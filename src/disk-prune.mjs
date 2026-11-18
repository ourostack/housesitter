// `housesitter restart-copilot --disk-prune`: keep free space above a floor (500 GiB by default) with no model turns and
// nothing for an agent to remember. launchd runs one pass every ten minutes; a pass does nothing while free space is above
// the floor. Below it, it reclaims safe classes in this order and stops once free space is back at floor + 50 GiB:
//   1. caches that rebuild themselves (npm, pip, Go, pnpm, Playwright, gh)
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
//   Before all of that, on every pass and above the floor too: the history of an archived session, compressed by
//   Shepherd's compressHistory, which refuses a live or open one. A finished history loses nothing, so it waits for nothing.
// Each hour it records free space in a ledger; each day it measures where the bytes are and says which sources grew,
// so the cause gets fixed and not only the symptom. A pass that finds nothing safe rests an hour before it scans again.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compressHistory, deps as shepherdDeps } from '@ouro.bot/shepherd';
import { realDeps, snapshot, stateDir } from './copilot-app.mjs';
import { iso, readJson, realTell, writeJson } from './recovery.mjs';
import { withBlock } from './lean-hook.mjs';

export const DP = {
  floor: 500 * 1073741824, // free bytes below which a pass starts reclaiming
  margin: 50 * 1073741824, // it stops once free space is floor + margin
  quiet: 24 * 3600000, // a worktree or history changed within this is never touched
  deadQuiet: 2 * 24 * 3600000, // the heavy parts of an unlisted session go only after this long untouched
  minHistory: 20 * 1048576, // smaller histories are not worth compressing
  nag: 24 * 3600000, // how often "still under the floor" may be said
  idleSessionQuiet: 3 * 24 * 3600000, // a listed session's regenerable files go only after the whole session folder was untouched this long
  junkQuiet: 3 * 24 * 3600000, // loose non-git work under ~/code goes only after this long untouched
  cloneQuiet: 3 * 24 * 3600000, // a full clone is removed only after this long untouched
  rest: 3600000, // after a pass that found nothing safe, the next scan waits this long
  ledgerEvery: 55 * 60000, // free space is recorded about hourly
  breakdownEvery: 24 * 3600000, // where the bytes are is measured daily
};

