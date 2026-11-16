// The command table and the dispatcher must name the same commands, and help, `help --json` and unknown commands come
// from the kit: pure JSON on stdout, exit codes from the table, no voice line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_WORDS, isCommand } from '../src/cli-table.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/housesitter.mjs');
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('the dispatcher handles exactly the commands the table declares', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  const dispatched = new Set([...src.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]));
  for (const word of ['unlock', 'power-cycle', 'power-on']) dispatched.add(word);
  dispatched.delete('help');
  assert.deepEqual([...dispatched].sort(), [...new Set(COMMAND_WORDS.map((w) => w.split(' ')[0]))].sort());
});

test('help --json is the kit\'s: pure JSON that lists every command with its effect', () => {
  const r = run(['help', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const help = JSON.parse(r.stdout);
  assert.deepEqual(help.commands.map((c) => c.name).sort(), [...COMMAND_WORDS].sort());
  for (const c of help.commands) assert.ok(['private', 'others'].includes(c.effect), c.name);
  assert.deepEqual(help.exitCodes.map((e) => e.name), ['ok', 'error', 'usage', 'findings']);
});

test('an unknown command exits 2 with one line on stderr and nothing on stdout', () => {
  const r = run(['no-such-command']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /there is no command "no-such-command"/);
});

test('help and a command\'s own help go to the kit; a command word runs the dispatcher', () => {
  assert.equal(isCommand(['help', 'status']), false);
  assert.equal(isCommand(['status', '--help']), false);
  assert.equal(isCommand(['--json', 'help']), false);
  assert.equal(isCommand(['status', 'studio']), true);
  assert.equal(isCommand(['--address', '10.0.0.5', 'adopt']), true);
});


test('a peer link or a returning Mac names a Mac the config knows; an unknown one is refused with the known names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-mac-'));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ macs: { studio: {} } }));
  const env = { ...process.env, HOUSESITTER_CONFIG: config };
  const unknown = spawnSync(process.execPath, [BIN, 'peer', 'flush', 'nope', '--why', 'the person asked'], { encoding: 'utf8', env });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no Mac called "nope".*studio/);
  const missing = spawnSync(process.execPath, [BIN, 'laptop-arrival', '--why', 'the person asked'], { encoding: 'utf8', env });
  assert.equal(missing.status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2026-11-16: #98 made every acting command need --why, and every installed launchd job (heartbeat, health watch,
// plugin and OS updates, crash resume, the Apple Account watch, laptop arrival) began failing with "needs --why",
// so freeze and crash recovery stopped. A scheduled job the person installed, a read-only look and a dry run act for
// no one new, so they run without --why; an agent's own restart still needs one.
test('installed jobs, read-only looks and dry runs run without --why; an agent\'s restart still needs one', async () => {
  const { cli } = await import('../src/cli-table.mjs');
  const { parse } = await import('../lib/ouro-ui/registry/ouro/ax/command.ts');
  const { AGENTS } = await import('../src/recovery.mjs');
  const refusal = (argv) => { try { parse(cli, argv); return null; } catch (e) { return e.shape?.code ?? String(e); } };
  const needsWhy = (argv) => refusal(argv) === 'needs-why';
  const jobs = [
    ...Object.values(AGENTS).map((a) => a.args),
    ['restart-copilot', '--resume-only', '--watch', '--open-at-login'],
    ['restart-copilot', '--plugin-updates', '--quiet'],
    ['apple-account', 'mini', '--watch'],
    ['laptop-arrival', 'laptop', '--config', '/tmp/laptop-arrival.json', '--quiet'],
    ['peer', 'watch', 'mini', '--agent', 'ouroboros', '--every', '60', '--ouro', '/tmp/ouro'],
    ['peer', 'watch', 'mini', '--once'],
  ];
  for (const argv of jobs) assert.equal(refusal(argv), null, argv.join(' '));
  for (const argv of [['restart-copilot', '--status'], ['restart-copilot', '--dry-run'], ['restart-copilot', '--dry-run', '--list'], ['apple-account', 'mini', '--status'], ['laptop-arrival', 'mini', '--dry-run']]) assert.equal(needsWhy(argv), false, argv.join(' '));
  for (const argv of [['restart-copilot', '--resume'], ['restart-copilot'], ['apple-account', 'mini', '--now'], ['peer', 'send', 'hi'], ['click', 'mini', '1', '2']]) assert.equal(needsWhy(argv), true, argv.join(' '));
});
