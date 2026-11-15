// `housesitter restart-copilot --plugin-updates`: restart the GitHub Copilot app when a plugin it has loaded is older
// than the newest release Agency has fetched.
//
// The app keeps a skill's text in memory for the life of its process, so a plugin's skills (Desk, MS Desk, cit, Crew)
// stay as they were at the app's start until the app restarts. Agency's cache (~/.local/agency/plugins/cache) holds the
// newer release; the running roots (~/.local/agency/plugins/sessions/agency-plugin-<id>.p<pid>/root-N/<plugin>) show
// what each session process loaded. When the cache is newer, this runs the proven `restart-copilot --resume --detach`,
// which does the coordination: it asks every working session to reach a safe point and say so, waits, restarts, and
// resumes each one with the reason.
//
// It never waits for sessions to be idle (there is always one working), but it holds:
//   - while a person is using the Mac (hackamore's gate: someone used it in the last 90 s, a call, a locked screen),
//   - for 6 hours after a restart it started,
//   - while a restart is already running,
//   - for a release it already restarted for (the app still loaded the old one: restarting again would not help).
// Every pass writes one line to plugin-updates.log, with the reason.
//
// A launchd agent runs one pass every five minutes (--install-plugin-updates). Everything that touches the Mac goes
// through `deps`, so tests run it against a fake sessions folder and a fake cache.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appGeneration, family, plan, readState, realDeps, runInProgress, stateDir } from './copilot-app.mjs';

export const PLUGIN_LABEL = 'bot.ouro.housesitter.plugin-update-restart';
export const COOLDOWN_MS = 6 * 3600000;
export const EVERY_SEC = 300;
export const PERSON_WAIT_SEC = 300;
const LOG_MAX = 1 << 20;

export const agencyHome = (home = os.homedir()) => path.join(home, '.local', 'agency', 'plugins');

// ---------- pure ----------

// 3.2.154 against 3.2.167: numeric parts, a missing part is 0, a pre-release tag sorts before its release.
export function cmpVersion(a, b) {
  const parts = (v) => String(v).trim().replace(/^v/, '').split('+')[0].split('-');
  const nums = (s) => s.split('.').map((x) => parseInt(x, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  const [na, nb] = [nums(pa[0]), nums(pb[0])];
  for (let i = 0; i < Math.max(na.length, nb.length); i++) if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) < (nb[i] || 0) ? -1 : 1;
  if (pa.length > 1 && pb.length === 1) return -1;
  if (pa.length === 1 && pb.length > 1) return 1;
  return 0;
}

// The plugin's name and version from its manifest (plugin.json, or .claude-plugin/plugin.json), or null.
export function readManifest(dir) {
  for (const f of [path.join(dir, 'plugin.json'), path.join(dir, '.claude-plugin', 'plugin.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && typeof j.name === 'string' && typeof j.version === 'string') return { name: j.name, version: j.version };
    } catch { /* not here */ }
  }
  return null;
}

// Every plugin loaded by a live session process of the app: [{ name, version, pid, root }]. `owned(pid)` says whether the
// process belongs to the app (a Copilot CLI in a terminal has its own roots, and restarting the app does not refresh them).
export function loadedPlugins(sessionsDir, owned) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(sessionsDir); } catch { return out; }
  for (const d of dirs) {
    const m = d.match(/^agency-plugin-.+\.p(\d+)$/);
    if (!m || !owned(Number(m[1]))) continue;
    let roots = [];
    try { roots = fs.readdirSync(path.join(sessionsDir, d)).filter((r) => /^root-\d+$/.test(r)); } catch { continue; }
    for (const r of roots) {
      let plugins = [];
      try { plugins = fs.readdirSync(path.join(sessionsDir, d, r)); } catch { continue; }
      for (const p of plugins) {
        const root = path.join(sessionsDir, d, r, p);
        const man = readManifest(root);
        if (man) out.push({ ...man, pid: Number(m[1]), root });
      }
    }
  }
  return out;
}

