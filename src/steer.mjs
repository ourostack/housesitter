// `housesitter steer`: can another computer see and drive this Mac's agent sessions? Plain checks, no model turns.
//
// What lets a laptop at the office reach this Mac's sessions, and what each check reads:
//   hub        Agency Hub's daemon is connected, tracks every session (track-all), never shuts itself down, and launchd
//              owns the same process, so it comes back after a crash or a reboot (`agency hub status`, `launchctl print`).
//   device     Hub's service lists this Mac online with the sessions it holds (GET /devices).
//   sessions   each live app session has a record Hub can read (GET /sessions/<id>); a 404 means Hub cannot show it.
//   remote     the app creates new sessions with Remote control on, and how many sessions are on (the app's database).
// --repair puts the daemon back under launchd with track-all when that is what is wrong (the supported pair of commands,
// `agency hub stop` then `agency hub autostart enable --track-all`); nothing else is ever changed.
// State: steer.json beside the other recovery state. The agent hears once when a repair did not take, and once when it did.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { iso, readJson, realTell, run, writeJson } from './recovery.mjs';
import { stateDir } from './copilot-app.mjs';

export const HUB_BASE = 'https://agencysessionmanager.app.prod.gitops.startclean.microsoft.com/api/v1';
export const HUB_RESOURCE = 'api://81bbac67-d541-4a6d-a48b-b1c0f9a57888';
export const HUB_LABEL = 'com.microsoft.agency.session-manager';
export const REPAIR_AFTER = 2; // consecutive bad passes before a repair
export const TELL_AFTER_MS = 10 * 60000; // a repair that has not held for this long is told

// `agency hub status` prints a banner, then "hub daemon (PID n)" and indented "Key: value" lines.
export function parseHubStatus(text) {
  const s = String(text || '');
  const pid = s.match(/hub daemon \(PID (\d+)\)/);
  const field = (k) => (s.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'mi')) || [])[1]?.trim() || null;
  return { running: Boolean(pid), pid: pid ? Number(pid[1]) : null, connection: field('Connection'), autoShutdown: field('Auto-shutdown'), tracking: field('Tracking') };
}

// `launchctl print gui/<uid>/<label>`: is the job loaded and which process does it own?
export function parseLaunchd(text) {
  const s = String(text || '');
  return { loaded: /state = /.test(s), running: /state = running/.test(s), pid: Number((s.match(/^\s*pid = (\d+)/m) || [])[1]) || null };
}

// What is wrong, as { code, why, repair } rows. `f` is the facts from gather().
export function judge(f) {
  const bad = [];
  const h = f.hub || {};
  if (!f.agency) return [{ code: 'no-agency', why: 'the Agency CLI was not found', repair: false }];
  if (!h.running) bad.push({ code: 'hub-down', why: 'the Hub daemon is not running', repair: true });
  else {
    if (!/^connected/i.test(h.connection || '')) bad.push({ code: 'hub-disconnected', why: `the Hub daemon says "${h.connection || 'nothing'}", not connected`, repair: true });
    if (!/track-all/i.test(h.tracking || '')) bad.push({ code: 'not-track-all', why: `the Hub daemon tracks "${h.tracking || 'nothing'}", not every session`, repair: true });
    if (!/disabled/i.test(h.autoShutdown || '')) bad.push({ code: 'auto-shutdown', why: 'the Hub daemon is set to shut itself down', repair: true });
  }
  const l = f.launchd || {};
  if (!l.running) bad.push({ code: 'not-under-launchd', why: `launchd's ${HUB_LABEL} is ${l.loaded ? 'loaded but not running' : 'not loaded'}`, repair: true });
  else if (h.pid && l.pid && h.pid !== l.pid) bad.push({ code: 'daemon-unsupervised', why: `the Hub daemon is process ${h.pid} but launchd owns ${l.pid}: a crash would not bring it back`, repair: true });
  if (f.device && f.device.online === false) bad.push({ code: 'device-offline', why: 'Hub\'s service lists this Mac as offline', repair: true });
  if (f.deviceError) bad.push({ code: 'service-unread', why: `Hub's service could not be read (${f.deviceError})`, repair: false, soft: true });
  return bad;
}

