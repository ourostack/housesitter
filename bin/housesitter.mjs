#!/usr/bin/env node
// housesitter: keep an always-on Mac that hosts your agents alive and drivable, hands-off, through a cheap IP-KVM.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, macConfig, secretStore, updateMac } from '../src/config.mjs';
import { adopt, defaultRefs, fakeDeps, hostIfconfig, realDeps } from '../src/adopt.mjs';
import { night, render } from '../src/demo.mjs';
import { buildDoctor, renderDoctor } from '../src/doctor.mjs';
import { renderEvening, replay } from '../src/evening.mjs';
import { glimpse as paintGlimpse, painter, beside } from '../src/paint.mjs';
import { Refusal, open } from '../src/hands.mjs';
import { connect, summarise } from '../src/kvmd.mjs';
import * as Peer from '../src/peer.mjs';
import * as Plugins from '../src/plugin-updates.mjs';
import { peerWatch, which } from '../src/peer-watch.mjs';
import * as Plug from '../src/plug.mjs';
import * as Watch from '../src/watch.mjs';
import * as O from '../src/outbox.mjs';
import os from 'node:os';
import { describeStatus, kvmHost, sitterClient, sshRunner } from '../src/sitter.mjs';
import * as Copilot from '../src/copilot-app.mjs';
import * as Beat from '../src/heartbeat.mjs';
import * as Disk from '../src/disk-prune.mjs';
import * as Load from '../src/load-shed.mjs';
import * as OsUp from '../src/os-update.mjs';
import * as Rec from '../src/recovery.mjs';
import * as Fleet from '../src/fleet.mjs';
import * as Apple from '../src/apple-account.mjs';
import * as Steer from '../src/steer.mjs';
import * as Hold from '../src/hold.mjs';
import * as Arrival from '../src/laptop-arrival.mjs';
import * as Deploy from '../src/deploy.mjs';
import { isCommand, parseCall, previewOf, refusalOf, runHelp } from '../src/cli-table.mjs';
import { quietPipes } from '../lib/ouro-ui/registry/ouro/ax/cli.ts';

quietPipes(process);
const kitIo = { stdout: process.stdout, stderr: process.stderr };

const sitterSsh = (mac) => sshRunner(mac.name, kvmHost(mac), { key: mac.kvm?.ssh_key || null });
const sitterDir = (mac) => mac.kvm?.sitter_home || '/etc/kvmd/user/housesitter';
const onSitter = (mac, args) => `${mac.kvm?.sitter_home ? `HOUSESITTER_HOME='${mac.kvm.sitter_home}' ` : ''}python3 ${sitterDir(mac)}/sitter.py ${args}`;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// ls and do check actions against hackamore's schema, the one dependency. Loaded only for them, so every other command
// runs from a clone that has not run `npm install`.
async function reinsLayer() {
  try { return await import('../src/reins.mjs'); } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND' || !/@ouro\.bot\/hackamore/.test(e.message)) throw e;
    throw new Refusal('action-failed', `ls and do need @ouro.bot/hackamore, which is not installed here. Run \`npm install\` in ${ROOT}, or run housesitter with \`npx github:ourostack/housesitter\`. Every other command works without it.`);
  }
}

// The kit parses every call (src/cli-table.mjs): `opt` is its flags, and `cmd`, `name` and `rest` are the command's words
// and then its arguments, in the order the table declares them.
const argv = process.argv.slice(2);
let opt = {};
let json = false;
let cmd, name, rest;
const say = (t) => { if (!json) console.log(t); };
const emit = (o) => console.log(JSON.stringify(o));

async function hands(mac) {
  return open(mac.name, { deps: { mac, sitter: sitterClient(mac) } });
}

async function kvmLook(mac) {
  const store = secretStore();
  const { client, endpoint } = await connect({ endpoints: mac.kvm.endpoints, pin: mac.kvm.tls_sha256, user: mac.kvm.user, password: () => store.get(mac.kvm.admin_password) || '' });
  const [info, hid, streamer] = await Promise.all([client.info(), client.hid().catch(() => null), client.streamer().catch(() => null)]);
  return { ...summarise({ info, hid, streamer }), via: `${endpoint.label || endpoint.url}${endpoint.fallback ? ' (fallback)' : ''}` };
}

function useColor() { return !opt.plain && !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === '1'); }

function showLook(l) {
  if (json) { emit(l); return 0; }
  const p = painter(useColor());
  const seen = l.prompt?.visible;
  const sees = l.reads_as === 'desktop' ? 'a desktop: a menu bar, top left' : l.reads_as === 'black' ? 'black: asleep, off, or no picture' : l.reads_as === 'none' ? `nothing (${l.why || 'no frame'})`
    : seen ? `the ${l.prompt.kind === 'boot' ? 'FileVault prompt it was taught at a boot' : 'lock screen it was taught'} (${Math.round(l.prompt.match * 100)}%)` : l.prompt?.taught ? 'no menu bar, and not the prompt it was taught' : 'no menu bar (no prompt taught yet)';
  const may = l.reads_as === 'desktop' ? ['never: a desktop'] : seen && l.prompt.kind === 'boot' ? ['yes, once its password is verified:', 'by itself after a boot, or when you ask'] : seen ? ['only when you ask, over SSH:', 'a lock screen is your lock'] : ['no: no password prompt it knows on the picture'];
  const right = ['', `${p.label('IT SEES  ')}${sees}`, ...may.map((m, i) => `${i ? '         ' : p.label('MAY TYPE ')}${seen ? p.fg([158, 206, 106], m) : m}`), ''];
  if (l.prompt && !l.prompt.taught) right.push(p.dim('teach it: housesitter learn-prompt <mac> --i-see-the-field [--filevault at FileVault]'));
  right.push(p.dim(l.from === 'kvm' ? `from the KVM${l.mode ? `, HDMI ${l.mode.join('×')}` : ''}` : `from ${l.from}`));
  right.push(p.dim('pressed nothing, typed nothing, changed nothing'));
  console.log(['', ...beside(paintGlimpse(p, opt.private ? null : l.glimpse, { title: 'what the KVM sees', note: opt.private ? 'picture hidden (--private)' : '' }).map((x) => `  ${x}`), right), ''].join('\n'));
  return 0;
}

async function watchKvm(mac) {
  const name = mac.name;
  const sp = Watch.statePath(name);
  const silentMin = Number(opt['silent-min']) || Watch.SILENT_MIN;
  const test = !!opt.test;
  if (opt.status) { const st = Watch.loadState(sp); json ? emit(st) : say(JSON.stringify(st, null, 2)); return 0; }
  const label = Watch.agentLabel(name);
  const agent = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const uid = process.getuid();
  if (opt.uninstall) {
    spawnSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
    if (fs.existsSync(agent)) fs.renameSync(agent, path.join(os.homedir(), '.Trash', `${label}.plist.${Date.now()}`));
    say(`stopped: ${name}'s KVM is no longer watched from this Mac`);
    return 0;
  }
  if (opt.install) {
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    fs.mkdirSync(path.join(os.homedir(), 'Library', 'Logs'), { recursive: true });
    const extra = [...(opt['silent-min'] ? ['--silent-min', String(silentMin)] : []), ...(test ? ['--test'] : [])];
    fs.writeFileSync(agent, Watch.plist({ name, node: Watch.stableNode(process.execPath), bin: Deploy.liveBin(fileURLToPath(import.meta.url)), args: extra }));
    spawnSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
    const r = spawnSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, agent], { encoding: 'utf8' });
    if (r.status !== 0) { say(`✗ launchctl bootstrap failed: ${String(r.stderr).trim()}`); return 1; }
    say(`✓ this Mac now checks ${name}'s KVM every minute (${label}); one message if it's silent for ${silentMin} min, one when it's back${test ? ' (TEST messages)' : ''}`);
    return 0;
  }
  const store = secretStore();
  const sh = sitterSsh(mac);
  const by = mac.watch?.by || os.hostname().replace(/\.local$/, '');
  const sshAsk = async (a) => {
    const r = await sh(onSitter(mac, `do watch_check '${JSON.stringify(a).replace(/'/g, "'\\''")}'`));
    const j = JSON.parse(String(r.stdout).trim().split('\n').at(-1) || '{}');
    if (!j.ok && /unknown op 'watch_check'/.test(j.result || '')) {
      // A sitter older than 0.2.4: its status still says whether it's looking; it just can't record the watch.
      const o = await sh(onSitter(mac, 'do status'));
      const k = JSON.parse(String(o.stdout).trim().split('\n').at(-1) || '{}');
      if (k.ok) return { status: k.result };
    }
    if (!j.ok) throw new Error(j.result || `ssh exit ${r.status}`);
    return j.result;
  };
  const routes = [{ via: 'ssh', ask: sshAsk }];
  if (mac.outbox?.gist) {
    const gh = O.gistClient({ token: () => (mac.outbox.token && store.get(mac.outbox.token)) || O.ghCliToken() });
    routes.push({ via: 'outbox', ask: Watch.outboxAsk({ readStatus: () => O.readStatus(name, mac.outbox, gh), beatMin: mac.outbox.beat_min ?? 10 }) });
  }
  const ask = Watch.askRoutes(routes);
  const n = mac.notify || {};
  const send = (title, body, { email }) => Watch.sendNtfy(n, title, body, { email, token: email ? store.get(n.token || defaultRefs(name).ntfy) : null });
  const tick = async () => {
    const out = await Watch.watchOnce({ name, by, notify: n, ask, send, state: Watch.loadState(sp), now: Date.now(), silentMin, test });
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(out.state, null, 2));
    const line = `${new Date().toISOString()} ${out.ok ? `ok via ${out.state.last_via || 'ssh'}` : `silent (${out.why})`}${out.said ? `; said ${out.said}: ${out.state.last_result}` : ''}`;
    json ? emit({ ok: out.ok, via: out.ok ? out.state.last_via || 'ssh' : null, said: out.said, why: out.why || null }) : say(line);
    return out;
  };
  if (opt.once) { await tick(); return 0; }
  for (;;) { await tick(); await new Promise((r) => setTimeout(r, 60000)); }
}

