// housesitter steer: another computer can see and drive this Mac's sessions only while the Hub daemon is connected, tracks
// every session and is owned by launchd. A bad state is repaired on its second sighting and told once if it does not hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gather, judge, parseHubStatus, parseLaunchd, pass, readable, renderFacts } from '../src/steer.mjs';

const HUB_OK = `WARN GH_TOKEN is set but will be ignored.
hub daemon (PID 3758)
  Connection:      connected
  Server:          https://example.invalid/
  Auto-shutdown:   disabled
  Tracking:        all sessions (track-all)
`;
const LAUNCHD_OK = '\tstate = running\n\tpid = 3758\n';

test('the daemon status and the launchd job are read', () => {
  assert.deepEqual(parseHubStatus(HUB_OK), { running: true, pid: 3758, connection: 'connected', autoShutdown: 'disabled', tracking: 'all sessions (track-all)' });
  assert.equal(parseHubStatus('hub daemon is not running').running, false);
  assert.deepEqual(parseLaunchd(LAUNCHD_OK), { loaded: true, running: true, pid: 3758 });
  assert.deepEqual(parseLaunchd('Could not find service'), { loaded: false, running: false, pid: null });
});

const facts = (over = {}) => ({ agency: '/x/agency', hub: parseHubStatus(HUB_OK), launchd: parseLaunchd(LAUNCHD_OK), device: { name: 'Mini', online: true, activeSessionCount: 120 }, ...over });

test('judge names each way the route can be broken, and what a repair can fix', () => {
  assert.deepEqual(judge(facts()), []);
  assert.deepEqual(judge(facts({ hub: { ...facts().hub, tracking: 'sessions started with --hub' } })).map((b) => b.code), ['not-track-all']);
  assert.deepEqual(judge(facts({ hub: { ...facts().hub, connection: 'reconnecting' } })).map((b) => b.code), ['hub-disconnected']);
  assert.deepEqual(judge(facts({ launchd: { loaded: true, running: true, pid: 99 } })).map((b) => b.code), ['daemon-unsupervised']);
  assert.deepEqual(judge(facts({ hub: { running: false } })).map((b) => b.code), ['hub-down']);
  assert.equal(judge(facts({ deviceError: 'no az' })).every((b) => b.soft), true, 'an unreadable service is not a reason to restart the daemon');
  assert.deepEqual(judge({ agency: null }).map((b) => b.code), ['no-agency']);
});

function rig({ hubText = HUB_OK, launchd = LAUNCHD_OK } = {}) {
  let now = Date.parse('2026-11-16T10:00:00Z');
  const calls = [], told = [];
  const r = {
    calls, told, hubText, launchd,
    deps: {
      agency: '/x/agency', now: () => now, uid: 501, sleep: async () => {},
      agencyRun: async (argv) => {
        calls.push(argv.join(' '));
        if (argv.join(' ') === 'hub status') return { code: 0, stdout: r.hubText, stderr: '' };
        if (argv.join(' ') === 'hub stop') return { code: 0, stdout: '', stderr: '' };
        if (argv.join(' ') === 'hub autostart enable --track-all') { r.hubText = HUB_OK; r.launchd = LAUNCHD_OK; return { code: 0, stdout: '', stderr: '' }; }
        if (argv[1] === 'list-local-sessions') return { code: 0, stdout: JSON.stringify({ sessions: [{ session_id: 'aaaaaaaa-1', source: 'copilot_app' }, { session_id: 'bbbbbbbb-2', source: 'copilot_app' }, { session_id: 'cccccccc-3', source: 'copilot_cli' }] }), stderr: '' };
        throw new Error(`unexpected ${argv}`);
      },
      launchctl: async () => ({ code: 0, stdout: r.launchd, stderr: '' }),
      hubGet: async (p) => {
        if (p === '/devices') return { status: 200, body: [{ deviceName: 'Mini', source: 'DevMachine', platform: 'macos', deviceId: 'd1', online: true, activeSessionCount: 120 }, { deviceName: 'Mac', deviceId: 'd2', online: true, activeSessionCount: 3 }] };
        if (p === '/sessions/aaaaaaaa-1') return { status: 200, body: { title: 'A', status: 'Active', statusDetail: 'Waiting for input' } };
        return { status: 404, body: null };
      },
      sql: async (q) => (q.includes('app_state') ? [{ value: '{"state":{"defaultRemoteSessionMode":"on"}}' }] : [{ m: 'on', n: 5 }, { m: 'export', n: 2 }]),
      readState: () => r.st || {}, writeState: (o) => { r.st = o; },
      tell: async (t) => { told.push(t); return { ok: true }; },
    },
    tick: (ms = 60000, o = {}) => { now += ms; return pass(o, r.deps); },
  };
  return r;
}

