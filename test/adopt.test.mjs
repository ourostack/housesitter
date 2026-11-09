// Arrival day against a pretend KVM: every step, and where each secret goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adopt, defaultRefs, fakeDeps, newPassword, parseIfconfig } from '../src/adopt.mjs';

const run = async (opts = {}, extra = {}, flags = { notify: 'ntfy' }) => {
  const f = fakeDeps(opts);
  const lines = [];
  const x = { name: 'studio', mac: { name: 'studio', kvm: { endpoints: [] }, user_names: ['Ada'], ...extra }, refs: defaultRefs('studio'), address: null, dryRun: false, outbox: false, say: (t) => lines.push(t), deps: f.deps, ...flags };
  const results = await adopt(x);
  return { f, x, results, lines };
};

test('a new KVM: password set, API checked, sitter installed, secrets sealed on it, never in a command line', async () => {
  const { f, results } = await run({ apiClosed: false });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  assert.equal(f.s.firstRun, 0, 'an open API needs no first-run page');
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

test('where it messages you: --notify ntfy makes a private topic, the sitter says hello once, and the start reports it', async () => {
  const { f, results } = await run({}, {}, { notify: 'ntfy', watchedBy: 'https://hc-ping.com/abc' });
  assert.match(f.s.saved.notify.url, /^https:\/\/ntfy\.sh\/housesitter-studio-[0-9a-f]{18}$/);
  assert.equal(f.s.saved.notify.kind, 'ntfy');
  assert.equal(f.s.saved.watched_by.url, 'https://hc-ping.com/abc');
  const cfg = JSON.parse(f.s.files['/etc/kvmd/user/housesitter/config.json']);
  assert.equal(cfg.notify.url, f.s.saved.notify.url);
  assert.equal(cfg.watched_by.url, 'https://hc-ping.com/abc');
  assert.equal(f.s.hello, 1);
  const old = await run({}, {}, { notify: 'ntfy', heartbeat: 'https://hc-ping.com/abc' });
  assert.equal(JSON.parse(old.f.s.files['/etc/kvmd/user/housesitter/config.json']).watched_by.url, 'https://hc-ping.com/abc', '--heartbeat, the 0.2 name, still works');
  assert.match(results.find((r) => r.id === 'start').detail, /it can notify;.*sent you a hello/);
});

test('nowhere to message you: adopt says so and how to fix it, and never claims it can notify', async () => {
  const { f, results } = await run({}, {}, {});
  const step = results.find((r) => r.id === 'notify');
  assert.equal(step.ok, false);
  assert.equal(step.decision, true);
  assert.match(step.detail, /--notify ntfy/);
  assert.doesNotMatch(results.find((r) => r.id === 'start').detail, /notify|hello/);
  assert.equal(f.s.hello, undefined);
});

test('a webhook that is not https is refused before anything is installed', async () => {
  const { results } = await run({}, {}, { notify: 'http://example.com/hook' });
  assert.equal(results.at(-1).id, 'notify');
  assert.equal(results.at(-1).ok, false);
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

test('a fingerprint read on the KVM itself must match, or adopt stops before sending anything', async () => {
  const { results, f } = await run({}, {}, { notify: 'ntfy', expectFingerprint: 'AA:BB' });
  assert.equal(results.at(-1).id, 'discover');
  assert.equal(results.at(-1).ok, false);
  assert.equal(f.s.ssh.length, 0);
  const good = await run({}, {}, { notify: 'ntfy', expectFingerprint: (fakeDeps().world.pin) });
  assert.match(good.results[0].detail, /the one you read on the KVM itself/);
});

test('harden must succeed (GL cloud read back as off), or adopt stops', async () => {
  const f = fakeDeps();
  f.s.hardenFails = true;
  const x = { name: 'studio', mac: { name: 'studio', kvm: { endpoints: [] }, user_names: ['Ada'] }, refs: defaultRefs('studio'), say: () => {}, deps: f.deps, notify: 'ntfy' };
  const r = await adopt(x);
  assert.equal(r.at(-1).id, 'harden');
  assert.equal(r.at(-1).ok, false);
  assert.match(r.at(-1).detail, /not hardened/);
  assert.ok(r.findIndex((s) => s.id === 'tailnet') < r.findIndex((s) => s.id === 'harden'), 'the tailnet is joined before ingress can be narrowed to it');
});

test('location: away makes the sitter tailnet-only; anything but home or away is refused', async () => {
  const away = await run({}, {}, { notify: 'ntfy', location: 'away' });
  assert.equal(JSON.parse(away.f.s.files['/etc/kvmd/user/housesitter/config.json']).location, 'away');
  assert.equal(away.f.s.saved.location, 'away');
  const home = await run({}, {}, { notify: 'ntfy' });
  assert.equal(JSON.parse(home.f.s.files['/etc/kvmd/user/housesitter/config.json']).location, 'home');
  assert.equal(away.results.find((r) => r.id === 'harden').ok, false, 'away without a joined tailnet: harden refuses rather than lock you out');
  assert.match(away.results.find((r) => r.id === 'harden').detail, /hasn't joined a running tailnet/);
  const bad = await run({}, {}, { notify: 'ntfy', location: 'office' });
  assert.equal(bad.results.at(-1).ok, false);
});

const adoptWith = async (prep, flags = { notify: 'ntfy' }, extra = {}) => {
  const f = fakeDeps();
  prep?.(f);
  const x = { name: 'studio', mac: { name: 'studio', kvm: { endpoints: [] }, user_names: ['Ada'], ...extra }, refs: defaultRefs('studio'), say: () => {}, deps: f.deps, ...flags };
  return { f, results: await adopt(x) };
};
const sitterConfig = (f) => JSON.parse(f.s.files['/etc/kvmd/user/housesitter/config.json']);

test('a re-adopt from another machine keeps the Mac addresses the sitter already has (fleet-tooling, 2026-11-09)', async () => {
  const { f, results } = await adoptWith((g) => { g.s.files['/etc/kvmd/user/housesitter/config.json'] = JSON.stringify({ mac_ips: ['192.168.50.37'], mac_macs: ['aa:bb:cc:dd:ee:ff'] }); });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  assert.deepEqual(sitterConfig(f).mac_ips, ['192.168.50.37']);
  assert.deepEqual(sitterConfig(f).mac_macs, ['aa:bb:cc:dd:ee:ff']);
  assert.match(results.find((r) => r.id === 'sitter').detail, /192\.168\.50\.37 \(kept from its config\)/);
});

test('--this-mac addresses replace the old ones; a first adopt with none writes none', async () => {
  const fresh = await adoptWith();
  assert.deepEqual(sitterConfig(fresh.f).mac_ips, []);
  const ifc = 'en0: flags=8863<UP>\n\tether 11:22:33:44:55:66\n\tinet 192.168.50.99 netmask 0xffffff00 broadcast 192.168.50.255\n';
  const { f } = await adoptWith((g) => { g.s.files['/etc/kvmd/user/housesitter/config.json'] = JSON.stringify({ mac_ips: ['192.168.50.37'], mac_macs: [] }); }, { notify: 'ntfy', macIfconfig: ifc });
  assert.deepEqual(sitterConfig(f).mac_ips, parseIfconfig(ifc).ips);
});

test('--email: ntfy forwards each message to one address, from an account token sealed on the sitter', async () => {
  const { f, results } = await adoptWith((g) => g.deps.secrets.set('keychain:housesitter/studio-ntfy-token', 'tk_fake'), { notify: 'ntfy', email: 'ada@example.com' });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  assert.equal(f.s.saved.notify.email, 'ada@example.com');
  assert.equal(sitterConfig(f).notify.email, 'ada@example.com');
  assert.equal(sitterConfig(f).notify.token, undefined, 'the keychain reference stays on this machine');
  assert.equal(f.s.secretsOnKvm.ntfy, 'tk_fake');
  assert.match(results.find((r) => r.id === 'notify').detail, /email to ada@example\.com \(at most 5 a day/);
  for (const c of f.s.ssh) assert.ok(!c.includes('tk_fake'), `token in argv: ${c}`);
});

test('--email without a token says how to get one; two addresses or a webhook are refused', async () => {
  const none = await adoptWith(null, { notify: 'ntfy', email: 'ada@example.com' });
  const step = none.results.find((r) => r.id === 'ntfy-token');
  assert.equal(step.ok, false);
  assert.match(step.detail, /verified ada@example\.com.*housesitter secret studio ntfy-token/);
  const two = await adoptWith(null, { notify: 'ntfy', email: 'a@example.com,b@example.com' });
  assert.match(two.results.at(-1).detail, /one address/);
  const hook = await adoptWith(null, { notify: 'https://example.com/hook', email: 'a@example.com' });
  assert.match(hook.results.at(-1).detail, /works through ntfy/);
});
