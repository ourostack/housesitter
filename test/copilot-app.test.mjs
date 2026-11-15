// housesitter restart-copilot: the whole sequence against a pretend Mac (a process table, a Quit menu) and a pretend
// Copilot app (a state folder and a local WebSocket), so the real socket, database and history code runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { family, findMain, installKeeper, KEEPER_LABEL, loopState, parsePs, pickTargets, plan, quitItem, readState, realDeps, renderState, restart, resumeOnly, runInProgress, saidReady, settleVerdict, watch, resumeText, settleText } from '../src/copilot-app.mjs';
import { DONE, MID_TURN, haveSqlite, makeHome, startApp } from './fake_app.mjs';

// The app's socket needs Node 22's global WebSocket; sqlite3 reads the pretend database.
const skip = !haveSqlite() || typeof WebSocket !== 'function';
const BUNDLE = '/Applications/Fake Copilot.app';
const ev = (type, data = {}, at = Date.now()) => JSON.stringify({ type, data, timestamp: new Date(at).toISOString() });
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003', D = 'dddddddd-0000-4000-8000-000000000004';

test('loopState: working mid-turn, between tool turns and on a running subagent; not working when finished or stopped', () => {
  const run = (...types) => loopState(types.map((t) => (Array.isArray(t) ? ev(t[0], t[1]) : ev(t))));
  assert.equal(run('user.message', 'assistant.turn_start').working, true);
  assert.equal(run('user.message', 'assistant.turn_start', ['assistant.message', { toolRequests: [{}] }], 'assistant.turn_end').working, true, 'a turn that asked for tools is cut between turns');
  assert.equal(run('user.message', 'assistant.turn_start', ['assistant.message', { toolRequests: [] }], 'assistant.turn_end').working, false);
  assert.equal(run('user.message', 'assistant.turn_start', 'subagent.started', ['assistant.message', { toolRequests: [] }], 'assistant.turn_end').working, true);
  assert.equal(run('user.message', 'assistant.turn_start', ['abort', { reason: 'user_initiated' }]).working, false);
  assert.equal(run('user.message', 'assistant.turn_start', ['abort', { reason: 'subagent_cancelled' }]).working, true, 'only a person\'s stop counts');
  assert.equal(run().working, false);
});

test('saidReady and settleVerdict: ready, idle, stalled and out of time are told apart; progress extends the wait', () => {
  const t0 = 1_000_000;
  const msg = (text, at) => ev('assistant.message', { content: text }, at);
  assert.equal(saidReady([msg('Pushed.\nREADY-TO-RESTART', t0 + 5)], t0), true);
  assert.equal(saidReady([msg('`READY-TO-RESTART`.', t0 + 5)], t0), true, 'markdown around the line does not matter');
  assert.equal(saidReady([msg('I will say READY-TO-RESTART when done', t0 + 5)], t0), false, 'only a line of its own counts');
  assert.equal(saidReady([msg('READY-TO-RESTART', t0 - 5)], t0), false, 'a message from before the ask does not count');
  const v = (o) => settleVerdict({ state: 'busy', lines: [], mtime: t0, askedAt: t0, now: t0, settle: 90000, settleMax: 600000, ...o });
  assert.equal(v({ state: 'idle' }), 'idle');
  assert.equal(v({ lines: [msg('READY-TO-RESTART', t0 + 1)] }), 'ready');
  assert.equal(v({ now: t0 + 89000 }), null, 'still inside the quiet window');
  assert.equal(v({ now: t0 + 91000 }), 'stalled');
  assert.equal(v({ now: t0 + 300000, mtime: t0 + 250000 }), null, 'a step 50 s ago: it is making progress, so it keeps its time');
  assert.equal(v({ now: t0 + 600000, mtime: t0 + 599000 }), 'capped', 'progress buys time, but not past the cap');
});

