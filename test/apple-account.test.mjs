// The Apple Account password prompt: filled only in the right dialog, in the right window of time, once, with no value in any
// log, and never past a verification code. A pretend Setup Assistant and a pretend Keychain stand in; no real secret is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = await import(path.join(ROOT, 'src/apple-account.mjs'));
const { parseRef, secretStore } = await import(path.join(ROOT, 'src/config.mjs'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hs-apple-'));

const FAKE = 'FAKE-not-a-real-password';
const BOOT = Date.parse('2026-11-15T20:00:54Z');
const MARKER = { at: BOOT - 120000, why: 'the 12:00 update reboot' };
const APPLE = { name: 'Setup Assistant', bundle: 'com.apple.SetupAssistant', front: true };
const screen = (texts, extra = []) => ({ state: { app: APPLE, window: { title: null }, alerts: [], elements: [...texts.map((label) => ({ role: 'statictext', label })), ...extra] } });
const FIELD = { role: 'securetextfield', label: 'Password', ref: 'securetextfield[Password]' };
const CONTINUE = { role: 'button', label: 'Continue', ref: 'button[Continue]' };
const PROMPT = screen(['To set up iCloud, enter the password for “a@example.test”'], [FIELD, CONTINUE]);
const MAC_PW = screen(['Enter the password for “someone”.'], [FIELD, CONTINUE]);
const CODE = screen(['Enter the verification code sent to your other devices']);
const DONE = screen(['Update Complete']);

// seq: what `ls` shows, in order, then the last one for ever; submitting moves to the next after the first.
function world({ seq = [PROMPT, DONE], now = BOOT + 300000, marker = MARKER, bootAt = BOOT, hasSecret = true, person = false } = {}) {
  const w = { calls: [], audit: [], told: [], state: {}, i: 0, typed: 0 };
  w.deps = {
    now: () => now, sleep: async () => {}, settleMs: 0,
    pid: async () => 4321,
    bootAt: () => bootAt, marker: () => marker,
    state: { get: () => w.state, set: (s) => { w.state = s; } },
    hasSecret: (ref) => hasSecret && ref === 'keychain:housesitter/mini-apple-account',
    audit: (e) => w.audit.push(e),
    tell: async ({ id, text }) => { if (!w.told.some((t) => t.id === id)) w.told.push({ id, text }); },
    hk: async (argv) => {
      w.calls.push(argv);
      assert.ok(!JSON.stringify(argv).includes(FAKE), 'the value is never an argument');
      if (argv[0] === 'ls') return { code: 0, json: seq[Math.min(w.i, seq.length - 1)] };
      if (argv[1] === 'type_secret') { if (person) return { code: 2, json: { ok: false, code: 'person-active' }, text: '' }; w.typed++; return { code: 0, json: { ok: true } }; }
      w.i++;
      return { code: 0, json: { ok: true } };
    },
  };
  return w;
}

test('after a coordinated boot, the iCloud password pane is filled once, with no value anywhere, and the owner is told once', async () => {
  const w = world();
  const r = await A.attempt({ mac: 'mini' }, w.deps);
  assert.equal(r.status, 'filled', JSON.stringify(r));
  const typed = w.calls.find((c) => c[1] === 'type_secret');
  assert.deepEqual(JSON.parse(typed[2]), { keychain_item: 'mini-apple-account', element: 'securetextfield[Password]' });
  assert.deepEqual(typed.slice(3), ['--app', 'Setup Assistant']);
  assert.ok(w.calls.some((c) => c[1] === 'click' && JSON.parse(c[2]).element === 'button[Continue]'), 'the pane is continued with its own button');
  assert.ok(w.audit.map((a) => a.event).includes('filled'));
  assert.ok(!JSON.stringify([w.audit, w.state, w.told]).includes(FAKE));
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /filled the Apple Account password prompt after the 12:00 update reboot/);
  // the same boot is not filled twice, even if the pane came back
  const w2 = Object.assign(world({ seq: [PROMPT] }), { state: w.state });
  assert.equal((await A.attempt({ mac: 'mini' }, w2.deps)).status, 'no-dialog');
  assert.equal(w2.typed, 0);
});

test("Setup Assistant's other password panes get nothing: only the iCloud pane is the dialog", async () => {
  const w = world({ seq: [MAC_PW] });
  assert.equal((await A.attempt({ mac: 'mini' }, w.deps)).status, 'no-dialog');
  assert.equal(w.typed, 0);
  assert.equal(w.told.length, 0);
  const text = new RegExp(A.hackamoreRule('mini').text, 'i');
  for (const t of ['To set up iCloud, enter the password for “a”', 'To set up iCloud and Find My Mac, enter the password for “a”']) assert.match(t, text);
  for (const t of ['Enter the password for “a”.', 'Please enter the password for the user “a”.', 'Please enter the password used to unlock your Mac’s boot volume.']) assert.doesNotMatch(t, text);
  assert.match('com.apple.SetupAssistant', new RegExp(A.hackamoreRule('mini').app, 'i'));
  for (const b of ['com.apple.Safari', 'com.apple.systempreferences', 'com.apple.SecurityAgent', 'com.apple.SetupAssistant.x']) assert.doesNotMatch(b, new RegExp(A.hackamoreRule('mini').app, 'i'));
});

test('outside the window, or after a boot nobody coordinated, the prompt is left alone and the owner told once; --now answers it', async () => {
  for (const [name, o] of [['an uncoordinated boot', { marker: null }], ['31 minutes after the boot', { now: BOOT + 31 * 60000 }], ['a marker written after the boot', { marker: { at: BOOT + 600000, why: 'x' } }], ['a marker from a day before', { marker: { at: BOOT - 24 * 3600000, why: 'x' } }]]) {
    const w = world(o);
    assert.equal((await A.attempt({ mac: 'mini' }, w.deps)).status, 'left-alone', name);
    assert.equal((await A.attempt({ mac: 'mini' }, w.deps)).status, 'left-alone', name);
    assert.equal(w.typed, 0, name);
    assert.equal(w.told.length, 1, `${name}: told once`);
    assert.match(w.told[0].text, /left alone/);
  }
  const w = world({ marker: null });
  const r = await A.attempt({ mac: 'mini', explicit: true }, w.deps);
  assert.equal(r.status, 'filled');
  assert.match(w.told[0].text, /when asked/);
});

test('a verification code stops it: nothing more is typed, the owner is told once, and the boot is not tried again', async () => {
  const w = world({ seq: [PROMPT, CODE] });
  const r = await A.attempt({ mac: 'mini' }, w.deps);
  assert.equal(r.status, 'needs-code');
  assert.equal(w.typed, 1);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /verification code/);
  assert.match(w.told[0].text, /will not try to get around it/);
  w.i = 0;
  assert.equal((await A.attempt({ mac: 'mini' }, w.deps)).status, 'no-dialog');
  assert.equal(w.typed, 1, 'no second try');
});

