// `housesitter secret <mac> <name> [--kvm]`: named secrets, from this Mac's Keychain to the KVM over SSH stdin, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeSecretDeps, sealOnKvm, secretTarget } from '../src/secrets.mjs';

const BIN = fileURLToPath(new URL('../bin/housesitter.mjs', import.meta.url));
const scratchRoot = path.join(fileURLToPath(new URL('..', import.meta.url)), '.scratch');
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'secrets-'));
const cli = (args, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input, env: { ...process.env, HOUSESITTER_CONFIG: path.join(scratch, 'config.json') } });
const onSitter = (a) => `python3 /etc/kvmd/user/housesitter/sitter.py ${a}`;

test('names: the known kinds keep their Keychain items, any other well-formed name gets its own, the sitter\'s own names are refused', () => {
  assert.deepEqual(secretTarget('mini', 'kvm-admin'), { ref: 'keychain:housesitter/mini-kvm-admin', kvmName: 'kvmd', kind: 'kvm-admin' });
  assert.equal(secretTarget('mini', 'mac-password', { mac_password: 'keychain:x/y' }).ref, 'keychain:x/y');
  assert.deepEqual(secretTarget('mini', 'setup-password'), { ref: 'keychain:housesitter/mini-setup-password', kvmName: 'setup-password', kind: 'named' });
  for (const bad of ['Setup', 'setup_password', '1password', 'a'.repeat(33), '../mac', '']) assert.throws(() => secretTarget('mini', bad), (e) => e.code === 'input-invalid', bad);
  assert.throws(() => secretTarget('mini', 'mac'), /housesitter secret mini mac-password/);
  assert.throws(() => secretTarget('mini', 'plug'), /housesitter plug mini adopt/);
});

test('--kvm: the Keychain\'s copy goes on SSH stdin, never in the command line; a missing item fails with the exact fix', async () => {
  const value = 'synthetic-setup-value';
  const f = fakeSecretDeps({ 'keychain:housesitter/mini-setup-password': value });
  const cmds = [];
  const ssh = async (cmd, input) => { cmds.push(cmd); return f.ssh(cmd, input); };
  const r = await sealOnKvm({ name: 'mini', which: 'setup-password', target: secretTarget('mini', 'setup-password'), store: f.store, ssh, onSitter });
  assert.deepEqual(r, { stored: 'setup-password', bound_to: 'hardware' });
  assert.equal(f.sealed['setup-password'], value);
  assert.deepEqual(cmds, ['python3 /etc/kvmd/user/housesitter/sitter.py store-secret setup-password']);
  await assert.rejects(sealOnKvm({ name: 'mini', which: 'apple-account', target: secretTarget('mini', 'apple-account'), store: f.store, ssh, onSitter }),
    (e) => e.code === 'action-unavailable' && /no apple-account for mini in this Mac's Keychain \(keychain:housesitter\/.*\)\. Fix: housesitter secret mini apple-account --kvm/.test(e.message));
  await assert.rejects(sealOnKvm({ name: 'mini', which: 'setup-password', target: secretTarget('mini', 'setup-password'), store: f.store, ssh: async () => ({ status: 2, stdout: '', stderr: 'store-secret: refusing: empty, too long, or more than one line' }), onSitter }),
    (e) => e.code === 'action-failed' && /did not seal setup-password: store-secret: refusing/.test(e.message));
});

test('CLI rehearsal (--fake): stored and sealed with the value nowhere in the output; nothing in the Keychain is a refusal with the fix', () => {
  const ok = cli(['secret', 'mini', 'setup-password', '--kvm', '--fake'], 'synthetic-setup-value\n');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /REHEARSAL/);
  assert.match(ok.stdout, /stored at keychain:housesitter\/mini-setup-password/);
  assert.match(ok.stdout, /sealed on mini's KVM as setup-password/);
  assert.doesNotMatch(ok.stdout + ok.stderr, /synthetic-setup-value/);
  const missing = cli(['secret', 'mini', 'setup-password', '--kvm', '--fake'], '');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /no setup-password for mini in this Mac's Keychain .*Fix: housesitter secret mini setup-password --kvm/);
  const bad = cli(['secret', 'mini', 'Setup_Password', '--fake'], 'x\n');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /not a secret's name/);
});