test('pickTargets: what was working, what the restart interrupted, and what was named; an old crash flag is left alone', () => {
  const before = [{ id: A, state: 'busy', why: 'mid-turn' }, { id: B, state: 'idle', interrupted: true }, { id: C, state: 'idle' }];
  const after = [{ id: A, interrupted: true }, { id: B, interrupted: true }, { id: C, interrupted: true, title: 'c' }, { id: D }];
  assert.deepEqual(pickTargets({ before, after, also: [D, 'eeeeeeee'] }).map((t) => [t.id.slice(0, 1), t.known]), [['a', true], ['c', true], ['d', true], ['e', false]]);
});

test('findMain and family: the app, what it started and anything run from its bundle, not strangers', () => {
  const ps = parsePs(` 100 1 ${BUNDLE}/Contents/MacOS/fake\n 101 100 runtime --server\n 102 101 mcp\n 103 1 ${BUNDLE}/Contents/Resources/helper\n 104 1 other\n 105 100 ${BUNDLE}/Contents/MacOS/fake-child`);
  assert.equal(findMain(ps, BUNDLE).pid, 100);
  assert.deepEqual(family(ps, 100, BUNDLE), [100, 101, 102, 103, 105]);
});

test('findMain: the app itself, not a helper in the same folder that has a lower pid', () => {
  const ps = parsePs(` 41409 95046 ${BUNDLE}/Contents/MacOS/git-credential-copilot --internal-git-lifetime-watchdog /x\n 95046 1 ${BUNDLE}/Contents/MacOS/github --restart-handoff-token=t\n 95100 95046 runtime`);
  assert.equal(findMain(ps, BUNDLE).pid, 95046, 'a helper that is the child of an app process is not the app');
  const orphan = parsePs(` 41409 1 ${BUNDLE}/Contents/MacOS/git-credential-copilot --watch\n 95046 1 ${BUNDLE}/Contents/MacOS/github`);
  assert.equal(findMain(orphan, BUNDLE, 'github').pid, 95046, 'the bundle\'s own executable wins when it is known');
});

test('quitItem finds the Quit entry in a hackamore ls reply', () => {
  const ls = { actions: [{ name: 'menu', input: { properties: { item: { enum: ['App > Hide App', 'App > Quit Fake', 'File > Close'] } } } }] };
  assert.equal(quitItem(ls), 'App > Quit Fake');
  assert.equal(quitItem({ actions: [] }), null);
});

test('messages say when, why and what to do', () => {
  const at = new Date(2026, 10, 14, 13, 5).getTime();
  assert.match(resumeText({ at, why: 'a Desk runtime upgrade' }), /^The app was restarted at 13:05 for a Desk runtime upgrade; resume where you left off\./);
  const m = settleText({ by: at, stallSec: 90, why: 'a plugin update (desk 3.2.154 → 3.2.167)' });
  assert.match(m, /restarts for a plugin update \(desk 3\.2\.154 → 3\.2\.167\), as soon as every working session is ready and no later than about 13:05\. Reach a safe point/);
  assert.match(m, /end your turn with a line that is exactly READY-TO-RESTART\./);
  assert.match(m, /goes 90 seconds without a step/);
});

// A pretend Mac around a pretend app.
async function world({ sessions, appOpts = {}, quit = 'menu', person = 0, stubborn = false, noQuitItem = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-restart-'));
  makeHome(home, sessions);
  const app = await startApp(home, appOpts);
  const w = { home, app, procs: [{ pid: 100, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` }, { pid: 101, ppid: 100, command: 'runtime --server' }], hk: [], kills: [], opens: 0, personLeft: person };
  const real = realDeps({ copilotHome: home });
  w.deps = {
    ...real,
    hackamore: ['hackamore'],
    appDir: () => BUNDLE,
    ps: async () => w.procs,
    startedAt: async () => w.startedAt,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    hk: async (argv) => {
      w.hk.push(argv.slice(0, 2).join(' '));
      if (argv[0] === 'ls') return { code: 0, json: noQuitItem ? { actions: [] } : { actions: [{ name: 'menu', input: { properties: { item: { enum: ['App > Quit Fake'] } } } }] } };
      if (w.personLeft-- > 0) return { code: 2, json: { code: 'person-active', problem: 'someone is using this Mac' } };
      if (!stubborn) w.procs = [];
      return { code: 0, json: {} };
    },
    kill: (pid, sig) => { w.kills.push([pid, sig]); w.procs = w.procs.filter((p) => p.pid !== pid); return true; },
    open: async () => { w.opens++; w.startedAt = Date.now(); w.procs = [{ pid: 200, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` }]; return { code: 0, stderr: '' }; },
  };
  w.opts = { app: 'Fake Copilot', resume: true, why: 'a Desk runtime upgrade', t: { settle: 200, grace: 0, quit: 400, up: 2000, delivery: 3000, retry: 400, tries: 2 } };
  w.done = () => app.close();
  return w;
}

