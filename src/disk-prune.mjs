// `housesitter restart-copilot --disk-prune`: keep the data volume under 80% with no model turns. launchd runs one pass
// every ten minutes; a pass does nothing below 80% used. Above it, it prunes safe classes in this order and stops as soon
// as the volume is back under 75%:
//   1. caches that rebuild themselves (npm, pip, Go, pnpm, Playwright, gh, the Copilot SDK)
//   2. the Copilot app's worktrees that no session uses and nobody has touched for a day: a worktree goes only if
//      no unarchived app session has it, no running process has a file open under it, and nothing in it changed in
//      24 hours. A name never qualifies one. Uncommitted or unpushed work is saved under ~/AgentBundles/disk-rescue first.
//   3. the history of a session the app no longer lists (gone or archived), compressed, never deleted
// What it reclaimed is told once, through the agent; a pass that cannot get under 80% says so once a day.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realDeps, stateDir } from './copilot-app.mjs';
import { iso, readJson, realTell, writeJson } from './recovery.mjs';

export const DP = {
  trigger: 80, // percent used at which a pass starts pruning
  goal: 75, // percent used at which it stops
  quiet: 24 * 3600000, // a worktree or history changed within this is never touched
  minHistory: 20 * 1048576, // smaller histories are not worth compressing
  nag: 24 * 3600000, // how often "still over 80%" may be said
};

const GIB = 1073741824;
export const gib = (b) => `${(b / GIB).toFixed(1)} GiB`;

export const CACHES = ['.npm/_cacache', '.cache/gh', 'Library/Caches/ms-playwright', 'Library/Caches/pip', 'Library/Caches/go-build', 'Library/Caches/pnpm', 'Library/Caches/github-copilot-sdk'];

// Why a worktree may not be removed now, or null when it may. `w`: { dir, linked, usedByApp, open, changedAt }.
export function whyKeep(w, now, t = DP) {
  if (!w.linked) return 'it is a main checkout, not a linked worktree';
  if (w.usedByApp) return 'an unarchived app session uses it';
  if (w.open) return 'a running process has it open';
  if (!(now - w.changedAt >= t.quiet)) return 'something in it changed in the last 24 hours';
  return null;
}

// One pass. deps are real (realDiskDeps) or fakes.
export async function pass(opts, deps, say = () => {}) {
  const t = { ...DP, ...(opts.t || {}) };
  const now = deps.now();
  const out = (m) => say(`${iso(now)} disk-prune: ${m}`);
  await deps.load?.();
  const before = deps.usage();
  if (before.pct < t.trigger && !opts.force) return { action: 'ok', pct: before.pct };
  const reclaimed = { caches: 0, worktrees: [], histories: 0, rescued: [] };
  const done = () => deps.usage().pct < t.goal;

  for (const c of deps.caches()) {
    if (done()) break;
    const n = deps.size(c); if (!n) continue;
    if (!opts.dry_run) deps.remove(c);
    reclaimed.caches += n; out(`cache ${c}: ${gib(n)}`);
  }

  const used = deps.appWorktrees();
  for (const dir of deps.worktrees()) {
    if (done()) break;
    const w = { dir, linked: deps.linked(dir), usedByApp: used.has(dir), open: false, changedAt: 0 };
    if (w.linked && !w.usedByApp) { w.open = deps.open(dir); if (!w.open) w.changedAt = deps.changedAt(dir); }
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

  const live = deps.liveSessions();
  for (const h of deps.histories()) {
    if (done()) break;
    if (live.has(h.id) || now - h.mtime < t.quiet || h.size < t.minHistory || deps.open(h.file)) continue;
    if (!opts.dry_run) deps.gzip(h.file);
    reclaimed.histories += h.size; out(`compressed history ${h.id.slice(0, 8)}: ${gib(h.size)}`);
  }

  const after = deps.usage();
  const total = reclaimed.caches + reclaimed.histories;
  const res = { action: reclaimed.worktrees.length || total ? 'pruned' : 'nothing-safe', before: before.pct, after: after.pct, reclaimed, dry_run: Boolean(opts.dry_run) };
  if (opts.dry_run) return res;
  const st = deps.readState() || {};
  if (res.action === 'pruned') {
    await deps.tell(`Disk was ${before.pct}% used; disk prune reclaimed caches ${gib(reclaimed.caches)}, ${reclaimed.worktrees.length} unused worktree(s), compressed histories ${gib(reclaimed.histories)}; now ${after.pct}%.${reclaimed.rescued.length ? ` Unsaved work was kept in ${reclaimed.rescued.join(', ')}.` : ''}${after.pct >= t.trigger ? ' Still over 80%: what is left is not safe to prune without Ari.' : ''}`);
    st.toldAt = now;
  } else if (now - (st.toldAt || 0) >= t.nag) {
    await deps.tell(`Disk is ${after.pct}% used and disk prune found nothing safe to remove. What is left belongs to Ari or to live sessions.`);
    st.toldAt = now;
  }
  deps.writeState({ ...st, lastPass: { at: iso(now), ...res } });
  return res;
}

// ---------- the real world ----------

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...o });
const sizeOf = (p) => { const r = sh('/usr/bin/du', ['-sk', p], { timeout: 300000 }); return (Number(String(r.stdout).split(/\s+/)[0]) || 0) * 1024; };

