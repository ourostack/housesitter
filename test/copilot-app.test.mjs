// housesitter restart-copilot: the whole sequence against a pretend Mac (a process table, a Quit menu) and a pretend
// Copilot app (a state folder and a local WebSocket), so the real socket, database and history code runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { family, findMain, loopState, parsePs, pickTargets, plan, quitItem, realDeps, restart, resumeText, settleText } from '../src/copilot-app.mjs';
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

test('quitItem finds the Quit entry in a hackamore ls reply', () => {
  const ls = { actions: [{ name: 'menu', input: { properties: { item: { enum: ['App > Hide App', 'App > Quit Fake', 'File > Close'] } } } }] };
  assert.equal(quitItem(ls), 'App > Quit Fake');
  assert.equal(quitItem({ actions: [] }), null);
});

test('messages say when, why and what to do', () => {
  const at = new Date(2026, 10, 14, 13, 5).getTime();
  assert.match(resumeText({ at, why: 'a Desk runtime upgrade' }), /^The app was restarted at 13:05 for a Desk runtime upgrade; resume where you left off\./);
  assert.match(settleText({ at, inSec: 90, why: null }), /restarts at about 13:05 \(in about 90 seconds\)\. Reach a safe point/);
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
