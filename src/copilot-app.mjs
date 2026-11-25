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
//      SIGTERM to the exact pid with --sigterm, or when hackamore sees no Quit menu item (the app's UI is frozen). Wait until every process of the app has exited.
//   3. Relaunch: open -a, then wait until the app answers on its local socket.
//   4. After: every session that was working, was interrupted by the quit, or was named with --also (and is not named with --skip) gets one resume
//      message through the app's socket, unless something already continued it. Each one must then take a turn. Shepherd's resume() sends and checks them and keeps the record its six-hour health watch follows.
//
// A session is left out when it is named with --skip or in ~/.config/housesitter/restart-copilot.json ({ "skip": ["<session id or its first 8+ characters>"] }),
// which the planned restart and the crash resume share; and a session whose last turn was over 24 h before the stop is never resumed.
//
// `--resume-only` runs just step 4 for an app that stopped some other way (a crash, an update, a login, a reboot), and
// `--resume-only --watch` does it for every new app process, as a launchd agent that `--install-keeper` writes.
//
// Everything that touches the Mac goes through `deps`, so tests run the whole sequence against a pretend Mac.

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFER, READY, RESUME_T, ShepherdError, appReady, deps as shepherdDeps, lastReply, pickTargets, resume, resumeText, sendTo, snapshot, stateDir as shepherdStateDir, tookTurnSince } from '@ouro.bot/shepherd';
import { Refusal } from './hands.mjs';
import { which } from './peer-watch.mjs';

// The app's sessions (the socket, the database, the histories) and the resume (its messages, its checks, its record) are Shepherd's; these are re-exported for the callers here.
export { MAX_HISTORY_BYTES, appReady, lastReply, pickTargets, resumeText, sendTo, snapshot, tookTurnSince } from '@ouro.bot/shepherd';

export const DEFAULT_APP = 'GitHub Copilot';
export const T = { settle: 600000, settleMax: 10800000, recheckMin: 120000, recheckMax: 1200000, beat: 60000, sendTries: 5, sendPause: 60000, quit: 60000, dialog: 4000, person: 600000, up: 120000, verify: 180000, ...RESUME_T };
// A session the app no longer has (archived or deleted on purpose) is not a failed resume.
export const isGone = (o) => /^gone/.test(o || '');
export const isDone = (o) => o === 'resumed' || o === 'already continued' || isGone(o);

export const LABEL = 'bot.ouro.housesitter.restart-copilot';
export const configPath = (home = os.homedir()) => process.env.HOUSESITTER_RESTART_CONFIG || path.join(home, '.config', 'housesitter', 'restart-copilot.json');

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const short = (id) => String(id).slice(0, 8);

// A Shepherd failure is the Refusal this module has always thrown: the same problem and fix, under the same code.
const refused = (e) => (e instanceof ShepherdError ? new Refusal(e.code === 'node-too-old' ? 'action-unavailable' : 'action-failed', e.message) : e);
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw refused(e); } };

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

export const settleText = ({ by, stallSec, why, what = 'the GitHub Copilot app restarts' }) => `Heads up: ${what}${why ? ` for ${why}` : ''}, as soon as every working session is ready and no later than about ${hhmm(by)}. Reach a safe point now: commit and push, or save to your task notes, anything not yet in git or your session, and start nothing long. When you are there, say so: end your turn with a line that is exactly ${READY}. If stopping your background lanes (subagents, shell jobs) now would lose work you cannot redo from pushed state, answer instead with a line of its own, ${DEFER}: <n> lanes running, about <m> min, and the restart waits for you and asks again when your estimate is up. A session that has not deferred and goes ${stallSec < 120 ? `${stallSec} seconds` : `${Math.round(stallSec / 60)} minutes`} without a step is not waited for. You will be sent a message to resume once the app is back.`;
export const recheckText = ({ by, why }) => `Recheck for the restart${why ? ` for ${why}` : ''}: are you at a safe point yet? Answer with a line of its own: ${READY}, or ${DEFER}: <n> lanes running, about <m> min again. The restart goes ahead at about ${hhmm(by)} whatever the answers.`;
export const cancelText = ({ why }) => `The restart${why ? ` for ${why}` : ''} was called off: the app did not quit and is still running, so nothing was stopped. Carry on with what you were doing; there is nothing to resume.`;

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

