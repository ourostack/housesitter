// `housesitter doctor` and `housesitter demo`: what they say, from a sitter's status and from the real evening's frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDoctor, renderDoctor } from '../src/doctor.mjs';
import { loadEvening, renderEvening, replay } from '../src/evening.mjs';
import { glimpse, painter, width } from '../src/paint.mjs';
import { promptMatch } from '../src/frames.mjs';

const NOW = Date.UTC(2026, 10, 9, 2, 31);
const KVM = { model: 'GL.iNet Comet (GLKVM)', version: '4.82', via: 'home LAN (fallback)', video: { online: true, resolution: '2560x1440' }, hid: { keyboard_online: true } };
const status = (over = {}) => ({
  v: 1, sitter: '0.1.0', at: NOW - 9000, state: 'healthy', since: NOW - 120000, interval_sec: 60, password: 'verified',
  obs: { screen: 'desktop', eyes: 'frame', answers: true, clock_ticking: true }, can: { plug: true }, secrets: { mac: true },
  prompt: { taught: 1, match: 0, visible: false }, budgets: { unlock_since_desktop: [0, 2], unlock_hour: [1, 3], unlock_hour_frees_at: NOW + 600000, cycles_day: [0, 3], blocked: null },
  glimpse: { w: 2, h: 2, rgb: Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]).toString('base64') }, recent: [], last_incident: null, ...over,
});
const plain = (m) => renderDoctor(m, { color: false, now: NOW });

