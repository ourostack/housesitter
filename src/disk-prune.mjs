// `housesitter restart-copilot --disk-prune`: keep free space above a floor (20% of the volume by default) with no model turns and
// nothing for an agent to remember. launchd runs one pass every ten minutes; a pass does nothing while free space is above
// the floor. Below it, it reclaims safe classes in this order and stops once free space is back at floor + 5% of the volume:
//   1. caches that rebuild themselves (npm, pip, Go, pnpm, Playwright, gh), except one a running process has open or one a
//      pass removed that came back within a week: that one is in use, and removing it again only buys a download
//   1a. lane build output: the Rust `target` folders (`**/engine/target`, or any `target` holding CACHEDIR.TAG) inside a lane checkout
//      (`/Volumes/LaneWork/work`, `~/.lane/work`, `~/.lane/work.noindex`) whose run is stopped (its `~/.lane/runs/<run>/copilot.pid` is
//      missing or names a dead process) and that no process has open; source, `.git`, worktrees and run state stay (see `reclaimLane`)
//   1b. landed worktrees: a linked git worktree anywhere (under ~/code, the desk, the CIT workspace) whose work is already on
//      the default branch on origin, with nothing uncommitted or untracked, nothing changed for 24 hours, no live process
//      or app session in it (one hour, not 24, in the margin above the floor: `nearQuiet`); removed with `git worktree remove` and logged with its size (see `landedWorktreeKeep`)
//   2. thin: a worktree whose session Shepherd reports idle (never busy) is made sparse with the repository's own
//      .github/scripts/lean-worktree.sh (images, video, audio and bundles leave the working tree and stay in Git;
//      modified and untracked files stay where they are)
//   3. the heavy parts (files/, images/) of a session the app no longer lists and nobody has touched for a week: its
//      history stays, compressed; a git checkout in it with unsaved work is saved under ~/AgentBundles/disk-rescue first
//   4. linked git worktrees (the app's own, and the ones agents keep under ~/code): a worktree goes only if no unarchived
//      app session has it, no running process has a file open under it, nothing in it changed in 24 hours, and it is not
//      something launchd runs from. A name never qualifies one. Unsaved work is saved to a bundle first.
//   5. agents' scratch under /private/tmp and in the per-user temp folder ($TMPDIR, /private/var/folders/*/*/T): an entry
//      I own that nothing has changed or opened for 24 hours (Apple's own com.apple.* entries are not ours)
//   5b. loose agent work under ~/code that is not a git checkout (art hunts, scratch folders, downloads): a folder with no
//      .git inside it that nothing has changed or opened for 3 days; a busy folder is looked into one level down
//   6. full clones agents left under ~/code or in a session's files/ that hold nothing Git does not: clean, no stash, no
//      second worktree, every branch on a remote, nothing open, untouched for 3 days (a clone is one `git clone` away)
//   7. the history of a session the app no longer lists, compressed, never deleted
//   The free-space check is the whole of an ordinary pass (about a second). The slow retention below walks the session
//   folders, so it runs at most once an hour (`retainEvery`), above the floor too, and under the floor it runs after the
//   reclaiming stages, never before them: the history of an archived session, compressed by Shepherd's compressHistory,
//   which refuses a live or open one (a finished history loses nothing, so it waits for nothing); files/ of an archived
//   session untouched for 72 h; gh cache entries older than 24 h (see `archivedQuiet`); the leaked code-sign clones of
//   Chromium browsers (see `leakedCloneQuiet`); the daily breakdown. Every pass records how long each phase took.
// Each hour it records free space in a ledger; each day it measures where the bytes are and says which sources grew,
// so the cause gets fixed and not only the symptom. A pass that finds nothing safe, or ends still under the floor, rests
// an hour before it scans again (under 50 GiB free every pass runs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { archive, compressHistory, deps as shepherdDeps } from '@ouro.bot/shepherd';
import { realDeps, snapshot, stateDir } from './copilot-app.mjs';
import { iso, readJson, realTell, writeJson } from './recovery.mjs';
import { withBlock } from './lean-hook.mjs';
import { sessionIndex } from './session-index.mjs';

export const DP = {
  // Free space below which a pass starts reclaiming is a share of the volume (the old backlog bar: keep it under 80% full),
  // not a fixed 500 GiB: on a 926 GiB disk that bar can never be met, so every pass was under it and cleared caches.
  floorPct: 0.2,
  safeMode: false, // a host's `disk_prune.safe_mode` limits a pass to regenerable caches, compressed histories and logs, and verified landed worktrees
  agencyLogQuiet: 24 * 3600000, // a closed Agency .log is gzipped in place only after this long untouched
  keepUnsaved: false, // a host's `disk_prune.keep_unsaved` keeps a worktree with unsaved work instead of saving it under ~/AgentBundles
  marginPct: 0.05, // it stops once free space is floor + this share
  floorFallback: 500 * 1073741824, // used only when the volume's size is unknown
  marginFallback: 50 * 1073741824,
  scratchQuiet: 3 * 3600000, // temp scratch is churned all day, so a full day of quiet would never come
  // Chromium browsers (Edge, Chrome) clone their own app bundle (about 1 GiB) into $TMPDIR/../X/<bundle id>.code_sign_clone/
  // for a signature check at launch, and delete the clone when they exit. A browser that is killed (a headless launch ended
  // by SIGKILL, a crash) leaves it behind, and a day of headless launches leaves hundreds of GiB. A running browser keeps
  // its clone open, so one nothing has open that is also this quiet is a leak, and it goes on every pass, above the floor too.
  leakedCloneQuiet: 3600000,
  quiet: 24 * 3600000, // a worktree or history changed within this is never touched
  nearQuiet: 3600000, // within `margin` above the floor, a landed worktree needs only this much quiet (every other gate holds)
  deadQuiet: 2 * 24 * 3600000, // the heavy parts of an unlisted session go only after this long untouched
  minHistory: 20 * 1048576, // smaller histories are not worth compressing
  nag: 24 * 3600000, // how often "still under the floor" may be said
  idleSessionQuiet: 3 * 24 * 3600000, // a listed session's regenerable files go only after the whole session folder was untouched this long
  junkQuiet: 3 * 24 * 3600000, // loose non-git work under ~/code goes only after this long untouched
  cloneQuiet: 3 * 24 * 3600000, // a full clone is removed only after this long untouched
  archivedQuiet: 72 * 3600000, // an archived session's files/ scratch goes only after its whole folder was untouched this long
  ghLookups: 25, // `gh pr list` calls one pass may spend asking whether a branch's PR merged
  ghCacheMaxAge: 24 * 3600000, // an entry in gh's HTTP response cache older than this goes
  retainEvery: 3600000, // the session-folder retention and the breakdown run at most this often; a pass between them only checks free space
  rest: 3600000, // after a pass that found nothing safe, or that ended still under the floor, the next scan waits this long
  urgent: 50 * 1073741824, // below this much free space a pass never rests
  cacheBack: 7 * 24 * 3600000, // a cache a pass removed that is back within this long is in use, and is kept
  ledgerEvery: 55 * 60000, // free space is recorded about hourly
  breakdownEvery: 24 * 3600000, // where the bytes are is measured daily
  dropBytes: 3 * 1073741824, // free space down by more than this since the previous pass measures where the bytes are at once
  triggerEvery: 30 * 60000, // but a fall-triggered measurement runs at most this often (it walks ~/Library and home)
  growRow: 1073741824, // a pass row names the roots whose growth since the last measurement is more than this
  gitRead: 60000, // every read-only git a pass spawns is killed after this; a git that did not answer is "unknown", and its worktree is kept
  gitRemove: 600000, // `git worktree remove` is given longer: it deletes a whole tree
  passDeadline: 20 * 60000, // a pass records what it finished and ends after this, so launchd can start the next one
};

const GIB = 1073741824;
export const gib = (b) => `${(b / GIB).toFixed(1)} GiB`;

// Caches that cost every lane minutes of download to rebuild: kept unless free space is urgent.
export const COSTLY_CACHES = ['Library/Caches/ms-playwright'];
export const floorOf = (t, size) => t.floor ?? (size ? Math.round(size * t.floorPct) : t.floorFallback);
export const marginOf = (t, size) => t.margin ?? (size ? Math.round(size * t.marginPct) : t.marginFallback);

// Ignored entries a build puts back (any depth): never counted as unsaved work.
const REBUILDABLE = /(^|\/)(node_modules|target|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.parcel-cache|\.gradle|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.tox|\.cache|\.DS_Store|[^/]*\.pyc)$/;
// Never reclaimed in safe mode, wherever it is met (worktree copies included).
export const HELD = /(^|\/)(AgentBundles|vault|tandem-wt\.noindex|vm-extra\.img)(\/|$)/i;
export const CACHES = ['.npm/_cacache', '.cache/gh', 'Library/Caches/ms-playwright', 'Library/Caches/pip', 'Library/Caches/go-build', 'Library/Caches/pnpm'];

// Why a worktree may not be removed now, or null when it may. `w`: { dir, linked, usedByApp, open, changedAt, protectedBy }.
export function whyKeep(w, now, t = DP) {
  if (!w.linked) return 'it is a main checkout, not a linked worktree';
  if (w.protectedBy) return `launchd or Housesitter runs from it (${w.protectedBy})`;
  if (w.usedByApp) return 'an unarchived app session uses it';
  if (w.open) return 'a running process has it open';
  if (!(now - w.changedAt >= t.quiet)) return 'something in it changed in the last 24 hours';
  return null;
}

// Why a linked worktree of a repository may not be removed as landed, or null when it may. `w`: { dir, protectedBy, usedByApp,
// open, quiet, dirty, landed }; the last three are asked in this order only while the earlier ones pass, since each costs more.
// The caller never lists a primary clone, ~/code/tandem-wt.noindex anything under ~/.copilot/copilot-worktrees, or a release folder `housesitter deploy` owns (see `isOffLimits`).
export const isOffLimits = (dir, copilotWorktrees) => dir.split('/').includes('tandem-wt.noindex') || dir.includes('/housesitter/releases/') || dir === copilotWorktrees || dir.startsWith(`${copilotWorktrees}/`);
export function landedWorktreeKeep(w, quietLabel = '24 hours') {
  if (w.protectedBy) return 'launchd or Housesitter runs from it';
  if (w.usedByApp()) return 'an unarchived app session uses it';
  if (w.open()) return 'a running process has it open';
  if (!w.quiet()) return `something in it changed in the last ${quietLabel}`;
  const dirty = w.dirty();
  if (w.hung?.()) return 'git did not answer';
  if (dirty) return 'it has uncommitted or untracked changes';
  const landed = w.landed();
  if (w.hung?.()) return 'git did not answer';
  if (!landed) return 'its work has not landed on the default branch';
  return null;
}

