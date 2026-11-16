// `housesitter restart-copilot --heartbeat`: a probe of the GitHub Copilot app that spends no model tokens, run by launchd
// every 30 s. It looks at two things that fail separately: the app's local socket (its server) and its window (its main
// thread, through hackamore's accessibility read, which only the main thread can answer). On 15 November the window froze
// while the socket kept answering, so the socket alone calls a frozen app healthy.
//
//   a probe fails         → record when it first failed; one pass later, again
//   failing for 2 min     → freeze: confirm with longer timeouts, capture evidence, quit (SIGTERM, then SIGKILL to the
//                            exact pids), relaunch, resume every session that was working, tell the person once
//   the app is gone       → if a crash report names it, or sessions were working and it has been gone 5 min: relaunch
//                            and resume the same way. A quit by a person leaves no report and stays quit.
//   a gap in these runs   → the Mac itself stopped for 5+ min (a reboot, a sleep, a hang): record the cause, tell once
//
// Everything that touches the Mac goes through `deps`, so tests run it against a pretend Mac and a pretend hung app.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appGeneration, appReady, family, findMain, isDone, resumeAfter, runInProgress, skipOf, snapshot, stateDir, T, realDeps, DEFAULT_APP } from './copilot-app.mjs';
import { judgeProgress } from './progress.mjs';
import { hhmm, iso, incidentsDir, readJson, recentIncidents, recordIncident, realTell, run, short, writeJson } from './recovery.mjs';

export const HB = {
  freeze: 0, // the silence itself (see progress.mjs) is the wait
  minBeats: 2, // and on at least this many runs
  beatGap: 100000, // runs further apart than this do not make one streak
  stall: 300000, // a gap this long between runs is the Mac stopping
  absent: 300000, // an app gone this long with sessions working is relaunched even with no crash report
  socketMs: 5000, windowMs: 15000, confirmSocketMs: 15000, confirmWindowMs: 30000,
  term: 15000, kill: 10000, // waits after SIGTERM and after SIGKILL
  hour: 3600000, cap: 3, // recoveries an hour before it stops and tells the person
  stormMs: 15 * 60000, stormCap: 2, // storm brake: this many freeze restarts in this long, and it snapshots memory and backs off
  settleAfterBoot: 10 * 60000, // how long after a stall it waits for the resume before it tells
};

// ---------- pure ----------

// Fold one run's probe failures into the streak. `bad` is the streak so far (or null).
export function judge(bad, failures, now, t = HB) {
  if (!failures.length) return { bad: null, frozen: false };
  const prev = bad && now - Date.parse(bad.last) <= t.beatGap ? bad : null;
  const next = { since: prev?.since || iso(now), last: iso(now), count: (prev?.count || 0) + 1, failures: [...new Set([...(prev?.failures || []), ...failures])] };
  return { bad: next, frozen: now - Date.parse(next.since) >= t.freeze && next.count >= t.minBeats };
}

const FAILURE_TEXT = { 'window-timeout': 'its window stopped answering (the main thread did not respond to an accessibility read)', 'no-progress': 'the sessions it says are working all stopped writing events',
  'socket-timeout': 'its socket took a connection but never said hello', 'socket-down': 'its socket was not serving' };
export const failureText = (fs_) => fs_.map((f) => FAILURE_TEXT[f] || f).join(' and ');

// The heaviest path of a `sample` report's first thread: follow the first child at each deeper line to the leaf.
export function heaviestPath(text, depth = 8) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => /^\s*\d+ Thread_\d+/.test(l));
  if (start < 0) return [];
  const out = [];
  let last = -1;
  for (const l of lines.slice(start)) {
    const m = l.match(/^([\s+!:|]*?)(\d+) (.+?)(?:\s+\(in [^)]*\))?\s*(?:\+ \d+)?\s*(?:\[0x[0-9a-f]+\])?$/);
    if (!m) { if (out.length) break; else continue; }
    const col = m[1].length;
    if (col <= last) break;
    last = col;
    out.push(m[3].replace(/\s+\(in .*$/, '').trim());
  }
  return out.slice(-depth);
}