const sessions = () => [
  { id: A, title: 'busy a', mode: 'autopilot', running: true, events: MID_TURN },
  { id: B, title: 'idle b', events: DONE },
  { id: C, title: 'busy c', mode: 'interactive', events: MID_TURN },
  { id: D, title: 'old crash', interrupted: true, events: DONE },
];

test('restart: asks working sessions to settle, quits, relaunches, resumes the working ones and checks they took a turn', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  const r = await restart(w.opts, w.deps);
  await w.done();
  assert.equal(r.ok, true, JSON.stringify(r.failed || r.resume));
  assert.deepEqual(r.before.filter((s) => s.state === 'busy').map((s) => s.id), [A, C]);
  assert.deepEqual(w.app.received.filter((m) => /Heads up/.test(m.prompt)).map((m) => m.id).sort(), [A, C], 'only working sessions are asked to settle');
  assert.deepEqual(r.resume.map((x) => [x.id, x.outcome]).sort(), [[A, 'resumed'], [C, 'resumed']], 'the idle session and the old crash flag are left alone');
  assert.match(w.app.received.find((m) => /restarted at/.test(m.prompt)).prompt, /for a Desk runtime upgrade; resume where you left off/);
  assert.ok(w.hk[0] === 'ls Fake Copilot' && w.hk.includes('do menu'));
  assert.equal(w.opens, 1);
  assert.deepEqual(w.kills, [], 'a menu quit needs no signal');
  assert.deepEqual(r.interrupted_at_quit.sort(), [A, C], 'they were still working when the quit came: recorded as interrupted');
});

test('restart: a session that is making progress gets time past the quiet window, and one that says ready is not waited for', { skip }, async () => {
  const w2 = await world({ sessions: sessions(), appOpts: { react: (id, prompt, append) => {
    if (!/Heads up/.test(prompt)) return;
    if (id === A) append('assistant.message', { content: 'Pushed.\nREADY-TO-RESTART', toolRequests: [] });
    // C keeps stepping for longer than the quiet window, then ends its turn.
    if (id === C) { for (let i = 1; i <= 4; i++) setTimeout(() => append('tool.execution_complete', {}), i * 120); setTimeout(() => { append('assistant.message', { toolRequests: [] }); append('assistant.turn_end'); }, 600); }
  } } });
  w2.opts.t = { ...w2.opts.t, settle: 300, settleMax: 5000 };
  const t0 = Date.now();
  const r = await restart(w2.opts, w2.deps);
  await w2.done();
  assert.equal(r.ok, true, JSON.stringify(r.failed || r.resume));
  assert.deepEqual(r.said_ready, [A]);
  assert.deepEqual(r.settled.sort(), [A, C]);
  assert.deepEqual(r.interrupted_at_quit, [], 'nothing was cut off');
  assert.ok(Date.now() - t0 >= 600, 'it waited for C, which was still stepping after the quiet window had passed once');
  assert.match(w2.app.received.find((m) => /Heads up/.test(m.prompt)).prompt, /exactly READY-TO-RESTART/);
});

test('restart: a session that goes quiet is cut off after the quiet window, not after the whole cap', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  w.opts.t = { ...w.opts.t, settle: 200, settleMax: 60000 };
  const t0 = Date.now();
  const r = await restart(w.opts, w.deps);
  await w.done();
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(r.interrupted_at_quit.sort(), [A, C]);
});

