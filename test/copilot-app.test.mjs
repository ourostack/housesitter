// housesitter restart-copilot: the whole sequence against a pretend Mac (a process table, a Quit menu) and a pretend
// Copilot app (a state folder and a local WebSocket), so the real socket, database and history code runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath, family, findMain, installKeeper, KEEPER_LABEL, loopState, parsePs, pickTargets, plan, quitItem, readState, realDeps, renderState, lastReply, lastTurnAt, readSkipConfig, recheckAfter, recheckText, restart, resumeOnly, runInProgress, settleVerdict, watch, resumeText, settleText } from '../src/copilot-app.mjs';
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

test('lastReply, recheckAfter and settleVerdict: ready, defer (with its lanes), idle, stalled and out of time are told apart', () => {
  const t0 = 1_000_000;
  const msg = (text, at) => ev('assistant.message', { content: text }, at);
  assert.deepEqual(lastReply([msg('Pushed.\nREADY-TO-RESTART', t0 + 5)], t0), { kind: 'ready', at: t0 + 5 });
  assert.equal(lastReply([msg('`READY-TO-RESTART`.', t0 + 5)], t0).kind, 'ready', 'markdown around the line does not matter');
  assert.equal(lastReply([msg('I will say READY-TO-RESTART when done', t0 + 5)], t0), null, 'only a line of its own counts');
  assert.equal(lastReply([msg('READY-TO-RESTART', t0 - 5)], t0), null, 'a message from before the ask does not count');
  assert.deepEqual(lastReply([msg('Two lanes are mid-run.\nDEFER: 3 lanes running, about 45 min', t0 + 5)], t0), { kind: 'defer', at: t0 + 5, lanes: 3, minutes: 45 });
  assert.deepEqual(lastReply([msg('**DEFER: 1 lane running**', t0 + 5)], t0), { kind: 'defer', at: t0 + 5, lanes: 1, minutes: null }, 'the estimate is optional');
  assert.equal(lastReply([msg('DEFER: 3 lanes running, about 45 min', t0 + 5), msg('READY-TO-RESTART', t0 + 9)], t0).kind, 'ready', 'the latest answer counts');
  assert.equal(lastReply([msg('READY-TO-RESTART', t0 + 5), msg('DEFER: 2 lanes running, about 5 min', t0 + 9)], t0).kind, 'defer');
  const t = { recheckMin: 120000, recheckMax: 1200000 };
  assert.deepEqual([{ minutes: 1 }, { minutes: 10 }, { minutes: 90 }, { minutes: null }].map((r) => recheckAfter(r, t)), [120000, 600000, 1200000, 600000], 'its own estimate, kept between the bounds');
  const v = (o) => settleVerdict({ state: 'busy', lines: [], mtime: t0, askedAt: t0, firstAskedAt: t0, now: t0, settle: 90000, settleMax: 600000, ...o }).outcome;
  assert.equal(v({ state: 'idle' }), 'idle');
  assert.equal(v({ lines: [msg('READY-TO-RESTART', t0 + 1)] }), 'ready');
  assert.equal(v({ now: t0 + 89000 }), null, 'still inside the quiet window');
  assert.equal(v({ now: t0 + 91000 }), 'stalled');
  assert.equal(v({ now: t0 + 300000, mtime: t0 + 250000 }), null, 'a step 50 s ago: it is making progress, so it keeps its time');
  assert.equal(v({ now: t0 + 600000, mtime: t0 + 599000 }), 'capped', 'progress buys time, but not past the ceiling');
  const deferred = [msg('DEFER: 2 lanes running, about 30 min', t0 + 1)];
  assert.equal(v({ lines: deferred, state: 'idle', now: t0 + 300000 }), null, 'a session that deferred is waited for even when its turn ended');
  assert.equal(v({ lines: deferred, now: t0 + 599000, deferred: true }), null, 'and is never cut off as quiet');
  assert.equal(v({ lines: deferred, now: t0 + 600000 }), 'capped', 'until the ceiling');
  assert.equal(v({ state: 'busy', mtime: t0, now: t0 + 500000, deferred: true }), null, 'a deferring session with no answer yet to the recheck is not cut off as quiet');
  assert.equal(v({ state: 'idle', askedAt: t0 + 100, now: t0 + 200 }), null, 'asked again and idle: it has not taken a turn yet, so it has not answered');
  assert.equal(v({ state: 'idle', askedAt: t0 + 100, now: t0 + 200, lines: [ev('assistant.turn_start', {}, t0 + 150)] }), 'idle', 'it took a turn and ended it without an answer');
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
  const m = settleText({ by: at, stallSec: 600, why: 'a plugin update (desk 3.2.154 → 3.2.167)' });
  assert.match(m, /restarts for a plugin update \(desk 3\.2\.154 → 3\.2\.167\), as soon as every working session is ready and no later than about 13:05\. Reach a safe point/);
  assert.match(m, /a line that is exactly READY-TO-RESTART\./);
  assert.match(m, /answer instead with a line of its own, DEFER: <n> lanes running, about <m> min, and the restart waits for you and asks again when your estimate is up\./);
  assert.match(m, /goes 10 minutes without a step is not waited for/);
  assert.match(recheckText({ by: at, why: null }), /^Recheck for the restart: are you at a safe point yet\?.*READY-TO-RESTART, or DEFER.*about 13:05/);
  assert.match(resumeText({ at, why: null, lanes: { lanes: 3, minutes: 45 } }), /You had said 3 lanes were still running \(about 45 min from done\): the restart went ahead without waiting longer, so those lanes were stopped; restart them from their pushed state\.$/);
  assert.doesNotMatch(resumeText({ at, why: null }), /You had said/);
});

