// The smart plug (src/plug.mjs), want_desktop in the Reins layer, and doctor's new lines, with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as Plug from '../src/plug.mjs';
import * as R from '../src/reins.mjs';
import { buildDoctor, renderDoctor } from '../src/doctor.mjs';
import { sshRunner } from '../src/sitter.mjs';

const DEVICE = fileURLToPath(new URL('../device', import.meta.url));

test('plug: the digest matches the sitter, and the password never travels', () => {
  const ch = 'Digest qop="auth", realm="shellyplugusg4-abc", nonce="60dc59c6", algorithm=SHA-256';
  const js = Plug.digestHeader(ch, 'POST', '/rpc', 's3cret', { cnonce: 'c0ffee', nc: 1 });
  const r = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(DEVICE)}); import sitter as S; print(S.shelly_digest(${JSON.stringify(ch)}, "POST", "/rpc", "s3cret", cnonce="c0ffee"))`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(js, r.stdout.trim());
  assert.doesNotMatch(js, /s3cret/);
});

test('plug: adopt sets every safe setting and reads each one back', async () => {
  const calls = [];
  const plug = { 'Switch.GetConfig': { initial_state: 'on', auto_off: false }, 'Cloud.GetConfig': { enable: false }, 'BLE.GetConfig': { enable: true, rpc: { enable: true } }, 'Shelly.GetDeviceInfo': { auth_en: true, mac: 'AABBCC001122' }, 'Switch.GetStatus': { output: true, apower: 9.4 } };
  const call = async (ip, m, p, o) => { calls.push([m, Boolean(o?.password)]); return plug[m] || {}; };
  const c = await Plug.configure('10.0.0.9', { id: 'shellyplugusg4-abc', auth_en: false }, 'pw', { call, name: 'mini-power' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(calls.slice(0, 5).map((x) => x[0]), ['Switch.SetConfig', 'Sys.SetConfig', 'Cloud.SetConfig', 'BLE.SetConfig', 'Shelly.SetAuth']);
  assert.equal(calls.slice(0, 5).some((x) => x[1]), false, 'no password before it has one');
  assert.ok(calls.slice(5).every((x) => x[1]), 'every readback with the new password');
  assert.equal(c.mac, 'AABBCC001122');
  plug['Cloud.GetConfig'] = { enable: true };
  const bad = await Plug.configure('10.0.0.9', { id: 'x', auth_en: true }, 'pw', { call });
  assert.equal(bad.ok, false);
  assert.equal(bad.checks['cloud off'], false);
});

test('plug: a plug DHCP moved is found again by its MAC', async () => {
  const call = async (host) => { if (host === '10.0.0.9') throw new Error('timeout'); return { output: true, apower: 3 }; };
  const findAll = async () => [{ ip: '10.0.0.5', mac: '000000000000' }, { ip: '10.0.0.42', mac: 'AABBCC001122' }];
  const r = await Plug.readPlug({ url: 'http://10.0.0.9', mac: 'aa:bb:cc:00:11:22' }, 'pw', { call, findAll });
  assert.deepEqual(r, { on: true, watts: 3, url: 'http://10.0.0.42', moved: true });
  await assert.rejects(Plug.readPlug({ url: 'http://10.0.0.9', mac: 'ff:ff:ff:ff:ff:ff' }, 'pw', { call, findAll }), /no Shelly with MAC/);
});

test('plug: handed to the sitter on stdin, never in a command line', async () => {
  const seen = [];
  const ssh = async (cmd, input) => { seen.push({ cmd, input }); return { status: 0, stdout: cmd.includes('plug-status') ? '{"ok": true, "on": true, "watts": 9.4, "url": "http://10.0.0.9"}\n' : '', stderr: '' }; };
  const r = await Plug.handToSitter({ kind: 'shelly', url: 'http://10.0.0.9', mac: 'AA', auth: true }, 'p@ss', ssh);
  assert.equal(r.on, true);
  assert.match(seen[0].cmd, /sitter\.py store-secret plug$/);
  assert.equal(seen[0].input, 'p@ss\n');
  assert.ok(seen.every((s) => !s.cmd.includes('p@ss')));
  assert.match(seen[1].cmd, /"power"/);
});

test('plug: prove cuts once, sees the boot and the desktop, and catches a KVM on the plug', async () => {
  const run = (kvmBootAfter) => {
    let t = 1_000_000;
    let n = 0;
    const ssh = async (cmd) => {
      if (cmd.includes('do power_cycle')) { assert.match(cmd, /"attended":true/); return { status: 0, stdout: '{"ok": true, "result": "plug: {}"}\n' }; }
      n++;
      const st = n === 1 ? { usb_seen: 100, kvm_boot: 'k1' } : n < 4 ? { usb_seen: 100, kvm_boot: 'k1' } : n < 8 ? { usb_seen: 160, pending: t, kvm_boot: kvmBootAfter } : { usb_seen: 160, desktop_at: t, kvm_boot: kvmBootAfter };
      return { status: 0, stdout: `${JSON.stringify(st)}\n` };
    };
    return Plug.prove({ ssh, sleep: async (ms) => { t += ms; }, now: () => t });
  };
  const ok = await run('k1');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(ok.boot_s > 0 && ok.desktop_s > ok.boot_s);
  const bad = await run('k2');
  assert.equal(bad.ok, false);
  assert.match(bad.why, /the KVM rebooted too/);
});

test('reins: want_desktop is offered only where the config allows lock screens', () => {
  const off = R.actionsFor({ kvm: null, sitter: { state: 'filevault', lock_policy: false, obs: { screen: 'login' }, can: {} } }).map((a) => a.name);
  const on = R.actionsFor({ kvm: null, sitter: { state: 'filevault', lock_policy: 'on_request', obs: { screen: 'login' }, can: {} } }).map((a) => a.name);
  const desk = R.actionsFor({ kvm: null, sitter: { state: 'healthy', lock_policy: 'on_request', obs: { screen: 'desktop' }, can: {} } }).map((a) => a.name);
  assert.ok(!off.includes('want_desktop'));
  assert.ok(on.includes('want_desktop'));
  assert.ok(!desk.includes('want_desktop'));
});

test('doctor: lessons, the lock-screen policy, the HDMI with no viewer, and what "up" means with no probe', () => {
  const now = 1_700_000_000_000;
  const st = { v: 1, at: now - 9000, state: 'healthy', since: now - 120000, interval_sec: 60, password: 'verified', secrets: { mac: true }, can: { plug: true }, obs: { screen: 'desktop', eyes: 'frame', clock_ticking: true, hdmi: '2560x1440', plug_on: true, watts: 14.2 },
    lessons: { boot: 1, lock: 1, grid: 1 }, lock_policy: 'on_request', desktop_wanted: true, probes: { health: false, heartbeat: false },
    budgets: { unlock_since_desktop: [0, 2], unlock_hour: [0, 3], unlock_test_hour: [4, 30], cycles_day: [0, 3], blocked: null } };
  const kvm = { model: 'GL.iNet Comet (GLKVM)', version: '4.82', via: 'home LAN', video: { online: null, resolution: null }, hid: { keyboard_online: true } };
  const m = buildDoctor({ name: 'mini', mac: { kvm: { tls_sha256: 'x' }, notify: { kind: 'ntfy' } }, kvm, sit: { status: st, via: 'ssh' }, now });
  const out = renderDoctor(m, { now });
  for (const s of ['taught: FileVault · lock screen · list of users', 'unlocks it when an agent asks (want-desktop); a request stands now', 'HDMI 2560×1440 (read by the sitter; no viewer open)',
    'no probe set: "up" is a desktop whose clock moves', '26 of 30 attended-test unlocks left this hour', 'plug on, 14.2 W']) assert.ok(out.includes(s), `${s}\n${out}`);
  assert.ok(!m.todo.some((t) => /learn-prompt/.test(t.cmd)));
});

test('ssh: banners and warnings stay out of the error a person reads (#12)', async () => {
  let got = null;
  const run = (bin, args) => { got = args; return { status: 0, stdout: '', stderr: '' }; };
  await sshRunner('mini', '192.168.50.14', { run, home: '/nowhere' })('true');
  assert.ok(got.join(' ').includes('LogLevel=ERROR'));
});