// The newest release Agency has fetched for each plugin: its Copilot entries that follow a branch or tag (not a pinned
// commit), the most recently fetched one per plugin name. Map name -> { version, sha, spec, fetched_at }.
export function newestReleases(cacheDir) {
  const out = new Map();
  let index;
  try { index = JSON.parse(fs.readFileSync(path.join(cacheDir, 'cache_index.json'), 'utf8')); } catch { return out; }
  for (const e of Object.values(index.entries || {})) {
    if (!/^copilot:/.test(e.spec || '') || /@[0-9a-f]{40}$/.test(e.spec) || !e.dir_name) continue;
    const man = readManifest(path.join(cacheDir, 'entries', e.dir_name));
    if (!man) continue;
    const had = out.get(man.name);
    if (!had || e.fetched_at > had.fetched_at) out.set(man.name, { version: man.version, sha: e.resolved_sha || null, spec: e.spec, fetched_at: e.fetched_at });
  }
  return out;
}

// What is stale: for each plugin the newest release has a higher version than some loaded copy (every loaded plugin, or only those in `watched`).
// [{ name, from (the oldest loaded), to, sha, sessions (processes on an older one), loaded: [versions] }].
export function findUpdates(loaded, newest, watched = null) {
  const out = [];
  for (const name of [...new Set(loaded.map((l) => l.name))].sort()) {
    if (watched && !watched.includes(name)) continue;
    const rel = newest.get(name);
    const mine = loaded.filter((l) => l.name === name);
    if (!rel || !mine.length) continue;
    const older = mine.filter((l) => cmpVersion(l.version, rel.version) < 0);
    if (!older.length) continue;
    const from = older.map((l) => l.version).sort(cmpVersion)[0];
    out.push({ name, from, to: rel.version, sha: rel.sha, sessions: new Set(older.map((l) => l.pid)).size, loaded: [...new Set(mine.map((l) => l.version))].sort(cmpVersion) });
  }
  return out;
}

export const reasonFor = (updates) => `a plugin update (${updates.map((u) => `${u.name} ${u.from} → ${u.to}`).join(', ')})`;

// The whole decision from what is true now: { action: 'restart' | 'hold', code, why }.
export function decide({ appRunning, updates, state = {}, now, runInProgress: busy = false, person, cooldownMs = COOLDOWN_MS }) {
  if (!appRunning) return { action: 'hold', code: 'app-not-running', why: 'the Copilot app is not running' };
  if (!updates.length) return { action: 'hold', code: 'current', why: 'every loaded plugin is at the newest release Agency has fetched' };
  const fresh = updates.filter((u) => state.attempted?.[u.name] !== u.to);
  const label = reasonFor(updates);
  if (!fresh.length) return { action: 'hold', code: 'already-restarted', why: `${label}: the app was already restarted for these releases and still loads the older ones, so another restart would not help` };
  if (busy) return { action: 'hold', code: 'restart-running', why: `${label}: a restart is already running` };
  const since = state.restarted_at ? now - Date.parse(state.restarted_at) : Infinity;
  if (since < cooldownMs) return { action: 'hold', code: 'cooldown', why: `${label}: the last restart was ${Math.round(since / 60000)} min ago; at most one in ${Math.round(cooldownMs / 3600000)} h` };
  if (!person?.open) return { action: 'hold', code: 'person-active', why: `${label}: ${person?.why || 'cannot tell whether someone is using the Mac'}` };
  return { action: 'restart', code: 'update', why: label };
}

// ---------- the Mac ----------

