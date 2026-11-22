import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fold, parseFreePct, parseSwapins, readMemory, renderMemory, sample } from '../src/memory-pressure.mjs';

const T = (s) => Date.parse(`${s}Z`);

test('parses memory_pressure and vm_stat output', () => {
  assert.equal(parseFreePct('The system has 17179869184 (4194304 pages)\nSystem-wide memory free percentage: 41%\n'), 41);
  assert.equal(parseSwapins('Pages free: 1.\nSwapins:                                  1200.\nSwapouts: 3.\n'), 1200);
  assert.equal(parseFreePct('nope'), null);
  assert.equal(parseSwapins(''), null);
});

test('keeps the worst pressure and the day delta of swap-ins, and a reboot reset counts the new value', () => {
  let st = fold(null, { now: T('2026-11-22T01:00:00'), freePct: 60, swapins: 1000 });
  st = fold(st, { now: T('2026-11-22T02:00:00'), freePct: 41, swapins: 1050 });
  st = fold(st, { now: T('2026-11-22T03:00:00'), freePct: 55, swapins: 20 });
  assert.deepEqual(st.days['2026-11-22'], { min_free_pct: 41, swapins: 70, samples: 3 });
  assert.equal(renderMemory(st), 'memory pressure and swap-ins per day:\n  11-22 pressure min free 41% swap-ins 70');
});

test('keeps 14 days', () => {
  let st = null;
  for (let d = 1; d <= 20; d++) st = fold(st, { now: T(`2026-11-${String(d).padStart(2, '0')}T12:00:00`), freePct: 50, swapins: 0 });
  assert.equal(Object.keys(st.days).length, 14);
  assert.ok(!st.days['2026-11-06'] && st.days['2026-11-07']);
});

test('sample stubs the commands, persists, and skips non-macOS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const exec = (cmd) => (cmd.endsWith('memory_pressure') ? 'System-wide memory free percentage: 33%' : 'Swapins: 7.');
  assert.equal(sample({ state: dir, platform: 'linux', exec }), null);
  sample({ state: dir, now: T('2026-11-22T01:00:00'), platform: 'darwin', exec });
  assert.equal(readMemory(dir).days['2026-11-22'].min_free_pct, 33);
  assert.equal(renderMemory(null), 'memory: no readings yet');
});