const GIB = 1073741824;
export const gib = (b) => `${(b / GIB).toFixed(1)} GiB`;

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
  const stamp = (patch) => { if (!opts.dry_run) deps.writeState({ ...(deps.readState() || {}), ...patch }); };

  if (!opts.dry_run) {
    try { deps.ensureLeanHooks?.(); } catch { /* a courtesy; the pass goes on */ }
    if (!(now - (st0.ledgerAt || 0) < t.ledgerEvery)) { deps.ledger?.({ at: iso(now), free: before.free, pct: before.pct }); stamp({ ledgerAt: now }); }
    if (!(now - (st0.breakdown?.at || 0) < t.breakdownEvery)) { const b = deps.breakdown?.(st0.breakdown); if (b) stamp({ breakdown: { ...b, at: now } }); }
  }
  const reclaimed = { caches: 0, thin: 0, thinned: [], worktrees: [], clones: [], cloned: 0, scratch: 0, junk: [], junked: 0, idle: [], idled: 0, sessions: 0, histories: 0, rescued: [] };
  const rows = (await deps.sessionRows?.()) || null;
  for (const id of rows?.archived || []) {
    if (rows.live.has(id)) continue;
    const r = await deps.compress(id, { dryRun: Boolean(opts.dry_run) });
    if (!r.ok) continue;
    const saved = opts.dry_run ? r.before : r.before - r.after;
    reclaimed.histories += saved; out(`${opts.dry_run ? 'would compress' : 'compressed'} the history of archived session ${id.slice(0, 8)}: ${gib(saved)}`);
  }

  if (before.free >= t.floor && !opts.force) return { action: 'ok', free: before.free, reclaimed };
  if (!opts.force && !opts.dry_run && now < (st0.restUntil || 0)) return { action: 'resting', free: before.free };

  await deps.load?.();
  const done = () => deps.usage().free >= t.floor + t.margin;
  const used = deps.appWorktrees();

  for (const c of deps.caches()) {
    if (done()) break;
    const n = deps.size(c); if (!n) continue;
    // A cache another process is writing can refuse to go (ENOTEMPTY); that must not end the pass.
    if (!opts.dry_run) { try { deps.remove(c); } catch (e) { out(`could not remove cache ${c}: ${e.message}`); continue; } }
    reclaimed.caches += n; out(`cache ${c}: ${gib(n)}`);
  }

  // Scratch is cheap to judge and often the biggest yield, so it goes before the slow per-worktree stages.
  for (const dir of deps.scratch?.() || []) {
    if (done()) break;
    if (deps.protectedBy?.(dir) || deps.open(dir) || !(now - deps.changedAt(dir) >= t.quiet)) continue;
    const n = deps.size(dir);
    if (!opts.dry_run) { try { deps.remove(dir); } catch (e) { out(`could not remove scratch ${dir}: ${e.message}`); continue; } }
    reclaimed.scratch += n; out(`removed scratch ${dir}: ${gib(n)}`);
  }

  for (const dir of deps.junk?.() || []) {
    if (done()) break;
    if (deps.protectedBy?.(dir) || used.has(dir) || deps.open(dir) || !(now - deps.changedAt(dir, 3) >= t.junkQuiet)) continue;
    const n = deps.size(dir);
    if (!opts.dry_run) { try { deps.remove(dir); } catch (e) { out(`could not remove ${dir}: ${e.message}`); continue; } }
    reclaimed.junk.push(dir); reclaimed.junked += n; out(`removed loose work ${dir}: ${gib(n)}`);
  }

  const idle = deps.idleSessions?.() || new Set();
  for (const w of deps.thinnable?.() || []) {
    if (done()) break;
    if (!idle.has(w.session)) { out(`kept ${w.dir} thick: its session is not idle`); continue; }
    if (opts.dry_run) { out(`would thin ${w.dir}`); reclaimed.thinned.push(w.dir); continue; }
    const n = deps.size(w.dir);
    if (!deps.thin(w.dir)) { out(`could not thin ${w.dir}`); continue; }
    const saved = Math.max(0, n - deps.size(w.dir));
    reclaimed.thinned.push(w.dir); reclaimed.thin += saved; out(`thinned ${w.dir}: ${gib(saved)}`);
  }

  const live = deps.liveSessions();
  for (const sdir of deps.deadSessions?.() || []) {
    if (done()) break;
    const why = whyKeepSession({ live: live.has(sdir.id), open: deps.open(sdir.dir), quietFor: deps.quietFor(sdir.dir) }, t);
    if (why) continue;
    const n = sdir.heavy.reduce((a, h) => a + deps.size(h), 0); if (!n) continue;
    if (!opts.dry_run) {
      for (const c of deps.clonesIn(sdir.heavy)) {
        const g = deps.git(c);
        if (g.dirty || g.unpushed) { const b = deps.rescue(c); reclaimed.rescued.push(b); out(`saved ${c}'s unsaved work to ${b}`); }
      }
      for (const h of sdir.heavy) deps.remove(h);
    }
    reclaimed.sessions += n; out(`dropped the files of unlisted session ${sdir.id.slice(0, 8)}: ${gib(n)}`);
  }

  // A listed session nobody is running, with no automation, untouched for days: only what a build or a clone gives back.
  // Dependency folders always; a clone only when every branch is on a remote and nothing is uncommitted. History stays.
  for (const s of deps.idleSessionFiles?.() || []) {
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

  for (const dir of deps.worktrees()) {
    if (done()) break;
    const w = { dir, linked: deps.linked(dir), usedByApp: used.has(dir), open: false, changedAt: 0, protectedBy: deps.protectedBy?.(dir) || null };
    if (w.linked && !w.usedByApp && !w.protectedBy) { w.open = deps.open(dir); if (!w.open) w.changedAt = deps.changedAt(dir); }
    const why = whyKeep(w, now, t);
    if (why) { out(`kept ${dir}: ${why}`); continue; }
    const n = deps.size(dir);
    if (!opts.dry_run) {
      const g = deps.git(dir);
      if (g.dirty || g.unpushed) { const b = deps.rescue(dir); reclaimed.rescued.push(b); out(`saved ${dir}'s unsaved work to ${b}`); }
      deps.removeWorktree(dir);
    }
    reclaimed.worktrees.push(dir); out(`removed worktree ${dir}: ${gib(n)}`);
  }


  for (const dir of deps.clones?.() || []) {
    if (done()) break;
    const why = deps.protectedBy?.(dir) ? 'launchd or Housesitter runs from it' : used.has(dir) ? 'an unarchived app session uses it' : deps.open(dir) ? 'a running process has it open' : !(now - deps.changedAt(dir) >= t.cloneQuiet) ? 'something in it changed in the last 3 days' : deps.clone(dir).unique ? 'it holds work that is not on a remote' : null;
    if (why) { out(`kept clone ${dir}: ${why}`); continue; }
    const n = deps.size(dir);
    if (!opts.dry_run) deps.remove(dir);
    reclaimed.clones.push(dir); reclaimed.cloned += n; out(`removed clone ${dir}: ${gib(n)}`);
  }

  // Only a session the app does not list at all: an archived one was compressed above, and a live one is never touched.
  const hlive = deps.liveSessions();
  for (const h of deps.histories()) {
    if (done()) break;
    if (!rows || rows.known.has(h.id) || hlive.has(h.id) || now - h.mtime < t.quiet || h.size < t.minHistory || deps.open(h.file)) continue;
    const r = await deps.compress(h.id, { dryRun: Boolean(opts.dry_run) });
    if (!r.ok) continue;
    const saved = opts.dry_run ? r.before : r.before - r.after;
    reclaimed.histories += saved; out(`${opts.dry_run ? 'would compress' : 'compressed'} the history of unlisted session ${h.id.slice(0, 8)}: ${gib(saved)}`);
  }

  const after = deps.usage();
  const total = reclaimed.scratch + reclaimed.junked + reclaimed.idled + reclaimed.cloned + reclaimed.caches + reclaimed.histories + reclaimed.sessions + reclaimed.thinned.length;
  const res = { action: reclaimed.worktrees.length || total ? 'pruned' : 'nothing-safe', before: before.free, after: after.free, reclaimed, dry_run: Boolean(opts.dry_run) };
  if (opts.dry_run) return res;
  const st = deps.readState() || {};
  const growers = top(st.breakdown);
  const tail = `${growers ? ` Biggest sources: ${growers}.` : ''}`;
  if (res.action === 'pruned') {
    await deps.tell(`Free space was ${gib(before.free)}, below the ${gib(t.floor)} floor; disk prune reclaimed caches ${gib(reclaimed.caches)}, ${reclaimed.thinned.length} idle worktree(s) made sparse (${gib(reclaimed.thin)}), files of unlisted sessions ${gib(reclaimed.sessions)}, ${reclaimed.worktrees.length} unused worktree(s), ${reclaimed.clones.length} rebuildable clone(s) (${gib(reclaimed.cloned)}), scratch in the temp folders ${gib(reclaimed.scratch)}, ${reclaimed.junk.length} loose folder(s) of old work under ~/code (${gib(reclaimed.junked)}), regenerable files of ${reclaimed.idle.length} idle session(s) (${gib(reclaimed.idled)}), compressed histories ${gib(reclaimed.histories)}; now ${gib(after.free)} free.${reclaimed.rescued.length ? ` Unsaved work from ${reclaimed.rescued.length} worktree(s) was saved under ~/AgentBundles/disk-rescue.` : ''}${after.free < t.floor ? ' Still under the floor: what is left is not safe to prune without Ari.' : ''}${tail}`);
    st.toldAt = now;
  } else if (now - (st.toldAt || 0) >= t.nag) {
    await deps.tell(`Free space is ${gib(after.free)}, under the ${gib(t.floor)} floor, and disk prune found nothing safe to remove. What is left belongs to Ari or to live sessions.${tail}`);
    st.toldAt = now;
  }
  if (res.action === 'nothing-safe') st.restUntil = now + t.rest; else delete st.restUntil;
  deps.writeState({ ...st, lastPass: { at: iso(now), ...res } });
  return res;
}

