// housesitter restart-copilot --disk-prune: below 80% nothing happens; above it only safe classes are pruned, and a
// worktree that a session uses, a process has open, or that changed in the last day is never removed, whatever its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pass, whyKeep } from '../src/disk-prune.mjs';

const DAY = 24 * 3600000, GIB = 1073741824;
const NOW = Date.parse('2026-11-16T12:00:00Z');

function fake(over = {}) {
  const log = { removed: [], rescued: [], gz: [], cache: [], told: [], state: {} };
  let pct = over.pct ?? 93;
  const d = {
    now: () => NOW,
    usage: () => ({ pct }),
    caches: () => over.caches || [],
    size: () => 2 * GIB,
    remove: (p) => { log.cache.push(p); pct -= 1; },
    appWorktrees: () => new Set(over.used || []),
    liveSessions: () => new Set(over.live || []),
    worktrees: () => Object.keys(over.wts || {}),
    linked: (x) => over.wts[x].linked !== false,
    open: (x) => (over.wts?.[x]?.open) || (over.openFiles || []).includes(x),
    changedAt: (x) => NOW - over.wts[x].ageMs,
    git: (x) => ({ dirty: Boolean(over.wts[x].dirty), unpushed: Boolean(over.wts[x].unpushed) }),
    rescue: (x) => { log.rescued.push(x); return `/bundles/${x.split('/').pop()}`; },
    removeWorktree: (x) => { log.removed.push(x); pct -= 2; },
    histories: () => over.hist || [],
    gzip: (f) => { log.gz.push(f); pct -= 1; },
    tell: async (m) => { log.told.push(m); },
    readState: () => log.state,
    writeState: (o) => { log.state = o; },
  };
  return { d, log };
}

test('whyKeep: used by a session, open in a process, changed in a day, or not a linked worktree: always kept', () => {
  const ok = { dir: '/w/a', linked: true, usedByApp: false, open: false, changedAt: NOW - 2 * DAY };
  assert.equal(whyKeep(ok, NOW), null);
  assert.match(whyKeep({ ...ok, usedByApp: true }, NOW), /session/);
  assert.match(whyKeep({ ...ok, open: true }, NOW), /process/);
  assert.match(whyKeep({ ...ok, changedAt: NOW - DAY / 2 }, NOW), /24 hours/);
  assert.match(whyKeep({ ...ok, linked: false }, NOW), /main checkout/);
});

test('a worktree in use or changed in the last day is never removed, whatever its name', async () => {
  const wts = {
    '/w/ouro-ui/drain-1718': { ageMs: 70 * 60000, dirty: true }, // a live drain lane, changed an hour ago
    '/w/ouro-ui/drain-old': { ageMs: 3 * DAY, open: true }, // a process has it open
    '/w/ouro-ui/copilot-prewarm-x': { ageMs: 3 * DAY }, // in the app's database
    '/w/ouro-ui/drain-core': { ageMs: 3 * DAY, linked: false }, // a main checkout
    '/w/ouro-ui/finished': { ageMs: 3 * DAY },
  };
  const { d, log } = fake({ wts, used: ['/w/ouro-ui/copilot-prewarm-x'] });
  const r = await pass({}, d);
  assert.deepEqual(log.removed, ['/w/ouro-ui/finished'], 'only the idle, unused, quiet worktree goes');
  assert.equal(r.action, 'pruned');
});

test('unsaved work is saved to a bundle before its worktree is removed', async () => {
  const { d, log } = fake({ wts: { '/w/r/dirty': { ageMs: 2 * DAY, dirty: true }, '/w/r/clean': { ageMs: 2 * DAY } } });
  await pass({}, d);
  assert.deepEqual(log.rescued, ['/w/r/dirty']);
  assert.deepEqual(log.removed, ['/w/r/dirty', '/w/r/clean']);
  assert.match(log.told[0], /Unsaved work was kept in \/bundles\/dirty/);
});

test('below 80% nothing is touched; it stops at 75%; a dry run changes nothing', async () => {
  const wts = { '/w/r/a': { ageMs: 2 * DAY }, '/w/r/b': { ageMs: 2 * DAY }, '/w/r/c': { ageMs: 2 * DAY } };
  let f = fake({ pct: 79, wts }); assert.equal((await pass({}, f.d)).action, 'ok'); assert.equal(f.log.removed.length, 0);
  f = fake({ pct: 82, wts }); await pass({ t: { goal: 81 } }, f.d); assert.equal(f.log.removed.length, 1, 'it stops once under the goal');
  f = fake({ wts }); const r = await pass({ dry_run: true }, f.d); assert.equal(f.log.removed.length, 0); assert.equal(f.log.told.length, 0); assert.equal(r.reclaimed.worktrees.length, 3);
});

test('caches go first; histories of sessions the app lists, or changed in the last day, are never compressed', async () => {
  const hist = [
    { id: 'live-1', file: '/s/live-1/events.jsonl', size: 5 * GIB, mtime: NOW - 9 * DAY },
    { id: 'fresh-2', file: '/s/fresh-2/events.jsonl', size: 5 * GIB, mtime: NOW - 3600000 },
    { id: 'small-3', file: '/s/small-3/events.jsonl', size: 1000, mtime: NOW - 9 * DAY },
    { id: 'open-5', file: '/s/open-5/events.jsonl', size: 5 * GIB, mtime: NOW - 9 * DAY },
    { id: 'gone-4', file: '/s/gone-4/events.jsonl', size: 5 * GIB, mtime: NOW - 9 * DAY },
  ];
  const { d, log } = fake({ pct: 85, caches: ['/h/.npm/_cacache'], hist, live: ['live-1'], openFiles: ['/s/open-5/events.jsonl'] });
  await pass({}, d);
  assert.deepEqual(log.cache, ['/h/.npm/_cacache']);
  assert.deepEqual(log.gz, ['/s/gone-4/events.jsonl']);
});

test('what it reclaimed is said once; when nothing is safe it says so at most once a day', async () => {
  const { d, log } = fake({ wts: { '/w/r/a': { ageMs: 2 * DAY } } });
  await pass({}, d);
  assert.equal(log.told.length, 1);
  assert.match(log.told[0], /93% used.*1 unused worktree/);
  const n = fake({ wts: {} });
  await pass({}, n.d); await pass({}, n.d);
  assert.equal(n.log.told.length, 1);
  assert.match(n.log.told[0], /nothing safe/);
});