test('doctor: a healthy, set-up Mac has nothing to do', () => {
  const m = buildDoctor({ name: 'mini', mac: { notify: { kind: 'ntfy' }, heartbeat: { url: 'x' }, kvm: { tls_sha256: 'AA' } }, kvm: KVM, sit: { via: 'ssh kvm', status: status() }, now: NOW });
  const out = plain(m);
  assert.equal(m.todo.length, 0);
  assert.doesNotMatch(out, /\x1b\[/);
  assert.match(out, /next look\s+in 51 s/);
  for (const s of ['THE SCREEN', 'a desktop (from a decoded frame)', 'up, at its desktop for at least 2 min', 'GL.iNet Comet (GLKVM) · kvmd 4.82 · via home LAN', 'verified: our one supervised try reached the desktop', '2 of 3 left this hour', '2 of 2 tries left before it stops', '3 of 3 cycles left today', 'none seen by this sitter yet']) assert.ok(out.includes(s), `${s}\n${out}`);
  assert.doesNotMatch(out, /fallback/);
});

test('doctor: says what is missing, and the command that fixes it', () => {
  const m = buildDoctor({ name: 'mini', mac: { kvm: {} }, kvm: KVM, sit: { status: status({ password: 'unverified', secrets: { mac: true }, can: {}, prompt: { taught: 0, match: 0, visible: false } }) }, now: NOW });
  const cmds = m.todo.map((t) => t.cmd);
  assert.deepEqual(cmds, ['housesitter unlock mini --trial', 'housesitter learn-prompt mini --i-see-the-field --filevault', 'housesitter adopt mini --notify ntfy', 'housesitter adopt mini --heartbeat <url>']);
  const out = plain(m);
  assert.match(out, /unverified, so never typed/);
  assert.match(out, /no plug: a frozen Mac is reported, never cycled/);
  assert.match(out, /its certificate is not pinned/);
  assert.match(out, /4 THINGS TO DO/);
  assert.match(out, /nothing outside watches the KVM: if it dies, nobody hears/);
});

test('doctor: honest timers and unreachable parts', () => {
  const late = plain(buildDoctor({ name: 'mini', kvm: { error: 'no KVM endpoint answered' }, sit: { status: status({ at: NOW - 400000 }) }, now: NOW }));
  assert.match(late, /LATE: is the sitter running\?/);
  assert.doesNotMatch(late, /next look/);
  assert.match(late, /not reached: no KVM endpoint answered/);
  const none = plain(buildDoctor({ name: 'mini', kvm: KVM, sit: { errors: ['ssh: no route'] }, now: NOW }));
  assert.match(none, /no word from its sitter \(ssh: no route\)/);
  assert.match(none, /no picture yet/);
});

test('doctor: an open incident, the last one, and a stopped budget', () => {
  const out = plain(buildDoctor({ name: 'mini', kvm: KVM, sit: { status: status({ state: 'filevault', incident: { started: NOW - 300000, notified_at: NOW - 200000 }, last_incident: { started: NOW - 86400000, ended: NOW - 86000000, actions: ['unlock'], told_you: false }, budgets: { unlock_since_desktop: [2, 2], unlock_hour: [2, 3], cycles_day: [0, 3], blocked: '2 tries since the Mac was last at its desktop, so it stops' } }) }, now: NOW }));
  assert.match(out, /at the FileVault or login screen/);
  assert.match(out, /open since .* \(5 min\), and it told you/);
  assert.match(out, /unlock; nobody was woken/);
  assert.match(out, /stopped: 2 tries since the Mac was last at its desktop/);
});

test('glimpse: two pixels to a character in colour, shades without', () => {
  const g = { w: 2, h: 2, rgb: Buffer.from([255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0]).toString('base64') };
  const c = glimpse(painter(true), g);
  assert.match(c[1], /38;2;255;0;0m\x1b\[48;2;255;255;255m▀/);
  const p = glimpse(painter(false), g);
  assert.equal(p.length, 3);
  assert.equal(width(p[1]), 4);
});

test('demo: the real evening, read by the same rules as the sitter', () => {
  const steps = replay();
  assert.deepEqual(steps.slice(0, 5).map((s) => [s.at, s.kind, s.seen.visible]), [['10:32', 'prompt_like', false], ['17:59', 'desktop', false], ['18:07', 'prompt_like', true], ['18:07', 'prompt_like', true], ['18:15', 'desktop', false]]);
  assert.equal(steps[5].key, 'restart');
  assert.equal(steps[2].seen.match, 1);
  assert.ok(steps[3].seen.match >= 0.9 && steps[3].seen.match < 1);
  const text = renderEvening(steps).flat().join('\n');
  assert.match(text, /won't type: no password field on its[\s\S]{0,80}picture/);
  assert.match(text, /the prompt it was taught: 100%,[\s\S]{0,80}then 9[0-9]% as the wallpaper moved/);
  assert.match(text, /18:32:37  typed the password, once/);
  assert.match(text, /a desktop, not shown/);
  assert.doesNotMatch(text, /\x1b\[/);
});

test('demo: Node and the sitter read the evening\'s frames alike', () => {
  const e = loadEvening();
  const py = `
import base64, json, sys
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../device', import.meta.url)))})
import sitter as S
e = json.load(open(${JSON.stringify(fileURLToPath(new URL('../assets/evening.json', import.meta.url)))}))
out = []
for f in e["frames"]:
    ff = {"mean": f["mean"], "top_edges": f["top_edges"], "_lum": base64.b64decode(f["lum"]) if f.get("lum") else None}
    out.append([S.classify_frame(ff), round(S.prompt_match(e["prompt_points"], ff), 3)])
print(json.dumps(out))`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const node = replay(e).map((s) => [s.kind, s.kind === 'prompt_like' ? s.seen.match : 0]);
  const pyOut = JSON.parse(r.stdout).map(([k, m]) => [k, k === 'prompt_like' ? m : 0]);
  assert.deepEqual(node, pyOut);
});

test('the prompt matcher is two-sided: a frame bright everywhere never matches', () => {
  const e = loadEvening();
  const n = e.frames.find((f) => f.lum).lum.length;
  for (const v of [255, 200, 128]) assert.equal(promptMatch(e.prompt_points, Buffer.alloc(n, v)), 0);
});

test('--private keeps email addresses out of a screenshot', async () => {
  const { maskEmails } = await import('../src/doctor.mjs');
  assert.equal(maskEmails('ntfy and email to ada.lovelace@example.com; 23:30 notify: posted 200, emailed ada@example.com'), 'ntfy and email to a…@example.com; 23:30 notify: posted 200, emailed a…@example.com');
});

test('doctor: a heartbeat probe says how old the beat is, and never where it lives', () => {
  const url = 'https://gist.githubusercontent.com/someone/secret0123/raw/mini.json';
  const mac = { notify: { kind: 'ntfy' }, heartbeat: { url: 'x' }, kvm: { tls_sha256: 'AA' }, health: { kind: 'json_age', url, field: 'at' } };
  const fresh = plain(buildDoctor({ name: 'mini', mac, kvm: KVM, sit: { via: 'ssh kvm', status: status({ obs: { screen: 'desktop', eyes: 'frame', answers: true, clock_ticking: true, heartbeat_age_min: 0.4 }, probes: { health: true } }) }, now: NOW }));
  assert.match(fresh, /answers\s+yes: its heartbeat is 0.4 min old/);
  assert.doesNotMatch(fresh, /secret0123|gist/);
  const stale = plain(buildDoctor({ name: 'mini', mac, kvm: KVM, sit: { status: status({ obs: { screen: 'desktop', answers: false, clock_ticking: true, heartbeat_age_min: 9.1 }, probes: { health: true } }) }, now: NOW }));
  assert.match(stale, /answers\s+NO: its heartbeat is 9.1 min old/);
});

test('doctor: "at least" rounds down, and a restart unlocked by itself is the last incident when it is newer', async () => {
  const { age } = await import('../src/paint.mjs');
  assert.equal(age(92 * 60000), '1 h 32 min');
  assert.equal(age(89 * 60000 + 59000), '89 min');
  assert.equal(age(2 * 3600000), '2 h');
  const recent = [{ at: NOW - 3600000, kind: 'unlock', result: 'typed the password at the FileVault prompt it was taught (frame, password verified)' }, { at: NOW - 60000, kind: 'notify', result: 'posted 200', test: true }];
  const li = { started: NOW - 7200000, ended: NOW - 7140000, actions: ['unlock'], told_you: false };
  const out = plain(buildDoctor({ name: 'mini', mac: { notify: { kind: 'ntfy' }, heartbeat: { url: 'x' }, kvm: { tls_sha256: 'AA' } }, kvm: KVM, sit: { status: status({ recent, last_incident: li }) }, now: NOW }));
  assert.match(out, /LAST INCIDENT\s+● \d\d:\d\d: a restart's FileVault, unlocked by the sitter; nobody was woken/);
  assert.match(out, /RECENT\s+\d\d:\d\d\s+TEST alert: posted 200/);
  const older = plain(buildDoctor({ name: 'mini', mac: { notify: { kind: 'ntfy' }, heartbeat: { url: 'x' }, kvm: { tls_sha256: 'AA' } }, kvm: KVM, sit: { status: status({ recent: [], last_incident: li }) }, now: NOW }));
  assert.match(older, /LAST INCIDENT\s+● \d\d:\d\d to \d\d:\d\d: unlock; nobody was woken/);
});
