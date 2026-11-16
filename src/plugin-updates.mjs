// `housesitter restart-copilot --plugin-updates`: restart the GitHub Copilot app when a plugin it has loaded is older
// than the newest release in the app's plugin cache.
//
// The app keeps a skill's text in memory for the life of its process, so a plugin's skills
// stay as they were at the app's start until the app restarts. The app's plugin cache (~/.local/agency/plugins/cache) holds the
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
import { pathToFileURL } from 'node:url';
import { appGeneration, family, plan, readState, realDeps, runInProgress, stateDir } from './copilot-app.mjs';

export const PLUGIN_LABEL = 'bot.ouro.housesitter.plugin-update-restart';
export const COOLDOWN_MS = 6 * 3600000;
export const EVERY_SEC = 300;
export const PERSON_WAIT_SEC = 300;
const LOG_MAX = 1 << 20;

export const pluginHome = (home = os.homedir()) => path.join(home, '.local', 'agency', 'plugins');

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

// The newest release in the app's plugin cache for each plugin: its Copilot entries that follow a branch or tag (not a pinned
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
    if (!had || e.fetched_at > had.fetched_at) out.set(man.name, { version: man.version, sha: e.resolved_sha || null, spec: e.spec, fetched_at: e.fetched_at, dir: path.join(cacheDir, 'entries', e.dir_name) });
  }
  return out;
}

// ---------- what a restart would change ----------
//
// A restart only helps with what a process fixes at its start: its skills (text and descriptions), hooks, agents and
// manifests, and the MCP tool list. Desk's own runtime updates in place (a release changes `mcp/src` under a running
// server), so a release that touches only that is no reason to restart; what counts is the MCP session layer, the tool
// names, descriptions and schemas the host registered when the session began. Every other plugin
// counts on any skill, hook or agent change. A manifest is compared without its version, so a bare version bump is nothing.

export const FIXED = ['skills/', 'agents/', 'hooks/', 'plugin.json', '.claude-plugin/plugin.json', '.mcp.json', '.mcp.copilot.json', '.mcp.claude-codex.json', 'agency.json', 'settings.json'];
export const DESK_SESSION_LAYER = ['mcp/src/tool-names.js', 'mcp/src/tool-schemas.js', 'mcp/src/tool-schema-parts.js', 'mcp/web-catalog.json'];

export const fixedPaths = (name) => (name === 'desk' ? [...FIXED, ...DESK_SESSION_LAYER] : FIXED);
const inSpec = (rel, paths) => paths.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));

function walk(root, dir = '', out = new Map()) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory() && !['node_modules', '.git'].includes(e.name)) walk(root, rel, out);
    else if (e.isFile()) out.set(rel, path.join(root, rel));
  }
  return out;
}

function contentOf(file, rel) {
  try {
    const buf = fs.readFileSync(file);
    if (!rel.endsWith('plugin.json')) return buf;
    const { version, ...rest } = JSON.parse(buf.toString('utf8'));
    return Buffer.from(JSON.stringify(rest));
  } catch { return null; }
}

// The fixed-per-process files that differ between a loaded copy and the newer release (added, removed or changed).
export function changedFixed(loadedRoot, newRoot, name) {
  const paths = fixedPaths(name);
  const a = walk(loadedRoot), b = walk(newRoot);
  const out = [];
  for (const rel of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!inSpec(rel, paths)) continue;
    const x = a.has(rel) ? contentOf(a.get(rel), rel) : null, y = b.has(rel) ? contentOf(b.get(rel), rel) : null;
    if (!x || !y || !x.equals(y)) out.push(rel);
  }
  return out;
}

// Desk (3.2.198+) knows better than this list: a live Desk follows skill text and hook scripts from the newest release on its
// own, so only the skill list and descriptions, and the hook registration, are fixed per process. Its
// changesPerProcess(loadedDir, newDir, name, live) answers that, and the newest fetched Desk carries it. `live` is read from a
// loaded Desk copy the way Desk's own boot reads it; the oldest loaded copy is the one a restart would replace.
export function deskLive(loaded) {
  const desks = loaded.filter((l) => l.name === 'desk').sort((a, b) => cmpVersion(a.version, b.version));
  if (!desks.length) return { skills: false, hooks: false };
  const root = desks[0].root;
  const follows = fs.existsSync(path.join(root, 'hooks', 'lib', 'current-release.cjs'));
  return { skills: follows && fs.existsSync(path.join(root, 'hooks', 'copilot-skill-current.cjs')), hooks: follows };
}

// The `changes` for findUpdates: Desk's rule (from the newest fetched Desk release) when it exports one, else changedFixed.
// A rule that throws or answers something other than a boolean falls back to changedFixed for that comparison.
export async function changesFor(newest, loaded) {
  const rel = newest.get('desk');
  if (!rel) return changedFixed;
  let rule;
  try {
    rule = (await import(pathToFileURL(path.join(rel.dir, 'mcp', 'src', 'runtime', 'plugin-update.js')).href)).changesPerProcess;
  } catch { return changedFixed; }
  if (typeof rule !== 'function') return changedFixed;
  const live = deskLive(loaded);
  return (loadedRoot, newRoot, name) => {
    let fixed;
    try { fixed = rule(loadedRoot, newRoot, name, live); } catch { return changedFixed(loadedRoot, newRoot, name); }
    if (typeof fixed !== 'boolean') return changedFixed(loadedRoot, newRoot, name);
    if (!fixed) return [];
    const files = changedFixed(loadedRoot, newRoot, name);
    return files.length ? files : [`${name}: a change Desk counts as fixed at a process's start`];
  };
}

