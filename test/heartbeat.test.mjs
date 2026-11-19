// housesitter restart-copilot --heartbeat: freeze, crash and stall detection against a pretend Mac and a pretend app whose
// socket takes the connection and never says hello, as the real app's did when its window froze.
import { judgeProgress } from '../src/progress.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyGap, jobErrors, crashSummary, failureText, heaviestPath, judge, parseHistory, pass, recoveryMessage, settleStall } from '../src/heartbeat.mjs';
import { realHeartbeatDeps } from '../src/heartbeat.mjs';
import { readIncidents, recordIncident } from '../src/recovery.mjs';
import { DONE, MID_TURN, haveSqlite, makeHome, startApp } from './fake_app.mjs';

const skip = !haveSqlite() || typeof WebSocket !== 'function';
const BUNDLE = '/Applications/Fake Copilot.app';
const SCRATCH = path.join(path.dirname(new URL(import.meta.url).pathname), '.scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003';

const SAMPLE = `Call graph:
    659 Thread_17230   DispatchQueue_1: com.apple.main-thread  (serial)
    + 659 start  (in dyld) + 6652  [0x199658d7c]
    +   659 main  (in github) + 52  [0x102779ea0]
    +     659 -[NSApplication run]  (in AppKit) + 396  [0x1a358e920]
    +       648 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x1996e7c20]
    +       11 WTF::RunLoop::performWork(void*)  (in JavaScriptCore) + 336  [0x1b95bac70]
    659 Thread_17231
    + 659 other  (in x) + 1  [0x1]
`;

test('judge: a freeze is two minutes of failures on at least three runs in a row; a clean run or a long gap starts over', () => {
  const OLD = { freeze: 120000, minBeats: 3, beatGap: 100000 };
  let bad = null, frozen = false;
  const at = (s) => Date.parse('2026-11-15T12:00:00Z') + s * 1000;
  for (const s of [0, 30, 60, 90]) ({ bad, frozen } = judge(bad, ['window-timeout'], at(s), OLD));
  assert.equal(frozen, false, '90 s is not yet two minutes');
  assert.equal(bad.count, 4);
  ({ bad, frozen } = judge(bad, ['window-timeout', 'socket-timeout'], at(120), OLD));
  assert.equal(frozen, true);
  assert.deepEqual(bad.failures, ['window-timeout', 'socket-timeout']);
  assert.equal(judge(bad, [], at(150), OLD).bad, null, 'one clean run ends the streak');
  const restarted = judge(bad, ['window-timeout'], at(120 + 300), OLD).bad;
  assert.equal(restarted.count, 1, 'runs five minutes apart are not one streak');
  assert.equal(judge(null, ['window-timeout'], at(0), { freeze: 60000, minBeats: 3, beatGap: 100000 }).frozen, false, 'one run is never a freeze');
});

test('heaviestPath follows a sample to its heaviest leaf; crashSummary names the call that threw', () => {
  assert.deepEqual(heaviestPath(SAMPLE).slice(-3), ['main', '-[NSApplication run]', 'mach_msg2_trap']);
  assert.deepEqual(heaviestPath('no call graph here'), []);
  const ips = `{"app_name":"github"}\n${JSON.stringify({ exception: { type: 'EXC_CRASH', signal: 'SIGABRT' }, asi: { 'libsystem_c.dylib': ['abort() called'] }, lastExceptionBacktrace: [{ symbol: '__exceptionPreprocess' }, { symbol: 'objc_exception_throw' }, { symbol: '-[NSWindow setStyleMask:]' }, { symbol: 'NSPerformVisuallyAtomicChange' }] })}`;
  const c = crashSummary(ips);
  assert.equal(c.signal, 'SIGABRT');
  assert.deepEqual(c.frames, ['-[NSWindow setStyleMask:]', 'NSPerformVisuallyAtomicChange']);
  assert.equal(crashSummary('not a report'), null);
});

test('parseHistory reads softwareupdate --history', () => {
  const h = parseHistory('Display Name   Version   Date\n------------\nmacOS 27.2.1                                       27.2.1     11/15/2026, 11:54:12  \n');
  assert.equal(h.length, 1);
  assert.equal(h[0].name, 'macOS 27.2.1');
  assert.equal(new Date(h[0].at).getHours(), 11);
});

test('classifyGap: a reboot for an update, a planned update, a sleep and a plain hang are told apart', () => {
  const at = (h, m) => new Date(2026, 10, 15, h, m).getTime();
  const gap = { from: at(11, 41), to: at(12, 6) };
  const upd = classifyGap({ ...gap, facts: { boot: at(12, 0), installs: [{ name: 'macOS 27.2.1', at: at(11, 54) }], onDemand: at(11, 42) } });
  assert.equal(upd.cause, 'update');
  assert.match(upd.text, /25 min \(11:41 to 12:06\).*restarted at 12:00 for macOS 27\.2\.1 \(installed 11:54\); housesitter did not schedule it.*from 11:42 the system had stopped starting jobs/);
  assert.equal(classifyGap({ ...gap, facts: { boot: at(12, 0), installs: [], planned: { at: new Date(at(11, 50)).toISOString(), label: 'macOS 27.2.1' } } }).cause, 'planned-update');
  assert.equal(classifyGap({ ...gap, facts: { boot: at(12, 0), installs: [], panics: ['Kernel_2026.panic'] } }).cause, 'panic');
  assert.equal(classifyGap({ ...gap, facts: { boot: at(12, 0) } }).cause, 'reboot-unknown');
  const sleep = classifyGap({ ...gap, facts: { sleeps: ['2026-11-15 11:50:00 -0800 Sleep Entering Sleep'], pmsetSleep: '10' } });
  assert.equal(sleep.cause, 'sleep');
  assert.match(sleep.text, /stay awake.*administrator's password/);
  const hang = classifyGap({ ...gap, facts: { load: '70.1 60.2 30.3' } });
  assert.equal(hang.cause, 'hang');
  assert.match(hang.text, /no reboot and no sleep.*Load then: 70\.1/);
});

// 2026-11-16 07:59-08:34: every job ran on schedule but exited 2 ("needs --why"), and the 36 min gap was reported as a Mac hang.
test('classifyGap: runs that exited with an error are told apart from a hang, with the evidence', () => {
  const at = (h, m) => new Date(2026, 10, 16, h, m).getTime();
  const gap = { from: at(7, 58), to: at(8, 34) };
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'jobs-'));
  const log = path.join(dir, 'heartbeat.launchd.log');
  fs.writeFileSync(log, 'error: needs --why: say why\n'.repeat(3));
  const errs = jobErrors(gap.from, gap.to, { home: dir, log });
  assert.equal(errs.count, 3);
  const c = classifyGap({ ...gap, facts: { ownErrors: errs, load: '1 1 1' } });
  assert.equal(c.cause, 'job-errors');
  assert.match(c.text, /Not a Mac hang.*exited with an error for 36 min \(07:58 to 08:34\).*has 3 refusal lines.*needs --why/);
  assert.equal(classifyGap({ ...gap, facts: { ownErrors: { log: null, count: 0, sample: '', exit: 2 } } }).cause, 'job-errors');
  assert.match(classifyGap({ ...gap, facts: { ownErrors: { log: null, count: 0, sample: '', exit: 2 } } }).text, /last exit status for the job is 2/);
  assert.equal(jobErrors(gap.from, gap.to, { home: dir, log: path.join(dir, 'none.log') }), null);
  assert.equal(classifyGap({ ...gap, facts: { ownErrors: null } }).cause, 'hang');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recoveryMessage: once, after the fact, with the count and the evidence; a repeat names the pattern', () => {
  const at = Date.parse('2026-11-15T12:31:00');
  const res = [{ id: A, outcome: 'resumed' }, { id: B, outcome: 'resumed' }, { id: C, title: 'c', outcome: 'NOT RESUMED after 3 tries (socket_error)' }];
  const one = recoveryMessage({ kind: 'freeze', at, res, evidence: '/e/1', failures: ['window-timeout'] });
  assert.match(one, /^The Copilot app froze at \d\d:\d\d: its window stopped answering.*; I restarted it and 2 of 3 sessions resumed \(not: cccccccc c: NOT RESUMED/);
  assert.match(one, /Evidence: \/e\/1$/);
  const two = recoveryMessage({ kind: 'freeze', at, res, evidence: '/e/2', failures: ['window-timeout'], prior: [{ at: '2026-11-15T12:02:00Z', evidence: '/e/1' }], pattern: 'Pattern: same.' });
  assert.match(two, /freeze 2 in an hour.*a pattern, not a one-off\. Pattern: same\. Evidence: \/e\/2; earlier: \/e\/1/);
  assert.match(recoveryMessage({ kind: 'crash', at, res: [], evidence: '/e/3', why: 'SIGABRT in -[NSWindow setStyleMask:]' }), /^The Copilot app crashed at \d\d:\d\d \(SIGABRT in -\[NSWindow setStyleMask:\]\); I relaunched it and 0 of 0 sessions resumed/);
  assert.equal(failureText(['socket-timeout', 'window-timeout']).includes(' and '), true);
});

// A pretend Mac around a pretend app. window: 'ok' | 'timeout' | 'slow' (times out only on the short probe).
async function world({ sessions, hung = false, window = 'ok', stubborn = true } = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, 'hb-'));
  const root = fs.mkdtempSync(path.join(SCRATCH, 'root-'));
  makeHome(home, sessions);
  const app = await startApp(home, { hung });
  const w = { home, root, app, window, kills: [], opens: 0, told: [], crashes: [], procs: [{ pid: 100, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` }, { pid: 101, ppid: 100, command: 'runtime --server' }], startedAt: Date.now() - 600000, facts: {}, resumed: null };
  const state = path.join(root, 'state');
  const d = realHeartbeatDeps({ home: root, copilotHome: home, state });
  Object.assign(d, {
    hackamore: ['hackamore'],
    appDir: () => BUNDLE,
    ps: async () => w.procs,
    startedAt: async () => w.startedAt,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    hk: async (argv, { timeoutMs } = {}) => {
      if (argv[0] !== 'ls') return { code: 0, json: {} };
      if (w.window === 'timeout' || (w.window === 'slow' && timeoutMs <= 1000)) return { code: 1, timedOut: true, text: '' };
      return { code: 0, json: { state: {} } };
    },
    kill: (pid, sig) => { w.kills.push([pid, sig]); if (sig === 'SIGKILL' || !stubborn) w.procs = w.procs.filter((p) => p.pid !== pid); return true; },
    open: async () => { w.opens++; w.startedAt = Date.now(); w.window = 'ok'; w.stalled = false; app.setHung(false); w.procs = [{ pid: 200, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` }]; return { code: 0, stderr: '' }; },
    related: async () => [],
    capture: async (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'sample-main.txt'), SAMPLE); return ['sample-main.txt']; },
    summarizeSample: (dir) => heaviestPath(fs.readFileSync(path.join(dir, 'sample-main.txt'), 'utf8')),
    crashes: () => w.crashes,
    copyFile: () => {},
    tell: async (text) => { w.told.push(text); return { ok: true }; },
    gapFacts: async () => w.facts,
    resumed: () => w.resumed,
    keepAwake: async () => { w.keptAwake = true; },
    // Three sessions the app says are working: writing now, or (stalled) nothing for 30 minutes.
    sessionProgress: async () => [1, 2, 3].map((i) => ({ id: `s${i}`, running: true, lastEventAt: Date.now() - (w.stalled ? 30 * 60000 : 5000) })),
    memorySnapshot: async (dir) => { fs.mkdirSync(dir, { recursive: true }); w.snapshots = (w.snapshots || 0) + 1; },
  });
  w.deps = d;
  w.opts = { app: 'Fake Copilot', t: { socketMs: 150, confirmSocketMs: 300, windowMs: 1000, confirmWindowMs: 2000, term: 200, kill: 200, up: 2000, grace: 0, delivery: 3000, retry: 400, tries: 2, settle: 200 } };
  // Time passes between runs by moving what the last run wrote back by `jump`; inside a run the clock is real.
  w.beat = async (jump = 40000) => {
    const f = path.join(state, 'heartbeat.json');
    if (fs.existsSync(f)) {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      const back = (x) => (x ? new Date(Date.parse(x) - jump).toISOString() : x);
      o.beat_at = back(o.beat_at);
      if (o.bad) { o.bad.since = back(o.bad.since); o.bad.last = back(o.bad.last); }
      if (o.app) o.app.seen_at = back(o.app.seen_at);
      fs.writeFileSync(f, JSON.stringify(o));
    }
    const lines = []; const r = await pass(w.opts, d, (l) => lines.push(l)); r.lines = lines; return r; };
  w.done = async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); };
  return w;
}

