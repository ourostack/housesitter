// housesitter restart-copilot --os-updates: a pending macOS update is installed only in the quiet hours with nobody at the
// Mac, after every working session is at a safe point, with the Apple Account prompt armed and the sessions owed a resume
// written down first; and when it cannot be installed without a password, the agent is told once what is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { consentText, decide, parseUpdates, pass, realOsDeps } from '../src/os-update.mjs';
import { DONE, MID_TURN, haveSqlite, makeHome, startApp } from './fake_app.mjs';

const skip = !haveSqlite() || typeof WebSocket !== 'function';
const SCRATCH = path.join(path.dirname(new URL(import.meta.url).pathname), '.scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const BUNDLE = '/Applications/Fake Copilot.app';
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003';
const LISTING = `Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: macOS 27.2.2-26B140
\tTitle: macOS 27.2.2, Version: 27.2.2, Size: 1234567KiB, Recommended: YES, Action: restart,
* Label: Safari27.2-27.2
\tTitle: Safari, Version: 27.2, Size: 100KiB, Recommended: YES,
`;
const UPDATE = { label: 'macOS 27.2.2-26B140', title: 'macOS 27.2.2', version: '27.2.2', restart: true };

test('parseUpdates reads softwareupdate -l and tells a restart from a plain update', () => {
  const u = parseUpdates(LISTING);
  assert.deepEqual(u.map((x) => [x.label, x.version, x.restart]), [['macOS 27.2.2-26B140', '27.2.2', true], ['Safari27.2-27.2', '27.2', false]]);
  assert.deepEqual(parseUpdates('No new software available.'), []);
});

test('decide: only in the quiet hours, with nobody at the Mac, and only when it can install without a password', () => {
  const now = Date.parse('2026-11-16T03:00:00');
  const go = { update: UPDATE, state: {}, now, hour: 3, idleMs: 30 * 60000, canInstall: true };
  assert.equal(decide(go).action, 'run');
  assert.equal(decide({ ...go, update: null }).code, 'nothing-pending');
  assert.equal(decide({ ...go, hour: 14 }).code, 'outside-window');
  assert.equal(decide({ ...go, hour: 5 }).code, 'outside-window', 'the window ends at 05:00');
  assert.equal(decide({ ...go, idleMs: 60000 }).code, 'person-active');
  assert.equal(decide({ ...go, idleMs: null }).code, 'person-active', 'idle time unknown is not quiet');
  assert.equal(decide({ ...go, canInstall: false }).action, 'needs-consent');
  assert.equal(decide({ ...go, state: { completed: { label: UPDATE.label, at: 'x' } } }).code, 'done');
  assert.equal(decide({ ...go, hour: 14, idleMs: 0, force: true }).action, 'run', '--now skips the wait');
  assert.match(consentText({ update: UPDATE, bin: '/b/housesitter.mjs', node: '/n/node' }), /administrator's password.*NOPASSWD: \/usr\/sbin\/softwareupdate.*--os-updates --prepare/);
});

async function world({ canInstall = true, installOk = true, hour = 3, idle = 3600000 } = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, 'os-'));
  const root = fs.mkdtempSync(path.join(SCRATCH, 'os-root-'));
  makeHome(home, [{ id: A, title: 'busy a', mode: 'autopilot', running: true, events: MID_TURN }, { id: B, title: 'idle b', events: DONE }, { id: C, title: 'busy c', mode: 'interactive', events: MID_TURN }]);
  const app = await startApp(home, {});
  const w = { home, root, app, told: [], installs: [], armed: [], opens: 0, kills: [], hk: [], procs: [{ pid: 100, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` }], startedAt: Date.now() - 600000, listing: LISTING, owedAtInstall: null, loaded: new Set(), boot: null };
  const d = realOsDeps({ home: root, copilotHome: home, state: path.join(root, 'state'), bin: '/b/housesitter.mjs', node: '/n/node' });
  Object.assign(d, {
    hackamore: ['hackamore'],
    appDir: () => BUNDLE,
    ps: async () => w.procs,
    startedAt: async () => w.startedAt,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    hk: async (argv) => {
      w.hk.push(argv.slice(0, 2).join(' '));
      if (argv[0] === 'ls') return { code: 0, json: { actions: [{ name: 'menu', input: { properties: { item: { enum: ['App > Quit Fake'] } } } }] } };
      w.procs = [];
      return { code: 0, json: {} };
    },
    kill: (pid) => { w.kills.push(pid); w.procs = w.procs.filter((p) => p.pid !== pid); return true; },
    open: async () => { w.opens++; w.startedAt = Date.now(); w.procs = [{ pid: 200, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` }]; return { code: 0, stderr: '' }; },
    tell: async (t) => { w.told.push(t); return { ok: true }; },
    listUpdates: async () => ({ ok: true, text: w.listing }),
    idleMs: async () => idle,
    hour: () => hour,
    canInstall: async () => canInstall,
    install: async (label) => { w.owedAtInstall = d.owed.get(); w.installs.push(label); return { ok: installOk, text: installOk ? '' : 'sudo: a password is required' }; },
    expectReboot: (why) => w.armed.push(why),
    bootTime: async () => w.boot,
    loaded: async () => w.loaded,
    wantedJobs: () => ['bot.ouro.housesitter.heartbeat', 'bot.ouro.housesitter.copilot-resume'],
    lastWrite: () => {},
  });
  w.deps = d;
  w.opts = { app: 'Fake Copilot', resume: true, t: { settle: 200, grace: 0, quit: 400, up: 2000, delivery: 3000, retry: 400, tries: 2 }, os: { prepareWait: 0, installWait: 0 } };
  w.done = async () => { await new Promise((r) => setTimeout(r, 120)); await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); };
  return w;
}