// A crash report (.ips: a header line, then JSON) in one line: how it ended and the frames that called it.
export function crashSummary(text) {
  try {
    const b = JSON.parse(String(text).split('\n').slice(1).join('\n'));
    const skip = /^(__pthread_kill|pthread_kill|abort|__abort_message|demangling_terminate_handler|_objc_terminate|std::__terminate|__cxa_rethrow|objc_exception_rethrow|__exceptionPreprocess|objc_exception_throw|\+\[NSException exceptionWithName:reason:userInfo:\])/;
    const frames = (b.lastExceptionBacktrace || b.threads?.[b.faultingThread]?.frames || []).map((f) => f.symbol).filter((s) => s && !skip.test(s));
    return { signal: b.exception?.signal || null, type: b.exception?.type || null, asi: b.asi ? Object.values(b.asi).flat().join('; ') : null, frames: frames.slice(0, 4), launched: b.procLaunch || null };
  } catch { return null; }
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const sessionsText = (res) => {
  const ok = res.filter((r) => ['resumed', 'already continued'].includes(r.outcome)).length;
  const bad = res.filter((r) => !isDone(r.outcome));
  const gone = res.filter((r) => /^gone/.test(r.outcome || ''));
  return { ok, total: res.length, bad, text: `${ok} of ${res.length} session${res.length === 1 ? '' : 's'} resumed${bad.length ? ` (not: ${bad.map((r) => `${short(r.id)}${r.title ? ` ${r.title}` : ''}: ${r.outcome}`).join('; ')})` : ''}${gone.length ? ` (archived, not resumed: ${gone.map((r) => short(r.id)).join(', ')})` : ''}` };
};

// What the person is told, once, after the recovery. `prior` are the earlier freezes in the last hour, oldest first.
export function recoveryMessage({ kind, at, res, evidence, failures, prior = [], pattern = null, why = null }) {
  const s = sessionsText(res || []);
  if (kind === 'crash') return `The Copilot app crashed at ${hhmm(at)}${why ? ` (${why})` : ''}; I relaunched it and ${s.text}. Evidence: ${evidence}`;
  const head = `The Copilot app froze at ${hhmm(at)}${failures?.length ? `: ${failureText(failures)}` : ''}; I restarted it and ${s.text}.`;
  if (!prior.length) return `${head} Evidence: ${evidence}`;
  const times = [...prior.map((p) => hhmm(Date.parse(p.at))), hhmm(at)].join(', ');
  return `${head} This is freeze ${prior.length + 1} in an hour (${times}), so it is a pattern, not a one-off.${pattern ? ` ${pattern}` : ''} Evidence: ${evidence}${prior.length ? `; earlier: ${prior.map((p) => p.evidence).filter(Boolean).join(', ')}` : ''}`;
}

// What the person is told after a gap in the heartbeat's own runs. `facts` is what the Mac's logs say about the gap.
export function classifyGap({ from, to, facts }) {
  const f = facts || {};
  const mins = Math.round((to - from) / 60000);
  const win = `${hhmm(from)} to ${hhmm(to)}`;
  if (f.boot && f.boot >= from - 60000 && f.boot <= to) {
    const upd = (f.installs || []).filter((i) => i.at <= f.boot && f.boot - i.at <= 30 * 60000).at(-1);
    const planned = f.planned && f.boot - Date.parse(f.planned.at || 0) <= 4 * 3600000 ? f.planned : null;
    const panic = (f.panics || []).at(-1);
    const why = planned ? `restarted at ${hhmm(f.boot)} for the macOS update (${planned.label || 'an update'}), with every session at a safe point first`
      : upd ? `restarted at ${hhmm(f.boot)} for ${upd.name} (installed ${hhmm(upd.at)}); housesitter did not schedule it, a person or the device's management did`
        : panic ? `restarted at ${hhmm(f.boot)} after a kernel panic (${panic})`
          : `restarted at ${hhmm(f.boot)} and the logs name no reason (no update recorded, no panic report)`;
    return { cause: planned ? 'planned-update' : upd ? 'update' : panic ? 'panic' : 'reboot-unknown', mins, text: `The Mac stopped running my jobs for ${mins} min (${win}): it ${why}${f.onDemand ? '; from ' + hhmm(f.onDemand) + ' the system had stopped starting jobs while it prepared the restart' : ''}.` };
  }
  // The job itself was switched off (launchctl disable/bootout) for the gap: nothing hung, and nobody needs telling.
  if (f.paused) return { cause: 'paused', mins, text: `The heartbeat job was switched off for ${mins} min (${win}); that is not a hang.` };
  if ((f.sleeps || []).length) return { cause: 'sleep', mins, text: `The Mac slept for ${mins} min (${win}): ${f.sleeps.slice(0, 2).join('; ')}. I have set it to stay awake${f.pmsetSleep ? ` (the system setting is still "sleep ${f.pmsetSleep}"; changing that needs an administrator's password)` : ''}.` };
  if (f.onDemand) return { cause: 'restart-pending', mins, text: `The Mac stopped starting my jobs for ${mins} min (${win}): from ${hhmm(f.onDemand)} the system was preparing a restart or shutdown, and it did not restart in that time.` };
  // launchd kept running the job but each run exited with an error before it recorded a run (a refused argument): not a hang.
  if (f.ownErrors) {
    const e = f.ownErrors;
    return { cause: 'job-errors', mins, text: `Not a Mac hang: launchd kept running my job, but my own runs exited with an error for ${mins} min (${win}). Evidence: ${e.log ? `${e.log} has ${e.count} refusal line${e.count === 1 ? '' : 's'} in that window, e.g. "${e.sample}"` : ''}${e.log && e.exit != null ? '; ' : ''}${e.exit != null ? `launchd's last exit status for the job is ${e.exit}` : ''}.` };
  }
  return { cause: 'hang', mins, text: `The Mac stopped running my jobs for ${mins} min (${win}) with no reboot and no sleep in its logs: a hang or heavy stall.${f.load ? ` Load then: ${f.load}.` : ''}${f.memory ? ` Memory: ${f.memory}.` : ''}` };
}

// ---------- the Mac ----------

export function realHeartbeatDeps({ home = os.homedir(), copilotHome, hackamore, state = stateDir(home), bin, node = process.execPath } = {}) {
  const base = realDeps({ home, copilotHome, hackamore, state });
  const file = path.join(state, 'heartbeat.json');
  const diag = path.join(home, 'Library', 'Logs', 'DiagnosticReports');
  const tell = realTell({ state, home });
  const d = {
    ...base,
    state, bin, node, userHome: home,
    readState: () => readJson(file, {}),
    writeState: (o) => writeJson(file, o),
    runInProgress: () => Boolean(runInProgress(state)),
    // How many sessions the app says are running: one cheap query, so a gone app can be told from one a person quit.
    busyCount: async () => Number((await d.sql('SELECT COUNT(*) AS n FROM sessions WHERE is_running = 1 AND archived_at IS NULL'))[0]?.n || 0),
    status: (o) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify(o)); },
    lastWrite: (o) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'last.json'), JSON.stringify(o, null, 2)); },
    tell,
    // The socket: ok when it says hello, down when nothing is serving, timeout when it takes the connection and says nothing.
    // Every session the app lists, with whether it says it is running and when its history last changed (a stat, never a read).
    sessionProgress: async () => {
      const rows = await d.sql('SELECT id, is_running AS running FROM sessions WHERE archived_at IS NULL');
      return rows.map((r) => { let m = 0; try { m = fs.statSync(path.join(d.copilotHome, 'session-state', r.id, 'events.jsonl')).mtimeMs; } catch { /* none */ } return { id: r.id, running: Number(r.running) === 1, lastEventAt: m }; });
    },
    memorySnapshot: async (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      for (const [n, f, a] of [['ps.txt', '/bin/ps', ['-axm', '-o', 'pid,ppid,rss,command']], ['vm_stat.txt', '/usr/bin/vm_stat', []], ['swap.txt', '/usr/sbin/sysctl', ['vm.swapusage']]]) fs.writeFileSync(path.join(dir, n), (await run(f, a)).stdout);
    },
    probeSocket: async (ms) => {
      const t0 = Date.now();
      const got = await d.exchange([], { done: (j) => j.type === 'server_hello', keep: (j) => j.type === 'server_hello' || j.type === 'socket_error', waitMs: ms });
      // Closing a connection that never opened also raises an error event, so only an error before the wait ran out is "down".
      return got.some((j) => j.type === 'server_hello') ? 'ok' : Date.now() - t0 >= ms - 100 ? 'timeout' : 'down';
    },
    // The window: an accessibility read, which the main thread answers. A timeout is the freeze; any other failure
    // (a locked screen, no permission) says nothing about the app and is not counted.
    probeWindow: async (app, ms) => {
      if (!d.hackamore) return { state: 'unknown', why: 'hackamore is not installed' };
      const r = await d.hk(['ls', app], { timeoutMs: ms });
      if (r.timedOut) return { state: 'timeout' };
      return r.code === 0 && r.json?.state ? { state: 'ok' } : { state: 'unknown', why: r.text };
    },
    // The app's other processes the system names with it: its web content, networking and graphics helpers.
    related: async () => {
      const out = (await run('/usr/bin/lsappinfo', ['list'])).stdout;
      return [...out.matchAll(/"GitHub Copilot [^"]*"[^\n]*\n(?:[^\n]*\n){0,6}?\s*pid = (\d+)/g)].map((m) => Number(m[1]));
    },
    capture: async (dir, { pid, others = [] }) => {
      fs.mkdirSync(dir, { recursive: true });
      const files = [];
      const grab = async (name, file, argv, timeoutMs = 20000) => { const r = await run(file, argv, { timeoutMs }); try { fs.writeFileSync(path.join(dir, name), r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')); files.push(name); } catch { /* best effort */ } return r; };
      await Promise.all([
        run('/usr/bin/sample', [String(pid), '5', '-mayDie', '-file', path.join(dir, 'sample-main.txt')], { timeoutMs: 30000 }).then(() => files.push('sample-main.txt')),
        ...others.slice(0, 4).map((p) => run('/usr/bin/sample', [String(p), '3', '-mayDie', '-file', path.join(dir, `sample-${p}.txt`)], { timeoutMs: 30000 }).then(() => files.push(`sample-${p}.txt`))),
        grab('ps.txt', '/bin/ps', ['-axo', 'pid,ppid,stat,pcpu,pmem,etime,command']),
        grab('uptime.txt', '/usr/bin/uptime', []),
        grab('vm_stat.txt', '/usr/bin/vm_stat', []),
        grab('swap.txt', '/usr/sbin/sysctl', ['vm.swapusage', 'kern.boottime']),
        grab('power.txt', '/usr/bin/pmset', ['-g', 'assertions']),
      ]);
      try {
        const lf = path.join(d.home, 'logs', `github-app.${pid}.log`);
        const size = fs.statSync(lf).size;
        const fd = fs.openSync(lf, 'r'); const buf = Buffer.alloc(Math.min(size, 256 * 1024)); fs.readSync(fd, buf, 0, buf.length, size - buf.length); fs.closeSync(fd);
        fs.writeFileSync(path.join(dir, 'app.log'), buf); files.push('app.log');
      } catch { /* no app log */ }
      return files;
    },
    summarizeSample: (dir) => { try { return heaviestPath(fs.readFileSync(path.join(dir, 'sample-main.txt'), 'utf8')); } catch { return []; } },
    // Crash reports for the app that are newer than `since` (ms).
    crashes: (since) => {
      try {
        return fs.readdirSync(diag).filter((n) => /^(github|GitHub)[^/]*\.ips$/.test(n)).map((n) => ({ n, f: path.join(diag, n), t: fs.statSync(path.join(diag, n)).mtimeMs })).filter((x) => x.t >= since)
          .sort((a, b) => a.t - b.t).map((x) => ({ file: x.f, at: x.t, summary: crashSummary(fs.readFileSync(x.f, 'utf8')) }));
      } catch { return []; }
    },
    copyFile: (from, dir) => { try { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(from, path.join(dir, path.basename(from))); } catch { /* best effort */ } },
    gapFacts: (from, to) => gapFacts(from, to, { state, home }),
    keepAwake: () => ensureKeepAwake({ node, bin, home }),
    evidenceRoot: incidentsDir(home),
    resumed: () => readJson(path.join(state, 'resume-only.json'), null),
  };
  return d;
}

const sysctlBoot = async () => { const m = (await run('/usr/sbin/sysctl', ['-n', 'kern.boottime'])).stdout.match(/sec = (\d+)/); return m ? Number(m[1]) * 1000 : null; };

// Parse `softwareupdate --history` (local times, "MM/DD/YYYY, HH:MM:SS").
export function parseHistory(text) {
  return String(text).split('\n').map((l) => l.match(/^(.*?)\s{2,}(\S+)\s{2,}(\d\d)\/(\d\d)\/(\d{4}), (\d\d):(\d\d):(\d\d)\s*$/)).filter(Boolean)
    .map((m) => ({ name: m[1].trim(), version: m[2], at: new Date(Number(m[5]), Number(m[3]) - 1, Number(m[4]), Number(m[6]), Number(m[7]), Number(m[8])).getTime() }));
}

// Did the heartbeat job's own runs fail in the window? Its launchd log (stderr and stdout) is untimed, so a refusal line
// counts when the log was written since the gap began; launchd's last exit status, when it is nonzero, says the same.
export function jobErrors(from, to, { home, log = path.join(home, 'Library', 'Logs', 'housesitter-heartbeat.launchd.log'), launchctlExit = null } = {}) {
  let lines = [];
  try { if (fs.statSync(log).mtimeMs >= from - 60000) lines = fs.readFileSync(log, 'utf8').split('\n').filter((l) => /needs --why|refus|usage:/i.test(l)); } catch { /* no log */ }
  const exit = launchctlExit != null && launchctlExit !== 0 ? launchctlExit : null;
  if (!lines.length && exit == null) return null;
  return { log: lines.length ? log : null, count: lines.length, sample: (lines.at(-1) || '').trim().slice(0, 120), exit };
}

// What the Mac's own logs say about a gap. Each lookup is best effort and bounded; a missing one is simply absent.
async function gapFacts(from, to, { state, home }) {
  const ts = (ms) => new Date(ms).toLocaleString('sv-SE').replace('T', ' ');
  const [boot, hist, sleepLog, onDemand, load, vm, offLog] = await Promise.all([
    sysctlBoot(),
    run('/usr/sbin/softwareupdate', ['--history'], { timeoutMs: 30000 }),
    run('/usr/bin/pmset', ['-g', 'log'], { timeoutMs: 90000 }),
    run('/usr/bin/log', ['show', '--start', ts(from), '--end', ts(to), '--style', 'compact', '--predicate', 'process == "launchd" AND eventMessage CONTAINS "on-demand-only"'], { timeoutMs: 90000 }),
    run('/usr/bin/uptime', []),
    run('/usr/bin/vm_stat', []),
    run('/usr/bin/log', ['show', '--start', ts(from), '--end', ts(to), '--style', 'compact', '--predicate', 'process == "launchd" AND eventMessage CONTAINS "housesitter.heartbeat" AND (eventMessage CONTAINS[c] "disable" OR eventMessage CONTAINS[c] "bootout" OR eventMessage CONTAINS[c] "removing")'], { timeoutMs: 90000 }),
  ]);
  const inWin = (s) => { const m = s.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/); if (!m) return null; const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime(); return t >= from - 60000 && t <= to ? t : null; };
  const sleeps = sleepLog.stdout.split('\n').filter((l) => /^\S+ \S+ [-+]\d{4} (Sleep|Wake|DarkWake)\s/.test(l) && inWin(l)).map((l) => l.replace(/\s+/g, ' ').slice(0, 120));
  const od = onDemand.stdout.split('\n').map((l) => ({ l, t: inWin(l) })).find((x) => x.t && /on-demand-only/.test(x.l));
  const diagDirs = ['/Library/Logs/DiagnosticReports', path.join(home, 'Library', 'Logs', 'DiagnosticReports')];
  const panics = diagDirs.flatMap((d) => { try { return fs.readdirSync(d).filter((n) => /panic|^Kernel/i.test(n)).map((n) => ({ n, t: fs.statSync(path.join(d, n)).mtimeMs })).filter((x) => x.t >= from - 600000); } catch { return []; } }).map((x) => x.n);
  const pm = (await run('/usr/bin/pmset', ['-g'], { timeoutMs: 10000 })).stdout.match(/^\s*sleep\s+(\d+)/m);
  const free = vm.stdout.match(/Pages free:\s+(\d+)/);
  // A pause marker ({from,to} in ms; `to` absent while still paused) written by whoever disables the job also counts.
  const mark = readJson(path.join(state, 'heartbeat-paused.json'), null);
  const paused = Boolean(offLog.stdout.split('\n').some((l) => inWin(l) && /disable|bootout|removing/i.test(l)) || (mark && Number(mark.from) <= to && (mark.to == null || Number(mark.to) >= from)));
  const lc = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/bot.ouro.housesitter.heartbeat`], { timeoutMs: 10000 });
  const ownErrors = jobErrors(from, to, { home, launchctlExit: (lc.stdout.match(/last exit code = (\d+)/) || [])[1] != null ? Number(lc.stdout.match(/last exit code = (\d+)/)[1]) : null });
  return {
    paused, ownErrors, boot, installs: parseHistory(hist.stdout), sleeps, onDemand: od?.t || null, panics, planned: readJson(path.join(state, 'os-update.json'), {}).reboot || null,
    pmsetSleep: pm && Number(pm[1]) > 0 ? pm[1] : null, load: (load.stdout.match(/load averages?: (.*)$/m) || [])[1] || null, memory: free ? `${Math.round(Number(free[1]) * 16384 / 1048576)} MB free` : null,
  };
}

export async function ensureKeepAwake({ node, bin, home = os.homedir() }) {
  const { installAgent, KEEP_AWAKE, agentPath } = await import('./recovery.mjs');
  if (fs.existsSync(agentPath(KEEP_AWAKE.label, home))) return { ok: true, already: true };
  return installAgent({ ...KEEP_AWAKE, env: { PATH: '/usr/bin:/bin', HOME: home }, home });
}

// ---------- the pass ----------

const label = (kind) => (kind === 'crash' ? 'a crash' : 'a frozen window');

// One run. Returns { action, ... }; every decision is one line to `say`.
export async function pass(opts, deps, say = () => {}) {
  const t = { ...T, ...HB, ...Object.fromEntries(Object.entries(opts.t || {})) };
  const app = opts.app || DEFAULT_APP;
  const now = deps.now();
  const out = (m) => say(`${iso(now)} heartbeat${opts.dry_run ? ' (dry run)' : ''}: ${m}`);
  const st = deps.readState() || {};
  // A streak recorded by an older version judged the socket or window; only no-progress is judged now.
  if (st.bad && !(st.bad.failures || []).includes('no-progress')) st.bad = null;
  const res = { action: 'ok', failures: [] };
  const save = (extra = {}) => { if (!opts.dry_run) deps.writeState({ ...st, ...extra, beat_at: iso(deps.now()) }); };
  const gap = st.beat_at ? now - Date.parse(st.beat_at) : 0;
  const stall = gap >= t.stall ? { from: Date.parse(st.beat_at), to: now } : null;

  // The Mac's own gap first: it is recorded whatever else happens in this run.
  if (!opts.dry_run) {
    if (stall) st.stall_pending = await handleStall({ stall, deps, out });
    if (st.stall_pending?.cause === 'paused') st.stall_pending = null;
    if (st.stall_pending) st.stall_pending = await settleStall({ st, deps, now, t, out });
  }

  if (deps.runInProgress?.()) { save(); res.action = 'hold'; res.code = 'restart-running'; out('a restart job is running; not probing'); return res; }

  const g = await appGeneration({ app }, deps);
  if (!g.main) {
    res.action = 'absent';
    const r = await absent({ st, now, t, opts, deps, app, g, out, stall });
    Object.assign(res, r);
    save(r.state || {});
    return res;
  }

  // A different app process than the last run saw: whatever the streak was, it was about the old one.
  const sameApp = st.app?.key === g.key;
  const failures = [];
  // Only the sessions' own progress counts; the socket and window are looked at for the record, never judged.
  const prog = judgeProgress(await deps.sessionProgress(), now, t.progress);
  if (prog.stalled) failures.push('no-progress');
  res.progress = prog; res.failures = failures;

  const j = judge(sameApp ? st.bad : null, failures, now, t);
  const busy = sameApp ? st.app?.busy : undefined;
  const appState = { key: g.key, pid: g.main.pid, started: g.startedAt, seen_at: iso(now), busy: await deps.busyCount().catch(() => busy ?? 0) };
  if (!failures.length) {
    if (st.bad) out(`the app answers again (it did not for ${Math.round((now - Date.parse(st.bad.since)) / 1000)} s: ${st.bad.failures.join(', ')})`);
    save({ bad: null, app: appState });
    return res;
  }
  out(`probe failed (${failures.join(', ')}); failing since ${j.bad.since}, ${plural(j.bad.count, 'run')}`);
  if (!j.frozen) { save({ bad: j.bad, app: appState }); res.action = 'watching'; return res; }

  // Frozen. Look again: any session writing anything now means it is not.
  const again2 = judgeProgress(await deps.sessionProgress(), deps.now(), t.progress);
  if (!again2.stalled) { out('a session wrote an event meanwhile: not a freeze'); save({ bad: null, app: appState }); res.action = 'slow'; return res; }
  const again = ['no-progress'];
  res.action = 'freeze';
  if (opts.dry_run) { out(`would recover: ${failureText(again)}`); return res; }
  const storm = recentIncidents(deps.state, ['freeze'], t.stormMs, now);
  if (storm.length >= t.stormCap && (!st.storm_snapped || now - Date.parse(st.storm_snapped) > t.hour)) {
    const dir = path.join(deps.evidenceRoot, `${iso(now).replace(/[:.]/g, '-')}-storm`);
    await deps.memorySnapshot?.(dir).catch(() => {});
    st.storm_snapped = iso(now);
  }
  const recent = recentIncidents(deps.state, ['freeze', 'crash'], t.hour, now);
  if (storm.length >= t.stormCap) {
    res.action = 'capped';
    if (!st.capped_told || now - Date.parse(st.capped_told) > t.hour) {
      await deps.tell(`The Copilot app froze ${storm.length} times in 15 minutes (${storm.map((r) => hhmm(Date.parse(r.at))).join(', ')}) and I restarted it each time; more restarts would reload every session's history and make memory worse, so I am backing off and took a memory snapshot.`);
      st.capped_told = iso(now);
    }
    out(`frozen again but ${storm.length} freeze restarts in 15 minutes: backing off`);
    save({ bad: j.bad, app: appState, capped_told: st.capped_told, storm_snapped: st.storm_snapped });
    return res;
  }
  if (recent.length >= t.cap) {
    res.action = 'capped';
    if (!st.capped_told || now - Date.parse(st.capped_told) > t.hour) {
      await deps.tell(`The Copilot app has frozen or crashed ${recent.length} times in the last hour and I recovered it each time (${recent.map((r) => hhmm(Date.parse(r.at))).join(', ')}); I am holding off a fourth restart because it is not holding, and it is frozen again now (${failureText(again)}). Evidence so far: ${recent.map((r) => r.evidence).join(', ')}`);
      st.capped_told = iso(now);
    }
    out(`frozen again but ${recent.length} recoveries in the last hour: holding`);
    save({ bad: j.bad, app: appState, capped_told: st.capped_told });
    return res;
  }
  const r = await recover({ kind: 'freeze', failures: again, since: Date.parse(j.bad.since), g, app, opts, deps, t, out });
  Object.assign(res, r);
  save({ bad: null, app: null, capped_told: st.capped_told });
  return res;
}