// Why a cache may not be removed now, or null when it may. `c`: { open, removedAt } (removedAt: when a pass last removed
// it, from disk-prune.json). The worktree rule "nothing changed for 24 hours" does not fit a cache: Playwright's
// browsers are only read while tests run, and APFS does not keep access times, so a cache in use looks quiet. What does
// show use is a removal undone: a pass removed it, and something put it back within a week. Then removing it again
// frees nothing for long and costs every lane a download, so it stays. Past the week it may go once more, so a cache
// nobody needs any more is not kept for ever; the worst case is one download a week, not one every ten minutes.
export function whyKeepCache(c, now, t = DP) {
  if (c.open) return 'a running process has a file open in it';
  if (c.costly && !c.urgent) return 'it costs every lane a download to rebuild, and free space is not urgent';
  if (c.removedAt != null && now - c.removedAt < t.cacheBack) return `it came back within ${Math.round(t.cacheBack / 86400000)} days of being removed, so something uses it`;
  return null;
}

// Why the heavy parts of a session folder may not go now, or null when they may. `s`: { live, open, quietFor }.
export function whyKeepSession(s, t = DP) {
  if (s.live) return 'the app lists it';
  if (s.open) return 'a running process has a file open in it';
  if (!(s.quietFor >= t.deadQuiet)) return 'something in it changed in the last 2 days';
  return null;
}

const top = (b) => (b?.top || []).slice(0, 3).map((x) => `${x.name} ${gib(x.size)}${x.grew > 0 ? ` (+${gib(x.grew)} in a day)` : ''}`).join('; ');

