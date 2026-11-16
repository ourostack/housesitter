// housesitter restart-copilot --disk-prune: below 80% nothing happens; above it only safe classes are pruned, and a
// worktree that a session uses, a process has open, or that changed in the last day is never removed, whatever its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHES, pass, whyKeep, whyKeepSession } from '../src/disk-prune.mjs';

const DAY = 24 * 3600000, GIB = 1073741824;
const NOW = Date.parse('2026-11-16T12:00:00Z');

function fake(over = {}) {
  const log = { removed: [], rescued: [], gz: [], cache: [], told: [], state: {} };
  let free = (over.freeGib ?? 60) * GIB;
  const pct = 93;
  const d = {
    now: () => NOW,
    usage: () => ({ pct, free, }),
    caches: () => over.caches || [],
    size: () => 2 * GIB,
    remove: (p) => { log.cache.push(p); free += 10 * GIB; },
    appWorktrees: () => new Set(over.used || []),
    liveSessions: () => new Set(over.live || []),
    worktrees: () => Object.keys(over.wts || {}),
    linked: (x) => over.wts[x].linked !== false,
    open: (x) => (over.wts?.[x]?.open) || (over.openFiles || []).includes(x),
    changedAt: (x) => NOW - over.wts[x].ageMs,
    git: (x) => ({ dirty: Boolean((over.wts?.[x] || over.gits?.[x] || {}).dirty), unpushed: Boolean((over.wts?.[x] || over.gits?.[x] || {}).unpushed) }),
    rescue: (x) => { log.rescued.push(x); return `/bundles/${x.split('/').pop()}`; },
    removeWorktree: (x) => { log.removed.push(x); free += 20 * GIB; },
    histories: () => over.hist || [],
    protectedBy: (x) => (over.protect || []).includes(x) ? 'launchd' : null,
    deadSessions: () => over.dead || [],
    quietFor: (dir) => (over.dead || []).find((x) => x.dir === dir).quietFor ?? Infinity,
    clonesIn: (dirs) => over.clones?.[dirs[0]] || [],
    ledger: (r) => { log.ledger = (log.ledger || []); log.ledger.push(r); },
    breakdown: () => over.breakdown || null,
    gzip: (f) => { log.gz.push(f); free += 10 * GIB; },
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

test('above the floor nothing is touched; it stops at floor + margin; a dry run changes nothing', async () => {
  const wts = { '/w/r/a': { ageMs: 2 * DAY }, '/w/r/b': { ageMs: 2 * DAY }, '/w/r/c': { ageMs: 2 * DAY } };
  let f = fake({ freeGib: 600, wts }); assert.equal((await pass({}, f.d)).action, 'ok'); assert.equal(f.log.removed.length, 0);
  f = fake({ freeGib: 490, wts }); await pass({ t: { margin: 5 * GIB } }, f.d); assert.equal(f.log.removed.length, 1, 'it stops once free space is floor + margin');
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
  const { d, log } = fake({ freeGib: 60, caches: ['/h/.npm/_cacache'], hist, live: ['live-1'], openFiles: ['/s/open-5/events.jsonl'] });
  await pass({}, d);
  assert.deepEqual(log.cache, ['/h/.npm/_cacache']);
  assert.deepEqual(log.gz, ['/s/gone-4/events.jsonl']);
});

test('what it reclaimed is said once; when nothing is safe it says so at most once a day', async () => {
  const { d, log } = fake({ wts: { '/w/r/a': { ageMs: 2 * DAY } } });
  await pass({}, d);
  assert.equal(log.told.length, 1);
  assert.match(log.told[0], /Free space was 60.0 GiB.*1 unused worktree/);
  const n = fake({ wts: {} });
  await pass({}, n.d); await pass({}, n.d);
  assert.equal(n.log.told.length, 1);
  assert.match(n.log.told[0], /nothing safe/);
});

// 2026-11-16: pruning Library/Caches/github-copilot-sdk deleted the Copilot app's own CLI, which it unpacks only at
// launch, so no session could start or reopen until the app restarted. Only caches that rebuild on demand are pruned.
test('the Copilot app\'s runtime is never pruned as a cache', () => {
  assert.ok(!CACHES.some((c) => /github-copilot|copilot-sdk/i.test(c)), CACHES.join(', '));
});

test('free space is recorded about hourly, and the biggest growers are named when it speaks', async () => {
  const bd = { at: NOW, top: [{ name: 'session 93a4d349', size: 40 * GIB, grew: 6 * GIB }, { name: 'code', size: 250 * GIB, grew: 0 }] };
  const f = fake({ freeGib: 700 });
  await pass({}, f.d); await pass({}, f.d);
  assert.equal(f.log.ledger.length, 1, 'a second pass in the same hour adds no row');
  const g = fake({ freeGib: 60, breakdown: bd, wts: { '/w/r/a': { ageMs: 2 * DAY } } });
  await pass({}, g.d);
  assert.match(g.log.told[0], /Biggest sources: session 93a4d349 40.0 GiB \(\+6.0 GiB in a day\)/);
});

test('a pass that found nothing safe rests an hour before it scans again', async () => {
  const f = fake({ freeGib: 60 });
  assert.equal((await pass({}, f.d)).action, 'nothing-safe');
  assert.equal((await pass({}, f.d)).action, 'resting');
  assert.equal((await pass({ force: true }, f.d)).action, 'nothing-safe', '--now ignores the rest');
});

test('whyKeepSession: listed, open or touched in a week: kept', () => {
  assert.equal(whyKeepSession({ live: false, open: false, quietFor: Infinity }), null);
  assert.match(whyKeepSession({ live: true, open: false, quietFor: Infinity }), /lists/);
  assert.match(whyKeepSession({ live: false, open: true, quietFor: Infinity }), /open/);
  assert.match(whyKeepSession({ live: false, open: false, quietFor: 0 }), /7 days/);
});

test('an unlisted, quiet session loses only files/ and images/, after its clones with unsaved work are saved; a listed or recent one loses nothing', async () => {
  const dead = [
    { id: 'gone-1', dir: '/s/gone-1', heavy: ['/s/gone-1/files', '/s/gone-1/images'] },
    { id: 'live-2', dir: '/s/live-2', heavy: ['/s/live-2/files'] },
    { id: 'recent-3', dir: '/s/recent-3', heavy: ['/s/recent-3/files'], quietFor: 0 },
  ];
  const f = fake({ dead, live: ['live-2'], clones: { '/s/gone-1/files': ['/s/gone-1/files/clone-a', '/s/gone-1/files/clone-b'] }, gits: { '/s/gone-1/files/clone-a': { dirty: true } } });
  await pass({}, f.d);
  assert.deepEqual(f.log.cache, ['/s/gone-1/files', '/s/gone-1/images']);
  assert.deepEqual(f.log.rescued, ['/s/gone-1/files/clone-a']);
});

// 2026-11-16: a worktree that launchd (or Housesitter itself) runs from must never go, however old and clean.
test('a worktree launchd runs from is never removed', async () => {
  const f = fake({ wts: { '/c/housesitter-wt/x': { ageMs: 9 * DAY }, '/c/other/y': { ageMs: 9 * DAY } }, protect: ['/c/housesitter-wt/x'] });
  await pass({}, f.d);
  assert.deepEqual(f.log.removed, ['/c/other/y']);
  assert.match(whyKeep({ dir: '/x', linked: true, protectedBy: '/c/hs', usedByApp: false, open: false, changedAt: 0 }, NOW), /launchd/);
});