test('restart: when the quit is refused the app is untouched, and the sessions that were asked to stop are told to carry on', { skip }, async () => {
  const w = await world({ sessions: sessions(), person: 1000 });
  w.opts.t.person = 100;
  const r = await restart(w.opts, w.deps);
  await w.done();
  assert.equal(r.failed.stage, 'quit');
  const told = w.app.received.filter((m) => /was called off/.test(m.prompt)).map((m) => m.id).sort();
  assert.deepEqual(told, [A, C]);
  assert.match(w.app.received.find((m) => /was called off/.test(m.prompt)).prompt, /nothing was stopped\. Carry on/);
  assert.equal(w.opens, 0);
});

test('restart: a session something already continued is not messaged twice, and one the app drops is reported', { skip }, async () => {
  const w = await world({ sessions: sessions(), appOpts: { drop: [C] } });
  // After the relaunch a resumer (not us) has already written to A.
  const open = w.deps.open;
  w.deps.open = async (...a) => { const x = await open(...a); fs.appendFileSync(path.join(w.home, 'session-state', A, 'events.jsonl'), `${ev('user.message', {}, Date.now() + 5000)}\n${ev('assistant.turn_start', {}, Date.now() + 5001)}\n`); return x; };
  const r = await restart(w.opts, w.deps);
  await w.done();
  assert.equal(r.ok, false);
  assert.equal(r.resume.find((x) => x.id === A).outcome, 'already continued');
  assert.match(r.resume.find((x) => x.id === C).outcome, /^NOT RESUMED after 2 tries \(delivered but no new turn\)/);
  assert.equal(w.app.received.filter((m) => m.id === A && /restarted at/.test(m.prompt)).length, 0);
});

test('restart: a session another resumer messaged but that never took a turn still gets ours', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  const open = w.deps.open;
  w.deps.open = async (...a) => { const x = await open(...a); fs.appendFileSync(path.join(w.home, 'session-state', A, 'events.jsonl'), `${ev('user.message', {}, Date.now() + 5000)}\n`); return x; };
  const r = await restart(w.opts, w.deps);
  await w.done();
  assert.deepEqual(r.resume.find((x) => x.id === A), { id: A, title: 'busy a', why: r.resume.find((x) => x.id === A).why, outcome: 'resumed', tries: 1 });
});

test('--skip leaves a session out of the ask, the targets and the resume; the resume text says what was stopped', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  assert.deepEqual((await plan({ ...w.opts, skip: [A.slice(0, 8)] }, w.deps)).resume.map((x) => x.id), [C]);
  const r = await restart({ ...w.opts, skip: [A.slice(0, 8)], also: [A] }, w.deps);
  await w.done();
  assert.deepEqual(r.resume.map((x) => x.id), [C]);
  assert.equal(w.app.received.some((m) => m.id === A), false, 'a skipped session gets no message at all');
  assert.match(w.app.received.find((m) => /restarted at/.test(m.prompt)).prompt, /Your background subagents and shell jobs were stopped; restart any unfinished ones from their pushed state\.$/);
});

test('restart: a session the app has archived is reported gone, not retried', { skip }, async () => {
  const w = await world({ sessions: sessions(), appOpts: { refuse: [A] } });
  const r = await restart({ ...w.opts, also: [D] }, w.deps);
  await w.done();
  assert.match(r.resume.find((x) => x.id === A).outcome, /^gone: session .* is archived/);
  assert.equal(r.resume.find((x) => x.id === D).outcome, 'resumed', '--also names a session that was not working');
  assert.equal(w.app.received.filter((m) => m.id === A && /restarted at/.test(m.prompt)).length, 1);
});

test('restart: waits while someone is using the Mac, then quits; never quits over them', { skip }, async () => {
  const w = await world({ sessions: sessions(), person: 2 });
  const r = await restart(w.opts, w.deps);
  assert.equal(r.ok, true);
  assert.equal(w.hk.filter((x) => x === 'do menu').length, 3, 'two refusals, then the quit');
  const w2 = await world({ sessions: sessions(), person: 1000 });
  w2.opts.t.person = 100;
  const r2 = await restart(w2.opts, w2.deps);
  await w.done(); await w2.done();
  assert.equal(r2.ok, false);
  assert.equal(r2.failed.stage, 'quit');
  assert.match(r2.failed.why, /hackamore refused the Quit menu item: someone is using this Mac/);
  assert.equal(w2.opens, 0, 'the app is left running');
});