// One pass. deps are real (realDiskDeps) or fakes.
export async function pass(opts, deps, say = () => {}) {
  const t = { ...DP, ...(opts.t || {}) };
  const now = deps.now();
  const out = (m) => say(`${iso(now)} disk-prune: ${m}`);
  const st0 = deps.readState() || {};
  const before = deps.usage();
  const floor = floorOf(t, before.size), margin = marginOf(t, before.size);
  const stamp = (patch) => { if (!opts.dry_run) deps.writeState({ ...(deps.readState() || {}), ...patch }); };
  const started = Date.now();
  const phases = {};
  let last = Date.now();
  const timed = async (name, fn) => { const t0 = Date.now(); try { return await fn(); } finally { phases[name] = (phases[name] || 0) + (Date.now() - t0); last = Date.now(); } };
  const lap = (name) => { const n = Date.now(); phases[name] = (phases[name] || 0) + (n - last); last = n; };
  let rows;
  const getRows = async () => (rows === undefined ? (rows = (await deps.sessionRows?.()) || null) : rows);
  // Where the bytes are: daily, and at once (at most every `triggerEvery`) when free space fell by more than `dropBytes` since the
  // highest free space seen since the last breakdown (a slow decline counts, a recovery then a fall counts), so a drop names its owner. A cheap pass stays cheap: only the fall pays for the walk.
  let bdInfo = null, bdRan = false, deadlineAt = null;
  const runBreakdown = (why, extra = {}) => timed(why === 'daily' ? 'breakdown' : 'breakdown (free space fell)', async () => {
    const b = deps.breakdown?.(st0.breakdown); if (!b) return;
    stamp({ breakdown: { ...b, at: now, free: before.free }, peakFree: { at: now, free: before.free } }); bdRan = true;
    bdInfo = { why, since: st0.breakdown?.at ? iso(st0.breakdown.at) : null, ...extra, ...(fallBase ? { fallSince: { at: iso(fallBase.at), free: fallBase.free } } : {}), grew: (b.top || []).filter((x) => Math.abs(x.grew || 0) > t.growRow).map((x) => ({ name: x.name, size: x.size, grew: x.grew })) };
  });
  // The fall is measured from the highest free space seen since the last breakdown (the breakdown's own free space to begin with), so a
  // fall after a recovery counts; a state from before that was recorded falls back to the previous pass.
  const lastBd = typeof st0.breakdown?.free === 'number' ? { at: st0.breakdown.at, free: st0.breakdown.free } : null;
  const sawPeak = lastBd && typeof st0.peakFree?.free === 'number' && st0.peakFree.at >= lastBd.at ? st0.peakFree : null;
  let fallBase = lastBd && sawPeak && sawPeak.free > lastBd.free ? { at: sawPeak.at, free: sawPeak.free } : lastBd;
  if (fallBase && before.free > fallBase.free) { fallBase = { at: now, free: before.free }; if (!opts.dry_run) stamp({ peakFree: fallBase }); }
  else if (lastBd && !sawPeak && !opts.dry_run) stamp({ peakFree: fallBase });
  const dropped = fallBase ? fallBase.free - before.free : typeof st0.lastFree === 'number' ? st0.lastFree - before.free : 0;
  const needBreakdown = !opts.dry_run && dropped > t.dropBytes && !(now - (st0.breakdown?.at || 0) < t.triggerEvery);
  if (!opts.dry_run) stamp({ lastFree: before.free });
  let dataUsed = null;
  try { dataUsed = deps.dataUsed?.() ?? null; } catch { /* a courtesy */ }
  const retentionDue = Boolean(opts.force || opts.dry_run) || !(now - (st0.retentionAt || 0) < t.retainEvery);
  const record = async (res) => {
    if (needBreakdown && !bdRan) await runBreakdown('free space fell', { drop: dropped });
    const ms = Date.now() - started;
    // What the pass removed and why it kept the rest, so the log alone answers "what went, and what stayed".
    const gt = deps.gitTimeouts?.() || [];
    const row = { at: iso(now), action: res.action, retention: retentionDue, free: before.free, ...(dataUsed == null ? {} : { dataUsed }), after: res.after ?? (res.reclaimed?.landedBytes || res.reclaimed?.laneBytes ? deps.usage().free : before.free), ms, phases,
      reclaimedBytes: res.reclaimedBytes ?? 0, ...(bdInfo ? { breakdown: bdInfo } : {}), landed: (res.reclaimed?.landed || []).map((x) => ({ dir: x.dir, bytes: x.bytes })), laneBuild: (res.reclaimed?.laneBuild || []).map((x) => ({ dir: x.dir, bytes: x.bytes })), laneBytes: res.reclaimed?.laneBytes ?? 0, keeps: res.keeps || {},
      ...(gt.length ? { gitTimeouts: gt } : {}), ...(deadlineAt ? { deadline: { seconds: Math.round(t.passDeadline / 1000), after: deadlineAt } } : {}) };
    if (!opts.dry_run) { try { deps.passLog?.(row); } catch { /* a courtesy */ } }
    out(`pass took ${(ms / 1000).toFixed(1)} s (${res.action}${retentionDue ? ', with retention' : ', free-space check only'}${Object.keys(phases).length ? `: ${Object.entries(phases).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(', ')}` : ''})`);
    if (gt.length) out(`git did not answer within its timeout: ${gt.map((x) => `${x.cmd} (${x.seconds} s)`).join('; ')}`);
    if (deadlineAt) out(`pass deadline of ${Math.round(t.passDeadline / 60000)} min reached after ${deadlineAt}; what it finished is recorded, the rest waits for the next pass`);
    return { ...res, ms, phases };
  };

  if (!opts.dry_run) {
    if (!(now - (st0.ledgerAt || 0) < t.ledgerEvery)) { deps.ledger?.({ at: iso(now), free: before.free, pct: before.pct }); stamp({ ledgerAt: now }); }
  }
  const keeps = {};
  const keep = (cat, why) => { const c = (keeps[cat] ||= {}); c[why] = (c[why] || 0) + 1; };
  const reclaimed = { landed: [], landedBytes: 0, caches: 0, thin: 0, thinned: [], worktrees: [], clones: [], cloned: 0, scratch: 0, browserClones: 0, junk: [], junked: 0, laneBuild: [], laneBytes: 0, idle: [], idled: 0, sessions: 0, histories: 0, rescued: [] };
  // Retention for agent storage, at most hourly: it walks session folders. Only files/ of an archived session nobody has touched
  // for 72 hours: events.jsonl(.gz), session.db, images/ and checkpoints stay, so the app can still restore the session.
  // In safe mode a consumer is looked for again, with a fresh lsof, right before each mutation; an lsof that fails counts as open.
  const isOpen = (p) => (t.safeMode ? (deps.openFresh ? deps.openFresh(p) : true) : deps.open(p));
  const retained = { archivedFiles: 0, ghCache: 0, agencyLogs: 0 };
  let retainedTotal = 0;
  const retain = async () => {
    if (!opts.dry_run && !t.safeMode) await timed('lean hooks', async () => { try { deps.ensureLeanHooks?.(); } catch { /* a courtesy; the pass goes on */ } });
    const rows = await timed('session rows', getRows);
    await timed('archived files/', async () => {
      for (const id of t.safeMode ? [] : rows?.archived || []) {
        if (late()) break;
        if (rows.live.has(id)) continue;
        const s = deps.archivedScratch?.(id);
        if (!s) continue;
        if (deps.open(s.dir) || deps.open(s.files)) { keep('archived scratch', 'a process has it open'); continue; }
        if (!(deps.quietFor(s.dir, t.archivedQuiet) >= t.archivedQuiet)) { keep('archived scratch', 'changed within 72 h'); continue; }
        const n = deps.size(s.files);
        if (!opts.dry_run) { try { deps.remove(s.files); } catch (e) { out(`could not remove files/ of archived session ${id.slice(0, 8)}: ${e.message}`); continue; } }
        retained.archivedFiles += n; out(`${opts.dry_run ? 'would remove' : 'removed'} files/ of archived session ${id.slice(0, 8)}: ${gib(n)}`);
      }
    });
    await timed('gh cache', async () => {
      for (const e of deps.ghCacheOld?.(now - t.ghCacheMaxAge) || []) {
        if (!opts.dry_run) { try { deps.remove(e.path); } catch (er) { out(`could not remove gh cache entry ${e.path}: ${er.message}`); continue; } }
        retained.ghCache += e.size;
      }
    });
    if (retained.ghCache) out(`${opts.dry_run ? 'would remove' : 'removed'} gh cache entries older than 24 h: ${gib(retained.ghCache)}`);
    // Closed Agency logs: gzipped in place (CRC-checked, mode and mtime kept), never deleted. Only *.log one level down, quiet for a day and not open.
    await timed('agency logs', async () => {
      let files = 0;
      for (const f of deps.agencyLogs?.(now - t.agencyLogQuiet) || []) {
        if (late()) break;
        if (isOpen(f.path)) continue;
        let saved = f.size;
        if (!opts.dry_run) { try { saved = deps.gzipLog(f.path); } catch (e) { out(`could not compress log ${f.path}: ${e.message}`); continue; } }
        retained.agencyLogs += saved; files++;
      }
      if (files) out(`${opts.dry_run ? 'would compress' : 'compressed'} ${files} closed Agency log(s): ${gib(retained.agencyLogs)}`);
    });
    retainedTotal = retained.archivedFiles + retained.ghCache + retained.agencyLogs;
    if (retainedTotal) out(`${opts.dry_run ? 'would reclaim' : 'reclaimed'} ${gib(retainedTotal)} of agent storage (archived files/ ${gib(retained.archivedFiles)}, gh cache ${gib(retained.ghCache)}, Agency logs ${gib(retained.agencyLogs)})`);

    await timed('compress histories', async () => {
      for (const id of rows?.archived || []) {
        if (late()) break;
        if (rows.live.has(id)) continue;
        const r = await deps.compress(id, { dryRun: Boolean(opts.dry_run) });
        if (!r.ok) continue;
        const saved = opts.dry_run ? r.before : r.before - r.after;
        reclaimed.histories += saved; out(`${opts.dry_run ? 'would compress' : 'compressed'} the history of archived session ${id.slice(0, 8)}: ${gib(saved)}`);
      }
    });

    await timed('browser clones', async () => {
      const leaked = [];
      for (const dir of deps.leakedClones?.() || []) {
        if (now - (deps.mtimeOf?.(dir) ?? deps.changedAt(dir)) < t.leakedCloneQuiet) { keep('browser clones', 'changed within 1 h'); continue; }
        if (isOpen(dir)) { keep('browser clones', 'a browser has it open'); continue; }
        const n = deps.size(dir);
        if (!opts.dry_run) { try { deps.remove(dir); } catch (e) { out(`could not remove browser clone ${dir}: ${e.message}`); continue; } }
        leaked.push(dir); reclaimed.browserClones += n;
      }
      if (leaked.length) out(`${opts.dry_run ? 'would remove' : 'removed'} ${leaked.length} leaked browser code-sign clone(s): ${gib(reclaimed.browserClones)}`);
    });

    // Where the bytes are, daily; last, so the slowest measurement never delays a reclaim.
    if (!opts.dry_run && !bdRan && !(now - (st0.breakdown?.at || 0) < t.breakdownEvery)) await runBreakdown('daily');
    stamp({ retentionAt: now, ...(retainedTotal ? { retention: { at: iso(now), reclaimedBytes: retainedTotal, ...retained } } : {}) });
  };

  const expired = () => Date.now() - started > t.passDeadline;
  // Every stage loop asks this to stop; past the deadline the pass records what it finished and ends.
  const late = () => { if (!expired()) return false; deadlineAt ??= Object.keys(phases).pop() ?? 'start'; return true; };
  const done = () => late() || deps.usage().free >= floor + margin;
  // Linked worktrees agents made with `git worktree add` whose work is already on origin's default branch (a squash merge
  // included). Cheap rules first; a kept one is only counted, since a Mac holds hundreds. Near the floor the idle gate is shorter.
  const reclaimLanded = (quietMs, quietLabel) => {
    // Off in safe mode: landedWhy() fetches into the shared git metadata of a primary checkout and cannot prove every local commit is on a remote.
    if (t.safeMode) return;
    const used = deps.appWorktrees();
    reclaimed.landed = []; reclaimed.landedBytes = 0;
    // Where the loop's time goes, by step, so a slow pass says which check was slow (these add to the phase that holds the loop).
    const steps = {};
    const step = (name, fn) => { const t0 = Date.now(); try { return fn(); } finally { steps[name] = (steps[name] || 0) + (Date.now() - t0); } };
    for (const w of deps.landedWorktrees?.() || []) {
      if (done()) break;
      if (t.safeMode && HELD.test(w.dir)) { keep('landed worktrees', 'it is under AgentBundles, a vault or a held path'); continue; }
      let landedBy = null;
      const why = landedWorktreeKeep({
        protectedBy: (deps.protectedDirect || deps.protectedBy)?.(w.dir), usedByApp: () => used.has(w.dir), open: () => step('open', () => deps.open(w.dir)),
        quiet: () => step('quiet', () => (deps.quietSince ? deps.quietSince(w.dir, quietMs) : now - deps.changedAt(w.dir) >= quietMs)),
        dirty: () => step('dirty', () => deps.dirty(w.dir)), hung: () => Boolean(deps.gitHung?.(w.dir)), landed: () => step('landed', () => { landedBy = deps.landedWhy(w.dir); return Boolean(landedBy); }),
      }, quietLabel);
      if (why) { keep('landed worktrees', why); continue; }
      const n = step('size', () => deps.size(w.dir));
      if (!opts.dry_run && !step('remove', () => deps.removeLanded(w.dir))) { out(`could not remove landed worktree ${w.dir}`); continue; }
      reclaimed.landed.push({ dir: w.dir, bytes: n, why: landedBy }); reclaimed.landedBytes += n;
      out(`${opts.dry_run ? 'would remove' : 'removed'} landed worktree ${w.dir}: ${gib(n)} (${landedBy})`);
    }
    for (const [k, v] of Object.entries(steps)) phases[`landed ${k}`] = v;
    if (reclaimed.landed.length) out(`${opts.dry_run ? 'would reclaim' : 'reclaimed'} ${gib(reclaimed.landedBytes)} from ${reclaimed.landed.length} landed worktree(s)`);
  };

  // Rust build output in the lane pool's checkouts: a stopped run's `target` is rebuilt by its next build, and a live run (its
  // copilot.pid names a live process) or one a process has open is never touched. Only the `target` folder goes.
  const reclaimLane = () => {
    // Off in safe mode: nothing here proves an engine/target folder is ignored, regenerable output.
    if (t.safeMode) return;
    const openRun = new Map();
    for (const x of deps.laneBuildOutputs?.() || []) {
      if (done()) break;
      if (x.alive) { keep('lane build output', 'its run is live (copilot.pid)'); continue; }
      if (!openRun.has(x.runDir)) openRun.set(x.runDir, deps.open(x.runDir));
      if (openRun.get(x.runDir)) { keep('lane build output', 'a process has the run open'); continue; }
      const n = deps.size(x.dir);
      if (!opts.dry_run) { try { deps.remove(x.dir); } catch (e) { out(`could not remove lane build output ${x.dir}: ${e.message}`); continue; } }
      reclaimed.laneBuild.push({ dir: x.dir, bytes: n }); reclaimed.laneBytes += n;
      out(`${opts.dry_run ? 'would remove' : 'removed'} lane build output ${x.dir}: ${gib(n)}`);
    }
    if (reclaimed.laneBuild.length) out(`${opts.dry_run ? 'would reclaim' : 'reclaimed'} ${gib(reclaimed.laneBytes)} from ${reclaimed.laneBuild.length} lane build output folder(s)`);
  };

  reclaimed.retention = retained;
  if (before.free >= floor && !opts.force) {
    if (retentionDue) await retain();
    // Within `margin` above the floor the next busy hour can cross it, and lane worktrees add about 1 GiB each: release landed ones after an hour.
    if (retentionDue && before.free < floor + margin) {
      await timed('lane build output (near floor)', async () => { await deps.load?.(); reclaimLane(); });
      await timed('landed worktrees (near floor)', async () => { reclaimLanded(t.nearQuiet, '1 hour'); });
    }
    return await record({ action: 'ok', free: before.free, reclaimed, reclaimedBytes: retainedTotal + reclaimed.landedBytes + reclaimed.laneBytes, keeps });
  }
  if (!opts.force && !opts.dry_run && before.free >= t.urgent && now < (st0.restUntil || 0)) {
    if (retentionDue) await retain();
    return await record({ action: 'resting', free: before.free });
  }

  await timed('load app state', async () => deps.load?.());
  const used = deps.appWorktrees();

  const kept = [];
  for (const c of deps.caches()) {
    if (done()) break;
    const n = deps.size(c); if (!n) continue;
    const rec = (deps.readState() || {}).caches?.[c] || {};
    const why = whyKeepCache({ open: isOpen(c), removedAt: rec.removedAt, costly: COSTLY_CACHES.some((x) => c.endsWith(x)), urgent: before.free < t.urgent }, now, t);
    if (why) {
      if (!rec.said) { out(`kept cache ${c} (${gib(n)}): ${why}`); kept.push(c); }
      continue;
    }
    // A cache another process is writing can refuse to go (ENOTEMPTY); that must not end the pass.
    if (!opts.dry_run) {
      try { deps.remove(c); } catch (e) { out(`could not remove cache ${c}: ${e.message}`); continue; }
      stamp({ caches: { ...(deps.readState() || {}).caches, [c]: { removedAt: now } } });
    }
    reclaimed.caches += n; out(`cache ${c}: ${gib(n)}`);
  }

  lap('caches');
  // Scratch is cheap to judge and often the biggest yield, so it goes before the slow per-worktree stages.
  if (t.safeMode) out('safe mode: scratch, loose work, session files, thinning, worktrees, clones and lane build output are left alone');
  for (const dir of t.safeMode ? [] : deps.scratch?.() || []) {
    if (done()) break;
    if (deps.protectedBy?.(dir)) { keep('scratch', 'launchd or Housesitter runs from it'); continue; }
    if (deps.open(dir)) { keep('scratch', 'a process has it open'); continue; }
    const quiet = deps.quietSince ? deps.quietSince(dir, t.scratchQuiet) : now - deps.changedAt(dir) >= t.scratchQuiet;
    if (!quiet) { keep('scratch', 'changed within 3 h'); continue; }
    const n = deps.size(dir);
    if (!n) continue;
    if (!opts.dry_run) { try { deps.remove(dir); } catch (e) { out(`could not remove scratch ${dir}: ${e.message}`); continue; } }
    reclaimed.scratch += n; out(`removed scratch ${dir}: ${gib(n)}`);
  }

  lap('scratch');
  for (const dir of t.safeMode ? [] : deps.junk?.() || []) {
    if (done()) break;
    const jwhy = deps.protectedBy?.(dir) ? 'launchd or Housesitter runs from it' : used.has(dir) ? 'a session uses it' : deps.open(dir) ? 'a process has it open' : !(now - deps.changedAt(dir, 3) >= t.junkQuiet) ? 'changed within 3 days' : null;
    if (jwhy) { keep('loose', jwhy); continue; }
    const n = deps.size(dir);
    if (!opts.dry_run) { try { deps.remove(dir); } catch (e) { out(`could not remove ${dir}: ${e.message}`); continue; } }
    reclaimed.junk.push(dir); reclaimed.junked += n; out(`removed loose work ${dir}: ${gib(n)}`);
  }

  lap('loose work');
  reclaimLane();

  lap('lane build output');
  // Linked worktrees agents made with `git worktree add` whose work is already on origin's default branch (a squash merge
  // included). Cheap rules first; a kept one is only counted, since a Mac holds hundreds.
  reclaimLanded(t.quiet, '24 hours');

  lap('landed worktrees');
  const idle = deps.idleSessions?.() || new Set();
  for (const w of t.safeMode ? [] : deps.thinnable?.() || []) {
    if (done()) break;
    if (!idle.has(w.session)) { out(`kept ${w.dir} thick: its session is not idle`); continue; }
    if (opts.dry_run) { out(`would thin ${w.dir}`); reclaimed.thinned.push(w.dir); continue; }
    const n = deps.size(w.dir);
    if (!deps.thin(w.dir)) { out(`could not thin ${w.dir}`); continue; }
    const saved = Math.max(0, n - deps.size(w.dir));
    reclaimed.thinned.push(w.dir); reclaimed.thin += saved; out(`thinned ${w.dir}: ${gib(saved)}`);
  }

  lap('thin');
  const live = deps.liveSessions();
  for (const sdir of t.safeMode ? [] : deps.deadSessions?.() || []) {
    if (done()) break;
    const why = whyKeepSession({ live: live.has(sdir.id), open: deps.open(sdir.dir), quietFor: deps.quietFor(sdir.dir) }, t);
    if (why) continue;
    const n = sdir.heavy.reduce((a, h) => a + deps.size(h), 0); if (!n) continue;
    if (!opts.dry_run) {
      let unknown = false;
      for (const c of deps.clonesIn(sdir.heavy)) {
        let b = null;
        try {
          const g = deps.git(c);
          if (g.unknown) unknown = true;
          else if (g.dirty || g.unpushed) { if (t.keepUnsaved) unknown = true; else b = deps.rescue(c); }
        } catch { unknown = true; }
        if (b) { reclaimed.rescued.push(b); out(`saved ${c}'s unsaved work to ${b}`); }
      }
      if (unknown) { keep('unlisted sessions', 'git did not answer or it holds unsaved work'); out(`kept the files of unlisted session ${sdir.id.slice(0, 8)}: git did not answer or it holds unsaved work`); continue; }
      for (const h of sdir.heavy) deps.remove(h);
    }
    reclaimed.sessions += n; out(`dropped the files of unlisted session ${sdir.id.slice(0, 8)}: ${gib(n)}`);
  }

  lap('unlisted sessions');
  // A listed session nobody is running, with no automation, untouched for days: only what a build or a clone gives back.
  // Dependency folders always; a clone only when every branch is on a remote and nothing is uncommitted. History stays.
  for (const s of t.safeMode ? [] : deps.idleSessionFiles?.() || []) {
    if (done()) break;
    if (deps.open(s.dir)) { out(`kept session ${s.id.slice(0, 8)}'s files: a running process has them open`); continue; }
    let n = 0;
    for (const d of deps.regenIn(s.files)) {
      const b = deps.size(d); if (!b) continue;
      if (!opts.dry_run) { try { deps.remove(d); } catch (e) { out(`could not remove ${d}: ${e.message}`); continue; } }
      n += b; out(`${opts.dry_run ? 'would remove' : 'removed'} ${d}: ${gib(b)}`);
    }
    for (const c of deps.clonesIn([s.files])) {
      if (deps.protectedBy?.(c) || deps.clone(c).unique) { out(`kept clone ${c}: it holds work that is not on a remote`); continue; }
      const b = deps.size(c); if (!b) continue;
      if (!opts.dry_run) { try { deps.remove(c); } catch (e) { out(`could not remove ${c}: ${e.message}`); continue; } }
      n += b; out(`${opts.dry_run ? 'would remove' : 'removed'} clone ${c}: ${gib(b)}`);
    }
    if (n) { reclaimed.idle.push(s.id); reclaimed.idled += n; }
  }

  lap('idle sessions');
  for (const dir of t.safeMode ? [] : deps.worktrees()) {
    if (done()) break;
    // A session still lists the worktree, but its branch is merged or gone: the work is on the remote, so only the quiet and open rules remain.
    // Never when the session is running, has an automation, coordinates others or is a drain target: its wake would find no folder.
    const pin = used.has(dir) ? (deps.sessionPin ? deps.sessionPin(dir) : 'session state unknown') : null;
    const finished = used.has(dir) && !pin && !deps.protectedBy?.(dir) && Boolean(deps.branchDone?.(dir));
    const w = { dir, linked: deps.linked(dir), usedByApp: used.has(dir) && !finished, open: false, changedAt: 0, protectedBy: deps.protectedBy?.(dir) || null };
    if (w.linked && !w.usedByApp && !w.protectedBy) { w.open = deps.open(dir); if (!w.open) w.changedAt = deps.changedAt(dir); }
    const why = whyKeep(w, now, t);
    if (why) { keep('worktrees', pin || why); out(`kept ${dir}: ${why}${pin ? ` (${pin})` : ''}`); continue; }
    const n = deps.size(dir);
    if (!opts.dry_run) {
      let g, b = null;
      try {
        g = deps.git(dir);
        if (!g.unknown && (g.dirty || g.unpushed)) { if (t.keepUnsaved) g = { unknown: true }; else b = deps.rescue(dir); }
      } catch { g = { unknown: true }; }
      if (g.unknown) { keep('worktrees', 'git did not answer or it holds unsaved work'); out(`kept ${dir}: git did not answer or it holds unsaved work`); continue; }
      if (b) { reclaimed.rescued.push(b); out(`saved ${dir}'s unsaved work to ${b}`); }
      // A session that still lists the folder is archived first (reversible), so none is left pointing at a missing folder.
      if (used.has(dir)) { const a = await deps.archiveSessions(dir); if (!a.ok) { out(`kept ${dir}: could not archive its session first (${a.error})`); continue; } }
      deps.removeWorktree(dir);
    }
    reclaimed.worktrees.push(dir); out(`removed worktree ${dir}: ${gib(n)}`);
  }


  lap('worktrees');
  for (const dir of t.safeMode ? [] : deps.clones?.() || []) {
    if (done()) break;
    const why = deps.protectedBy?.(dir) ? 'launchd or Housesitter runs from it' : used.has(dir) ? 'an unarchived app session uses it' : deps.open(dir) ? 'a running process has it open' : !(now - deps.changedAt(dir) >= t.cloneQuiet) ? 'something in it changed in the last 3 days' : deps.clone(dir).unique ? 'it holds work that is not on a remote' : null;
    if (why) { keep('clones', why); out(`kept clone ${dir}: ${why}`); continue; }
    const n = deps.size(dir);
    if (!opts.dry_run) deps.remove(dir);
    reclaimed.clones.push(dir); reclaimed.cloned += n; out(`removed clone ${dir}: ${gib(n)}`);
  }

  // Only a session the app does not list at all: an archived one was compressed above, and a live one is never touched.
  lap('clones');
  const hlive = deps.liveSessions();
  const hrows = await getRows();
  for (const h of deps.histories()) {
    if (done()) break;
    if (!hrows || hrows.known.has(h.id) || hlive.has(h.id) || now - h.mtime < t.quiet || h.size < t.minHistory || isOpen(h.file)) continue;
    const r = await deps.compress(h.id, { dryRun: Boolean(opts.dry_run) });
    if (!r.ok) continue;
    const saved = opts.dry_run ? r.before : r.before - r.after;
    reclaimed.histories += saved; out(`${opts.dry_run ? 'would compress' : 'compressed'} the history of unlisted session ${h.id.slice(0, 8)}: ${gib(saved)}`);
  }

  lap('unlisted histories');
  if (retentionDue) await retain();
  const after = deps.usage();
  const total = retainedTotal + reclaimed.scratch + reclaimed.browserClones + reclaimed.junked + reclaimed.landedBytes + reclaimed.laneBytes + reclaimed.idled + reclaimed.cloned + reclaimed.caches + reclaimed.histories + reclaimed.sessions + reclaimed.thinned.length;
  const res = { action: reclaimed.worktrees.length || reclaimed.landed.length || reclaimed.laneBuild.length || total ? 'pruned' : 'nothing-safe', before: before.free, after: after.free, reclaimed, reclaimedBytes: total - reclaimed.thinned.length + reclaimed.thin, keptCaches: kept, keeps, dry_run: Boolean(opts.dry_run) };
  if (opts.dry_run) return await record(res);
  const st = deps.readState() || {};
  const growers = top(st.breakdown);
  const why = Object.entries(keeps).map(([c, r]) => `${c}: ${Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ')}`).join('; ');
  if (why) out(`kept, by reason (${why})`);
  const tail = `${why ? ` Kept, by reason: ${why}.` : ''}${kept.length ? ` Kept ${kept.length} cache(s) in use (${kept.map((c) => path.basename(c)).join(', ')}): removing them again would only make the next run download them.` : ''}${growers ? ` Biggest sources: ${growers}.` : ''}`;
  if (res.action === 'pruned') {
    await deps.tell(`Free space was ${gib(before.free)}, below the ${gib(floor)} floor; disk prune reclaimed caches ${gib(reclaimed.caches)}, ${reclaimed.thinned.length} idle worktree(s) made sparse (${gib(reclaimed.thin)}), files of unlisted sessions ${gib(reclaimed.sessions)}, ${reclaimed.laneBuild.length} lane build output folder(s) (${gib(reclaimed.laneBytes)}), ${reclaimed.landed.length} landed worktree(s) (${gib(reclaimed.landedBytes)}), ${reclaimed.worktrees.length} unused worktree(s), ${reclaimed.clones.length} rebuildable clone(s) (${gib(reclaimed.cloned)}), scratch in the temp folders ${gib(reclaimed.scratch)}, ${reclaimed.junk.length} loose folder(s) of old work under ~/code (${gib(reclaimed.junked)}), regenerable files of ${reclaimed.idle.length} idle session(s) (${gib(reclaimed.idled)}), compressed histories ${gib(reclaimed.histories)}; now ${gib(after.free)} free.${reclaimed.rescued.length ? ` Unsaved work from ${reclaimed.rescued.length} worktree(s) was saved under ~/AgentBundles/disk-rescue.` : ''}${after.free < floor ? ' Still under the floor: what is left is not safe to prune without Ari.' : ''}${tail}`);
    st.toldAt = now;
  } else if (now - (st.toldAt || 0) >= t.nag || kept.length) {
    await deps.tell(`Free space is ${gib(after.free)}, under the ${gib(floor)} floor, and disk prune found nothing safe to remove. What is left belongs to Ari or to live sessions.${tail}`);
    st.toldAt = now;
  }
  // Told, so not again: launchd runs with --quiet, so this message is the only place a keep is said.
  if (kept.length) st.caches = { ...st.caches, ...Object.fromEntries(kept.map((c) => [c, { ...st.caches?.[c], said: true }])) };
  // A pass that ends still under the floor rests too: the next one, ten minutes later, would scan the same disk (lsof,
  // du, find on a loaded Mac) to find the same nothing. Only when space is critically low does every pass run.
  if (res.action === 'nothing-safe' || (after.free < floor && after.free >= t.urgent)) st.restUntil = now + t.rest; else delete st.restUntil;
  const rec = await record(res);
  deps.writeState({ ...st, ...(retainedTotal ? { retention: { at: iso(now), reclaimedBytes: retainedTotal, ...retained } } : {}), lastPass: { at: iso(now), ...rec } });
  return rec;
}