const sessions = () => [
  { id: A, title: 'busy a', mode: 'autopilot', running: true, events: MID_TURN },
  { id: B, title: 'idle b', events: DONE },
  { id: C, title: 'busy c', mode: 'interactive', events: MID_TURN },
];

// 2026-11-18: sessionProgress read a copilotHome the deps never carried, every stat failed into "no events", and a
// 50-minute freeze of 23 working sessions went unseen. The stubbed worlds above never ran the real reader.
test('the real sessionProgress finds each session\'s history in the app\'s home', { skip: !haveSqlite() }, async () => {
  const home = fs.mkdtempSync(path.join(SCRATCH, 'hb-'));
  makeHome(home, sessions());
  const d = realHeartbeatDeps({ home: fs.mkdtempSync(path.join(SCRATCH, 'root-')), copilotHome: home });
  const p = await d.sessionProgress();
  assert.equal(p.length, 3);
  assert.ok(p.every((s) => s.lastEventAt > 0), JSON.stringify(p));
  assert.deepEqual(p.filter((s) => s.running).map((s) => s.id), [A]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a healthy app: both probes answer and nothing happens', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  for (let i = 0; i < 3; i++) assert.equal((await w.beat()).action, 'ok');
  assert.deepEqual(w.kills, []);
  assert.deepEqual(w.told, []);
  await w.done();
});

test('a fake hung app: frozen for two minutes, it is evidence, SIGTERM, SIGKILL by exact pid, relaunch, resume, and one message', { skip }, async () => {
  const w = await world({ sessions: sessions(), hung: true, window: 'timeout' }); w.stalled = true;
  const r1 = await w.beat();
  assert.equal(r1.action, 'watching', 'one run of silence is only watched');
  assert.deepEqual(r1.failures, ['no-progress']);
  assert.deepEqual(w.kills, []);
  const r4 = await w.beat(50000);
  assert.equal(r4.action, 'freeze', JSON.stringify(r4.lines));
  assert.equal(r4.ok, true, JSON.stringify(r4.failed || r4.resume));
  assert.deepEqual(w.kills.slice(0, 1), [[100, 'SIGTERM']], 'the graceful stop comes first');
  assert.deepEqual(w.kills.filter(([, s]) => s === 'SIGKILL').map(([p]) => p).sort(), [100, 101], 'then SIGKILL to the exact pids of the app and what it started');
  assert.equal(w.opens, 1);
  assert.deepEqual(r4.resume.map((x) => [x.id, x.outcome]).sort(), [[A, 'resumed'], [C, 'resumed']], 'the working sessions are resumed, the idle one is left alone');
  assert.match(w.app.received.find((m) => m.id === A).prompt, /^The app was restarted at \d\d:\d\d for a frozen window; resume where you left off/);
  assert.equal(w.told.length, 1, 'the person is told once');
  assert.match(w.told[0], /^The Copilot app froze at \d\d:\d\d: the sessions it says are working all stopped writing events.*; I restarted it and 2 of 2 sessions resumed\. Evidence: .*-freeze$/);
  assert.ok(fs.existsSync(path.join(r4.evidence, 'sample-main.txt')), 'a sample was taken before the kill');
  assert.deepEqual(r4.main_thread.slice(-1), ['mach_msg2_trap']);
  const inc = readIncidents(w.deps.state);
  assert.equal(inc.length, 1);
  assert.equal(inc[0].kind, 'freeze');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.deps.state, 'status.json'), 'utf8')).state, 'done');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.deps.state, 'last.json'), 'utf8')).resume.length, 2, 'last.json is the record of the restart');
  assert.equal(w.deps.owed.get().length, 0, 'nothing is owed after the resume');
  // The app is healthy again: the next run is quiet and the streak is gone.
  assert.equal((await w.beat()).action, 'ok');
  assert.equal(w.told.length, 1);
  await w.done();
});