// The app is not running.
async function absent({ st, now, t, opts, deps, app, g, out }) {
  const was = st.app;
  if (!was) return { state: { app: null }, note: 'not running, and not seen running by this watch' };
  // Gone since it was last seen. A crash report that postdates the last sighting names a crash.
  const reports = deps.crashes(Date.parse(was.seen_at) - 60000).filter((c) => c.at >= (Number(was.started) || Date.parse(was.seen_at)) - 60000);
  const crash = reports.at(-1);
  const away = now - Date.parse(was.seen_at);
  if (!crash && !(was.busy > 0 && away >= t.absent)) {
    out(`the app is not running (last seen ${Math.round(away / 1000)} s ago) and no crash report names it: left closed`);
    return { state: { app: was }, action: 'absent' };
  }
  if (opts.dry_run) { out('would relaunch the app'); return { state: { app: was }, action: 'crash' }; }
  const recent = recentIncidents(deps.state, ['freeze', 'crash'], t.hour, now);
  if (recent.length >= t.cap) { out(`crashed again but ${recent.length} recoveries in the last hour: holding`); return { state: { app: was }, action: 'capped' }; }
  const r = await recover({ kind: 'crash', crash, since: Date.parse(was.seen_at), g, app, opts, deps, t, out, gone: true });
  return { ...r, action: 'crash', state: { app: null, bad: null } };
}