test('in the quiet hours: sessions are asked to reach a safe point, the app is quit, the Apple Account prompt is armed and the owed resume written, then it installs', { skip }, async () => {
  const w = await world();
  const r = await pass(w.opts, w.deps);
  assert.equal(r.decision.action, 'run');
  assert.deepEqual(w.app.received.filter((m) => /Heads up/.test(m.prompt)).map((m) => m.id).sort(), [A, C], 'the working sessions are asked to reach a safe point');
  assert.match(w.app.received.find((m) => /Heads up/.test(m.prompt)).prompt, /restarts for a macOS update \(27\.2\.2\)/);
  assert.deepEqual(w.installs, ['macOS 27.2.2-26B140']);
  assert.deepEqual(w.owedAtInstall.sort(), [A, C], 'the sessions owed a resume are written down before the install');
  assert.equal(w.armed.length, 1);
  assert.match(w.armed[0], /macOS update \(27\.2\.2\) reboot/);
  assert.ok(w.hk.includes('do menu'), 'the app is quit through its own Quit item');
  await w.done();
});

test('the Mac does not go down after the install: the app is relaunched and the sessions resumed, nothing is left closed', { skip }, async () => {
  const w = await world();
  const r = await pass(w.opts, w.deps);
  assert.equal(w.opens, 1);
  assert.deepEqual(r.report.resume.map((x) => x.outcome).sort(), ['resumed', 'resumed']);
  assert.equal(w.deps.readState().reboot, null);
  assert.deepEqual(w.deps.owed.get(), [], 'nothing is owed once they are resumed');
  await w.done();
});

test('an install that will not start tells the agent once, and the app is back with its sessions', { skip }, async () => {
  const w = await world({ installOk: false });
  await pass(w.opts, w.deps);
  assert.equal(w.opens, 1);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0], /tried to install macOS 27\.2\.2-26B140 and it did not start \(sudo: a password is required\).*the sessions were resumed/);
  await w.done();
});

test('without a password for softwareupdate it installs nothing, touches no session, and says once what is needed', { skip }, async () => {
  const w = await world({ canInstall: false });
  const r = await pass(w.opts, w.deps);
  assert.equal(r.decision.action, 'needs-consent');
  assert.deepEqual([w.installs.length, w.app.received.length, w.hk.length], [0, 0, 0]);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0], /administrator's password/);
  await pass({ ...w.opts }, w.deps);
  assert.equal(w.told.length, 1, 'told once per update');
  await w.done();
});

test('outside the quiet hours, or with a person at the Mac, nothing happens', { skip }, async () => {
  const day = await world({ hour: 14 });
  assert.equal((await pass(day.opts, day.deps)).decision.code, 'outside-window');
  assert.deepEqual([day.installs.length, day.app.received.length], [0, 0]);
  await day.done();
  const busy = await world({ idle: 60000 });
  assert.equal((await pass(busy.opts, busy.deps)).decision.code, 'person-active');
  assert.equal(busy.installs.length, 0);
  await busy.done();
});

test('--prepare gets everything ready for a person to restart: safe point, app closed, prompt armed, one message; then it gives up and resumes', { skip }, async () => {
  const w = await world({ canInstall: false, hour: 14, idle: 0 });
  const r = await pass({ ...w.opts, prepare: true }, w.deps);
  assert.equal(w.installs.length, 0, 'it never installs');
  assert.equal(w.armed.length, 1);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0], /^Ready for the restart: every working session is at a safe point and the app is closed\. Restart the Mac now/);
  assert.equal(w.opens, 1, 'nobody restarted the Mac in time: the app is reopened and the sessions resumed');
  assert.equal(r.report.resume.length, 2);
  await w.done();
});

test('after a planned reboot it checks that our jobs came back, and tells only about the ones that did not', { skip }, async () => {
  const w = await world();
  w.listing = 'No new software available.';
  w.deps.writeState({ reboot: { at: new Date(Date.now() - 600000).toISOString(), label: 'macOS 27.2.2-26B140', planned: true }, checked_at: new Date().toISOString() });
  w.boot = Date.now() - 300000;
  w.loaded = new Set(['bot.ouro.housesitter.heartbeat']);
  await pass(w.opts, w.deps);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0], /did not come back by themselves: bot\.ouro\.housesitter\.copilot-resume/);
  assert.equal(w.deps.readState().completed.label, 'macOS 27.2.2-26B140');
  await pass(w.opts, w.deps);
  assert.equal(w.told.length, 1, 'once');
  const ok = await world();
  ok.listing = 'No new software available.';
  ok.deps.writeState({ reboot: { at: new Date(Date.now() - 600000).toISOString(), label: 'x', planned: true }, checked_at: new Date().toISOString() });
  ok.boot = Date.now() - 300000;
  ok.loaded = new Set(['bot.ouro.housesitter.heartbeat', 'bot.ouro.housesitter.copilot-resume']);
  await pass(ok.opts, ok.deps);
  assert.deepEqual(ok.told, [], 'when everything came back it says nothing');
  await w.done(); await ok.done();
});
