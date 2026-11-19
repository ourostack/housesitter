// `housesitter restart-copilot --load-shed`: keep the Mac responsive under load, with no model turns. Batch work that agent
// lanes start (mutation testing, derive runs, test runners, headless browsers, image tools) can push the 1-minute load far above
// the core count, and then the Copilot app cannot start a session ("Agency startup timed out"). launchd runs one pass every 30 s.
// While the load is above threshold_per_core x cores (2 x by default), every process that matches a batch pattern, and every
// descendant of one, is reniced to +15 and, on macOS, put in background QoS with `taskpolicy -b`. Nice only lowers priority, so
// nothing is restored. The Copilot app, copilot-runtime, agency, git, launchd's own daemons and anything Housesitter or
// Shepherd run are never touched, whatever else they match. A process that is already at +15 is skipped, so a pass is idempotent.
// Config (top level of config.json):
//   "load_shed": { "enabled": true, "threshold_per_core": 2, "threshold": null /* an absolute load, wins over per-core */,
//                  "nice": 15, "patterns": ["extra regex on the command line", …], "exclude": ["extra regex never touched", …],
//                  "replace_patterns": false /* true: only your patterns, not the defaults */ }
// Every renice is logged (pid, command, load); each pass writes load-shed.json (shown by `restart-copilot --status`) and one
// line to load-ledger.jsonl (load, cores, matched, reniced), so a later pass can show whether the load fell and sessions start again.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { iso, readJson, writeJson } from './recovery.mjs';

export const LS = {
  perCore: 2,
  nice: 15,
  ledgerKeep: 2880, // a day of 30 s passes
};

// Regexes tested against the whole command line.
export const DEFAULT_PATTERNS = [
  'stryker',
  'mutation',
  'brand/tools/derive\\.py',
  '\\bderive\\.py\\b',
  'brand/tools/[\\w-]+\\.py\\b',
  'multiprocessing\\.(spawn|forkserver|resource_tracker)\\b',
  'playwright',
  '--headless',
  'headless_shell',
  'chrome-headless',
  '\\bnode\\b.*\\s--test\\b',
  'go-build[0-9]+/.*\\.test\\b',
  '\\bgo\\s+test\\b',
  '\\bcargo\\s+(test|nextest)\\b',
  '\\b(pytest|vitest|jest)\\b',
  '\\b(npm|pnpm|yarn)\\s+(run\\s+)?test\\b',
  '\\b(magick|convert|cwebp|dwebp|pngquant|optipng|oxipng|svgo|ffmpeg)\\b',
];

// Never touched, even when a pattern matches or the process descends from a match.
export const DEFAULT_EXCLUDES = [
  '/Copilot[^/ ]*\\.app/',
  '\\bcopilot-runtime\\b',
  '(^|/)copilot(\\s|$)',
  '(^|/)agency[^/ ]*(\\s|$)',
  '(^|/)git(\\s|$)',
  '(^|/)git-[a-z-]+(\\s|$)',
  'bin/(housesitter|shepherd)(\\.mjs)?(\\s|$)',
  '(^|/)(housesitter|shepherd)(\\s|$)',
  '@ouro\\.bot/(housesitter|shepherd)',
  '/(housesitter|shepherd)/(current|releases)/',
  '^/(System|usr/libexec|usr/sbin|sbin|Library/Apple)/',
];

const compile = (xs) => xs.map((x) => new RegExp(x, 'i'));

export function settings(cfg = {}) {
  const c = cfg.load_shed || {};
  const patterns = [...(c.replace_patterns ? [] : DEFAULT_PATTERNS), ...(c.patterns || [])];
  return {
    enabled: c.enabled !== false,
    perCore: Number(c.threshold_per_core) > 0 ? Number(c.threshold_per_core) : LS.perCore,
    threshold: Number(c.threshold) > 0 ? Number(c.threshold) : null,
    nice: Number(c.nice) > 0 ? Math.min(19, Number(c.nice)) : LS.nice,
    patterns: compile(patterns),
    excludes: compile([...DEFAULT_EXCLUDES, ...(c.exclude || [])]),
  };
}

export const limit = (s, cores) => s.threshold ?? s.perCore * cores;

// Pure: which processes to renice. `procs`: [{ pid, ppid, nice, command }]; `protectedPids`: this process and its ancestors.
// A match is a process whose command matches a pattern; its descendants join it. An excluded process is skipped along with
// everything under it, and a process already at the target nice or lower in priority is skipped (idempotence).
export function pick(procs, s, protectedPids = new Set()) {
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const excluded = (p) => protectedPids.has(p.pid) || p.pid <= 1 || s.excludes.some((r) => r.test(p.command));
  const chosen = new Map();
  const take = (p, root) => {
    if (chosen.has(p.pid) || excluded(p)) return;
    chosen.set(p.pid, { ...p, why: root === p ? 'pattern' : `descendant of ${root.pid}` });
    for (const k of kids.get(p.pid) || []) take(k, root);
  };
  for (const p of procs) if (!excluded(p) && s.patterns.some((r) => r.test(p.command))) take(p, p);
  const matched = [...chosen.values()];
  return { matched, todo: matched.filter((p) => !(p.nice >= s.nice)) };
}

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 15000 });

