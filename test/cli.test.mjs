// The CLI, the Reins layer, the demo and the config, end to end without hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../src/reins.mjs';
import { night } from '../src/demo.mjs';
import { parseRef, secretStore, macConfig } from '../src/config.mjs';
import { sitterClient, describeStatus } from '../src/sitter.mjs';

const BIN = fileURLToPath(new URL('../bin/housesitter.mjs', import.meta.url));
const scratchRoot = path.join(fileURLToPath(new URL('..', import.meta.url)), '.scratch');
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'cli-'));
const cli = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, HOUSESITTER_CONFIG: path.join(scratch, 'config.json'), ...env } });

test('demo: two incidents fixed by itself, one message for the one it could not fix', async () => {
  const { incidents, world } = await night();
  assert.deepEqual(incidents.map((i) => i.fixed), [true, true, false]);
  assert.equal(world.st.unlocked, 2);
  const r = cli(['demo', '--json']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).rehearsal, true);
});

test('CLI: help, adopt --fake, and refusal exit codes', () => {
  assert.match(cli(['help']).stdout, /housesitter demo/);
  const a = cli(['adopt', 'studio', '--fake', '--json']);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout).fake, true);
  const u = cli(['status', 'nowhere', '--json']);
  assert.equal(u.status, 2);
  assert.equal(JSON.parse(u.stdout).code, 'input-invalid');
  assert.equal(cli(['frobnicate', 'x']).status, 2);
});

test('Reins: only what is possible now; inputs validated with a JSON path', async () => {
  const kvm = { video: { online: true }, hid: { keyboard_online: true } };
  const healthy = R.screen('studio', { kvm, sitter: { state: 'healthy', can: { unlock: true, plug: true } } });
  const names = healthy.actions.map((a) => a.name);
  assert.ok(names.includes('left_click') && names.includes('power_cycle') && !names.includes('unlock'));
  const fv = R.screen('studio', { kvm, sitter: { state: 'filevault', can: { unlock: true } } });
  assert.ok(fv.actions.some((a) => a.name === 'unlock'));
  await assert.rejects(R.run('studio', 'unlock', {}, { scr: healthy }), (e) => e.code === 'action-unavailable' && e.available.includes('screenshot'));
  await assert.rejects(R.run('studio', 'left_click', { coordinate: [1] }, { scr: healthy }), (e) => e.code === 'input-invalid' && e.path === '$.coordinate');
  const sitter = { op: async (op) => ({ ok: true, result: `did ${op}`, via: 'ssh kvm' }) };
  assert.equal((await R.run('studio', 'unlock', {}, { scr: fv, sitter })).result, 'did unlock');
});

test('config: secret references, never values', () => {
  assert.deepEqual(parseRef('keychain:housesitter/studio-mac'), { kind: 'keychain', service: 'housesitter', account: 'studio-mac' });
  assert.throws(() => parseRef('hunter2'), /not a secret reference/);
  const f = path.join(scratch, 'pw');
  fs.writeFileSync(f, 'from-a-file\n');
  const s = secretStore({ env: { PW: 'from-env' } });
  assert.equal(s.get('env:PW'), 'from-env');
  assert.equal(s.get(`file:${f}`), 'from-a-file');
  assert.equal(s.get('env:NOPE'), null);
  assert.throws(() => macConfig('ghost', { macs: { studio: {} } }), /known: studio/);
});

test('sitter client: SSH first, the outbox when SSH times out, and a readable status', async () => {
  const calls = [];
  const mac = { name: 'studio', kvm: { endpoints: [{ url: 'https://kvm.local' }] }, outbox: { gist: 'g', inbox: 'i' } };
  const ssh = async (cmd) => { calls.push(cmd); return { status: 0, stdout: JSON.stringify({ ok: true, result: 'typed the password at the filevault prompt (slow mode)' }) }; };
  const c = sitterClient(mac, { deps: { ssh, gh: { get: async () => ({ body: {} }), put: async () => ({}) }, secrets: { get: () => null } } });
  assert.deepEqual(c.routes.map((r) => r.via), ['ssh kvm.local', 'outbox (GitHub)']);
  const r = await c.op('unlock');
  assert.ok(r.ok);
  assert.match(calls[0], /sitter\.py do unlock '\{\}'/);
  assert.match(describeStatus('studio', { state: 'healthy', at: Date.now(), obs: { video: true }, can: { unlock: true } }), /studio is healthy/);
});