// A pretend Mac around a pretend app.
async function world({ sessions, appOpts = {}, quit = 'menu', person = 0, stubborn = false, noQuitItem = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-restart-'));
  makeHome(home, sessions);
  const app = await startApp(home, appOpts);
  const w = { home, app, procs: [{ pid: 100, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` }, { pid: 101, ppid: 100, command: 'runtime --server' }], hk: [], kills: [], opens: 0, personLeft: person };
  // Everything the deps write (resumed.json, resume-only.json) and read (the skip list) lives in this folder, never in the real ones.
  const real = realDeps({ copilotHome: home, state: path.join(home, 'state'), config: path.join(home, 'restart-copilot.json') });
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
  w.state = path.join(home, 'state');
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

test('restart: a session that defers is asked again at its estimate and waited for; one still deferring at the ceiling is resumed with its lanes named', { skip }, async () => {
  let rechecks = 0;
  const w = await world({ sessions: sessions(), appOpts: { react: (id, prompt, append) => {
    if (/Heads up/.test(prompt)) append('assistant.message', { content: `Lanes are mid-run.\nDEFER: ${id === A ? 2 : 4} lanes running, about 1 min`, toolRequests: [] });
    if (/Recheck for the restart/.test(prompt) && id === A) { rechecks++; append('assistant.message', { content: 'Pushed.\nREADY-TO-RESTART', toolRequests: [] }); }
  } } });
  w.opts.t = { ...w.opts.t, settle: 300, settleMax: 1500, recheckMin: 100, recheckMax: 100 };
  const t0 = Date.now();
  const r = await restart(w.opts, w.deps);
  await w.done();
  assert.equal(r.ok, true, JSON.stringify(r.failed || r.resume));
  assert.ok(Date.now() - t0 >= 1400, 'it waited for C until the ceiling');
  assert.deepEqual(r.said_ready, [A], 'A deferred, was asked again and said ready');
  assert.equal(rechecks, 1, 'once ready, A is not asked again');
  assert.deepEqual(r.interrupted_at_quit, [C]);
  assert.deepEqual(r.deferred_at_quit, [{ id: C, lanes: 4, minutes: 1 }]);
  assert.ok(w.app.received.filter((m) => m.id === C && /Recheck for the restart/.test(m.prompt)).length >= 2, 'C is asked again at each estimate');
  assert.match(w.app.received.find((m) => m.id === C && /restarted at/.test(m.prompt)).prompt, /You had said 4 lanes were still running \(about 1 min from done\): the restart went ahead without waiting longer/);
  assert.doesNotMatch(w.app.received.find((m) => m.id === A && /restarted at/.test(m.prompt)).prompt, /You had said/);
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

test('restart: the only session not resumed was archived on purpose, so the restart succeeds and --status says archived', { skip }, async () => {
  const w = await world({ sessions: sessions(), appOpts: { refuse: [A] } });
  const statuses = [];
  const r = await restart(w.opts, { ...w.deps, status: (o) => statuses.push(o) });
  await w.done();
  assert.match(r.resume.find((x) => x.id === A).outcome, /^gone/);
  assert.equal(r.ok, true);
  const last = statuses.at(-1);
  assert.equal(last.state, 'done');
  assert.deepEqual(last.archived, [A]);
  assert.equal(last.not_resumed, undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-state-'));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ started: '2026-11-16T10:00:00.000Z', updated: '2026-11-16T10:01:00.000Z', ...last }));
  const text = renderState(readState(dir));
  assert.match(text, /^restart-copilot DONE/);
  assert.match(text, new RegExp(`archived, not resumed: ${A.slice(0, 8)}`));
  assert.doesNotMatch(text, /\n  not resumed:/);
  fs.rmSync(dir, { recursive: true, force: true });
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

test('lastTurnAt and readSkipConfig: the last loop event, and a skip list that a bad file cannot break', () => {
  assert.equal(lastTurnAt([ev('user.message', {}, 1000), ev('assistant.turn_start', {}, 2000), ev('session.resume', {}, 9000)]), 2000, 'only the agent loop counts, not a resume marker');
  assert.equal(lastTurnAt([]), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-skip-'));
  const f = path.join(dir, 'restart-copilot.json'), warns = [];
  assert.deepEqual(readSkipConfig(f, (m) => warns.push(m)), [], 'no file, no skips, no complaint');
  fs.writeFileSync(f, JSON.stringify({ skip: ['6f222445-5e74-4655-a24c-e9a24305edff', 'short'] }));
  assert.deepEqual(readSkipConfig(f, (m) => warns.push(m)), ['6f222445-5e74-4655-a24c-e9a24305edff']);
  assert.equal(warns.length, 1, 'an entry under 8 characters is named and ignored');
  fs.writeFileSync(f, '{ not json');
  assert.deepEqual(readSkipConfig(f, (m) => warns.push(m)), []);
  assert.match(warns.at(-1), /is not valid JSON/);
  assert.match(configPath('/h'), /\/h\/\.config\/housesitter\/restart-copilot\.json$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the skip list file is shared by the crash resume and the planned restart, and a session idle for over 24 h is never resumed', { skip }, async () => {
  const OLD = 'eeeeeeee-0000-4000-8000-000000000005';
  const w = await world({ sessions: [...sessions(), { id: OLD, title: 'old crash, flagged running', running: true, interrupted: true, ageMs: 30 * 3600000, events: MID_TURN }] });
  w.startedAt = Date.now() - 300000;
  const t = { ...w.opts, t: { ...w.opts.t, grace: 0 } };
  assert.deepEqual((await resumeOnly({ ...t, dry_run: true }, w.deps)).resume.map((x) => x.id), [A, C], 'the 30 h old session is not resumed although the app still marks it running');
  assert.deepEqual((await plan(t, w.deps)).resume.map((x) => x.id), [A, C]);
  fs.writeFileSync(path.join(w.home, 'restart-copilot.json'), JSON.stringify({ skip: [A.slice(0, 8)] }));
  assert.deepEqual((await resumeOnly({ ...t, dry_run: true, also: [A] }, w.deps)).resume.map((x) => x.id), [C], 'the file is read at each pass, and --also cannot bring a skipped session back');
  assert.deepEqual((await plan(t, w.deps)).resume.map((x) => x.id), [C], 'the planned restart reads the same file');
  const r = await resumeOnly({ ...t, skip: [C.slice(0, 8)] }, w.deps);
  assert.deepEqual(r.resume, [], 'the file and --skip add up');
  assert.deepEqual(w.app.received, []);
  assert.ok(fs.existsSync(path.join(w.state, 'resumed.json')), 'the pretend Mac keeps its state in its own folder');
  await w.done();
});

test('resume: sends go out concurrently up to a small limit, a failed send is retried after a pause, and a session that still fails is named with its reason', { skip }, async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `1000000${i}-0000-4000-8000-00000000000${i}`);
  const [FLAKY, DEAD] = [ids[1], ids[2]];
  const w = await world({ sessions: ids.map((id, i) => ({ id, title: `s${i}`, mode: 'autopilot', events: MID_TURN })) });
  let live = 0, peak = 0;
  const failures = new Map([[FLAKY, 1], [DEAD, 99]]);
  const sleeps = [];
  const exchange = w.deps.exchange;
  w.deps.sleep = async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 1)); };
  w.deps.exchange = async (messages, o) => {
    const id = messages[0]?.session_id;
    if (id && /restarted at/.test(messages[0].prompt) && failures.get(id) > 0) { failures.set(id, failures.get(id) - 1); return [{ type: 'socket_error' }]; }
    if (!/restarted at/.test(messages[0]?.prompt || '')) return exchange(messages, o);
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 40));
    try { return await exchange(messages, o); } finally { live--; }
  };
  const log = [];
  const t = { ...w.opts.t, grace: 0, concurrency: 3, tries: 3, backoff: [111, 222] };
  const res = await restart({ ...w.opts, t }, w.deps, (m) => log.push(m));
  await w.done();
  assert.ok(peak > 1 && peak <= 3, `peak in flight ${peak}`);
  assert.equal(res.resume.find((x) => x.id === FLAKY).tries, 2);
  assert.ok(sleeps.includes(111) && sleeps.includes(222), `backoff between tries: ${sleeps}`);
  assert.match(res.resume.find((x) => x.id === DEAD).outcome, /^NOT RESUMED after 3 tries \(socket_error: the app's socket refused or dropped the connection\)/);
  assert.equal(res.ok, false);
  assert.ok(log.some((l) => /^NOT RESUMED: 1 of 6 session\(s\): 10000002 "s2": NOT RESUMED after 3 tries \(socket_error/.test(l)), log.join('\n'));
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

test('resumeOnly dry run reports what the real run would do: oversized sessions held, unknown ones gone, stale owed entries dropped', { skip }, async () => {
  const w = await world({ sessions: sessions() });
  w.startedAt = Date.now() - 300000;
  const ghost = 'eeeeeeee-0000-4000-8000-000000000005';
  w.deps.generation = { get: () => null, set: () => {} };
  w.deps.restartState = () => null;
  w.deps.historySize = (id) => (id === A ? 600 * 1024 * 1024 : 10);
  w.deps.owed = { get: () => [A, B, D, ghost], set: () => {}, clear: () => {} };
  const realHistory = w.deps.history;
  w.deps.history = (id) => (id === D ? { lines: [JSON.stringify({ type: 'assistant.turn_start', data: {}, timestamp: new Date().toISOString() })], mtime: Date.now() } : realHistory(id));
  const t = { ...w.opts, t: { ...w.opts.t, grace: 0 } };
  const dry = await resumeOnly({ ...t, dry_run: true }, w.deps);
  assert.deepEqual(dry.held.map((h) => h.id), [A], 'an over-cap history is held');
  assert.deepEqual(dry.resume.map((x) => x.id).sort(), [B, C].sort(), 'owed B and working C; D took a turn since, the ghost is gone');
  assert.deepEqual(dry.gone, []);
  const real = await resumeOnly(t, w.deps);
  assert.deepEqual(real.resume.map((x) => x.id).sort(), dry.resume.map((x) => x.id).sort(), 'the real run does exactly what the dry run said');
  assert.ok(!w.app.received.some((m) => m.id === A || m.id === D || m.id === ghost));
  await w.done();
});
