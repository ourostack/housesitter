// housesitter restart-copilot --disk-prune: below 80% nothing happens; above it only safe classes are pruned, and a
// worktree that a session uses, a process has open, or that changed in the last day is never removed, whatever its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHES, mayThinSession, pass, whyKeep, whyKeepCache, whyKeepSession } from '../src/disk-prune.mjs';

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
    branchDone: (x) => (over.done || []).includes(x),
    sessionPin: (x) => (over.pins || {})[x] || null,
    archiveSessions: async (x) => { log.archived = [...(log.archived || []), x]; return over.archiveFail ? { ok: false, error: 'refused' } : { ok: true }; },
    open: (x) => (over.wts?.[x]?.open) || (over.openFiles || []).includes(x),
    changedAt: (x) => NOW - (over.wts?.[x]?.ageMs ?? over.cloneAge?.[x] ?? 9 * DAY),
    git: (x) => ({ dirty: Boolean((over.wts?.[x] || over.gits?.[x] || {}).dirty), unpushed: Boolean((over.wts?.[x] || over.gits?.[x] || {}).unpushed) }),
    rescue: (x) => { log.rescued.push(x); return `/bundles/${x.split('/').pop()}`; },
    removeWorktree: (x) => { log.removed.push(x); free += 20 * GIB; },
    histories: () => over.hist || [],
    protectedBy: (x) => (over.protect || []).includes(x) ? 'launchd' : null,
    deadSessions: () => over.dead || [],
    quietFor: (dir) => (over.dead || []).find((x) => x.dir === dir).quietFor ?? Infinity,
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
  const f = fake({ caches: [pw] });
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
  const f = fake({ caches: [pw] });
  f.log.state = { caches: { [pw]: { removedAt: NOW - 8 * DAY } } };
  await pass({}, f.d);
  assert.deepEqual(f.log.cache, [pw]);
  assert.equal(f.log.state.caches[pw].removedAt, NOW);
  const g = fake({ caches: [pw] });
  await pass({ dry_run: true }, g.d);
  assert.equal(g.log.state.caches, undefined);
  assert.equal(whyKeepCache({ open: false, removedAt: NOW - 8 * DAY }, NOW), null);
  assert.match(whyKeepCache({ open: false, removedAt: NOW - 6 * DAY }, NOW), /came back/);
  assert.match(whyKeepCache({ open: true }, NOW), /open/);
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