export function renderFacts(f, bad) {
  const h = f.hub || {}, l = f.launchd || {};
  const rows = [
    `hub daemon   ${h.running ? `process ${h.pid}, ${h.connection}, ${h.tracking}, auto-shutdown ${h.autoShutdown}` : 'not running'}`,
    `launchd      ${l.running ? `${HUB_LABEL} owns process ${l.pid}${h.pid === l.pid ? ' (the same one)' : ''}` : `${HUB_LABEL}: ${l.loaded ? 'loaded, not running' : 'not loaded'}`}`,
    f.device ? `device       ${f.device.name}: ${f.device.online ? 'online' : 'OFFLINE'}, ${f.device.activeSessionCount} active sessions, last seen ${f.device.lastSeenAt}` : `device       ${f.deviceError ? `unread (${f.deviceError})` : 'not listed'}`,
    f.sessions ? `sessions     ${f.sessions.visible} of ${f.sessions.checked} live app sessions are readable through Hub${f.sessions.missing.length ? `; not found: ${f.sessions.missing.map((s) => s.slice(0, 8)).join(', ')}` : ''}` : 'sessions     not checked',
    f.remote ? `remote       new sessions start ${f.remote.default}; ${f.remote.on} sessions have Remote control on, ${f.remote.export} view only, ${f.remote.off} off` : 'remote       not read',
  ];
  return `${rows.join('\n')}\n${bad.length ? bad.map((b) => `✗ ${b.code}: ${b.why}`).join('\n') : '✓ another computer can see and drive this Mac\'s sessions through Hub'}`;
}