test('restart: a straggler gets SIGTERM by exact pid; one that will not die stops the run before any relaunch', { skip }, async () => {
  const w = await world({ sessions: sessions(), stubborn: true });
  w.deps.hk = async (argv) => { if (argv[0] === 'ls') return { code: 0, json: { actions: [{ name: 'menu', input: { properties: { item: { enum: ['App > Quit Fake'] } } } }] } }; w.procs = w.procs.filter((p) => p.pid === 101); return { code: 0, json: {} }; };
  const r = await restart(w.opts, w.deps);
  await w.done();
  assert.equal(r.ok, true);
  assert.deepEqual(w.kills, [[101, 'SIGTERM']]);
  const w2 = await world({ sessions: sessions(), stubborn: true });
  w2.deps.kill = () => true;
  const r2 = await restart(w2.opts, w2.deps);
  await w2.done();
  assert.equal(r2.failed.stage, 'quit');
  assert.match(r2.failed.why, /still running after the quit and a SIGTERM: 100, 101/);
  assert.equal(w2.opens, 0);
});

test('plan: changes nothing and names what it would do; no Quit item or no hackamore is said plainly', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  const p = await plan(w.opts, w.deps);
  assert.deepEqual([p.sessions.busy, p.resume.map((x) => x.id), p.quit.method, p.relaunch], [2, [A, C], 'menu', 'open -a "Fake Copilot"']);
  assert.equal(w.opens + w.kills.length, 0);
  assert.equal(w.hk.some((x) => x.startsWith('do')), false);
  const n = await world({ sessions: sessions(), noQuitItem: true });
  assert.match((await plan(n.opts, n.deps)).quit.why, /sees no Quit menu item/);
  assert.equal((await plan({ ...n.opts, sigterm: true }, n.deps)).quit.method, 'sigterm');
  assert.match((await plan(n.opts, { ...n.deps, hackamore: null })).quit.why, /hackamore is not on PATH/);
  await w.done(); await n.done();
});

test('restart keeps status.json current: running at each step, then done, or failed with the sessions not resumed', { skip }, async () => {
  const w = await world({ sessions: sessions(), appOpts: { drop: [C] } });
  const seen = [];
  w.deps.status = (o) => seen.push(o);
  await restart(w.opts, w.deps);
  await w.done();
  assert.deepEqual([...new Set(seen.map((o) => o.state))], ['running', 'failed']);
  assert.ok(seen.every((o) => o.started && o.updated));
  assert.deepEqual(seen.at(-1).not_resumed, [C]);
  const w2 = await world({ sessions: sessions() });
  const seen2 = [];
  w2.deps.status = (o) => seen2.push(o);
  await restart(w2.opts, w2.deps);
  await w2.done();
  assert.equal(seen2.at(-1).state, 'done');
});

test('restart: an app that does not quit by itself gets SIGTERM to its own pid first, then what is left, and the log says why', { skip }, async () => {
  const w = await world({ sessions: sessions(), stubborn: true });
  const log = [];
  const hk = w.deps.hk;
  w.deps.hk = async (a) => (a[0] === 'ls' ? { code: 0, json: { actions: [{ name: 'menu', input: { properties: { item: { enum: ['App > Quit Fake'] } } } }], state: { elements: [{ role: 'button', label: 'Cancel', ref: 'button[Cancel]' }] } } } : hk(a));
  w.deps.sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  const r = await restart(w.opts, w.deps, (m) => log.push(m));
  await w.done();
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.deepEqual(w.kills, [[100, 'SIGTERM'], [101, 'SIGTERM']], 'the app first, then the straggler');
  assert.ok(log.some((l) => /the app did not quit within \d+ s of the Quit item \(its own process 100 is still running\).*no confirmation dialog, no Quit button/.test(l)), log.join('\n'));
});

