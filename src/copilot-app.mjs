// `housesitter restart-copilot`: restart the GitHub Copilot app on this Mac without losing a session's work, from
// outside the app, so the job survives the app quitting (run it with --detach and launchd owns it).
//
//   1. Before: read every session's state (the app's database for mode, its own history for whether the agent loop is
//      working), then ask each working session to reach a safe point: commit and push or save what is not yet in git or
//      its notes, and answer: READY-TO-RESTART, or DEFER: <n> lanes running, about <m> min. The restart waits until
//      every session is ready (or its turn ended), asking a deferring session again when its estimate is up, for at most
//      --settle-max seconds (3 h); a session that has not deferred is cut off after --settle seconds without a step in its
//      history. What is still working at the quit is recorded as interrupted, and its resume message says which lanes it
//      had said were running.
//   2. Quit: through the app's own Quit menu item with hackamore (which refuses while a person is using the Mac), or
//      SIGTERM to the exact pid with --sigterm. Wait until every process of the app has exited.
//   3. Relaunch: open -a, then wait until the app answers on its local socket.
//   4. After: every session that was working, was interrupted by the quit, or was named with --also (and is not named with --skip) gets one resume
//      message through the app's socket, unless something already continued it. Each one must then take a turn.
//
// A session is left out when it is named with --skip or in ~/.config/housesitter/restart-copilot.json ({ "skip": ["<session id or its first 8+ characters>"] }),
// which the planned restart and the crash resume share; and a session whose last turn was over 24 h before the stop is never resumed.
//
// `--resume-only` runs just step 4 for an app that stopped some other way (a crash, an update, a login, a reboot), and
// `--resume-only --watch` does it for every new app process, as a launchd agent that `--install-keeper` writes.
//
// Everything that touches the Mac goes through `deps`, so tests run the whole sequence against a pretend Mac.

import { execFile, spawnSync } from 'node:child_process';
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
export const T = { settle: 600000, settleMax: 10800000, recheckMin: 120000, recheckMax: 1200000, beat: 60000, quit: 60000, dialog: 4000, person: 600000, up: 120000, grace: 25000, delivery: 120000, verify: 180000, retry: 90000, tries: 3, concurrency: 4, backoff: [2000, 6000, 15000] };
export const LABEL = 'bot.ouro.housesitter.restart-copilot';
export const STALE_MS = 24 * 3600000;
// A session whose history is bigger than this is never resumed by us: the app loads the whole file into memory on resume.
export const MAX_HISTORY_BYTES = 500 * 1024 * 1024;
export const configPath = (home = os.homedir()) => process.env.HOUSESITTER_RESTART_CONFIG || path.join(home, '.config', 'housesitter', 'restart-copilot.json');

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const short = (id) => String(id).slice(0, 8);

// ---------- pure ----------

export function parsePs(text) {
  return String(text).split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

// The app's own process. Helpers live in the same folder (a credential helper started by the app is one), so the app's
// own executable comes first, then a process that is not the child of another process of the bundle, then the lowest pid.
export function findMain(procs, bundleDir, exe = null) {
  const prefix = `${bundleDir}/Contents/MacOS/`;
  const inside = procs.filter((p) => p.command.startsWith(prefix));
  const pids = new Set(inside.map((p) => p.pid));
  const rank = (p) => [exe && p.command.slice(prefix.length).split(' ')[0] === exe ? 0 : 1, pids.has(p.ppid) ? 1 : 0, p.pid];
  return inside.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })[0] || null;
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

// When the session's agent loop last did something (the time of its last loop event in these history lines), or null.
export function lastTurnAt(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;
    const e = parse(l);
    if (e && LOOP.has(e.type) && Date.parse(e.timestamp || '') > 0) return Date.parse(e.timestamp);
  }
  return null;
}

// The skip list file: { "skip": [ids] }. A missing file is an empty list; a bad one is reported and ignored (the keeper must keep resuming the rest).
export function readSkipConfig(file = configPath(), warn = () => {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') warn(`${file}: ${e.message}`); return []; }
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j?.skip) ? j.skip : [];
    const bad = list.filter((x) => typeof x !== 'string' || x.length < 8);
    if (!Array.isArray(j?.skip) || bad.length) warn(`${file}: "skip" must be a list of session ids (8 or more characters each); ignoring ${bad.length ? JSON.stringify(bad) : 'it'}`);
    return list.filter((x) => typeof x === 'string' && x.length >= 8);
  } catch (e) { warn(`${file} is not valid JSON (${e.message}): no sessions skipped from it`); return []; }
}

// Every id to leave out: --skip and the shared file, read at each call so an edit counts without a reload.
export const skipOf = (opts, deps) => [...new Set([...(opts.skip || []), ...(deps.skipList?.() || [])])];

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
  for (const s of before) if (s.state === 'busy' && !s.stale) add(s.id, `was working (${s.why})`);
  for (const s of after) if (s.interrupted && !s.stale && !was.get(s.id)?.interrupted) add(s.id, 'the app marked it interrupted by the restart');
  for (const id of also) add(id, 'named with --also');
  return out.map((t) => ({ ...t, known: now.has(t.id), title: (now.get(t.id) || was.get(t.id))?.title || null }));
}