// What is stale: for each plugin the newest release has a higher version than some loaded copy (every loaded plugin, or only
// those in `watched`) AND changes something fixed per process. { updates, runtime_only }: updates are
// [{ name, from (the oldest loaded), to, sha, sessions (processes on an older one), loaded: [versions], changed: [paths] }];
// runtime_only are the releases that are newer but change nothing a restart would pick up.
export function findUpdates(loaded, newest, { watched = null, changes = changedFixed } = {}) {
  const updates = [], runtime_only = [];
  const seen = new Map();
  for (const name of [...new Set(loaded.map((l) => l.name))].sort()) {
    if (watched && !watched.includes(name)) continue;
    const rel = newest.get(name);
    const mine = loaded.filter((l) => l.name === name);
    if (!rel || !mine.length) continue;
    const older = mine.filter((l) => cmpVersion(l.version, rel.version) < 0);
    if (!older.length) continue;
    const from = older.map((l) => l.version).sort(cmpVersion)[0];
    const changed = new Set();
    // One comparison per version a process loaded: the same version is the same files.
    for (const o of older) {
      const key = `${name}|${o.version}|${rel.version}`;
      if (!seen.has(key)) seen.set(key, changes(o.root, rel.dir, name));
      for (const f of seen.get(key)) changed.add(f);
    }
    const u = { name, from, to: rel.version, sha: rel.sha, sessions: new Set(older.map((l) => l.pid)).size, loaded: [...new Set(mine.map((l) => l.version))].sort(cmpVersion), changed: [...changed].sort() };
    (changed.size ? updates : runtime_only).push(u);
  }
  return { updates, runtime_only };
}

const changedText = (updates) => updates.map((u) => `${u.name}: ${u.changed.slice(0, 3).join(', ')}${u.changed.length > 3 ? ` +${u.changed.length - 3} more` : ''}`).join('; ');

export const reasonFor = (updates) => `a plugin update (${updates.map((u) => `${u.name} ${u.from} → ${u.to}`).join(', ')})`;

// The whole decision from what is true now: { action: 'restart' | 'hold', code, why }.
export function decide({ appRunning, updates, runtimeOnly = [], state = {}, now, runInProgress: busy = false, person, cooldownMs = COOLDOWN_MS }) {
  if (!appRunning) return { action: 'hold', code: 'app-not-running', why: 'the Copilot app is not running' };
  if (!updates.length && runtimeOnly.length) return { action: 'hold', code: 'runtime-only', why: `${reasonFor(runtimeOnly)}: the newer release changes nothing a process fixes at its start (no skill, hook, agent or MCP session file), so a restart would add nothing` };
  if (!updates.length) return { action: 'hold', code: 'current', why: 'every loaded plugin is at the newest release in the plugin cache' };
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
    sessionsDir: path.join(pluginHome(home), 'sessions'),
    cacheDir: path.join(pluginHome(home), 'cache'),
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
  const newest = newestReleases(deps.cacheDir);
  const changes = deps.changes ?? await changesFor(newest, loaded);
  const { updates, runtime_only: runtimeOnly } = findUpdates(loaded, newest, { watched: opts.watched, changes });
  const state = reconcile(deps.readState?.() || {}, deps, now, out, !opts.dry_run);
  // The gate is only read when it could matter.
  const person = g.main && updates.length ? await deps.person() : null;
  const d = decide({ appRunning: Boolean(g.main), updates, runtimeOnly, state, now, runInProgress: g.main ? deps.runInProgress() : false, person, cooldownMs: opts.cooldown_ms ?? COOLDOWN_MS });
  // Which version of each plugin the app's processes run now, for callers that need a floor (the laptop's arrival check).
  const running = [...new Map(loaded.map((l) => [`${l.name}@${l.version}`, { name: l.name, version: l.version }])).values()];
  const res = { decision: d, updates, runtime_only: runtimeOnly, loaded: running, loaded_processes: new Set(loaded.map((l) => l.pid)).size, restarted: false };
  if (d.action === 'hold') { out(`hold (${d.code}): ${d.why}`); return res; }
  const reason = reasonFor(updates);
  if (opts.dry_run) {
    res.would_run = `housesitter restart-copilot --resume --detach --why "${reason}" --person-wait ${PERSON_WAIT_SEC}`;
    const p = await deps.plan?.(opts).catch(() => null);
    if (p) res.sessions = p.sessions;
    out(`would restart: ${reason}; changed: ${changedText(updates)}${p ? `; it would ask ${p.sessions.busy} working session(s) to reach a safe point and resume them, and leave ${p.sessions.idle} idle one(s) alone` : ''}`);
    return res;
  }
  // Recorded before the job starts: a failure to start must not become a restart loop.
  deps.writeState?.({ ...state, restarted_at: new Date(now).toISOString(), reason, pending: Object.fromEntries(updates.map((u) => [u.name, u.to])) });
  const r = await deps.startRestart(reason);
  res.restarted = r.ok;
  out(r.ok ? `restart started: ${reason}; changed: ${changedText(updates)}` : `restart did not start: ${reason}: ${r.text}`);
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
  for (const u of r.updates) L.push(`  ${u.name}: ${u.from} → ${u.to}${u.sha ? ` (${u.sha.slice(0, 8)})` : ''}; ${u.sessions} process(es) behind; loaded: ${u.loaded.join(', ')}; fixed per process and changed: ${u.changed.slice(0, 5).join(', ')}${u.changed.length > 5 ? ` +${u.changed.length - 5} more` : ''}`);
  for (const u of r.runtime_only || []) L.push(`  ${u.name}: ${u.from} → ${u.to} is newer but runtime-only: nothing a restart would pick up`);
  if (!r.updates.length && !(r.runtime_only || []).length) L.push('  no plugin is behind');
  if (r.would_run) L.push(`would run: ${r.would_run}`);
  return L.join('\n');
}
