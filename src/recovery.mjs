// What the recovery jobs share: where they keep their state, the incident record, telling the agent once after the fact,
// and the launchd agents that run them. No model turns are spent here: each job is a plain program that launchd runs on a
// timer, and the agent hears only when there is something to say.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which } from './peer-watch.mjs';

export const incidentsDir = (home = os.homedir()) => path.join(home, 'Library', 'Logs', 'housesitter', 'incidents');

export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
export const short = (id) => String(id).slice(0, 8);

export const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };

export const run = (file, argv, { timeoutMs = 30000 } = {}) => new Promise((res) => {
  execFile(file, argv, { timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: Boolean(err?.killed), stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

// ---------- the incident record: one JSON line each, in the state folder ----------

export const incidentFile = (state) => path.join(state, 'incidents.jsonl');

export function recordIncident(state, rec) {
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(incidentFile(state), `${JSON.stringify(rec)}\n`);
}

export function readIncidents(state) {
  try { return fs.readFileSync(incidentFile(state), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

// The incidents of these kinds in the last `withinMs`, oldest first.
export const recentIncidents = (state, kinds, withinMs, now) => readIncidents(state).filter((r) => kinds.includes(r.kind) && now - Date.parse(r.at) <= withinMs);

// ---------- telling the agent ----------

// The agent's CLI: named, on PATH, or where its installer puts it (launchd's PATH is short).
export function findOuro(home = os.homedir(), env = process.env) {
  return env.HOUSESITTER_OURO || which('ouro', env.PATH || '') || [path.join(home, '.ouro-cli', 'bin', 'ouro')].find((p) => fs.existsSync(p)) || null;
}

// One message to the agent, which tells the person. Every message is also appended to told.log in the state folder.
// Ouro's CLI asks who wanted a message sent: this is Housesitter's standing job, set up by the operator.
export const WHY = 'Housesitter is the operator\'s standing Mac-keeping job; it reports what it did without being asked';

export function realTell({ state, home = os.homedir(), agent = process.env.HOUSESITTER_AGENT || 'ouroboros' } = {}) {
  return async (text) => {
    const ouro = findOuro(home);
    let r = { code: 1, stderr: 'the ouro CLI was not found' };
    if (ouro) r = await run(ouro, ['msg', '--to', agent, '--why', WHY, text], { timeoutMs: 60000 });
    try { fs.mkdirSync(state, { recursive: true }); fs.appendFileSync(path.join(state, 'told.log'), `${JSON.stringify({ at: new Date().toISOString(), ok: r.code === 0, text, error: r.code === 0 ? undefined : String(r.stderr).trim().slice(0, 200) })}\n`); } catch { /* the log is a courtesy */ }
    return { ok: r.code === 0, error: r.code === 0 ? null : String(r.stderr).trim().slice(0, 200) };
  };
}

// ---------- launchd agents ----------

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function agentPlist({ label, program, env = {}, log, every = null, keepAlive = false }) {
  const envs = Object.entries(env).map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
${every ? `  <key>StartInterval</key><integer>${every}</integer>\n` : ''}${keepAlive ? '  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>\n' : ''}  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>EnvironmentVariables</key>
  <dict>
${envs}
  </dict>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}

export const agentPath = (label, home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);

// Write (and, unless dry, load) one agent. Loading replaces a running copy of the same label.
export async function installAgent({ label, program, env, every, keepAlive, logName, home = os.homedir(), dry = false, launchctl = (a) => run('/bin/launchctl', a), uid = process.getuid() }) {
  const file = agentPath(label, home);
  const log = path.join(home, 'Library', 'Logs', logName);
  const text = agentPlist({ label, program, env, log, every, keepAlive });
  if (dry) return { ok: true, dry_run: true, label, plist: file, log, text };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(file, text);
  await launchctl(['bootout', `gui/${uid}/${label}`]);
  const r = await launchctl(['bootstrap', `gui/${uid}`, file]);
  return { ok: r.code === 0, label, plist: file, log, error: r.stderr.trim() };
}

export async function uninstallAgent({ label, home = os.homedir(), launchctl = (a) => run('/bin/launchctl', a), uid = process.getuid() }) {
  await launchctl(['bootout', `gui/${uid}/${label}`]);
  fs.rmSync(agentPath(label, home), { force: true });
  return { ok: true, label, plist: agentPath(label, home) };
}

// The jobs, each a plain program on a timer. --install-recovery loads them all.
export const AGENTS = {
  heartbeat: { label: 'bot.ouro.housesitter.heartbeat', args: ['restart-copilot', '--heartbeat', '--quiet'], every: 30, logName: 'housesitter-heartbeat.launchd.log' },
  os: { label: 'bot.ouro.housesitter.os-updates', args: ['restart-copilot', '--os-updates', '--quiet'], every: 300, logName: 'housesitter-os-updates.launchd.log' },
  steer: { label: 'bot.ouro.housesitter.steer', args: ['steer', '--repair', '--no-sessions', '--quiet'], every: 120, logName: 'housesitter-steer.launchd.log' },
  disk: { label: 'bot.ouro.housesitter.disk-prune', args: ['restart-copilot', '--disk-prune', '--quiet'], every: 600, logName: 'housesitter-disk-prune.launchd.log' },
  load: { label: 'bot.ouro.housesitter.load-shed', args: ['restart-copilot', '--load-shed'], every: 30, logName: 'housesitter-load-shed.launchd.log' },
  fleet: { label: 'bot.ouro.housesitter.fleet-run', args: ['fleet', 'run', '--serve', '--quiet'], every: 60, logName: 'housesitter-fleet-run.launchd.log' },
  hold: { label: 'bot.ouro.housesitter.hold', args: ['hold', '--quiet'], every: 3600, logName: 'housesitter-hold.launchd.log' },
};

// Jobs an older version installed and this one retired (the six-hour health watch is Shepherd's now): unloaded and removed, so no
// launchd job keeps calling a flag that is gone.
export const RETIRED = ['bot.ouro.housesitter.health-watch'];

export async function retireAgents({ home = os.homedir(), dry = false, launchctl = (a) => run('/bin/launchctl', a), uid = process.getuid() } = {}) {
  const out = [];
  for (const label of RETIRED) {
    const plist = agentPath(label, home);
    if (!fs.existsSync(plist)) continue;
    out.push(dry ? { ok: true, dry_run: true, label, plist } : await uninstallAgent({ label, home, launchctl, uid }));
  }
  return out;
}

// What --status shows of the recovery jobs: the heartbeat's last run and the last incidents. The six-hour health watch is Shepherd's.
export function readRecovery(dir, now = Date.now()) {
  const b = readJson(path.join(dir, 'heartbeat.json'), {});
  return { beat_at: b.beat_at || null, beat_age_s: b.beat_at ? Math.round((now - Date.parse(b.beat_at)) / 1000) : null, app: b.app || null, bad: b.bad || null, incidents: readIncidents(dir).slice(-5) };
}

export function renderRecovery(r) {
  const L = [];
  if (r.beat_at) L.push(`heartbeat: last run ${r.beat_age_s} s ago${r.beat_age_s > 180 ? ' (STALE: the job may not be running)' : ''}${r.bad ? `; the app is failing its probe since ${r.bad.since} (${r.bad.failures.join(', ')})` : '; the app answers'}`);
  else L.push('heartbeat: not running yet (restart-copilot --install-recovery)');
  L.push('health watch: Shepherd\'s; `shepherd watch --status` shows the resumed sessions it follows');
  for (const i of r.incidents) L.push(`  ${i.at} ${i.kind}${i.cause ? ` (${i.cause})` : ''}${i.ok === false ? ' FAILED' : ''}${i.evidence ? `: ${i.evidence}` : ''}`);
  return L.join('\n');
}

// The Mac must not sleep while agents work on it: a user-level caffeinate held by launchd (no password needed).
export const KEEP_AWAKE = { label: 'bot.ouro.housesitter.keep-awake', program: ['/usr/bin/caffeinate', '-imsu'], keepAlive: true, logName: 'housesitter-keep-awake.log' };