export const READY = 'READY-TO-RESTART';
export const DEFER = 'DEFER';
export const settleText = ({ by, stallSec, why, what = 'the GitHub Copilot app restarts' }) => `Heads up: ${what}${why ? ` for ${why}` : ''}, as soon as every working session is ready and no later than about ${hhmm(by)}. Reach a safe point now: commit and push, or save to your task notes, anything not yet in git or your session, and start nothing long. When you are there, say so: end your turn with a line that is exactly ${READY}. If stopping your background lanes (subagents, shell jobs) now would lose work you cannot redo from pushed state, answer instead with a line of its own, ${DEFER}: <n> lanes running, about <m> min, and the restart waits for you and asks again when your estimate is up. A session that has not deferred and goes ${stallSec < 120 ? `${stallSec} seconds` : `${Math.round(stallSec / 60)} minutes`} without a step is not waited for. You will be sent a message to resume once the app is back.`;
export const recheckText = ({ by, why }) => `Recheck for the restart${why ? ` for ${why}` : ''}: are you at a safe point yet? Answer with a line of its own: ${READY}, or ${DEFER}: <n> lanes running, about <m> min again. The restart goes ahead at about ${hhmm(by)} whatever the answers.`;
export const cancelText = ({ why }) => `The restart${why ? ` for ${why}` : ''} was called off: the app did not quit and is still running, so nothing was stopped. Carry on with what you were doing; there is nothing to resume.`;
const lanesNote = (l) => (l ? ` You had said ${l.lanes ?? 'some'} lane${l.lanes === 1 ? ' was' : 's were'} still running${l.minutes != null ? ` (about ${l.minutes} min from done)` : ''}: the restart went ahead without waiting longer, so those lanes were stopped; restart them from their pushed state.` : '');
export const resumeText = ({ at, why, lanes = null }) => `The app was restarted at ${hhmm(at)}${why ? ` for ${why}` : ''}; resume where you left off. Anything that was in flight when it stopped (a shell command, a subagent, a send or a push) was interrupted: re-check its real state before relying on it, and redo it if it did not finish. Your background subagents and shell jobs were stopped; restart any unfinished ones from their pushed state.${lanesNote(lanes)}`;

// What the session last answered to the ask, after `since`: { kind: 'ready', at } or { kind: 'defer', at, lanes, minutes }, or null.
// An answer is a line of its own: the ready token, or the defer token, a colon, and "N lanes running" with "about M min".
export function lastReply(lines, since) {
  let out = null;
  for (const l of lines) {
    if (!l || !l.includes('assistant.message')) continue;
    const e = parse(l);
    const at = Date.parse(e?.timestamp || '');
    if (e?.type !== 'assistant.message' || !(at > since)) continue;
    for (const raw of String(e.data?.content ?? '').split('\n')) {
      const line = raw.replace(/[`*_]/g, '').trim();
      if (line.replace(/[\s.]/g, '') === READY) out = { kind: 'ready', at };
      const d = line.match(new RegExp(`^${DEFER}\\s*:\\s*(\\d+)\\s+lanes?\\s+running(?:\\s*,?\\s*about\\s+(\\d+)\\s*min)?`, 'i'));
      if (d) out = { kind: 'defer', at, lanes: Number(d[1]), minutes: d[2] == null ? null : Number(d[2]) };
    }
  }
  return out;
}

// When to ask a deferring session again: its own estimate, kept between recheckMin and recheckMax.
export const recheckAfter = (reply, t) => Math.min(t.recheckMax, Math.max(t.recheckMin, reply.minutes == null ? t.recheckMax / 2 : reply.minutes * 60000));

// Is this session done settling? { outcome, reply }; outcome is null while it is still getting there. Done when it said
// ready, its turn ended (idle; a session asked again must have taken a turn first), it has gone `settle` ms without a step
// (stalled; not for a session that deferred, which said it is working), or `settleMax` ms have passed since the first ask.
// A session that deferred is waited for until its next answer or the ceiling.
export function settleVerdict({ state, lines, mtime, askedAt, firstAskedAt, now, settle, settleMax, deferred = false }) {
  const reply = lastReply(lines, askedAt);
  if (reply?.kind === 'ready') return { outcome: 'ready', reply };
  if (now - firstAskedAt >= settleMax) return { outcome: 'capped', reply };
  if (reply?.kind === 'defer') return { outcome: null, reply };
  if (state !== 'busy') return askedAt > firstAskedAt && !tookTurnSince(lines, askedAt) ? { outcome: null, reply } : { outcome: 'idle', reply };
  if (!deferred && now - Math.max(askedAt, mtime || 0) >= settle) return { outcome: 'stalled', reply };
  return { outcome: null, reply };
}

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
  execFile(file, argv, { timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: Boolean(err?.killed), stdout: String(stdout || ''), stderr: String(stderr || '') }));
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

export function realDeps({ copilotHome = path.join(os.homedir(), '.copilot'), hackamore = null, state = stateDir(), config = configPath(), warn = () => {} } = {}) {
  const given = hackamore || process.env.HOUSESITTER_HACKAMORE || which('hackamore');
  const cmd = given ? given.trim().split(/\s+/) : bundledHackamore();
  return {
    home: copilotHome,
    hackamore: cmd,
    skipList: () => readSkipConfig(config, warn),
    now: () => Date.now(),
    sleep: sleepReal,
    ps: async () => parsePs((await run('/bin/ps', ['-axo', 'pid=,ppid=,command='])).stdout),
    startedAt: async (pid) => Date.parse((await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])).stdout.trim()),
    sql: async (q) => {
      const db = path.join(copilotHome, 'data.db');
      if (!fs.existsSync(db)) throw new Refusal('action-failed', `there is no Copilot app database at ${db}: the app has not run on this Mac, or --copilot-home points elsewhere. Fix: pass --copilot-home <dir> with this Mac's Copilot folder, or open the app once so it creates the database.`);
      const r = await run('/usr/bin/sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', db, q]);
      if (r.code !== 0) throw new Refusal('action-failed', `SQLite refused the Copilot app's database at ${db}: ${r.stderr.trim().slice(0, 160)}. Fix: pass --copilot-home <dir> with this Mac's Copilot folder, or open the app once so it creates the database.`);
      return r.stdout.trim() ? JSON.parse(r.stdout) : [];
    },
    historySize: (id) => { try { return fs.statSync(path.join(copilotHome, 'session-state', id, 'events.jsonl')).size; } catch { return 0; } },
    history: (id) => { const f = path.join(copilotHome, 'session-state', id, 'events.jsonl'); try { return { lines: readTail(f), mtime: fs.statSync(f).mtimeMs }; } catch { return { lines: [], mtime: 0 }; } },
    hk: async (argv, { timeoutMs = 60000 } = {}) => {
      const r = await run(cmd[0], [...cmd.slice(1), ...argv], { timeoutMs });
      let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
      return { code: r.code, json, timedOut: r.timedOut, text: (r.stderr || r.stdout).trim().slice(0, 300) };
    },
    kill: (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } },
    open: async (appName, { background }) => run('/usr/bin/open', [...(background ? ['-g'] : []), '-a', appName]),
    exchange: (messages, opts) => exchange(copilotHome, messages, opts),
    appExe: async (dir) => (await run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(dir, 'Contents', 'Info.plist')])).stdout.trim() || null,
    // Which app process (pid and start time) has had its sessions resumed already, so two resumers never both send.
    generation: {
      get: () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'resumed.json'), 'utf8')).key || null; } catch { return null; } },
      set: (key, by) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'resumed.json'), JSON.stringify({ key, by, at: new Date().toISOString() })); },
    },
    // True once per login (the login window's pid names it).
    loginClaim: () => {
      const id = String(spawnSync('/usr/bin/pgrep', ['-x', 'loginwindow'], { encoding: 'utf8' }).stdout || '').split('\n')[0].trim();
      if (!id) return false;
      const f = path.join(state, `login-${id}`);
      if (fs.existsSync(f)) return false;
      try { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(f, new Date().toISOString()); for (const old of fs.readdirSync(state)) if (/^login-\d+$/.test(old) && old !== `login-${id}`) fs.rmSync(path.join(state, old), { force: true }); } catch { return false; }
      return true;
    },
    // Sessions owed a resume that a job could not finish (it died, the Mac restarted): the resume watcher sends them.
    owed: {
      get: () => { try { const o = JSON.parse(fs.readFileSync(path.join(state, 'owed-resume.json'), 'utf8')); return Date.now() - Date.parse(o.at) < 6 * 3600000 ? o.ids || [] : []; } catch { return []; } },
      set: (ids, why) => { fs.mkdirSync(state, { recursive: true }); if (ids.length) fs.writeFileSync(path.join(state, 'owed-resume.json'), JSON.stringify({ ids, why, at: new Date().toISOString() })); },
      clear: () => { try { fs.rmSync(path.join(state, 'owed-resume.json'), { force: true }); } catch { /* none */ } },
    },
    restartState: () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8')); } catch { return null; } },
    // Every pass is recorded; one that resumed sessions is also kept in resume-last.json, which a later "already resumed" pass must not replace (the health watch follows it).
    heldBack: (list) => { try { fs.mkdirSync(state, { recursive: true }); fs.appendFileSync(path.join(state, 'held-back.log'), list.map((x) => `${JSON.stringify({ at: new Date().toISOString(), ...x })}\n`).join('')); } catch { /* a courtesy */ } },
    recorded: (o) => { try { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'resume-only.json'), JSON.stringify(o)); if ((o.resumed || []).length) fs.writeFileSync(path.join(state, 'resume-last.json'), JSON.stringify(o)); } catch { /* a courtesy */ } },
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