// The hackamore this package depends on, run with the node that runs housesitter.
function bundledHackamore() {
  try { return [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.resolve('@ouro.bot/hackamore'))), '..', 'bin', 'hackamore.mjs')]; } catch { return null; }
}

// A hackamore command as an argv. An array or a JSON array is taken as is; a string naming a file is one program (its
// path may hold spaces); any other string is a command line ("npx hackamore") split on whitespace.
export function hackamoreArgv(given) {
  if (!given) return null;
  if (Array.isArray(given)) return given.length ? given.map(String) : null;
  const s = String(given).trim();
  if (s.startsWith('[')) { try { const a = JSON.parse(s); if (Array.isArray(a) && a.length && a.every((x) => typeof x === 'string')) return a; } catch { /* a plain string */ } }
  if (fs.existsSync(s)) return [s];
  return s.split(/\s+/);
}

export function realDeps({ copilotHome = path.join(os.homedir(), '.copilot'), home = os.homedir(), hackamore = null, state = stateDir(), config = configPath(), warn = () => {} } = {}) {
  const given = hackamore || process.env.HOUSESITTER_HACKAMORE || which('hackamore');
  const cmd = hackamoreArgv(given) || bundledHackamore();
  const app = shepherdDeps({ copilotHome });
  return {
    home: copilotHome,
    // Shepherd's record of a resume (the health watch reads it): its own state folder, under this home.
    shepherdState: shepherdStateDir(home),
    hackamore: cmd,
    skipList: () => readSkipConfig(config, warn),
    now: () => Date.now(),
    sleep: sleepReal,
    ps: async () => parsePs((await run('/bin/ps', ['-axo', 'pid=,ppid=,command='])).stdout),
    startedAt: async (pid) => Date.parse((await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])).stdout.trim()),
    // The app's database, histories and socket: Shepherd's.
    sql: guard(app.sql),
    historySize: app.historySize,
    history: app.history,
    // sendTo puts a compressed history back first, so it needs Shepherd's history path and gunzip.
    historyPath: app.historyPath,
    gunzip: app.gunzip,
    hk: async (argv, { timeoutMs = 60000 } = {}) => {
      const r = await run(cmd[0], [...cmd.slice(1), ...argv], { timeoutMs });
      let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
      return { code: r.code, json, timedOut: r.timedOut, text: (r.stderr || r.stdout).trim().slice(0, 300) };
    },
    kill: (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } },
    open: async (appName, { background }) => run('/usr/bin/open', [...(background ? ['-g'] : []), '-a', appName]),
    exchange: guard(app.exchange),
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
    // Every pass is recorded. Shepherd keeps the resume record (resume-last.json) when a resume sent anything, so a later "already resumed" pass never replaces it.
    heldBack: (list) => { try { fs.mkdirSync(state, { recursive: true }); fs.appendFileSync(path.join(state, 'held-back.log'), list.map((x) => `${JSON.stringify({ at: new Date().toISOString(), ...x })}\n`).join('')); } catch { /* a courtesy */ } },
    recorded: (o) => { try { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'resume-only.json'), JSON.stringify(o)); } catch { /* a courtesy */ } },
    appDir: (name) => ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')].map((d) => path.join(d, `${name}.app`)).find((p) => fs.existsSync(p)) || null,
  };
}

// ---------- the steps ----------

// Hackamore's others-see actions need --why. A restart someone asked for forwards their words; a scheduled one names its job.
export const hackamoreWhy = (why) => String(why || '').trim() || "Housesitter's scheduled restart-copilot job, which Ari installed on this Mac to restart the app after plugin or macOS updates";