async function handleStall({ stall, deps, out }) {
  const facts = await deps.gapFacts(stall.from, stall.to).catch(() => ({}));
  const c = classifyGap({ ...stall, facts });
  const rec = { kind: 'stall', at: iso(stall.to), from: iso(stall.from), to: iso(stall.to), cause: c.cause, mins: c.mins, text: c.text };
  recordIncident(deps.state, rec);
  out(`a gap of ${c.mins} min between runs: ${c.cause}: ${c.text}`);
  if (c.cause === 'sleep') await deps.keepAwake?.().catch(() => {});
  return rec;
}

// After a stall, tell once, when the resume that followed has finished (or a while has passed), so the message can say how
// it went. Returns what is still pending: null once told.
export async function settleStall({ st, deps, now = deps.now(), t = HB, out = () => {} }) {
  const p = st.stall_pending;
  if (!p) return null;
  const rec = deps.resumed?.();
  const done = rec && Date.parse(rec.at) >= Date.parse(p.to) - 60000;
  if (!done && now - Date.parse(p.to) < t.settleAfterBoot) return p;
  const s = done ? sessionsText(rec.resumed || []) : null;
  const after = s ? ` Everything came back by launchd, and ${s.text}.` : ' The sessions had not finished resuming when I looked; Shepherd\'s health watch is following them.';
  await deps.tell(`${p.text}${after}`);
  out(`told once about the ${p.mins} min gap (${p.cause})`);
  return null;
}