const run = (file, argv, { timeoutMs = 60000 } = {}) => new Promise((res) => {
  execFile(file, argv, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

const jsonIn = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

export function realPluginDeps({ home = os.homedir(), copilotHome, hackamore, state = stateDir(home), bin, node = process.execPath } = {}) {
  const base = realDeps({ copilotHome, hackamore, state });
  const file = path.join(state, 'plugin-updates.json');
  const logFile = path.join(state, 'plugin-updates.log');
  return {
    ...base,
    sessionsDir: path.join(agencyHome(home), 'sessions'),
    cacheDir: path.join(agencyHome(home), 'cache'),
    // May an agent (and so a restart) touch this Mac now? hackamore's gate: unlocked, nobody used it for 90 s, no call.
    person: async () => {
      if (!base.hackamore) return { open: false, why: 'hackamore is not installed, so it cannot tell whether someone is using the Mac' };
      const r = await base.hk(['gate', 'check', '--json']);
      if (!r.json || typeof r.json.ok !== 'boolean') return { open: false, why: `hackamore gate check gave no answer (${r.text || `exit ${r.code}`})` };
      return { open: r.json.ok, why: String(r.json.msg || (r.json.ok ? 'open' : 'closed')).replace(/^(OPEN|CLOSED): /, '') };
    },
    readState: () => jsonIn(file, {}),
    writeState: (o) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(file, JSON.stringify(o, null, 2)); },
    runInProgress: () => Boolean(runInProgress(state)),
    plan: (opts) => plan({ ...opts, resume: true }, base),
    lastRun: () => readState(state),
    // The proven command, run as a launchd job that outlives the app.
    startRestart: async (reason) => {
      const r = await run(node, [bin, 'restart-copilot', '--resume', '--detach', '--why', reason, '--person-wait', String(PERSON_WAIT_SEC)]);
      return { ok: r.code === 0, text: (r.stdout || r.stderr).trim().slice(0, 300) };
    },
    log: (line) => {
      fs.mkdirSync(state, { recursive: true });
      try { if (fs.statSync(logFile).size > LOG_MAX) fs.renameSync(logFile, `${logFile}.1`); } catch { /* no log yet */ }
      fs.appendFileSync(logFile, `${line}\n`);
    },
    logFile,
  };
}

// A restart this job started is judged by how it ended: done means the app now loads those releases (so do not restart for
// them again); failed (the person came back, the app would not quit) means it may try again once the cooldown is over.
export function reconcile(state, deps, now, out, write = true) {
  if (!state.pending || deps.runInProgress?.()) return state;
  const last = deps.lastRun?.() || {};
  const since = Date.parse(state.restarted_at || 0);
  const mine = last.started && Date.parse(last.started) >= since - 60000;
  if (!mine && now - since < 15 * 60000) return state;
  const next = { ...state, pending: undefined };
  if (mine && last.state === 'done') next.attempted = { ...(state.attempted || {}), ...state.pending };
  else out(`the restart started at ${state.restarted_at} did not finish (${mine ? `${last.state}: ${last.step || ''}` : 'no run found'}); it may be tried again after the cooldown`);
  if (write) deps.writeState?.(next);
  return next;
}

// One pass. Reads the sessions folder and the cache, decides, and (unless opts.dry_run) starts the restart.
// Returns { decision, updates, restarted, ... }; writes one line to the log.
export async function pass(opts, deps, say = () => {}) {
  const now = deps.now();
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const out = (line) => { const l = `${stamp} plugin-updates${opts.dry_run ? ' (dry run)' : ''}: ${line}`; say(l); if (!opts.dry_run) { try { deps.log?.(l); } catch { /* the log is a courtesy */ } } };
  const g = await appGeneration(opts, deps).catch(() => ({ main: null }));
  const procs = g.main ? await deps.ps() : [];
  const mine = new Set(g.main ? family(procs, g.main.pid, g.dir) : []);
  const loaded = g.main ? loadedPlugins(deps.sessionsDir, (pid) => mine.has(pid)) : [];
  const updates = findUpdates(loaded, newestReleases(deps.cacheDir), opts.watched);
  const state = reconcile(deps.readState?.() || {}, deps, now, out, !opts.dry_run);
  // The gate is only read when it could matter.
  const person = g.main && updates.length ? await deps.person() : null;
  const d = decide({ appRunning: Boolean(g.main), updates, state, now, runInProgress: g.main ? deps.runInProgress() : false, person, cooldownMs: opts.cooldown_ms ?? COOLDOWN_MS });
  const res = { decision: d, updates, loaded_processes: new Set(loaded.map((l) => l.pid)).size, restarted: false };
  if (d.action === 'hold') { out(`hold (${d.code}): ${d.why}`); return res; }
  const reason = reasonFor(updates);
  if (opts.dry_run) {
    res.would_run = `housesitter restart-copilot --resume --detach --why "${reason}" --person-wait ${PERSON_WAIT_SEC}`;
    const p = await deps.plan?.(opts).catch(() => null);
    if (p) res.sessions = p.sessions;
    out(`would restart: ${reason}${p ? `; it would ask ${p.sessions.busy} working session(s) to reach a safe point and resume them, and leave ${p.sessions.idle} idle one(s) alone` : ''}`);
    return res;
  }
  // Recorded before the job starts: a failure to start must not become a restart loop.
  deps.writeState?.({ ...state, restarted_at: new Date(now).toISOString(), reason, pending: Object.fromEntries(updates.map((u) => [u.name, u.to])) });
  const r = await deps.startRestart(reason);
  res.restarted = r.ok;
  out(r.ok ? `restart started: ${reason}` : `restart did not start: ${reason}: ${r.text}`);
  return res;
}

// ---------- the launchd agent ----------

export function pluginPlist({ node, bin, env = {}, log, every = EVERY_SEC }) {
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const envs = Object.entries(env).map(([k, v]) => `    <key>${x(k)}</key><string>${x(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLUGIN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[node, bin, 'restart-copilot', '--plugin-updates', '--quiet'].map((a) => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${every}</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>EnvironmentVariables</key>
  <dict>
${envs}
  </dict>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict>
</plist>
`;
}

export const pluginPlistPath = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${PLUGIN_LABEL}.plist`);

// Write (and, unless dry, load) the agent that runs one pass every five minutes. Desk looks for this file to say an
// update "will be picked up automatically".
export async function installPluginAgent({ node, bin, env, home = os.homedir(), dry = false, launchctl = (a) => run('/bin/launchctl', a), uid = process.getuid() }) {
  const file = pluginPlistPath(home);
  const log = path.join(home, 'Library', 'Logs', 'housesitter-plugin-updates.launchd.log');
  const text = pluginPlist({ node, bin, env, log });
  if (dry) return { ok: true, dry_run: true, plist: file, log, text };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(file, text);
  await launchctl(['bootout', `gui/${uid}/${PLUGIN_LABEL}`]);
  const r = await launchctl(['bootstrap', `gui/${uid}`, file]);
  return { ok: r.code === 0, plist: file, log, error: r.stderr.trim() };
}

export async function uninstallPluginAgent({ home = os.homedir(), launchctl = (a) => run('/bin/launchctl', a), uid = process.getuid() }) {
  const file = pluginPlistPath(home);
  await launchctl(['bootout', `gui/${uid}/${PLUGIN_LABEL}`]);
  fs.rmSync(file, { force: true });
  return { ok: true, plist: file };
}

export function renderPass(r) {
  const L = [`${r.decision.action.toUpperCase()} (${r.decision.code}): ${r.decision.why}`];
  L.push(`loaded by ${r.loaded_processes} session process(es) of the app`);
  for (const u of r.updates) L.push(`  ${u.name}: ${u.from} → ${u.to}${u.sha ? ` (${u.sha.slice(0, 8)})` : ''}; ${u.sessions} process(es) behind; loaded: ${u.loaded.join(', ')}`);
  if (!r.updates.length) L.push('  no watched plugin is behind');
  if (r.would_run) L.push(`would run: ${r.would_run}`);
  return L.join('\n');
}