export function realDiskDeps({ home = os.homedir(), copilotHome = path.join(home, '.copilot'), state = stateDir(home), volume = '/System/Volumes/Data' } = {}) {
  const base = realDeps({ copilotHome, state });
  const wt = path.join(copilotHome, 'copilot-worktrees');
  const sessions = path.join(copilotHome, 'session-state');
  const rescueRoot = path.join(home, 'AgentBundles', 'disk-rescue');
  const q = async (sql) => { try { return await base.sql(sql); } catch { return null; } };
  let appPaths = null, liveIds = null;
  return {
    now: () => Date.now(),
    usage: () => { const r = sh('/bin/df', ['-k', volume]).stdout.trim().split('\n').pop().split(/\s+/); const size = Number(r[1]), used = Number(r[2]); return { pct: Math.round((used / size) * 100) }; },
    caches: () => CACHES.map((c) => path.join(home, c)).filter((p) => fs.existsSync(p)),
    size: sizeOf,
    remove: (p) => fs.rmSync(p, { recursive: true, force: true }),
    // Without the app's database nothing is known to be unused, so nothing is removed.
    appWorktrees: () => appPaths || new Set(),
    liveSessions: () => liveIds || new Set(),
    worktrees: () => {
      if (!appPaths) return [];
      const out = [];
      try { for (const r of fs.readdirSync(wt)) for (const n of fs.readdirSync(path.join(wt, r))) { const d = path.join(wt, r, n); if (fs.existsSync(path.join(d, '.git'))) out.push(d); } } catch { /* none */ }
      return out;
    },
    linked: (d) => { try { return fs.statSync(path.join(d, '.git')).isFile(); } catch { return false; } },
    open: (p) => { const r = sh('/usr/sbin/lsof', fs.statSync(p).isDirectory() ? ['+D', p] : [p], { timeout: 120000 }); return r.error || r.status === null ? true : r.stdout.trim().length > 0; },
    changedAt: (d) => {
      const rec = sh('/usr/bin/find', [d, '-mtime', '-1', '-print', '-quit'], { timeout: 300000 });
      if (rec.error || rec.stdout.trim()) return Date.now();
      const c = Number(sh('/usr/bin/git', ['-C', d, 'log', '-1', '--format=%ct']).stdout.trim());
      return Math.max(fs.statSync(d).mtimeMs, (Number.isFinite(c) ? c : 0) * 1000);
    },
    git: (d) => ({
      dirty: sh('/usr/bin/git', ['-C', d, 'status', '--porcelain']).stdout.trim() !== '',
      unpushed: sh('/usr/bin/git', ['-C', d, 'log', '--oneline', 'HEAD', '--not', '--remotes']).stdout.trim() !== '',
    }),
    rescue: (d) => {
      const dir = path.join(rescueRoot, `${path.relative(wt, d).replace(/\//g, '__')}-${Date.now()}`);
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
    gzip: (f) => { sh('/usr/bin/gzip', ['-1', f]); },
    tell: realTell({ state, home }),
    readState: () => readJson(path.join(state, 'disk-prune.json'), {}),
    writeState: (o) => writeJson(path.join(state, 'disk-prune.json'), o),
    // Reads the app's database once per pass; the pass calls this first.
    load: async () => {
      const w = await q('SELECT w.path AS p FROM worktrees w JOIN workspaces k ON k.worktree_id = w.id WHERE k.archived_at IS NULL');
      const s = await q('SELECT id FROM sessions WHERE archived_at IS NULL');
      appPaths = w ? new Set(w.map((r) => r.p)) : null;
      liveIds = s ? new Set(s.map((r) => r.id)) : null;
    },
  };
}
