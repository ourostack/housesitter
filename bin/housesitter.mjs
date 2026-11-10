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
import * as Plug from '../src/plug.mjs';
import * as Watch from '../src/watch.mjs';
import * as O from '../src/outbox.mjs';
import os from 'node:os';
import * as R from '../src/reins.mjs';
import { describeStatus, kvmHost, sitterClient, sshRunner } from '../src/sitter.mjs';

const sitterSsh = (mac) => sshRunner(mac.name, kvmHost(mac), { key: mac.kvm?.ssh_key || null });
const sitterDir = (mac) => mac.kvm?.sitter_home || '/etc/kvmd/user/housesitter';
const onSitter = (mac, args) => `${mac.kvm?.sitter_home ? `HOUSESITTER_HOME='${mac.kvm.sitter_home}' ` : ''}python3 ${sitterDir(mac)}/sitter.py ${args}`;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const HELP = `housesitter ${VERSION}: your agents' Mac, looked after while you're away.

  housesitter demo                         the real evening it was built for, replayed (no hardware)
  housesitter demo night                   one bad night, rehearsed: a panic, a freeze, a changed password
  housesitter adopt <mac> --address <ip>   set up a new KVM next to <mac>: three cables in, then this
      [--notify ntfy|<url>] [--email <you@example.com>] [--watched-by <url>] [--location home|away] [--fingerprint <sha256>]
      [--this-mac] [--outbox] [--dry-run] [--fake]
  housesitter secret <mac> <mac-password|kvm-admin|outbox-token|ntfy-token>   store a secret (read from stdin, no echo)
  housesitter proof <mac> [--record <dir>] record what the KVM sees while you restart the Mac
                                           (desktops are never recorded unless --all-frames)
  housesitter plug <mac> find|adopt [ip]|status   the smart plug on the Mac's cord: set it up safely, read it
  housesitter plug <mac> prove --attended  one real 10 s power cut, watched until the Mac is back

  housesitter doctor <mac> [--private]     everything in one screen: what the KVM sees, the Mac, the budgets
                                           (--private hides the picture, for a screenshot or a screen share)
  housesitter look <mac>                   one read-only look at the screen   (--picture <file>: a saved one)
  housesitter screenshot <mac> [--out f.jpg] [--max-width 1280]
  housesitter click <mac> <x> <y> [--right|--double]    in the last screenshot's pixels
  housesitter type <mac> <text>            housesitter key <mac> <combo>     housesitter scroll <mac> <up|down> [n]
  housesitter computer <mac> '<json>'      an Anthropic computer-use action, as-is
  housesitter unlock|power-cycle|power-on <mac>     ask the sitter (it keeps its own limits and checks)
  housesitter unlock <mac> --trial|--hold  arm one supervised try of the stored password, or disarm it
  housesitter unlock <mac> --attended-test you are locking and unlocking on purpose: its own budget (30 an hour)
  housesitter want-desktop <mac> [--minutes 10]   an agent needs the UI: unlock now, and again if it locks meanwhile
                                           (only with "unlock_lock_screen": "on_request" or true in its config)
  housesitter watch-kvm <mac> --install   on the Mac: a LaunchAgent that checks the KVM every minute, and tells you
                                           once if it goes silent (and once when it's back): the Mac watches its KVM
                                           [--silent-min 5] [--test]; also --once, --status, --uninstall
  housesitter alert-test <mac> [--again]  one real "I'm stuck" message through the rules, marked TEST (over SSH; once a day)
  housesitter learn-prompt <mac> --i-see-the-field [--filevault]  teach it the prompt you see on the KVM; --filevault during a restart
  housesitter learn-prompt <mac> --i-see-the-field --grid <x> <y>  the login window's list of users: x y is your
                                           account's tile, as fractions of the screen (0.48 0.87)
  housesitter power-cycle <mac> --attended  you have looked: skip the frozen-desktop check (never the budgets)

  housesitter ls <mac>                     the Mac as state + the actions available now (Ouro Reins)
  housesitter do <mac> <action> ['<json>'] run one; refusals: action-unavailable, input-invalid, action-failed
  housesitter forget <mac> --yes           wipe the secrets from the KVM and stop the sitter
  housesitter peer send <text> [--re <id>] Ouroboros to Housesitter, the agent on the KVM: free text through a secret gist
  housesitter peer inbox [--peek]          Housesitter's new messages, oldest first, each shown once (--peek: don't mark them read)
  housesitter tailnet-policy               a Tailscale policy where the KVM reaches nothing
  housesitter doctor                       check this computer's setup (status <mac> is doctor <mac>)

  --json for machine output. Config: ${configPath()}. Docs: https://github.com/ourostack/housesitter`;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const VALUED = ['--address', '--out', '--max-width', '--record', '--minutes', '--picture', '--home', '--notify', '--email', '--silent-min', '--watched-by', '--heartbeat', '--location', '--fingerprint', '--every', '--re', '--to'];