async function appleAccount() {
  need(name, 'housesitter apple-account <mac> [--now | --watch | --expect-reboot --why "<reason>" | --install-agent | --uninstall-agent | --status]');
  const bin = Deploy.liveBin(fileURLToPath(import.meta.url));
  if (opt.status) { const s = Apple.readStatus(); if (json) emit(s); else say(`marker: ${s.marker ? `${new Date(s.marker.at).toISOString()} ${s.marker.why}` : 'none'}\nstate: ${JSON.stringify(s.state)}\n${s.audit.map((a) => `${a.at} ${a.event}${a.why ? `: ${a.why}` : ''}`).join('\n') || 'no audit lines yet'}`); return 0; }
  if (opt['expect-reboot']) { const r = Apple.expectReboot({ why: opt.why }); say(`marked: a boot in the next ${Apple.MARKER_MAX_AGE_MS / 3600000} h is one Housesitter coordinated (${r.why}); the prompt after it is filled within ${Apple.WINDOW_MS / 60000} min of that boot`); return 0; }
  if (opt['uninstall-agent']) { const r = Apple.uninstallAgent(); say(`removed ${r.plist}`); return 0; }
  if (opt['install-agent']) {
    const r = await Apple.installAgent({ node: Watch.stableNode(process.execPath), bin, mac: name, env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() }, dry: !!opt['dry-run'] });
    if (json) emit(r); else say(r.dry_run ? `would write ${r.plist} and load it:\n${r.text}` : r.ok ? `installed ${r.plist} and loaded it (${Apple.LABEL}); it looks at Setup Assistant while it runs. Log: ${r.log}` : `✗ launchctl would not load it: ${r.error}`);
    return r.ok ? 0 : 1;
  }
  const agent = opt.agent || 'ouroboros';
  const ouro = opt.ouro || which('ouro');
  const tell = async (text) => {
    if (!ouro) return false;
    const r = spawnSync(ouro, ['msg', '--to', agent, text], { encoding: 'utf8', timeout: 60000 });
    return r.status === 0;
  };
  const hk = Copilot.realDeps({ hackamore: opt.hackamore }).hk;
  const deps = Apple.realDeps({ hk, tell });
  const out = (m) => console.log(`${new Date().toISOString()} apple-account: ${m}`);
  if (opt.watch) { await Apple.watch({ mac: name }, deps, out); return 0; }
  const r = await Apple.attempt({ mac: name, explicit: !!opt.now }, deps);
  if (json) emit(r); else say(`${r.status}${r.why ? `: ${r.why}` : ''}`);
  return ['filled', 'no-dialog', 'left-alone', 'waiting'].includes(r.status) ? 0 : 1;
}

async function holdCmd() {
  const quiet = !!opt.quiet;
  const dry = !!opt['dry-run'];
  const labels = loadConfig().launchd_disabled ?? null;
  if (labels !== null && !Array.isArray(labels)) throw new Refusal('input-invalid', `launchd_disabled in ${configPath()} must be a list of launchd labels`);
  // The installed job passes --quiet and stays silent; a person who runs it with no list is told where to add one.
  if (labels === null && !dry && !quiet) throw new Refusal('input-invalid', Hold.NO_LIST);
  const rows = labels ? Hold.holdDisabled(labels, { dry }) : [];
  const failed = rows.some((r) => r.error);
  const text = labels === null ? Hold.NO_LIST : Hold.acted(rows).length ? Hold.renderHold(rows) : Hold.ALL_OFF(rows.length);
  if (dry) {
    if (json) emit({ ok: !failed, dry_run: true, nothing_done: true, rows, message: `${text}\n${Hold.PREVIEW}` });
    else console.log(`${text}\n${Hold.PREVIEW}`);
    return failed ? 1 : 0;
  }
  if (json) emit({ ok: !failed, rows });
  else if (Hold.acted(rows).length) say(text);
  else if (labels !== null && !quiet) say(text);
  return failed ? 1 : 0;
}

async function steerCmd() {
  const deps = Steer.realSteerDeps();
  const bin = Deploy.liveBin(fileURLToPath(import.meta.url));
  if (!!opt.install || !!opt.uninstall) {
    const a = Rec.AGENTS.steer;
    const r = opt.uninstall ? await Rec.uninstallAgent({ label: a.label }) : await Rec.installAgent({ label: a.label, program: [Watch.stableNode(process.execPath), bin, ...a.args], env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() }, every: a.every, logName: a.logName, dry: !!opt['dry-run'] });
    if (json) emit(r); else say(opt.uninstall ? `removed ${r.plist}` : r.dry_run ? `would write ${r.plist} and load it` : r.ok ? `installed ${r.plist} and loaded it (${a.label})` : `✗ launchctl would not load it: ${r.error}`);
    return r.ok ? 0 : 1;
  }
  const r = await Steer.pass({ repair: !!opt.repair, sessions: !opt['no-sessions'], peer: opt.peer }, deps, (l) => { if (!json && !opt.quiet) console.log(l); });
  const ok = r.bad.length === 0;
  if (json) emit({ ok, problems: r.bad.map((b) => b.code), ...r.facts, repaired: r.repaired });
  else if (!opt.quiet || !ok) {
    say(Steer.renderFacts(r.facts, r.bad));
    if (r.facts.peer) say(`peer         ${r.facts.peer.name}: ${r.facts.peer.online ? `online, ${r.facts.peer.activeSessionCount} active sessions` : 'OFFLINE or not listed'}`);
    if (!!opt.list && r.facts.sessions) for (const s of r.facts.sessions.rows) say(`  ${s.id.slice(0, 8)}  ${String(s.status).padEnd(9)} ${String(s.detail || '').padEnd(22).slice(0, 22)} ${String(s.title || '').slice(0, 70)}`);
  }
  return ok ? 0 : 1;
}

