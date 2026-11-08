// Arrival day against a pretend KVM: every step, and where each secret goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adopt, defaultRefs, fakeDeps, newPassword, parseIfconfig } from '../src/adopt.mjs';

const run = async (opts = {}, extra = {}) => {
  const f = fakeDeps(opts);
  const lines = [];
  const x = { name: 'studio', mac: { name: 'studio', kvm: { endpoints: [] }, user_names: ['Ada'], ...extra }, refs: defaultRefs('studio'), address: null, dryRun: false, outbox: false, say: (t) => lines.push(t), deps: f.deps };
  const results = await adopt(x);
  return { f, x, results, lines };
};

test('a new KVM: password set, API checked, sitter installed, secrets sealed on it, never in a command line', async () => {
  const { f, results } = await run();
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  assert.equal(f.world.st.otg.start_cdrom, false, 'virtual media off');
  assert.deepEqual(Object.keys(f.s.secretsOnKvm).sort(), ['kvmd', 'mac']);
  assert.equal(f.s.secretsOnKvm.mac, 'correct horse');
  for (const c of f.s.ssh) assert.ok(!c.includes('correct horse') && !c.includes(f.world.st.adminPassword), `secret in argv: ${c}`);
  assert.equal(f.s.saved.kvm.tls_sha256, f.world.pin);
  assert.equal(f.s.saved.mac_password, 'keychain:housesitter/studio-mac-password');
  assert.ok(f.s.files['/etc/init.d/S99housesitter'] != null, 'BusyBox init script installed');
});

test('GL.iNet with its REST API shipped off: one first-run page, then the API is turned on over SSH', async () => {
  const { f, results } = await run({ apiClosed: true });
  assert.equal(f.s.firstRun, 1);
  assert.ok(results.find((r) => r.id === 'open-api').ok);
  assert.equal(f.world.st.apiClosed, false);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
});

test('no Mac password stored: adopt says how to store it and does not pretend', async () => {
  const f = fakeDeps();
  const r = await adopt({ name: 'studio', mac: { name: 'studio', kvm: {}, mac_password: 'keychain:nowhere' }, refs: defaultRefs('studio'), say: () => {}, deps: f.deps });
  const step = r.find((s) => s.id === 'mac-password');
  assert.equal(step.ok, false);
  assert.match(step.detail, /housesitter secret studio mac-password/);
});

test('dry run changes nothing', async () => {
  const f = fakeDeps();
  await adopt({ name: 'studio', mac: { name: 'studio', kvm: {} }, refs: defaultRefs('studio'), dryRun: true, say: () => {}, deps: f.deps });
  assert.equal(f.world.st.inited, false);
  assert.equal(f.s.ssh.length, 0);
});

test('passwords and network parsing', () => {
  const p = newPassword();
  assert.ok(p.length >= 20 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /^[A-Za-z]/.test(p));
  const n = parseIfconfig('lo0: flags\n\tinet 127.0.0.1\nen0: flags\n\tether aa:bb:cc:dd:ee:ff\n\tinet 192.168.1.10 netmask\nutun3: flags\n\tinet 100.64.0.2\n');
  assert.deepEqual(n, { ips: ['192.168.1.10'], macs: ['aa:bb:cc:dd:ee:ff'] });
});
