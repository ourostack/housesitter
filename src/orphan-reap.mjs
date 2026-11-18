// Part of `housesitter restart-copilot --load-shed` (every 30 s, no model turns): end the headless browsers and dev servers that
// agent lanes leave running after the lane's own process has gone.
// A lane starts a browser or a dev server through a shell it owns. When the shell exits, the child is adopted by launchd (parent
// pid 1) and nothing ever stops it, so a day of lanes leaves gigabytes of orphaned Chromium, Edge, vite and http.server behind.
// A process is reaped only when all of these hold: its parent is launchd; it matches a lane-scratch pattern below (a browser
// started with a throwaway profile, or a dev server); it has run longer than the minimum age; and, for a dev server or a browser that was not itself started with a throwaway profile, its working
// folder is a worktree or scratch folder, never a repository checkout someone works in. The whole tree under it goes with it
// (SIGTERM, so the process can clean up). A process whose parent is alive is never touched, so a running lane keeps its server.
// Config (top level of config.json):
//   "orphan_reap": { "enabled": true, "browser_min_hours": 2, "server_min_hours": 3, "exclude": ["extra regex never reaped"] }
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { iso, readJson, writeJson } from './recovery.mjs';

export const OR = { browserHours: 2, serverHours: 3 };

// Browsers a lane drives: a throwaway profile, or the test browsers Playwright installs (Chromium, Firefox and WebKit, which
// carries its own WebKit.framework, so its helper processes match by path). The system WebKit services
// (/System/Library/Frameworks/WebKit.framework/.../com.apple.WebKit.WebContent) belong to an app such as Safari, Mail or the
// Copilot app, are adopted by launchd from birth and are never matched here.
export const BROWSER_PATTERNS = [
  '--user-data-dir=\\S*(github-browser-|playwright[^/ ]*profile|puppeteer_dev)',
  '/ms-playwright/',
  '/webkit-[0-9]+/(pw_run\\.sh|Playwright\\.app|minibrowser-)',
  'chrome-headless-shell',
];

// Servers a lane starts to look at its own work.
export const SERVER_PATTERNS = [
  '\\bpython[0-9.]*\\s+-m\\s+http\\.server\\b|/Python\\s+-m\\s+http\\.server\\b',
  '\\bvite(\\.js|\\s|$)',
  '\\bnext\\s+(dev|start)\\b',
  '\\bnode\\s+(\\S+/)?test/serve\\.mjs\\b',
  '\\bnode\\b.*\\s(\\S+/)?src/daemon/main\\.mjs\\b',
  '\\bhttp-server\\b',
  '\\bwebpack(-dev-server)?\\s+serve\\b',
];

// Never reaped, whatever else matches.
export const DEFAULT_EXCLUDES = [
  '/Copilot[^/ ]*\\.app/',
  '\\bcopilot-runtime\\b',
  '(^|/)copilot(\\s|$)',
  '(^|/)agency[^/ ]*(\\s|$)',
  'bin/(housesitter|shepherd)(\\.mjs)?(\\s|$)',
  '/(housesitter|shepherd)/(current|releases)/',
  '^/(System|usr/libexec|usr/sbin|sbin|Library/Apple)/',
];

// A scratch folder: a git worktree, a lane's scratch checkout, or a temp folder. A main checkout is not.
export const SCRATCH_CWD = /(-worktrees?\/|\.noindex(\/|$)|\/copilot-worktrees\/|-wt[0-9]*(\/|$)|^\/(private\/)?(tmp|var\/folders)\/)/;

const compile = (xs) => xs.map((x) => new RegExp(x, 'i'));

export function settings(cfg = {}) {
  const c = cfg.orphan_reap || {};
  const hours = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return {
    enabled: c.enabled !== false,
    browserMs: hours(c.browser_min_hours, OR.browserHours) * 3_600_000,
    serverMs: hours(c.server_min_hours, OR.serverHours) * 3_600_000,
    browsers: compile(BROWSER_PATTERNS),
    servers: compile(SERVER_PATTERNS),
    excludes: compile([...DEFAULT_EXCLUDES, ...(c.exclude || [])]),
  };
}

// `ps` elapsed time: [[dd-]hh:]mm:ss, in milliseconds.
export function parseEtime(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  const [, d = 0, h = 0, mm, s] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(mm)) * 60 + Number(s)) * 1000;
}