// ---------- the real world ----------

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...o });
const nice = (cmd, args, o) => sh('/usr/bin/nice', ['-n', '10', cmd, ...args], o);
const sizeOf = (p) => { const r = sh('/usr/bin/du', ['-sk', p], { timeout: 300000 }); return (Number(String(r.stdout).split(/\s+/)[0]) || 0) * 1024; };

// A listed session is a candidate for losing regenerable files only when nothing runs it and no automation will wake it.
export const mayThinSession = (id, { live, running, automated }) => live.has(id) && !running.has(id) && !automated.has(id);

export function realDiskDeps({ home = os.homedir(), copilotHome = path.join(home, '.copilot'), state = stateDir(home), volume = '/System/Volumes/Data', extraProtected = [] } = {}) {
  const base = realDeps({ copilotHome, state });
  const shepherd = shepherdDeps({ copilotHome, ledger: path.join(state, 'disk-ledger.jsonl') });
  const wt = path.join(copilotHome, 'copilot-worktrees');
  const sessions = path.join(copilotHome, 'session-state');
  const rescueRoot = path.join(home, 'AgentBundles', 'disk-rescue');
  const q = async (sql) => { try { return await base.sql(sql); } catch { return null; } };
  let idleKnown = false, runningIds = new Set(), autoIds = new Set(), appPaths = null, liveIds = null, openList, appRows = null, idleIds = null;
  const LEAN = '.github/scripts/lean-worktree.sh';
  // Linked worktrees agents make inside a session's files/ (a worktree's .git is a file).
  const sessionWorktrees = () => {
    const r = sh('/usr/bin/find', [sessions, '-maxdepth', '5', '-name', '.git', '-type', 'f', '-print'], { timeout: 120000 });
    return String(r.stdout).split('\n').filter((l) => /\/files\//.test(l)).map((l) => path.dirname(l));
  };
  const leanScript = (d) => {
    for (const ref of ['HEAD', 'origin/HEAD', 'origin/main']) { const r = sh('/usr/bin/git', ['-C', d, 'show', `${ref}:${LEAN}`]); if (r.status === 0 && r.stdout.trim()) return r.stdout; }
    return null;
  };
  let protectedPaths = null;
  const gitCommon = (d) => { const r = sh('/usr/bin/git', ['-C', d, 'rev-parse', '--git-common-dir']); return r.status === 0 ? path.resolve(d, r.stdout.trim()) : null; };
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
  return {
    now: () => Date.now(),
    usage: () => { const r = sh('/bin/df', ['-k', volume]).stdout.trim().split('\n').pop().split(/\s+/); const size = Number(r[1]), used = Number(r[2]), free = Number(r[3]) * 1024; return { pct: Math.round((used / size) * 100), free }; },
    caches: () => CACHES.map((c) => path.join(home, c)).filter((p) => fs.existsSync(p)),
    size: sizeOf,
    // rmSync can lose a race with a process still writing into the folder (ENOTEMPTY); retry, then let rm have a go.
    remove: (p) => {
      try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {
        const r = sh('/bin/rm', ['-rf', p], { timeout: 600000 });
        if (r.status !== 0 && fs.existsSync(p)) throw e;
      }
    },
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
      const g = (...a) => sh('/usr/bin/git', ['-C', d, ...a]);
      const worktrees = g('worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
      const unique = g('status', '--porcelain').stdout.trim() !== '' || g('stash', 'list').stdout.trim() !== '' || g('remote').stdout.trim() === '' ||
        g('log', '--oneline', '--branches', '--tags', '--not', '--remotes').stdout.trim() !== '' || worktrees !== 1 || g('rev-parse', '--git-dir').status !== 0;
      return { unique };
    },
    // What launchd runs from, and the clone Housesitter itself runs from, with their own worktrees: never removed.
    protectedBy: (d) => {
      load_protected();
      return protectedPaths.find((p) => d === p || d.startsWith(`${p}/`)) || protectedPaths.find((p) => gitCommon(d) === gitCommon(p)) || null;
    },
    linked: (d) => { try { return fs.statSync(path.join(d, '.git')).isFile(); } catch { return false; } },
    // One lsof snapshot per pass; when it cannot be read, everything counts as open.
    open: (p) => {
      if (openList === undefined) { const r = sh('/usr/sbin/lsof', ['-nP', '-w', '-Fn'], { timeout: 240000 }); openList = r.error || r.status === null ? null : r.stdout.split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1)); }
      return openList === null ? true : openList.some((f) => f === p || f.startsWith(`${p}/`));
    },
    quietFor: (d) => { const r = sh('/usr/bin/find', [d, '-mtime', `-${Math.ceil(DP.deadQuiet / 86400000)}`, '-print', '-quit'], { timeout: 300000 }); return r.error || r.stdout.trim() ? 0 : Infinity; },
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
          const r = sh('/usr/bin/find', [dir, '-mtime', `-${Math.ceil(DP.idleSessionQuiet / 86400000)}`, '-print', '-quit'], { timeout: 300000 });
          if (r.error || r.stdout.trim()) continue;
          out.push({ id, dir, files });
        }
      } catch { /* none */ }
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
          out.push({ id, dir, heavy, size: heavy.reduce((a, h) => a + sizeOf(h), 0) });
        }
      } catch { /* none */ }
      return out.filter((x) => x.size >= 50 * 1048576).sort((a, b) => b.size - a.size);
    },
    // Clones agents make worktrees from: ~/code/*, the desk and the CIT workspace, when their repository ships the script.
    ensureLeanHooks: () => {
      const cands = [path.join(home, 'personal-desk'), path.join(home, 'CIT-workspace')];
      try { for (const n of fs.readdirSync(path.join(home, 'code'))) cands.push(path.join(home, 'code', n)); } catch { /* none */ }
      for (const c of cands) {
        try {
          if (!fs.statSync(path.join(c, '.git')).isDirectory()) continue;
          if (sh('/usr/bin/git', ['-C', c, 'config', '--get', 'core.hooksPath']).stdout.trim()) continue;
          if (leanScript(c) == null) continue;
          const f = path.join(c, '.git', 'hooks', 'post-checkout');
          const had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
          const next = withBlock(had);
          if (next !== had) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, next, { mode: 0o755 }); fs.chmodSync(f, 0o755); }
        } catch { /* one clone's trouble is not the others' */ }
      }
    },
    idleSessions: () => idleIds || new Set(),
    // Linked worktrees of unarchived app sessions that are still whole; the script is the repository's own, from the
    // worktree or else from the default branch, so the patterns have one source.
    thinnable: () => {
      if (!appRows) return [];
      const owned = sessionWorktrees().map((d) => ({ dir: d, session: path.relative(sessions, d).split(path.sep)[0] }));
      return [...appRows.filter((r) => fs.existsSync(r.p)).map((r) => ({ dir: r.p, session: r.sid })), ...owned].filter((w, i, all) => all.findIndex((x) => x.dir === w.dir) === i).filter((w) => {
        try { if (!fs.statSync(path.join(w.dir, '.git')).isFile()) return false; } catch { return false; }
        return sh('/usr/bin/git', ['-C', w.dir, 'config', '--get', 'core.sparseCheckout']).stdout.trim() !== 'true' && leanScript(w.dir) != null;
      });
    },
    thin: (d) => { const text = leanScript(d); if (text == null) return false; const r = sh('/bin/bash', ['-s'], { input: text, cwd: d, timeout: 600000, env: { ...process.env, COPILOT_WORKSPACE_PATH: d, COPILOT_ROOT_PATH: '' } }); return r.status === 0; },
    ledger: (row) => { try { fs.mkdirSync(state, { recursive: true }); fs.appendFileSync(path.join(state, 'disk-ledger.jsonl'), `${JSON.stringify(row)}\n`); } catch { /* a courtesy */ } },
    // Where the bytes are, daily: each root, and the biggest session folders, with growth since the last measurement.
    breakdown: (prev) => {
      const roots = { sessions, worktrees: wt, code: path.join(home, 'code'), caches: path.join(home, 'Library', 'Caches'), trash: path.join(home, '.Trash'), rescue: rescueRoot };
      const sizes = {}; for (const [k, p] of Object.entries(roots)) sizes[k] = fs.existsSync(p) ? (Number(String(nice('/usr/bin/du', ['-sk', p], { timeout: 1800000 }).stdout).split(/\s+/)[0]) || 0) * 1024 : 0;
      const ses = {};
      try { for (const l of String(nice('/usr/bin/du', ['-sk', ...fs.readdirSync(sessions).map((i) => path.join(sessions, i))], { timeout: 1800000 }).stdout).split('\n')) { const m = l.match(/^(\d+)\s+(.*)$/); if (m) ses[path.basename(m[2])] = Number(m[1]) * 1024; } } catch { /* none */ }
      const prevSes = prev?.sessionSizes || {};
      const list = [...Object.entries(sizes).map(([k, v]) => ({ name: k, size: v, grew: prev?.roots ? v - (prev.roots[k] || 0) : 0 })), ...Object.entries(ses).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ name: `session ${k.slice(0, 8)}`, size: v, grew: prev ? v - (prevSes[k] || 0) : 0 }))];
      const sessionSizes = Object.fromEntries(Object.entries(ses).sort((a, b) => b[1] - a[1]).slice(0, 50));
      return { roots: sizes, sessionSizes, top: list.sort((a, b) => (b.grew > 0 ? b.grew : 0) - (a.grew > 0 ? a.grew : 0) || b.size - a.size) };
    },
    changedAt: (d, days = 1) => {
      const rec = sh('/usr/bin/find', [d, '-mtime', `-${days}`, '-print', '-quit'], { timeout: 300000 });
      if (rec.error || rec.stdout.trim()) return Date.now();
      const c = Number(sh('/usr/bin/git', ['-C', d, 'log', '-1', '--format=%ct']).stdout.trim());
      try { return Math.max(fs.statSync(d).mtimeMs, (Number.isFinite(c) ? c : 0) * 1000); } catch { return Date.now(); }
    },
    git: (d) => ({
      dirty: sh('/usr/bin/git', ['-C', d, 'status', '--porcelain']).stdout.trim() !== '',
      unpushed: sh('/usr/bin/git', ['-C', d, 'log', '--oneline', 'HEAD', '--not', '--remotes']).stdout.trim() !== '',
    }),
    rescue: (d) => {
      const dir = path.join(rescueRoot, `${path.relative(home, d).replace(/\//g, '__')}-${Date.now()}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'diff.patch'), sh('/usr/bin/git', ['-C', d, 'diff', 'HEAD']).stdout);
      const files = sh('/usr/bin/git', ['-C', d, 'ls-files', '--others', '--exclude-standard', '-z']).stdout;
      if (files) sh('/usr/bin/tar', ['-cf', path.join(dir, 'untracked.tar'), '-C', d, '--null', '-T', '-'], { input: files });
      sh('/usr/bin/git', ['-C', d, 'bundle', 'create', path.join(dir, 'repo.bundle'), 'HEAD', '--not', '--remotes']);
      return dir;
    },
    removeWorktree: (d) => {
      const common = sh('/usr/bin/git', ['-C', d, 'rev-parse', '--git-common-dir']).stdout.trim();
      const g = path.resolve(d, common);
      sh('/usr/bin/git', ['--git-dir', g, 'worktree', 'remove', '--force', d]);
      sh('/usr/bin/git', ['--git-dir', g, 'worktree', 'prune']);
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
      openList = undefined; protectedPaths = null;
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
      try { idleIds = new Set((await snapshot(base)).filter((x) => x.state === 'idle').map((x) => x.id)); } catch { idleIds = null; }
      appPaths = w ? new Set(w.map((r) => r.p)) : null;
      liveIds = s ? new Set(s.map((r) => r.id)) : null;
    },
  };
}