export function agencyPath(home = os.homedir(), env = process.env) {
  const cands = [env.HOUSESITTER_AGENCY, path.join(home, '.config', 'agency', 'CurrentVersion', 'agency'), '/opt/homebrew/bin/agency', '/usr/local/bin/agency'].filter(Boolean);
  return cands.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

export function realSteerDeps({ home = os.homedir(), state = stateDir(), copilotHome = path.join(home, '.copilot'), env = process.env } = {}) {
  const agency = agencyPath(home, env);
  // Agency ignores GH_TOKEN and says so on every call.
  const noWarn = { ...env };
  delete noWarn.GH_TOKEN; delete noWarn.GITHUB_TOKEN;
  const exec = (file, argv, timeoutMs) => new Promise((res) => {
    execFile(file, argv, { timeout: timeoutMs, env: noWarn, maxBuffer: 16 << 20 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
  let token = null;
  return {
    agency,
    state,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    agencyRun: (argv, timeoutMs = 60000) => exec(agency, argv, timeoutMs),
    launchctl: (argv) => run('/bin/launchctl', argv),
    uid: process.getuid(),
    // A Hub token lives in memory for the pass only.
    hubGet: async (p) => {
      if (!token) {
        const az = env.HOUSESITTER_AZ || ['/opt/homebrew/bin/az', '/usr/local/bin/az', '/usr/bin/az'].find((f) => fs.existsSync(f));
        if (!az) throw new Error('no az CLI for a Hub token');
        const r = await exec(az, ['account', 'get-access-token', '--resource', HUB_RESOURCE, '--query', 'accessToken', '-o', 'tsv'], 30000);
        if (r.code !== 0 || !r.stdout.trim()) throw new Error('az would not give a Hub token');
        token = r.stdout.trim();
      }
      const r = await fetch(`${HUB_BASE}${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
      return { status: r.status, body: r.status === 200 ? await r.json().catch(() => null) : null };
    },
    sql: async (q) => {
      const r = await run('/usr/bin/sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', path.join(copilotHome, 'data.db'), q]);
      return r.code === 0 && r.stdout.trim() ? JSON.parse(r.stdout) : [];
    },
    readState: () => readJson(path.join(state, 'steer.json'), {}),
    writeState: (o) => writeJson(path.join(state, 'steer.json'), o),
    tell: realTell({ state, home }),
  };
}

// The facts: every read is bounded and a failed read is data, not a crash.
export async function gather(deps, { sessions = true, peer = null } = {}) {
  const f = { at: iso(deps.now()), agency: deps.agency };
  if (!deps.agency) return f;
  f.hub = parseHubStatus((await deps.agencyRun(['hub', 'status'], 40000)).stdout);
  f.launchd = parseLaunchd((await deps.launchctl(['print', `gui/${deps.uid}/${HUB_LABEL}`])).stdout);
  try {
    const d = await deps.hubGet('/devices');
    const list = Array.isArray(d.body) ? d.body : [];
    const mine = list.find((x) => String(x.deviceName).toLowerCase() === os.hostname().replace(/\.local$/i, '').toLowerCase()) || list.find((x) => x.source === 'DevMachine' && x.platform === 'macos');
    if (d.status !== 200) f.deviceError = `devices answered ${d.status}`;
    else if (mine) f.device = { name: mine.deviceName, id: mine.deviceId, online: Boolean(mine.online), activeSessionCount: mine.activeSessionCount, lastSeenAt: mine.lastSeenAt };
    // Another Mac's device, as this Mac's token reads it: whether it can see that Mac at all.
    if (peer && d.status === 200) {
      const p = list.find((x) => String(x.deviceName).toLowerCase() === String(peer).toLowerCase());
      f.peer = p ? { name: p.deviceName, online: Boolean(p.online), activeSessionCount: p.activeSessionCount, lastSeenAt: p.lastSeenAt } : { name: peer, online: false, listed: false };
    }
  } catch (e) { f.deviceError = String(e.message || e).slice(0, 100); }
  try {
    const rows = await deps.sql("select coalesce(remote_session_mode,'') m, count(*) n from sessions group by 1");
    const n = (m) => rows.filter((r) => r.m === m).reduce((a, r) => a + r.n, 0);
    const def = await deps.sql("select value from app_state where key='remote-session-default'");
    let mode = 'unknown'; try { mode = JSON.parse(def[0].value).state.defaultRemoteSessionMode; } catch { /* not set */ }
    f.remote = { default: mode, on: n('on'), export: n('export'), off: n('off') };
  } catch { /* the app's database is optional here */ }
  if (sessions && f.device) f.sessions = await readable(deps);
  return f;
}

// The live app sessions on this Mac (what the Agency CLI lists locally) that Hub's service can read by id. A skill-evaluation
// or other CLI scratch session is not an app session and is not counted.
export async function readable(deps, { max = 40 } = {}) {
  let local = [];
  try { local = JSON.parse((await deps.agencyRun(['hub', 'list-local-sessions', '--active', '--limit', '400', '--json'], 90000)).stdout).sessions || []; } catch { return null; }
  const ids = local.filter((s) => s.source === 'copilot_app' && s.session_id).slice(0, max).map((s) => s.session_id);
  const out = { checked: ids.length, visible: 0, missing: [], rows: [] };
  for (const id of ids) {
    try {
      const r = await deps.hubGet(`/sessions/${id}`);
      if (r.status === 200 && r.body) { out.visible++; out.rows.push({ id, title: r.body.title, status: r.body.status, detail: r.body.statusDetail || null, last: r.body.lastActivityAt }); } else out.missing.push(id);
    } catch { out.missing.push(id); }
  }
  return out;
}

// Put the Hub daemon back under launchd with track-all. Stopping a hand-started daemon first matters: otherwise the
// autostart job sees it running, exits, and leaves the manual process unsupervised.
export async function repairHub(deps) {
  const steps = [];
  const stop = await deps.agencyRun(['hub', 'stop'], 60000);
  steps.push(`hub stop: exit ${stop.code}`);
  const en = await deps.agencyRun(['hub', 'autostart', 'enable', '--track-all'], 90000);
  steps.push(`autostart enable --track-all: exit ${en.code}`);
  await deps.sleep(8000);
  return { ok: en.code === 0, steps };
}

// One pass. A bad state is repaired on its second consecutive sighting (a restart in flight looks bad for a moment);
// the agent hears once if it is still bad TELL_AFTER_MS after the first sighting, and once when it is good again.
export async function pass({ repair = false, sessions = true, peer = null, immediate = false } = {}, deps, say = () => {}) {
  const now = deps.now();
  let f = await gather(deps, { sessions, peer });
  let bad = judge(f).filter((b) => !b.soft);
  const st = deps.readState() || {};
  const next = { ...st, at: iso(now), ok: !bad.length, problems: bad.map((b) => b.code) };
  const repaired = [];
  if (bad.length) {
    next.bad_runs = (st.bad_runs || 0) + 1;
    next.bad_since = st.bad_since || iso(now);
    if (repair && (immediate || next.bad_runs >= REPAIR_AFTER) && bad.some((b) => b.repair)) {
      say(`${iso(now)} steer: ${bad.map((b) => b.code).join(', ')}: repairing`);
      const r = await repairHub(deps);
      repaired.push(...r.steps);
      f = await gather(deps, { sessions: false, peer });
      bad = judge(f).filter((b) => !b.soft);
      next.ok = !bad.length;
      next.problems = bad.map((b) => b.code);
      next.last_repair = { at: iso(now), steps: r.steps, ok: !bad.length };
    }
    if (!bad.length) { delete next.bad_runs; delete next.bad_since; if (st.told_bad) await deps.tell('Housesitter: Agency Hub is reachable again, so another computer can see and drive this Mac\'s sessions.'); delete next.told_bad; }
    else if (!st.told_bad && now - Date.parse(next.bad_since) >= TELL_AFTER_MS) {
      const t = await deps.tell(`Housesitter: another computer cannot reliably see and drive this Mac's sessions through Agency Hub since ${next.bad_since}: ${bad.map((b) => b.why).join('; ')}.${repaired.length ? ` A repair was tried (${repaired.join('; ')}) and did not hold.` : ''}`);
      next.told_bad = t.ok;
    }
  } else {
    if (st.told_bad) await deps.tell('Housesitter: Agency Hub is reachable again, so another computer can see and drive this Mac\'s sessions.');
    delete next.bad_runs; delete next.bad_since; delete next.told_bad;
  }
  deps.writeState(next);
  return { facts: f, bad, repaired };
}