test('gather reads Hub, launchd, the device, the app default and which live sessions Hub can read', async () => {
  const r = rig();
  const f = await gather(r.deps, { peer: 'Mac' });
  assert.equal(f.device.activeSessionCount, 120);
  assert.deepEqual(f.remote, { default: 'on', on: 5, export: 2, off: 0 });
  assert.deepEqual(f.peer, { name: 'Mac', online: true, activeSessionCount: 3, lastSeenAt: undefined });
  assert.equal(f.sessions.checked, 2, 'only app sessions are counted');
  assert.equal(f.sessions.visible, 1);
  assert.deepEqual(f.sessions.missing, ['bbbbbbbb-2']);
  assert.match(renderFacts(f, []), /another computer can see and drive/);
  assert.equal((await readable(r.deps)).rows[0].detail, 'Waiting for input');
});

test('a healthy pass changes nothing and says nothing', async () => {
  const r = rig();
  const out = await r.tick(60000, { repair: true, sessions: false });
  assert.equal(out.bad.length, 0);
  assert.equal(r.calls.includes('hub stop'), false);
  assert.deepEqual(r.told, []);
});

test('a bad daemon is repaired on its second sighting with the supported pair of commands, not before', async () => {
  const r = rig({ hubText: HUB_OK.replace('all sessions (track-all)', 'sessions started with --hub') });
  await r.tick(60000, { repair: true, sessions: false });
  assert.equal(r.calls.includes('hub stop'), false, 'a restart in flight can look bad for a moment');
  const out = await r.tick(60000, { repair: true, sessions: false });
  assert.deepEqual(r.calls.filter((c) => /^hub (stop|autostart)/.test(c)), ['hub stop', 'hub autostart enable --track-all']);
  assert.equal(out.bad.length, 0);
  assert.deepEqual(r.told, []);
  assert.equal(r.st.bad_runs, undefined);
});

test('a repair that does not hold is told once after ten minutes, and the recovery once', async () => {
  const r = rig({ hubText: HUB_OK.replace('connected', 'disconnected') });
  r.deps.agencyRun = ((orig) => async (argv) => (argv.join(' ') === 'hub autostart enable --track-all' ? { code: 1, stdout: '', stderr: 'no' } : orig(argv)))(r.deps.agencyRun);
  await r.tick(60000, { repair: true, sessions: false });
  await r.tick(60000, { repair: true, sessions: false });
  assert.equal(r.told.length, 0);
  await r.tick(660000, { repair: true, sessions: false });
  assert.equal(r.told.length, 1);
  assert.match(r.told[0], /cannot reliably see and drive/);
  await r.tick(60000, { repair: true, sessions: false });
  assert.equal(r.told.length, 1);
  r.hubText = HUB_OK;
  await r.tick(60000, { repair: true, sessions: false });
  assert.equal(r.told.length, 2);
  assert.match(r.told[1], /reachable again/);
});

test('without --repair nothing is ever changed', async () => {
  const r = rig({ hubText: 'hub daemon is not running' });
  r.launchd = 'Could not find service';
  await r.tick(60000, { sessions: false });
  await r.tick(60000, { sessions: false });
  assert.equal(r.calls.some((c) => /^hub (stop|autostart)/.test(c)), false);
});