// Quit the frozen app, relaunch it, resume the sessions that were working, tell the person once.
export async function recover({ kind, failures = [], crash = null, since, g, app, opts, deps, t, out, gone = false }) {
  const started = deps.now();
  const stamp = iso(started).replace(/[:]/g, '-');
  const evidence = path.join(deps.evidenceRoot, `${stamp}-${kind}`);
  const report = { ok: false, app, kind, started_at: iso(started), steps: [] };
  const step = (name, extra = {}) => { report.steps.push({ step: name, at: iso(deps.now()), ...extra }); out(`${name}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`); deps.status?.({ started: report.started_at, updated: iso(deps.now()), state: 'running', step: name }); };
  const fail = async (stage, why) => {
    report.failed = { stage, why }; step(`FAILED at ${stage}`, { why });
    deps.status?.({ started: report.started_at, updated: iso(deps.now()), state: 'failed', step: `failed at ${stage}`, failed: report.failed });
    deps.lastWrite?.(report);
    recordIncident(deps.state, { kind, at: iso(started), evidence, ok: false, failed: report.failed });
    await deps.tell(`The Copilot app ${kind === 'crash' ? 'crashed' : 'froze'} at ${hhmm(started)} and I could not recover it by myself: ${why}. It needs a look. Evidence: ${evidence}`);
    return { ...report, evidence };
  };
  const dir = g.dir;
  const main = g.main;
  step(kind === 'crash' ? 'the app crashed: recovering' : `the app froze (${failureText(failures)}): recovering`, { pid: main?.pid || null, evidence });

  // Evidence first, while the frozen app is still there to look at.
  let before = [];
  try { before = opts.stand_in ? [] : await snapshot(deps, undefined, skipOf(opts, deps)); } catch (e) { out(`could not read the sessions: ${e.message}`); }
  report.before = before.map(({ id, title, mode, state, why, interrupted }) => ({ id, title, mode, state, why, interrupted }));
  if (gone) {
    fs.mkdirSync(evidence, { recursive: true });
    if (crash) { deps.copyFile?.(crash.file, evidence); report.crash = crash.summary; }
  } else {
    const others = await deps.related().catch(() => []);
    const files = await deps.capture(evidence, { pid: main.pid, others });
    step('evidence captured', { files: files.length, samples: files.filter((f) => /^sample/.test(f)).length });
    report.main_thread = deps.summarizeSample?.(evidence) || [];
  }

  // The working sessions are owed a resume even if this job dies from here on (a reboot): the keeper finishes it.
  deps.owed?.set(before.filter((s) => s.state === 'busy').map((s) => s.id), `recovery of ${label(kind)} at ${iso(started)}`);

  if (!gone) {
    // Quit: SIGTERM (the app's own handler, if its thread can run it), then SIGKILL to exactly these pids.
    const procs = await deps.ps();
    const pids = family(procs, main.pid, dir);
    const alive = async () => { const set = new Set(pids); return (await deps.ps()).filter((x) => set.has(x.pid) || x.command.includes(`${dir}/Contents/`)).map((x) => x.pid); };
    deps.kill(main.pid, 'SIGTERM');
    let left = await alive();
    for (const end = deps.now() + t.term; left.length && deps.now() < end;) { await deps.sleep(1000); left = await alive(); }
    if (left.length) {
      step('the app did not quit on SIGTERM; SIGKILL to exactly these pids', { pids: left });
      for (const pid of left) deps.kill(pid, 'SIGKILL');
      for (const end = deps.now() + t.kill; left.length && deps.now() < end;) { await deps.sleep(500); left = await alive(); }
    }
    if (left.length) return fail('quit', `${left.length} process(es) would not die after SIGKILL: ${left.join(', ')}`);
    step('app exited', { processes: pids.length });
  }

  const opened = await deps.open(app, { background: true });
  if (opened.code !== 0) return fail('relaunch', `open -a "${app}" failed: ${opened.stderr.trim().slice(0, 200)}`);
  let main2 = null;
  for (const end = deps.now() + t.up; !main2 && deps.now() < end;) { main2 = findMain(await deps.ps(), dir, await deps.appExe?.(dir)); if (!main2) await deps.sleep(1000); }
  if (!main2) return fail('relaunch', `${app} did not start within ${Math.round(t.up / 1000)} s`);
  const startedAt = (await deps.startedAt(main2.pid)) || deps.now();
  deps.generation?.set(`${main2.pid}:${startedAt}`, 'recovery');
  report.restarted_at = iso(deps.now());
  step('relaunched', { pid: main2.pid, from: main?.pid || null });
  let ready = false;
  for (const end = deps.now() + t.up; !ready && deps.now() < end;) { ready = await appReady(deps); if (!ready) await deps.sleep(2000); }
  if (!ready) return fail('relaunch', `${app} is running but its socket did not answer within ${Math.round(t.up / 1000)} s; the sessions that were working were not resumed`);
  step('socket answering');

  const res = await resumeAfter({ before, opts: { ...opts, why: label(kind), also: [...(opts.also || []), ...(deps.owed?.get() || [])] }, startedAt, restartedAt: deps.now(), t: { ...T, ...(opts.t || {}) }, lanes: new Map() }, deps, (m) => out(m));
  report.resume = res;
  report.ok = res.every((r) => isDone(r.outcome));
  step(report.ok ? 'every session resumed' : 'some sessions did not resume', { not: res.filter((r) => !isDone(r.outcome)).map((r) => `${short(r.id)}: ${r.outcome}`) });
  deps.owed?.clear();
  deps.status?.({ started: report.started_at, updated: iso(deps.now()), state: report.ok ? 'done' : 'failed', step: 'finished', ...(report.ok ? {} : { not_resumed: res.filter((r) => !isDone(r.outcome)).map((r) => r.id) }) });
  deps.lastWrite?.(report);

  const prior = recentIncidents(deps.state, ['freeze'], t.hour, started).filter((r) => r.ok);
  const pattern = prior.length && kind === 'freeze' ? patternText([...prior.map((p) => p.main_thread), report.main_thread], [...prior.map((p) => p.failures), failures]) : null;
  recordIncident(deps.state, { kind, at: iso(started), evidence, ok: true, failures, main_thread: report.main_thread || null, crash: report.crash || null, resumed: res.length, not_resumed: res.filter((r) => !isDone(r.outcome)).map((r) => r.id) });
  const crashWhy = crash?.summary ? `${crash.summary.signal || ''} in ${crash.summary.frames.slice(0, 2).join(' ← ')}`.trim() : null;
  await deps.tell(recoveryMessage({ kind, at: started, res, evidence, failures, prior, pattern, why: crashWhy }));
  return { ...report, evidence };
}

function patternText(mainThreads, failureSets) {
  const same = (a) => a.every((x) => JSON.stringify(x) === JSON.stringify(a[0]));
  const bits = [];
  if (failureSets.every((f) => (f || []).join() === (failureSets[0] || []).join())) bits.push(`every time it was the same: ${failureText(failureSets[0] || [])}`);
  const tops = mainThreads.map((m) => (m || []).at(-1)).filter(Boolean);
  if (tops.length === mainThreads.length && same(tops)) bits.push(`the main thread's sample ended in ${tops[0]} each time`);
  else if (tops.length) bits.push(`main-thread samples: ${tops.join(' / ')}`);
  return bits.length ? `Pattern: ${bits.join('; ')}.` : null;
}

export function renderPass(r) {
  const L = [`${String(r.action).toUpperCase()}${r.code ? ` (${r.code})` : ''}: socket ${r.socket || '?'}, window ${r.window || '?'}${r.failures?.length ? `, failing: ${r.failures.join(', ')}` : ''}`];
  if (r.evidence) L.push(`evidence: ${r.evidence}`);
  return L.join('\n');
}