test('restart: a quit confirmation with a Quit button is answered through hackamore', { skip }, async () => {
  const w = await world({ sessions: sessions(), stubborn: true });
  const log = [];
  const hk = w.deps.hk;
  let up = false;
  w.deps.hk = async (a) => {
    if (a[0] === 'ls') return { code: 0, json: { actions: [{ name: 'menu', input: { properties: { item: { enum: ['App > Quit Fake'] } } } }], state: { elements: up ? [{ role: 'button', label: 'Cancel', ref: 'button[Cancel]' }, { role: 'button', label: 'Quit', ref: 'button[Quit]' }] : [] } } };
    if (a[1] === 'menu') { up = true; return { code: 0, json: {} }; }
    if (a[1] === 'click') { w.clicked = JSON.parse(a[2]); w.procs = []; return { code: 0, json: {} }; }
    return hk(a);
  };
  w.opts.t.dialog = 30;
  w.opts.t.quit = 3000;
  const r = await restart(w.opts, w.deps, (m) => log.push(m));
  await w.done();
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.deepEqual(w.clicked, { element: 'button[Quit]', app: 'Fake Copilot' });
  assert.deepEqual(w.kills, [], 'answered, so nothing was signalled');
  assert.ok(log.some((l) => /the app asked to confirm the quit; answered it/.test(l)));
});

test('readState: --status reports a run in progress from status.json, not the previous run\'s report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-state-'));
  const put = (f, o) => fs.writeFileSync(path.join(dir, f), typeof o === 'string' ? o : JSON.stringify(o));
  assert.equal(readState(dir).state, 'none');
  assert.match(renderState(readState(dir)), /no restart has run on this Mac yet/);
  put('last.json', { ok: true, started_at: '2026-11-13T10:00:00.000Z', steps: [{ step: 'snapshot {"n":1}' }], resume: [] });
  put('status.json', { started: '2026-11-14T19:49:26.576Z', updated: '2026-11-14T19:51:01.000Z', state: 'running', step: 'quit sent' });
  put('run-2026-11-14T19-49-26-146Z.log', 'a\nb\nquit sent {"method":"menu"}\n');
  const now = Date.parse('2026-11-14T19:51:31.000Z');
  const s = readState(dir, now);
  assert.deepEqual([s.state, s.step, s.started, s.age_s, s.result], ['running', 'quit sent', '2026-11-14T19:49:26.576Z', 30, null]);
  const text = renderState(s);
  assert.match(text, /^restart-copilot RUNNING: quit sent\n  started 2026-11-14T19:49:26.576Z, last step 30 s ago/);
  assert.match(text, /run-2026-11-14T19-49-26-146Z\.log/);
  assert.match(text, /quit sent \{"method":"menu"\}/);
  assert.equal(readState(dir, now + 3600000).stale, true, 'a running job with no step for an hour is flagged');
  assert.equal(runInProgress(dir, now).step, 'quit sent', 'a second restart must not start over a running one');
  assert.equal(runInProgress(dir, now + 3600000), null, 'a dead job does not block a new one');
  put('last.json', { ok: false, started_at: '2026-11-14T19:49:26.700Z', failed: { stage: 'quit', why: 'x' }, steps: [{ step: 'snapshot {}' }, { step: 'FAILED at quit {}' }], resume: [] });
  put('status.json', { started: '2026-11-14T19:49:26.576Z', updated: '2026-11-14T19:53:16.000Z', state: 'failed', step: 'failed at quit', failed: { stage: 'quit', why: 'x' } });
  const f = readState(dir, now);
  assert.equal(f.state, 'failed');
  assert.match(renderState(f), /FAILED: failed at quit[\s\S]*failed at quit: x[\s\S]*steps: snapshot → FAILED at quit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resumeOnly: resumes what was working when the app stopped, once per app process, and never over a running restart job', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  w.startedAt = Date.now() - 300000;
  let marked = null, running = false;
  w.deps.generation = { get: () => marked, set: (k) => { marked = k; } };
  w.deps.restartState = () => (running ? { state: 'running', updated: new Date().toISOString() } : null);
  const t = { ...w.opts, t: { ...w.opts.t, grace: 0 } };
  const dry = await resumeOnly({ ...t, dry_run: true }, w.deps);
  assert.deepEqual(dry.resume.map((x) => x.id), [A, C]);
  assert.equal(marked, null, 'a dry run marks nothing');
  running = true;
  assert.equal((await resumeOnly(t, w.deps)).skipped, 'a restart is running');
  assert.equal(w.app.received.length, 0);
  running = false;
  const r = await resumeOnly(t, w.deps);
  assert.equal(r.ok, true, JSON.stringify(r.resume));
  assert.deepEqual(r.resume.map((x) => [x.id, x.outcome]).sort(), [[A, 'resumed'], [C, 'resumed']]);
  assert.match(w.app.received.find((m) => m.id === A).prompt, /^The app was restarted at \d\d:\d\d/);
  assert.equal((await resumeOnly(t, w.deps)).skipped, 'already resumed');
  assert.equal(w.app.received.filter((m) => m.id === A).length, 1, 'a second pass sends nothing');
  const w2 = await world({ sessions: sessions() });
  w2.procs = [];
  assert.equal((await resumeOnly(w2.opts, w2.deps)).skipped, 'app not running');
  await w.done(); await w2.done();
});

