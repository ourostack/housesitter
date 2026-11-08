#!/usr/bin/env node
// housesitter: keep an always-on Mac that hosts your agents alive and drivable, hands-off, through a cheap IP-KVM.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, macConfig, secretStore, updateMac } from '../src/config.mjs';
import { adopt, defaultRefs, fakeDeps, hostIfconfig, realDeps } from '../src/adopt.mjs';
import { night, render } from '../src/demo.mjs';
import { Refusal, open } from '../src/hands.mjs';
import { connect, summarise } from '../src/kvmd.mjs';
import * as R from '../src/reins.mjs';
import { describeStatus, kvmHost, sitterClient, sshRunner } from '../src/sitter.mjs';

const sitterSsh = (mac) => sshRunner(mac.name, kvmHost(mac));

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const HELP = `housesitter ${VERSION}: your agents' Mac, looked after while you're away.

  housesitter demo                         one bad night, rehearsed in seconds (no hardware)
  housesitter adopt <mac> --address <ip>   set up a new KVM next to <mac>: three cables in, then this
      [--notify ntfy|<url>] [--heartbeat <url>] [--location home|away] [--fingerprint <sha256>]
      [--this-mac] [--outbox] [--dry-run] [--fake]
  housesitter secret <mac> <mac-password|kvm-admin|outbox-token>   store a secret (read from stdin, no echo)
  housesitter proof <mac> [--record <dir>] record what the KVM sees while you restart the Mac

  housesitter status <mac>                 the KVM and the sitter, in one look
  housesitter screenshot <mac> [--out f.jpg] [--max-width 1280]
  housesitter click <mac> <x> <y> [--right|--double]    in the last screenshot's pixels
  housesitter type <mac> <text>            housesitter key <mac> <combo>     housesitter scroll <mac> <up|down> [n]
  housesitter computer <mac> '<json>'      an Anthropic computer-use action, as-is
  housesitter unlock|power-cycle|power-on <mac>     ask the sitter (it keeps its own limits and checks)
  housesitter unlock <mac> --trial|--hold  arm one supervised try of the stored password, or disarm it
  housesitter learn-prompt <mac> --i-see-the-field  teach it the password prompt while you see it on the KVM
  housesitter power-cycle <mac> --attended  you have looked: skip the frozen-desktop check (never the budgets)

  housesitter ls <mac>                     the Mac as state + the actions available now (Ouro Reins)
  housesitter do <mac> <action> ['<json>'] run one; refusals: action-unavailable, input-invalid, action-failed
  housesitter forget <mac> --yes           wipe the secrets from the KVM and stop the sitter
  housesitter tailnet-policy               a Tailscale policy where the KVM reaches nothing
  housesitter doctor                       check this computer's setup

  --json for machine output. Config: ${configPath()}. Docs: https://github.com/ourostack/housesitter`;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const VALUED = ['--address', '--out', '--max-width', '--record', '--minutes'];
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

function need(n, usage) { if (!n) throw new Refusal('input-invalid', `usage: ${usage}`); }

