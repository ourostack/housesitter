// housesitter restart-copilot --os-updates: macOS installs its own updates; housesitter reads what is pending and what macOS
// will do (no admin rights), and shortly before it acts gets every session to a safe point, arms the Apple Account prompt and
// writes the sessions owed a resume; it stands down if the Mac does not restart, and says once what to turn on if nothing will.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { INSTALLING, OS, decide, nativeOffText, parseDefaults, parseEnforced, parseNative, parseUpdates, pass, realOsDeps } from '../src/os-update.mjs';
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


const LOG_LINE = '2026-11-15 11:41:10.557 Df softwareupdated[73513:8aeb985] [com.apple.SoftwareUpdateMacController:DDM] Sorted valid enforced-su declarations: ( "SUCoreDDMDeclaration (DeclarationKey:com.apple.RemoteManagement.SoftwareUpdateExtension/7341AD9C:MDE0=|EnforcedInstallDate:2026-11-21T00:00:00|VersionString:27.2.2|BuildVersionString:(null)|DetailsURL:(null)|NotificationsEnabled:YES)" )';

const DEFAULTS = `{
    AutomaticDownload = 1;
    AutomaticallyInstallMacOSUpdates = 1;
    CriticalUpdateInstall = 1;
    DDMPersistedErrorKey =     {
    };
    FirstInstallTonightDateDictionary =     {
        "MSU_UPDATE_26B131_patch_27.2.1_minor" = "2026-11-10 15:30:06 +0000";
    };
    InstallDateDictionary =     {
        26B123 = "2026-11-06 17:36:58 +0000";
        26B131 = "2026-11-15 19:54:12 +0000";
    };
    LastResultCode = 2;
}`;

test('parseNative and parseEnforced read what macOS and the management server have set, with no admin rights', () => {
  const n = parseNative({ AutomaticCheckEnabled: 1, AutomaticDownload: 1, AutomaticallyInstallMacOSUpdates: 1, CriticalUpdateInstall: 1, FirstInstallTonightDateDictionary: { 'MSU_UPDATE_26B131_patch_27.2.1_minor': 'x' } });
  assert.deepEqual([n.check, n.download, n.install, n.critical, n.scheduled.length], [true, true, true, true, 1]);
  assert.equal(parseNative({ AutomaticDownload: 1 }).install, false);
  const t = parseNative(parseDefaults(DEFAULTS));
  assert.deepEqual([t.download, t.install, t.critical, t.scheduled, t.installed], [true, true, true, ['MSU_UPDATE_26B131_patch_27.2.1_minor'], ['26B123', '26B131']]);
  const e = parseEnforced(`noise\n${LOG_LINE}\n`);
  assert.equal(e.version, '27.2.2');
  assert.equal(e.at, new Date(2026, 10, 21, 0, 0, 0).getTime(), 'a date without a zone is the Mac\'s local time');
  assert.equal(parseEnforced('nothing here'), null);
  assert.ok(INSTALLING.test('CurrentProgressStateName = SUMacControllerProgressStateApplying'));
  assert.ok(!INSTALLING.test('CurrentProgressStateName = SUMacControllerProgressStatePrepared'));
});