test('a password the prompt still asks for is not retried', async () => {
  const w = world({ seq: [PROMPT, PROMPT] });
  assert.equal((await A.attempt({ mac: 'mini' }, w.deps)).status, 'rejected');
  assert.equal((await A.attempt({ mac: 'mini' }, w.deps)).status, 'no-dialog');
  assert.equal(w.typed, 1);
  assert.equal(w.told.length, 1);
  const bad = world({ seq: [screen(['To set up iCloud, enter the password for “a”', 'The password is incorrect. Try again.'], [FIELD])] });
  assert.equal((await A.attempt({ mac: 'mini' }, bad.deps)).status, 'rejected');
  assert.equal(bad.typed, 0, 'a prompt already rejecting a password gets nothing');
});

test('someone at the Mac waits, with no stop and no message; a missing secret is told once and types nothing', async () => {
  const p = world({ person: true });
  assert.equal((await A.attempt({ mac: 'mini' }, p.deps)).status, 'waiting');
  assert.deepEqual([p.told.length, p.state.stopped_boot], [0, undefined]);
  const m = world({ hasSecret: false });
  assert.equal((await A.attempt({ mac: 'mini' }, m.deps)).status, 'failed');
  await A.attempt({ mac: 'mini' }, m.deps);
  assert.equal(m.typed, 0);
  assert.equal(m.told.length, 1);
  assert.match(m.told[0].text, /housesitter secret <mac> apple-account/);
});

test('the window: 30 minutes after a boot that a marker came before; --now ignores it; a stopped boot stays stopped', () => {
  const ok = (o) => A.decide({ now: BOOT + 60000, bootAt: BOOT, marker: MARKER, ...o }).ok;
  assert.equal(ok({}), true);
  assert.equal(ok({ now: BOOT + 30 * 60000 }), true);
  assert.equal(ok({ now: BOOT + 30 * 60000 + 1 }), false);
  assert.equal(ok({ bootAt: null }), false);
  assert.equal(ok({ bootAt: null, explicit: true }), true);
  assert.equal(ok({ state: { stopped_boot: BOOT } }), false);
  assert.equal(ok({ state: { stopped_boot: BOOT }, explicit: true }), true);
  assert.equal(A.parseBoot('{ sec = 1794772854, usec = 700772 } Sun Nov 15 12:00:54 2026'), 1794772854000);
});