export const appReady = async (deps) => (await deps.exchange([], { done: (j) => j.type === 'server_hello', keep: (j) => j.type === 'server_hello', waitMs: 3000 })).some((j) => j.type === 'server_hello');

export async function sendTo(deps, id, prompt, waitMs) {
  const request_id = randomUUID();
  const got = await deps.exchange([{ type: 'send_message', session_id: id, prompt, delivery_mode: 'immediate', request_id }], {
    keep: (j) => j.request_id === request_id || (j.session_id === id && /message_(sent|queued|delivery)/.test(j.type)) || j.type === 'socket_error',
    done: (j) => /^(session_message_sent|session_message_queued|session_message_delivery_unknown|error|socket_error)$/.test(j.type),
    // A session whose runtime is not loaded loads first, often for more than 20 s; closing early cancels the send.
    waitMs,
  });
  const last = got.at(-1);
  return { ok: Boolean(last && /session_message_(sent|queued)/.test(last.type)), reply: last?.type || 'no reply', error: last?.type === 'error' || last?.type === 'socket_error' ? String(last.message || (last.type === 'socket_error' ? 'socket_error: the app\'s socket refused or dropped the connection' : '')).slice(0, 200) : null };
}

// ---------- the steps ----------

const ROWS = `SELECT s.id, s.title, s.mode, s.is_running AS running, s.was_interrupted AS interrupted, s.execution_location AS loc
FROM sessions s LEFT JOIN workspaces w ON w.session_id = s.id
WHERE s.archived_at IS NULL AND w.archived_at IS NULL`;