const pos = args.filter((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
const json = flag('--json');
const say = (t) => { if (!json) console.log(t); };
const emit = (o) => console.log(JSON.stringify(o));
const [cmd, name, ...rest] = pos;

async function hands(mac) {
  return open(mac.name, { deps: { mac, sitter: sitterClient(mac) } });
}

async function kvmLook(mac) {
  const store = secretStore();
  const { client, endpoint } = await connect({ endpoints: mac.kvm.endpoints, pin: mac.kvm.tls_sha256, user: mac.kvm.user, password: () => store.get(mac.kvm.admin_password) || '' });
  const [info, hid, streamer] = await Promise.all([client.info(), client.hid().catch(() => null), client.streamer().catch(() => null)]);
  return { ...summarise({ info, hid, streamer }), via: `${endpoint.label || endpoint.url}${endpoint.fallback ? ' (fallback)' : ''}` };
}

function useColor() { return !flag('--plain') && !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === '1'); }

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
  console.log(['', ...beside(paintGlimpse(p, flag('--private') ? null : l.glimpse, { title: 'what the KVM sees', note: flag('--private') ? 'picture hidden (--private)' : '' }).map((x) => `  ${x}`), right), ''].join('\n'));
  return 0;
}

async function watchKvm(mac) {
  const name = mac.name;
  const sp = Watch.statePath(name);
  const silentMin = Number(val('--silent-min')) || Watch.SILENT_MIN;
  const test = flag('--test');
  if (flag('--status')) { const st = Watch.loadState(sp); json ? emit(st) : say(JSON.stringify(st, null, 2)); return 0; }
  const label = Watch.agentLabel(name);
  const agent = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const uid = process.getuid();
  if (flag('--uninstall')) {
    spawnSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
    if (fs.existsSync(agent)) fs.renameSync(agent, path.join(os.homedir(), '.Trash', `${label}.plist.${Date.now()}`));
    say(`stopped: ${name}'s KVM is no longer watched from this Mac`);
    return 0;
  }
  if (flag('--install')) {
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    fs.mkdirSync(path.join(os.homedir(), 'Library', 'Logs'), { recursive: true });
    const extra = [...(val('--silent-min') ? ['--silent-min', String(silentMin)] : []), ...(test ? ['--test'] : [])];
    fs.writeFileSync(agent, Watch.plist({ name, node: Watch.stableNode(process.execPath), bin: fileURLToPath(import.meta.url), args: extra }));
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
  if (flag('--once')) { await tick(); return 0; }
  for (;;) { await tick(); await new Promise((r) => setTimeout(r, 60000)); }
}

function need(n, usage) { if (!n) throw new Refusal('input-invalid', `usage: ${usage}`); }

async function main() {
  if (!cmd || cmd === 'help' || flag('--help') || flag('-h')) { console.log(HELP); return 0; }
  if (cmd === 'version' || flag('--version')) { console.log(VERSION); return 0; }

  if (cmd === 'demo' && name !== 'night') {
    const steps = replay();
    if (json) { emit({ replay: '2026-11-08', steps: steps.map(({ lum, glimpse, ...s }) => s) }); return 0; }
    const blocks = renderEvening(steps, { color: useColor() });
    const slow = process.stdout.isTTY && !flag('--fast');
    for (const b of blocks) { console.log(b.join('\n')); if (slow) await new Promise((r) => setTimeout(r, 1400)); }
    return 0;
  }

  if (cmd === 'demo') {
    const r = await night();
    if (json) emit({ rehearsal: true, lines: r.lines, incidents: r.incidents }); else console.log(render(r, { color: useColor() }));
    return 0;
  }

  if (cmd === 'tailnet-policy') { console.log(fs.readFileSync(path.join(ROOT, 'docs', 'tailnet-policy.hujson'), 'utf8')); return 0; }

  if (cmd === 'look' && val('--picture')) {
    // What the sitter would make of a saved picture: the same code as on the KVM, run here (needs python3 and ffmpeg).
    const r = spawnSync('python3', [path.join(ROOT, 'device', 'sitter.py'), 'look', '--from', path.resolve(val('--picture'))], { encoding: 'utf8', env: { ...process.env, HOUSESITTER_HOME: val('--home') || path.join(path.dirname(configPath()), 'look') } });
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
    const fake = flag('--fake') ? fakeDeps({ apiClosed: !flag('--api-open') }) : null;
    const store = secretStore();
    let mac;
    try { mac = macConfig(name); } catch { mac = { name, kvm: { endpoints: [] } }; }
    const x = {
      name, mac, refs: { ...defaultRefs(name), ...(mac.kvm?.admin_password ? { admin: mac.kvm.admin_password } : {}) }, address: val('--address') || (fake ? null : mac.kvm?.endpoints?.find((e) => e.fallback)?.url?.replace(/^https:\/\//, '') || null),
      dryRun: flag('--dry-run'), outbox: flag('--outbox'), notify: val('--notify'), email: val('--email'), watchedBy: val('--watched-by'), heartbeat: val('--heartbeat'), location: val('--location'), expectFingerprint: val('--fingerprint'), macIfconfig: flag('--this-mac') ? hostIfconfig() : '', say,
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
    need(name && ['mac-password', 'kvm-admin', 'outbox-token', 'ntfy-token'].includes(which), 'housesitter secret <mac> <mac-password|kvm-admin|outbox-token|ntfy-token>  (reads the value from stdin)');
    const refs = defaultRefs(name);
    let m = {};
    try { m = macConfig(name); } catch { /* new */ }
    const ref = { 'mac-password': m.mac_password || refs.mac, 'kvm-admin': m.kvm?.admin_password || refs.admin, 'outbox-token': m.outbox?.token || refs.outbox, 'ntfy-token': m.notify?.token || refs.ntfy }[which];
    if (process.stdin.isTTY) { process.stderr.write(`${which} for ${name} (input hidden), then Return: `); spawnStty('-echo'); }
    const value = await new Promise((res) => { let b = ''; process.stdin.on('data', (d) => { b += d; if (process.stdin.isTTY && b.includes('\n')) { process.stdin.pause(); res(b); } }); process.stdin.on('end', () => res(b)); });
    if (process.stdin.isTTY) { spawnStty('echo'); process.stderr.write('\n'); }
    secretStore().set(ref, value.replace(/\r?\n$/, ''));
    updateMac(name, (c) => { if (which === 'mac-password') c.mac_password = ref; if (which === 'kvm-admin') { c.kvm = c.kvm || {}; c.kvm.admin_password = ref; } if (which === 'outbox-token' && c.outbox) c.outbox.token = ref; if (which === 'ntfy-token' && c.notify) c.notify.token = ref; });
    say(`stored at ${ref}${which === 'mac-password' || which === 'ntfy-token' ? `; run housesitter adopt ${name} to put it on the sitter` : ''}`);
    return 0;
  }

  if (cmd === 'peer') return peerCmd();

  need(name, `housesitter ${cmd} <mac>`);
  const mac = macConfig(name);

  if (cmd === 'watch-kvm') return watchKvm(mac);

  if (cmd === 'status' || cmd === 'doctor') {
    const [kvm, sit] = await Promise.all([kvmLook(mac).catch((e) => ({ error: e.message })), sitterClient(mac).status().catch((e) => ({ errors: [e.message] }))]);
    if (json) { emit({ name, kvm, sitter: sit.status, sitter_via: sit.via }); return 0; }
    if (flag('--plain')) {
      console.log(kvm.error ? `KVM: not reached (${kvm.error})` : `KVM via ${kvm.via}: ${kvm.model || 'kvmd'}; video ${kvm.video.online ? `on, ${kvm.video.resolution}` : 'no signal'}; keyboard ${kvm.hid.keyboard_online ? 'online' : 'offline'}`);
      console.log(sit.status ? `${describeStatus(name, sit.status)}\n  via ${sit.via}` : `sitter: no status (${(sit.errors || []).join('; ') || 'no route'})`);
      return 0;
    }
    const model = buildDoctor({ name, mac, kvm, sit });
    console.log(renderDoctor(model, { color: useColor(), hidePicture: flag('--private') }));
    return cmd === 'doctor' && (kvm.error || !sit.status) ? 3 : 0;
  }

  if (cmd === 'look') {
    const r = await sitterSsh(mac)(onSitter(mac, 'look'));
    if (r.status !== 0) { say(`✗ ${String(r.stderr || r.stdout).trim() || 'could not reach the KVM over SSH'}`); return 1; }
    return showLook(JSON.parse(String(r.stdout).trim().split('\n').at(-1)));
  }

  if (cmd === 'proof') return proof(mac);

  if (cmd === 'forget') {
    if (!flag('--yes')) { say(`This wipes the Mac's password, the KVM's admin password and the outbox token from ${name}'s KVM and stops the sitter. Run again with --yes.`); return 2; }
    const sh = sitterSsh(mac);
    const r = await sh(`python3 /etc/kvmd/user/housesitter/sitter.py forget && (systemctl disable --now housesitter 2>/dev/null || /etc/init.d/S99housesitter stop; true)`);
    say(r.status === 0 ? `forgot: ${String(r.stdout).trim()}; the sitter is stopped. Your Keychain items are untouched (security delete-generic-password -s housesitter …).` : `could not reach the KVM over SSH: ${String(r.stderr).trim()}`);
    return r.status === 0 ? 0 : 1;
  }

  if (cmd === 'unlock' && (flag('--trial') || flag('--hold'))) {
    // Arming the one supervised try is an operator act over SSH, never through the GitHub outbox.
    const r = await sitterSsh(mac)(`python3 /etc/kvmd/user/housesitter/sitter.py ${flag('--trial') ? 'password-trial' : 'password-hold'}`);
    if (r.status !== 0) { say(`✗ ${String(r.stderr || r.stdout).trim() || 'could not reach the KVM over SSH'}`); return 1; }
    say(flag('--trial')
      ? `armed one supervised try. Restart the Mac now and watch: housesitter proof ${name} --record ./proof. The sitter types once, only where it sees the password field; if the desktop follows within 2 minutes the password is verified, otherwise it goes back to unverified and types nothing more.`
      : 'held: the password is unverified again, and nothing is typed until you arm a trial.');
    return 0;
  }

  if (cmd === 'alert-test') {
    // An operator act over SSH, never through the GitHub outbox: the sitter sends one real stuck message, marked TEST.
    const r = await sitterSsh(mac)(onSitter(mac, `alert-test${flag('--again') ? ' --again' : ''}`));
    let j = {};
    try { j = JSON.parse(String(r.stdout).trim().split('\n').at(-1)); } catch { j = { ok: false, result: String(r.stderr || r.stdout).trim().slice(0, 200) || 'could not reach the KVM over SSH' }; }
    if (json) emit(j); else say(j.ok ? `✓ sent through ${mac.notify?.kind || 'the notify channel'}: ${j.result}\n  title: ${j.sent?.title}\n  body:  ${String(j.sent?.body || '').replace(/\n/g, ' / ')}` : `✗ ${j.result}`);
    return j.ok ? 0 : 1;
  }

  if (cmd === 'learn-prompt') {
    if (!flag('--i-see-the-field')) { say(`Teach the sitter ${name}'s password prompt only while you can see the FileVault or login password field (or, with --grid, the login window's list of users) on the KVM's own picture (housesitter screenshot ${name}). Then run again with --i-see-the-field.`); return 2; }
    let grid = '';
    if (flag('--grid') && flag('--filevault')) { say('--grid and --filevault are two different lessons: a list of users is only ever clicked, never typed into. Teach each on its own.'); return 2; }
    if (flag('--grid')) {
      const i = args.indexOf('--grid');
      const [gx, gy] = [Number(args[i + 1]), Number(args[i + 2])];
      if (!(gx > 0 && gx < 1 && gy > 0 && gy < 1)) { say('--grid needs your account tile as two fractions of the screen, like --grid 0.48 0.87 (x then y, from housesitter screenshot)'); return 2; }
      grid = ` --grid ${gx} ${gy}`;
    }
    const r = await sitterSsh(mac)(onSitter(mac, `learn-prompt${flag('--filevault') ? ' --filevault' : ''}${grid} taught over SSH by an operator who saw the screen`));
    say(r.status === 0 ? `learned: ${String(r.stdout).trim()}. The sitter types only where a frame matches this.` : `✗ ${String(r.stderr || r.stdout).trim()}`);
    return r.status === 0 ? 0 : r.status === 2 ? 2 : 1;
  }

  if (cmd === 'want-desktop') {
    const r = await sitterClient(mac).op('want_desktop', { minutes: Number(val('--minutes')) || 10 });
    if (json) emit(r); else say(`${r.ok ? '✓' : `✗ ${r.code}`} want-desktop: ${typeof r.result === 'string' ? r.result : `${r.result?.unlock || ''}${r.result?.minutes ? ` (the request stands for ${r.result.minutes} min)` : ''}`}${r.via ? `\n  via ${r.via}` : ''}`);
    return r.ok ? 0 : r.code === 'action-unavailable' || r.code === 'input-invalid' ? 2 : 1;
  }

  if (cmd === 'plug') return plugCmd(mac);

  if (['unlock', 'power-cycle', 'power-on'].includes(cmd)) {
    const opArgs = flag('--attended') ? { attended: true } : cmd === 'unlock' && flag('--attended-test') ? { attended_test: true } : {};
    if (opArgs.attended_test && !sitterClient(mac).routes.some((x) => x.via.startsWith('ssh'))) { say('✗ attended tests run over SSH only, and there is no SSH route to this KVM'); return 2; }
    const r = await sitterClient(mac).op(cmd.replace('-', '_'), opArgs);
    if (json) emit(r); else say(`${r.ok ? '✓' : `✗ ${r.code}`} ${cmd}: ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}${r.via ? `\n  via ${r.via}` : ''}`);
    return r.ok ? 0 : r.code === 'action-unavailable' || r.code === 'input-invalid' ? 2 : 1;
  }

  if (cmd === 'ls' || cmd === 'do') {
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
    const s = await h.screenshot({ maxWidth: Number(val('--max-width')) || undefined });
    const f = val('--out') || saveShot(name, s.image);
    if (val('--out')) fs.writeFileSync(f, s.image);
    if (json) emit({ file: f, width: s.width, height: s.height, real: s.real, via: s.via }); else say(`${f}  ${s.width}x${s.height} (the Mac drives ${s.real.width}x${s.real.height}) via ${s.via}`);
    return 0;
  }
  if (cmd === 'click') { const r = await h.click(Number(rest[0]), Number(rest[1]), { button: flag('--right') ? 'right' : 'left', double: flag('--double') }); json ? emit(r) : say(`clicked via ${r.via}`); return 0; }
  if (cmd === 'type') { const r = await h.type(rest.join(' ')); json ? emit(r) : say(`typed via ${r.via}`); return 0; }
  if (cmd === 'key') { const r = await h.key(rest[0]); json ? emit(r) : say(`pressed ${rest[0]} via ${r.via}`); return 0; }
  if (cmd === 'scroll') { const r = await h.scroll(null, null, { direction: rest[0] || 'down', amount: Number(rest[1]) || 3 }); json ? emit(r) : say(`scrolled via ${r.via}`); return 0; }
  if (cmd === 'computer') {
    const out = await h.computer(JSON.parse(rest[0] || '{}'));
    if (out.type === 'image') { const f = saveShot(name, Buffer.from(out.source.data, 'base64')); emit(flag('--base64') ? out : { ...out, source: { ...out.source, data: `<${out.source.data.length} base64 characters>` }, file: f }); } else emit(out);
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
  const dir = path.resolve(val('--record') || `proof-${mac.name}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
  const sit = sitterClient(mac);
  if (!sit.routes.some((x) => x.via.startsWith('ssh'))) { say(`✗ proof reads frames on the KVM over SSH, and there is no SSH route to ${mac.name}'s KVM (housesitter adopt sets one up)`); return 2; }
  fs.mkdirSync(dir, { recursive: true });
  const sh = sitterSsh(mac);
  const end = Date.now() + (Number(val('--minutes')) || 15) * 60000;
  const every = (Number(val('--every')) || 3) * 1000;
  const timeline = [];
  let wentDown = false;
  let backAt = null;
  let kept = 0;
  say(`recording into ${dir} (Ctrl+C to stop). Restart the Mac now (Apple menu > Restart); the sitter does the rest.${flag('--all-frames') ? ' Recording desktops too (--all-frames).' : ' Desktops are not recorded.'}`);
  for (let n = 1; Date.now() < end; n++) {
    const t = Date.now();
    const [fr, st] = await Promise.all([
      sh(onSitter(mac, `proof-frame${flag('--all-frames') ? ' --all-frames' : ''}`)).then((r) => JSON.parse(String(r.stdout).trim().split('\n').at(-1))).catch((e) => ({ error: e.message })),
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
  fs.writeFileSync(path.join(dir, 'timeline.json'), `${JSON.stringify({ mac: mac.name, recorded_by: `housesitter ${VERSION}`, real: true, desktops: flag('--all-frames') ? 'recorded' : 'not recorded', kvm_log: raw ? { unfiltered: 'syslog.log (logread, the whole in-memory buffer; it holds addresses, so check against it rather than publish it whole)', access: 'kvmd-access.log', command: ACCESS } : null, timeline }, null, 2)}\n`);
  say(`\n${kept} frames, timeline.json (${timeline.length} looks)${raw ? ', and the KVM\'s own log (syslog.log, which holds addresses, and kvmd-access.log from it)' : ''} in ${dir}${backAt ? '' : ' (the Mac did not come back while recording)'}.\nA video: ffmpeg -framerate 4 -pattern_type glob -i '${dir}/frame-*.jpg' -vf "scale=1280:-2" -pix_fmt yuv420p ${dir}/proof.mp4`);
  return backAt ? 0 : 1;
}

// `housesitter peer send|inbox`: Ouroboros's end of the peer link with Housesitter; see src/peer.mjs.
async function peerCmd() {
  const p = Peer.peer({ dir: path.dirname(configPath()) });
  if (name === 'send') {
    const text = rest.join(' ');
    need(text, 'housesitter peer send <text> [--re <id>]');
    const r = await p.send(text, { re: val('--re'), to: val('--to') || 'housesitter' });
    json ? emit(r) : say(`sent ${r.id} to ${r.to}${r.pruned.length ? ` (cleared ${r.pruned.length} over a day old)` : ''}`);
    return 0;
  }
  if (name === 'inbox') {
    const r = await p.inbox({ mark: !flag('--peek') });
    if (json) emit(r);
    else say(r.messages.length ? r.messages.map((m) => `${m.at}  ${m.from || '?'}  ${m.id}${m.re ? ` (re ${m.re})` : ''}\n${m.text}`).join('\n\n') : 'nothing new');
    return 0;
  }
  throw new Refusal('input-invalid', `peer: unknown subcommand ${name || ''} (send, inbox)`);
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
    if (flag('--dry-run')) { say(`would adopt ${d.id} (${d.model || 'Shelly'}) at ${d.ip}: on after an outage, no auto-off, cloud off, Bluetooth RPC on, a password of its own at ${ref}; record it; hand it to the sitter. Nothing is switched.`); return 0; }
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
    if (!flag('--attended')) { say(`refused: this cuts ${mac.name}'s power for 10 s. Run it while you (or your agent) are watching, with --attended, and only once the Mac's cord alone is on the plug.`); return 2; }
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
