// Part of `housesitter restart-copilot --load-shed` (every 30 s, no model turns): restart the GitHub Copilot app when its own web
// view has grown too big. The app's WebKit WebContent process grows without bound (11 GB after a day on the mini, most of it
// WebKit malloc), nothing else frees it, and on a Mac that is short of memory it is the largest single holder.
// The restart is the one `housesitter restart-copilot --resume` does: sessions at a safe point, quit, relaunch, resume.
// It starts only when all of these hold: the app's WebContent footprint is over the limit; Ari's keyboard and mouse have been
// idle for the minimum time (HIDIdleTime); no session is mid-turn (Shepherd's view); no restart already ran in the last
// min_gap_hours (so at most once a night); and no other restart is running. And nothing is held only in the app's memory:
// restart-guards.mjs holds the restart while a session has a queued message, an unanswered ask or plan wait, a tool call in
// flight, an unsent composer draft, a background shell or agent, or a schedule about to fire. Before a restart the sessions,
// worktrees (branch and `git status`) and schedules are recorded as `before` in app-bloat.json; the first pass after the app is
// back compares them as `verified` (the evidence that a restart loses nothing). Each decision is logged and kept in app-bloat.json.
// Config (top level of config.json):
//   "app_bloat": { "enabled": true, "limit_gb": 6, "idle_minutes": 30, "min_gap_hours": 18 }
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { iso, readJson, writeJson } from './recovery.mjs';
import { compareStates, holds as guardHolds, realGuardDeps, renderHolds } from './restart-guards.mjs';

export const AB = { limitGb: 6, idleMinutes: 30, minGapHours: 18 };

export function settings(cfg = {}) {
  const c = cfg.app_bloat || {};
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return {
    enabled: c.enabled !== false,
    limitMb: num(c.limit_gb, AB.limitGb) * 1024,
    idleMs: num(c.idle_minutes, AB.idleMinutes) * 60_000,
    gapMs: num(c.min_gap_hours, AB.minGapHours) * 3_600_000,
  };
}

// Pure. `m`: { webMb (the app's WebContent footprint, null when unknown), idleMs (null when unknown), busy (sessions mid-turn,
// null when unknown), lastRestartAt (ms or null), restarting (a restart is running), now }. Returns { restart, why }.
// Anything unknown holds the restart: it is never done on a guess.
export function decide(m, s) {
  if (!s.enabled) return { restart: false, why: 'disabled' };
  if (m.webMb == null) return { restart: false, why: 'the app\'s web view size is unknown' };
  if (m.webMb < s.limitMb) return { restart: false, why: `web view ${Math.round(m.webMb)} MB is under ${Math.round(s.limitMb)} MB` };
  if (m.restarting) return { restart: false, why: 'a restart is already running' };
  if (m.lastRestartAt != null && m.now - m.lastRestartAt < s.gapMs) return { restart: false, why: `restarted ${Math.round((m.now - m.lastRestartAt) / 3_600_000)} h ago; once a night at most` };
  if (m.idleMs == null) return { restart: false, why: 'keyboard idle time is unknown' };
  if (m.idleMs < s.idleMs) return { restart: false, why: `someone was at the keyboard ${Math.round(m.idleMs / 60_000)} min ago (needs ${Math.round(s.idleMs / 60_000)})` };
  if (m.busy == null) return { restart: false, why: 'which sessions are mid-turn is unknown' };
  if (m.busy > 0) return { restart: false, why: `${m.busy} session(s) are mid-turn` };
  return { restart: true, why: `web view ${Math.round(m.webMb)} MB is over ${Math.round(s.limitMb)} MB, idle ${Math.round(m.idleMs / 60_000)} min, no session mid-turn` };
}

const run = (cmd, args, timeout = 20000) => spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 1 << 24 });

// macOS has no shell command for "which app owns this process" without root, only libSystem's responsibility call.
const RESPONSIBLE = 'import ctypes,sys\nf=ctypes.CDLL("/usr/lib/libSystem.B.dylib").responsibility_get_pid_responsible_for_pid\nf.argtypes=[ctypes.c_int];f.restype=ctypes.c_int\nfor p in sys.argv[1:]:print(p,f(int(p)))';
const UNITS = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 };

export function parseFootprint(out) {
  const m = /Footprint:\s*([\d.]+)\s*([KMG]?B)\b/.exec(out || '');
  return m ? Number(m[1]) * UNITS[m[2]] : null;
}

// ps lines: pid, then the command. Returns the pids of WebKit WebContent processes.
export const webContentPids = (psOut) => String(psOut).split('\n').flatMap((l) => { const m = /^\s*(\d+)\s+.*com\.apple\.WebKit\.WebContent\s*$/.exec(l); return m ? [Number(m[1])] : []; });

export function parseIdle(ioregOut) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOut || '');
  return m ? Number(m[1]) / 1e6 : null;
}

