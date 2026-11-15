// `housesitter laptop-arrival`: when a Mac that has been away comes back online, bring it up to date and say so once.
//
// Written for Ari's laptop, which goes to the office for days. From the always-on Mac, with no model turns, one pass a minute:
//   1. Is it back? Agency Hub lists its device online (a cheap GET); then its Mac bus must answer a shell command.
//   2. A new arrival (it was gone for 10 minutes or more, or it rebooted) starts a fresh run of the steps below. A short
//      network blip does not. Each step looks at the laptop first and acts only when something is off, so running the
//      whole list twice changes nothing the second time.
//        housesitter  the laptop has a current checkout of this tool (it does the restart and the checks there)
//        app          the Copilot app is at least as new as the one on this Mac and runs the newest Desk; if not, restart
//                     it with its sessions saved and resumed (READY/DEFER, as on this Mac). It waits while someone is using
//                     the laptop; a locked screen is not "using" it, and the quit then goes by signal, not by menu.
//        retire       the jobs the mini has taken over are unloaded and their plists moved aside (never deleted)
//        verify       the laptop's Hub daemon is connected, tracks every session and is under launchd; it can read this
//                     Mac's device and sessions in Hub's service; the app and Desk are at their floor
//        report       the agent is told once, so Ari hears "the laptop is up; you can steer the mini from it"
//        macd         last, the laptop's Mac bus daemon is updated to the current tools, and must answer afterwards
//   3. A step that cannot finish says why; the agent hears once, after 20 minutes, which step is stuck and why.
// The route to the laptop is whatever `route` names in the config: `<route...> sh <peer> --timeout <s> '<cmd>'` runs a shell
// command there and `<route...> gate <peer> check` says whether a person is using it. State: arrival.json in the state folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { hhmm, iso, readJson, realTell, writeJson } from './recovery.mjs';
import { stateDir } from './copilot-app.mjs';
import { HUB_BASE, HUB_RESOURCE } from './steer.mjs';

export const DEFAULTS = {
  peer: 'laptop',
  route: [],
  hub_device_id: null,
  mini_device_name: null, // the always-on Mac's name in Hub, for the laptop's "can I see it" check
  target_app: 'mini', // 'mini': at least the version of this Mac's app
  min_desk: '3.2.154',
  housesitter_git: 'https://github.com/ourostack/housesitter.git',
  retire: [], // [{ label, requires_local_job? }]
  macd_update: false,
  probe_every_ms: 5 * 60000, // route probe when Hub's service cannot be read
  down_gap_ms: 10 * 60000,
  blocked_tell_ms: 20 * 60000,
  app_fallback_ms: 45 * 60000, // how long the app's own updater gets before brew is tried
  restart_max: 2,
  step_tries: 6,
};

export const cmpVersion = (a, b) => {
  const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
};