// ---------- the real world ----------

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...o });
const nice = (cmd, args, o) => sh('/usr/bin/nice', ['-n', '10', cmd, ...args], o);
const sizeOf = (p) => { const r = sh('/usr/bin/du', ['-sk', p], { timeout: 300000 }); return (Number(String(r.stdout).split(/\s+/)[0]) || 0) * 1024; };

// Run folders of the lane pool: each holds one run's checkouts, and `<laneHome>/runs/<run>/copilot.pid` names its live process.
// A pid file that is missing or names a dead process is a stopped run; one that cannot be read as a pid counts as live.
export function pidAlive(file) {
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const pid = Number.parseInt(txt.trim(), 10);
  if (!(pid > 0)) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Rust build output inside a run's checkouts (including nested ones such as test/.tmp-lane-*-worktree): a `target` folder that is
// `engine/target` or holds CACHEDIR.TAG. Never descends into `.git`, `node_modules`, symlinks or the folders it returns.
export function laneBuildOutputsIn(runDir, maxDepth = 8) {
  const found = [];
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.name === 'target') { if (path.basename(dir) === 'engine' || fs.existsSync(path.join(p, 'CACHEDIR.TAG'))) found.push(p); continue; }
      if (depth < maxDepth) walk(p, depth + 1);
    }
  };
  walk(runDir, 1);
  return found;
}