async function main() {
  if (!cmd || cmd === 'help' || flag('--help') || flag('-h')) { console.log(HELP); return 0; }
  if (cmd === 'version' || flag('--version')) { console.log(VERSION); return 0; }

  if (cmd === 'demo') {
    const r = await night();
    if (json) emit({ rehearsal: true, lines: r.lines, incidents: r.incidents }); else console.log(render(r, { color: process.stdout.isTTY && !process.env.NO_COLOR }));
    return 0;
  }

  if (cmd === 'tailnet-policy') { console.log(fs.readFileSync(path.join(ROOT, 'docs', 'tailnet-policy.hujson'), 'utf8')); return 0; }

  if (cmd === 'doctor') {
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
    need(name, 'housesitter adopt <mac> [--address <ip>] [--notify ntfy|<url>] [--heartbeat <url>] [--outbox] [--this-mac] [--dry-run] [--fake]');
    const fake = flag('--fake') ? fakeDeps({ apiClosed: !flag('--api-open') }) : null;
    const store = secretStore();
    let mac;
    try { mac = macConfig(name); } catch { mac = { name, kvm: { endpoints: [] } }; }
    const x = {
      name, mac, refs: { ...defaultRefs(name), ...(mac.kvm?.admin_password ? { admin: mac.kvm.admin_password } : {}) }, address: val('--address') || (fake ? null : mac.kvm?.endpoints?.find((e) => e.fallback)?.url?.replace(/^https:\/\//, '') || null),
      dryRun: flag('--dry-run'), outbox: flag('--outbox'), notify: val('--notify'), heartbeat: val('--heartbeat'), location: val('--location'), expectFingerprint: val('--fingerprint'), macIfconfig: flag('--this-mac') ? hostIfconfig() : '', say,
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
    need(name && ['mac-password', 'kvm-admin', 'outbox-token'].includes(which), 'housesitter secret <mac> <mac-password|kvm-admin|outbox-token>  (reads the value from stdin)');
    const refs = defaultRefs(name);
    let m = {};
    try { m = macConfig(name); } catch { /* new */ }
    const ref = { 'mac-password': m.mac_password || refs.mac, 'kvm-admin': m.kvm?.admin_password || refs.admin, 'outbox-token': m.outbox?.token || refs.outbox }[which];
    if (process.stdin.isTTY) { process.stderr.write(`${which} for ${name} (input hidden), then Return: `); spawnStty('-echo'); }
    const value = await new Promise((res) => { let b = ''; process.stdin.on('data', (d) => { b += d; if (process.stdin.isTTY && b.includes('\n')) { process.stdin.pause(); res(b); } }); process.stdin.on('end', () => res(b)); });
    if (process.stdin.isTTY) { spawnStty('echo'); process.stderr.write('\n'); }
    secretStore().set(ref, value.replace(/\r?\n$/, ''));
    updateMac(name, (c) => { if (which === 'mac-password') c.mac_password = ref; if (which === 'kvm-admin') { c.kvm = c.kvm || {}; c.kvm.admin_password = ref; } if (which === 'outbox-token' && c.outbox) c.outbox.token = ref; });
    say(`stored at ${ref}${which === 'mac-password' ? `; run housesitter adopt ${name} to put it on the sitter` : ''}`);
    return 0;
  }

  need(name, `housesitter ${cmd} <mac>`);
  const mac = macConfig(name);

  if (cmd === 'status') {
    const [kvm, sit] = await Promise.all([kvmLook(mac).catch((e) => ({ error: e.message })), sitterClient(mac).status().catch((e) => ({ errors: [e.message] }))]);
    if (json) { emit({ name, kvm, sitter: sit.status, sitter_via: sit.via }); return 0; }
    console.log(kvm.error ? `KVM: not reached (${kvm.error})` : `KVM via ${kvm.via}: ${kvm.model || 'kvmd'}; video ${kvm.video.online ? `on, ${kvm.video.resolution}` : 'no signal'}; keyboard ${kvm.hid.keyboard_online ? 'online' : 'offline'}`);
    console.log(sit.status ? `${describeStatus(name, sit.status)}\n  via ${sit.via}` : `sitter: no status (${(sit.errors || []).join('; ') || 'no route'})`);
    return 0;
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

  if (cmd === 'learn-prompt') {
    if (!flag('--i-see-the-field')) { say(`Teach the sitter ${name}'s password prompt only while you can see the FileVault or login password field on the KVM's own picture (housesitter screenshot ${name}). Then run again with --i-see-the-field.`); return 2; }
    const r = await sitterSsh(mac)('python3 /etc/kvmd/user/housesitter/sitter.py learn-prompt taught over SSH by an operator who saw the field');
    say(r.status === 0 ? `learned: ${String(r.stdout).trim()}. The sitter types only where a frame matches this.` : `✗ ${String(r.stderr || r.stdout).trim()}`);
    return r.status === 0 ? 0 : r.status === 2 ? 2 : 1;
  }

  if (['unlock', 'power-cycle', 'power-on'].includes(cmd)) {
    const r = await sitterClient(mac).op(cmd.replace('-', '_'), flag('--attended') ? { attended: true } : {});
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

// Record what the KVM sees while the Mac restarts: numbered frames, the sitter's state beside each, a timeline.
// The real-footage path for "show it working": restart the Mac yourself while this runs.
async function proof(mac) {
  const dir = path.resolve(val('--record') || `proof-${mac.name}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  const sit = sitterClient(mac);
  const h = await hands(mac);
  const end = Date.now() + (Number(val('--minutes')) || 15) * 60000;
  const timeline = [];
  let wentDown = false;
  let backAt = null;
  say(`recording into ${dir} (Ctrl+C to stop). Restart the Mac now (Apple menu > Restart); the sitter does the rest.`);
  for (let n = 1; Date.now() < end; n++) {
    const t = Date.now();
    const [shot, st] = await Promise.all([h.screenshot({ maxWidth: 1280 }).catch((e) => ({ error: e.message })), sit.status().catch(() => ({}))]);
    const state = st.status?.state || '?';
    const file = shot.image ? `frame-${String(n).padStart(4, '0')}.jpg` : null;
    if (file) fs.writeFileSync(path.join(dir, file), shot.image);
    const last = st.status?.actions?.map((a) => `${a.kind}: ${a.result}`).join('; ') || '';
    timeline.push({ at: new Date(t).toISOString(), file, state, screen: st.status?.obs?.screen ?? null, actions: last || null, error: shot.error || null });
    say(`${new Date(t).toLocaleTimeString()}  ${state.padEnd(9)} ${st.status?.obs?.screen || ''} ${last}`);
    if (state !== 'healthy' && state !== '?') wentDown = true;
    if (wentDown && state === 'healthy' && !backAt) backAt = t;
    if (backAt && t - backAt > 30000) break;
    await new Promise((r) => setTimeout(r, Math.max(0, 2000 - (Date.now() - t))));
  }
  fs.writeFileSync(path.join(dir, 'timeline.json'), `${JSON.stringify({ mac: mac.name, recorded_by: `housesitter ${VERSION}`, real: true, timeline }, null, 2)}\n`);
  say(`\n${timeline.length} frames and timeline.json in ${dir}${backAt ? '' : ' (the Mac did not come back while recording)'}.\nA video: ffmpeg -framerate 4 -pattern_type glob -i '${dir}/frame-*.jpg' -vf "scale=1280:-2" -pix_fmt yuv420p ${dir}/proof.mp4`);
  return backAt ? 0 : 1;
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  const code = e instanceof Refusal || e.code ? e.code : 'action-failed';
  if (json) emit({ ok: false, code, message: e.message, ...(e.available ? { available: e.available } : {}), ...(e.path ? { path: e.path } : {}) });
  else console.error(`housesitter: ${e.message}${e.available ? `\n  available: ${e.available.join(', ')}` : ''}`);
  process.exit(code === 'action-unavailable' || code === 'input-invalid' ? 2 : 1);
});
