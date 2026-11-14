// `housesitter restart-copilot`: restart the GitHub Copilot app on this Mac without losing a session's work, from
// outside the app, so the job survives the app quitting (run it with --detach and launchd owns it).
//
//   1. Before: read every session's state (the app's database for mode, its own history for whether the agent loop is
//      working), then ask each working session to reach a safe point: commit and push or save what is not yet in git or
//      its notes, and stop. Wait up to --settle seconds; what is still working at the quit is recorded as interrupted.
//   2. Quit: through the app's own Quit menu item with hackamore (which refuses while a person is using the Mac), or
//      SIGTERM to the exact pid with --sigterm. Wait until every process of the app has exited.
//   3. Relaunch: open -a, then wait until the app answers on its local socket.
//   4. After: every session that was working, was interrupted by the quit, or was named with --also gets one resume
//      message through the app's socket, unless something already continued it. Each one must then take a turn.
//
// Everything that touches the Mac goes through `deps`, so tests run the whole sequence against a pretend Mac.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refusal } from './hands.mjs';
import { which } from './peer-watch.mjs';

export const DEFAULT_APP = 'GitHub Copilot';
export const LOOKBACK_MS = 24 * 3600000;
export const TAIL_BYTES = 4 * 1024 * 1024;
export const T = { settle: 90000, quit: 60000, person: 600000, up: 120000, grace: 25000, delivery: 120000, verify: 180000, retry: 90000, tries: 3 };
export const LABEL = 'bot.ouro.housesitter.restart-copilot';

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const short = (id) => String(id).slice(0, 8);

// ---------- pure ----------

export function parsePs(text) {
  return String(text).split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

// The app's own process: the lowest pid running its executable (helpers live elsewhere in the bundle).
export function findMain(procs, bundleDir) {
  const re = new RegExp(`^${esc(bundleDir)}/Contents/MacOS/`);
  return procs.filter((p) => re.test(p.command)).sort((a, b) => a.pid - b.pid)[0] || null;
}

// Every process that must be gone before a relaunch: the app, what it started, and anything run from its bundle.
export function family(procs, mainPid, bundleDir) {
  const out = new Set();
  if (mainPid) out.add(mainPid);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (!out.has(p.pid) && out.has(p.ppid)) { out.add(p.pid); grew = true; }
  }
  for (const p of procs) if (p.command.includes(`${bundleDir}/Contents/`)) out.add(p.pid);
  return [...out].sort((a, b) => a - b);
}

const LOOP = new Set(['user.message', 'assistant.turn_start', 'assistant.message', 'assistant.turn_end', 'abort', 'session.task_complete',
  'tool.execution_start', 'tool.execution_complete', 'subagent.started', 'subagent.completed', 'external_tool.requested', 'external_tool.completed']);
const textOf = (r) => (typeof r === 'string' ? r : r?.content != null ? String(r.content) : JSON.stringify(r ?? ''));
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };

// Was this session's agent loop working when its history ended? Mid-turn, between turns that asked for tools, with a
// subagent running, or waiting on an async shell or background agent that never reported back. A person's stop, a
// finished task and a plain finished turn are not work.
export function loopState(lines) {
  let last = null, lastMsg = null, running = 0, finished = false;
  let shells = new Map(), agents = new Map();
  const starts = new Map();
  for (const l of lines) {
    if (!l) continue;
    const e = parse(l);
    if (!e) continue;
    const d = e.data || {};
    if (e.type === 'session.start' || e.type === 'session.resume') { shells = new Map(); agents = new Map(); running = 0; }
    if (e.type === 'tool.execution_start') starts.set(d.toolCallId, d);
    if (e.type === 'tool.execution_complete') {
      const s = starts.get(d.toolCallId);
      const out = textOf(d.result);
      if (s?.toolName === 'bash' && s.arguments?.mode === 'async') {
        const id = (out.match(/shellId:\s*([^\s>"\\]+)/) || [])[1] || s.arguments?.shellId;
        if (id && !/completed with exit code|has completed/i.test(out)) shells.set(String(id), s.arguments?.description || 'shell');
      }
      if (s && (s.toolName === 'read_bash' || s.toolName === 'stop_bash') && s.arguments?.shellId != null) {
        if (s.toolName === 'stop_bash' || /completed with exit code|has completed|no (such )?shell|not found|stopped/i.test(out)) shells.delete(String(s.arguments.shellId));
      }
    }
    if (e.type === 'system.notification') {
      const k = d.kind || {};
      if (k.shellId != null) shells.delete(String(k.shellId));
      if (k.agentId) agents.delete(k.agentId);
    }
    if (e.type === 'subagent.started' && d.executionMode === 'background') { agents.set(e.agentId || d.toolCallId, d.agentDisplayName || d.agentName || 'agent'); continue; }
    if ((e.type === 'subagent.completed' || e.type === 'subagent.failed') && agents.has(e.agentId || d.toolCallId)) { agents.delete(e.agentId || d.toolCallId); continue; }
    if (!LOOP.has(e.type)) continue;
    if (e.type === 'abort' && d.reason && d.reason !== 'user_initiated') continue;
    if (e.type === 'subagent.started') running++;
    if (e.type === 'subagent.completed') running = Math.max(0, running - 1);
    if (e.type === 'assistant.message') { lastMsg = e; finished = false; }
    if (e.type === 'session.task_complete') finished = true;
    if (e.type === 'user.message') { lastMsg = null; running = 0; finished = false; }
    last = e.type;
  }
  const owed = [...[...shells.values()].map((x) => `shell "${x}"`), ...[...agents.values()].map((x) => `background agent ${x}`)];
  if (last === 'abort') return { working: false, why: 'stopped by the person' };
  if (last === 'session.task_complete' || (last === 'assistant.turn_end' && finished)) return { working: false, why: 'task complete' };
  if (last === 'assistant.turn_end') {
    const asked = (lastMsg?.data?.toolRequests || []).length > 0;
    if (asked) return { working: true, why: 'between turns (its last turn called tools and no next turn started)' };
    if (running > 0) return { working: true, why: `${running} subagent(s) still running` };
    if (owed.length) return { working: true, why: `waiting on ${owed.slice(0, 3).join(', ')}` };
    return { working: false, why: 'its turn had ended' };
  }
  return last ? { working: true, why: `mid-turn (last ${last})` } : { working: false, why: 'no agent activity' };
}

// Did anything (a person, a resumer, a queue) send the session a message after `since`? Then it was continued.
export function continuedSince(lines, since) {
  for (const l of lines) {
    if (!l || !/"type":"user\.message"/.test(l.slice(0, 80))) continue;
    const e = parse(l);
    if (e && Date.parse(e.timestamp || '') > since) return true;
  }
  return false;
}

// Did the session start a new agent turn after `since`?
export function tookTurnSince(lines, since) {
  for (const l of lines) {
    if (!l || !/"type":"assistant\.turn_start"/.test(l.slice(0, 80))) continue;
    const e = parse(l);
    if (e && Date.parse(e.timestamp || '') > since) return true;
  }
  return false;
}

// Who gets a resume message. before/after: [{ id, state: 'busy'|'idle', interrupted }]. A flag the app set before the
// restart (an old crash nobody resumed) is not this restart's doing and is left alone.
export function pickTargets({ before, after, also = [] }) {
  const was = new Map(before.map((s) => [s.id, s]));
  const now = new Map(after.map((s) => [s.id, s]));
  const out = [];
  const add = (id, why) => { if (!out.some((t) => t.id === id)) out.push({ id, why }); };
  for (const s of before) if (s.state === 'busy') add(s.id, `was working (${s.why})`);
  for (const s of after) if (s.interrupted && !was.get(s.id)?.interrupted) add(s.id, 'the app marked it interrupted by the restart');
  for (const id of also) add(id, 'named with --also');
  return out.map((t) => ({ ...t, known: now.has(t.id), title: (now.get(t.id) || was.get(t.id))?.title || null }));
}

export const settleText = ({ at, inSec, why }) => `Heads up: the GitHub Copilot app restarts at about ${hhmm(at)} (in about ${Math.round(inSec)} seconds)${why ? ` for ${why}` : ''}. Reach a safe point now: commit and push, or save to your task notes, anything not yet in git or your session, start nothing long, then stop. You will be sent a message to resume once the app is back.`;
export const resumeText = ({ at, why }) => `The app was restarted at ${hhmm(at)}${why ? ` for ${why}` : ''}; resume where you left off. Anything that was in flight when it stopped (a shell command, a subagent, a send or a push) was interrupted: re-check its real state before relying on it, and redo it if it did not finish.`;

// The quit menu item in a hackamore `ls` reply, or null.
export function quitItem(ls) {
  const menu = (ls?.actions || []).find((a) => a.name === 'menu');
  return (menu?.input?.properties?.item?.enum || []).find((i) => / > Quit\b/.test(i)) || null;
}

export function plist({ node, bin, args, env = {}, log }) {
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const envs = Object.entries(env).map(([k, v]) => `    <key>${x(k)}</key><string>${x(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[node, bin, ...args].map((a) => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>EnvironmentVariables</key>
  <dict>
${envs}
  </dict>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict>
</plist>
`;
}

// ---------- the Mac ----------

const run = (file, argv, { timeoutMs = 30000 } = {}) => new Promise((res) => {
  execFile(file, argv, { timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

function readTail(f, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    return len < size ? lines.slice(1) : lines;
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// The hackamore this package depends on, run with the node that runs housesitter.
function bundledHackamore() {
  try { return [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.resolve('@ouro.bot/hackamore'))), '..', 'bin', 'hackamore.mjs')]; } catch { return null; }
}

export function realDeps({ copilotHome = path.join(os.homedir(), '.copilot'), hackamore = null } = {}) {
  const given = hackamore || process.env.HOUSESITTER_HACKAMORE || which('hackamore');
  const cmd = given ? given.trim().split(/\s+/) : bundledHackamore();
  return {
    home: copilotHome,
    hackamore: cmd,
    now: () => Date.now(),
    sleep: sleepReal,
    ps: async () => parsePs((await run('/bin/ps', ['-axo', 'pid=,ppid=,command='])).stdout),
    startedAt: async (pid) => Date.parse((await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])).stdout.trim()),
    sql: async (q) => {
      const r = await run('/usr/bin/sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', path.join(copilotHome, 'data.db'), q]);
      if (r.code !== 0) throw new Refusal('action-failed', `the app's database would not open (${r.stderr.trim().slice(0, 160)}): is ${copilotHome} this Mac's Copilot folder?`);
      return r.stdout.trim() ? JSON.parse(r.stdout) : [];
    },
    history: (id) => { const f = path.join(copilotHome, 'session-state', id, 'events.jsonl'); try { return { lines: readTail(f), mtime: fs.statSync(f).mtimeMs }; } catch { return { lines: [], mtime: 0 }; } },
    hk: async (argv) => {
      const r = await run(cmd[0], [...cmd.slice(1), ...argv], { timeoutMs: 60000 });
      let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
      return { code: r.code, json, text: (r.stderr || r.stdout).trim().slice(0, 300) };
    },
    kill: (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } },
    open: async (appName, { background }) => run('/usr/bin/open', [...(background ? ['-g'] : []), '-a', appName]),
    exchange: (messages, opts) => exchange(copilotHome, messages, opts),
    appDir: (name) => ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')].map((d) => path.join(d, `${name}.app`)).find((p) => fs.existsSync(p)) || null,
  };
}

// One conversation with the app's local WebSocket (port and token in <home>/run/): send, collect until done() or the wait ends.
export function exchange(copilotHome, messages, { done = () => false, waitMs = 10000, keep = () => true } = {}) {
  const rd = (n) => fs.readFileSync(path.join(copilotHome, 'run', n), 'utf8').trim().split(/\s+/)[0];
  let port, token;
  try { port = rd('ws.port'); token = rd('ws.token'); } catch { return Promise.resolve([{ type: 'socket_error', message: 'no ws.port or ws.token: the app is not serving' }]); }
  if (typeof WebSocket !== 'function') throw new Refusal('action-unavailable', 'the app\'s socket needs Node 22 or newer (global WebSocket); run housesitter with a newer node');
  return new Promise((resolve) => {
    const got = [];
    let ws; try { ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}&observer=1`); } catch { resolve([{ type: 'socket_error' }]); return; }
    let over = false;
    const finish = () => { if (over) return; over = true; clearTimeout(timer); try { ws.close(); } catch { /* closed */ } resolve(got); };
    const timer = setTimeout(finish, waitMs);
    ws.addEventListener('open', () => { for (const m of messages) ws.send(JSON.stringify(m)); });
    ws.addEventListener('message', (e) => { let j; try { j = JSON.parse(String(e.data)); } catch { return; } if (!keep(j)) return; got.push(j); if (done(j, got)) finish(); });
    ws.addEventListener('error', () => { got.push({ type: 'socket_error' }); finish(); });
  });
}

const appReady = async (deps) => (await deps.exchange([], { done: (j) => j.type === 'server_hello', keep: (j) => j.type === 'server_hello', waitMs: 3000 })).some((j) => j.type === 'server_hello');

async function sendTo(deps, id, prompt, waitMs) {
  const request_id = randomUUID();
  const got = await deps.exchange([{ type: 'send_message', session_id: id, prompt, delivery_mode: 'immediate', request_id }], {
    keep: (j) => j.request_id === request_id || (j.session_id === id && /message_(sent|queued|delivery)/.test(j.type)) || j.type === 'socket_error',
    done: (j) => /^(session_message_sent|session_message_queued|session_message_delivery_unknown|error|socket_error)$/.test(j.type),
    // A session whose runtime is not loaded loads first, often for more than 20 s; closing early cancels the send.
    waitMs,
  });
  const last = got.at(-1);
  return { ok: Boolean(last && /session_message_(sent|queued)/.test(last.type)), reply: last?.type || 'no reply', error: last?.type === 'error' ? String(last.message || '').slice(0, 200) : null };
}

// ---------- the steps ----------

const ROWS = `SELECT s.id, s.title, s.mode, s.is_running AS running, s.was_interrupted AS interrupted, s.execution_location AS loc
FROM sessions s LEFT JOIN workspaces w ON w.session_id = s.id
WHERE s.archived_at IS NULL AND w.archived_at IS NULL`;

// Every local, unarchived session: its mode, and whether its agent loop is working (busy) or not (idle).
export async function snapshot(deps, now = deps.now()) {
  const rows = (await deps.sql(ROWS)).filter((r) => r.loc === 'local' || !r.loc);
  return rows.map((r) => {
    const h = deps.history(r.id);
    const v = h.mtime >= now - LOOKBACK_MS ? loopState(h.lines) : { working: false, why: 'no recent activity' };
    // The app's own running flag counts too: either one says the session had work in flight.
    const busy = v.working || Boolean(r.running);
    return { id: r.id, title: r.title, mode: r.mode || null, state: busy ? 'busy' : 'idle', why: v.working ? v.why : r.running ? 'the app marks it running' : v.why, running: Boolean(r.running), interrupted: Boolean(r.interrupted) };
  });
}

async function hackamoreQuit(deps, app, { personWaitMs, log }) {
  const ls = await deps.hk(['ls', app]);
  if (ls.code !== 0 || !ls.json) return { ok: false, why: `hackamore ls ${app} failed: ${ls.text || `exit ${ls.code}`}` };
  const item = quitItem(ls.json);
  if (!item) return { ok: false, why: `hackamore sees no Quit menu item in ${app} (it may be protected or have no menu bar)` };
  const input = JSON.stringify({ item, app });
  for (const end = deps.now() + personWaitMs; ;) {
    const r = await deps.hk(['do', 'menu', input]);
    if (r.code === 0) return { ok: true, method: 'menu', item };
    const code = r.json?.code || null;
    if (code === 'person-active' && deps.now() < end) { log(`someone is using the Mac; waiting to quit ${app} (hackamore: ${r.json?.problem || code})`); await deps.sleep(10000); continue; }
    return { ok: false, code, why: `hackamore refused the Quit menu item: ${r.json?.problem || r.text || `exit ${r.code}`}${r.json?.fix ? ` (${r.json.fix})` : ''}` };
  }
}

// The whole plan from what is true now; changes nothing. Used by --dry-run and by the real run's first step.
export async function plan(opts, deps) {
  const app = opts.app || DEFAULT_APP;
  const dir = deps.appDir(app);
  if (!dir) throw new Refusal('input-invalid', `no app called ${app} in /Applications, /System/Applications or ~/Applications: pass --app with the app's name`);
  const procs = await deps.ps();
  const main = findMain(procs, dir);
  const sessions = opts.stand_in ? [] : await snapshot(deps);
  const busy = sessions.filter((s) => s.state === 'busy');
  const also = (opts.also || []).map((id) => sessions.find((s) => s.id.startsWith(id))?.id || id);
  const targets = pickTargets({ before: sessions, after: [], also });
  let quit;
  if (opts.sigterm) quit = { method: 'sigterm', pid: main?.pid || null };
  else if (!deps.hackamore) quit = { method: 'unavailable', why: 'hackamore is not on PATH: install it, pass --hackamore "<command>", or pass --sigterm' };
  else {
    const ls = await deps.hk(['ls', app]);
    const item = ls.code === 0 ? quitItem(ls.json) : null;
    quit = item ? { method: 'menu', item, via: deps.hackamore.join(' '), gate: ls.json?.state?.gate || undefined } : { method: 'unavailable', why: ls.code === 0 ? `hackamore sees no Quit menu item in ${app}` : `hackamore ls ${app} failed: ${ls.text}` };
  }
  return {
    app, bundle: dir, pid: main?.pid || null, running: Boolean(main), family: main ? family(procs, main.pid, dir).length : 0,
    sessions: { total: sessions.length, busy: busy.length, idle: sessions.length - busy.length, by_mode: sessions.reduce((m, s) => { m[s.mode || 'default'] = (m[s.mode || 'default'] || 0) + 1; return m; }, {}) },
    ask_to_settle: busy.map((s) => ({ id: s.id, title: s.title, mode: s.mode, why: s.why })),
    resume: targets.map(({ id, title, why }) => ({ id, title, why })),
    quit,
    relaunch: `open -a "${app}"`,
    resume_enabled: Boolean(opts.resume),
    steps: [
      `ask ${busy.length} working session(s) to reach a safe point, wait up to ${Math.round((opts.settle ?? T.settle) / 1000)} s`,
      quit.method === 'menu' ? `quit with hackamore: do menu "${quit.item}"` : quit.method === 'sigterm' ? `quit with SIGTERM to pid ${quit.pid}` : `cannot quit: ${quit.why}`,
      `wait until all ${main ? family(procs, main.pid, dir).length : 0} process(es) of ${app} have exited`,
      `relaunch: open -a "${app}", wait for its socket`,
      opts.resume ? `resume ${targets.length} session(s) (more if the restart interrupts others), then verify each took a turn` : 'no resume (add --resume)',
    ],
  };
}

// Runs the sequence and keeps status.json current (state running|done|failed, the step, when), which the Mac's peer
// watch reads: a job that dies mid-way leaves "running" with an old time, and that is how someone learns of it.
export async function restart(opts, deps, log = () => {}) {
  const started = new Date(deps.now()).toISOString();
  const write = (o) => { try { deps.status?.({ started, updated: new Date(deps.now()).toISOString(), ...o }); } catch { /* the status file is a courtesy */ } };
  const r = await restartSteps(opts, deps, (m) => { log(m); write({ state: 'running', step: m.split(' {')[0] }); });
  const not = r.not_resumed || (r.resume || []).filter((x) => !['resumed', 'already continued'].includes(x.outcome)).map((x) => x.id);
  write({ state: r.ok ? 'done' : 'failed', step: r.failed ? `failed at ${r.failed.stage}` : 'finished', ...(r.failed ? { failed: r.failed } : {}), ...(not.length ? { not_resumed: not } : {}) });
  return r;
}

async function restartSteps(opts, deps, log) {
  const t = { ...T, ...Object.fromEntries(Object.entries(opts.t || {})) };
  const app = opts.app || DEFAULT_APP;
  const report = { ok: false, app, started_at: new Date(deps.now()).toISOString(), steps: [] };
  const step = (name, extra = {}) => { report.steps.push({ step: name, at: new Date(deps.now()).toISOString(), ...extra }); log(`${name}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`); };
  const fail = (stage, why) => { report.failed = { stage, why }; step(`FAILED at ${stage}`, { why }); return report; };

  const p = await plan(opts, deps);
  const dir = p.bundle;
  if (!p.running) return fail('before', `${app} is not running: nothing to restart: open it first`);
  if (p.quit.method === 'unavailable') return fail('before', p.quit.why);
  const procs0 = await deps.ps();
  const mainBefore = findMain(procs0, dir);
  const before = opts.stand_in ? [] : await snapshot(deps);
  report.before = before.map(({ id, title, mode, state, why, interrupted }) => ({ id, title, mode, state, why, interrupted }));
  step('snapshot', { sessions: before.length, busy: before.filter((s) => s.state === 'busy').length, pid: mainBefore.pid });
  const asked = before.filter((s) => s.state === 'busy');

  // 1. Ask the working sessions to reach a safe point.
  if (asked.length) {
    const quitAt = deps.now() + t.settle;
    const sent = await Promise.all(asked.map((s) => sendTo(deps, s.id, settleText({ at: quitAt, inSec: t.settle / 1000, why: opts.why }), 30000).then((r) => ({ id: s.id, ...r }))));
    step('asked to reach a safe point', { asked: asked.length, accepted: sent.filter((r) => r.ok).length, refused: sent.filter((r) => !r.ok).map((r) => `${short(r.id)}: ${r.error || r.reply}`) });
    let left = asked.map((s) => s.id);
    for (const end = deps.now() + t.settle; left.length && deps.now() < end;) {
      await deps.sleep(Math.min(5000, Math.max(0, end - deps.now())));
      const now = await snapshot(deps);
      left = left.filter((id) => now.find((s) => s.id === id)?.state === 'busy');
    }
    report.settled = asked.filter((s) => !left.includes(s.id)).map((s) => s.id);
    report.interrupted_at_quit = left;
    step('settle ended', { settled: report.settled.length, still_working: left.map(short) });
  }

  // 2. Quit, then wait for every process of the app.
  const familyPids = family(await deps.ps(), mainBefore.pid, dir);
  let q;
  if (opts.sigterm) { deps.kill(mainBefore.pid, 'SIGTERM'); q = { ok: true, method: 'sigterm', pid: mainBefore.pid }; } else q = await hackamoreQuit(deps, app, { personWaitMs: t.person, log });
  if (!q.ok) return fail('quit', q.why);
  step('quit sent', { method: q.method, ...(q.item ? { item: q.item } : {}) });
  const alive = async () => { const ps = await deps.ps(); const set = new Set(familyPids); return ps.filter((x) => set.has(x.pid) || x.command.includes(`${dir}/Contents/`)).map((x) => x.pid); };
  let left = await alive();
  for (const end = deps.now() + t.quit; left.length && deps.now() < end;) { await deps.sleep(1000); left = await alive(); }
  if (left.length) {
    step('stragglers after the quit wait; SIGTERM to exactly these pids', { pids: left });
    for (const pid of left) deps.kill(pid, 'SIGTERM');
    for (const end = deps.now() + Math.min(t.quit, 20000); left.length && deps.now() < end;) { await deps.sleep(1000); left = await alive(); }
  }
  if (left.length) return fail('quit', `${left.length} process(es) of ${app} still running after the quit and a SIGTERM: ${left.join(', ')}. Nothing was relaunched; look at them (ps -p ${left[0]}) before trying again`);
  step('app exited', { processes: familyPids.length });

  // 3. Relaunch.
  const opened = await deps.open(app, { background: opts.background !== false });
  if (opened.code !== 0) return fail('relaunch', `open -a "${app}" failed: ${opened.stderr.trim().slice(0, 200)}`);
  let main = null;
  for (const end = deps.now() + t.up; !main && deps.now() < end;) { main = findMain(await deps.ps(), dir); if (!main) await deps.sleep(1000); }
  if (!main) return fail('relaunch', `${app} did not start within ${Math.round(t.up / 1000)} s`);
  const startedAt = (await deps.startedAt(main.pid)) || deps.now();
  report.restarted_at = new Date(deps.now()).toISOString();
  step('relaunched', { pid: main.pid, from: mainBefore.pid });
  if (opts.stand_in) { report.ok = true; return report; }
  let ready = false;
  for (const end = deps.now() + t.up; !ready && deps.now() < end;) { ready = await appReady(deps); if (!ready) await deps.sleep(2000); }
  if (!ready) {
    report.not_resumed = before.filter((s) => s.state === 'busy').map((s) => s.id);
    return fail('relaunch', `${app} is running but its socket did not answer within ${Math.round(t.up / 1000)} s; the ${report.not_resumed.length} session(s) that were working (report.not_resumed) were not resumed`);
  }
  step('socket answering');
  if (!opts.resume) { report.ok = true; return report; }

  // 4. Resume and verify.
  const res = await resumeAfter({ before, opts, startedAt, restartedAt: deps.now(), t }, deps, log);
  report.resume = res;
  report.ok = res.every((r) => r.outcome === 'resumed' || r.outcome === 'already continued');
  step(report.ok ? 'every session resumed' : 'some sessions did not resume', { not: res.filter((r) => !['resumed', 'already continued'].includes(r.outcome)).map((r) => `${short(r.id)}: ${r.outcome}`) });
  return report;
}

export async function resumeAfter({ before, opts, startedAt, restartedAt, t }, deps, log = () => {}) {
  await deps.sleep(t.grace);
  const after = await snapshot(deps);
  const targets = pickTargets({ before, after, also: (opts.also || []).map((id) => after.find((s) => s.id.startsWith(id))?.id || id) });
  const text = resumeText({ at: restartedAt, why: opts.why });
  return Promise.all(targets.map(async (tg) => {
    const rec = { id: tg.id, title: tg.title, why: tg.why };
    if (!tg.known) return { ...rec, outcome: 'gone: the app has no such live session (archived or deleted)' };
    if (continuedSince(deps.history(tg.id).lines, startedAt)) {
      // Another resumer got there first: only its turn counts. If none starts, we send our own.
      for (const end = deps.now() + t.retry; deps.now() < end;) {
        if (tookTurnSince(deps.history(tg.id).lines, startedAt)) return { ...rec, outcome: 'already continued' };
        await deps.sleep(3000);
      }
      log(`${short(tg.id)}: continued by someone else but no turn followed; sending our own`);
    }
    for (let tries = 1; tries <= t.tries; tries++) {
      const at = deps.now();
      const s = await sendTo(deps, tg.id, text, t.delivery);
      log(`${short(tg.id)}: send ${tries}: ${s.ok ? s.reply : `refused (${s.error || s.reply})`}`);
      if (!s.ok) { rec.last = s.error || s.reply; if (/archived|not found|unknown session/i.test(rec.last)) return { ...rec, outcome: `gone: ${rec.last}` }; continue; }
      for (const end = deps.now() + t.retry; deps.now() < end;) {
        if (tookTurnSince(deps.history(tg.id).lines, at)) return { ...rec, outcome: 'resumed', tries };
        await deps.sleep(3000);
      }
      rec.last = 'delivered but no new turn';
    }
    return { ...rec, outcome: `NOT RESUMED after ${t.tries} tries (${rec.last || 'no reply'})` };
  }));
}

export const stateDir = (home = os.homedir()) => path.join(home, 'Library', 'Caches', 'housesitter', 'restart-copilot');

export function render(r) {
  const L = [];
  L.push(`${r.dry_run ? 'DRY RUN: nothing is changed. ' : ''}${r.app}${r.running ? ` is running (pid ${r.pid}, ${r.family} process(es))` : ' is not running'}`);
  L.push(`sessions: ${r.sessions.total} local, ${r.sessions.busy} working, ${r.sessions.idle} idle; modes ${Object.entries(r.sessions.by_mode).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  r.steps.forEach((s, i) => L.push(`  ${i + 1}. ${s}`));
  L.push(`would ask to settle (${r.ask_to_settle.length}): ${r.ask_to_settle.map((s) => `${short(s.id)} ${s.title || ''}`.trim()).join('; ') || 'none'}`);
  L.push(`would resume (${r.resume.length}): ${r.resume.map((s) => `${short(s.id)} ${s.title || ''}`.trim()).join('; ') || 'none'}`);
  return L.join('\n');
}

// Start the real restart as a launchd job that owns it, so it survives the app (and the session that asked) quitting.
export function detach({ node, bin, args, env, home = os.homedir(), launchctl = (a) => run('/bin/launchctl', a), uid = process.getuid() }) {
  const d = stateDir(home);
  fs.mkdirSync(d, { recursive: true });
  const log = path.join(d, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const file = path.join(d, 'job.plist');
  fs.writeFileSync(file, plist({ node, bin, args, env, log }));
  return launchctl(['bootout', `gui/${uid}/${LABEL}`]).then(() => launchctl(['bootstrap', `gui/${uid}`, file])).then((r) => ({ ok: r.code === 0, log, plist: file, error: r.stderr.trim() }));
}
