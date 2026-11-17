// housesitter laptop-arrival: a Mac that was away comes back, and each step looks before it acts, so a second run changes
// nothing. The laptop here is a small simulation behind the route's `sh` and `gate`; the always-on Mac's own parts are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPTS, appNeed, cmpVersion, describePlan, detect, loadConfig, parseGate, parseKv, pass, pickCoordinators, renderPass, reportText } from '../src/laptop-arrival.mjs';

const CFG = { peer: 'laptop', route: ['mac'], hub_device_id: 'dev', mini_device_name: 'Aris-Mac-Mini', target_app: 'mini', min_desk: '3.2.154', housesitter_git: 'https://example.invalid/housesitter.git', retire: [{ label: 'x.arrival-post' }, { label: 'bot.ouro.daemon', requires_local_job: 'bot.ouro.daemon' }], macd_update: false, probe_every_ms: 300000, down_gap_ms: 600000, blocked_tell_ms: 1200000, app_fallback_ms: 2700000, restart_max: 2, step_tries: 6 };

// A laptop: what is on it, and what the route can ask of it.
function laptop(over = {}) {
  const L = { online: true, bus: true, boot: 1000, app: '1.1.35', desk: '3.2.110', hs: null, jobs: ['x.arrival-post', 'bot.ouro.daemon', 'other'], plists: ['x.arrival-post', 'bot.ouro.daemon', 'other'], gate: 'OPEN: unlocked, idle 500 s', restart: null, restarts: [], upgrades: 0, retired: [], hubOk: true, peerOnline: true, plan: { retire: [], size: [], errors: [] }, applied: [], shepherdUpdates: 0, ...over };
  const sh = async (cmd) => {
    if (!L.bus) return { ok: false, noRelay: true, out: '', err: 'no-relay', code: 1 };
    if (cmd === SCRIPTS.facts) return { ok: true, out: `boot=${L.boot}\nnow=2000\nuser=microsoft\napp=${L.app}\napp_pid=1\nnode=v22\nhs=${L.hs || ''}\njobs=${L.jobs.join(',')}\nplists=${L.plists.join(',')}\n`, err: '', code: 0 };
    if (cmd.includes('rev-parse --short HEAD 2>/dev/null; true')) return { ok: true, out: `${L.hs || ''}\n`, err: '', code: 0 };
    if (cmd.includes('git clone -q') && cmd.includes('/code/shepherd')) { L.shepherdUpdates += 1; return { ok: true, out: 'sh=def5678\n', err: '', code: 0 }; }
    if (cmd.includes('git clone')) { L.hs = 'abc1234'; return { ok: true, out: 'hs=abc1234\n', err: '', code: 0 }; }
    if (cmd === SCRIPTS.restartStatus) return { ok: true, out: JSON.stringify(L.restart || { state: 'none' }), err: '', code: 0 };
    if (cmd === SCRIPTS.plugins) return { ok: true, out: JSON.stringify({ decision: { action: 'hold' }, updates: [], loaded: [{ name: 'desk', version: L.desk }] }), err: '', code: 0 };
    if (cmd.includes('restart-copilot --resume --detach')) { L.restarts.push(cmd.includes('--sigterm') ? 'sigterm' : 'menu'); L.restart = { state: 'running', step: 'quit sent' }; return { ok: true, out: 'started', err: '', code: 0 }; }
    if (cmd.includes('launchctl bootout')) { const lab = cmd.match(/retired=([^"\n]+)/)[1]; L.jobs = L.jobs.filter((j) => j !== lab); L.plists = L.plists.filter((j) => j !== lab); L.retired.push(lab); return { ok: true, out: `retired=${lab}\n`, err: '', code: 0 }; }
    if (cmd.includes('steer --repair')) return { ok: true, out: JSON.stringify({ ok: L.hubOk, problems: L.hubOk ? [] : ['hub-disconnected'], remote: { default: 'on' }, peer: { name: 'Aris-Mac-Mini', online: L.peerOnline, activeSessionCount: 120 } }), err: '', code: 0 };
    if (cmd === SCRIPTS.retirePlan) return { ok: true, out: `noise\n${JSON.stringify(L.plan)}\n`, err: '', code: 0 };
    if (cmd === SCRIPTS.retireApply) { L.applied.push(1); return { ok: true, out: JSON.stringify({ retire: L.plan.retire.map((x) => ({ ...x, done: x.what === 'archive' })), size: [], errors: [] }), err: '', code: 0 }; }
    if (cmd.includes('brew upgrade')) { L.upgrades += 1; return { ok: true, out: 'upgraded', err: '', code: 0 }; }
    if (cmd === 'echo alive') return { ok: true, out: 'alive\n', err: '', code: 0 };
    throw new Error(`unexpected command: ${cmd.slice(0, 80)}`);
  };
  return { L, sh };
}

function rig(over = {}, { miniApp = '1.4.2', cfg = CFG } = {}) {
  const { L, sh } = laptop(over);
  let now = Date.parse('2026-11-16T17:00:00Z');
  let state = null;
  const told = [];
  const deps = {
    now: () => now,
    hubDevice: async () => (L.online ? { listed: true, online: true, lastSeenAt: 'now' } : { listed: false, online: false }),
    sh,
    gate: async () => parseGate(L.gate),
    mac: async (argv) => { if (argv[0] === 'macd') return { code: 0, stdout: 'updated', stderr: '' }; throw new Error('unexpected mac call'); },
    miniVersion: async () => miniApp,
    miniJobRunning: async (l) => l === 'bot.ouro.daemon',
    readState: () => state,
    writeState: (s) => { state = JSON.parse(JSON.stringify(s)); },
    sleep: async () => {},
    liveSessions: async () => [{ name: 'CIT Pages coordinator', activity: { status: 'busy', last_activity: '2026-11-17T10:00:00Z' } }],
    tell: async (t) => { told.push(t); return { ok: true }; },
  };
  const tick = (ms = 60000, opts = {}) => { now += ms; return pass({ cfg, ...opts }, deps); };
  return { L, deps, told, tick, get state() { return state; }, advance: (ms) => { now += ms; } };
}

test('versions and gate answers are read plainly', () => {
  assert.equal(cmpVersion('1.1.35', '1.4.2'), -1);
  assert.equal(cmpVersion('1.4.2', '1.4.2'), 0);
  assert.equal(cmpVersion('3.2.154', '3.2.9'), 1);
  assert.equal(parseGate('OPEN: unlocked, idle 500 s (via bus)').state, 'idle');
  assert.equal(parseGate('CLOSED: locked').state, 'locked');
  assert.equal(parseGate('CLOSED: someone used this Mac 7 s ago (need 90 s idle)').state, 'active');
  assert.deepEqual(parseKv('app=1.1.35\nnode=v22\nnoise'), { app: '1.1.35', node: 'v22' });
});

test('what the app needs: older than the floor, Desk below its floor, or a plugin waiting', () => {
  assert.equal(appNeed({ app: '1.4.2', plug: { loaded: [{ name: 'desk', version: '3.2.163' }], updates: [] }, target: '1.4.2', minDesk: '3.2.154' }).need, false);
  assert.match(appNeed({ app: '1.1.35', plug: { loaded: [{ name: 'desk', version: '3.2.163' }], updates: [] }, target: '1.4.2', minDesk: '3.2.154' }).why[0], /older than 1\.4\.2/);
  assert.match(appNeed({ app: '1.4.2', plug: { loaded: [{ name: 'desk', version: '3.2.110' }], updates: [] }, target: '1.4.2', minDesk: '3.2.154' }).why[0], /Desk 3\.2\.110/);
  assert.match(appNeed({ app: '1.4.2', plug: { loaded: [{ name: 'desk', version: '3.2.163' }], updates: [{ name: 'ms-desk', from: '1', to: '2' }] }, target: '1.4.2', minDesk: '3.2.154' }).why[0], /ms-desk 1 → 2/);
});

test('offline: nothing is touched, and the plan names every step it would run on arrival', async () => {
  const r = rig({ online: false });
  const out = await r.tick();
  assert.equal(out.action, 'down');
  assert.equal(out.plan.length, 8);
  assert.match(renderPass(out), /when it arrives, in order/);
  assert.deepEqual(r.told, []);
  assert.deepEqual(r.L.restarts, []);
});

test('online in Hub with a silent bus is held, and the agent hears once after 20 minutes', async () => {
  const r = rig({ bus: false });
  assert.equal((await r.tick()).action, 'hub-only');
  assert.equal(r.told.length, 0);
  await r.tick(1260000);
  await r.tick();
  assert.equal(r.told.length, 1);
  assert.match(r.told[0], /Mac bus does not answer/);
});

test('an arrival runs every step once, tells the agent once, and a second pass changes nothing', async () => {
  const r = rig();
  assert.equal((await r.tick()).action, 'working');
  // the app step started a restart (the screen was idle); the checkout was cloned; the retired jobs are gone
  assert.equal(r.L.hs, 'abc1234');
  assert.deepEqual(r.L.restarts, ['menu']);
  assert.deepEqual(r.L.retired, ['x.arrival-post', 'bot.ouro.daemon']);
  assert.equal(r.told.length, 0, 'not told while the app restart is running');
  // the restart finishes, and the laptop's app comes back at the floor
  Object.assign(r.L, { restart: { state: 'done' }, app: '1.4.2', desk: '3.2.163' });
  const done = await r.tick();
  assert.equal(done.action, 'complete');
  assert.equal(r.told.length, 1);
  assert.match(r.told[0], /the laptop is up/);
  assert.match(r.told[0], /you can steer the mini from it/);
  // nothing more happens on later passes, even if the laptop answers again
  const before = JSON.stringify([r.L.restarts, r.L.retired, r.told]);
  for (let i = 0; i < 3; i++) assert.equal((await r.tick()).action, 'idle');
  assert.equal(JSON.stringify([r.L.restarts, r.L.retired, r.told]), before);
});

test('a laptop already current is not restarted, and a second arrival pass is a no-op', async () => {
  const r = rig({ app: '1.4.2', desk: '3.2.163', jobs: ['other'], plists: ['other'], hs: 'abc1234' });
  const out = await r.tick();
  assert.equal(out.action, 'complete');
  assert.deepEqual(r.L.restarts, []);
  assert.deepEqual(r.L.retired, []);
  assert.equal(r.told.length, 1);
  assert.equal((await r.tick()).action, 'idle');
  assert.equal(r.told.length, 1);
});

test('a person using the laptop defers the restart; a locked screen restarts it by signal', async () => {
  const r = rig({ gate: 'CLOSED: someone used this Mac 7 s ago (need 90 s idle)' });
  await r.tick();
  assert.deepEqual(r.L.restarts, []);
  assert.match(r.state.epoch.steps.app.detail, /waiting for the laptop to be idle or locked/);
  r.L.gate = 'CLOSED: locked';
  await r.tick();
  assert.deepEqual(r.L.restarts, ['sigterm']);
});

test('a restart is not started while one is running, and at most restart_max per arrival', async () => {
  const r = rig();
  await r.tick();
  assert.equal(r.L.restarts.length, 1);
  await r.tick(); // still running
  assert.equal(r.L.restarts.length, 1);
  r.L.restart = { state: 'done' }; // finished, but the app is still behind
  await r.tick();
  assert.equal(r.L.restarts.length, 2);
  r.L.restart = { state: 'done' };
  await r.tick();
  assert.equal(r.L.restarts.length, 2);
  assert.match(r.state.epoch.steps.app.detail, /restarted 2 times/);
});

test('an app still old after 45 minutes gets the cask upgrade once, never while someone is using the laptop', async () => {
  const r = rig({ gate: 'CLOSED: someone used this Mac 7 s ago (need 90 s idle)' });
  await r.tick();
  r.L.gate = 'OPEN: unlocked, idle 500 s';
  await r.tick();
  assert.equal(r.L.restarts.length, 1);
  r.L.restart = { state: 'done' };
  r.L.gate = 'CLOSED: someone used this Mac 7 s ago (need 90 s idle)';
  r.advance(2800000);
  await r.tick();
  assert.equal(r.L.upgrades, 0, 'a person is using it');
  r.L.gate = 'OPEN: unlocked, idle 500 s';
  await r.tick();
  assert.equal(r.L.upgrades, 1);
  await r.tick();
  assert.equal(r.L.upgrades, 1, 'once per arrival');
});

test('the duplicate daemon is not unloaded until this Mac runs its own', async () => {
  const r = rig({ app: '1.4.2', desk: '3.2.163' });
  r.deps.miniJobRunning = async () => false;
  await r.tick();
  assert.deepEqual(r.L.retired, ['x.arrival-post']);
  assert.match(r.state.epoch.steps.retire.detail, /holding bot\.ouro\.daemon/);
  assert.equal(r.told.length, 0);
});

test('a stuck step is told once, after the grace period, with why', async () => {
  const r = rig({ hubOk: false, app: '1.4.2', desk: '3.2.163' });
  await r.tick();
  assert.equal(r.told.length, 0);
  await r.tick(1300000);
  assert.equal(r.told.length, 1);
  assert.match(r.told[0], /verify/);
  await r.tick();
  await r.tick();
  assert.equal(r.told.length, 1, 'the same block is not told again');
});

test('a short blip keeps the arrival; a long absence starts a new one', async () => {
  const r = rig({ app: '1.4.2', desk: '3.2.163', jobs: [], plists: [], hs: 'abc' });
  await r.tick();
  assert.equal(r.state.epoch.complete != null, true);
  const id = r.state.epoch.id;
  r.L.online = false; await r.tick(120000);
  r.L.online = true; assert.equal((await r.tick(120000)).action, 'idle');
  assert.equal(r.state.epoch.id, id);
  r.L.online = false; await r.tick(60000);
  r.L.online = true; await r.tick(1800000);
  assert.notEqual(r.state.epoch.id, id);
  assert.equal(r.told.length, 2);
});

test('a reboot of the laptop starts a new arrival', async () => {
  const r = rig({ app: '1.4.2', desk: '3.2.163', jobs: [], plists: [], hs: 'abc' });
  await r.tick();
  const id = r.state.epoch.id;
  r.L.boot = 5000;
  await r.tick();
  assert.notEqual(r.state.epoch.id, id);
});

test('a dry run changes nothing and writes no state, even against an online laptop', async () => {
  const r = rig();
  const out = await r.tick(60000, { dry_run: true });
  assert.equal(r.state, null);
  assert.equal(r.L.hs, null);
  assert.deepEqual(r.L.restarts, []);
  assert.deepEqual(r.L.retired, []);
  assert.deepEqual(r.told, []);
  assert.match(renderPass(out), /would/);
});

test('the macd update comes last and must leave the laptop answering', async () => {
  const cfg = { ...CFG, macd_update: true };
  const r = rig({ app: '1.4.2', desk: '3.2.163', jobs: [], plists: [], hs: 'abc' }, { cfg });
  const out = await r.tick();
  assert.equal(out.action, 'complete');
  assert.equal(r.state.epoch.steps.macd.status, 'done');
  r.L.bus = true;
  assert.equal(describePlan(cfg).at(-1).startsWith('macd: update'), true);
});

test('detect asks the bus only when Hub says online, or when Hub cannot be read and a probe is due', async () => {
  let probes = 0;
  const deps = { hubDevice: async () => ({ listed: true, online: false, lastSeenAt: 'x' }), sh: async () => { probes += 1; return { ok: true, out: 'boot=1\n' }; } };
  assert.equal((await detect(CFG, {}, deps, 0)).kind, 'down');
  assert.equal(probes, 0);
  deps.hubDevice = async () => { throw new Error('no token'); };
  assert.equal((await detect(CFG, { last_probe: new Date(0).toISOString(), phase: 'down' }, deps, 60000)).kind, 'down');
  assert.equal(probes, 0, 'a probe is not due yet');
  assert.equal((await detect(CFG, { last_probe: new Date(0).toISOString(), phase: 'down' }, deps, 400000)).kind, 'up');
  assert.equal(probes, 1);
});

test('a missing config names the fields it needs and where to read how', () => {
  assert.throws(() => loadConfig('/nonexistent/laptop-arrival.json'), (e) => /no config at \/nonexistent\/laptop-arrival\.json/.test(e.message) && /"peer"/.test(e.message) && /"route"/.test(e.message) && /housesitter laptop-arrival --help/.test(e.message));
});

const S = (name, over = {}) => ({ name, activity: { status: 'busy', last_activity: '2026-11-17T10:00:00Z' }, ...over });

test('coordinators: busy top-level sessions only, "coordinator" titles first, never drains or children, none when unsure', () => {
  const list = [S('Tandem coordinator', { activity: { status: 'busy', last_activity: '2026-11-17T10:05:00Z' } }), S('CIT Pages coordinator'), S('Ouro UI issue drain 2'), S('Moody\'s next steps query'), S('Child coordinator', { coordinator_session_id: 'x' }), S('Idle coordinator', { activity: { status: 'idle' } })];
  assert.deepEqual(pickCoordinators(list), ['Tandem coordinator', 'CIT Pages coordinator']);
  assert.deepEqual(pickCoordinators([S('Moody\'s next steps query'), S('Helper: lint'), S('Ouro UI issue drain 2')]), ["Moody's next steps query"]);
  assert.deepEqual(pickCoordinators([S('a coordinator 1'), S('b coordinator 2'), S('c coordinator 3'), S('d coordinator 4')]).length, 3);
  assert.deepEqual(pickCoordinators([S('x drain'), S('y', { activity: { status: 'idle' } })]), []);
  assert.deepEqual(pickCoordinators(undefined), []);
});

test('the report names what really works, not the deleted mac sessions verbs, and says none when unsure', () => {
  const st = { epoch: { started: '2026-11-17T15:00:00Z', steps: { app: { detail: 'app ok' }, verify: { detail: 'Hub ok' }, sessions: { detail: 'archived 2 finished session(s)' } } } };
  const t = reportText({ facts: { app: '1.4.2' }, st, cfg: {}, coordinators: ['A coordinator'] });
  assert.doesNotMatch(t, /mac sessions|aris-mac-mini:<id>/);
  assert.match(t, /Resume remote session/);
  assert.match(t, /housesitter steer --peer Aris-Mac-Mini/);
  assert.doesNotMatch(t, /sidebar/i);
  assert.match(t, /Talk to: A coordinator\./);
  assert.match(t, /Laptop sessions: archived 2/);
  assert.match(reportText({ facts: {}, st, cfg: {} }), /none I am certain of/);
});

test('sessions step: archives only what Shepherd\'s plan marks safe, lists the rest, is not repeated, and the report names coordinators', async () => {
  const r = rig({ hs: 'abc1234', app: '1.4.2', desk: '3.2.200', jobs: [], plists: [], plan: { retire: [{ what: 'archive', id: 'a', name: 'Old job', reason: 'finished', why: 'idle' }, { what: 'hold', id: 'b', name: 'Busy parent', why: 'held while sessions it coordinates still work' }], size: [], errors: [] } });
  await r.tick();
  assert.equal(r.state.epoch.steps.sessions.status, 'done');
  assert.match(r.state.epoch.steps.sessions.detail, /archived 1 finished session\(s\) \(Old job\).*left alone: Busy parent/);
  assert.equal(r.L.applied.length, 1);
  assert.match(r.told.at(-1), /Talk to: CIT Pages coordinator\./);
  await r.tick(); await r.tick();
  assert.equal(r.L.applied.length, 1);
  assert.equal(r.L.shepherdUpdates, 1);
});

test('sessions step: no-op when nothing is safe, waits when Shepherd cannot read, holds back with size actions, off by config', async () => {
  const base = { hs: 'abc1234', app: '1.4.2', desk: '3.2.200', jobs: [], plists: [] };
  let r = rig({ ...base, plan: { retire: [{ what: 'hold', id: 'b', name: 'P', why: 'w' }], size: [], errors: [] } });
  await r.tick();
  assert.equal(r.L.applied.length, 0);
  assert.match(r.state.epoch.steps.sessions.detail, /nothing Shepherd can confirm.*left alone: P/);
  r = rig({ ...base, plan: { retire: [], size: [], errors: ['app not running'] } });
  await r.tick();
  assert.equal(r.state.epoch.steps.sessions.status, 'wait');
  r = rig({ ...base, plan: { retire: [{ what: 'archive', id: 'a', name: 'Old', why: 'idle' }], size: [{ what: 'flag' }], errors: [] } });
  await r.tick();
  assert.equal(r.L.applied.length, 0);
  assert.match(r.state.epoch.steps.sessions.detail, /none were archived/);
  r = rig(base, { cfg: { ...CFG, laptop_sessions_retire: false } });
  await r.tick();
  assert.equal(r.state.epoch.steps.sessions.detail, 'off in the config');
  assert.ok(describePlan(CFG).some((l) => l.startsWith('sessions:')));
});
