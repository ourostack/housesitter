import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, settings, parseFootprint, parseIdle, webContentPids, pass } from '../src/app-bloat.mjs';

const s = settings({});
const base = { webMb: 11000, idleMs: 40 * 60000, busy: 0, lastRestartAt: null, restarting: false, now: 1e12 };

test('restarts when big, idle, nothing mid-turn', () => assert.equal(decide(base, s).restart, true));
test('holds under the limit', () => assert.equal(decide({ ...base, webMb: 5000 }, s).restart, false));
test('holds when someone is at the keyboard', () => assert.match(decide({ ...base, idleMs: 10 * 60000 }, s).why, /keyboard/));
test('holds when a session is mid-turn', () => assert.match(decide({ ...base, busy: 2 }, s).why, /mid-turn/));
test('once a night at most', () => assert.match(decide({ ...base, lastRestartAt: base.now - 3600000 }, s).why, /once a night/));
test('allows again after the gap', () => assert.equal(decide({ ...base, lastRestartAt: base.now - 20 * 3600000 }, s).restart, true));
test('unknowns hold', () => {
  for (const k of ['webMb', 'idleMs', 'busy']) assert.equal(decide({ ...base, [k]: null }, s).restart, false);
});
test('disabled and config', () => {
  assert.equal(decide(base, settings({ app_bloat: { enabled: false } })).restart, false);
  assert.equal(settings({ app_bloat: { limit_gb: 8 } }).limitMb, 8192);
});
test('parsers', () => {
  assert.equal(parseFootprint('Footprint: 11 GB (16384 bytes per page)'), 11264);
  assert.equal(parseIdle('"HIDIdleTime" = 1800000000000'), 1800000);
  assert.deepEqual(webContentPids('  12 /x/com.apple.WebKit.WebContent\n  13 /x/Other\n'), [12]);
});

const mk = (o = {}) => { const calls = []; let st = null; return { calls, d: { now: () => 1e12, cfg: () => ({}), webMb: () => ({ mb: 11000, pids: [5] }), idleMs: () => 3e6, busy: async () => 0, restarting: () => false, detach: async (w) => { calls.push(w); return { ok: true, log: 'l' }; }, readState: () => st, writeState: (x) => { st = x; }, ...o } }; };
test('pass restarts once and records it', async () => {
  const { calls, d } = mk();
  assert.equal((await pass({}, d)).action, 'restarted');
  assert.equal((await pass({}, d)).action, 'held');
  assert.equal(calls.length, 1);
});
test('dry run starts nothing', async () => {
  const { calls, d } = mk();
  assert.equal((await pass({ dry_run: true }, d)).action, 'would-restart');
  assert.equal(calls.length, 0);
});
