// housesitter restart-copilot --disk-prune: below 80% nothing happens; above it only safe classes are pruned, and a
// worktree that a session uses, a process has open, or that changed in the last day is never removed, whatever its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionIndex } from '../src/session-index.mjs';
import { CACHES, DP, floorOf, marginOf, mayThinSession, pass, whyKeep, whyKeepCache, whyKeepSession } from '../src/disk-prune.mjs';

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
    remove: (p) => { log.cache.push(p); free += 10 * GIB; },
    appWorktrees: () => new Set(over.used || []),
    liveSessions: () => new Set(over.live || []),
    worktrees: () => Object.keys(over.wts || {}),
    linked: (x) => over.wts[x].linked !== false,
    branchDone: (x) => (over.done || []).includes(x),
    sessionPin: (x) => (over.pins || {})[x] || null,
    archiveSessions: async (x) => { log.archived = [...(log.archived || []), x]; return over.archiveFail ? { ok: false, error: 'refused' } : { ok: true }; },
    open: (x) => (over.wts?.[x]?.open) || (over.landed?.[x]?.open) || (over.openFiles || []).includes(x),
    changedAt: (x) => NOW - (over.wts?.[x]?.ageMs ?? over.cloneAge?.[x] ?? 9 * DAY),
    git: (x) => ({ dirty: Boolean((over.wts?.[x] || over.gits?.[x] || {}).dirty), unpushed: Boolean((over.wts?.[x] || over.gits?.[x] || {}).unpushed) }),
    rescue: (x) => { log.rescued.push(x); return `/bundles/${x.split('/').pop()}`; },
    removeWorktree: (x) => { log.removed.push(x); free += 20 * GIB; },
    landedWorktrees: () => Object.keys(over.landed || {}).map((dir) => ({ dir })),
    dirty: (x) => Boolean(over.landed?.[x]?.dirty),
    landedWhy: (x) => (over.landed?.[x] && 'why' in over.landed[x] ? over.landed[x].why : 'in origin/main'),
    removeLanded: (x) => { log.landed = [...(log.landed || []), x]; return true; },
    histories: () => over.hist || [],
    protectedBy: (x) => (over.protect || []).includes(x) ? 'launchd' : null,
    deadSessions: () => over.dead || [],
    quietFor: (dir) => (over.dead || []).find((x) => x.dir === dir)?.quietFor ?? over.quiet?.[dir] ?? Infinity,
    archivedScratch: (id) => (over.scratchOf || {})[id] || null,
    ghCacheOld: () => over.ghOld || [],
    size: (p) => over.sizes?.[p] ?? 2 * GIB,
    clonesIn: (dirs) => over.clones?.[dirs[0]] || [],
    scratch: () => over.scratchList || [],
    leakedClones: () => over.leaked || [],
    clones: () => over.clonesList || [],
    clone: (x) => ({ unique: Boolean(over.uniq?.includes(x)) }),
    idleSessionFiles: () => over.idleFiles || [],
    regenIn: (f) => over.regen?.[f] || [],
    idleSessions: () => new Set(over.idle || []),
    thinnable: () => over.thin || [],
    thin: (x) => { log.thinned = (log.thinned || []); log.thinned.push(x); free += 10 * GIB; return true; },
    ledger: (r) => { log.ledger = (log.ledger || []); log.ledger.push(r); },
    breakdown: () => over.breakdown || null,
    sessionRows: async () => ({ archived: over.archived || [], live: new Set(over.live || []), known: new Set([...(over.live || []), ...(over.archived || []), ...(over.listed || [])]) }),
    // Shepherd's compressHistory, as a fake: 5:1 on the history it is given, and a refusal for the ids in over.compressFails.
    compress: async (id, { dryRun }) => {
      if (over.compressFails?.includes(id)) return { id, ok: false, before: null, after: null, why: 'refused' };
      const before = (over.hist || []).find((x) => x.id === id)?.size ?? 0, after = Math.round(before / 5);
      if (!dryRun) { log.gz.push(id); free += before - after; }
      return { id, ok: true, before, after: dryRun ? null : after, why: null };
    },
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
  assert.match(log.told[0], /Unsaved work from 1 worktree\(s\) was saved under ~\/AgentBundles\/disk-rescue/);
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
  assert.deepEqual(log.gz, ['gone-4']);
});

test('an archived session\'s history is compressed on every pass, above the floor and without waiting a day', async () => {
  const hist = [{ id: 'arch-1', file: '/s/arch-1/events.jsonl', size: 4 * GIB, mtime: NOW - 60000 }];
  const { d, log } = fake({ freeGib: 600, hist, archived: ['arch-1'] });
  const r = await pass({}, d);
  assert.equal(r.action, 'ok');
  assert.deepEqual(log.gz, ['arch-1']);
  assert.equal(r.reclaimed.histories, 4 * GIB - Math.round(4 * GIB / 5));
});

test('a live session\'s history is never compressed, above the floor or below it', async () => {
  const hist = [{ id: 'live-2', file: '/s/live-2/events.jsonl', size: 4 * GIB, mtime: NOW - 9 * DAY }];
  for (const freeGib of [600, 60]) {
    const { d, log } = fake({ freeGib, hist, live: ['live-2'] });
    await pass({}, d);
    assert.deepEqual(log.gz, [], `free ${freeGib} GiB`);
  }
});

test('an unlisted session\'s history still waits a day and the floor', async () => {
  const hist = [{ id: 'gone-7', file: '/s/gone-7/events.jsonl', size: 4 * GIB, mtime: NOW - 3 * 3600000 }];
  let f = fake({ freeGib: 600, hist }); await pass({}, f.d); assert.deepEqual(f.log.gz, [], 'above the floor');
  f = fake({ freeGib: 60, hist }); await pass({}, f.d); assert.deepEqual(f.log.gz, [], 'quiet for less than a day');
  const old = [{ ...hist[0], mtime: NOW - 2 * DAY }];
  f = fake({ freeGib: 600, hist: old }); await pass({}, f.d); assert.deepEqual(f.log.gz, [], 'above the floor, even when quiet');
  f = fake({ freeGib: 60, hist: old }); await pass({}, f.d); assert.deepEqual(f.log.gz, ['gone-7']);
});

test('a dry run compresses nothing, archived or unlisted, and reports what it would', async () => {
  const hist = [
    { id: 'arch-1', file: '/s/arch-1/events.jsonl', size: 4 * GIB, mtime: NOW - 60000 },
    { id: 'gone-7', file: '/s/gone-7/events.jsonl', size: 4 * GIB, mtime: NOW - 9 * DAY },
  ];
  const { d, log } = fake({ freeGib: 60, hist, archived: ['arch-1'] });
  const r = await pass({ dry_run: true }, d);
  assert.deepEqual(log.gz, []);
  assert.equal(r.reclaimed.histories, 8 * GIB);
});

