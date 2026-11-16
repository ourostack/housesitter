// Keeping chosen launchd jobs off: a job whose disable was lost is disabled again, a running one is stopped by its PID,
// and nothing is changed by a dry run. launchctl and kill are fakes; no Mac is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acted, holdDisabled, renderHold } from '../src/hold.mjs';

const UID = 501;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'housesitter.mjs');

// `disabledList`: label => whether launchd lists it disabled; `jobs`: label => launchctl print text.
function fakeLaunchctl({ disabledList, jobs, failDisable = false }) {
  const calls = [];
  const run = (file, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'print-disabled') {
      const body = Object.entries(disabledList).map(([l, d]) => `\t"${l}" => ${d ? 'disabled' : 'enabled'}`).join('\n');
      return { status: 0, stdout: `disabled services = {\n${body}\n}\n`, stderr: '' };
    }
    if (args[0] === 'disable') return failDisable ? { status: 1, stdout: '', stderr: 'nope' } : { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') {
      const label = args[1].split('/').pop();
      return { status: jobs[label] ? 0 : 113, stdout: jobs[label] || '', stderr: '' };
    }
    throw new Error(`unexpected launchctl ${args.join(' ')}`);
  };
  return { calls, run };
}

const running = (pid) => `gui/${UID}/x = {\n\tstate = running\n\tpid = ${pid}\n}\n`;
const stopped = 'gui/501/x = {\n\tstate = not running\n}\n';

test('a job whose disable was lost is disabled again, and a running one is stopped by its PID', () => {
  const lc = fakeLaunchctl({ disabledList: { 'com.apple.mediaanalysisd': false, 'bot.ouro.other': true }, jobs: { 'com.apple.mediaanalysisd': running(4242) } });
  const killed = [];
  const rows = holdDisabled(['com.apple.mediaanalysisd'], { uid: UID, run: lc.run, kill: (pid) => killed.push(pid) });
  assert.deepEqual(rows, [{ label: 'com.apple.mediaanalysisd', disabled_again: true, stopped: true, pid: 4242 }]);
  assert.deepEqual(killed, [4242]);
  assert.ok(lc.calls.includes(`disable gui/${UID}/com.apple.mediaanalysisd`));
  assert.equal(renderHold(rows), 'com.apple.mediaanalysisd: disable it again (it had come back on) and stop it (pid 4242)');
});

test('an already-disabled, stopped job is left alone and reports nothing', () => {
  const lc = fakeLaunchctl({ disabledList: { 'bot.ouro.x': true }, jobs: { 'bot.ouro.x': stopped } });
  const killed = [];
  const rows = holdDisabled(['bot.ouro.x'], { uid: UID, run: lc.run, kill: (pid) => killed.push(pid) });
  assert.deepEqual(acted(rows), []);
  assert.deepEqual(killed, []);
  assert.ok(!lc.calls.some((c) => c.startsWith('disable ')));
});

test('a label that is not a launchd label is rejected without any launchctl call for it', () => {
  const lc = fakeLaunchctl({ disabledList: {}, jobs: {} });
  const rows = holdDisabled(['../etc', 'ok.label'], { uid: UID, run: lc.run, kill: () => {} });
  assert.deepEqual(rows[0], { label: '../etc', error: 'not a launchd label' });
  assert.ok(!lc.calls.some((c) => c.includes('../etc')));
});

test('a kill that fails is reported in the row, not thrown', () => {
  const lc = fakeLaunchctl({ disabledList: { 'bot.ouro.x': true }, jobs: { 'bot.ouro.x': running(77) } });
  const rows = holdDisabled(['bot.ouro.x'], {
    uid: UID,
    run: lc.run,
    kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
  });
  assert.deepEqual(rows, [{ label: 'bot.ouro.x', disabled_again: false, error: 'could not stop pid 77: EPERM' }]);
  assert.match(renderHold(rows), /✗ bot\.ouro\.x: could not stop pid 77: EPERM/);
});

test('a dry run changes nothing and says what it would do', () => {
  const lc = fakeLaunchctl({ disabledList: { 'bot.ouro.x': false }, jobs: { 'bot.ouro.x': running(9) } });
  const killed = [];
  const rows = holdDisabled(['bot.ouro.x'], { uid: UID, run: lc.run, kill: (pid) => killed.push(pid), dry: true });
  assert.deepEqual(killed, []);
  assert.ok(!lc.calls.some((c) => c.startsWith('disable ')));
  assert.match(renderHold(rows), /would disable it again.*would stop it \(pid 9\)/);
});

test('with no launchd_disabled list, hold does nothing and says so; --quiet says nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-hold-'));
  const env = { ...process.env, HOME: home, HOUSESITTER_CONFIG: path.join(home, 'config.json') };
  fs.writeFileSync(env.HOUSESITTER_CONFIG, JSON.stringify({ macs: {} }));
  const loud = spawnSync(process.execPath, [BIN, 'hold', '--why', 'test'], { encoding: 'utf8', env });
  assert.equal(loud.status, 0, loud.stderr);
  assert.match(loud.stdout, /no launchd_disabled list/);
  const quiet = spawnSync(process.execPath, [BIN, 'hold', '--quiet'], { encoding: 'utf8', env });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');
  fs.rmSync(home, { recursive: true, force: true });
});