test('hackamore gets the rule, merged into its config without losing anything and without a plain entry for the item', () => {
  const file = path.join(tmp(), 'hackamore', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ clients: ['x'], secrets: ['other', 'mini-apple-account'], secret_rules: [{ item: 'kept', app: 'a', text: 'b' }, { item: 'mini-apple-account', app: 'old', text: 'old' }] }));
  const r = A.installRule('mini', { file });
  assert.equal(r.changed, true);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.clients, ['x']);
  assert.deepEqual(cfg.secrets, ['other']);
  assert.deepEqual(cfg.secret_rules.map((x) => x.item), ['kept', 'mini-apple-account']);
  assert.deepEqual(cfg.secret_rules[1], A.hackamoreRule('mini'));
  assert.equal(A.installRule('mini', { file }).changed, false, 'again: nothing changes');
  const fresh = path.join(tmp(), 'new', 'config.json');
  A.installRule('mini', { file: fresh });
  assert.equal(JSON.parse(fs.readFileSync(fresh, 'utf8')).secret_rules.length, 1);
});

test('housesitter secret mini apple-account writes the one Keychain item hackamore reads: service housesitter, account mini-apple-account', () => {
  assert.equal(A.appleRef('mini'), 'keychain:housesitter/mini-apple-account');
  assert.deepEqual(parseRef(A.appleRef('mini')), { kind: 'keychain', service: 'housesitter', account: 'mini-apple-account' });
  const rule = A.hackamoreRule('mini');
  assert.deepEqual([rule.service, rule.account], ['housesitter', 'mini-apple-account']);
  const seen = [];
  secretStore({ run: (f, args, o) => { seen.push({ f, args, input: o?.input }); return { status: 0, stdout: '', stderr: '' }; } }).set(A.appleRef('mini'), FAKE);
  assert.deepEqual(seen[0].args, ['-i']);
  assert.equal(seen[0].input, `add-generic-password -U -s "housesitter" -a "mini-apple-account" -w "${FAKE}"\n`, 'the value goes on stdin, never in argv');
});

test('on the Mac: existence is checked without reading the value, and state, audit and the one-time telling live in the cache folder', async () => {
  const home = tmp();
  const runs = [];
  const run = (f, a) => { runs.push([f, ...a]); return { status: 0, stdout: f.endsWith('sysctl') ? '{ sec = 1794772854, usec = 1 }' : f.endsWith('pgrep') ? '4321\n' : '', stderr: '' }; };
  const sent = [];
  const d = A.realDeps({ hk: async () => ({ code: 0, json: null }), home, run, tell: async (t) => { sent.push(t); return true; } });
  assert.equal(d.hasSecret('keychain:housesitter/mini-apple-account'), true);
  assert.ok(!runs.some((r) => r.includes('-w')), 'the Keychain is asked whether the item exists, not for its value');
  assert.equal(d.bootAt(), 1794772854000);
  assert.equal(await d.pid('Setup Assistant'), 4321);
  A.expectReboot({ why: 'the update reboot', now: 5, home });
  assert.deepEqual(d.marker(), { at: 5, why: 'the update reboot' });
  await d.tell({ id: 'a', text: 'once' });
  await d.tell({ id: 'a', text: 'once' });
  assert.deepEqual(sent, ['once']);
  const failing = A.realDeps({ hk: null, home: tmp(), run, tell: async () => false });
  await failing.tell({ id: 'b', text: 'x' });
  await failing.tell({ id: 'b', text: 'x' });
  d.audit({ at: 'now', event: 'filled', mac: 'mini' });
  assert.equal(A.readStatus({ home }).audit[0].event, 'filled');
});

test('the launchd agent runs the watcher at login and keeps it running', () => {
  const t = A.agentPlist({ node: '/n/node', bin: '/b/housesitter.mjs', mac: 'mini', env: { HOME: '/h' }, log: '/l' });
  assert.match(t, /bot\.ouro\.housesitter\.apple-account/);
  assert.match(t, /<string>apple-account<\/string>\s*<string>mini<\/string>\s*<string>--watch<\/string>/);
  assert.match(t, /<key>KeepAlive<\/key><true\/>/);
});