async function laptopArrival() {
  const file = path.resolve(opt.config || path.join(os.homedir(), '.config', 'housesitter', 'laptop-arrival.json'));
  const bin = Deploy.liveBin(fileURLToPath(import.meta.url));
  if (!!opt.install || !!opt.uninstall) {
    const args = ['laptop-arrival', '--config', file, '--quiet'];
    const r = opt.uninstall ? await Rec.uninstallAgent({ label: Arrival.LABEL }) : await Rec.installAgent({ label: Arrival.LABEL, program: [Watch.stableNode(process.execPath), bin, ...args], env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() }, every: Arrival.EVERY_SEC, logName: 'housesitter-laptop-arrival.launchd.log', dry: !!opt['dry-run'] });
    if (json) emit(r); else say(opt.uninstall ? `removed ${r.plist}` : r.dry_run ? `would write ${r.plist} and load it` : r.ok ? `installed ${r.plist} and loaded it (${Arrival.LABEL}); every minute it checks whether the laptop is back, with no model turns` : `✗ launchctl would not load it: ${r.error}`);
    return r.ok ? 0 : 1;
  }
  let cfg;
  try { cfg = Arrival.loadConfig(file); } catch (e) {
    if (!opt['dry-run'] || !/no config/.test(e.message)) throw e;
    const line = `laptop-arrival: dry run; nothing was done. There is no config at ${file}, so there is nothing to check. Without --dry-run this brings a returning Mac up to date and tells the agent once; the agent is the one who sees it.`;
    if (json) emit({ ok: true, dry_run: true, nothing_done: true, message: line }); else console.log(line);
    return 0;
  }
  const deps = Arrival.realArrivalDeps(cfg);
  deps.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (opt.status) { const st = deps.readState(); json ? emit(st) : say(JSON.stringify(st, null, 2)); return 0; }
  const r = await Arrival.pass({ cfg, dry_run: !!opt['dry-run'] }, deps, (l) => { if (!json && !opt.quiet && !opt['dry-run']) console.log(l); });
  if (json) emit({ action: r.action, why: r.why || null, steps: r.steps || null }); else if (!opt.quiet || !!opt['dry-run']) say(Arrival.renderPass(r));
  return r.steps && Object.values(r.steps).some((s) => s.status === 'fail') ? 1 : 0;
}

async function restartCopilot() {
  const sec = (f, d) => (opt[f] == null ? d : Number(opt[f]) * 1000);
  const app = opt.app || Copilot.DEFAULT_APP;
  const opts = {
    app, why: opt.why, also: opt.also ?? [], skip: opt.skip ?? [], resume: !!opt.resume, sigterm: !!opt.sigterm, dry_run: !!opt['dry-run'], open_at_login: !!opt['open-at-login'],
    stand_in: app !== Copilot.DEFAULT_APP && !opt['copilot-home'],
    t: { settle: sec('settle', Copilot.T.settle), settleMax: sec('settle-max', Copilot.T.settleMax), grace: sec('grace', Copilot.T.grace), person: sec('person-wait', Copilot.T.person) },
  };
  if (opts.skip.some((id) => id.length < 8)) throw new Refusal('input-invalid', '--skip takes a session id or its first 8 characters or more');
  if ([opts.t.settle, opts.t.settleMax, opts.t.grace, opts.t.person].some((n) => !Number.isFinite(n) || n < 0)) throw new Refusal('input-invalid', '--settle, --settle-max, --grace and --person-wait take a number of seconds');
  const stateDir = Copilot.stateDir();
  if (opt.status) {
    const s = Copilot.readState(stateDir);
    const rec = Rec.readRecovery(stateDir);
    const load = Load.readLoad(stateDir);
    if (json) emit({ ...s, recovery: rec, load_shed: load }); else say(`${Copilot.renderState(s)}\n${Rec.renderRecovery(rec)}\n${Load.renderLoad(load.last, load.ledger)}`);
    return 0; // read-only: the exit code says the status was read; a failed restart is in the text and in --json (state, failed)
  }
  if (!!opt['install-recovery'] || !!opt['uninstall-recovery']) {
    const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() };
    const node = Watch.stableNode(process.execPath), bin = Deploy.liveBin(fileURLToPath(import.meta.url));
    const rs = [];
    for (const a of Object.values(Rec.AGENTS)) rs.push(opt['uninstall-recovery'] ? await Rec.uninstallAgent({ label: a.label }) : await Rec.installAgent({ label: a.label, program: [node, bin, ...a.args], env, every: a.every, logName: a.logName, dry: !!opt['dry-run'] }));
    const retired = await Rec.retireAgents({ dry: !!opt['dry-run'] });
    // The Apple Account prompt after a coordinated reboot is filled by its own agent; it is part of the same setup.
    if (!opt['uninstall-recovery'] && opt.mac) { const r = await Apple.installAgent({ node, bin, mac: opt.mac, env, dry: !!opt['dry-run'] }); rs.push({ ...r, ok: r.ok, label: Apple.LABEL }); }
    if (!opt['uninstall-recovery']) rs.push(await Rec.installAgent({ ...Rec.KEEP_AWAKE, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() }, dry: !!opt['dry-run'] }));
    if (json) emit({ agents: rs, retired }); else {
      for (const r of retired) say(r.dry_run ? `would unload and remove ${r.plist}: retired (the health watch is Shepherd's now)` : `retired ${r.label}: unloaded and removed ${r.plist}`);
      for (const r of rs) say(opt['uninstall-recovery'] ? `removed ${r.plist}` : r.dry_run ? `would write ${r.plist} and load it` : r.ok ? `installed ${r.plist} and loaded it (${r.label})` : `✗ ${r.label}: launchctl would not load it: ${r.error}`);
    }
    return rs.every((r) => r.ok) ? 0 : 1;
  }
  if (opt['load-shed']) {
    const r = await Load.pass(opts, Load.realLoadDeps({ state: stateDir, cfgLoad: () => loadConfig() }), (l) => { if (!json && !opt.quiet) console.log(l); });
    if (json) emit(r); else if (!opt.quiet && opts.dry_run) say(`load shed: ${r.action} (load ${r.load1} on ${r.cores} cores, limit ${r.limit}; ${r.reniced.length} would be reniced)`);
    return 0;
  }
  if (opt['disk-prune']) {
    const floor = opt['floor-gib'] == null ? undefined : Number(opt['floor-gib']) * 1073741824;
    const r = await Disk.pass({ ...opts, force: !!opt.now, t: floor == null ? undefined : { floor } }, Disk.realDiskDeps({ copilotHome: opt['copilot-home'] || undefined, state: stateDir }), (l) => { if (!json && !opt.quiet) console.log(l); });
    if (json) emit(r); else if (!opt.quiet) say(`disk prune: ${r.action}${r.after != null ? ` (${Disk.gib(r.before)} -> ${Disk.gib(r.after)} free)` : ` (${Disk.gib(r.free)} free)`}`);
    return 0;
  }
  if (opt['os-updates']) {
    const od = OsUp.realOsDeps({ copilotHome: opt['copilot-home'] || undefined, hackamore: opt.hackamore, state: stateDir, bin: Deploy.liveBin(fileURLToPath(import.meta.url)), mac: opt.mac || 'mini', listing: opt.listing ? path.resolve(opt.listing) : null });
    od.status = (o) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'status.json'), JSON.stringify(o)); };
    const w = (opt.window || '').match(/^(\d+)-(\d+)$/);
    const r = await OsUp.pass({ ...opts, force: !!opt.now, os: w ? { windowStart: Number(w[1]), windowEnd: Number(w[2]) } : {} }, od, (l) => { if (!json) console.log(l); });
    if (json) emit({ decision: r.decision, update: r.update || null, ok: r.report ? r.report.ok : null }); else if (!opt.quiet) say(OsUp.renderPass(r));
    return r.report && !r.report.ok ? 1 : 0;
  }
  if (opt.heartbeat) {
    const hd = Beat.realHeartbeatDeps({ copilotHome: opt['copilot-home'] || undefined, hackamore: opt.hackamore, state: stateDir, bin: Deploy.liveBin(fileURLToPath(import.meta.url)) });
    const r = await Beat.pass(opts, hd, (l) => { if (!json) console.log(l); });
    if (json) emit({ action: r.action, socket: r.socket, window: r.window, failures: r.failures, evidence: r.evidence || null }); else if (!opt.quiet) say(Beat.renderPass(r));
    return ['capped'].includes(r.action) || r.ok === false ? 1 : 0;
  }
  if (!!opt['install-plugin-updates'] || !!opt['uninstall-plugin-updates']) {
    const r = !!opt['uninstall-plugin-updates']
      ? await Plugins.uninstallPluginAgent({})
      : await Plugins.installPluginAgent({ node: Watch.stableNode(process.execPath), bin: Deploy.liveBin(fileURLToPath(import.meta.url)), env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() }, dry: !!opt['dry-run'] });
    if (json) emit(r); else say(opt['uninstall-plugin-updates'] ? `removed ${r.plist}` : r.dry_run ? `would write ${r.plist} and load it:\n${r.text}` : r.ok ? `installed ${r.plist} and loaded it (${Plugins.PLUGIN_LABEL}); every ${Plugins.EVERY_SEC / 60} min it restarts the app, with its sessions saved and resumed, when a plugin it loaded has a newer release. Decisions: ${path.join(stateDir, 'plugin-updates.log')}` : `✗ launchctl would not load it: ${r.error}`);
    return r.ok ? 0 : 1;
  }
  if (opt['plugin-updates']) {
    const pd = Plugins.realPluginDeps({ copilotHome: opt['copilot-home'] || undefined, hackamore: opt.hackamore, state: stateDir, bin: Deploy.liveBin(fileURLToPath(import.meta.url)) });
    const r = await Plugins.pass({ ...opts, cooldown_ms: opt['cooldown-hours'] == null ? undefined : Number(opt['cooldown-hours']) * 3600000 }, pd, !!opt.quiet || json || opts.dry_run ? () => {} : (l) => console.log(l));
    if (json) emit(r); else if (opts.dry_run) say(Plugins.renderPass(r));
    return r.decision.action === 'restart' && !r.restarted && !opts.dry_run ? 1 : 0;
  }
  if (opt['install-keeper']) {
    const d = Copilot.realDeps({ copilotHome: opt['copilot-home'] || undefined, state: stateDir });
    const before = async () => { const g = await Copilot.appGeneration(opts, d).catch(() => ({})); if (g.key) d.generation.set(g.key, 'install-keeper'); };
    const r = await Copilot.installKeeper({ node: Watch.stableNode(process.execPath), bin: Deploy.liveBin(fileURLToPath(import.meta.url)), env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() }, dry: !!opt['dry-run'], before });
    if (json) emit(r); else say(r.dry_run ? `would write ${r.plist} and load it:\n${r.text}` : r.ok ? `installed ${r.plist} and loaded it (${Copilot.KEEPER_LABEL}); it resumes sessions after every app start from now on (the app that is up now is not resumed). Log: ${r.log}` : `✗ launchctl would not load it: ${r.error}`);
    return r.ok ? 0 : 1;
  }
  if (opt['resume-only']) {
    const out = (m) => console.log(`${new Date().toISOString()} copilot-resume: ${m}`);
    const deps0 = Copilot.realDeps({ copilotHome: opt['copilot-home'] || undefined, state: stateDir, warn: out });
    if (opt.watch) { await Copilot.watch(opts, deps0, out); return 0; }
    const r = await Copilot.resumeOnly(opts, deps0, json ? () => {} : out);
    if (json) emit(r); else if (r.dry_run) say(`DRY RUN: would resume ${r.resume.length}: ${r.resume.map((x) => `${x.id.slice(0, 8)} ${x.title || ''}`.trim()).join('; ') || 'none'}`);
    return r.ok ? 0 : 1;
  }
  const deps = Copilot.realDeps({ copilotHome: opt['copilot-home'] || undefined, hackamore: opt.hackamore, state: stateDir });
  deps.status = (o) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'status.json'), JSON.stringify(o)); };
  deps.tell = Rec.realTell({ state: stateDir });
  // After the real app is back, make sure Agency Hub still tracks its sessions (a rehearsal on another app leaves Hub alone).
  if (!opt.app) deps.steering = async () => {
    const r = await Steer.pass({ repair: true, sessions: false, immediate: true }, Steer.realSteerDeps({ copilotHome: opt['copilot-home'] || undefined, state: stateDir }));
    return { ok: r.bad.length === 0, why: r.bad.map((b) => b.code).join(', '), repaired: r.repaired };
  };
  if (opt['dry-run']) {
    const p = await Copilot.plan(opts, deps).catch((e) => {
      // No app database here, so no sessions to plan for: say so, and exit 0 as a preview does.
      if (/database|no app called/.test(e.message)) return { no_database: e.message.split('. Fix:')[0] };
      throw e;
    });
    if (p.no_database) {
      const line = `restart-copilot: dry run; nothing was done. ${p.no_database}, so there are no sessions to plan for. Without --dry-run this would restart the app and resume the sessions it was working on, which the people using those sessions see.`;
      if (json) emit({ ok: true, dry_run: true, nothing_done: true, message: line }); else console.log(line);
      return 0;
    }
    if (json) emit({ dry_run: true, ...p }); else say(Copilot.render({ dry_run: true, ...p }));
    return p.quit.method === 'unavailable' ? 1 : 0;
  }
  const busy = Copilot.runInProgress(stateDir);
  if (busy) throw new Refusal('action-unavailable', `a restart is already running (step "${busy.step}", started ${busy.started}); read it with housesitter restart-copilot --status, and start another when it has finished`);
  if (opt.detach) {
    const keep = Object.entries(opt).flatMap(([k, v]) => (['detach', 'hackamore', 'json'].includes(k) || v === false || v == null ? [] : v === true ? [`--${k}`] : [v].flat().flatMap((x) => [`--${k}`, String(x)])));
    const hk = deps.hackamore ? ['--hackamore', JSON.stringify(deps.hackamore)] : [];
    const r = await Copilot.detach({ node: Watch.stableNode(process.execPath), bin: Deploy.liveBin(fileURLToPath(import.meta.url)), args: ['restart-copilot', ...keep, ...hk], env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() } });
    if (json) emit(r); else say(r.ok ? `started as a launchd job (${Copilot.LABEL}); it does not depend on this session. Log: ${r.log}\nRead the result with: housesitter restart-copilot --status` : `✗ launchctl would not start it: ${r.error}`);
    return r.ok ? 0 : 1;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const log = (m) => console.log(`${new Date().toISOString()} restart-copilot: ${m}`);
  const report = await Copilot.restart(opts, deps, log);
  fs.writeFileSync(path.join(stateDir, 'last.json'), JSON.stringify(report, null, 2));
  if (json) emit(report);
  return report.ok ? 0 : 1;
}