test('decide: at the enforced deadline less the lead, in the quiet hours with nobody there, or when the install starts; never twice for the same trigger', () => {
  const day = new Date(2026, 10, 20, 12, 0, 0).getTime();
  const deadline = new Date(2026, 10, 21, 0, 0, 0).getTime();
  const native = { install: true, download: true };
  const enforced = { at: deadline, version: '27.2.2', date: '2026-11-21T00:00:00' };
  const base = { update: UPDATE, native, enforced: null, state: {}, now: day, hour: 12, idleMs: 0, imminent: false };
  assert.equal(decide({ ...base, update: null }).code, 'nothing-pending');
  assert.equal(decide({ ...base, state: { completed: { label: UPDATE.label, at: 'x' } } }).code, 'done');
  assert.equal(decide({ ...base, enforced }).code, 'before-deadline', 'noon is hours before the lead starts');
  const lead = decide({ ...base, enforced, now: deadline - OS.lead + 60000, hour: 22 });
  assert.deepEqual([lead.action, lead.code, lead.until], ['run', 'deadline', deadline + OS.afterDeadline]);
  assert.equal(decide({ ...base, enforced, now: deadline - OS.lead + 60000, hour: 22, state: { safe: { key: lead.key, at: 'x' } } }).action, 'hold', 'the deadline safe point runs once');
  assert.equal(decide({ ...base, enforced: { ...enforced, version: '27.3' }, now: deadline - 60000, hour: 23 }).code, 'waiting', 'a deadline for another version is not ours');
  const night = { ...base, now: new Date(2026, 10, 20, 3, 0, 0).getTime(), hour: 3, idleMs: 30 * 60000 };
  assert.equal(decide(night).code, 'night');
  assert.equal(decide({ ...night, idleMs: 60000 }).action, 'hold', 'somebody is at the Mac');
  assert.equal(decide({ ...night, idleMs: null }).action, 'hold');
  assert.equal(decide({ ...night, hour: 5 }).action, 'hold', 'the window ends at 05:00');
  assert.equal(decide({ ...night, state: { safe: { key: decide(night).key, at: 'x' } } }).action, 'hold', 'once a night');
  assert.equal(decide({ ...base, imminent: true }).code, 'imminent');
  assert.equal(decide({ ...base, force: true }).code, 'manual');
  const off = decide({ ...base, native: { install: false } });
  assert.equal(off.action, 'native-off');
  assert.equal(decide({ ...base, native: { install: false }, enforced }).action, 'hold', 'an enforced deadline installs it by itself even with the setting off');
  assert.match(nativeOffText({ update: UPDATE }), /administrator's password.*Install macOS updates/);
});

const worlds = [];
after(async () => { for (const w of worlds) await w.done(); });

async function world({ hour = 12, idle = 3600000, native = { install: true, download: true, critical: true }, enforced = null, imminent = false } = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, 'os-'));
  const root = fs.mkdtempSync(path.join(SCRATCH, 'os-root-'));
  makeHome(home, [{ id: A, title: 'busy a', mode: 'autopilot', running: true, events: MID_TURN }, { id: B, title: 'idle b', events: DONE }, { id: C, title: 'busy c', mode: 'interactive', events: MID_TURN }]);
  const app = await startApp(home, {});
  const w = { home, root, app, told: [], armed: [], opens: 0, kills: [], hk: [], procs: [{ pid: 100, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` }], startedAt: Date.now() - 600000, listing: LISTING, owedWhileArmed: null, stateWhileArmed: null, loaded: new Set(), boot: null };
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
    open: async () => { w.opens++; return { code: 0, stderr: '' }; },
    tell: async (t) => { w.told.push(t); return { ok: true }; },
    listUpdates: async () => ({ ok: true, text: w.listing }),
    native: async () => native,
    enforced: async () => { if (typeof enforced === 'function') enforced = enforced(); return enforced; },
    imminent: async () => imminent,
    idleMs: async () => idle,
    hour: () => hour,
    expectReboot: (why) => { w.armed.push(why); w.owedWhileArmed = d.owed.get(); w.stateWhileArmed = d.readState(); },
    bootTime: async () => w.boot,
    loaded: async () => w.loaded,
    wantedJobs: () => ['bot.ouro.housesitter.heartbeat', 'bot.ouro.housesitter.copilot-resume'],
    lastWrite: () => {},
  });
  w.deps = d;
  w.opts = { app: 'Fake Copilot', resume: true, t: { settle: 200, grace: 0, quit: 400, up: 2000, delivery: 3000, retry: 400, tries: 2 }, os: { manualWait: 100 } };
  let closed = false;
  w.done = async () => {
    if (closed) return;
    closed = true;
    await new Promise((r) => setTimeout(r, 120));
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  };
  worlds.push(w);
  return w;
}

test('at the enforced deadline: sessions reach a safe point with the app left running, the prompt is armed and the resume owed; when the Mac does not restart it stands down', { skip }, async () => {
  const w = await world({ enforced: () => ({ at: Date.now() + 30, version: '27.2.2', date: '2026-11-21T00:00:00' }) });
  const r = await pass({ ...w.opts, os: { lead: 60000, afterDeadline: 300 } }, w.deps);
  assert.equal(r.decision.code, 'deadline');
  const asked = w.app.received.filter((m) => /Heads up/.test(m.prompt));
  assert.deepEqual(asked.map((m) => m.id).sort(), [A, C], 'the working sessions are asked to reach a safe point');
  assert.match(asked[0].prompt, /the Mac restarts for a macOS update \(27\.2\.2\) that macOS installs by itself/);
  assert.equal(w.armed.length, 1);
  assert.match(w.armed[0], /macOS update \(27\.2\.2\).*reboot/);
  assert.deepEqual(w.owedWhileArmed.sort(), [A, C], 'the sessions owed a resume are written down before the Mac can restart');
  assert.deepEqual([w.stateWhileArmed.reboot.label, w.stateWhileArmed.reboot.planned], [UPDATE.label, true], 'the reboot is recorded as planned while holding');
  assert.deepEqual([w.hk.includes('do menu'), w.opens, w.kills.length], [false, 0, 0], 'the app is never quit');
  assert.deepEqual(w.app.received.filter((m) => /was called off/.test(m.prompt)).map((m) => m.id).sort(), [A, C], 'nothing happened: the sessions are told to carry on');
  assert.deepEqual(w.deps.owed.get(), [], 'nothing stays owed');
  const st = w.deps.readState();
  assert.equal(st.reboot, null);
  assert.equal(st.safe.outcome, 'stood-down');
  assert.deepEqual(w.told, [], 'nobody is bothered');
  const again = await pass({ ...w.opts, os: { lead: 60000, afterDeadline: 300 } }, w.deps);
  assert.equal(again.decision.action, 'hold', 'once per deadline');
  await w.done();
});

test('the quiet hours with nobody at the Mac, and the install starting, each run the safe point', { skip }, async () => {
  const night = await world({ hour: 3 });
  assert.equal((await pass({ ...night.opts, os: { minHold: 100, maxHold: 300 } }, night.deps).catch((e) => e)).decision?.code, 'night');
  assert.equal(night.armed.length, 1);
  await night.done();
  const soon = await world({ imminent: true });
  assert.equal((await pass({ ...soon.opts, os: { imminentWithin: 200 } }, soon.deps)).decision.code, 'imminent');
  assert.equal(soon.armed.length, 1);
  await soon.done();
});

test('outside every trigger, or with a person at the Mac overnight, nothing is touched', { skip }, async () => {
  const day = await world({ hour: 14, enforced: { at: Date.now() + 3 * 86400000, version: '27.2.2', date: 'x' } });
  assert.equal((await pass(day.opts, day.deps)).decision.code, 'before-deadline');
  assert.deepEqual([day.armed.length, day.app.received.length], [0, 0]);
  await day.done();
  const busy = await world({ hour: 3, idle: 60000 });
  assert.equal((await pass(busy.opts, busy.deps)).decision.action, 'hold');
  assert.deepEqual([busy.armed.length, busy.app.received.length], [0, 0]);
  await busy.done();
});

test('automatic install off and nothing enforced: nothing is touched and the agent is told once which setting a person must turn on', { skip }, async () => {
  const w = await world({ native: { install: false, download: true } });
  const r = await pass(w.opts, w.deps);
  assert.equal(r.decision.action, 'native-off');
  assert.deepEqual([w.armed.length, w.app.received.length, w.hk.length], [0, 0, 0]);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0], /Install macOS updates.*administrator's password/);
  await pass(w.opts, w.deps);
  assert.equal(w.told.length, 1, 'told once per update');
  await w.done();
});

test('--now: the safe point at once, one message to restart the Mac, then it stands down if nobody does', { skip }, async () => {
  const w = await world({ hour: 14, idle: 0 });
  const r = await pass({ ...w.opts, force: true }, w.deps);
  assert.equal(r.decision.code, 'manual');
  assert.equal(w.armed.length, 1);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0], /^Ready for the restart: every working session is at a safe point\. Restart the Mac now/);
  assert.equal(w.opens, 0);
  assert.equal(w.app.received.filter((m) => /was called off/.test(m.prompt)).length, 2);
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