// Pure: which process trees to end. `procs`: [{ pid, ppid, ageMs, rssKb, command }]; `cwdOf(pid)`: a process's working folder or null;
// `protectedPids`: this process and its ancestors. Returns [{ root, kind, pids, rssKb }], one per orphaned root.
export function pickOrphans(procs, s, cwdOf = () => null, protectedPids = new Set()) {
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const excluded = (p) => protectedPids.has(p.pid) || s.excludes.some((r) => r.test(p.command));
  const tree = (p, out = []) => { out.push(p); for (const k of kids.get(p.pid) || []) tree(k, out); return out; };
  const picked = [];
  const covered = new Set();
  // The oldest roots first, so a server's npm wrapper takes its child with it and the child is not listed again.
  for (const p of [...procs].sort((a, b) => b.ageMs - a.ageMs)) {
    if (p.ppid !== 1 || p.pid <= 1 || covered.has(p.pid) || excluded(p)) continue;
    const members = tree(p);
    if (members.some(excluded)) continue;
    const browser = members.some((m) => s.browsers.some((r) => r.test(m.command)));
    const server = !browser && members.some((m) => s.servers.some((r) => r.test(m.command)));
    if (!browser && !server) continue;
    if (p.ageMs < (browser ? s.browserMs : s.serverMs)) continue;
    if (server || !s.browsers.some((r) => r.test(p.command))) {
      const cwd = members.map((m) => cwdOf(m.pid)).find(Boolean);
      if (!cwd || !SCRATCH_CWD.test(cwd.endsWith('/') ? cwd : `${cwd}/`)) continue;
    }
    for (const m of members) covered.add(m.pid);
    picked.push({ root: p, kind: browser ? 'browser' : 'server', pids: members.map((m) => m.pid), rssKb: members.reduce((a, m) => a + (m.rssKb || 0), 0) });
  }
  return picked;
}

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 15000 });

export function listProcesses(uid = process.getuid()) {
  const r = run('/bin/ps', ['-ww', '-U', String(uid), '-o', 'pid=,ppid=,etime=,rss=,command=']);
  const out = [];
  for (const l of String(r.stdout || '').split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    const ageMs = m ? parseEtime(m[3]) : null;
    if (m && ageMs !== null) out.push({ pid: Number(m[1]), ppid: Number(m[2]), ageMs, rssKb: Number(m[4]), command: m[5] });
  }
  return out;
}

export function realReapDeps({ state, cfgLoad } = {}) {
  return {
    now: () => Date.now(),
    procs: () => listProcesses(),
    self: () => process.pid,
    cwd: (pid) => {
      const r = run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn']);
      return String(r.stdout || '').split('\n').find((l) => l.startsWith('n'))?.slice(1) || null;
    },
    kill: (pid) => { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } },
    writeState: (o) => writeJson(path.join(state, 'orphan-reap.json'), o),
    readState: () => readJson(path.join(state, 'orphan-reap.json'), null),
    cfg: () => cfgLoad?.() || {},
  };
}

const ancestors = (procs, pid) => {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const set = new Set();
  for (let p = byPid.get(pid); p && !set.has(p.pid); p = byPid.get(p.ppid)) set.add(p.pid);
  return set;
};
const clip = (s, n = 100) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// One pass. Returns { action, reaped: [{ pid, kind, command, count, mb }] }; a dry run changes nothing.
export async function pass(opts, deps, say = () => {}) {
  const s = settings(deps.cfg());
  const at = iso(deps.now());
  if (!s.enabled) return { at, action: 'disabled', reaped: [] };
  const procs = deps.procs();
  const found = pickOrphans(procs, s, (pid) => deps.cwd(pid), ancestors(procs, deps.self()));
  const reaped = [];
  for (const f of found) {
    const row = { pid: f.root.pid, kind: f.kind, command: clip(f.root.command, 200), count: f.pids.length, mb: Math.round(f.rssKb / 1024) };
    if (opts.dry_run) { say(`${at} orphan-reap: would end ${f.kind} pid ${row.pid} and ${row.count - 1} child(ren), ${row.mb} MB: ${clip(row.command)}`); reaped.push({ ...row, dry: true }); continue; }
    const ended = f.pids.filter((pid) => deps.kill(pid)).length;
    if (!ended) continue;
    reaped.push(row);
    say(`${at} orphan-reap: ended ${f.kind} pid ${row.pid} and ${row.count - 1} child(ren), ${row.mb} MB, left running ${Math.round(f.root.ageMs / 3_600_000)} h by a lane that is gone: ${clip(row.command)}`);
  }
  const out = { at, action: reaped.length ? 'reaped' : 'ok', reaped };
  if (!opts.dry_run && (reaped.length || deps.readState()?.action === 'reaped')) deps.writeState(out);
  return out;
}