function need(n, usage) { if (!n) throw new Refusal('input-invalid', `usage: ${usage}`); }
// The Mac a peer link or a return names must be one the config knows, so a wrong name never acts for another Mac.
function requireMac(n) {
  const known = Object.keys(loadConfig().macs || {});
  if (known.includes(n)) return n;
  throw new Refusal('input-invalid', `no Mac called "${n}" in ${configPath()}. Fix: ${known.length ? `name one of the Macs in the config: ${known.join(', ')}` : 'add it first: housesitter adopt <mac> --address <ip>'}.`);
}

async function main() {
  if (argv.includes('--version')) { console.log(VERSION); return 0; }
  // Help, `help --json`, and an unknown command are the kit's (src/cli-table.mjs); every command word runs below.
  if (!isCommand(argv)) {
    const code = await runHelp(argv, kitIo);
    // process.exit below would cut a piped stdout short, so wait for what the kit wrote.
    await new Promise((done) => process.stdout.write('', done));
    return code;
  }
  // The kit checks the call first: its words, its flags, and the --why an acting command needs.
  const refused = await refusalOf(argv, kitIo);
  if (refused) { await new Promise((done) => process.stdout.write('', done)); return refused.exit; }
  const call = parseCall(argv);
  opt = call.input;
  json = call.json;
  const words = call.command.name.split(' ');
  [cmd, name, ...rest] = [...words, ...(call.command.args ?? []).flatMap((a) => (opt[a.name] == null ? [] : [opt[a.name]]))];
  if (cmd === 'version') { if (json) emit({ version: VERSION }); else console.log(VERSION); return 0; }
  const previewed = cmd === 'deploy' && name ? null : previewOf(argv);
  if (previewed) {
    if (json) emit({ ok: true, dry_run: true, nothing_done: true, message: previewed }); else console.log(previewed);
    return 0;
  }

  if (cmd === 'demo' && name !== 'night') {
    const steps = replay();
    if (json) { emit({ replay: '2026-11-08', steps: steps.map(({ lum, glimpse, ...s }) => s) }); return 0; }
    const blocks = renderEvening(steps, { color: useColor() });
    const slow = process.stdout.isTTY && !opt.fast;
    for (const b of blocks) { console.log(b.join('\n')); if (slow) await new Promise((r) => setTimeout(r, 1400)); }
    return 0;
  }

  if (cmd === 'demo') {
    const r = await night();
    if (json) emit({ rehearsal: true, lines: r.lines, incidents: r.incidents }); else console.log(render(r, { color: useColor() }));
    return 0;
  }

  if (cmd === 'fleet') {
    let beats;
    try {
      beats = opt.from ? Fleet.beatsFromGist(JSON.parse(fs.readFileSync(path.resolve(opt.from), 'utf8'))) : await Fleet.readFleet();
    } catch (e) {
      throw new Refusal('action-failed', `could not read the fleet's health records: ${e.message}. Check that gh is signed in (gh auth status) and HOUSESITTER_FLEET_GIST names the gist, or read a saved copy with housesitter fleet --from <gist.json>`);
    }
    const num = (f) => (opt[f] == null ? undefined : Number(opt[f]));
    const rows = Fleet.fleetRows(beats, { staleMin: num('stale-min'), diskFloorGb: num('disk-floor-gb'), alwaysOn: opt['always-on'] ? opt['always-on'].split(',') : [] });
    if (json) emit({ rows }); else console.log(Fleet.renderFleet(rows).join('\n'));
    return rows.every((r) => r.healthy) ? 0 : 1;
  }

  if (cmd === 'tailnet-policy') {
    const policy = fs.readFileSync(path.join(ROOT, 'docs', 'tailnet-policy.hujson'), 'utf8');
    if (json) emit({ policy }); else console.log(policy);
    return 0;
  }

  if (cmd === 'look' && opt.picture) {
    // What the sitter would make of a saved picture: the same code as on the KVM, run here (needs python3 and ffmpeg).
    const r = spawnSync('python3', [path.join(ROOT, 'device', 'sitter.py'), 'look', '--from', path.resolve(opt.picture)], { encoding: 'utf8', env: { ...process.env, HOUSESITTER_HOME: opt.home || path.join(path.dirname(configPath()), 'look') } });
    if (r.status !== 0) { say(`✗ ${String(r.stderr || '').trim() || 'python3 or ffmpeg missing?'}`); return 1; }
    return showLook(JSON.parse(r.stdout));
  }

  if (cmd === 'doctor' && !name) {
    const cfg = loadConfig();
    const store = secretStore();
    const lines = [`node ${process.version}${Number(process.versions.node.split('.')[0]) >= 20 ? ' ✓' : ' ✗ (needs 20+)'}`, `config ${configPath()}${fs.existsSync(configPath()) ? '' : ' (none yet: housesitter adopt makes it)'}`];
    for (const [n, m] of Object.entries(cfg.macs || {})) {
      const refs = [['KVM admin password', m.kvm?.admin_password], ['Mac password', m.mac_password], ['outbox token', m.outbox?.token]].filter(([, r]) => r);
      lines.push(`${n}: ${m.kvm?.endpoints?.length || 0} endpoint(s)${m.kvm?.tls_sha256 ? ', pinned' : ', NOT pinned'}; ${refs.map(([l, r]) => `${l} ${store.has(r) ? '✓' : '✗'}`).join(', ') || 'no secrets referenced'}; power ${m.power?.kind || 'none'}; notify ${m.notify?.kind || 'none'}`);
    }
    if (json) emit({ lines }); else console.log(lines.join('\n'));
    return 0;
  }

  if (cmd === 'adopt') {
    need(name, 'housesitter adopt <mac> [--address <ip>] [--notify ntfy|<url>] [--watched-by <url>] [--outbox] [--this-mac] [--dry-run] [--fake]');
    const fake = opt.fake ? fakeDeps({ apiClosed: !opt['api-open'] }) : null;
    const store = secretStore();
    let mac;
    try { mac = macConfig(name); } catch { mac = { name, kvm: { endpoints: [] } }; }
    const x = {
      name, mac, refs: { ...defaultRefs(name), ...(mac.kvm?.admin_password ? { admin: mac.kvm.admin_password } : {}) }, address: opt.address || (fake ? null : mac.kvm?.endpoints?.find((e) => e.fallback)?.url?.replace(/^https:\/\//, '') || null),
      dryRun: !!opt['dry-run'], outbox: !!opt.outbox, notify: opt.notify, email: opt.email, watchedBy: opt['watched-by'], heartbeat: opt.heartbeat, location: opt.location, expectFingerprint: opt.fingerprint, macIfconfig: opt['this-mac'] ? hostIfconfig() : '', say,
      deps: fake ? fake.deps : realDeps(name, { secrets: store, saveMac: (fn) => updateMac(name, fn) }), configFile: configPath(),
    };
    if (fake) x.mac = { name, kvm: { endpoints: [] }, user_names: ['Ada'] };
    say(`${fake ? 'REHEARSAL (a pretend KVM; nothing leaves this computer): ' : ''}adopting the KVM for ${name}${x.dryRun ? ' (dry run: nothing changes)' : ''}\n`);
    const results = await adopt(x);
    if (json) emit({ name, fake: Boolean(fake), results });
    return results.some((r) => !r.ok && !r.decision) ? 1 : 0;
  }

  if (cmd === 'secret') {
    const which = rest[0];
    need(name && ['mac-password', 'kvm-admin', 'outbox-token', 'ntfy-token', 'apple-account'].includes(which), 'housesitter secret <mac> <mac-password|kvm-admin|outbox-token|ntfy-token|apple-account>  (reads the value from stdin)');
    const refs = defaultRefs(name);
    let m = {};
    try { m = macConfig(name); } catch { /* new */ }
    const ref = { 'mac-password': m.mac_password || refs.mac, 'kvm-admin': m.kvm?.admin_password || refs.admin, 'outbox-token': m.outbox?.token || refs.outbox, 'ntfy-token': m.notify?.token || refs.ntfy, 'apple-account': Apple.appleRef(name) }[which];
    if (process.stdin.isTTY) { process.stderr.write(`${which} for ${name} (input hidden), then Return: `); spawnStty('-echo'); }
    const value = await new Promise((res) => { let b = ''; process.stdin.on('data', (d) => { b += d; if (process.stdin.isTTY && b.includes('\n')) { process.stdin.pause(); res(b); } }); process.stdin.on('end', () => res(b)); });
    if (process.stdin.isTTY) { spawnStty('echo'); process.stderr.write('\n'); }
    secretStore().set(ref, value.replace(/\r?\n$/, ''));
    updateMac(name, (c) => { if (which === 'mac-password') c.mac_password = ref; if (which === 'kvm-admin') { c.kvm = c.kvm || {}; c.kvm.admin_password = ref; } if (which === 'outbox-token' && c.outbox) c.outbox.token = ref; if (which === 'ntfy-token' && c.notify) c.notify.token = ref; if (which === 'apple-account') c.apple_account = ref; });
    if (which === 'apple-account') { const r = Apple.installRule(name); say(`hackamore may now type it only into Setup Assistant's iCloud password pane (${r.file}${r.changed ? '' : ', already set'})`); }
    say(`stored at ${ref}${which === 'mac-password' || which === 'ntfy-token' ? `; run housesitter adopt ${name} to put it on the sitter` : ''}`);
    return 0;
  }

  if (cmd === 'deploy') {
    need(name, 'housesitter deploy <housesitter|shepherd> [--ref <tag|branch|sha>] [--clone <dir>] [--dry-run] [--json] --why "<who asked, and what they said>"');
    const r = await Deploy.deploy({ name, ref: opt.ref, clone: opt.clone, why: opt.why, dry: !!opt['dry-run'] });
    if (json) emit(r); else say(Deploy.renderDeploy(r));
    return r.ok ? 0 : 1;
  }
  if (cmd === 'apple-account') return appleAccount();
  if (cmd === 'peer' && ['flush', 'watch'].includes(name)) requireMac(rest[0]);
  if (cmd === 'peer') return peerCmd();
  if (cmd === 'restart-copilot') return restartCopilot();
  if (cmd === 'steer') return steerCmd();
  if (cmd === 'hold') return holdCmd();
  // The returning Mac is the `peer` in laptop-arrival.json; it has no KVM, so config.json need not list it.
  if (cmd === 'laptop-arrival') return laptopArrival();

  need(name, `housesitter ${cmd} <mac>`);
  const mac = macConfig(name);

  if (cmd === 'watch-kvm') return watchKvm(mac);

  if (cmd === 'status' || cmd === 'doctor') {
    const [kvm, sit] = await Promise.all([kvmLook(mac).catch((e) => ({ error: e.message })), sitterClient(mac).status().catch((e) => ({ errors: [e.message] }))]);
    if (json) { emit({ name, kvm, sitter: sit.status, sitter_via: sit.via }); return 0; }
    if (opt.plain) {
      console.log(kvm.error ? `KVM: not reached (${kvm.error})` : `KVM via ${kvm.via}: ${kvm.model || 'kvmd'}; video ${kvm.video.online ? `on, ${kvm.video.resolution}` : 'no signal'}; keyboard ${kvm.hid.keyboard_online ? 'online' : 'offline'}`);
      console.log(sit.status ? `${describeStatus(name, sit.status)}\n  via ${sit.via}` : `sitter: no status (${(sit.errors || []).join('; ') || 'no route'})`);
      return 0;
    }
    const model = buildDoctor({ name, mac, kvm, sit });
    console.log(renderDoctor(model, { color: useColor(), hidePicture: !!opt.private }));
    return cmd === 'doctor' && (kvm.error || !sit.status) ? 3 : 0;
  }

  if (cmd === 'look') {
    const r = await sitterSsh(mac)(onSitter(mac, 'look'));
    if (r.status !== 0) { say(`✗ ${String(r.stderr || r.stdout).trim() || 'could not reach the KVM over SSH'}`); return 1; }
    return showLook(JSON.parse(String(r.stdout).trim().split('\n').at(-1)));
  }

  if (cmd === 'proof') return proof(mac);

  if (cmd === 'forget') {
    if (!opt.yes) { say(`This wipes the Mac's password, the KVM's admin password and the outbox token from ${name}'s KVM and stops the sitter. Run again with --yes.`); return 2; }
    const sh = sitterSsh(mac);
    const r = await sh(`python3 /etc/kvmd/user/housesitter/sitter.py forget && (systemctl disable --now housesitter 2>/dev/null || /etc/init.d/S99housesitter stop; true)`);
    say(r.status === 0 ? `forgot: ${String(r.stdout).trim()}; the sitter is stopped. Your Keychain items are untouched (security delete-generic-password -s housesitter …).` : `could not reach the KVM over SSH: ${String(r.stderr).trim()}`);
    return r.status === 0 ? 0 : 1;
  }

  if (cmd === 'unlock' && (!!opt.trial || !!opt.hold)) {
    // Arming the one supervised try is an operator act over SSH, never through the GitHub outbox.
    const r = await sitterSsh(mac)(`python3 /etc/kvmd/user/housesitter/sitter.py ${opt.trial ? 'password-trial' : 'password-hold'}`);
    if (r.status !== 0) { say(`✗ ${String(r.stderr || r.stdout).trim() || 'could not reach the KVM over SSH'}`); return 1; }
    say(!!opt.trial
      ? `armed one supervised try. Restart the Mac now and watch: housesitter proof ${name} --record ./proof. The sitter types once, only where it sees the password field; if the desktop follows within 2 minutes the password is verified, otherwise it goes back to unverified and types nothing more.`
      : 'held: the password is unverified again, and nothing is typed until you arm a trial.');
    return 0;
  }

  if (cmd === 'alert-test') {
    // An operator act over SSH, never through the GitHub outbox: the sitter sends one real stuck message, marked TEST.
    const r = await sitterSsh(mac)(onSitter(mac, `alert-test${opt.again ? ' --again' : ''}`));
    let j = {};
    try { j = JSON.parse(String(r.stdout).trim().split('\n').at(-1)); } catch { j = { ok: false, result: String(r.stderr || r.stdout).trim().slice(0, 200) || 'could not reach the KVM over SSH' }; }
    if (json) emit(j); else say(j.ok ? `✓ sent through ${mac.notify?.kind || 'the notify channel'}: ${j.result}\n  title: ${j.sent?.title}\n  body:  ${String(j.sent?.body || '').replace(/\n/g, ' / ')}` : `✗ ${j.result}`);
    return j.ok ? 0 : 1;
  }

  if (cmd === 'learn-prompt') {
    if (!opt['i-see-the-field']) { say(`Teach the sitter ${name}'s password prompt only while you can see the FileVault or login password field (or, with --grid, the login window's list of users) on the KVM's own picture (housesitter screenshot ${name}). Then run again with --i-see-the-field.`); return 2; }
    let grid = '';
    if (!!opt.grid && !!opt.filevault) { say('--grid and --filevault are two different lessons: a list of users is only ever clicked, never typed into. Teach each on its own.'); return 2; }
    if (opt.grid) {
      const [gx, gy] = [Number(rest[0]), Number(rest[1])];
      if (!(gx > 0 && gx < 1 && gy > 0 && gy < 1)) { say('--grid needs your account tile as two fractions of the screen, like --grid 0.48 0.87 (x then y, from housesitter screenshot)'); return 2; }
      grid = ` --grid ${gx} ${gy}`;
    }
    const r = await sitterSsh(mac)(onSitter(mac, `learn-prompt${opt.filevault ? ' --filevault' : ''}${grid} taught over SSH by an operator who saw the screen`));
    say(r.status === 0 ? `learned: ${String(r.stdout).trim()}. The sitter types only where a frame matches this.` : `✗ ${String(r.stderr || r.stdout).trim()}`);
    return r.status === 0 ? 0 : r.status === 2 ? 2 : 1;
  }

  if (cmd === 'want-desktop') {
    const r = await sitterClient(mac).op('want_desktop', { minutes: Number(opt.minutes) || 10 });
    if (json) emit(r); else say(`${r.ok ? '✓' : `✗ ${r.code}`} want-desktop: ${typeof r.result === 'string' ? r.result : `${r.result?.unlock || ''}${r.result?.minutes ? ` (the request stands for ${r.result.minutes} min)` : ''}`}${r.via ? `\n  via ${r.via}` : ''}`);
    return r.ok ? 0 : r.code === 'action-unavailable' || r.code === 'input-invalid' ? 2 : 1;
  }

  if (cmd === 'plug') return plugCmd(mac);

  if (['unlock', 'power-cycle', 'power-on'].includes(cmd)) {
    const opArgs = opt.attended ? { attended: true } : cmd === 'unlock' && opt['attended-test'] ? { attended_test: true } : {};
    if (opArgs.attended_test && !sitterClient(mac).routes.some((x) => x.via.startsWith('ssh'))) { say('✗ attended tests run over SSH only, and there is no SSH route to this KVM'); return 2; }
    const r = await sitterClient(mac).op(cmd.replace('-', '_'), opArgs);
    if (json) emit(r); else say(`${r.ok ? '✓' : `✗ ${r.code}`} ${cmd}: ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}${r.via ? `\n  via ${r.via}` : ''}`);
    return r.ok ? 0 : r.code === 'action-unavailable' || r.code === 'input-invalid' ? 2 : 1;
  }

  if (cmd === 'ls' || cmd === 'do') {
    const R = await reinsLayer();
    const [kvm, sit] = await Promise.all([kvmLook(mac).catch(() => null), sitterClient(mac).status().catch(() => ({}))]);
    const scr = R.screen(name, { kvm, sitter: sit.status, via: { kvm: kvm?.via || null, sitter: sit.via || null } });
    if (cmd === 'ls') { console.log(JSON.stringify(scr, null, json ? 0 : 2)); return 0; }
    const action = rest[0];
    const input = rest[1] ? JSON.parse(rest[1]) : {};
    const out = await R.run(name, action, input, { scr, hands: () => hands(mac), sitter: sitterClient(mac) });
    if (out.result?.type === 'image') out.result = { ...out.result, source: { ...out.result.source, data: `<${out.result.source.data.length} base64 characters>` }, file: saveShot(name, Buffer.from(out.result.source.data, 'base64')) };
    emit(out);
    return 0;
  }

  const h = await hands(mac);
  if (cmd === 'screenshot') {
    const s = await h.screenshot({ maxWidth: Number(opt['max-width']) || undefined });
    const f = opt.out || saveShot(name, s.image);
    if (opt.out) fs.writeFileSync(f, s.image);
    if (json) emit({ file: f, width: s.width, height: s.height, real: s.real, via: s.via }); else say(`${f}  ${s.width}x${s.height} (the Mac drives ${s.real.width}x${s.real.height}) via ${s.via}`);
    return 0;
  }
  if (cmd === 'click') { const r = await h.click(Number(rest[0]), Number(rest[1]), { button: opt.right ? 'right' : 'left', double: !!opt.double }); json ? emit(r) : say(`clicked via ${r.via}`); return 0; }
  if (cmd === 'type') { const r = await h.type(rest.join(' ')); json ? emit(r) : say(`typed via ${r.via}`); return 0; }
  if (cmd === 'key') { const r = await h.key(rest[0]); json ? emit(r) : say(`pressed ${rest[0]} via ${r.via}`); return 0; }
  if (cmd === 'scroll') { const r = await h.scroll(null, null, { direction: rest[0] || 'down', amount: Number(rest[1]) || 3 }); json ? emit(r) : say(`scrolled via ${r.via}`); return 0; }
  if (cmd === 'computer') {
    const out = await h.computer(JSON.parse(rest[0] || '{}'));
    if (out.type === 'image') { const f = saveShot(name, Buffer.from(out.source.data, 'base64')); emit(opt.base64 ? out : { ...out, source: { ...out.source, data: `<${out.source.data.length} base64 characters>` }, file: f }); } else emit(out);
    return 0;
  }
  throw new Refusal('action-unavailable', `unknown command ${cmd} (housesitter help)`);
}

function spawnStty(mode) { spawnSync('stty', [mode], { stdio: 'inherit' }); }

function saveShot(name, buf) {
  const dir = path.join(process.env.HOME || '.', 'Library', 'Caches', 'housesitter');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
  fs.writeFileSync(f, buf, { mode: 0o600 });
  return f;
}

// Record what the KVM sees while the Mac restarts: numbered frames, the sitter's state beside each, a timeline. The
// real-footage path for "show it working": restart the Mac yourself while this runs. Each frame is decoded and read on
// the KVM; a JPEG leaves it only when the frame isn't a desktop (--all-frames to keep those too), so a recording never
// carries your desktop or its notifications. Frames come at the KVM's full size (its ffmpeg can't scale); the video
// command below scales them.
async function proof(mac) {
  const dir = path.resolve(opt.record || `proof-${mac.name}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
  const sit = sitterClient(mac);
  if (!sit.routes.some((x) => x.via.startsWith('ssh'))) { say(`✗ proof reads frames on the KVM over SSH, and there is no SSH route to ${mac.name}'s KVM (housesitter adopt sets one up)`); return 2; }
  fs.mkdirSync(dir, { recursive: true });
  const sh = sitterSsh(mac);
  const end = Date.now() + (Number(opt.minutes) || 15) * 60000;
  const every = (Number(opt.every) || 3) * 1000;
  const timeline = [];
  let wentDown = false;
  let backAt = null;
  let kept = 0;
  say(`recording into ${dir} (Ctrl+C to stop). Restart the Mac now (Apple menu > Restart); the sitter does the rest.${opt['all-frames'] ? ' Recording desktops too (--all-frames).' : ' Desktops are not recorded.'}`);
  for (let n = 1; Date.now() < end; n++) {
    const t = Date.now();
    const [fr, st] = await Promise.all([
      sh(onSitter(mac, `proof-frame${opt['all-frames'] ? ' --all-frames' : ''}`)).then((r) => JSON.parse(String(r.stdout).trim().split('\n').at(-1))).catch((e) => ({ error: e.message })),
      sit.status().catch(() => ({})),
    ]);
    const state = st.status?.state || '?';
    const file = fr.jpeg ? `frame-${String(n).padStart(4, '0')}.jpg` : null;
    if (file) { fs.writeFileSync(path.join(dir, file), Buffer.from(fr.jpeg, 'base64')); kept++; }
    const last = st.status?.actions?.map((a) => `${a.kind}: ${a.result}`).join('; ') || '';
    // state is the rules' word: "filevault" means any login, lock or FileVault screen; screen is what the sitter's last look read.
    timeline.push({ at: new Date(t).toISOString(), file, reads_as: fr.reads_as ?? null, hdmi: fr.hdmi ?? null, prompt: fr.prompt ?? null, screen: st.status?.obs?.screen ?? null, state, actions: last || null, error: fr.error || null });
    say(`${new Date(t).toLocaleTimeString()}  ${String(fr.reads_as || '?').padEnd(11)} ${state.padEnd(9)} ${fr.prompt?.visible ? `lesson ${fr.prompt.kind} ${Math.round(fr.prompt.match * 100)}% ` : ''}${file ? '' : fr.withheld ? '(desktop: not recorded) ' : ''}${last}`);
    if (state !== 'healthy' && state !== '?') wentDown = true;
    if (wentDown && state === 'healthy' && !backAt) backAt = t;
    if (backAt && t - backAt > 30000) break;
    await new Promise((r) => setTimeout(r, Math.max(0, every - (Date.now() - t))));
  }
  // #27: the KVM's own record of who pressed what, taken now, because BusyBox keeps only about 45 minutes in memory.
  // syslog.log is the whole buffer, unfiltered; kvmd-access.log is the extract, made by the command written beside it.
  const ACCESS = "logread | grep 'kvmd: aiohttp.access'";
  const raw = await sh('logread').then((r) => String(r.stdout)).catch(() => '');
  if (raw) {
    fs.writeFileSync(path.join(dir, 'syslog.log'), raw);
    fs.writeFileSync(path.join(dir, 'kvmd-access.log'), raw.split('\n').filter((l) => l.includes('kvmd: aiohttp.access')).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(dir, 'timeline.json'), `${JSON.stringify({ mac: mac.name, recorded_by: `housesitter ${VERSION}`, real: true, desktops: opt['all-frames'] ? 'recorded' : 'not recorded', kvm_log: raw ? { unfiltered: 'syslog.log (logread, the whole in-memory buffer; it holds addresses, so check against it rather than publish it whole)', access: 'kvmd-access.log', command: ACCESS } : null, timeline }, null, 2)}\n`);
  say(`\n${kept} frames, timeline.json (${timeline.length} looks)${raw ? ', and the KVM\'s own log (syslog.log, which holds addresses, and kvmd-access.log from it)' : ''} in ${dir}${backAt ? '' : ' (the Mac did not come back while recording)'}.\nA video: ffmpeg -framerate 4 -pattern_type glob -i '${dir}/frame-*.jpg' -vf "scale=1280:-2" -pix_fmt yuv420p ${dir}/proof.mp4`);
  return backAt ? 0 : 1;
}

// `housesitter peer send|inbox|flush|watch`: Ouroboros's end of the peer link with Housesitter; see src/peer.mjs.
async function peerCmd() {
  let user;
  try { user = loadConfig().peer?.user; } catch { user = undefined; }
  const p = Peer.peer({ dir: path.dirname(configPath()), user });
  const waiting = (r) => (r.capped ? `the hourly cap is reached; it goes out after ${r.next_allowed_at}`
    : r.error ? `it goes out at the next flush (${r.error})`
    : r.next_flush_at ? `it goes out by ${r.next_flush_at}` : 'it goes out at the next flush');
  if (name === 'send') {
    const text = rest.join(' ');
    need(text, 'housesitter peer send <text> [--re <id>] [--now]');
    const r = await p.send(text, { re: opt.re, to: opt.to || 'housesitter', now: !!opt.now });
    json ? emit(r) : say(r.status === 'sent'
      ? `sent ${r.id} to ${r.to}${r.pruned?.length ? ` (cleared ${r.pruned.length} over a day old)` : ''}`
      : `queued ${r.id} for ${r.to}: ${waiting(r)}`);
    return 0;
  }
  if (name === 'flush') {
    const r = await p.flush({ now: !!opt.now });
    json ? emit(r) : say(r.sent.length ? `sent ${r.sent.length} queued message${r.sent.length === 1 ? '' : 's'}` : r.queued ? `${r.queued} queued: ${waiting(r).replace(/^it goes/, 'they go')}` : 'nothing queued');
    return 0;
  }
  if (name === 'inbox') {
    const r = await p.inbox({ mark: !opt.peek });
    if (json) emit(r);
    else say(r.messages.length ? r.messages.map((m) => `${m.at}  ${m.from || '?'}  ${m.id}${m.re ? ` (re ${m.re})` : ''}\n${m.text}`).join('\n\n') : 'nothing new');
    return 0;
  }
  if (name === 'drill') {
    const file = path.join(path.dirname(configPath()), 'drill.json');
    if (opt.end) {
      const d = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } })();
      if (d) fs.writeFileSync(file, `${JSON.stringify({ ...d, until: new Date().toISOString() }, null, 2)}\n`);
      json ? emit({ ok: true, ended: d?.label || null }) : say(d ? `drill "${d.label}" ended` : 'no drill');
      return 0;
    }
    const label = rest.join(' ');
    need(label, 'housesitter peer drill <label> [--minutes 60] | housesitter peer drill --end');
    const minutes = Math.max(1, Number.parseInt(opt.minutes || '60', 10) || 60);
    const d = { label, from: new Date().toISOString(), until: new Date(Date.now() + minutes * 60e3).toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
    json ? emit({ ok: true, ...d }) : say(`drill "${label}" until ${d.until}: everything sent on the peer link says "[planned drill: ${label}]"`);
    return 0;
  }
  if (name === 'watch') {
    const every = Math.max(5, Number.parseInt(opt.every || '30', 10) || 30);
    const w = peerWatch({ p, dir: path.dirname(configPath()), agent: opt.agent || 'ouroboros', ouro: opt.ouro || which('ouro'), bin: path.join(ROOT, 'bin', 'housesitter.mjs'), every, print: !!opt.once || process.stdout.isTTY ? (l) => console.log(l) : () => {} });
    if (opt.once) { await w.tick(); return 0; }
    return w.run();
  }
  throw new Refusal('input-invalid', `peer: unknown subcommand ${name || ''} (send, inbox, flush, watch, drill)`);
}

// `housesitter plug <mac> find|adopt [ip]|status|prove`: see src/plug.mjs.
async function plugCmd(mac) {
  const sub = rest[0] || 'status';
  const store = secretStore();
  const ref = mac.plug_password || `keychain:housesitter/${mac.name}-plug`;
  if (sub === 'find') {
    const all = await Plug.find();
    if (json) emit(all); else say(all.length ? all.map((d) => `${d.ip}  ${d.id}  ${d.model || ''} gen ${d.gen ?? '?'}  mac ${d.mac}${Plug.isPlug(d) ? '  (a plug)' : ''}${d.auth_en ? '  password set' : ''}`).join('\n') : 'no Shelly answered on this network (is the plug on this Wi-Fi yet? In the Shelly app: Add device, then this network)');
    return all.length ? 0 : 1;
  }
  if (sub === 'adopt') {
    const ip = rest[1];
    const cands = ip ? [await Plug.shellyInfo(ip)].filter(Boolean) : (await Plug.find()).filter(Plug.isPlug);
    if (cands.length !== 1) { say(cands.length ? `more than one plug answered (${cands.map((d) => d.ip).join(', ')}): name it, housesitter plug ${mac.name} adopt <ip>` : 'no Shelly plug answered on this network yet (Shelly app > Add device > this Wi-Fi, then run this again)'); return 2; }
    const d = cands[0];
    if (opt['dry-run']) { say(`would adopt ${d.id} (${d.model || 'Shelly'}) at ${d.ip}: on after an outage, no auto-off, cloud off, Bluetooth RPC on, a password of its own at ${ref}; record it; hand it to the sitter. Nothing is switched.`); return 0; }
    let pw = store.has(ref) ? store.get(ref) : null;
    if (!pw) { pw = Plug.newPassword(); store.set(ref, pw); }
    const c = await Plug.configure(d.ip, d, pw, { name: `${mac.name}-power` });
    const marks = Object.entries(c.checks).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join(' · ');
    if (!c.ok) { say(`✗ the plug didn't read back as set: ${marks}`); return 1; }
    const power = { kind: 'shelly', url: `http://${d.ip}`, mac: c.mac || d.mac, id: d.id, model: d.model || null, gen: d.gen ?? null, auth: true, ble_mac: null, adopted_at: new Date().toISOString() };
    updateMac(mac.name, (m) => { m.power = power; m.plug_password = ref; });
    const seen = await Plug.handToSitter(power, pw, sitterSsh(mac), { dir: sitterDir(mac) });
    say(`✓ ${d.id} at ${d.ip}: ${marks}. From here: ${c.on ? 'on' : 'OFF'}, ${c.watts ?? '?'} W.\n  The sitter reads it: ${seen.ok ? `${seen.on ? 'on' : 'OFF'}, ${seen.watts ?? '?'} W` : `✗ ${seen.error}`}. Password at ${ref}, sealed on the KVM as "plug".\n  Next, with the Mac's cord (and only that) on the plug: housesitter plug ${mac.name} prove --attended`);
    return seen.ok ? 0 : 1;
  }
  if (sub === 'status') {
    const p = mac.power;
    if (!p || p.kind !== 'shelly') { say(p ? `${mac.name}'s power is ${p.kind}; status reads Shelly plugs` : `${mac.name} has no plug yet; when it's on the Mac's cord: housesitter plug ${mac.name} adopt`); return 1; }
    const pw = p.auth ? store.get(ref) : null;
    const [here, there] = await Promise.all([
      Plug.readPlug(p, pw).catch((e) => ({ error: e.message })),
      sitterSsh(mac)(onSitter(mac, 'plug-status')).then((r) => JSON.parse(String(r.stdout).trim().split('\n').at(-1))).catch((e) => ({ ok: false, error: e.message })),
    ]);
    if (here.moved) updateMac(mac.name, (m) => { m.power.url = here.url; });
    if (json) emit({ name: mac.name, plug: p.id, here, sitter: there });
    else say(`${mac.name}'s plug ${p.id || ''}\n  from here:   ${here.error ? `✗ ${here.error}` : `${here.on ? 'on' : 'OFF'}, ${here.watts ?? '?'} W${here.moved ? ` (it moved: now ${here.url}, saved)` : ''}`}\n  the sitter:  ${there.ok ? `${there.on ? 'on' : 'OFF'}, ${there.watts ?? '?'} W at ${there.url || '?'}` : `✗ ${there.error}`}`);
    return here.error || !there.ok ? 1 : 0;
  }
  if (sub === 'prove') {
    if (!opt.attended) { say(`refused: this cuts ${mac.name}'s power for 10 s. Run it while you (or your agent) are watching, with --attended, and only once the Mac's cord alone is on the plug.`); return 2; }
    if (!mac.power) { say(`${mac.name} has no plug yet: housesitter plug ${mac.name} adopt`); return 2; }
    const r = await Plug.prove({ ssh: sitterSsh(mac), dir: sitterDir(mac), say });
    if (json) emit(r); else say(r.ok ? `✓ power cut → boot seen in ${r.boot_s} s → desktop in ${r.desktop_s} s, unlocked by the sitter; the KVM stayed up` : `✗ ${r.why}`);
    return r.ok ? 0 : 1;
  }
  throw new Refusal('input-invalid', `plug: unknown subcommand ${sub} (find, adopt, status, prove)`);
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  const code = e instanceof Refusal || e.code ? e.code : 'action-failed';
  if (json) emit({ ok: false, code, message: e.message, ...(e.available ? { available: e.available } : {}), ...(e.path ? { path: e.path } : {}) });
  else console.error(`housesitter: ${e.message}${e.available ? `\n  available: ${e.available.join(', ')}` : ''}`);
  process.exit(code === 'action-unavailable' || code === 'input-invalid' ? 2 : 1);
});