// Every local, unarchived session (except those whose id starts with an entry of skip): its mode, and whether its agent loop is working (busy) or not (idle).
export async function snapshot(deps, now = deps.now(), skip = []) {
  const rows = (await deps.sql(ROWS)).filter((r) => (r.loc === 'local' || !r.loc) && !skip.some((p) => r.id.startsWith(p)));
  return rows.map((r) => {
    const bytes = deps.historySize?.(r.id) || 0;
    if (bytes > MAX_HISTORY_BYTES) return { id: r.id, title: r.title, mode: r.mode || null, state: 'idle', why: `its history is ${Math.round(bytes / 1048576)} MB, over the ${MAX_HISTORY_BYTES / 1048576} MB resume cap`, running: Boolean(r.running), interrupted: Boolean(r.interrupted), oversize: bytes };
    const h = deps.history(r.id);
    const last = lastTurnAt(h.lines);
    // A session whose last turn is over a day old is never resumed, whatever flag the app still carries for it.
    const stale = last != null ? last < now - STALE_MS : h.mtime > 0 && h.mtime < now - STALE_MS;
    if (stale) return { id: r.id, title: r.title, mode: r.mode || null, state: 'idle', why: 'its last turn was over 24 h ago', running: false, interrupted: false, stale: true };
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

const QUIT_BUTTON = /^(quit|quit anyway|quit and stop|quit now|stop (all )?(sessions )?and quit|force quit|quit github( copilot)?)$/i;

// What a read of the app shows that could be a quit confirmation: buttons, any system alert. Changes nothing.
async function readDialog(deps, app) {
  const ls = await deps.hk(['ls', app]);
  if (ls.code !== 0 || !ls.json) return { buttons: [], summary: `hackamore ls failed: ${ls.text || `exit ${ls.code}`}` };
  const els = ls.json.state?.elements || [];
  const quit = els.filter((e) => e.role === 'button' && QUIT_BUTTON.test(String(e.label || '').trim()));
  const alerts = (ls.json.state?.alerts || []).map((a) => `${a.owner || 'alert'}${a.text ? `: ${a.text}` : ''}`);
  return { quit, alerts, buttons: els.filter((e) => e.role === 'button').length, summary: alerts.length ? `system alert: ${alerts.join('; ')}` : quit.length ? `Quit button: "${quit[0].label}"` : 'no confirmation dialog, no Quit button, no system alert on screen' };
}

// Press the Quit button of a confirmation the app put up after the Quit menu item (each label once).
async function answerQuitDialog(deps, app, answered) {
  const d = await readDialog(deps, app);
  const b = (d.quit || []).find((e) => !answered.includes(e.label));
  if (!b) return { pressed: null };
  answered.push(b.label);
  const r = await deps.hk(['do', 'click', JSON.stringify({ element: b.ref, app })]);
  return { pressed: r.code === 0 ? b.label : null, why: r.code === 0 ? null : r.text };
}

// The whole plan from what is true now; changes nothing. Used by --dry-run and by the real run's first step.
export async function plan(opts, deps) {
  const app = opts.app || DEFAULT_APP;
  const dir = deps.appDir(app);
  if (!dir) throw new Refusal('input-invalid', `no app called ${app} in /Applications, /System/Applications or ~/Applications: pass --app with the app's name`);
  const procs = await deps.ps();
  const main = findMain(procs, dir, await deps.appExe?.(dir));
  const skip = skipOf(opts, deps);
  const sessions = opts.stand_in ? [] : await snapshot(deps, undefined, skip);
  const busy = sessions.filter((s) => s.state === 'busy');
  const also = (opts.also || []).filter((id) => !skip.some((p) => id.startsWith(p))).map((id) => sessions.find((s) => s.id.startsWith(id))?.id || id);
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
      `ask ${busy.length} working session(s) to reach a safe point (ready, or defer with the lanes they have running); wait until all are ready, up to ${Math.round(((opts.t?.settleMax) ?? T.settleMax) / 60000)} min`,
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
  if (r.restarted_at) {
    // The app can restart itself right after a relaunch (an update): mark the process that is up now too.
    try {
      const dir = deps.appDir(r.app), m = findMain(await deps.ps(), dir, await deps.appExe?.(dir));
      if (m) deps.generation?.set(`${m.pid}:${(await deps.startedAt(m.pid)) || ''}`, 'restart-copilot');
    } catch { /* the marker only stops a second resumer */ }
  }
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
  // safe_point: stop after the sessions are at a safe point and hand them to the caller, with the app left running.
  if (!p.running && !opts.safe_point) return fail('before', `${app} is not running: nothing to restart: open it first`);
  if (p.running && p.quit.method === 'unavailable' && !opts.safe_point) return fail('before', p.quit.why);
  const procs0 = p.running ? await deps.ps() : [];
  const mainBefore = findMain(procs0, dir, await deps.appExe?.(dir)) || { pid: null };
  const before = opts.stand_in || !p.running ? [] : await snapshot(deps, undefined, skipOf(opts, deps));
  report.before = before.map(({ id, title, mode, state, why, interrupted }) => ({ id, title, mode, state, why, interrupted }));
  step('snapshot', { sessions: before.length, busy: before.filter((s) => s.state === 'busy').length, pid: mainBefore.pid });
  const asked = before.filter((s) => s.state === 'busy');

  // 1. Ask the working sessions to reach a safe point. Each answers ready or defer (with its lanes); a deferring session is asked
  // again when its estimate is up. The wait ends when every session is ready, its turn ended or it went quiet, or at the ceiling.
  const lanes = new Map();
  if (asked.length) {
    const firstAskedAt = deps.now();
    const by = firstAskedAt + t.settleMax;
    const sent = await Promise.all(asked.map((s) => sendTo(deps, s.id, settleText({ by, stallSec: Math.round(t.settle / 1000), why: opts.why, what: opts.what }), 30000).then((r) => ({ id: s.id, ...r }))));
    step('asked to reach a safe point', { asked: asked.length, accepted: sent.filter((r) => r.ok).length, refused: sent.filter((r) => !r.ok).map((r) => `${short(r.id)}: ${r.error || r.reply}`), ceiling: new Date(by).toISOString() });
    // A session that did not take the message has nothing to answer: it counts from the ask like the rest.
    const st = new Map(asked.map((s) => [s.id, { askedAt: firstAskedAt, outcome: null, deferred: null, next: null }]));
    let beat = deps.now();
    for (let open = asked.map((s) => s.id); open.length; open = open.filter((id) => !st.get(id).outcome)) {
      await deps.sleep(Math.min(5000, Math.max(250, t.recheckMin / 4)));
      const now = deps.now();
      const states = new Map((await snapshot(deps, undefined, skipOf(opts, deps))).map((x) => [x.id, x.state]));
      for (const id of open) {
        const x = st.get(id), h = deps.history(id);
        const v = settleVerdict({ state: states.get(id) || 'idle', lines: h.lines, mtime: h.mtime, askedAt: x.askedAt, firstAskedAt, now, settle: t.settle, settleMax: t.settleMax, deferred: Boolean(x.deferred) });
        if (v.reply?.kind === 'defer' && x.deferred?.at !== v.reply.at) { x.deferred = v.reply; x.next = v.reply.at + recheckAfter(v.reply, t); }
        if (v.outcome) { x.outcome = v.outcome; continue; }
        if (!x.deferred || now < x.next) continue;
        x.next = now + recheckAfter(x.deferred, t);
        const r = await sendTo(deps, id, recheckText({ by, why: opts.why }), 30000);
        if (r.ok) x.askedAt = now;
        step('asked a deferring session again', { session: short(id), said: `${x.deferred.lanes} lanes, about ${x.deferred.minutes ?? '?'} min`, accepted: r.ok });
      }
      if (now - beat >= t.beat) {
        beat = now;
        const rest = open.filter((id) => !st.get(id).outcome);
        log(`waiting for ${rest.length} session(s): ${rest.filter((id) => st.get(id).deferred).length} deferred, ${rest.filter((id) => !st.get(id).deferred).length} still working; goes ahead by ${new Date(by).toISOString()}`);
      }
    }
    const of = (...k) => asked.filter((s) => k.includes(st.get(s.id).outcome)).map((s) => s.id);
    report.settled = of('idle', 'ready');
    report.said_ready = of('ready');
    report.interrupted_at_quit = of('stalled', 'capped');
    for (const s of asked) if (st.get(s.id).deferred && st.get(s.id).outcome !== 'ready') lanes.set(s.id, { lanes: st.get(s.id).deferred.lanes, minutes: st.get(s.id).deferred.minutes });
    report.deferred_at_quit = [...lanes].map(([id, l]) => ({ id, ...l }));
    step('settle ended', { settled: report.settled.length, said_ready: report.said_ready.length, went_quiet: of('stalled').map(short), out_of_time: of('capped').map(short), still_deferring: report.deferred_at_quit.map((d) => `${short(d.id)}: ${d.lanes} lanes`) });
  }

  if (opts.safe_point) {
    const a = await opts.safe_point({ before, asked, lanes, report });
    step(a?.what || 'sessions are at a safe point; the app is left running');
    report.ok = true;
    report.safe_point = true;
    return report;
  }

  // 2. Quit, then wait for every process of the app.
  const familyPids = family(await deps.ps(), mainBefore.pid, dir);
  let q;
  if (opts.sigterm) { deps.kill(mainBefore.pid, 'SIGTERM'); q = { ok: true, method: 'sigterm', pid: mainBefore.pid }; } else q = await hackamoreQuit(deps, app, { personWaitMs: t.person, log });
  if (!q.ok) {
    // The app is untouched: tell the sessions that were asked to stop that nothing happened.
    const cancel = await Promise.all(asked.map((x) => sendTo(deps, x.id, cancelText({ why: opts.why }), 30000)));
    step('restart called off: told the sessions to carry on', { told: cancel.filter((r) => r.ok).length, of: asked.length });
    return fail('quit', q.why);
  }
  step('quit sent', { method: q.method, ...(q.item ? { item: q.item } : {}) });
  const alive = async () => { const ps = await deps.ps(); const set = new Set(familyPids); return ps.filter((x) => set.has(x.pid) || x.command.includes(`${dir}/Contents/`)).map((x) => x.pid); };
  let left = await alive();
  const quitSentAt = deps.now();
  const answered = [];
  for (let next = deps.now() + t.dialog, end = deps.now() + t.quit; left.length && deps.now() < end;) {
    await deps.sleep(1000);
    left = await alive();
    // The app asks its window to confirm a quit; if a dialog with a Quit button is up, press it.
    if (left.length && q.method === 'menu' && deps.now() >= next) { next = deps.now() + t.dialog; const d = await answerQuitDialog(deps, app, answered); if (d.pressed) step('the app asked to confirm the quit; answered it', { button: d.pressed, via: 'hackamore' }); }
  }
  if (left.length) {
    // The app did not finish the quit by itself. Its window confirms a quit and waits for the answer (strings in the app:
    // "No app window is ready to handle Quit. The app is still running."), and nothing in the app's log shows it starting
    // to exit; so this is the usual path when it is busy, not a surprise. Ask the app itself to stop first so it can
    // close its sessions, then what its own stop leaves.
    const seen = await readDialog(deps, app);
    const mainLeft = mainBefore && left.includes(mainBefore.pid);
    step(`the app did not quit within ${Math.round((deps.now() - quitSentAt) / 1000)} s of the Quit item${mainLeft ? ` (its own process ${mainBefore.pid} is still running)` : ''}; stopping it with SIGTERM to exact pids`, { alive: left.length, dialog: seen.summary });
    if (mainLeft) {
      deps.kill(mainBefore.pid, 'SIGTERM');
      for (const end = deps.now() + Math.min(t.quit, 15000); left.includes(mainBefore.pid) && deps.now() < end;) { await deps.sleep(1000); left = await alive(); }
    }
    if (left.length) {
      step('stragglers after the app stopped; SIGTERM to exactly these pids', { pids: left });
      for (const pid of left) deps.kill(pid, 'SIGTERM');
      for (const end = deps.now() + Math.min(t.quit, 20000); left.length && deps.now() < end;) { await deps.sleep(1000); left = await alive(); }
    }
  }
  if (left.length) return fail('quit', `${left.length} process(es) of ${app} still running after the quit and a SIGTERM: ${left.join(', ')}. Nothing was relaunched; look at them (ps -p ${left[0]}) before trying again`);
  step('app exited', { processes: familyPids.length });

  // A step of the caller's own while the app is down (a macOS update that restarts the Mac). If it takes over, nothing is
  // relaunched here; if it did not start, or the Mac is still up after its wait, the app is relaunched and resumed as usual.
  if (opts.while_down) {
    const a = await opts.while_down({ before, lanes, report });
    step(a.ok ? (a.what || 'handed over: the Mac is restarting') : 'the step while the app is down did not take over; relaunching');
    if (a.ok) { report.ok = true; report.handed_over = a.what || true; return report; }
  }

  // 3. Relaunch.
  const opened = await deps.open(app, { background: opts.background !== false });
  if (opened.code !== 0) return fail('relaunch', `open -a "${app}" failed: ${opened.stderr.trim().slice(0, 200)}`);
  let main = null;
  for (const end = deps.now() + t.up; !main && deps.now() < end;) { main = findMain(await deps.ps(), dir, await deps.appExe?.(dir)); if (!main) await deps.sleep(1000); }
  if (!main) return fail('relaunch', `${app} did not start within ${Math.round(t.up / 1000)} s`);
  const startedAt = (await deps.startedAt(main.pid)) || deps.now();
  deps.generation?.set(`${main.pid}:${startedAt}`, 'restart-copilot');
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
  // The Hub daemon outlives the app, but the sessions the app brings back must be readable through it: check, and repair at once.
  if (deps.steering) {
    const sr = await deps.steering().catch((e) => ({ ok: false, why: String(e.message || e).slice(0, 120) }));
    report.steering = sr;
    step(sr.ok ? 'Agency Hub still tracks every session (the laptop can see and drive them)' : `Agency Hub's route is not intact: ${sr.why}`);
  }
  if (!opts.resume) { report.ok = true; return report; }

  // 4. Resume and verify.
  const res = await resumeAfter({ before, opts, startedAt, restartedAt: deps.now(), t, lanes }, deps, log);
  report.resume = res;
  deps.owed?.clear?.();
  report.ok = res.every((r) => r.outcome === 'resumed' || r.outcome === 'already continued');
  step(report.ok ? 'every session resumed' : 'some sessions did not resume', { not: res.filter((r) => !['resumed', 'already continued'].includes(r.outcome)).map((r) => `${short(r.id)}: ${r.outcome}`) });
  return report;
}

export async function resumeAfter({ before, opts, startedAt, restartedAt, t, lanes = new Map() }, deps, log = () => {}) {
  await deps.sleep(t.grace);
  const skip = skipOf(opts, deps);
  const after = await snapshot(deps, undefined, skip);
  const targets = pickTargets({ before, after, also: (opts.also || []).filter((id) => !skip.some((p) => id.startsWith(p))).map((id) => after.find((s) => s.id.startsWith(id))?.id || id) });
  // A history over the cap is logged, never resumed (not even when named with --also or owed from before).
  const held = targets.filter((tg) => after.find((s) => s.id === tg.id)?.oversize);
  for (const tg of held) log(`${short(tg.id)}${tg.title ? ` "${tg.title}"` : ''}: NOT resumed: ${after.find((s) => s.id === tg.id).why}; it needs a hand-off to a fresh session`);
  if (held.length) deps.heldBack?.(held.map((tg) => ({ id: tg.id, title: tg.title, bytes: after.find((s) => s.id === tg.id).oversize })));
  const results = await pooled(targets.filter((tg) => !held.includes(tg)), Math.max(1, t.concurrency || 1), async (tg) => {
    const text = resumeText({ at: restartedAt, why: opts.why, lanes: lanes.get(tg.id) || null });
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
      if (!s.ok) {
        rec.last = s.error || s.reply;
        if (/archived|not found|unknown session/i.test(rec.last)) return { ...rec, outcome: `gone: ${rec.last}` };
        if (tries < t.tries) await deps.sleep((t.backoff || [])[Math.min(tries - 1, (t.backoff || []).length - 1)] ?? 0);
        continue;
      }
      for (const end = deps.now() + t.retry; deps.now() < end;) {
        if (tookTurnSince(deps.history(tg.id).lines, at)) return { ...rec, outcome: 'resumed', tries };
        await deps.sleep(3000);
      }
      rec.last = 'delivered but no new turn';
    }
    return { ...rec, outcome: `NOT RESUMED after ${t.tries} tries (${rec.last || 'no reply'})` };
  });
  const failed = results.filter((r) => !/^(resumed|already continued)/.test(r.outcome));
  if (failed.length) log(`NOT RESUMED: ${failed.length} of ${results.length} session(s): ${failed.map((r) => `${short(r.id)}${r.title ? ` "${r.title}"` : ''}: ${r.outcome}`).join('; ')}`);
  return results;
}

// fn over items, at most `limit` at a time; results in the order of items.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  }));
  return out;
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

// ---------- resume only (a crash, an update, a login, a reboot) ----------

// An app process is a "generation": its pid and start time. One generation's sessions are resumed once, by whoever
// gets there first (this, or the restart job that relaunched the app).
export async function appGeneration(opts, deps) {
  const app = opts.app || DEFAULT_APP;
  const dir = deps.appDir(app);
  if (!dir) throw new Refusal('input-invalid', `no app called ${app} in /Applications, /System/Applications or ~/Applications: pass --app with the app's name`);
  const main = findMain(await deps.ps(), dir, await deps.appExe?.(dir));
  if (!main) return { dir, main: null };
  const startedAt = (await deps.startedAt(main.pid)) || null;
  return { dir, main, startedAt, key: `${main.pid}:${startedAt ?? ''}` };
}

// A restart job that is running resumes the sessions itself.
const restartRunning = (deps, now) => { const s = deps.restartState?.(); return Boolean(s && s.state === 'running' && now - Date.parse(s.updated || s.started || 0) < 15 * 60000); };

// Resume what the app's last stop left unfinished: every session whose own history says it was working, that nothing
// has continued since this app process started. Restarts nothing. Idempotent per app process.
export async function resumeOnly(opts, deps, log = () => {}) {
  const t = { ...T, ...Object.fromEntries(Object.entries(opts.t || {})) };
  const g = await appGeneration(opts, deps);
  if (!g.main) { log(`${opts.app || DEFAULT_APP} is not running: nothing to resume`); return { ok: true, skipped: 'app not running', resume: [] }; }
  if (!opts.dry_run && deps.generation?.get() === g.key) { log(`app process ${g.key}: already resumed`); return { ok: true, skipped: 'already resumed', key: g.key, resume: [] }; }
  if (!opts.dry_run && restartRunning(deps, deps.now())) { log('a restart-copilot job is running and resumes the sessions itself'); return { ok: true, skipped: 'a restart is running', key: g.key, resume: [], retry: true }; }
  let ready = false;
  for (const end = deps.now() + t.up; !ready && deps.now() < end;) { ready = await appReady(deps); if (!ready) await deps.sleep(2000); }
  if (!ready) return { ok: false, key: g.key, failed: { stage: 'relaunch', why: `the app is running (pid ${g.main.pid}) but its socket did not answer within ${Math.round(t.up / 1000)} s` }, resume: [] };
  // The restart job may have claimed this process while we waited.
  if (!opts.dry_run && deps.generation?.get() === g.key) { log(`app process ${g.key}: resumed by the restart job`); return { ok: true, skipped: 'already resumed', key: g.key, resume: [] }; }
  if (!opts.dry_run && restartRunning(deps, deps.now())) return { ok: true, skipped: 'a restart is running', key: g.key, resume: [], retry: true };
  const startedAt = g.startedAt || deps.now();
  const skip = skipOf(opts, deps);
  const sessions = await snapshot(deps, undefined, skip);
  // An owed session that is gone (archived) or has taken a turn since this app process started is not owed anything.
  const owed = (deps.owed?.get?.() || []).filter((id) => !skip.some((p) => id.startsWith(p)) && sessions.some((s) => s.id === id) && !tookTurnSince(deps.history(id).lines, startedAt));
  opts = { ...opts, also: [...new Set([...(opts.also || []), ...owed])] };
  // Working now because something started a turn after the app came up: not left over from the stop.
  const before = sessions.map((s) => (s.state === 'busy' && tookTurnSince(deps.history(s.id).lines, startedAt) ? { ...s, state: 'idle', why: 'took a turn since the app started' } : s));
  log(`app process ${g.key}: ${before.filter((s) => s.state === 'busy').length} of ${sessions.length} session(s) were working when the app stopped`);
  if (opts.dry_run) {
    const picked = pickTargets({ before, after: sessions, also: (opts.also || []).filter((id) => !skip.some((p) => id.startsWith(p))).map((id) => sessions.find((s) => s.id.startsWith(id))?.id || id) });
    const heldOf = (tg) => sessions.find((s) => s.id === tg.id)?.oversize;
    const held = picked.filter((tg) => tg.known && heldOf(tg));
    for (const tg of held) log(`${short(tg.id)}${tg.title ? ` "${tg.title}"` : ''}: would NOT resume: history over the cap`);
    return { ok: true, dry_run: true, key: g.key, resume: picked.filter((tg) => tg.known && !heldOf(tg)).map(({ id, title, why }) => ({ id, title, why })), held: held.map(({ id, title }) => ({ id, title, bytes: heldOf({ id }) })), gone: picked.filter((tg) => !tg.known).map(({ id }) => id) };
  }
  deps.generation?.set(g.key, 'resume-only');
  const res = await resumeAfter({ before, opts: { ...opts, also: opts.also || [] }, startedAt, restartedAt: startedAt, t }, deps, log);
  const not = res.filter((r) => !['resumed', 'already continued'].includes(r.outcome));
  if (!not.length) deps.owed?.clear?.();
  log(not.length ? `some sessions did not resume ${JSON.stringify(not.map((r) => `${short(r.id)}: ${r.outcome}`))}` : `resumed ${res.length} session(s)`);
  return { ok: not.length === 0, key: g.key, resume: res };
}

// Resume-only for every new app process, for as long as this runs (launchd keeps it up; see installKeeper).
export async function watch(opts, deps, log = () => {}, { every = 5000, stop = () => false } = {}) {
  let last = null;
  // The first pass after a login opens a closed app, so its sessions come back after a reboot (once per login: an app the person quit later stays quit).
  if (opts.open_at_login && deps.loginClaim?.() && !(await appGeneration(opts, deps)).main) {
    const o = await deps.open(opts.app || DEFAULT_APP, { background: true });
    log(o.code === 0 ? `${opts.app || DEFAULT_APP} was closed at login: opened it in the background` : `${opts.app || DEFAULT_APP} was closed at login and would not open: ${o.stderr.trim().slice(0, 200)}`);
  }
  while (!stop()) {
    try {
      const g = await appGeneration(opts, deps);
      const key = g.main ? g.key : null;
      if (key && key !== last) {
        const r = await resumeOnly(opts, deps, log);
        if (!r.retry) last = key;
        deps.recorded?.({ at: new Date(deps.now()).toISOString(), key, ok: r.ok, skipped: r.skipped || null, resumed: (r.resume || []).map((x) => ({ id: x.id, title: x.title, outcome: x.outcome })), failed: r.failed || null });
      }
      if (!key) last = null;
    } catch (e) { log(`watch: ${e.message || e}`); }
    await deps.sleep(every);
  }
}

// ---------- reading the state ----------

// What --status tells: the run in progress or the last one, from status.json (written at every step), last.json (the
// finished report) and the newest run log.
export function readState(dir = stateDir(), now = Date.now()) {
  const json = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const st = json('status.json'), last = json('last.json'), resumer = json('resume-only.json');
  let log = null, tail = [];
  try {
    log = fs.readdirSync(dir).filter((f) => /^run-.*\.log$/.test(f)).sort().at(-1) || null;
    if (log) tail = fs.readFileSync(path.join(dir, log), 'utf8').trim().split('\n').slice(-4);
  } catch { /* no folder yet */ }
  const base = { dir, log: log ? path.join(dir, log) : null, tail, resumer };
  if (!st && !last) return { ...base, state: 'none' };
  if (!st) return { ...base, state: last.ok ? 'done' : 'failed', step: last.failed ? `failed at ${last.failed.stage}` : 'finished', started: last.started_at, result: last };
  const age = Math.max(0, Math.round((now - Date.parse(st.updated || st.started)) / 1000));
  // last.json is the report of the run that wrote status.json only once that run has finished.
  const result = st.state !== 'running' && last && Math.abs(Date.parse(last.started_at) - Date.parse(st.started)) < 10000 ? last : null;
  return { ...base, state: st.state, step: st.step, started: st.started, updated: st.updated, age_s: age, stale: st.state === 'running' && age > 600, ...(st.failed ? { failed: st.failed } : {}), ...(st.not_resumed ? { not_resumed: st.not_resumed } : {}), result };
}

// A restart job that is running now (its last step under ten minutes ago): starting another would end it mid-way.
export const runInProgress = (dir = stateDir(), now = Date.now()) => { const s = readState(dir, now); return s.state === 'running' && !s.stale ? s : null; };

export function renderState(s) {
  if (s.state === 'none') return `no restart has run on this Mac yet${s.resumer ? `\n${renderResumer(s.resumer)}` : ''}`;
  const L = [];
  const head = { running: `RUNNING: ${s.step || 'starting'}`, done: 'DONE', failed: `FAILED: ${s.step || ''}` }[s.state] || s.state;
  L.push(`restart-copilot ${head}`);
  L.push(`  started ${s.started}${s.updated ? `, last step ${s.age_s} s ago (${s.updated})` : ''}`);
  if (s.stale) L.push(`  no step for ${Math.round(s.age_s / 60)} min: the job may have died; read the log below`);
  if (s.failed) L.push(`  failed at ${s.failed.stage}: ${s.failed.why}`);
  if (s.not_resumed?.length) L.push(`  not resumed: ${s.not_resumed.map((id) => id.slice(0, 8)).join(', ')}`);
  const r = s.result;
  if (r) {
    L.push(`  steps: ${r.steps.map((x) => x.step.split(' {')[0]).join(' → ')}`);
    for (const x of r.resume || []) L.push(`  ${x.id.slice(0, 8)} ${x.title || ''}: ${x.outcome}`);
  }
  if (s.log) L.push(`  log: ${s.log}`);
  if (s.state === 'running') for (const l of s.tail) L.push(`    ${l}`);
  if (s.resumer) L.push(renderResumer(s.resumer));
  return L.join('\n');
}

const renderResumer = (r) => `resume watcher: last app process ${r.key} at ${r.at}: ${r.skipped ? r.skipped : r.ok ? `resumed ${r.resumed.length}` : `NOT everything resumed (${(r.resumed || []).filter((x) => !/^(resumed|already continued)/.test(x.outcome)).map((x) => `${short(x.id)}: ${x.outcome}`).join('; ') || r.failed?.why})`}`;

// ---------- the launchd agent for the resume watcher ----------

export const KEEPER_LABEL = 'bot.ouro.housesitter.copilot-resume';

export function keeperPlist({ node, bin, env = {}, log }) {
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const envs = Object.entries(env).map(([k, v]) => `    <key>${x(k)}</key><string>${x(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${KEEPER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[node, bin, 'restart-copilot', '--resume-only', '--watch', '--open-at-login'].map((a) => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
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

// Write (and, unless dry, load) the agent that runs `restart-copilot --resume-only --watch --open-at-login` at login and keeps it running.
// `before` runs once the agent is written and before it loads: installing it must not resume the app that is already up.
export async function installKeeper({ node, bin, env, home = os.homedir(), dry = false, before = async () => {}, launchctl = (a) => run('/bin/launchctl', a), uid = process.getuid() }) {
  const file = path.join(home, 'Library', 'LaunchAgents', `${KEEPER_LABEL}.plist`);
  const log = path.join(home, 'Library', 'Logs', 'housesitter-copilot-resume.log');
  const text = keeperPlist({ node, bin, env, log });
  if (dry) return { ok: true, dry_run: true, plist: file, log, text };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(file, text);
  await before();
  await launchctl(['bootout', `gui/${uid}/${KEEPER_LABEL}`]);
  const r = await launchctl(['bootstrap', `gui/${uid}`, file]);
  return { ok: r.code === 0, plist: file, log, error: r.stderr.trim() };
}