export const parseKv = (text) => Object.fromEntries(String(text || '').split('\n').map((l) => l.match(/^([a-z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));

// The first line of `gate check` is OPEN or CLOSED with the reason. A locked screen is not a person at work.
export function parseGate(text) {
  const t = String(text || '');
  if (/^OPEN/m.test(t)) return { state: 'idle', why: t.trim().split('\n')[0] };
  if (/locked|login window|screen saver/i.test(t)) return { state: 'locked', why: t.trim().split('\n')[0] };
  if (/CLOSED/.test(t)) return { state: 'active', why: t.trim().split('\n')[0] };
  return { state: 'unknown', why: t.trim().split('\n')[0] || 'no answer' };
}

const PATH_PREFIX = 'export PATH="$(ls -d "$HOME"/.nvm/versions/node/v22* 2>/dev/null | sort -V | tail -1)/bin:$HOME/.config/agency/CurrentVersion:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"';
const APP = '/Applications/GitHub Copilot.app';
const HS = '$HOME/code/housesitter';

export const SCRIPTS = {
  facts: `${PATH_PREFIX}
echo "boot=$(sysctl -n kern.boottime | sed -n 's/^{ sec = \\([0-9]*\\),.*/\\1/p')"
echo "now=$(date +%s)"
echo "user=$(id -un)"
echo "app=$(defaults read "${APP}/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
echo "app_pid=$(pgrep -f "${APP}/Contents/MacOS/" | head -1)"
echo "node=$(node -v 2>/dev/null)"
echo "hs=$(git -C ${HS} rev-parse --short HEAD 2>/dev/null)"
echo "jobs=$(launchctl list 2>/dev/null | awk 'NR>1{print $3}' | paste -sd, -)"
echo "plists=$(ls "$HOME"/Library/LaunchAgents 2>/dev/null | sed -n 's/\\.plist$//p' | paste -sd, -)"`,
  housesitter: (git) => `${PATH_PREFIX}
set -e
mkdir -p "$HOME/code"
if [ -d ${HS}/.git ]; then git -C ${HS} fetch -q origin && git -C ${HS} merge --ff-only -q origin/main; else git clone -q ${git} ${HS}; fi
cd ${HS}
[ -d node_modules/@ouro.bot/hackamore ] || npm install --omit=dev --no-audit --no-fund --silent
echo "hs=$(git rev-parse --short HEAD)"`,
  plugins: `${PATH_PREFIX}
cd ${HS} && node bin/housesitter.mjs restart-copilot --plugin-updates --dry-run --json 2>/dev/null | tail -1`,
  restartStatus: `${PATH_PREFIX}
cd ${HS} && node bin/housesitter.mjs restart-copilot --status --json 2>/dev/null | tail -1`,
  restart: ({ sigterm, why }) => `${PATH_PREFIX}
cd ${HS} && node bin/housesitter.mjs restart-copilot --resume --detach ${sigterm ? '--sigterm ' : ''}--why '${why.replace(/'/g, '')}' 2>&1 | tail -3`,
  retire: (label) => `uid=$(id -u)
launchctl bootout "gui/$uid/${label}" 2>/dev/null || true
if [ -f "$HOME/Library/LaunchAgents/${label}.plist" ]; then mkdir -p "$HOME/Library/LaunchAgents.retired" && mv "$HOME/Library/LaunchAgents/${label}.plist" "$HOME/Library/LaunchAgents.retired/${label}.plist.$(date +%Y%m%d%H%M%S)"; fi
echo "retired=${label}"`,
  verify: (peer) => `${PATH_PREFIX}
cd ${HS} && node bin/housesitter.mjs steer --repair --no-sessions ${peer ? `--peer '${peer.replace(/'/g, '')}' ` : ''}--json 2>/dev/null | tail -1`,
  appUpgrade: `${PATH_PREFIX}
brew upgrade --cask --greedy github-copilot-app 2>&1 | tail -3`,
};

const parseJsonLine = (t) => { try { return JSON.parse(String(t).trim().split('\n').filter(Boolean).at(-1)); } catch { return null; } };

export const STEPS = ['housesitter', 'app', 'retire', 'verify', 'report', 'macd'];

export function describePlan(cfg) {
  return [
    `detect: Hub lists the laptop's device online and its bus answers a shell command`,
    `housesitter: a current checkout of this tool on the laptop (${cfg.housesitter_git})`,
    `app: the Copilot app at least ${cfg.target_app === 'mini' ? "this Mac's version" : cfg.target_app} and Desk at least ${cfg.min_desk}; otherwise restart it with its sessions saved and resumed (waits while someone uses the laptop)`,
    `retire: ${cfg.retire.length ? `unload and move aside ${cfg.retire.map((r) => r.label).join(', ')}` : 'nothing configured'}`,
    `verify: the laptop's Hub daemon connected, tracking every session, under launchd; it can read this Mac's device in Hub`,
    `report: tell the agent once that the laptop is up and the Mac can be steered from it`,
    `macd: ${cfg.macd_update ? "update the laptop's Mac bus daemon, then require it to answer" : 'not configured'}`,
  ];
}

export function loadConfig(file) {
  const raw = readJson(file, null);
  if (!raw) throw new Error(`no config at ${file}`);
  const cfg = { ...DEFAULTS, ...raw };
  if (!Array.isArray(cfg.route) || !cfg.route.length) throw new Error('the config needs "route": the command that reaches the laptop, such as ["/path/to/mac"]');
  return cfg;
}

// ---------- the real dependencies ----------

const exec = (file, argv, timeoutMs, env = process.env) => new Promise((res) => {
  execFile(file, argv, { timeout: timeoutMs, env, maxBuffer: 16 << 20 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

export function realArrivalDeps(cfg, { home = os.homedir(), state = stateDir(), env = process.env } = {}) {
  let token = null;
  const hubGet = async (p) => {
    if (!token) {
      const az = env.HOUSESITTER_AZ || ['/opt/homebrew/bin/az', '/usr/local/bin/az', '/usr/bin/az'].find((f) => fs.existsSync(f));
      if (!az) throw new Error('no az CLI for a Hub token');
      const r = await exec(az, ['account', 'get-access-token', '--resource', HUB_RESOURCE, '--query', 'accessToken', '-o', 'tsv'], 30000, env);
      if (r.code !== 0 || !r.stdout.trim()) throw new Error('az would not give a Hub token');
      token = r.stdout.trim();
    }
    const r = await fetch(`${HUB_BASE}${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (r.status !== 200) throw new Error(`Hub answered ${r.status}`);
    return r.json();
  };
  const mac = (argv, timeoutMs = 60000) => exec(cfg.route[0], [...cfg.route.slice(1), ...argv], timeoutMs, env);
  return {
    now: () => Date.now(),
    hubDevice: async (id) => {
      const list = await hubGet('/devices');
      const d = (Array.isArray(list) ? list : []).find((x) => String(x.deviceId).toLowerCase() === String(id).toLowerCase());
      return d ? { listed: true, online: Boolean(d.online), lastSeenAt: d.lastSeenAt } : { listed: false, online: false };
    },
    mac,
    sh: async (cmd, timeoutS = 20) => {
      const r = await mac(['sh', cfg.peer, '--timeout', String(timeoutS), cmd], (timeoutS + 25) * 1000);
      const text = `${r.stdout}\n${r.stderr}`;
      // A route that answers through a model session is not a watcher's route: refuse it.
      if (/via relay/.test(text)) return { ok: false, noRelay: true, out: '', err: 'the route answered through a model-backed relay, which a watcher must not use', code: 1 };
      return { ok: r.code === 0, noRelay: /no-relay/.test(text), out: r.stdout, err: r.stderr.trim().slice(0, 300), code: r.code };
    },
    gate: async () => parseGate((await mac(['gate', cfg.peer, 'check'], 45000)).stdout),
    miniVersion: async () => (await exec('/usr/bin/defaults', ['read', `${APP}/Contents/Info`, 'CFBundleShortVersionString'], 10000)).stdout.trim() || null,
    miniJobRunning: async (label) => /state = running/.test((await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], 10000)).stdout),
    readState: () => readJson(path.join(state, 'arrival.json'), null),
    writeState: (o) => writeJson(path.join(state, 'arrival.json'), o),
    log: (line) => { try { fs.mkdirSync(state, { recursive: true }); const f = path.join(state, 'arrival.log'); if (fs.existsSync(f) && fs.statSync(f).size > 1 << 20) fs.renameSync(f, `${f}.1`); fs.appendFileSync(f, `${line}\n`); } catch { /* a courtesy */ } },
    tell: realTell({ state, home }),
  };
}

// ---------- one pass ----------

const newEpoch = (now, boot) => ({ id: iso(now), started: iso(now), boot: boot || null, steps: {}, told: {}, restarts: 0 });

async function readFacts(deps) {
  const r = await deps.sh(SCRIPTS.facts, 25);
  return r.ok ? { ok: true, facts: parseKv(r.out) } : { ok: false, noRelay: r.noRelay, err: r.err };
}

// Who is back? 'up' with facts, 'hub-only' (Hub lists it, its bus does not answer), or 'down'.
export async function detect(cfg, st, deps, now) {
  let hub = null;
  try { hub = await deps.hubDevice(cfg.hub_device_id); } catch (e) { hub = { error: String(e.message || e).slice(0, 100) }; }
  const probeDue = !st?.last_probe || now - Date.parse(st.last_probe) >= cfg.probe_every_ms;
  if (!hub.error && !hub.online) return { kind: 'down', why: hub.listed ? `Hub lists the laptop's device offline (last seen ${hub.lastSeenAt})` : "Hub does not list the laptop's device" };
  if (hub.error && !probeDue) return { kind: st?.phase === 'up' ? 'up-unchecked' : 'down', why: `Hub's service could not be read (${hub.error}); next probe of the bus is not due`, hub };
  const f = await readFacts(deps);
  if (!f.ok) return { kind: hub.error ? 'down' : 'hub-only', why: f.noRelay ? 'its Mac bus does not answer yet (no relay)' : `its shell did not answer: ${f.err}`, hub, probed: true };
  return { kind: 'up', facts: f.facts, hub, probed: true };
}

const stepNote = (st, name) => st.epoch.steps[name] || {};
const setStep = (st, name, status, detail, now) => {
  const prev = st.epoch.steps[name] || {};
  st.epoch.steps[name] = { status, detail, at: iso(now), tries: status === 'fail' ? (prev.tries || 0) + 1 : prev.tries || 0, since: prev.status === status ? prev.since : iso(now) };
};

async function stepHousesitter({ cfg, deps, opts }) {
  const r0 = await deps.sh('git -C "$HOME/code/housesitter" rev-parse --short HEAD 2>/dev/null; true', 10);
  const had = r0.out.trim();
  if (opts.dry_run) return { status: 'would', detail: had ? `would update the checkout (${had})` : 'would clone it' };
  const r = await deps.sh(SCRIPTS.housesitter(cfg.housesitter_git), 280);
  if (!r.ok) return { status: 'fail', detail: `the checkout did not update: ${r.err || r.out.trim().split('\n').at(-1)}` };
  return { status: 'done', detail: `housesitter ${parseKv(r.out).hs || '?'} on the laptop` };
}

export function appNeed({ app, desk, plug, target, minDesk }) {
  const why = [];
  if (!app) why.push('its version is unreadable');
  else if (target && cmpVersion(app, target) < 0) why.push(`app ${app} is older than ${target}`);
  const dv = (plug?.loaded || []).find((l) => l.name === 'desk')?.version || desk || null;
  if (plug && !(plug.loaded || []).length) why.push('no Desk is loaded (the app is not running)');
  else if (dv && cmpVersion(dv, minDesk) < 0) why.push(`Desk ${dv} is older than ${minDesk}`);
  if (plug?.updates?.length) why.push(`${plug.updates.map((u) => `${u.name} ${u.from} → ${u.to}`).join(', ')} waiting in the plugin cache`);
  return { need: why.length > 0, why, desk: dv };
}

async function stepApp({ cfg, deps, st, now, facts, opts }) {
  const target = cfg.target_app === 'mini' ? await deps.miniVersion() : cfg.target_app;
  const rs = parseJsonLine((await deps.sh(SCRIPTS.restartStatus, 25)).out);
  if (rs?.state === 'running' && !rs.stale) return { status: 'wait', detail: `a restart is running on the laptop (${rs.step || 'working'})` };
  if (opts.dry_run && !facts.hs) return { status: 'would', detail: 'after the checkout, would compare the app and Desk against their floors and restart it if behind' };
  const plug = parseJsonLine((await deps.sh(SCRIPTS.plugins, 60)).out);
  if (!plug) return { status: 'fail', detail: 'could not read which Desk the laptop\'s app has loaded' };
  const n = appNeed({ app: facts.app, plug, target, minDesk: cfg.min_desk });
  if (!n.need) return { status: 'done', detail: `app ${facts.app}, Desk ${n.desk || 'current'}` };
  const ep = st.epoch;
  const sinceArrival = now - Date.parse(ep.started);
  // The app updates itself; after it has had its time, the cask is the fallback (once per arrival).
  if (n.why.some((w) => /older than \d/.test(w) && /^app/.test(w)) && sinceArrival >= cfg.app_fallback_ms && !ep.told.brew && ep.restarts >= 1) {
    if (opts.dry_run) return { status: 'would', detail: `would run brew upgrade for the app (${n.why.join('; ')})` };
    const g = await deps.gate();
    if (g.state !== 'idle' && g.state !== 'locked') return { status: 'wait', detail: `the app's own updater has not caught up and the laptop is in use or unreadable (${g.why})` };
    ep.told.brew = iso(now);
    const b = await deps.sh(SCRIPTS.appUpgrade, 280);
    return { status: 'wait', detail: `brew upgrade for the app: ${b.out.trim().split('\n').at(-1) || b.err}` };
  }
  if (ep.restarts >= cfg.restart_max) return { status: 'wait', detail: `restarted ${ep.restarts} times this arrival and still behind (${n.why.join('; ')}); waiting for the app's own updater` };
  const g = await deps.gate();
  if (g.state === 'active') return { status: 'wait', detail: `waiting for the laptop to be idle or locked (${g.why}); needs: ${n.why.join('; ')}` };
  if (g.state === 'unknown') return { status: 'wait', detail: `cannot tell whether someone is using the laptop (${g.why})` };
  if (opts.dry_run) return { status: 'would', detail: `would restart the app (${g.state}): ${n.why.join('; ')}` };
  const r = await deps.sh(SCRIPTS.restart({ sigterm: g.state === 'locked', why: `the laptop is back online: ${n.why.join('; ')}`.slice(0, 160) }), 60);
  if (!r.ok) return { status: 'fail', detail: `the restart did not start: ${r.err || r.out.trim().split('\n').at(-1)}` };
  ep.restarts += 1;
  return { status: 'wait', detail: `restart started (${g.state}): ${n.why.join('; ')}` };
}

async function stepRetire({ cfg, deps, facts, opts }) {
  if (!cfg.retire.length) return { status: 'done', detail: 'nothing to retire' };
  const loaded = new Set((facts.jobs || '').split(','));
  const present = new Set((facts.plists || '').split(','));
  const todo = cfg.retire.filter((r) => loaded.has(r.label) || present.has(r.label));
  if (!todo.length) return { status: 'done', detail: `${cfg.retire.length} already retired` };
  const moved = [], held = [];
  for (const r of todo) {
    if (r.requires_local_job && !(await deps.miniJobRunning(r.requires_local_job))) { held.push(`${r.label} (this Mac's ${r.requires_local_job} is not running yet)`); continue; }
    if (opts.dry_run) { moved.push(`${r.label} (would)`); continue; }
    const x = await deps.sh(SCRIPTS.retire(r.label), 20);
    if (x.ok) moved.push(r.label); else held.push(`${r.label}: ${x.err}`);
  }
  if (opts.dry_run) return { status: 'would', detail: `would retire ${moved.map((m) => m.replace(' (would)', '')).join(', ')}${held.length ? `; holding ${held.join('; ')}` : ''}` };
  if (held.length) return { status: 'wait', detail: `retired ${moved.join(', ') || 'none'}; holding ${held.join('; ')}` };
  return { status: 'done', detail: `retired ${moved.join(', ')}` };
}

async function stepVerify({ cfg, deps, facts }) {
  const r = await deps.sh(SCRIPTS.verify(cfg.mini_device_name), 120);
  const j = parseJsonLine(r.out);
  if (!r.ok || !j) return { status: 'fail', detail: `the laptop's steering check gave no answer: ${r.err || r.out.trim().slice(-120)}` };
  const bad = (j.problems || []).filter((p) => p !== 'service-unread');
  const seen = j.peer ? (j.peer.online ? `it reads this Mac's device online with ${j.peer.activeSessionCount} sessions` : 'it reads this Mac as OFFLINE in Hub') : 'it cannot read Hub\'s service (az sign-in?), so the sight of this Mac is not proven from there';
  const remote = j.remote ? `new sessions start with Remote control ${j.remote.default}` : 'Remote control state unread';
  const hub = `Hub ${bad.length ? `NOT OK (${bad.join(', ')})` : 'connected, tracking every session, under launchd'}`;
  if (bad.length) return { status: 'fail', detail: `${hub}; ${seen}`, info: { remote } };
  if (j.peer && !j.peer.online) return { status: 'wait', detail: `${hub}; ${seen}`, info: { remote } };
  return { status: 'done', detail: `${hub}; ${seen}; ${remote}`, info: { remote, peer: j.peer || null } };
}

export function reportText({ facts, st, cfg }) {
  const s = st.epoch.steps;
  const lines = [`Housesitter: the laptop is up (arrived ${hhmm(Date.parse(st.epoch.started))}); you can steer the mini from it.`];
  lines.push(`Laptop: Copilot app ${facts.app || '?'}, ${s.app?.detail || 'app checked'}. ${s.verify?.detail || ''}`);
  if (s.retire?.detail && !/nothing|already/.test(s.retire.detail)) lines.push(`On the laptop: ${s.retire.detail}.`);
  lines.push('From the laptop Ari can: read and answer the mini\'s sessions in Agency Hub and, for sessions with Remote control on, the Copilot app (Resume remote session); `mac sessions send|tail aris-mac-mini:<id>` steers any session; `mac session aris-mac-mini open <cwd> <prompt>` starts one; Ouroboros on Teams works from anywhere.');
  return lines.join('\n');
}

export async function pass(opts, deps, say = () => {}) {
  const cfg = opts.cfg;
  const now = deps.now();
  const out = (m) => { const l = `${iso(now)} laptop-arrival${opts.dry_run ? ' (dry run)' : ''}: ${m}`; say(l); if (!opts.dry_run) deps.log?.(l); };
  const st0 = deps.readState() || { phase: 'down' };
  const st = JSON.parse(JSON.stringify(st0));
  const d = await detect(cfg, st, deps, now);
  if (d.probed) st.last_probe = iso(now);
  if (d.kind === 'down' || d.kind === 'hub-only') {
    const wasUp = st.phase === 'up';
    if (wasUp || !st.down_at) st.down_at = iso(now);
    st.phase = d.kind === 'hub-only' ? 'hub-only' : 'down';
    if (d.kind === 'hub-only') {
      st.hub_only_since = st.hub_only_since || iso(now);
      if (now - Date.parse(st.hub_only_since) >= cfg.blocked_tell_ms && !st.told_hub_only && !opts.dry_run) {
        const t = await deps.tell(`Housesitter: the laptop is online in Agency Hub but its Mac bus does not answer (${d.why}), so I cannot update it. It needs its Mac bus daemon (macd) running there.`);
        st.told_hub_only = t.ok;
      }
    }
    if (wasUp) out(`the laptop went offline: ${d.why}`);
    if (!opts.dry_run) deps.writeState(st);
    out(`${d.kind}: ${d.why}`);
    return { action: d.kind, why: d.why, state: st, plan: describePlan(cfg) };
  }
  if (d.kind === 'up-unchecked') { out(d.why); return { action: 'unchecked', why: d.why, state: st }; }

  const facts = d.facts;
  const boot = facts.boot || null;
  const gapped = st.phase !== 'up' && (!st.epoch || !st.down_at || now - Date.parse(st.down_at) >= cfg.down_gap_ms);
  if (!st.epoch || gapped || (boot && st.epoch.boot && boot !== st.epoch.boot)) {
    st.epoch = newEpoch(now, boot);
    out(`the laptop is back (app ${facts.app || '?'}, up since ${boot ? hhmm(Number(boot) * 1000) : '?'}): starting the arrival steps`);
  }
  st.epoch.boot = st.epoch.boot || boot;
  st.phase = 'up'; delete st.hub_only_since; delete st.told_hub_only; delete st.down_at;

  if (st.epoch.complete) { if (!opts.dry_run) deps.writeState(st); return { action: 'idle', state: st }; }

  const ctx = { cfg, deps, st, now, facts, opts };
  const run = { housesitter: stepHousesitter, app: stepApp, retire: stepRetire, verify: stepVerify };
  for (const name of STEPS) {
    const prev = stepNote(st, name);
    if (prev.status === 'done') continue;
    if (name === 'report' || name === 'macd') continue;
    if (name !== 'housesitter' && stepNote(st, 'housesitter').status !== 'done' && !opts.dry_run) { setStep(st, name, 'wait', 'waits for the checkout of this tool on the laptop', now); continue; }
    if ((prev.tries || 0) >= cfg.step_tries && prev.status === 'fail') continue;
    let r;
    try { r = await run[name](ctx); } catch (e) { r = { status: 'fail', detail: String(e.message || e).slice(0, 200) }; }
    setStep(st, name, r.status, r.detail, now);
    if (r.info) st.epoch.info = { ...st.epoch.info, ...r.info };
    out(`${name}: ${r.status}: ${r.detail}`);
  }

  const core = ['housesitter', 'app', 'retire', 'verify'];
  const allDone = core.every((n) => stepNote(st, n).status === 'done');
  if (allDone && !st.epoch.told.report && !opts.dry_run) {
    const t = await deps.tell(reportText({ facts, st, cfg }));
    st.epoch.told.report = t.ok ? iso(now) : null;
    setStep(st, 'report', t.ok ? 'done' : 'fail', t.ok ? 'the agent was told' : `the agent could not be told: ${t.error}`, now);
    out(`report: ${t.ok ? 'told the agent once' : `not delivered (${t.error})`}`);
  } else if (allDone && opts.dry_run) setStep(st, 'report', 'would', 'would tell the agent once', now);
  if (st.epoch.told.report && stepNote(st, 'macd').status !== 'done' && !opts.dry_run) {
    if (!cfg.macd_update) setStep(st, 'macd', 'done', 'not configured', now);
    else {
      const u = await deps.mac(['macd', cfg.peer, 'update'], 280000);
      await deps.sleep?.(8000);
      const p = await deps.sh('echo alive', 20);
      setStep(st, 'macd', u.code === 0 && p.ok ? 'done' : 'fail', u.code === 0 && p.ok ? 'macd updated and answering' : `macd update ${u.code === 0 ? 'ran but the laptop did not answer after' : 'failed'}: ${(u.stderr || u.stdout).trim().split('\n').at(-1) || p.err}`, now);
      out(`macd: ${stepNote(st, 'macd').status}: ${stepNote(st, 'macd').detail}`);
    }
  }
  if (stepNote(st, 'macd').status === 'done' && st.epoch.told.report) { st.epoch.complete = iso(now); out('every step is done for this arrival'); }

  // One message per stuck step, after the grace period.
  const stuck = Object.entries(st.epoch.steps).filter(([n, s]) => ['wait', 'fail'].includes(s.status) && now - Date.parse(s.since || st.epoch.started) >= cfg.blocked_tell_ms && !['report', 'macd'].includes(n));
  const key = stuck.map(([n, s]) => `${n}:${s.status}`).sort().join(',');
  if (stuck.length && key && st.epoch.told.blocked !== key && !opts.dry_run) {
    const t = await deps.tell(`Housesitter: the laptop has been online since ${hhmm(Date.parse(st.epoch.started))} and is not fully ready: ${stuck.map(([n, s]) => `${n} (${s.detail})`).join('; ')}. It keeps trying each minute; nothing is needed from Ari unless a step says so.`);
    if (t.ok) st.epoch.told.blocked = key;
  }
  if (!opts.dry_run) deps.writeState(st);
  return { action: st.epoch.complete ? 'complete' : 'working', state: st, steps: st.epoch.steps };
}

export function renderPass(r) {
  if (r.action === 'down' || r.action === 'hub-only') return `laptop: ${r.action === 'down' ? 'offline' : 'online in Hub, bus silent'}: ${r.why}\nwhen it arrives, in order:\n${(r.plan || []).map((p) => `  - ${p}`).join('\n')}`;
  if (r.action === 'idle') return 'laptop: up; this arrival is already complete';
  const rows = Object.entries(r.steps || {}).map(([n, s]) => `  ${s.status === 'done' ? '✓' : s.status === 'fail' ? '✗' : s.status === 'would' ? '·' : '…'} ${n}: ${s.detail}`);
  return `laptop: up (${r.action})\n${rows.join('\n')}`;
}

// ---------- the launchd agent ----------

export const LABEL = 'bot.ouro.housesitter.laptop-arrival';
export const EVERY_SEC = 60;
