// The command table and the dispatcher must name the same commands, and help, `help --json` and unknown commands come
// from the kit: pure JSON on stdout, exit codes from the table, no voice line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
  assert.deepEqual([...dispatched].sort(), [...COMMAND_WORDS].sort());
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