test('watch: opens a closed app once per login, then resumes the sessions of each new app process', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  w.procs = [];
  let marked = null, claims = 1;
  w.deps.generation = { get: () => marked, set: (k) => { marked = k; } };
  w.deps.loginClaim = () => claims-- > 0;
  const log = [];
  let laps = 0;
  const opts = { ...w.opts, open_at_login: true, t: { ...w.opts.t, grace: 0 } };
  await watch(opts, w.deps, (m) => log.push(m), { every: 1, stop: () => laps++ >= 40 || w.app.received.some((m) => m.id === C && /restarted at/.test(m.prompt)) });
  assert.equal(w.opens, 1);
  assert.ok(log.some((l) => /was closed at login: opened it in the background/.test(l)));
  assert.deepEqual([...new Set(w.app.received.filter((m) => /restarted at/.test(m.prompt)).map((m) => m.id))].sort(), [A, C]);
  w.procs = [];
  await watch(opts, w.deps, () => {}, { every: 1, stop: () => laps++ >= 45 });
  assert.equal(w.opens, 1, 'the second start in the same login opens nothing');
  await w.done();
});

test('installKeeper writes the launch agent for the resume watcher and loads it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-keeper-'));
  const calls = [];
  const r = await installKeeper({ node: '/n/node', bin: '/h/bin/housesitter.mjs', env: { HOME: home }, home, uid: 501, launchctl: async (a) => { calls.push(a); return { code: 0, stderr: '' }; } });
  const text = fs.readFileSync(r.plist, 'utf8');
  assert.equal(r.ok, true);
  assert.match(text, new RegExp(`<string>${KEEPER_LABEL}</string>`));
  assert.match(text, /<string>\/n\/node<\/string>\s*<string>\/h\/bin\/housesitter\.mjs<\/string>\s*<string>restart-copilot<\/string>\s*<string>--resume-only<\/string>\s*<string>--watch<\/string>\s*<string>--open-at-login<\/string>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>[\s\S]*<key>KeepAlive<\/key><true\/>/);
  assert.deepEqual(calls.map((c) => c[0]), ['bootout', 'bootstrap']);
  const order = [];
  await installKeeper({ node: '/n', bin: '/b', home, uid: 1, before: async () => order.push('before'), launchctl: async (a) => { order.push(a[0]); return { code: 0, stderr: '' }; } });
  assert.deepEqual(order, ['before', 'bootout', 'bootstrap'], 'the app that is already up is marked before the agent can see it');
  assert.equal((await installKeeper({ node: '/n/node', bin: '/b', home, dry: true })).dry_run, true);
  fs.rmSync(home, { recursive: true, force: true });
});