test('a slow socket and window are not a freeze: the sessions are still writing, so nothing is killed', { skip }, async () => {
  const w = await world({ sessions: sessions(), hung: true, window: 'timeout' });
  for (let i = 0; i < 6; i++) assert.equal((await w.beat(40000)).action, 'ok');
  assert.deepEqual(w.kills, []);
  assert.deepEqual(w.told, []);
  await w.done();
});

test('a quiet stretch shorter than ten minutes, or fewer than three working sessions, is not a freeze', () => {
  const now = 1e12, mk = (n, ago) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, running: true, lastEventAt: now - ago }));
  assert.equal(judgeProgress(mk(5, 9 * 60000), now).stalled, false);
  assert.equal(judgeProgress(mk(5, 11 * 60000), now).stalled, true);
  assert.equal(judgeProgress(mk(2, 30 * 60000), now).stalled, false);
  assert.equal(judgeProgress(mk(5, 3 * 3600000), now).stalled, false, 'sessions stuck "working" for hours were never working');
  assert.equal(judgeProgress([...mk(5, 30 * 60000), { id: 'x', running: false, lastEventAt: now - 1000 }], now).stalled, false, 'any session writing means it is alive');
});

test('replay of 2026-11-15 (every session event, 21:00-23:05 UTC): the 22:27, 22:40 and 22:51 restarts would not have fired; the stop at the reboot would', () => {
  const sec = JSON.parse(fs.readFileSync(new URL('./fixtures/event-seconds-2026-11-15.json', import.meta.url), 'utf8')).map((x) => x * 1000);
  const fires = [];
  for (let now = Date.parse('2026-11-15T21:10:00Z'); now <= Date.parse('2026-11-15T23:20:00Z'); now += 30000) {
    const seen = sec.filter((t) => t <= now);
    const sessions = [1, 2, 3, 4].map((i) => ({ id: `s${i}`, running: true, lastEventAt: seen.at(-1) }));
    if (judgeProgress(sessions, now).stalled) fires.push(new Date(now).toISOString().slice(11, 16));
  }
  assert.ok(!fires.some((f) => f < '23:00'), `fired while sessions were writing: ${fires}`);
  assert.ok(fires.some((f) => f >= '23:15'), 'a real stop of every session does fire');
});