export function listProcesses(uid = process.getuid()) {
  const r = run('/bin/ps', ['-ww', '-U', String(uid), '-o', 'pid=,ppid=,ni=,command=']);
  const out = [];
  for (const l of String(r.stdout || '').split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), nice: Number(m[3]), command: m[4] });
  }
  return out;
}

export function ancestors(procs, pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const set = new Set();
  for (let p = byPid.get(pid); p && !set.has(p.pid); p = byPid.get(p.ppid)) set.add(p.pid);
  return set;
}

export function realLoadDeps({ state, platform = process.platform, cfgLoad } = {}) {
  return {
    now: () => Date.now(),
    load: () => os.loadavg()[0],
    cores: () => os.cpus().length,
    procs: () => listProcesses(),
    self: () => process.pid,
    renice: (pid, n) => run('/usr/bin/renice', ['-n', String(n), '-p', String(pid)]).status === 0,
    background: (pid) => platform === 'darwin' && run('/usr/sbin/taskpolicy', ['-b', '-p', String(pid)]).status === 0,
    readState: () => readJson(path.join(state, 'load-shed.json'), null),
    writeState: (o) => writeJson(path.join(state, 'load-shed.json'), o),
    ledger: (row) => appendLedger(path.join(state, 'load-ledger.jsonl'), row),
    cfg: () => cfgLoad?.() || {},
  };
}

export function appendLedger(file, row, keep = LS.ledgerKeep) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > keep + 200) fs.writeFileSync(file, `${lines.slice(-keep).join('\n')}\n`);
  } catch { /* a ledger that cannot be trimmed is still a ledger */ }
}

export function readLedger(state, n = 120) {
  try { return fs.readFileSync(path.join(state, 'load-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
}

const clip = (s, n = 100) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// One pass. deps are real (realLoadDeps) or fakes.
export async function pass(opts, deps, say = () => {}) {
  const s = settings(deps.cfg());
  const now = deps.now(), load = deps.load(), cores = deps.cores();
  const lim = limit(s, cores);
  const out = (m) => say(`${iso(now)} load-shed: ${m}`);
  const base = { at: iso(now), load1: Number(load.toFixed(2)), cores, limit: lim };
  const record = (o) => {
    const row = { ...base, matched: o.matched || 0, reniced: o.reniced?.length || 0, action: o.action };
    if (!opts.dry_run) { deps.writeState({ ...row, reniced: o.reniced || [], skipped: o.skipped || 0 }); deps.ledger?.(row); }
    return { ...row, reniced: o.reniced || [] };
  };
  if (!s.enabled) return record({ action: 'disabled' });
  if (!(load > lim)) return record({ action: 'ok' });

  const procs = deps.procs();
  const { matched, todo } = pick(procs, s, ancestors(procs, deps.self()));
  const reniced = [];
  for (const p of todo) {
    if (opts.dry_run) { out(`would renice +${s.nice} pid ${p.pid} ${clip(p.command)} (load ${base.load1} > ${lim})`); reniced.push({ pid: p.pid, command: clip(p.command, 200), nice: p.nice, dry: true }); continue; }
    if (!deps.renice(p.pid, s.nice)) continue; // gone, or not ours
    const bg = deps.background?.(p.pid) || false;
    reniced.push({ pid: p.pid, command: clip(p.command, 200), was: p.nice, background: bg });
    out(`renice +${s.nice}${bg ? ' + taskpolicy -b' : ''} pid ${p.pid} ${clip(p.command)} (load ${base.load1} > ${lim}; ${p.why})`);
  }
  if (!reniced.length && !(deps.readState()?.action === 'busy-nothing')) out(`load ${base.load1} > ${lim} but nothing batch left to renice (${matched.length} matched, all already low priority)`);
  return record({ action: reniced.length ? 'shed' : 'busy-nothing', matched: matched.length, reniced, skipped: matched.length - todo.length });
}

export function renderLoad(st, ledger = []) {
  if (!st) return 'load-shed: not running yet (restart-copilot --install-recovery)';
  const L = [`load-shed: last pass ${st.at}: load ${st.load1} on ${st.cores} cores (limit ${st.limit}); ${st.action === 'ok' ? 'under the limit, nothing to do' : st.action === 'disabled' ? 'disabled in config' : `reniced ${st.reniced?.length || 0} of ${st.matched} batch processes (${st.skipped || 0} already low priority)`}`];
  for (const r of (st.reniced || []).slice(0, 5)) L.push(`  pid ${r.pid} ${clip(r.command, 80)}`);
  if (ledger.length >= 2) {
    const loads = ledger.map((r) => r.load1);
    const over = ledger.filter((r) => r.action === 'shed' || r.action === 'busy-nothing');
    L.push(`  last ${ledger.length} passes: load min ${Math.min(...loads)} / max ${Math.max(...loads)} / now ${loads.at(-1)}; over the limit in ${over.length}; ${ledger.reduce((a, r) => a + (r.reniced || 0), 0)} reniced in all (${ledger[0].at} to ${ledger.at(-1).at})`);
  }
  return L.join('\n');
}

export const readLoad = (state) => ({ last: readJson(path.join(state, 'load-shed.json'), null), ledger: readLedger(state) });