export function realBloatDeps({ state, cfgLoad, copilot, busy, detach, app, resumeRecord, bundle = 'GitHub Copilot.app' } = {}) {
  const g = app ? realGuardDeps({ app }) : null;
  return {
    guards: g ? async () => guardHolds(await g.inventory()) : undefined,
    snapshot: g?.state,
    resumeRecord,
    now: () => Date.now(),
    cfg: () => cfgLoad?.() || {},
    webMb: () => {
      const pids = webContentPids(run('/bin/ps', ['-axo', 'pid=,command=']).stdout);
      if (!pids.length) return { mb: 0, pids: [] };
      const owner = new Map(String(run('/usr/bin/python3', ['-c', RESPONSIBLE, ...pids.map(String)]).stdout).split('\n').filter(Boolean).map((l) => l.split(' ').map(Number)));
      const mine = pids.filter((p) => {
        const r = owner.get(p);
        return r && String(run('/bin/ps', ['-o', 'command=', '-p', String(r)]).stdout).includes(`/${bundle}/`);
      });
      if (!mine.length) return { mb: 0, pids: [] };
      const sizes = mine.map((p) => parseFootprint(run('/usr/bin/footprint', ['-p', String(p), '--noCategories']).stdout));
      return sizes.some((x) => x == null) ? { mb: null, pids: mine } : { mb: sizes.reduce((a, b) => a + b, 0), pids: mine };
    },
    idleMs: () => parseIdle(run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4']).stdout),
    busy,
    restarting: () => Boolean(copilot?.runInProgress?.(copilot.stateDir?.())),
    detach,
    readState: () => readJson(path.join(state, 'app-bloat.json'), null),
    writeState: (o) => writeJson(path.join(state, 'app-bloat.json'), o),
  };
}

// After a restart: compare what was recorded before it with what is there now, and with Shepherd's record of the resumes.
async function verify(prior, deps, now) {
  const after = await deps.snapshot();
  const cmp = compareStates(prior.before, after);
  const rec = deps.resumeRecord?.() || null;
  const fresh = rec && Date.parse(rec.at) >= (prior.lastRestartAt || 0);
  const notResumed = fresh ? (rec.results || []).filter((r) => !/^(resumed|already continued|gone)/.test(r.outcome)).map((r) => ({ id: r.id, outcome: r.outcome })) : [];
  return { at: iso(now), ok: cmp.ok && notResumed.length === 0, sessions_before: cmp.sessions, sessions_after: after.sessions.length, problems: cmp.problems, not_resumed: notResumed, resume_checked: Boolean(fresh), resumed: fresh ? (rec.resumed || []).length : null };
}

// One pass. Returns { at, action: 'restarted'|'held'|'would-restart'|'disabled', why, ... }; a dry run starts nothing and writes nothing.
export async function pass(opts, deps, say = () => {}) {
  const s = settings(deps.cfg());
  const at = iso(deps.now());
  if (!s.enabled) return { at, action: 'disabled', why: 'disabled' };
  const web = deps.webMb();
  let prior = deps.readState();
  // The first calm pass after a restart: did every session, worktree and schedule come back as it was?
  if (prior?.before && !prior.verified && prior.lastRestartAt != null && deps.snapshot && !deps.restarting?.() && deps.now() - prior.lastRestartAt > 5 * 60000) {
    try {
      const v = await verify(prior, deps, deps.now());
      prior = { ...prior, verified: v };
      if (!opts.dry_run) deps.writeState(prior);
      say(`${at} app-bloat: after the restart ${v.ok ? `all ${v.sessions_after} session(s) are back with their worktrees and schedules` : `NOT ALL BACK: ${v.problems.slice(0, 3).map((p) => p.why).join('; ') || ''}${v.not_resumed.length ? ` ${v.not_resumed.length} not resumed` : ''}`}`);
    } catch { /* tried again next pass */ }
  }
  const keep = { lastRestartAt: prior?.lastRestartAt ?? null, before: prior?.before, verified: prior?.verified };
  // The expensive reads wait until the cheap test passes: a Mac under the limit pays for one ps and one footprint.
  const cheap = decide({ webMb: web.mb, idleMs: 1e12, busy: 0, lastRestartAt: keep.lastRestartAt, restarting: false, now: deps.now() }, s);
  let m = { webMb: web.mb, idleMs: null, busy: null, lastRestartAt: keep.lastRestartAt, restarting: false, now: deps.now() };
  let d = cheap;
  let held = [];
  if (cheap.restart) {
    m = { ...m, idleMs: deps.idleMs(), restarting: Boolean(deps.restarting?.()) };
    try { m.busy = await deps.busy(); } catch { m.busy = null; }
    d = decide(m, s);
    if (d.restart && deps.guards) {
      try { held = await deps.guards(); } catch (e) { held = [{ guard: 'unreadable', session: null, why: `the guards could not be read (${String(e.message || e).slice(0, 80)})` }]; }
      if (held.length) d = { restart: false, why: `held by a guard: ${renderHolds(held)}` };
    }
  }
  const out = { at, action: d.restart ? (opts.dry_run ? 'would-restart' : 'restarted') : 'held', why: d.why, web_mb: web.mb == null ? null : Math.round(web.mb), web_pids: web.pids, idle_min: m.idleMs == null ? null : Math.round(m.idleMs / 60_000), busy: m.busy, guards: held.length ? held : undefined };
  if (d.restart && !opts.dry_run) {
    let before = null;
    try { before = await deps.snapshot?.(); } catch { before = null; }
    const r = await deps.detach(`the app's web view is ${out.web_mb} MB`);
    if (!r.ok) { out.action = 'failed'; out.why = `launchd would not start the restart: ${r.error}`; } else { out.log = r.log; deps.writeState({ ...out, lastRestartAt: deps.now(), before: before || undefined, verified: undefined }); }
  }
  if (d.restart || prior?.action !== out.action || prior?.why !== out.why) say(`${at} app-bloat: ${out.action}: ${out.why}`);
  if (!opts.dry_run && !d.restart && (prior?.action !== 'held' || prior?.why !== out.why)) deps.writeState({ ...out, ...keep });
  return out;
}

export const homeState = (home = os.homedir()) => path.join(home, 'Library', 'Caches', 'housesitter');