test('a second freeze in an hour is recovered again and the message names the pattern; a fourth is held and told once', { skip }, async () => {
  const w = await world({ sessions: sessions(), hung: true, window: 'timeout' }); w.stalled = true;
  recordIncident(w.deps.state, { kind: 'freeze', at: new Date(Date.now() - 20 * 60000).toISOString(), evidence: '/e/earlier', ok: true, failures: ['no-progress'], main_thread: ['mach_msg2_trap'] });
  await w.beat(40000);
  const r = await w.beat(50000);
  assert.equal(r.action, 'freeze');
  assert.match(w.told[0], /freeze 2 in an hour.*Pattern: every time it was the same.*the main thread's sample ended in mach_msg2_trap each time.*earlier: \/e\/earlier/);
  // Two more recoveries in the hour fill the cap; the next freeze is held, and the person hears once.
  recordIncident(w.deps.state, { kind: 'freeze', at: new Date().toISOString(), evidence: '/e/third', ok: true });
  w.app.setHung(true); w.window = 'timeout'; w.stalled = true; w.startedAt += 1;
  w.procs = [{ pid: 300, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` }];
  await w.beat(40000);
  const held = await w.beat(50000);
  assert.equal(held.action, 'capped');
  assert.equal(w.told.length, 2);
  assert.match(w.told[1], /froze 2 times in 15 minutes.*backing off and took a memory snapshot/);
  assert.equal(w.snapshots, 1, 'a memory snapshot was taken once');
  await w.beat(40000);
  assert.equal(w.told.length, 2, 'held, and told only once');
  await w.done();
});

test('a fake crash: a crash report and no app means relaunch and resume; no report and nothing working means it stays closed', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  await w.beat();
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.deps.state, 'heartbeat.json'), 'utf8')).app.pid, 100);
  w.procs = [];
  w.crashes = [{ file: '/x/github-1.ips', at: Date.now() + 1000, summary: { signal: 'SIGABRT', frames: ['-[NSWindow setStyleMask:]', 'NSPerformVisuallyAtomicChange'] } }];
  const r = await w.beat(30000);
  assert.equal(r.action, 'crash', JSON.stringify(r.lines));
  assert.equal(w.opens, 1);
  assert.deepEqual(r.resume.map((x) => x.outcome), ['resumed', 'resumed']);
  assert.match(w.told[0], /^The Copilot app crashed at \d\d:\d\d \(SIGABRT in -\[NSWindow setStyleMask:\] ← NSPerformVisuallyAtomicChange\); I relaunched it and 2 of 2 sessions resumed\./);
  await w.done();
  const q = await world({ sessions: [{ id: B, title: 'idle b', events: DONE }] });
  await q.beat();
  q.procs = [];
  const n = await q.beat(30000);
  assert.equal(n.action, 'absent');
  assert.equal(q.opens, 0, 'an app a person quit stays quit');
  assert.deepEqual(q.told, []);
  await q.done();
  // Sessions working and the app gone: relaunched after five minutes even with no crash report.
  const r2 = await world({ sessions: sessions() });
  await r2.beat();
  assert.equal(JSON.parse(fs.readFileSync(path.join(r2.deps.state, 'heartbeat.json'), 'utf8')).app.busy, 1, 'the beat notes how many sessions are running');
  r2.procs = [];
  assert.equal((await r2.beat(60000)).action, 'absent');
  assert.equal(r2.opens, 0, 'one minute gone is not enough');
  const late = await r2.beat(280000);
  assert.equal(late.action, 'crash');
  assert.equal(r2.opens, 1);
  await r2.done();
});

test('a gap in the runs is the Mac stopping: the cause is recorded, and the person hears once, after the sessions resumed', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  const at = (h, m) => new Date(2026, 10, 15, h, m).getTime();
  const gapTo = Date.now();
  const gapFrom = gapTo - 25 * 60000;
  fs.mkdirSync(w.deps.state, { recursive: true });
  fs.writeFileSync(path.join(w.deps.state, 'heartbeat.json'), JSON.stringify({ beat_at: new Date(gapFrom).toISOString() }));
  w.facts = { boot: gapFrom + 19 * 60000, installs: [{ name: 'macOS 27.2.1', at: gapFrom + 13 * 60000 }], onDemand: gapFrom + 60000 };
  void at;
  const r = await w.beat(0);
  assert.equal(r.action, 'ok');
  const inc = readIncidents(w.deps.state).filter((x) => x.kind === 'stall');
  assert.equal(inc.length, 1);
  assert.equal(inc[0].cause, 'update');
  assert.deepEqual(w.told, [], 'not yet: the sessions have not been resumed');
  w.resumed = { at: new Date(Date.now() + 5000).toISOString(), resumed: [{ id: A, outcome: 'resumed' }, { id: C, outcome: 'resumed' }] };
  await w.beat(30000);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0], /macOS 27\.2\.1.*housesitter did not schedule it.*Everything came back by launchd, and 2 of 2 sessions resumed\.$/);
  await w.beat(30000);
  assert.equal(w.told.length, 1, 'told once');
  await w.done();
});

test('settleStall tells after ten minutes even if no resume was recorded', { skip }, async () => {
  const told = [];
  const deps = { now: () => 1e12, tell: async (t) => told.push(t), resumed: () => null };
  const st = { stall_pending: { to: new Date(1e12 - 11 * 60000).toISOString(), mins: 25, cause: 'hang', text: 'The Mac stopped.' } };
  assert.equal(await settleStall({ st, deps }), null);
  assert.match(told[0], /^The Mac stopped\. The sessions had not finished resuming/);
});

test('a gap while the job was switched off is "paused", never a hang, and is never told', { skip }, async () => {
  assert.equal(classifyGap({ from: 0, to: 66 * 60000, facts: { paused: true, load: '1' } }).cause, 'paused');
  const w = await world({ sessions: sessions() });
  w.facts = { paused: true };
  await w.beat();
  await w.beat(66 * 60000);
  assert.deepEqual(w.told, [], 'a pause is recorded but nobody is told');
  await w.beat(40000);
  assert.deepEqual(w.told, []);
  await w.done();
});

test('a streak from before the progress rule (socket-timeout) is dropped, not reported', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  await w.beat();
  const f = path.join(w.root, 'state', 'heartbeat.json');
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  o.bad = { since: new Date(Date.now() - 4565000).toISOString(), last: new Date(Date.now() - 4000000).toISOString(), count: 5, failures: ['socket-timeout'] };
  fs.writeFileSync(f, JSON.stringify(o));
  const r = await w.beat();
  assert.equal(r.action, 'ok');
  assert.ok(!r.lines.some((l) => /socket-timeout|did not for/.test(l)));
  await w.done();
});