// The other APFS volumes of the container that holds the Data volume, beyond Data and VM, that are mounted: [{ name, used }].
// `apfs` is `diskutil apfs list -plist` as JSON; `mounted` is the set of mounted device identifiers (disk3s7).
export function siblingVolumes(apfs, mounted) {
  const out = [];
  for (const c of apfs?.Containers || []) {
    const vols = c.Volumes || [];
    if (!vols.some((v) => (v.Roles || []).includes('Data'))) continue;
    for (const v of vols) {
      if ((v.Roles || []).some((r) => r === 'Data' || r === 'VM') || !mounted.has(v.DeviceIdentifier)) continue;
      if (v.Name && Number.isFinite(v.CapacityInUse)) out.push({ name: v.Name, used: v.CapacityInUse });
    }
  }
  return out;
}

// A listed session is a candidate for losing regenerable files only when nothing runs it and no automation will wake it.
export const mayThinSession = (id, { live, running, automated }) => live.has(id) && !running.has(id) && !automated.has(id);

// The common git directory of the repository holding d, read from the files git keeps (a `.git` directory, or a `.git` file
// saying `gitdir:` plus the `commondir` file), so no process is started; null when d is in no repository.
export function gitCommonDir(d) {
  for (let cur = path.resolve(d); ; cur = path.dirname(cur)) {
    const g = path.join(cur, '.git');
    try {
      const st = fs.statSync(g);
      let dir = g;
      if (st.isFile()) {
        const m = fs.readFileSync(g, 'utf8').match(/^gitdir:\s*(.+)$/m); if (!m) return null;
        dir = path.resolve(cur, m[1].trim());
        try { dir = path.resolve(dir, fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
      }
      return fs.realpathSync(dir);
    } catch { /* keep climbing */ }
    if (cur === path.dirname(cur)) return null;
  }
}

// Sessions that Desk's issue drains wake: every session id named in its drain config (generated or by hand).
export function drainTargets(home) {
  const ids = new Set();
  for (const f of [path.join(home, '.local', 'state', 'ouroboros-skills', 'desk', 'drains', 'config.json'), path.join(home, '.config', 'desk', 'issue-watch.json')]) {
    try { for (const m of fs.readFileSync(f, 'utf8').matchAll(/"session"\s*:\s*"([0-9a-f-]{36})"/g)) ids.add(m[1]); } catch { /* none */ }
  }
  return ids;
}

// A fresh lsof for one path (a folder includes what is under it). Only "found nothing" (status 1, no output) means closed; any other result counts as open.
export function realOpenFresh(p) {
  let isDir = false; try { isDir = fs.statSync(p).isDirectory(); } catch { return false; }
  const r = spawnSync('/usr/sbin/lsof', ['-nP', '-w', '-F', 'p', ...(isDir ? ['+D', p] : ['--', p])], { encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status === null) return true;
  return !(r.status === 1 && !r.stdout.trim());
}
export function realDiskDeps({ home = os.homedir(), copilotHome = path.join(home, '.copilot'), state = stateDir(home), volume = '/System/Volumes/Data', extraProtected = [], ghPath = null, gitPath = '/usr/bin/git', gitMs = {}, keepIgnored = false, openFresh = realOpenFresh, laneHome = path.join(home, '.lane'), laneRoots = ['/Volumes/LaneWork/work', path.join(laneHome, 'work'), path.join(laneHome, 'work.noindex')] } = {}) {
  const base = realDeps({ copilotHome, state });
  const shepherd = shepherdDeps({ copilotHome, ledger: path.join(state, 'disk-ledger.jsonl') });
  const wt = path.join(copilotHome, 'copilot-worktrees');
  const sessions = path.join(copilotHome, 'session-state');
  const rescueRoot = path.join(home, 'AgentBundles', 'disk-rescue');
  // `status --porcelain` leaves out ignored files (.env, notes, vault data). With `keepIgnored`, an ignored top-level entry that is not a
  // known rebuildable output counts as unsaved work, so the worktree is kept.
  const ignoredData = (d) => {
    if (!keepIgnored) return false;
    const r = git(d, ['status', '--porcelain', '--ignored=matching']);
    if (r.status !== 0) return true;
    return r.stdout.split('\n').some((l) => l.startsWith('!! ') && !REBUILDABLE.test(l.slice(3).replace(/\/$/, '')));
  };
  const q = async (sql) => { try { return await base.sql(sql); } catch { return null; } };
  const fetched = new Set();
  let ghLookups = 0;
  // Every git runs without fsmonitor (a worktree's daemon that stops answering blocks `status` and `diff` for ever) and under a
  // timeout. A git that timed out is unknown: its directory is remembered in `hung`, its command is logged in `gitTimeouts`.
  const readMs = gitMs.read ?? DP.gitRead, removeMs = gitMs.remove ?? DP.gitRemove;
  const hung = new Set(), gitTimeouts = [];
  const runGit = (key, pre, args, o = {}) => {
    const timeout = o.timeout ?? readMs;
    const r = sh(gitPath, ['-c', 'core.fsmonitor=false', ...pre, ...args], { killSignal: 'SIGKILL', ...o, timeout });
    if (r.error?.code === 'ETIMEDOUT') { hung.add(key); gitTimeouts.push({ cmd: `git ${[...pre, ...args].join(' ')}`.slice(0, 200), seconds: Math.round(timeout / 1000) }); }
    return r;
  };
  const git = (d, args, o) => runGit(d, ['-C', d], args, o);
  const gitAt = (common, args, o) => runGit(common, ['--git-dir', common], args, o);
  const ghBin = ghPath || [path.join(home, '.local', 'bin', 'gh'), '/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => fs.existsSync(p)) || 'gh';
  let drainIds = new Set(), idleKnown = false, runningIds = new Set(), autoIds = new Set(), appPaths = null, liveIds = null, openList, appRows = null, idleIds = null;
  const LEAN = '.github/scripts/lean-worktree.sh';
  // Linked worktrees agents make inside a session's files/ (a worktree's .git is a file).
  const sessionWorktrees = () => {
    const r = sh('/usr/bin/find', [sessions, '-maxdepth', '5', '-name', '.git', '-type', 'f', '-print'], { timeout: 120000 });
    return String(r.stdout).split('\n').filter((l) => /\/files\//.test(l)).map((l) => path.dirname(l));
  };
  const leanScript = (d) => {
    for (const ref of ['HEAD', 'origin/HEAD', 'origin/main']) { const r = git(d, ['show', `${ref}:${LEAN}`]); if (r.status === 0 && r.stdout.trim()) return r.stdout; }
    return null;
  };
  // The session-state index (see session-index.mjs): read once per process, written when a pass changed it.
  const indexFile = path.join(state, 'session-index.json');
  let idx = null;
  const index = () => (idx ||= sessionIndex({ data: readJson(indexFile, {}) }));
  const saveIndex = (ids) => {
    if (!idx) return;
    if (ids) idx.prune(ids);
    if (idx.dirty()) { try { writeJson(indexFile, idx.data()); } catch { /* the next pass walks again */ } }
  };
  const nothingNewer = (d, ms) => { const r = sh('/usr/bin/find', [d, '-mtime', `-${Math.ceil(ms / 86400000)}`, '-print', '-quit'], { timeout: 300000 }); return !r.error && !r.stdout.trim(); };
  let protectedPaths = null;
  const commons = new Map();
  const gitCommon = (d) => { if (!commons.has(d)) commons.set(d, gitCommonDir(d)); return commons.get(d); };
  const load_protected = () => {
    if (protectedPaths) return;
    protectedPaths = [path.join(home, 'code', 'housesitter'), ...(extraProtected || [])];
    try {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.plist')) continue;
        for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/<string>(\/[^<]+)<\/string>/g)) {
          const tmp = m[1].match(/^(\/(?:private\/)?tmp\/[^/]+)/);
          if (tmp) protectedPaths.push(tmp[1], tmp[1].replace(/^\/tmp/, '/private/tmp'));
          const dd = home && m[1].startsWith(`${home}/`) ? m[1] : null;
          // The repository root a plist's path sits in.
          let cur = dd; while (cur && cur !== home && !fs.existsSync(path.join(cur, '.git'))) cur = path.dirname(cur);
          if (cur && cur !== home && fs.existsSync(cur)) protectedPaths.push(cur);
        }
      }
    } catch { /* none */ }
    protectedPaths = [...new Set(protectedPaths)];
  };
  // Mounted APFS volumes beside Data and VM in the same container, so a volume that grows is named in the breakdown.
  const siblingsNow = () => {
    try {
      const list = sh('/usr/sbin/diskutil', ['apfs', 'list', '-plist']);
      const json = sh('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: list.stdout });
      const mounted = new Set([...String(sh('/sbin/mount').stdout).matchAll(/^\/dev\/(\S+) on /gm)].map((m) => m[1]));
      return siblingVolumes(JSON.parse(json.stdout), mounted);
    } catch { return []; }
  };
  return {
    now: () => Date.now(),
    usage: () => { const r = sh('/bin/df', ['-k', volume]).stdout.trim().split('\n').pop().split(/\s+/); const size = Number(r[1]), used = Number(r[2]), free = Number(r[3]) * 1024; return { pct: Math.round((used / size) * 100), free, size: size * 1024 }; },
    // The Data volume's own consumed bytes: free space swings with builds that write and delete, this does not.
    dataUsed: () => Number(sh('/bin/df', ['-k', '/System/Volumes/Data']).stdout.trim().split('\n').pop().split(/\s+/)[2]) * 1024,
    caches: () => CACHES.map((c) => path.join(home, c)).filter((p) => fs.existsSync(p)),
    size: sizeOf,
    // rmSync can lose a race with a process still writing into the folder (ENOTEMPTY); retry, then let rm have a go.
    remove: (p) => {
      try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {
        const r = sh('/bin/rm', ['-rf', p], { timeout: 600000 });
        if (r.status !== 0 && fs.existsSync(p)) throw e;
      }
    },
    // Build output of every lane checkout, with whether its run is live (see `pidAlive`).
    laneBuildOutputs: () => {
      const out = [];
      for (const root of laneRoots) {
        let runs; try { runs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const r of runs) {
          if (!r.isDirectory()) continue;
          const runDir = path.join(root, r.name), alive = pidAlive(path.join(laneHome, 'runs', r.name, 'copilot.pid'));
          for (const dir of laneBuildOutputsIn(runDir)) out.push({ run: r.name, runDir, dir, alive });
        }
      }
      return out;
    },
    volumes: siblingsNow,
    // Without the app's database nothing is known to be unused, so nothing is removed.
    appWorktrees: () => appPaths || new Set(),
    liveSessions: () => liveIds || new Set(),
    worktrees: () => {
      if (!appPaths) return [];
      const out = [];
      try { for (const r of fs.readdirSync(wt)) for (const n of fs.readdirSync(path.join(wt, r))) { const d = path.join(wt, r, n); if (fs.existsSync(path.join(d, '.git'))) out.push(d); } } catch { /* none */ }
      // Linked worktrees agents keep under ~/code (a worktree's .git is a file; a clone's is a folder, and is never listed).
      const codeRoot = path.join(home, 'code');
      const linkedHere = (d) => { try { return fs.statSync(path.join(d, '.git')).isFile(); } catch { return false; } };
      try {
        for (const a of fs.readdirSync(codeRoot)) {
          const da = path.join(codeRoot, a);
          if (!fs.statSync(da).isDirectory()) continue;
          if (linkedHere(da)) out.push(da);
          else for (const b of fs.readdirSync(da)) { const db = path.join(da, b); try { if (fs.statSync(db).isDirectory() && linkedHere(db)) out.push(db); } catch { /* gone */ } }
        }
      } catch { /* none */ }
      for (const d of sessionWorktrees()) if (!out.includes(d)) out.push(d);
      return out;
    },
    // Chromium's code-sign clones: <per-user folder>/X/<bundle id>.code_sign_clone/code_sign_clone.<random>, one folder per launch.
    leakedClones: () => {
      const u = sh('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR']).stdout.trim();
      if (!u) return [];
      const out = [], x = path.join(fs.realpathSync(u), '..', 'X');
      try {
        for (const b of fs.readdirSync(x)) {
          if (!b.endsWith('.code_sign_clone')) continue;
          for (const c of fs.readdirSync(path.join(x, b))) if (c.startsWith('code_sign_clone.')) out.push(path.join(x, b, c));
        }
      } catch { /* none */ }
      return out;
    },
    // Entries I own in /private/tmp and in the per-user temp folder (/private/var/folders/*/*/T): agents' scratch. Apple's
    // own com.apple.* entries are not ours.
    scratch: () => {
      const me = process.getuid?.(), out = [];
      const roots = ['/private/tmp'];
      const u = sh('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR']).stdout.trim();
      if (u) roots.push(fs.realpathSync(u));
      for (const root of roots) {
        try { for (const n of fs.readdirSync(root)) { if (/^com\.apple\./.test(n)) continue; const p = path.join(root, n); const st = fs.lstatSync(p); if (st.uid === me && !st.isSymbolicLink()) out.push(p); } } catch { /* none */ }
      }
      return out;
    },
    // Loose agent work under ~/code that is not a git checkout: folders with no .git within four levels, the folder and
    // then what is in it (down to three levels), so a busy art or scratch folder still gives up its old parts.
    junk: () => {
      const root = path.join(home, 'code'), out = [];
      const plain = (d) => { const r = sh('/usr/bin/find', [d, '-maxdepth', '4', '-name', '.git', '-print', '-quit'], { timeout: 120000 }); return !r.error && !r.stdout.trim(); };
      const kids = (d) => { try { return fs.readdirSync(d).map((n) => path.join(d, n)).filter((p) => { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); }); } catch { return []; } };
      const walk = (d, depth) => { if (!plain(d)) return; out.push(d); if (depth < 3) for (const k of kids(d)) walk(k, depth + 1); };
      for (const d of kids(root)) walk(d, 1);
      return out;
    },
    // Full clones (a .git folder) under ~/code and in sessions' files/: only those with nothing Git does not hold.
    clones: () => {
      const roots = [path.join(home, 'code'), ...(() => { try { return fs.readdirSync(sessions).map((i) => path.join(sessions, i, 'files')); } catch { return []; } })()];
      const out = [];
      for (const r of roots) {
        if (!fs.existsSync(r)) continue;
        const f = sh('/usr/bin/find', [r, '-maxdepth', r.startsWith(sessions) ? '4' : '2', '-name', '.git', '-type', 'd', '-prune', '-print'], { timeout: 120000 });
        for (const g of String(f.stdout).split('\n').filter(Boolean)) out.push(path.dirname(g));
      }
      return out;
    },
    // `unique`: anything here a clone would not give back (unsaved changes, a stash, a commit on no remote, a second worktree, no remote at all).
    clone: (d) => {
      const g = (...a) => git(d, a);
      const worktrees = g('worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
      const unique = g('status', '--porcelain').stdout.trim() !== '' || g('stash', 'list').stdout.trim() !== '' || g('remote').stdout.trim() === '' ||
        g('log', '--oneline', '--branches', '--tags', '--not', '--remotes').stdout.trim() !== '' || worktrees !== 1 || g('rev-parse', '--git-dir').status !== 0;
      return { unique: unique || hung.has(d) };
    },
    // What launchd runs from, and the clone Housesitter itself runs from, with their own worktrees: never removed.
    protectedBy: (d) => {
      load_protected();
      return protectedPaths.find((p) => d === p || d.startsWith(`${p}/`)) || (gitCommon(d) ? protectedPaths.find((p) => gitCommon(d) === gitCommon(p)) : null) || null;
    },
    // Narrower than protectedBy: only the folder launchd or Housesitter runs from, not every worktree of its repository.
    protectedDirect: (d) => { load_protected(); return protectedPaths.find((p) => d === p || d.startsWith(`${p}/`)) || null; },
    // Why a session using this worktree must keep its folder: running, an automation (or owner of one), or a drain target.
    sessionPin: (d) => {
      if (!idleKnown || !appRows) return 'session state unknown';
      const sids = appRows.filter((r) => r.p === d).map((r) => r.sid);
      if (!sids.length || sids.some((x) => !x)) return 'no session known for it';
      for (const sid of sids) {
        if (runningIds.has(sid)) return 'session is running';
        if (autoIds.has(sid)) return 'session has an automation or coordinates others';
        if (drainIds.has(sid)) return 'session is a drain target';
      }
      return null;
    },
    archiveSessions: async (d) => {
      try {
        const rows = await snapshot(base);
        for (const sid of appRows.filter((r) => r.p === d).map((r) => r.sid)) {
          const row = rows.find((x) => x.id === sid); if (!row) continue;
          const r = await archive(shepherd, row, { keepWorktree: true });
          if (!r.ok) return { ok: false, error: r.error || 'the app refused' };
        }
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    // True when the worktree's branch is merged into the default branch or deleted on the remote (fetched once per repository per pass).
    branchDone: (d) => {
      const common = gitCommon(d); if (!common) return false;
      if (!fetched.has(common)) { fetched.add(common); git(d, ['fetch', '--prune', '--quiet', 'origin'], { timeout: 90000 }); }
      const g = (...a) => git(d, a);
      const br = g('symbolic-ref', '--quiet', '--short', 'HEAD').stdout.trim();
      if (br) {
        const up = g('for-each-ref', '--format=%(upstream:track)', `refs/heads/${br}`).stdout;
        if (/gone/.test(up)) return true;
      }
      const head = g('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').stdout.trim() || 'refs/remotes/origin/main';
      // A branch still at the default branch's tip has done no work yet; that is a new session, not a finished one.
      const done = g('rev-parse', 'HEAD').stdout.trim() !== g('rev-parse', head).stdout.trim() && g('merge-base', '--is-ancestor', 'HEAD', head).status === 0;
      return done && !hung.has(d);
    },
    linked: (d) => { try { return fs.statSync(path.join(d, '.git')).isFile(); } catch { return false; } },
    // One lsof snapshot per pass; when it cannot be read, everything counts as open.
    // One lsof per pass, indexed as the set of every open file and each folder above it, so a lookup is one hash read.
    open: (p) => {
      if (openList === undefined) {
        const r = sh('/usr/sbin/lsof', ['-nP', '-w', '-Fn'], { timeout: 240000 });
        if (r.error || r.status === null) openList = null;
        else { openList = new Set(); for (const l of r.stdout.split('\n')) { if (!l.startsWith('n/')) continue; for (let f = l.slice(1); f.length > 1 && !openList.has(f); f = f.slice(0, f.lastIndexOf('/')) || '/') openList.add(f); } }
      }
      return openList === null ? true : openList.has(p);
    },
    quietFor: (d, ms = DP.deadQuiet) => { const r = sh('/usr/bin/find', [d, '-mmin', `-${Math.ceil(ms / 60000)}`, '-print', '-quit'], { timeout: 300000 }); return r.error || r.stdout.trim() ? 0 : Infinity; },
    clonesIn: (dirs) => dirs.flatMap((d) => { const r = sh('/usr/bin/find', [d, '-maxdepth', '5', '-name', '.git', '-prune', '-print'], { timeout: 120000 }); return r.stdout.split('\n').filter(Boolean).map((g) => path.dirname(g)); }),
    // Listed sessions that are not running, own no automation and have had nothing change for days, with their files/ folder.
    idleSessionFiles: () => {
      if (!liveIds || !idleKnown) return [];
      const out = [];
      try {
        for (const id of fs.readdirSync(sessions)) {
          if (!mayThinSession(id, { live: liveIds, running: runningIds, automated: autoIds })) continue;
          const dir = path.join(sessions, id), files = path.join(dir, 'files');
          if (!fs.existsSync(files)) continue;
          if (!index().quiet(id, dir, DP.idleSessionQuiet, nothingNewer)) continue;
          out.push({ id, dir, files });
        }
      } catch { /* none */ }
      saveIndex();
      return out;
    },
    // Dependency and build-cache folders a package manager rebuilds; target only beside a Cargo or Maven file.
    regenIn: (root) => {
      const names = ['node_modules', '.venv', '.next', '.nuxt', '.turbo', '.parcel-cache', '.gradle', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox'];
      const expr = ['(', ...names.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n])), ')', '-type', 'd', '-prune', '-print'];
      const f = sh('/usr/bin/find', [root, '-maxdepth', '8', ...expr], { timeout: 300000 });
      const found = String(f.stdout).split('\n').filter(Boolean);
      const t = sh('/usr/bin/find', [root, '-maxdepth', '8', '-name', 'target', '-type', 'd', '-prune', '-print'], { timeout: 300000 });
      for (const d of String(t.stdout).split('\n').filter(Boolean)) if (['Cargo.toml', 'pom.xml'].some((m) => fs.existsSync(path.join(path.dirname(d), m)))) found.push(d);
      return found.filter((d, i) => !found.some((o, j) => j !== i && d.startsWith(`${o}/`)));
    },
    // Session folders the app does not list, biggest first: the parts that are made by the session and rebuilt by no one.
    deadSessions: () => {
      if (!liveIds) return [];
      const out = [];
      try {
        for (const id of fs.readdirSync(sessions)) {
          if (liveIds.has(id)) continue;
          const dir = path.join(sessions, id);
          const heavy = ['files', 'images'].map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
          if (!heavy.length) continue;
          out.push({ id, dir, heavy, size: index().heavy(id, dir, ['files', 'images'], sizeOf) });
        }
      } catch { /* none */ }
      saveIndex();
      return out.filter((x) => x.size >= 50 * 1048576).sort((a, b) => b.size - a.size);
    },
    // Clones agents make worktrees from: ~/code/*, the desk and the CIT workspace, when their repository ships the script.
    ensureLeanHooks: () => {
      const cands = [path.join(home, 'personal-desk'), path.join(home, 'CIT-workspace')];
      try { for (const n of fs.readdirSync(path.join(home, 'code'))) cands.push(path.join(home, 'code', n)); } catch { /* none */ }
      for (const c of cands) {
        try {
          if (!fs.statSync(path.join(c, '.git')).isDirectory()) continue;
          if (git(c, ['config', '--get', 'core.hooksPath']).stdout.trim()) continue;
          if (leanScript(c) == null) continue;
          const f = path.join(c, '.git', 'hooks', 'post-checkout');
          const had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
          const next = withBlock(had);
          if (next !== had) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, next, { mode: 0o755 }); fs.chmodSync(f, 0o755); }
        } catch { /* one clone's trouble is not the others' */ }
      }
    },
    // An archived session's files/ folder, when it has one: the only part of it the retention rule removes.
    archivedScratch: (id) => {
      if (!/^[0-9a-f-]{36}$/.test(id)) return null;
      const dir = path.join(sessions, id), files = path.join(dir, 'files');
      try { return fs.statSync(files).isDirectory() ? { id, dir, files } : null; } catch { return null; }
    },
    // Files in gh's HTTP response cache (~/.cache/gh/<00..ff>/...) last changed before `cutoff` (ms since the epoch).
    // *.log files one level under ~/.local/agency/logs/<session>/ last changed before `cutoff`.
    agencyLogs: (cutoff) => {
      const root = path.join(home, '.local', 'agency', 'logs'), out = [];
      let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        let ents; try { ents = fs.readdirSync(path.join(root, d.name), { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          if (!e.isFile() || !e.name.endsWith('.log')) continue;
          const f = path.join(root, d.name, e.name);
          try { const st = fs.statSync(f); if (st.mtimeMs < cutoff && st.size > 0) out.push({ path: f, size: st.blocks * 512 }); } catch { /* gone */ }
        }
      }
      return out;
    },
    // Gzip a log next to itself, check the copy reads back byte for byte, keep mode and mtime, then drop the original. Returns bytes saved.
    gzipLog: (f) => {
      const st = fs.statSync(f), data = fs.readFileSync(f), gz = `${f}.gz`, tmp = `${f}.gz.${process.pid}.tmp`;
      if (!st.isFile() || data.length !== st.size) throw new Error('it changed while reading');
      if (fs.existsSync(gz)) throw new Error('a .gz already exists');
      const z = zlib.gzipSync(data);
      fs.writeFileSync(tmp, z, { mode: st.mode & 0o777, flag: 'wx' });
      try {
        if (!zlib.gunzipSync(fs.readFileSync(tmp)).equals(data)) throw new Error('the compressed copy did not read back identically');
        fs.utimesSync(tmp, st.atime, st.mtime);
        const now = fs.statSync(f);
        if (now.ino !== st.ino || now.size !== st.size || now.mtimeMs !== st.mtimeMs) throw new Error('it changed while compressing');
        if (openFresh(f)) throw new Error('a process has it open');
        fs.linkSync(tmp, gz); // fails if a .gz appeared meanwhile: nothing is overwritten
      } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
      fs.unlinkSync(tmp);
      fs.unlinkSync(f);
      return Math.max(0, st.blocks * 512 - fs.statSync(gz).blocks * 512);
    },
    openFresh,
    ghCacheOld: (cutoff) => {
      const root = path.join(home, '.cache', 'gh'), out = [];
      const walk = (d) => {
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else if (e.isFile()) { try { const st = fs.statSync(f); if (st.mtimeMs < cutoff) out.push({ path: f, size: st.blocks * 512 }); } catch { /* gone */ } }
        }
      };
      walk(root);
      return out;
    },
    idleSessions: () => idleIds || new Set(),
    // Linked worktrees of unarchived app sessions that are still whole; the script is the repository's own, from the
    // worktree or else from the default branch, so the patterns have one source.
    thinnable: () => {
      if (!appRows) return [];
      const owned = sessionWorktrees().map((d) => ({ dir: d, session: path.relative(sessions, d).split(path.sep)[0] }));
      return [...appRows.filter((r) => fs.existsSync(r.p)).map((r) => ({ dir: r.p, session: r.sid })), ...owned].filter((w, i, all) => all.findIndex((x) => x.dir === w.dir) === i).filter((w) => {
        try { if (!fs.statSync(path.join(w.dir, '.git')).isFile()) return false; } catch { return false; }
        return git(w.dir, ['config', '--get', 'core.sparseCheckout']).stdout.trim() !== 'true' && !hung.has(w.dir) && leanScript(w.dir) != null;
      });
    },
    thin: (d) => { const text = leanScript(d); if (text == null) return false; const r = sh('/bin/bash', ['-s'], { input: text, cwd: d, timeout: 600000, env: { ...process.env, COPILOT_WORKSPACE_PATH: d, COPILOT_ROOT_PATH: '' } }); return r.status === 0; },
    // One row per pass: when, what it did and how long each phase took, so a slow pass names its slow phase.
    passLog: (row) => {
      try {
        fs.mkdirSync(state, { recursive: true });
        const f = path.join(state, 'disk-prune-passes.jsonl');
        fs.appendFileSync(f, `${JSON.stringify(row)}\n`);
        if (fs.statSync(f).size > 262144) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-500).join('\n') + '\n');
      } catch { /* a courtesy */ }
    },
    ledger: (row) => { try { fs.mkdirSync(state, { recursive: true }); fs.appendFileSync(path.join(state, 'disk-ledger.jsonl'), `${JSON.stringify(row)}\n`); } catch { /* a courtesy */ } },
    // Where the bytes are, daily: each root, and the biggest session folders, with growth since the last measurement.
    breakdown: (prev) => {
      const roots = { sessions, worktrees: wt, code: path.join(home, 'code'), caches: path.join(home, 'Library', 'Caches'), trash: path.join(home, '.Trash'), rescue: rescueRoot };
      const duBytes = (p) => (Number(String(nice('/usr/bin/du', ['-sk', p], { timeout: 1800000 }).stdout).split(/\s+/)[0]) || 0) * 1024;
      // The rest of the disk, by top-level child, so a fall that is not agent storage still has a name: ~/Library/Metadata (Spotlight),
      // every other ~/Library child, the rest of ~/.copilot and of home. The folders macOS asks the user's leave to read are left out.
      const kids = (dir, skip) => { try { return fs.readdirSync(dir).filter((n) => !skip.includes(n)).map((n) => [path.join(dir, n), n]); } catch { return []; } };
      for (const [p, n] of kids(path.join(home, 'Library'), ['Caches'])) roots[`Library/${n}`] = p;
      for (const [p, n] of kids(copilotHome, [path.basename(sessions), path.basename(wt)])) roots[`.copilot/${n}`] = p;
      const claimed = ['Library', 'code', '.copilot', '.Trash', 'Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public', path.relative(home, rescueRoot).split('/')[0]];
      for (const [p, n] of kids(home, claimed)) roots[`~/${n}`] = p;
      // The session folders are measured through the index, so only a folder that changed is walked; their root is their sum.
      const ses = {};
      try {
        const ids = fs.readdirSync(sessions);
        for (const id of ids) { try { ses[id] = index().size(id, path.join(sessions, id), duBytes); } catch { /* gone */ } }
        saveIndex(new Set(ids));
      } catch { /* none */ }
      const sizes = {}; for (const [k, p] of Object.entries(roots)) sizes[k] = k === 'sessions' ? Object.values(ses).reduce((a, b) => a + b, 0) : fs.existsSync(p) ? duBytes(p) : 0;
      // Swap lives in its own APFS volume: what the kernel says is used, and what that volume has consumed.
      const m = /used = ([\d.]+)([MG])/.exec(String(sh('/usr/sbin/sysctl', ['-n', 'vm.swapusage']).stdout));
      if (m) sizes['swap used'] = Math.round(Number(m[1]) * (m[2] === 'G' ? GIB : 1048576));
      const vm = Number(String(sh('/bin/df', ['-k', '/System/Volumes/VM']).stdout).trim().split('\n').pop().split(/\s+/)[2]);
      if (Number.isFinite(vm)) sizes['swap VM volume'] = vm * 1024;
      for (const v of siblingsNow()) sizes[`volume ${v.name}`] = v.used;
      const prevSes = prev?.sessionSizes || {};
      const list = [...Object.entries(sizes).map(([k, v]) => ({ name: k, size: v, grew: prev?.roots && k in prev.roots ? v - prev.roots[k] : 0 })), ...Object.entries(ses).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ name: `session ${k.slice(0, 8)}`, size: v, grew: prev ? v - (prevSes[k] || 0) : 0 }))];
      const sessionSizes = Object.fromEntries(Object.entries(ses).sort((a, b) => b[1] - a[1]).slice(0, 50));
      return { roots: sizes, sessionSizes, top: list.sort((a, b) => (b.grew > 0 ? b.grew : 0) - (a.grew > 0 ? a.grew : 0) || b.size - a.size) };
    },
    // True when nothing in d changed for `ms`: the entry's own mtime first (no process), then one find for a folder.
    quietSince: (d, ms) => {
      let st; try { st = fs.lstatSync(d); } catch { return false; }
      if (Date.now() - st.mtimeMs < ms) return false;
      if (!st.isDirectory()) return true;
      const r = sh('/usr/bin/find', [d, '-mmin', `-${Math.ceil(ms / 60000)}`, '-print', '-quit'], { timeout: 300000 });
      return !r.error && !r.stdout.trim();
    },
    // The folder's own modification time: a clone is created whole and never touched, so its age is its folder's.
    mtimeOf: (d) => { try { return fs.statSync(d).mtimeMs; } catch { return Date.now(); } },
    changedAt: (d, days = 1) => {
      const rec = sh('/usr/bin/find', [d, '-mtime', `-${days}`, '-print', '-quit'], { timeout: 300000 });
      if (rec.error || rec.stdout.trim()) return Date.now();
      const c = Number(git(d, ['log', '-1', '--format=%ct']).stdout.trim());
      if (hung.has(d)) return Date.now();
      try { return Math.max(fs.statSync(d).mtimeMs, (Number.isFinite(c) ? c : 0) * 1000); } catch { return Date.now(); }
    },
    git: (d) => {
      const dirty = git(d, ['status', '--porcelain']).stdout.trim() !== '' || ignoredData(d);
      const unpushed = git(d, ['log', '--oneline', 'HEAD', '--not', '--remotes']).stdout.trim() !== '';
      return { dirty, unpushed, unknown: hung.has(d) };
    },
    // A git that did not answer throws: a bundle made from half an answer would be a lost-work bundle.
    rescue: (d) => {
      const dir = path.join(rescueRoot, `${path.relative(home, d).replace(/\//g, '__')}-${Date.now()}`);
      fs.mkdirSync(dir, { recursive: true });
      const patch = git(d, ['diff', 'HEAD']).stdout;
      const files = git(d, ['ls-files', '--others', '--exclude-standard', '-z']).stdout;
      if (hung.has(d)) throw new Error('git did not answer');
      fs.writeFileSync(path.join(dir, 'diff.patch'), patch);
      if (files) sh('/usr/bin/tar', ['-cf', path.join(dir, 'untracked.tar'), '-C', d, '--null', '-T', '-'], { input: files });
      git(d, ['bundle', 'create', path.join(dir, 'repo.bundle'), 'HEAD', '--not', '--remotes']);
      if (hung.has(d)) throw new Error('git did not answer');
      return dir;
    },
    // Linked worktrees of every repository agents work in (~/code/*, the desk, the CIT workspace), never the primary clone,
    // Tandem's live keepers or the app's own folder.
    landedWorktrees: () => {
      const cands = [path.join(home, 'personal-desk'), path.join(home, 'CIT-workspace')];
      try { for (const n of fs.readdirSync(path.join(home, 'code'))) cands.push(path.join(home, 'code', n)); } catch { /* none */ }
      const seen = new Set(), out = [];
      for (const c of cands) {
        try { if (!fs.statSync(path.join(c, '.git')).isDirectory()) continue; } catch { continue; }
        const common = gitCommon(c); if (!common || seen.has(common)) continue;
        seen.add(common);
        const r = git(c, ['worktree', 'list', '--porcelain']);
        const blocks = String(r.stdout).split('\n\n').filter(Boolean);
        for (const b of blocks.slice(1)) {
          const m = b.match(/^worktree (.+)$/m);
          if (!m || /^bare$/m.test(b) || isOffLimits(m[1], wt) || !fs.existsSync(m[1])) continue;
          out.push({ dir: m[1], repo: c });
        }
      }
      return out;
    },
    dirty: (d) => { const r = git(d, ['status', '--porcelain']); return r.status !== 0 || r.stdout.trim() !== '' || ignoredData(d); },
    // True when a git on this worktree timed out this pass: what it said is unknown, so the worktree is kept.
    gitHung: (d) => hung.has(d),
    // Every git that timed out this pass, for the pass row.
    gitTimeouts: () => gitTimeouts.slice(),
    // How the worktree's work landed, or null: HEAD is in origin's default branch; every path the branch changed has the
    // default branch's content (a squash merge); or its branch's PR, at this very commit, is merged (the one call that costs quota).
    landedWhy: (d) => {
      const g = (...a) => git(d, a);
      const common = gitCommon(d); if (!common) return null;
      if (!fetched.has(common)) { fetched.add(common); g('fetch', '--prune', '--quiet', 'origin'); }
      let ref = g('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').stdout.trim();
      if (!ref) ref = ['refs/remotes/origin/main', 'refs/remotes/origin/master'].find((c) => g('rev-parse', '--verify', '--quiet', c).status === 0);
      if (!ref) return null;
      const short = ref.replace(/^refs\/remotes\//, '');
      if (g('merge-base', '--is-ancestor', 'HEAD', ref).status === 0) return `in ${short}`;
      const mb = g('merge-base', ref, 'HEAD').stdout.trim();
      if (mb) {
        // git diff takes no pathspec file, so the paths that still differ from the default branch are intersected with the branch's own.
        const mine = g('diff', '--name-only', '-z', '--no-renames', mb, 'HEAD').stdout.split('\0').filter(Boolean);
        if (mine.length) {
          const diff = g('diff', '--name-only', '-z', '--no-renames', ref, 'HEAD');
          if (diff.status === 0) { const differ = new Set(diff.stdout.split('\0')); if (!mine.some((n) => differ.has(n))) return `every changed path matches ${short}`; }
        }
      }
      const branch = g('symbolic-ref', '--quiet', '--short', 'HEAD').stdout.trim();
      if (!branch || ghLookups >= DP.ghLookups) return null;
      ghLookups += 1;
      const head = g('rev-parse', 'HEAD').stdout.trim();
      const r = sh(ghBin, ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefOid', '--limit', '10'], { cwd: d, timeout: 30000 });
      try { const pr = JSON.parse(r.stdout).find((x) => x.headRefOid === head); return pr ? `PR #${pr.number} merged` : null; } catch { return null; }
    },
    // `git worktree remove` without --force: git itself refuses a worktree with changes or a lock.
    removeLanded: (d) => {
      const common = gitCommon(d); if (!common) return false;
      gitAt(common, ['worktree', 'remove', d], { timeout: removeMs });
      gitAt(common, ['worktree', 'prune']);
      return !fs.existsSync(d);
    },
    removeWorktree: (d) => {
      const common = git(d, ['rev-parse', '--git-common-dir']).stdout.trim();
      if (!common) return;
      const g = path.resolve(d, common);
      gitAt(g, ['worktree', 'remove', '--force', d], { timeout: removeMs });
      gitAt(g, ['worktree', 'prune']);
    },
    histories: () => {
      if (!liveIds) return [];
      const out = [];
      try {
        for (const id of fs.readdirSync(sessions)) {
          const file = path.join(sessions, id, 'events.jsonl');
          try { const s = fs.statSync(file); out.push({ id, file, size: s.size, mtime: s.mtimeMs }); } catch { /* none */ }
        }
      } catch { /* none */ }
      return out.sort((a, b) => b.size - a.size);
    },
    // Shepherd's compressHistory: the one compress path, and the one ledger row (in this same disk-ledger.jsonl).
    compress: (id, o) => compressHistory(shepherd, id, o),
    // The app's sessions: archived ones, live ones, and every id it lists. null when the database cannot be read.
    sessionRows: async () => {
      const r = await q('SELECT id, archived_at FROM sessions');
      if (!r) return null;
      return { archived: r.filter((x) => x.archived_at).map((x) => x.id), live: new Set(r.filter((x) => !x.archived_at).map((x) => x.id)), known: new Set(r.map((x) => x.id)) };
    },
    tell: realTell({ state, home }),
    readState: () => readJson(path.join(state, 'disk-prune.json'), {}),
    writeState: (o) => writeJson(path.join(state, 'disk-prune.json'), o),
    // Reads the app's database once per pass; the pass calls this first.
    load: async () => {
      openList = undefined; protectedPaths = null; ghLookups = 0; fetched.clear(); commons.clear(); hung.clear(); gitTimeouts.length = 0;
      const w = await q('SELECT w.path AS p FROM worktrees w JOIN workspaces k ON k.worktree_id = w.id WHERE k.archived_at IS NULL');
      const s = await q('SELECT id FROM sessions WHERE archived_at IS NULL');
      const wr = await q('SELECT w.path AS p, k.session_id AS sid FROM worktrees w JOIN workspaces k ON k.worktree_id = w.id WHERE k.archived_at IS NULL AND k.session_id IS NOT NULL');
      appRows = wr || null;
      const run = await q('SELECT id FROM sessions WHERE is_running = 1');
      const au = await q('SELECT session_id, owner_session_id FROM session_automations');
      // Unknown means not safe: with either read failing, no session counts as idle.
      runningIds = new Set((run || []).map((r) => r.id));
      autoIds = new Set((au || []).flatMap((r) => [r.session_id, r.owner_session_id].filter(Boolean)));
      idleKnown = Boolean(run && au);
      drainIds = drainTargets(home);
      try { idleIds = new Set((await snapshot(base)).filter((x) => x.state === 'idle').map((x) => x.id)); } catch { idleIds = null; }
      appPaths = w ? new Set(w.map((r) => r.p)) : null;
      liveIds = s ? new Set(s.map((r) => r.id)) : null;
    },
  };
}