test('reclaimed bytes are before minus after; a history Shepherd refuses is not counted', async () => {
  const hist = [
    { id: 'arch-1', file: '/s/arch-1/events.jsonl', size: 4 * GIB, mtime: NOW },
    { id: 'arch-2', file: '/s/arch-2/events.jsonl', size: 2 * GIB, mtime: NOW },
  ];
  const { d, log } = fake({ freeGib: 600, hist, archived: ['arch-1', 'arch-2'], compressFails: ['arch-2'] });
  const r = await pass({}, d);
  assert.deepEqual(log.gz, ['arch-1']);
  assert.equal(r.reclaimed.histories, 4 * GIB - Math.round(4 * GIB / 5));
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

test('whyKeepSession: listed, open or touched in two days: kept', () => {
  assert.equal(whyKeepSession({ live: false, open: false, quietFor: Infinity }), null);
  assert.match(whyKeepSession({ live: true, open: false, quietFor: Infinity }), /lists/);
  assert.match(whyKeepSession({ live: false, open: true, quietFor: Infinity }), /open/);
  assert.match(whyKeepSession({ live: false, open: false, quietFor: 0 }), /2 days/);
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

test('an idle session\'s worktree is thinned; a busy one is left whole', async () => {
  const f = fake({ thin: [{ dir: '/w/a', session: 's-idle' }, { dir: '/w/b', session: 's-busy' }, { dir: '/w/c', session: 's-gone' }], idle: ['s-idle'] });
  const r = await pass({}, f.d);
  assert.deepEqual(f.log.thinned, ['/w/a']);
  assert.equal(r.action, 'pruned');
  assert.match(f.log.told[0], /1 idle worktree\(s\) made sparse/);
  const g = fake({ thin: [{ dir: '/w/a', session: 's-idle' }], idle: ['s-idle'] });
  await pass({ dry_run: true }, g.d); assert.equal(g.log.thinned, undefined, 'a dry run thins nothing');
});

test('thin uses the repository\'s own script: clean media leaves the tree, modified and untracked files stay', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-'));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  const main = path.join(root, 'main'); fs.mkdirSync(main); g(main, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(main, '.github/scripts'), { recursive: true });
  fs.writeFileSync(path.join(main, '.github/scripts/lean-worktree.sh'), "#!/usr/bin/env bash\nset -euo pipefail\ncd \"${COPILOT_WORKSPACE_PATH:-.}\"\ngit sparse-checkout set --no-cone '/*' '!*.png'\n");
  for (const f of ['clean.png', 'edited.png', 'doc.md']) fs.writeFileSync(path.join(main, f), 'x');
  g(main, 'add', '-A'); g(main, 'commit', '-qm', 'one');
  const wt = path.join(root, 'wt'); g(main, 'worktree', 'add', '-q', '-b', 'b', wt);
  fs.writeFileSync(path.join(wt, 'edited.png'), 'changed'); fs.writeFileSync(path.join(wt, 'new.png'), 'mine');
  const d = realDiskDeps({ home: root });
  assert.equal(d.thin(wt), true);
  assert.ok(!fs.existsSync(path.join(wt, 'clean.png')), 'clean media is gone from the tree');
  assert.ok(fs.existsSync(path.join(wt, 'edited.png')) && fs.existsSync(path.join(wt, 'new.png')) && fs.existsSync(path.join(wt, 'doc.md')));
  assert.equal(fs.readFileSync(path.join(wt, 'edited.png'), 'utf8'), 'changed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a full clone goes only when it holds nothing Git does not and has been quiet three days', async () => {
  const clonesList = ['/c/clean', '/c/unique', '/c/recent', '/c/used', '/c/launchd', '/c/open'];
  const f = fake({ clonesList, uniq: ['/c/unique'], cloneAge: { '/c/recent': DAY }, used: ['/c/used'], protect: ['/c/launchd'], openFiles: ['/c/open'] });
  const r = await pass({}, f.d);
  assert.deepEqual(f.log.cache, ['/c/clean']);
  assert.equal(r.reclaimed.clones.length, 1);
});

test('scratch in /private/tmp goes only when quiet for a day, not open and not something launchd runs from', async () => {
  const scratchList = ['/private/tmp/old', '/private/tmp/new', '/private/tmp/open', '/private/tmp/agent'];
  const f = fake({ scratchList, cloneAge: { '/private/tmp/new': 3600000 }, openFiles: ['/private/tmp/open'], protect: ['/private/tmp/agent'] });
  const r = await pass({}, f.d);
  assert.deepEqual(f.log.cache, ['/private/tmp/old']);
  assert.equal(r.reclaimed.scratch, 2 * GIB);
});

test('leaked browser code-sign clones go on every pass, even above the floor, unless a browser has one open or it is under an hour old', async () => {
  const leaked = ['/X/e.code_sign_clone/code_sign_clone.old', '/X/e.code_sign_clone/code_sign_clone.live', '/X/e.code_sign_clone/code_sign_clone.new'];
  const f = fake({ freeGib: 900, leaked, openFiles: [leaked[1]], cloneAge: { [leaked[2]]: 600000 } });
  const r = await pass({}, f.d);
  assert.equal(r.action, 'ok');
  assert.deepEqual(f.log.cache, [leaked[0]]);
  assert.equal(r.reclaimed.browserClones, 2 * GIB);
  const dry = fake({ freeGib: 900, leaked: [leaked[0]] });
  await pass({ dry_run: true }, dry.d);
  assert.deepEqual(dry.log.cache, []);
});

test('loose work under ~/code goes only when quiet for three days, not open, not in use and not launchd\'s', async () => {
  const junk = ['/h/code/old', '/h/code/busy', '/h/code/open', '/h/code/agent'];
  const f = fake({ cloneAge: { '/h/code/busy': 2 * DAY }, openFiles: ['/h/code/open'], protect: ['/h/code/agent'] });
  f.d.junk = () => junk;
  const r = await pass({}, f.d);
  assert.deepEqual(f.log.cache, ['/h/code/old']);
  assert.deepEqual(r.reclaimed.junk, ['/h/code/old']);
});

test('a cache that refuses to go (ENOTEMPTY) does not end the pass: the next categories still run', async () => {
  const f = fake({ caches: ['/h/.npm/_cacache'], scratchList: ['/private/tmp/old'] });
  const real = f.d.remove;
  f.d.remove = (p) => { if (p.includes('_cacache')) throw new Error('ENOTEMPTY'); real(p); };
  const r = await pass({}, f.d);
  assert.equal(r.reclaimed.caches, 0);
  assert.deepEqual(f.log.cache, ['/private/tmp/old']);
});

test('real temp folders and loose ~/code work: Apple\'s entries and git checkouts stay, old plain folders are listed', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-junk-'));
  const code = path.join(home, 'code');
  for (const d of ['repo/.git', 'plain/a', 'mixed/hunt1', 'mixed/withgit/.git']) fs.mkdirSync(path.join(code, d), { recursive: true });
  fs.writeFileSync(path.join(code, 'afile'), 'x');
  const got = realDiskDeps({ home }).junk().map((p) => path.relative(code, p)).sort();
  assert.ok(got.includes('plain') && got.includes('plain/a'));
  assert.ok(!got.some((p) => p === 'repo' || p.startsWith('repo/')), 'a checkout is not loose work');
  assert.ok(!got.some((p) => p === 'mixed' || p.startsWith('mixed/')), 'a folder holding a checkout is left to the checkout stages');
  assert.ok(!got.includes('afile'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('idle listed session: dependency folders and fully pushed clones go; unpushed or dirty clones, history and open sessions stay', async () => {
  const idleFiles = [{ id: 'aaaaaaaa1', dir: '/s/a', files: '/s/a/files' }, { id: 'bbbbbbbb2', dir: '/s/b', files: '/s/b/files' }];
  const f = fake({
    idleFiles, regen: { '/s/a/files': ['/s/a/files/x/node_modules', '/s/a/files/y/.venv'], '/s/b/files': ['/s/b/files/node_modules'] },
    clones: { '/s/a/files': ['/s/a/files/x', '/s/a/files/y'], '/s/b/files': ['/s/b/files/z'] },
    uniq: ['/s/a/files/y'], openFiles: ['/s/b'],
  });
  const r = await pass({}, f.d);
  assert.deepEqual(f.log.cache, ['/s/a/files/x/node_modules', '/s/a/files/y/.venv', '/s/a/files/x']);
  assert.deepEqual(r.reclaimed.idle, ['aaaaaaaa1']);
  assert.ok(!f.log.cache.some((p) => p.endsWith('events.jsonl') || p === '/s/a/files/y' || p.startsWith('/s/b')), 'unpushed clone, history and open session untouched');
});

test('idle listed session: a dry run removes nothing', async () => {
  const f = fake({ idleFiles: [{ id: 'cccccccc3', dir: '/s/c', files: '/s/c/files' }], regen: { '/s/c/files': ['/s/c/files/node_modules'] } });
  await pass({ dry_run: true }, f.d);
  assert.deepEqual(f.log.cache, []);
});

test('mayThinSession: running, automated and unlisted sessions are never candidates', () => {
  const sets = { live: new Set(['a', 'b', 'c']), running: new Set(['b']), automated: new Set(['c']) };
  assert.equal(mayThinSession('a', sets), true);
  assert.equal(mayThinSession('b', sets), false);
  assert.equal(mayThinSession('c', sets), false);
  assert.equal(mayThinSession('z', sets), false);
});

test('real regenIn: dependency folders are listed once (nested ones folded in), target only beside Cargo.toml', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-regen-'));
  for (const d of ['a/node_modules/dep/node_modules', 'a/src', 'b/.venv', 'c/target', 'd/target', 'e/dist']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'd/Cargo.toml'), '');
  const got = realDiskDeps({ home }).regenIn(home).map((p) => path.relative(home, p)).sort();
  assert.deepEqual(got, ['a/node_modules', 'b/.venv', 'd/target']);
  fs.rmSync(home, { recursive: true, force: true });
});

// 2026-11-18: every pass under the floor deleted ~/Library/Caches/ms-playwright, the next test run downloaded Chromium
// and WebKit again, and the next pass deleted them again. A cache that comes back is in use, and stays.
test('a cache removed on one pass and back on the next is kept, and that is said once', async () => {
  const pw = '/h/Library/Caches/ms-playwright';
  const f = fake({ caches: [pw], freeGib: 30 });
  await pass({}, f.d);
  assert.deepEqual(f.log.cache, [pw]);
  f.d.now = () => NOW + 2 * 3600000;
  const said = [];
  const r = await pass({}, f.d, (l) => said.push(l));
  assert.deepEqual(f.log.cache, [pw], 'the second pass leaves it alone');
  assert.equal(r.reclaimed.caches, 0);
  assert.equal(said.filter((l) => l.includes(`kept cache ${pw}`)).length, 1);
  assert.match(said.find((l) => l.includes('kept cache')), /came back/);
  assert.equal(f.log.told.length, 2, 'the keep reaches the agent even within a day of the last message');
  assert.match(f.log.told[1], /Kept 1 cache\(s\) in use \(ms-playwright\)/);
  f.d.now = () => NOW + 4 * 3600000;
  const again = [];
  await pass({}, f.d, (l) => again.push(l));
  assert.deepEqual(f.log.cache, [pw]);
  assert.equal(again.filter((l) => l.includes('kept cache')).length, 0, 'said once, not every pass');
  assert.equal(f.log.told.length, 2);
});

test('a cache a running process has open is kept', async () => {
  const f = fake({ caches: ['/h/Library/Caches/pnpm', '/h/.cache/gh'], openFiles: ['/h/Library/Caches/pnpm'] });
  await pass({}, f.d);
  assert.deepEqual(f.log.cache, ['/h/.cache/gh']);
});

test('a cache unused through the window is still removed when the floor needs it; a dry run records nothing', async () => {
  const pw = '/h/Library/Caches/ms-playwright';
  const f = fake({ caches: [pw], freeGib: 30 });
  f.log.state = { caches: { [pw]: { removedAt: NOW - 8 * DAY } } };
  await pass({}, f.d);
  assert.deepEqual(f.log.cache, [pw]);
  assert.equal(f.log.state.caches[pw].removedAt, NOW);
  const g = fake({ caches: [pw], freeGib: 30 });
  await pass({ dry_run: true }, g.d);
  assert.equal(g.log.state.caches, undefined);
  assert.equal(whyKeepCache({ open: false, removedAt: NOW - 8 * DAY }, NOW), null);
  assert.match(whyKeepCache({ open: false, removedAt: NOW - 6 * DAY }, NOW), /came back/);
  assert.match(whyKeepCache({ open: true }, NOW), /open/);
});

// 2026-11-19 13:40Z: a pass wiped ms-playwright for the first time, so nothing yet said it came back.
test('Playwright browsers survive a pass that is not urgent, even the first one', async () => {
  const pw = '/h/Library/Caches/ms-playwright', gh = '/h/.cache/gh';
  const f = fake({ caches: [pw, gh], freeGib: 175 });
  const said = [];
  await pass({ force: true }, f.d, (l) => said.push(l));
  assert.deepEqual(f.log.cache, [gh]);
  assert.match(said.join('\n'), /kept cache .*ms-playwright.*costs every lane/);
});

test('the floor is a share of the volume, so a 926 GiB disk with 190 GiB free is left alone', async () => {
  const size = 926 * GIB;
  assert.equal(floorOf({ ...DP }, size), Math.round(size * 0.2));
  assert.equal(floorOf({ ...DP }, undefined), 500 * GIB);
  assert.equal(floorOf({ ...DP, floor: 7 }, size), 7);
  assert.equal(marginOf({ ...DP }, size), Math.round(size * 0.05));
  const f = fake({ caches: ['/h/.cache/gh'], freeGib: 190 });
  const u = f.d.usage; f.d.usage = () => ({ ...u(), size });
  assert.equal((await pass({}, f.d)).action, 'ok');
  assert.deepEqual(f.log.cache, []);
  const g = fake({ caches: ['/h/.cache/gh'], freeGib: 150 });
  const v = g.d.usage; g.d.usage = () => ({ ...v(), size });
  await pass({}, g.d);
  assert.deepEqual(g.log.cache, ['/h/.cache/gh']);
});

test('a pass that ends still under the floor rests an hour, unless free space is critically low', async () => {
  const f = fake({ wts: { '/w/r/a': { ageMs: 2 * DAY } } });
  assert.equal((await pass({}, f.d)).action, 'pruned');
  assert.equal((await pass({}, f.d)).action, 'resting');
  const g = fake({ freeGib: 5, wts: { '/w/r/a': { ageMs: 2 * DAY } } });
  assert.equal((await pass({}, g.d)).after, 25 * GIB);
  assert.notEqual((await pass({}, g.d)).action, 'resting', 'below the urgent level every pass runs');
  const h = fake({ freeGib: 5 });
  h.log.state = { restUntil: NOW + 3600000 };
  assert.notEqual((await pass({}, h.d)).action, 'resting', 'a rest set when space was higher does not hold once it is critically low');
});

test('a worktree an unarchived session still lists goes once its branch is merged or gone, but only if idle and not open', async () => {
  const wts = { '/w/done': { ageMs: 2 * DAY }, '/w/active': { ageMs: 2 * DAY }, '/w/fresh': { ageMs: 2 * 3600000 }, '/w/openone': { ageMs: 2 * DAY, open: true } };
  const f = fake({ wts, used: Object.keys(wts), done: ['/w/done', '/w/fresh', '/w/openone'] });
  const r = await pass({}, f.d);
  assert.deepEqual(f.log.removed, ['/w/done']);
  assert.deepEqual(r.reclaimed.worktrees, ['/w/done']);
});

test('a finished worktree whose session runs, has an automation, coordinates or is a drain target is kept; others are archived first, then removed', async () => {
  const wts = Object.fromEntries(['/w/drain', '/w/auto', '/w/run', '/w/plain'].map((k) => [k, { ageMs: 2 * DAY }]));
  const f = fake({ wts, used: Object.keys(wts), done: Object.keys(wts), pins: { '/w/drain': 'session is a drain target', '/w/auto': 'automation', '/w/run': 'running' } });
  await pass({}, f.d);
  assert.deepEqual(f.log.removed, ['/w/plain']);
  assert.deepEqual(f.log.archived, ['/w/plain']);
});

test('a finished worktree stays when its session cannot be archived', async () => {
  const wts = { '/w/a': { ageMs: 2 * DAY } };
  const f = fake({ wts, used: ['/w/a'], done: ['/w/a'], archiveFail: true });
  await pass({}, f.d);
  assert.deepEqual(f.log.removed, []);
});

test('drainTargets reads every session id the drain configs name', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { drainTargets } = await import('../src/disk-prune.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-dr-'));
  const dir = path.join(home, '.local/state/ouroboros-skills/desk/drains'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{"drains":[{"repo":"a/b","session":"3abdecbe-465a-4d40-870d-58c36ec65013"}]}');
  assert.deepEqual([...drainTargets(home)], ['3abdecbe-465a-4d40-870d-58c36ec65013']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('real branchDone: merged or remote-deleted branches are done; a branch with its own commits, or still at the tip, is not', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), { execFileSync } = await import('node:child_process');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-bd-'));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { encoding: 'utf8' });
  const origin = path.join(root, 'origin.git'), main = path.join(root, 'main');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin); git(root, 'clone', '-q', origin, main);
  fs.writeFileSync(path.join(main, 'a'), '1'); git(main, 'add', 'a'); git(main, 'commit', '-qm', 'a'); git(main, 'push', '-q', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main');
  const wt = (n, commit) => { const d = path.join(root, n); git(main, 'worktree', 'add', '-q', '-b', n, d); if (commit) { fs.writeFileSync(path.join(d, n), n); git(d, 'add', n); git(d, 'commit', '-qm', n); } return d; };
  const tip = wt('tip', false), work = wt('work', true), merged = wt('merged', true), gone = wt('gone', true);
  const d = realDiskDeps({ home: root });
  assert.equal(d.branchDone(tip), false);
  git(merged, 'push', '-q', 'origin', 'merged:main');
  fs.writeFileSync(path.join(main, 'b'), '2'); git(main, 'pull', '-q', 'origin', 'main'); git(main, 'add', 'b'); git(main, 'commit', '-qm', 'b'); git(main, 'push', '-q', 'origin', 'main');
  git(gone, 'push', '-q', '-u', 'origin', 'gone'); git(main, 'push', '-q', 'origin', '--delete', 'gone');
  const d2 = realDiskDeps({ home: root });
  assert.equal(d2.branchDone(work), false);
  assert.equal(d2.branchDone(merged), true);
  assert.equal(d2.branchDone(gone), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('gitCommonDir answers as git does, for a checkout, a linked worktree, a subfolder and a non-repo', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), { execFileSync } = await import('node:child_process');
  const { gitCommonDir } = await import('../src/disk-prune.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-gc-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { encoding: 'utf8' });
  const main = path.join(root, 'main'); fs.mkdirSync(path.join(main, 'sub'), { recursive: true });
  git(main, 'init', '-q'); fs.writeFileSync(path.join(main, 'a'), '1'); git(main, 'add', 'a'); git(main, 'commit', '-qm', 'a');
  const wt = path.join(root, 'wt'); git(main, 'worktree', 'add', '-q', '-b', 'b', wt);
  fs.mkdirSync(path.join(root, 'plain'));
  for (const d of [main, path.join(main, 'sub'), wt]) assert.equal(gitCommonDir(d), fs.realpathSync(path.resolve(d, git(d, 'rev-parse', '--git-common-dir').trim())));
  assert.equal(gitCommonDir(path.join(root, 'plain')), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('real protectedBy: a path outside any repository is not protected just because a protected path is outside one too', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-pb-')));
  const prot = path.join(root, 'prot'), other = path.join(root, 'other');
  fs.mkdirSync(prot); fs.mkdirSync(other);
  const d = realDiskDeps({ home: root, extraProtected: [prot] });
  assert.equal(d.protectedBy(path.join(prot, 'x')), prot);
  assert.equal(d.protectedBy(other), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('real quietSince: a file or folder changed within the window is not quiet; an old one is', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-qs-')));
  const old = new Date(Date.now() - 10 * 3600000);
  const f = path.join(root, 'f'); fs.writeFileSync(f, 'x');
  const dir = path.join(root, 'd'); fs.mkdirSync(path.join(dir, 'in'), { recursive: true }); const g = path.join(dir, 'in', 'g'); fs.writeFileSync(g, 'x');
  const d = realDiskDeps({ home: root });
  assert.equal(d.quietSince(f, 3 * 3600000), false);
  fs.utimesSync(f, old, old); assert.equal(d.quietSince(f, 3 * 3600000), true);
  fs.utimesSync(dir, old, old); fs.utimesSync(path.join(dir, 'in'), old, old);
  assert.equal(d.quietSince(dir, 3 * 3600000), false);
  fs.utimesSync(g, old, old); assert.equal(d.quietSince(dir, 3 * 3600000), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the tell and result count what was kept, by reason', async () => {
  const scratchList = ['/private/tmp/a', '/private/tmp/b', '/private/tmp/c', '/private/tmp/d'];
  const f = fake({ scratchList, cloneAge: { '/private/tmp/a': 3600000, '/private/tmp/b': 3600000 }, openFiles: ['/private/tmp/c'], protect: ['/private/tmp/d'] });
  const r = await pass({}, f.d);
  assert.deepEqual(r.keeps.scratch, { 'changed within 3 h': 2, 'a process has it open': 1, 'launchd or Housesitter runs from it': 1 });
});

test('retention: an archived, quiet session loses only files/, above the floor too; live, recent or open ones keep it', async () => {
  const sc = (id) => ({ id, dir: `/s/${id}`, files: `/s/${id}/files` });
  const { d, log } = fake({
    freeGib: 600, archived: ['a-old', 'a-new', 'a-open', 'a-live'], live: ['a-live'],
    scratchOf: { 'a-old': sc('a-old'), 'a-new': sc('a-new'), 'a-open': sc('a-open'), 'a-live': sc('a-live') },
    quiet: { '/s/a-new': 3600000 }, openFiles: ['/s/a-open/files'],
    sizes: { '/s/a-old/files': 5 * GIB },
  });
  const r = await pass({}, d);
  assert.deepEqual(log.cache, ['/s/a-old/files']);
  assert.equal(r.reclaimedBytes, 5 * GIB);
  assert.equal(log.state.retention.reclaimedBytes, 5 * GIB);
  assert.ok(!log.cache.some((p) => /events|session\.db|images|checkpoints/.test(p)));
});

test('retention: a dry run removes nothing and a session without files/ is skipped', async () => {
  const { d, log } = fake({ freeGib: 600, archived: ['a-old', 'a-bare'], scratchOf: { 'a-old': { id: 'a-old', dir: '/s/a-old', files: '/s/a-old/files' } } });
  const r = await pass({ dry_run: true }, d);
  assert.deepEqual(log.cache, []);
  assert.equal(r.reclaimedBytes, 2 * GIB);
});

test('retention: old gh cache entries go and fresh ones stay (the dep lists only old ones)', async () => {
  const { d, log } = fake({ freeGib: 600, ghOld: [{ path: '/h/.cache/gh/0a/old1', size: GIB }, { path: '/h/.cache/gh/ff/old2', size: GIB }] });
  const r = await pass({}, d);
  assert.deepEqual(log.cache, ['/h/.cache/gh/0a/old1', '/h/.cache/gh/ff/old2']);
  assert.equal(r.reclaimedBytes, 2 * GIB);
});

test('real ghCacheOld and archivedScratch read a synthetic home', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ret-'));
  const id = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(home, '.cache/gh/0a'), { recursive: true });
  fs.mkdirSync(path.join(home, '.copilot/session-state', id, 'files'), { recursive: true });
  fs.writeFileSync(path.join(home, '.copilot/session-state', id, 'events.jsonl'), 'x');
  const oldF = path.join(home, '.cache/gh/0a/old'), newF = path.join(home, '.cache/gh/0a/new');
  fs.writeFileSync(oldF, 'o'); fs.writeFileSync(newF, 'n');
  const past = new Date(Date.now() - 3 * DAY); fs.utimesSync(oldF, past, past);
  const deps = realDiskDeps({ home, state: path.join(home, 'st') });
  assert.deepEqual(deps.ghCacheOld(Date.now() - DAY).map((e) => e.path), [oldF]);
  assert.equal(deps.archivedScratch(id).files, path.join(home, '.copilot/session-state', id, 'files'));
  assert.equal(deps.archivedScratch('../etc'), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('landed worktrees: removed only when clean, quiet, idle, unused and landed; reasons are counted and the total is reported', async () => {
  const { d, log } = fake({
    freeGib: 60,
    landed: {
      '/c/a': { why: 'in origin/main' }, '/c/dirty': { dirty: true }, '/c/recent': {}, '/c/open': { open: true },
      '/c/unlanded': { why: null }, '/c/app': { why: 'in origin/main' }, '/c/launchd': { why: 'in origin/main' },
    },
    used: ['/c/app'], protect: ['/c/launchd'], cloneAge: { '/c/recent': 3600000 },
  });
  const r = await pass({}, d);
  assert.deepEqual(log.landed, ['/c/a']);
  assert.equal(r.reclaimed.landedBytes, 2 * GIB);
  assert.deepEqual(r.keeps['landed worktrees'], {
    'it has uncommitted or untracked changes': 1, 'something in it changed in the last 24 hours': 1, 'a running process has it open': 1,
    'its work has not landed on the default branch': 1, 'an unarchived app session uses it': 1, 'launchd or Housesitter runs from it': 1,
  });
  assert.match(log.told.join('\n'), /1 landed worktree\(s\) \(2\.0 GiB\)/);
});

test('landed worktrees: a dry run removes nothing; Tandem\'s keepers and the app\'s folder are off limits', async () => {
  const { d, log } = fake({ freeGib: 60, landed: { '/c/a': { why: 'in origin/main' } } });
  const r = await pass({ dry_run: true }, d);
  assert.deepEqual(log.landed || [], []);
  assert.equal(r.reclaimed.landedBytes, 2 * GIB);
  const { isOffLimits } = await import('../src/disk-prune.mjs');
  assert.ok(isOffLimits('/h/code/tandem-wt.noindex/x', '/h/.copilot/copilot-worktrees'));
  assert.ok(isOffLimits('/h/.copilot/copilot-worktrees/r/n', '/h/.copilot/copilot-worktrees'));
  assert.ok(isOffLimits('/h/Library/Application Support/housesitter/releases/shepherd/abc', '/h/.copilot/copilot-worktrees'));
  assert.ok(!isOffLimits('/h/code/CIT-pages-worktrees/x', '/h/.copilot/copilot-worktrees'));
});

test('real landed worktrees: squash-merged goes; unpushed, dirty, recent, tandem-wt and copilot-worktrees stay', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), { execFileSync } = await import('node:child_process');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-lw-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { encoding: 'utf8' });
  const origin = path.join(root, 'origin.git'), main = path.join(root, 'code', 'repo');
  fs.mkdirSync(path.join(root, 'code'));
  git(root, 'init', '-q', '--bare', '-b', 'main', origin); git(root, 'clone', '-q', origin, main);
  fs.writeFileSync(path.join(main, 'a'), '1'); git(main, 'add', 'a'); git(main, 'commit', '-qm', 'a'); git(main, 'push', '-q', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main');
  const wt = (dir, br, file, body) => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(main, 'worktree', 'add', '-q', '-b', br, dir);
    if (file) { fs.writeFileSync(path.join(dir, file), body); git(dir, 'add', file); git(dir, 'commit', '-qm', br); }
    return dir;
  };
  const wts = path.join(root, 'code', 'repo-worktrees');
  const squash = wt(path.join(wts, 'squash'), 'squash', 'x', 'same');
  const merged = wt(path.join(wts, 'pr'), 'pr', 'p', 'pr-content');
  const unpushed = wt(path.join(wts, 'unpushed'), 'unpushed', 'y', 'mine');
  const dirty = wt(path.join(wts, 'dirty'), 'dirty', 'z', 'zz');
  const recent = wt(path.join(wts, 'recent'), 'recent', 'r', 'rr');
  const tandem = wt(path.join(root, 'code', 'tandem-wt.noindex', 'k'), 'k', 'k', 'kk');
  const app = wt(path.join(root, '.copilot', 'copilot-worktrees', 'repo', 'n'), 'n', 'n', 'nn');
  // The squash merge: main gets the same content in a new commit, so HEAD is not its ancestor.
  fs.writeFileSync(path.join(main, 'x'), 'same'); git(main, 'add', 'x'); git(main, 'commit', '-qm', 'squash merge (#1)'); git(main, 'push', '-q', 'origin', 'main');
  for (const w of [squash, merged, unpushed, dirty, tandem, app, recent]) git(w, 'push', '-q', ...(w === unpushed ? ['--dry-run'] : []), 'origin', `${path.basename(w) === 'pr' ? 'pr' : 'HEAD'}`.replace('HEAD', `HEAD:refs/heads/keep-${path.basename(w)}`));
  fs.writeFileSync(path.join(dirty, 'untracked'), 'u');
  const old = (dir) => { const past = new Date(Date.now() - 3 * DAY); const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { if (e.name === '.git' && e.isDirectory()) continue; const f = path.join(p, e.name); if (e.isDirectory()) walk(f); fs.utimesSync(f, past, past); } fs.utimesSync(p, past, past); }; walk(dir); };
  for (const w of [squash, merged, unpushed, dirty, tandem, app]) old(w);
  fs.writeFileSync(path.join(wts, 'recent', 'now'), 'n');
  const gh = path.join(root, 'gh'); fs.writeFileSync(gh, '#!/bin/sh\ncat "$(dirname "$0")/pr.json"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'pr.json'), JSON.stringify([{ number: 7, headRefOid: git(merged, 'rev-parse', 'HEAD').trim() }]));
  const real = realDiskDeps({ home: root, state: path.join(root, 'st'), ghPath: gh, extraProtected: [main] });
  const log = [];
  const deps = {
    ...real, usage: () => ({ pct: 90, free: 10 * GIB, size: 926 * GIB }), tell: async () => {}, readState: () => ({}), writeState: () => {},
    sessionRows: async () => null, load: async () => {}, open: () => false, appWorktrees: () => new Set(),
    caches: () => [], scratch: () => [], junk: () => [], clones: () => [], worktrees: () => [], histories: () => [], leakedClones: () => [], ensureLeanHooks: () => {},
    ghCacheOld: () => [], size: () => 0,
  };
  const r = await pass({ force: true }, deps, (l) => log.push(l));
  const gone = [squash, merged].filter((w) => !fs.existsSync(w));
  assert.deepEqual(gone.sort(), [merged, squash].sort(), log.join('\n'));
  for (const w of [unpushed, dirty, recent, tandem, app]) assert.ok(fs.existsSync(w), `${w} must stay`);
  assert.ok(!git(main, 'worktree', 'list').includes('squash'));
  assert.ok(fs.existsSync(main), 'the protected primary clone stays, and does not shield its other worktrees');
  assert.deepEqual(r.reclaimed.landed.map((x) => x.why).sort(), ['PR #7 merged', 'every changed path matches origin/main']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('near the floor: a landed, clean worktree idle 2 h is kept when space is plentiful and removed within the margin; dirty, open and unlanded ones stay in both', async () => {
  const fsx = await import('node:fs'), osx = await import('node:os'), pathx = await import('node:path'), { execFileSync } = await import('node:child_process');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { encoding: 'utf8' });
  const run = async (freeGib) => {
    const root = fsx.realpathSync(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'dp-near-')));
    const origin = pathx.join(root, 'origin.git'), main = pathx.join(root, 'code', 'repo');
    fsx.mkdirSync(pathx.join(root, 'code'));
    git(root, 'init', '-q', '--bare', '-b', 'main', origin); git(root, 'clone', '-q', origin, main);
    fsx.writeFileSync(pathx.join(main, 'a'), '1'); git(main, 'add', 'a'); git(main, 'commit', '-qm', 'a'); git(main, 'push', '-q', 'origin', 'main');
    git(main, 'remote', 'set-head', 'origin', 'main');
    const wts = pathx.join(root, 'code', 'repo-worktrees');
    const mk = (name, landed) => {
      const dir = pathx.join(wts, name);
      fsx.mkdirSync(wts, { recursive: true });
      git(main, 'worktree', 'add', '-q', '-b', name, dir);
      if (!landed) { fsx.writeFileSync(pathx.join(dir, name), name); git(dir, 'add', name); git(dir, 'commit', '-qm', name); }
      return dir;
    };
    const clean = mk('clean', true), dirty = mk('dirty', true), busy = mk('busy', true), unlanded = mk('unlanded', false), fresh = mk('fresh', true);
    fsx.writeFileSync(pathx.join(dirty, 'untracked'), 'u');
    const twoHours = new Date(Date.now() - 2 * 3600000);
    for (const w of [clean, dirty, busy, unlanded]) for (const f of fsx.readdirSync(w, { withFileTypes: true })) fsx.utimesSync(pathx.join(w, f.name), twoHours, twoHours);
    for (const w of [clean, dirty, busy, unlanded]) fsx.utimesSync(w, twoHours, twoHours);
    const real = realDiskDeps({ home: root, state: pathx.join(root, 'st'), extraProtected: [main] });
    const deps = {
      ...real, usage: () => ({ pct: 80, free: freeGib * GIB, size: 926 * GIB }), tell: async () => {}, readState: () => ({}), writeState: () => {},
      sessionRows: async () => null, load: async () => {}, open: (x) => x === busy, appWorktrees: () => new Set(),
      caches: () => [], scratch: () => [], junk: () => [], clones: () => [], worktrees: () => [], histories: () => [], leakedClones: () => [], ensureLeanHooks: () => {},
      ghCacheOld: () => [], size: () => GIB,
    };
    const r = await pass({}, deps);
    const left = [clean, dirty, busy, unlanded, fresh].filter((w) => fsx.existsSync(w)).map((w) => pathx.basename(w)).sort();
    const listed = git(main, 'worktree', 'list');
    fsx.rmSync(root, { recursive: true, force: true });
    return { r, left, listed };
  };
  // 926 GiB volume: floor 185.2 GiB, margin 46.3 GiB, so the near zone ends at 231.5 GiB.
  const plenty = await run(300);
  assert.equal(plenty.r.action, 'ok');
  assert.deepEqual(plenty.left, ['busy', 'clean', 'dirty', 'fresh', 'unlanded'], 'plentiful space: nothing is released after 2 h');
  const near = await run(187);
  assert.equal(near.r.action, 'ok');
  assert.deepEqual(near.left, ['busy', 'dirty', 'fresh', 'unlanded'], 'near the floor: only the clean landed one goes');
  assert.ok(!near.listed.includes('/clean'), 'git forgot it');
  assert.equal(near.r.reclaimedBytes, GIB);
});

test('near the floor: the 1 h gate applies only within the margin, still needs an hour of quiet, and stops once free space is back above floor + margin', async () => {
  const { d, log } = fake({ freeGib: 520, landed: { '/c/two-hours': {}, '/c/recent': {} }, cloneAge: { '/c/two-hours': 2 * 3600000, '/c/recent': 600000 } });
  const r = await pass({}, d);
  assert.deepEqual(log.landed, ['/c/two-hours']);
  assert.deepEqual(r.keeps['landed worktrees'], { 'something in it changed in the last 1 hour': 1 });
  const plenty = fake({ freeGib: 560, landed: { '/c/two-hours': {} }, cloneAge: { '/c/two-hours': 2 * 3600000 } });
  await pass({}, plenty.d);
  assert.deepEqual(plenty.log.landed || [], []);
});

test('the pass row says what went and why the rest stayed, near the floor too', async () => {
  const { d } = fake({ freeGib: 520, landed: { '/c/old': {}, '/c/dirty': { dirty: true }, '/c/recent': {} }, cloneAge: { '/c/old': 2 * 3600000, '/c/dirty': 2 * 3600000, '/c/recent': 600000 } });
  const rows = []; d.passLog = (row) => rows.push(row);
  await pass({}, d);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].landed, [{ dir: '/c/old', bytes: 2 * GIB }]);
  assert.equal(rows[0].reclaimedBytes, 2 * GIB);
  assert.deepEqual(rows[0].keeps['landed worktrees'], { 'it has uncommitted or untracked changes': 1, 'something in it changed in the last 1 hour': 1 });
  assert.equal(rows[0].free, 520 * GIB);
  assert.ok('landed worktrees (near floor)' in rows[0].phases);
  for (const k of ['quiet', 'dirty', 'landed', 'size', 'remove']) assert.ok(`landed ${k}` in rows[0].phases, k);
});

test('scheduling: a pass between hourly ones only checks free space; the retention walk runs once an hour', async () => {
  const hist = [{ id: 'arch-1', file: '/s/arch-1/events.jsonl', size: 100 * 1048576, mtime: NOW - 9 * DAY }];
  const { d, log } = fake({ freeGib: 600, hist, archived: ['arch-1'], scratchOf: { 'arch-1': { id: 'arch-1', dir: '/s/arch-1', files: '/s/arch-1/files' } } });
  const calls = { rows: 0, compress: 0, gh: 0, quiet: 0 };
  const { sessionRows, compress, ghCacheOld, quietFor } = d;
  d.sessionRows = async () => { calls.rows++; return sessionRows(); };
  d.compress = async (...a) => { calls.compress++; return compress(...a); };
  d.ghCacheOld = (...a) => { calls.gh++; return ghCacheOld(...a); };
  d.quietFor = (...a) => { calls.quiet++; return quietFor(...a); };
  let now = NOW; d.now = () => now;
  let r = await pass({}, d);
  assert.equal(r.action, 'ok');
  assert.deepEqual(calls, { rows: 1, compress: 1, gh: 1, quiet: 1 }, 'the first pass does the retention');
  assert.equal(log.state.retentionAt, NOW);
  now = NOW + 10 * 60000;
  r = await pass({}, d);
  assert.equal(r.action, 'ok');
  assert.deepEqual(calls, { rows: 1, compress: 1, gh: 1, quiet: 1 }, 'ten minutes later it walks nothing');
  assert.deepEqual(Object.keys(r.phases), [], 'and has no slow phase');
  now = NOW + 61 * 60000;
  await pass({}, d);
  assert.deepEqual(calls, { rows: 2, compress: 2, gh: 2, quiet: 2 }, 'an hour on it does the retention again');
  assert.ok(log.state.retentionAt === NOW + 61 * 60000);
  await pass({ force: true }, d);
  assert.equal(calls.rows, 3, 'a forced pass always does it');
});

test('scheduling: under the floor the reclaiming stages run before the retention, and a pass records its phases', async () => {
  const order = [];
  const { d } = fake({ freeGib: 60, caches: ['/home/.npm/_cacache'], archived: ['arch-1'], hist: [{ id: 'arch-1', file: '/s/arch-1/events.jsonl', size: 100 * 1048576, mtime: NOW - 9 * DAY }] });
  const { remove, compress } = d;
  d.remove = (p) => { order.push(`remove ${p}`); return remove(p); };
  d.compress = async (...a) => { order.push('compress'); return compress(...a); };
  const rows = [];
  d.passLog = (row) => rows.push(row);
  const r = await pass({}, d);
  assert.ok(order.indexOf('remove /home/.npm/_cacache') < order.indexOf('compress'), 'the floor action is not held up by the slow retention');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].retention, true);
  assert.ok(r.ms >= 0 && 'compress histories' in r.phases && 'caches' in r.phases);
});

test('session index: an unchanged folder is not walked again; a changed one is', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-idx-'));
  try {
    const dir = path.join(root, 'sess'); fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), 'x');
    let walks = 0; const du = () => { walks++; return 1000; };
    const find = () => { walks++; return true; };
    const first = sessionIndex();
    assert.equal(first.size('s', dir, du), 1000);
    assert.equal(first.quiet('s', dir, 1000, find), true);
    assert.equal(first.heavy('s', dir, ['files', 'images'], du), 1000);
    assert.equal(walks, 3);
    const again = sessionIndex({ data: JSON.parse(JSON.stringify(first.data())) });
    assert.equal(again.size('s', dir, du), 1000);
    assert.equal(again.quiet('s', dir, 500, find), true, 'quiet for longer is quiet for less');
    assert.equal(again.heavy('s', dir, ['files', 'images'], du), 1000);
    assert.equal(walks, 3, 'nothing was re-read');
    assert.equal(again.stats.misses, 0);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), 'xyz');
    assert.equal(again.size('s', dir, du), 1000);
    assert.equal(walks, 4, 'a changed folder is walked again');
    assert.equal(again.quiet('s', dir, 500, () => { walks++; return false; }), false, 'a busy folder is asked each time');
    again.prune(new Set());
    assert.deepEqual(again.data(), {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('free space falling more than 3 GiB since the last pass measures where the bytes are at once, and the row names what grew', async () => {
  const prev = { at: NOW - 3 * 3600000, roots: { code: 100 * GIB, swap: 1 * GIB } };
  const bd = { top: [{ name: 'swap', size: 9 * GIB, grew: 8 * GIB }, { name: 'code', size: 100.5 * GIB, grew: 0.5 * GIB }, { name: 'caches', size: 5 * GIB, grew: -2 * GIB }] };
  const f = fake({ freeGib: 690, breakdown: bd }); let calls = 0; const inner = f.d.breakdown; f.d.breakdown = (p) => { calls++; assert.equal(p, prev); return inner(); };
  f.log.state = { lastFree: 700 * GIB, breakdown: prev, retentionAt: NOW };
  const rows = []; f.d.passLog = (r) => rows.push(r);
  await pass({}, f.d);
  assert.equal(calls, 1, 'measured at once, not in a day');
  assert.equal(rows[0].breakdown.why, 'free space fell');
  assert.equal(rows[0].breakdown.drop, 10 * GIB);
  assert.deepEqual(rows[0].breakdown.grew.map((x) => x.name), ['swap', 'caches'], 'only roots that moved by more than 1 GiB');
  assert.ok('breakdown (free space fell)' in rows[0].phases);
  assert.equal(f.log.state.lastFree, 690 * GIB);
  // a small fall, or a fall measured less than 30 minutes ago, stays cheap
  const g = fake({ freeGib: 698, breakdown: bd }); g.d.breakdown = () => { throw new Error('should not measure'); };
  g.log.state = { lastFree: 700 * GIB, breakdown: prev, retentionAt: NOW }; g.d.passLog = (r) => rows.push(r);
  await pass({}, g.d);
  const h = fake({ freeGib: 690, breakdown: bd }); h.d.breakdown = () => { throw new Error('too soon'); };
  h.log.state = { lastFree: 700 * GIB, breakdown: { ...prev, at: NOW - 600000 }, retentionAt: NOW };
  await pass({}, h.d);
  assert.equal(rows[1].breakdown, undefined);
});

test('a slow decline fires the breakdown once free space is 3 GiB below the last breakdown; a rise resets nothing; spacing holds', async () => {
  const MIN = 60000, bd = { top: [{ name: 'code', size: 100 * GIB, grew: 2 * GIB }] };
  const f = fake({ freeGib: 700, breakdown: bd }); let calls = 0; const inner = f.d.breakdown; f.d.breakdown = (p) => { calls++; return inner(p); };
  f.log.state = { lastFree: 700 * GIB, breakdown: { at: NOW - 3 * 3600000, free: 700 * GIB, roots: {} }, retentionAt: NOW };
  const rows = []; f.d.passLog = (r) => rows.push(r); f.d.dataUsed = () => 759 * GIB;
  const run = async (freeGib) => { f.d.usage = () => ({ pct: 50, free: freeGib * GIB, size: 1000 * GIB }); await pass({}, f.d); };
  for (const g of [699.4, 698.8, 698.2, 697.6]) { await run(g); assert.equal(calls, 0, `${g} GiB is within 3 GiB of the last breakdown`); }
  await run(699); await run(697.2); // a rise in between resets nothing
  assert.equal(calls, 0, '2.8 GiB below');
  await run(696.9);
  assert.equal(calls, 1, 'the pass that crosses 3 GiB below the last breakdown fires');
  const row = rows.at(-1);
  assert.equal(row.breakdown.fallSince.free, 700 * GIB);
  assert.equal(row.dataUsed, 759 * GIB);
  assert.equal(f.log.state.breakdown.free, 696.9 * GIB, 'the baseline moves to this breakdown');
  await run(693); assert.equal(calls, 1, 'a new 3 GiB fall counts from the new baseline');
  // within 30 minutes of the last breakdown the spacing holds
  const g = fake({ freeGib: 690, breakdown: bd }); g.d.breakdown = () => { throw new Error('too soon'); };
  g.log.state = { lastFree: 695 * GIB, breakdown: { at: NOW - 10 * MIN, free: 700 * GIB, roots: {} }, retentionAt: NOW };
  await pass({}, g.d);
});

test('a git that never answers keeps its worktree ("git did not answer"), the pass finishes, and every git runs without fsmonitor', async () => {
  const fsx = await import('node:fs'), osx = await import('node:os'), pathx = await import('node:path'), { execFileSync } = await import('node:child_process');
  const { realDiskDeps } = await import('../src/disk-prune.mjs');
  const root = fsx.realpathSync(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'dp-hang-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { encoding: 'utf8' });
  const origin = pathx.join(root, 'origin.git'), main = pathx.join(root, 'code', 'repo');
  fsx.mkdirSync(pathx.join(root, 'code'));
  git(root, 'init', '-q', '--bare', '-b', 'main', origin); git(root, 'clone', '-q', origin, main);
  fsx.writeFileSync(pathx.join(main, 'a'), '1'); git(main, 'add', 'a'); git(main, 'commit', '-qm', 'a'); git(main, 'push', '-q', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main');
  const wts = pathx.join(root, 'code', 'repo-worktrees');
  fsx.mkdirSync(wts);
  const hang = pathx.join(wts, 'hang'), fine = pathx.join(wts, 'fine');
  for (const w of [hang, fine]) git(main, 'worktree', 'add', '-q', '-b', pathx.basename(w), w);
  const past = new Date(Date.now() - 3 * DAY);
  for (const w of [hang, fine]) { for (const f of fsx.readdirSync(w, { withFileTypes: true })) fsx.utimesSync(pathx.join(w, f.name), past, past); fsx.utimesSync(w, past, past); }
  // A git that hangs on the one worktree, like one blocked on a dead fsmonitor daemon; every call is logged.
  const calls = pathx.join(root, 'calls.log'), wrapper = pathx.join(root, 'git');
  fsx.writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> '${calls}'\ncase "$*" in *"/hang "*|*"/hang") exec sleep 30;; esac\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  const rows = [];
  const real = realDiskDeps({ home: root, state: pathx.join(root, 'st'), gitPath: wrapper, gitMs: { read: 500 }, extraProtected: [main] });
  const deps = {
    ...real, usage: () => ({ pct: 90, free: 10 * GIB, size: 926 * GIB }), tell: async () => {}, readState: () => ({}), writeState: () => {}, passLog: (r) => rows.push(r),
    sessionRows: async () => null, open: () => false, appWorktrees: () => new Set(),
    caches: () => [], scratch: () => [], junk: () => [], clones: () => [], worktrees: () => [], histories: () => [], leakedClones: () => [], ensureLeanHooks: () => {},
    ghCacheOld: () => [], size: () => 0,
  };
  const t0 = Date.now();
  const r = await pass({ force: true }, deps, () => {});
  const took = Date.now() - t0;
  assert.ok(took < 15000, `the pass must not wait for the hung git (${took} ms)`);
  assert.ok(fsx.existsSync(hang), 'the worktree whose git did not answer is kept');
  assert.ok(!fsx.existsSync(fine), 'the other worktree is still judged and removed');
  assert.equal(r.keeps['landed worktrees']['git did not answer'], 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gitTimeouts.length, 1);
  assert.match(rows[0].gitTimeouts[0].cmd, /git -C .*\/hang status --porcelain/);
  const lines = fsx.readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length > 3);
  for (const l of lines) assert.ok(l.startsWith('-c core.fsmonitor=false '), `fsmonitor must be off: ${l}`);
  fsx.rmSync(root, { recursive: true, force: true });
});

test('a pass that would run for ever ends at its deadline, and its row says where', async () => {
  const landed = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`/c/w${i}`, {}]));
  const { d } = fake({ freeGib: 60, landed });
  const rows = [];
  d.passLog = (r) => rows.push(r);
  d.removeLanded = (x) => { const end = Date.now() + 25; while (Date.now() < end); return true; };
  const log = [];
  const r = await pass({ force: true, t: { passDeadline: 150 } }, d, (l) => log.push(l));
  assert.ok(r.reclaimed.landed.length > 0 && r.reclaimed.landed.length < 40, `some finished, not all: ${r.reclaimed.landed.length}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deadline.after, 'loose work');
  assert.equal(rows[0].landed.length, r.reclaimed.landed.length, 'what it finished is recorded');
  assert.ok(log.some((l) => /pass deadline/.test(l)));
});