async function hackamoreQuit(deps, app, { personWaitMs, log, why }) {
  const ls = await deps.hk(['ls', app]);
  if (ls.code !== 0 || !ls.json) return { ok: false, why: `hackamore ls ${app} failed: ${ls.text || `exit ${ls.code}`}` };
  const item = quitItem(ls.json);
  if (!item) return { ok: false, why: `hackamore sees no Quit menu item in ${app} (it may be protected or have no menu bar)` };
  const input = JSON.stringify({ item, app });
  for (const end = deps.now() + personWaitMs; ;) {
    const r = await deps.hk(['do', 'menu', input, '--why', hackamoreWhy(why)]);
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
async function answerQuitDialog(deps, app, answered, why) {
  const d = await readDialog(deps, app);
  const b = (d.quit || []).find((e) => !answered.includes(e.label));
  if (!b) return { pressed: null };
  answered.push(b.label);
  const r = await deps.hk(['do', 'click', JSON.stringify({ element: b.ref, app }), '--why', hackamoreWhy(why)]);
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
    // A running app whose menu bar hackamore cannot read is not answering its UI (a frozen web view): the menu quit can never
    // work, so SIGTERM to the exact pid is the only way out. Without this a frozen app could not be restarted unattended.
    if (item) quit = { method: 'menu', item, via: deps.hackamore.join(' '), gate: ls.json?.state?.gate || undefined };
    else if (ls.code === 0 && main) quit = { method: 'sigterm', pid: main.pid, fallback: `hackamore sees no Quit menu item in ${app} (its UI is not answering): SIGTERM instead` };
    else quit = { method: 'unavailable', why: ls.code === 0 ? `hackamore sees no Quit menu item in ${app}` : `hackamore ls ${app} failed: ${ls.text}` };
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
      quit.method === 'menu' ? `quit with hackamore: do menu "${quit.item}"` : quit.method === 'sigterm' ? `quit with SIGTERM to pid ${quit.pid}${quit.fallback ? ` (${quit.fallback})` : ''}` : `cannot quit: ${quit.why}`,
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
  const not = r.not_resumed || (r.resume || []).filter((x) => !isDone(x.outcome)).map((x) => x.id);
  const archived = (r.resume || []).filter((x) => isGone(x.outcome)).map((x) => x.id);
  write({ state: r.ok ? 'done' : 'failed', step: r.failed ? `failed at ${r.failed.stage}` : 'finished', ...(r.failed ? { failed: r.failed } : {}), ...(not.length ? { not_resumed: not } : {}), ...(archived.length ? { archived } : {}) });
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
    const askAll = () => Promise.all(asked.map((s) => sendTo(deps, s.id, settleText({ by, stallSec: Math.round(t.settle / 1000), why: opts.why, what: opts.what }), 30000).then((r) => ({ id: s.id, ...r }))));
    let sent = await askAll();
    // A busy laptop can be slow to take a message while its menu still answers: that is a slow app, not a frozen one, and quitting it
    // would stop every working session without a safe point. Ask again a few times, then call the restart off with nothing touched.
    for (let n = 2; !sent.some((r) => r.ok) && p.quit.method === 'menu' && n <= t.sendTries; n++) {
      step(`no session took the message but the app's menu answers: it is slow, not frozen; asking again in ${Math.round(t.sendPause / 1000)} s`, { try: n - 1, of: t.sendTries });
      await deps.sleep(t.sendPause);
      sent = await askAll();
    }
    if (!sent.some((r) => r.ok) && p.quit.method === 'menu') return fail('settle', `none of the ${asked.length} working sessions took the message in ${t.sendTries} tries, though the app's menu answers; nothing was quit, so the sessions carry on. It will try again later`);
    step('asked to reach a safe point', { asked: asked.length, accepted: sent.filter((r) => r.ok).length, refused: sent.filter((r) => !r.ok).map((r) => `${short(r.id)}: ${r.error || r.reply}`), ceiling: new Date(by).toISOString() });
    // A session that did not take the message has nothing to answer: it counts from the ask like the rest. When none took it,
    // the app is not answering (a frozen app refuses every send): nobody can reach a safe point, so waiting only delays the fix.
    const unreachable = !sent.some((r) => r.ok);
    if (unreachable) step('no session took the message: the app is not answering, so the restart does not wait', { refused: sent.length });
    const st = new Map(asked.map((s) => [s.id, { askedAt: firstAskedAt, outcome: unreachable ? 'unreachable' : null, deferred: null, next: null }]));
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
        const named = (ids) => ids.map((id) => `${short(id)}${asked.find((x) => x.id === id)?.title ? ` "${asked.find((x) => x.id === id).title}"` : ''}`).join(', ');
        log(`waiting for ${rest.length} session(s): ${rest.filter((id) => st.get(id).deferred).length} deferred${named(rest.filter((id) => st.get(id).deferred)) ? ` (${named(rest.filter((id) => st.get(id).deferred))})` : ''}, ${rest.filter((id) => !st.get(id).deferred).length} still working${named(rest.filter((id) => !st.get(id).deferred)) ? ` (${named(rest.filter((id) => !st.get(id).deferred))})` : ''}; goes ahead by ${new Date(by).toISOString()}`);
      }
    }
    const of = (...k) => asked.filter((s) => k.includes(st.get(s.id).outcome)).map((s) => s.id);
    report.settled = of('idle', 'ready');
    report.said_ready = of('ready');
    report.interrupted_at_quit = of('stalled', 'capped', 'unreachable');
    for (const s of asked) if (st.get(s.id).deferred && st.get(s.id).outcome !== 'ready') lanes.set(s.id, { lanes: st.get(s.id).deferred.lanes, minutes: st.get(s.id).deferred.minutes });
    report.deferred_at_quit = [...lanes].map(([id, l]) => ({ id, ...l }));
    step('settle ended', { settled: report.settled.length, said_ready: report.said_ready.length, went_quiet: of('stalled').map(short), ...(of('unreachable').length ? { unreachable: of('unreachable').map(short) } : {}), out_of_time: of('capped').map(short), still_deferring: report.deferred_at_quit.map((d) => `${short(d.id)}: ${d.lanes} lanes`) });
  }

  if (opts.safe_point) {
    const a = await opts.safe_point({ before, asked, lanes, report });
    step(a?.what || 'sessions are at a safe point; the app is left running');
    report.ok = true;
    report.safe_point = true;
    return report;
  }

  // 2. Quit, then wait for every process of the app.
  const psAtQuit = await deps.ps();
  const familyPids = family(psAtQuit, mainBefore.pid, dir);
  const cmdAt = new Map(psAtQuit.map((x) => [x.pid, x.command]));
  let q;
  if (p.quit.method === 'sigterm') { deps.kill(mainBefore.pid, 'SIGTERM'); q = { ok: true, method: 'sigterm', pid: mainBefore.pid, ...(p.quit.fallback ? { fallback: p.quit.fallback } : {}) }; } else q = await hackamoreQuit(deps, app, { personWaitMs: t.person, log, why: opts.why });
  if (!q.ok) {
    // The app is untouched: tell the sessions that were asked to stop that nothing happened.
    const cancel = await Promise.all(asked.map((x) => sendTo(deps, x.id, cancelText({ why: opts.why }), 30000)));
    step('restart called off: told the sessions to carry on', { told: cancel.filter((r) => r.ok).length, of: asked.length });
    return fail('quit', q.why);
  }
  step('quit sent', { method: q.method, ...(q.item ? { item: q.item } : {}), ...(q.fallback ? { why: q.fallback } : {}) });
  // A pid counts only while it still runs the command it ran at the quit: pids get reused.
  const ownsPid = (x) => (new Set(familyPids).has(x.pid) && x.command === cmdAt.get(x.pid)) || x.command.includes(`${dir}/Contents/`);
  const alive = async () => (await deps.ps()).filter(ownsPid).map((x) => x.pid);
  let left = await alive();
  const quitSentAt = deps.now();
  const answered = [];
  for (let next = deps.now() + t.dialog, end = deps.now() + t.quit; left.length && deps.now() < end;) {
    await deps.sleep(1000);
    left = await alive();
    // The app asks its window to confirm a quit; if a dialog with a Quit button is up, press it.
    if (left.length && q.method === 'menu' && deps.now() >= next) { next = deps.now() + t.dialog; const d = await answerQuitDialog(deps, app, answered, opts.why); if (d.pressed) step('the app asked to confirm the quit; answered it', { button: d.pressed, via: 'hackamore' }); }
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
  if (left.length) {
    // SIGTERM and its grace did not end them: SIGKILL exactly these pids, each re-checked against its own command first.
    const ps = await deps.ps();
    const mine = left.filter((pid) => { const x = ps.find((p) => p.pid === pid); return x && ownsPid(x); });
    step('stragglers survived SIGTERM; SIGKILL to exactly these pids', { pids: mine, commands: mine.map((pid) => (ps.find((p) => p.pid === pid).command || '').slice(0, 80)) });
    for (const pid of mine) deps.kill(pid, 'SIGKILL');
    for (const end = deps.now() + Math.min(t.quit, 10000); left.length && deps.now() < end;) { await deps.sleep(1000); left = await alive(); }
  }
  if (left.length) {
    const why = `${left.length} process(es) of ${app} still running after the quit, a SIGTERM and a SIGKILL: ${left.join(', ')}. Nothing was relaunched; look at them (ps -p ${left[0]})`;
    await told(deps, `The Copilot app restart could not finish: ${why}. The app is down or stuck and I could not bring it back by myself.`);
    return fail('quit', why);
  }
  step('app exited', { processes: familyPids.length });

  // A step of the caller's own while the app is down (a macOS update that restarts the Mac). If it takes over, nothing is
  // relaunched here; if it did not start, or the Mac is still up after its wait, the app is relaunched and resumed as usual.
  if (opts.while_down) {
    const a = await opts.while_down({ before, lanes, report });
    step(a.ok ? (a.what || 'handed over: the Mac is restarting') : 'the step while the app is down did not take over; relaunching');
    if (a.ok) { report.ok = true; report.handed_over = a.what || true; return report; }
  }

  // 3. Relaunch, and do not stop until the app's socket answers and a window is open: retried, and a person is told only
  // when it still will not come back.
  const tries = Math.max(1, t.relaunchTries || 3);
  let main = null, ready = false, startedAt, lastWhy = '';
  for (let n = 1; n <= tries && !ready; n++) {
    main = findMain(await deps.ps(), dir, await deps.appExe?.(dir));
    if (!main) {
      const opened = await deps.open(app, { background: opts.background !== false });
      if (opened.code !== 0) { lastWhy = `open -a "${app}" failed: ${opened.stderr.trim().slice(0, 200)}`; step(`relaunch try ${n} of ${tries}: ${lastWhy}`); await deps.sleep(t.relaunchPause ?? 5000); continue; }
      for (const end = deps.now() + t.up; !main && deps.now() < end;) { main = findMain(await deps.ps(), dir, await deps.appExe?.(dir)); if (!main) await deps.sleep(1000); }
      if (!main) { lastWhy = `${app} did not start within ${Math.round(t.up / 1000)} s`; step(`relaunch try ${n} of ${tries}: ${lastWhy}`); continue; }
    }
    startedAt = (await deps.startedAt(main.pid)) || deps.now();
    deps.generation?.set(`${main.pid}:${startedAt}`, 'restart-copilot');
    report.restarted_at = new Date(deps.now()).toISOString();
    step('relaunched', { pid: main.pid, from: mainBefore.pid, try: n });
    if (opts.stand_in) { report.ok = true; return report; }
    for (const end = deps.now() + t.up; !ready && deps.now() < end;) { ready = await appReady(deps); if (!ready) await deps.sleep(2000); }
    if (!ready) { lastWhy = `${app} is running but its socket did not answer within ${Math.round(t.up / 1000)} s`; step(`relaunch try ${n} of ${tries}: ${lastWhy}`); if (n < tries) { deps.kill(main.pid, 'SIGTERM'); await deps.sleep(t.relaunchPause ?? 5000); } }
  }
  if (!ready) {
    report.not_resumed = before.filter((s) => s.state === 'busy').map((s) => s.id);
    const why = `${lastWhy}; the ${report.not_resumed.length} session(s) that were working (report.not_resumed) were not resumed`;
    await told(deps, `The Copilot app restart could not bring the app back after ${tries} tries: ${why}.`);
    return fail('relaunch', why);
  }
  // A background launch can leave the app running with no window (the Dock says "Running in Background"): open one.
  const hasWindow = async () => (deps.windowOpen ? deps.windowOpen(app, { pid: main.pid }) : windowFromLs(await deps.hk(['ls', app], { timeoutMs: 20000 }), main.pid));
  const win = await hasWindow();
  if (win === null) { await deps.open(app, { background: false }); step('could not read whether the app has a window; asked it to open one'); }
  else if (win === false) {
    let seen = false;
    for (let n = 1; n <= tries && !seen; n++) {
      await deps.open(app, { background: false });
      for (const end = deps.now() + (t.window ?? 15000); !seen && deps.now() < end;) { await deps.sleep(1000); seen = (await hasWindow()) === true; }
      step(seen ? 'the app was running without a window; opened one' : `the app has no window yet (try ${n} of ${tries})`);
    }
    if (!seen) {
      const why = `${app} is running but no window opened after ${tries} tries`;
      await told(deps, `The Copilot app restart: ${why}; someone needs to click it in the Dock.`);
      return fail('relaunch', why);
    }
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
  report.ok = res.every((r) => isDone(r.outcome));
  step(report.ok ? 'every session resumed' : 'some sessions did not resume', { not: res.filter((r) => !isDone(r.outcome)).map((r) => `${short(r.id)}: ${r.outcome}`) });
  return report;
}

// Whether the app has a window, from `hackamore ls <app>` (which holds the Accessibility grant): true or false, or null when
// it cannot be read or the screen read belongs to another process. The app's process is named `github`, so it is matched by pid.
export function windowFromLs(r, pid) {
  const st = r?.json?.state;
  if (!st || r.code !== 0 || !st.app) return null;
  if (pid && st.app.pid !== pid) return null;
  return Boolean(st.window);
}

// One message to the agent when a restart cannot finish on its own; best effort.
async function told(deps, text) { try { await deps.tell?.(text); } catch { /* the failure is in the run log too */ } }

export async function resumeAfter({ before, opts, startedAt, restartedAt, t, lanes = new Map() }, deps, log = () => {}) {
  await deps.sleep(t.grace);
  const skip = skipOf(opts, deps);
  const after = await snapshot(deps, undefined, skip);
  const targets = pickTargets({ before, after, also: (opts.also || []).filter((id) => !skip.some((p) => id.startsWith(p))).map((id) => after.find((s) => s.id.startsWith(id))?.id || id) });
  // Shepherd sends each resume, holds an over-cap history, checks each turn and writes the record its health watch follows.
  return resume({ ...deps, state: deps.shepherdState }, { targets, startedAt, restartedAt, why: opts.why, lanes, t, log });
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
  const not = res.filter((r) => !isDone(r.outcome));
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
  return { ...base, state: st.state, step: st.step, started: st.started, updated: st.updated, age_s: age, stale: st.state === 'running' && age > 600, ...(st.failed ? { failed: st.failed } : {}), ...(st.not_resumed ? { not_resumed: st.not_resumed } : {}), ...(st.archived ? { archived: st.archived } : {}), result };
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
  if (s.archived?.length) L.push(`  archived, not resumed: ${s.archived.map((id) => id.slice(0, 8)).join(', ')}`);
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

const renderResumer = (r) => `resume watcher: last app process ${r.key} at ${r.at}: ${r.skipped ? r.skipped : r.ok ? `resumed ${r.resumed.length}` : `NOT everything resumed (${(r.resumed || []).filter((x) => !/^(resumed|already continued|gone)/.test(x.outcome)).map((x) => `${short(x.id)}: ${x.outcome}`).join('; ') || r.failed?.why})`}`;

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
