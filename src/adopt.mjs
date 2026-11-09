// `housesitter adopt <mac>`: arrival day. You plug in three cables; this does the rest, step by step, and stops at
// the first thing that needs a person or a decision. It runs once from a computer on the KVM's network (the one LAN
// step); after it, you and your agents reach the KVM over the tailnet or the outbox.
//
//   housesitter adopt <mac> [--address <kvm ip>] [--notify ntfy|<url>] [--heartbeat <url>] [--dry-run] [--outbox] [--fake [--api-open]] [--json]
//
// Secrets, each copied once to the KVM over SSH stdin (never argv, logs or git), where the sitter seals it root-only
// to the KVM's own hardware ids: the KVM's admin password (generated here if the KVM is new), the Mac's password (so
// the sitter unlocks FileVault by itself), and, with --outbox, a gist-only GitHub token. A Tailscale auth key, if
// configured, is used once by `tailscale up` from a root-only file that is emptied right after.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPicture, httpsRequest, makeClient, withWarm } from './kvmd.mjs';
import { classifyScreen } from './screen.mjs';
import { DIR, knownHostsPath, sshKeyPath, sshRunner } from './sitter.mjs';
import { fakeWorld } from './fake.mjs';
import * as O from './outbox.mjs';

export const DEVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'device');
const GL_OUIS = ['94:83:c4', 'e4:95:6e'];
// ECDSA P-256, not ed25519: a GL-RM1PE on firmware V1.7.1 runs dropbear 2019.78, which refuses an ed25519 key it
// has in authorized_keys (seen on a real unit, 2026-11-08).
export const KEYGEN = ['-t', 'ecdsa', '-b', '256', '-N', ''];
const SYSTEMD = 'test -d /run/systemd/system';
const RESTART = `if ${SYSTEMD}; then systemctl restart housesitter; else /etc/init.d/S99housesitter restart; fi`;

export const defaultRefs = (name) => ({ admin: `keychain:housesitter/${name}-kvm-admin`, mac: `keychain:housesitter/${name}-mac-password`, outbox: `keychain:housesitter/${name}-outbox-token` });

export function newPassword(rand = crypto.randomBytes) {
  // GLKVM wants 10-63 characters with at least two of upper/lower/digit/symbol; give it all four.
  const pick = (set, n) => Array.from(rand(n), (b) => set[b % set.length]);
  const chars = [...pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 6), ...pick('abcdefghijkmnopqrstuvwxyz', 8), ...pick('23456789', 6), ...pick('_.+=', 4)];
  const r = rand(chars.length);
  for (let i = chars.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return pick('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', 1)[0] + chars.join('');
}

export function parseIfconfig(text) {
  const ips = [], macs = [];
  let ifc = null, ether = null;
  for (const line of String(text).split('\n')) {
    const h = line.match(/^(\w+):/);
    if (h) { ifc = h[1]; ether = null; continue; }
    const e = line.match(/^\s+ether\s+([0-9a-f:]{17})/);
    if (e) ether = e[1];
    const i = line.match(/^\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (i && i[1] !== '127.0.0.1' && !/^lo|^utun|^bridge|^awdl|^llw/.test(ifc || '')) { ips.push(i[1]); if (ether) macs.push(ether); }
  }
  return { ips: [...new Set(ips)], macs: [...new Set(macs)] };
}

async function storeSecret(x, name, value) {
  if (!value) return { ok: false, detail: `nothing to store for ${name}` };
  const r = await x.deps.ssh(`python3 ${DIR}/sitter.py store-secret ${name}`, value);
  if (r.status !== 0) return { ok: false, detail: `store-secret ${name} failed: ${String(r.stderr).slice(0, 160)}` };
  try { return { ok: true, ...JSON.parse(String(r.stdout).trim().split('\n').at(-1)) }; } catch { return { ok: false, detail: 'store-secret gave no receipt' }; }
}

export function steps() {
  return [
    {
      id: 'discover', title: 'Find the KVM on this network',
      async run(x) {
        const cands = x.address ? [x.address] : await x.deps.candidates();
        for (const a of cands) {
          try {
            const r = await x.deps.request({ url: `https://${a}/api/init/is_inited`, pin: null, timeoutMs: 4000 });
            if (r.status === 404) {
              const home = await x.deps.request({ url: `https://${a}/`, pin: null, timeoutMs: 4000 }).catch(() => null);
              if (!home || !/glkvm|gl\.inet|pikvm|kvm/i.test(home.body.toString('utf8'))) continue;
              x.apiClosed = true;
            } else if (r.status === 401 || r.status === 403) { x.inited = true; } // PiKVM: no first-run API, auth required
            else if (r.status !== 200) continue;
            if (!x.apiClosed && x.inited == null) x.inited = Boolean(JSON.parse(r.body.toString('utf8')).result?.is_inited);
            x.address = a; x.fingerprint = r.fingerprint;
            const want = x.expectFingerprint && x.expectFingerprint.toUpperCase().replace(/[^0-9A-F]/g, '');
            if (want && want !== x.fingerprint.replace(/:/g, '')) return { ok: false, stop: true, detail: `the KVM at ${a} shows certificate ${x.fingerprint}, not the one you read on the KVM itself (--fingerprint). Stopping: something else may be answering` };
            return { ok: true, detail: `KVM at ${a} (${x.apiClosed ? 'its REST API is off, as GL.iNet ships it' : x.inited ? 'already set up' : 'new, not set up yet'}); certificate ${x.fingerprint}${want ? ', the one you read on the KVM itself' : ' (trusted on first use: adopt on a network you trust, or pass --fingerprint with the one the KVM shows itself; docs/security.md)'}` };
          } catch { /* next */ }
        }
        return { ok: false, stop: true, detail: `no KVM answered (${cands.length} candidate${cands.length === 1 ? '' : 's'}: ${cands.join(', ') || 'none'}). Check its Ethernet and power lights, or pass --address <ip> from your router's client list.` };
      },
    },
    {
      id: 'credentials', title: "The KVM's admin password: generate it, keep it in your Keychain, set it",
      async run(x) {
        const have = x.deps.secrets.get(x.refs.admin);
        if (x.apiClosed) {
          if (have && (await x.deps.sshPassword(x, 'true')).status === 0) return { ok: true, detail: 'set up already; root SSH works with the stored password' };
          if (x.dryRun) return { ok: true, stop: true, detail: "dry run stops here: the KVM's first-run page has to set its password" };
          const pw = have || newPassword();
          if (!have) x.deps.secrets.set(x.refs.admin, pw);
          const done = await x.deps.firstRunPerson(x, pw);
          if (!done) return { ok: false, decision: true, stop: true, detail: `open https://${x.address}, paste the password from the clipboard into both fields and save, then run adopt again` };
          x.inited = true;
          return { ok: true, detail: 'first-run page done; root SSH works with the stored password' };
        }
        if (x.inited) {
          if (!have) return { ok: false, stop: true, detail: `the KVM is already set up and its admin password isn't stored (${x.refs.admin}). Store it with: housesitter secret ${x.name} kvm-admin` };
          return { ok: true, detail: `already set up; using ${x.refs.admin}` };
        }
        if (x.dryRun) return { ok: true, detail: 'would generate a password, store it, then call /api/init/init' };
        const pw = have || newPassword();
        if (!have) x.deps.secrets.set(x.refs.admin, pw);
        // GLKVM's first-run API takes the password in the query string (the vendor's design; TLS, on your LAN).
        const r = await x.deps.request({ url: `https://${x.address}/api/init/init?password=${encodeURIComponent(pw)}`, pin: x.fingerprint });
        if (r.status !== 200) return { ok: false, stop: true, detail: `/api/init/init -> HTTP ${r.status}` };
        x.inited = true;
        return { ok: true, detail: `admin password set (stored at ${x.refs.admin})` };
      },
    },
    {
      id: 'open-api', title: "Turn on the KVM's REST API (GL.iNet ships it off)",
      async run(x) {
        if (!x.apiClosed) return { ok: true, detail: 'already on' };
        if (x.dryRun) return { ok: true, stop: true, detail: 'would add our SSH key, uncomment the /api blocks in /etc/kvmd/nginx-kvmd.conf and restart nginx' };
        const pub = x.deps.sshPublicKey(x.name);
        let r = await x.deps.sshPassword(x, `mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && (grep -qF "${pub.split(' ')[1]}" /root/.ssh/authorized_keys || cat >> /root/.ssh/authorized_keys)`, `${pub}\n`);
        if (r.status !== 0) return { ok: false, stop: true, detail: `could not add our SSH key: ${String(r.stderr).slice(0, 160)}` };
        x.sshReady = true;
        r = await x.deps.ssh(`mkdir -p ${DIR} && chmod 700 ${DIR} && cat > ${DIR}/sitter.py && python3 ${DIR}/sitter.py enable-api && (for s in /etc/init.d/S*nginx*; do [ -x "$s" ] && "$s" restart; done; command -v systemctl >/dev/null && systemctl restart kvmd-nginx; true)`, x.deps.readDevice('sitter.py'));
        if (r.status !== 0) return { ok: false, stop: true, detail: `enable-api failed: ${String(r.stderr || r.stdout).slice(0, 200)}` };
        await x.deps.sleep(3000);
        const probe = await x.deps.request({ url: `https://${x.address}/api/info`, pin: x.fingerprint, timeoutMs: 5000 }).catch(() => null);
        if (!probe || probe.status === 404) return { ok: false, stop: true, detail: 'still 404 after enabling: the block may be named differently on this firmware (see /etc/kvmd/nginx-kvmd.conf; the original is kept as .orig-housesitter)' };
        x.apiClosed = false;
        return { ok: true, detail: 'on; a firmware update can turn it off again (run adopt again after one). The sitter never needs it: it talks to kvmd\'s own socket' };
      },
    },
    {
      id: 'login', title: 'Log in, then record the endpoint and the pinned certificate',
      async run(x) {
        if (x.dryRun && !x.inited) return { ok: true, stop: true, detail: 'dry run stops here: the KVM is not set up yet' };
        x.client = makeClient({ base: `https://${x.address}`, pin: x.fingerprint, user: 'admin', password: () => x.deps.secrets.get(x.refs.admin) || '', request: x.deps.request, warm: x.deps.warm ?? null });
        try { x.info = await x.client.info(); } catch (e) { return { ok: false, stop: true, detail: `login failed: ${e.message}` }; }
        if (!x.dryRun) x.deps.saveMac((m) => {
          m.kvm = m.kvm || {};
          const e = { label: 'LAN', url: `https://${x.address}`, fallback: true };
          m.kvm.endpoints = [...(m.kvm.endpoints || []).filter((v) => v.url !== e.url), e];
          m.kvm.tls_sha256 = x.fingerprint; m.kvm.user = 'admin'; m.kvm.admin_password = x.refs.admin;
          m.mac_password = m.mac_password || x.refs.mac;
        });
        return { ok: true, detail: `${[x.info?.hw?.platform?.model, x.info?.system?.kvmd?.version].filter(Boolean).join(' ') || 'kvmd'}; ${x.dryRun ? 'would record' : 'recorded'} the LAN endpoint and certificate` };
      },
    },
    {
      id: 'keyboard', title: "The KVM's USB is the Mac's keyboard",
      async run(x) {
        const h = await x.client.hid();
        return (h?.keyboard?.online ?? h?.online) ? { ok: true, detail: 'keyboard online' } : { ok: false, stop: true, detail: "keyboard offline: plug the KVM's USB into a port on the Mac itself, not a dock or hub (pre-boot only sees the Mac's own ports)" };
      },
    },
    {
      id: 'video', title: 'An HDMI picture, at whatever the Mac sends',
      async run(x) {
        const src = await withWarm(x.client.warm, async () => {
          let last = {};
          for (let i = 0; i < 6; i++) {
            const s = await x.client.streamer();
            last = s?.streamer?.source || s?.source || {};
            if (hasPicture(last)) return last;
            await x.deps.sleep(1000);
          }
          return { ...last, online: false };
        });
        if (!src.online) return { ok: false, detail: "no HDMI picture (no frames). Plug the KVM's HDMI into the Mac itself (its HDMI port, or a USB-C-to-HDMI adapter), not a dock. Adopt carries on: the sitter and its secrets don't need the picture" };
        const w = src.resolution?.width || 0;
        const res = src.resolution ? `${src.resolution.width}x${src.resolution.height}` : '?';
        // Any mode is fine. Never change the KVM's EDID or the Mac's display settings to suit the KVM: an EDID change on
        // a live Mac mini hung it (2026-11-08). The sitter reads whatever arrives.
        return { ok: w > 0, detail: `signal ${res}; housesitter never changes it` };
      },
    },
    {
      id: 'virtual-media', title: 'Virtual media off (it can hide the keyboard at the FileVault screen)',
      async run(x) {
        const o = await x.client.otg().catch(() => null);
        if (!o) return { ok: true, detail: 'not readable on this firmware; check by hand' };
        if (!(o.start_cdrom || o.start_flash)) return { ok: true, detail: 'already off' };
        if (x.dryRun) return { ok: true, detail: 'would turn virtual media off' };
        await x.client.setOtg({ start_cdrom: 'false', start_flash: 'false' });
        return { ok: true, detail: 'turned off' };
      },
    },
    {
      id: 'eyes', title: "The KVM reads the Mac's screen",
      async run(x) {
        const text = await x.client.ocr().catch(() => null);
        const s = classifyScreen(text, { userNames: x.mac.user_names || [] });
        if (s.kind !== 'unknown') return { ok: true, detail: `with kvmd's OCR: the screen reads as ${s.kind} (${s.why})` };
        x.eyesWithoutOcr = true;
        return { ok: true, detail: "kvmd's OCR doesn't work here (a GL.iNet Comet at 2K hands back H.264), so the sitter decodes frames on the KVM itself and types only at a password prompt you teach it (learn-prompt); checked once the sitter is installed" };
      },
    },
    {
      id: 'outbox', title: 'The GitHub outbox (optional): two secret gists, status out and requests in',
      async run(x) {
        if (!x.outbox) return { ok: true, skipped: true, detail: 'skipped (add --outbox to reach the sitter from anywhere with only GitHub)' };
        if (x.mac.outbox?.gist && x.mac.outbox?.inbox) return { ok: true, detail: 'already there' };
        if (x.dryRun) return { ok: true, detail: 'would create two secret gists with your gh token and record them' };
        const ids = await x.deps.createGists(x.name);
        x.mac.outbox = { ...(x.mac.outbox || {}), ...ids, token: x.mac.outbox?.token || x.refs.outbox };
        x.deps.saveMac((m) => { m.outbox = x.mac.outbox; });
        return { ok: true, detail: `created (outbox ${ids.gist.slice(0, 7)}…, inbox ${ids.inbox.slice(0, 7)}…)` };
      },
    },
    {
      id: 'notify', title: 'Where it messages you when it needs you',
      async run(x) {
        if (x.notify) {
          const url = x.notify === 'ntfy' ? `https://ntfy.sh/housesitter-${x.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${crypto.randomBytes(9).toString('hex')}` : x.notify;
          if (!/^https:\/\/\S+$/.test(url)) return { ok: false, stop: true, detail: `--notify takes ntfy (a private ntfy.sh topic made for you) or an https URL (got ${x.notify})` };
          x.mac.notify = { kind: /^https:\/\/ntfy\./.test(url) ? 'ntfy' : 'webhook', url };
        }
        if (x.heartbeat) {
          if (!/^https:\/\/\S+$/.test(x.heartbeat)) return { ok: false, stop: true, detail: `--heartbeat takes an https URL to ping every minute (got ${x.heartbeat})` };
          x.mac.heartbeat = { url: x.heartbeat };
        }
        if ((x.notify || x.heartbeat) && !x.dryRun) x.deps.saveMac((m) => { if (x.mac.notify) m.notify = x.mac.notify; if (x.mac.heartbeat) m.heartbeat = x.mac.heartbeat; });
        const dms = x.mac.heartbeat?.url ? `; it pings ${new URL(x.mac.heartbeat.url).host} every minute, which tells you if the KVM itself goes quiet` : '; for word when the KVM itself dies, add --heartbeat <a healthchecks.io ping URL>';
        const n = x.mac.notify;
        if (!n?.url) return { ok: false, decision: true, detail: `nowhere yet, so it can fix things but can't tell you when it can't. Run adopt again with --notify ntfy (a private ntfy.sh topic for your phone) or --notify <webhook URL>${dms}` };
        return { ok: true, detail: `${n.kind === 'ntfy' ? `ntfy: subscribe to ${n.url.replace(/^https:\/\//, '')} in the ntfy app (the topic's name is its only lock, so keep it to yourself)` : `webhook: ${new URL(n.url).host}`}${dms}` };
      },
    },
    {
      id: 'sitter', title: 'Install the sitter on the KVM',
      async run(x) {
        if (x.dryRun) return { ok: true, detail: 'would install sitter.py and its service (systemd or BusyBox init, whichever the KVM runs)' };
        if (!x.sshReady) {
          const r = await x.deps.addKey(x);
          if (!r.ok) return { ok: false, stop: true, detail: r.detail };
        }
        const net = parseIfconfig(x.macIfconfig || '');
        if (x.location && !['home', 'away'].includes(x.location)) return { ok: false, stop: true, detail: `--location is home (the LAN may reach the KVM) or away (only the tailnet may); got ${x.location}` };
        if (x.location) x.deps.saveMac((m) => { m.location = x.location; });
        const config = {
          name: x.name, interval_sec: 60, kvmd_user: 'admin', user_names: x.mac.user_names || [], mac_ips: net.ips, mac_macs: net.macs,
          unlock: x.mac.unlock !== false, location: x.location || x.mac.location || 'home', power: x.mac.power || null, notify: x.mac.notify || null, health: x.mac.health || null, heartbeat: x.mac.heartbeat || null,
          outbox: x.mac.outbox?.gist ? { gist: x.mac.outbox.gist, inbox: x.mac.outbox.inbox, poll_sec: 2, beat_min: 10 } : null,
        };
        let r = await x.deps.ssh(`mkdir -p ${DIR} && chmod 700 ${DIR} && cat > ${DIR}/sitter.py`, x.deps.readDevice('sitter.py'));
        if (r.status !== 0) return { ok: false, stop: true, detail: `ssh to the KVM failed: ${String(r.stderr).slice(0, 200)}` };
        await x.deps.ssh(`umask 077; cat > ${DIR}/config.json`, JSON.stringify(config, null, 2));
        const s = await storeSecret(x, 'kvmd', x.deps.secrets.get(x.refs.admin));
        if (!s.ok) return { ok: false, stop: true, detail: `admin password: ${s.detail}` };
        const init = String((await x.deps.ssh(`if ${SYSTEMD}; then echo systemd; else echo busybox; fi`)).stdout).trim();
        if (init === 'systemd') {
          await x.deps.ssh('cat > /etc/systemd/system/housesitter.service', x.deps.readDevice('housesitter.service'));
          r = await x.deps.ssh('systemctl daemon-reload && systemctl enable housesitter');
        } else {
          r = await x.deps.ssh('cat > /etc/init.d/S99housesitter && chmod 755 /etc/init.d/S99housesitter', x.deps.readDevice('S99housesitter'));
        }
        if (r.status !== 0) return { ok: false, stop: true, detail: `service install failed: ${String(r.stderr || r.stdout).slice(0, 200)}` };
        return { ok: true, detail: `${init === 'systemd' ? 'systemd unit' : 'BusyBox init script'}; watching the screen${net.ips.length ? `, ${net.ips.join(', ')}` : ''}${x.mac.power ? ' and the plug' : ''}${net.ips.length ? '' : ' (run adopt on the Mac itself with --this-mac to watch its network too)'}${x.mac.power ? '' : '; no smart plug, so a hang gets a message, not a power cycle'}` };
      },
    },
    {
      id: 'mac-password', title: "The Mac's password onto the sitter, so it unlocks FileVault by itself",
      async run(x) {
        if (x.mac.unlock === false) return { ok: true, skipped: true, detail: 'turned off ("unlock": false)' };
        const ref = x.mac.mac_password || x.refs.mac;
        if (!x.deps.secrets.has(ref)) return { ok: false, decision: true, detail: `no Mac password stored at ${ref}. Store it with: housesitter secret ${x.name} mac-password, then run adopt again` };
        if (x.dryRun) return { ok: true, detail: `would copy ${ref} to the sitter over SSH stdin (sealed, root-only)` };
        const r = await storeSecret(x, 'mac', x.deps.secrets.get(ref));
        return r.ok ? { ok: true, detail: `stored, sealed to the KVM's ${r.bound_to} ids, root-only; never in argv or logs. Typing stays disarmed until one supervised trial works: housesitter unlock ${x.name} --trial` } : { ok: false, detail: r.detail };
      },
    },
    {
      id: 'outbox-token', title: "The sitter's own gist-only GitHub token",
      async run(x) {
        if (!x.mac.outbox?.gist) return { ok: true, skipped: true, detail: 'skipped (no outbox)' };
        const ref = x.mac.outbox.token || x.refs.outbox;
        if (!x.deps.secrets.has(ref)) return { ok: false, decision: true, detail: `no token at ${ref}. Make a fine-grained or classic token with only the gist scope, store it with: housesitter secret ${x.name} outbox-token, then run adopt again` };
        if (x.dryRun) return { ok: true, detail: 'would copy the token to the sitter (sealed, root-only)' };
        const r = await storeSecret(x, 'outbox', x.deps.secrets.get(ref));
        return r.ok ? { ok: true, detail: `stored (sealed to the KVM's ${r.bound_to} ids)` } : { ok: false, detail: r.detail };
      },
    },
    {
      id: 'start', title: 'Start the sitter and take one look',
      async run(x) {
        if (x.dryRun) return { ok: true, detail: 'would start the sitter and run one look' };
        // The KVM reads its own certificate: a second look at the fingerprint, over SSH rather than TLS.
        const fp = await x.deps.ssh(`python3 ${DIR}/sitter.py fingerprint`);
        let own = {};
        try { own = JSON.parse(String(fp.stdout).trim()); } catch { /* reported below */ }
        if (own.sha256 && x.fingerprint && own.sha256 !== x.fingerprint) return { ok: false, stop: true, detail: `the KVM's own certificate (${own.sha256}) isn't the one pinned over HTTPS (${x.fingerprint}). Stopping: something sits between you and the KVM` };
        const r = await x.deps.ssh(`${RESTART} && sleep 2 && python3 ${DIR}/sitter.py secrets && python3 ${DIR}/sitter.py once`);
        if (r.status !== 0) return { ok: false, detail: `did not start: ${String(r.stderr || r.stdout).slice(0, 200)}` };
        const lines = String(r.stdout).trim().split('\n');
        let sec = {}, first = {};
        try { sec = JSON.parse(lines[0]); first = JSON.parse(lines.at(-1)); } catch { /* shown below */ }
        let eyes = '';
        if (x.eyesWithoutOcr) {
          const e = await x.deps.ssh(`python3 ${DIR}/sitter.py eyes`);
          let j = {};
          try { j = JSON.parse(String(e.stdout).trim().split('\n').at(-1)); } catch { /* reported below */ }
          if (!j.frame) return { ok: false, detail: `the sitter can't see the Mac: no OCR, and no frame decoded on the KVM (${j.frame_error || String(e.stderr).slice(0, 120) || '?'})` };
          eyes = `; eyes: frames decoded on the KVM (${(j.size || []).join('x')}, ${j.frame})`;
        }
        let hello = '';
        if (x.mac.notify?.url) {
          const h = await x.deps.ssh(`python3 ${DIR}/sitter.py hello`);
          hello = h.status === 0 ? '; sent you a hello, so check your phone' : `; the hello didn't arrive (${String(h.stdout || h.stderr).trim().slice(0, 120)}): check the --notify address`;
        }
        return { ok: Boolean(sec.kvmd) && (Boolean(sec.mac) || x.mac.unlock === false), detail: `secrets ${Object.entries(sec).map(([k, v]) => `${k} ${v ? '✓' : '✗'}`).join(', ')}; first look: ${first.state || '?'}; it can ${Object.entries(first.can || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || '?'}${eyes}${hello}` };
      },
    },
    {
      id: 'tailnet', title: 'Join your tailnet, tagged, so it reaches nothing and you reach it from anywhere',
      async run(x) {
        const t = x.mac.tailscale;
        if (!t?.authkey) return { ok: true, skipped: true, detail: `skipped: to reach it from anywhere, add "tailscale": {"tag": "tag:kvm", "authkey": "keychain:…"} to ${x.name} in ${x.configFile || '~/.config/housesitter/config.json'} (docs/tailscale.md)` };
        if (!/^tag:[a-z0-9-]+$/.test(t.tag || '')) return { ok: false, detail: `tailscale.tag must look like tag:kvm (got ${t.tag})` };
        if (!x.deps.secrets.has(t.authkey)) return { ok: false, decision: true, detail: `no auth key at ${t.authkey} (make a tagged, pre-approved key in the Tailscale admin console)` };
        const hostname = String(t.hostname || `kvm-${x.name}`).toLowerCase().replace(/[^a-z0-9-]/g, '-');
        if (x.dryRun) return { ok: true, detail: `would join as ${hostname} with ${t.tag}` };
        let r = await x.deps.ssh(`umask 077; cat > ${DIR}/ts.key`, x.deps.secrets.get(t.authkey));
        if (r.status !== 0) return { ok: false, detail: `could not stage the key: ${String(r.stderr).slice(0, 160)}` };
        r = await x.deps.ssh(`tailscale up --auth-key=file:${DIR}/ts.key --hostname=${hostname} --advertise-tags=${t.tag} --accept-dns=false --accept-routes=false; rc=$?; : > ${DIR}/ts.key; exit $rc`);
        if (r.status !== 0) return { ok: false, detail: `tailscale up failed: ${String(r.stderr || r.stdout).replace(/tskey-[\w-]+/g, 'tskey-…').slice(0, 200)}` };
        r = await x.deps.ssh('tailscale status --json --peers=false');
        let j = {};
        try { j = JSON.parse(r.stdout); } catch { /* below */ }
        const dns = String(j.Self?.DNSName || '').replace(/\.$/, '');
        if (!dns) return { ok: false, detail: `joined, but tailscale has no name yet (${j.BackendState || 'no status'})` };
        if (!(j.Self?.Tags || []).includes(t.tag)) return { ok: false, detail: `joined as ${dns} but without ${t.tag}: the auth key must be tagged` };
        x.deps.saveMac((m) => { const e = { label: 'tailnet', url: `https://${dns}` }; m.kvm.endpoints = [e, ...(m.kvm.endpoints || []).filter((v) => v.url !== e.url)]; });
        return { ok: true, detail: `${dns} (${(j.Self?.TailscaleIPs || []).join(', ')}), ${t.tag}; recorded as the first endpoint` };
      },
    },
    {
      // After the tailnet step: away from home, the KVM may only be reached over the tailnet, so it must have joined it.
      id: 'harden', title: "Harden the KVM: GL.iNet's cloud off (read back), and SSH and HTTPS only from where they should come",
      async run(x) {
        if (x.dryRun) return { ok: true, detail: `would turn GL.iNet's cloud binding off and check it, then allow SSH and HTTPS from ${(x.location || x.mac.location || 'home') === 'home' ? 'the LAN and the tailnet' : 'the tailnet only'}` };
        const hd = await x.deps.ssh(`python3 ${DIR}/sitter.py harden`);
        if (hd.status !== 0) return { ok: false, stop: true, detail: `not hardened: ${String(hd.stderr || hd.stdout).trim().slice(0, 200)}` };
        let j = {};
        try { j = JSON.parse(String(hd.stdout).trim().split('\n').at(-1)); } catch { /* shown raw */ }
        return { ok: true, detail: j.gl_cloud ? `GL cloud ${j.gl_cloud}; ${j.ingress}` : String(hd.stdout).trim().slice(0, 200) };
      },
    },
    {
      id: 'next', title: 'Prove it: restart the Mac and watch the sitter unlock it',
      async run(x) {
        return { ok: true, next: true, detail: `lock the Mac, check housesitter look ${x.name} shows the lock screen, then housesitter learn-prompt ${x.name} --i-see-the-field and housesitter unlock ${x.name} --trial. Then housesitter proof ${x.name} --record ./proof and restart the Mac (Apple menu > Restart): it records what the KVM sees until the Mac is back` };
      },
    },
  ];
}

export async function adopt(x) {
  const results = [];
  for (const s of steps()) {
    let r;
    try { r = await s.run(x); } catch (e) { r = { ok: false, stop: true, detail: e.message }; }
    if (s.id === 'discover' && r.ok) x.deps.bind?.(x);
    results.push({ id: s.id, title: s.title, ...r });
    x.say(`${r.next ? '→' : r.skipped ? '○' : r.ok ? '✓' : r.decision ? '…' : '✗'} ${s.title}\n    ${r.detail}`);
    if (r.stop) break;
  }
  return results;
}

// ---------- the worlds ----------

// The rehearsal plays the KVM we have: a GL.iNet Comet as it ships (API off), driving 2560x1440, with no working OCR.
export function fakeDeps({ apiClosed = true, comet = true } = {}) {
  const w = fakeWorld({ apiClosed, inited: false, ...(comet ? { resolution: [2560, 1440], ocr: false } : {}) });
  const vault = { 'keychain:housesitter/studio-mac-password': 'correct horse' };
  const s = { ssh: [], files: {}, secretsOnKvm: {}, rootKeys: [], init: 'busybox', saved: {}, firstRun: 0 };
  return {
    world: w, s,
    deps: {
      request: w.request,
      warm: false,
      candidates: async () => ['192.168.1.20', '192.168.1.50'].slice(1),
      secrets: { get: (r) => vault[r] ?? null, has: (r) => vault[r] != null, set: (r, v) => { vault[r] = v; } },
      sleep: async () => {},
      readDevice: (f) => `# ${f}\n`,
      sshPublicKey: () => 'ecdsa-sha2-nistp256 AAAAfake housesitter studio',
      async firstRunPerson(x, pw) {
        x.say(`    Next, its admin password. The KVM's first-run page would open now. You'd paste (Cmd+V) into both password fields and save: the password is on the clipboard and stored at ${x.refs.admin}. (Rehearsal: pasted for you.)`);
        s.firstRun++; w.st.adminPassword = pw; w.st.inited = true; return true;
      },
      async sshPassword(x, cmd, input) {
        if (!w.st.adminPassword || vault[x.refs.admin] !== w.st.adminPassword) return { status: 255, stdout: '', stderr: 'Permission denied' };
        if (input && cmd.includes('authorized_keys')) s.rootKeys.push(input.trim());
        return { status: 0, stdout: '', stderr: '' };
      },
      async addKey() { s.rootKeys.push('ecdsa-sha2-nistp256 AAAAfake'); return { ok: true }; },
      async ssh(cmd, input) {
        s.ssh.push(cmd.replace(/tskey-[\w-]+/g, 'tskey-…'));
        if (!s.rootKeys.length) return { status: 255, stdout: '', stderr: 'Permission denied (publickey)' };
        if (cmd.includes('enable-api')) { w.st.apiClosed = false; return { status: 0, stdout: '{"opened_blocks": 1}\n', stderr: '' }; }
        const m = cmd.match(/sitter\.py store-secret (\w+)$/);
        if (m) { s.secretsOnKvm[m[1]] = input; return { status: 0, stdout: `${JSON.stringify({ stored: m[1], chars: input.length, bound_to: 'hardware' })}\n`, stderr: '' }; }
        if (cmd.startsWith('if test -d /run/systemd/system; then echo')) return { status: 0, stdout: `${s.init}\n`, stderr: '' };
        const f = cmd.match(/cat > (\S+)/);
        if (f) { s.files[f[1]] = input; return { status: 0, stdout: '', stderr: '' }; }
        if (cmd.includes('sitter.py secrets')) {
          const cfg = JSON.parse(Object.entries(s.files).find(([f]) => f.endsWith('/config.json'))?.[1] || '{}');
          return { status: 0, stdout: `${JSON.stringify({ mac: Boolean(s.secretsOnKvm.mac), kvmd: Boolean(s.secretsOnKvm.kvmd), outbox: Boolean(s.secretsOnKvm.outbox) })}\n${JSON.stringify({ state: 'healthy', can: { unlock: false, plug: Boolean(cfg.power), notify: Boolean(cfg.notify?.url) } })}\n`, stderr: '' };
        }
        if (cmd.includes('sitter.py fingerprint')) return { status: 0, stdout: `${JSON.stringify({ path: '/etc/kvmd/nginx/ssl/server.crt', sha256: w.pin })}\n`, stderr: '' };
        if (cmd.includes('sitter.py harden')) {
          const away = JSON.parse(Object.entries(s.files).find(([f]) => f.endsWith('/config.json'))?.[1] || '{}').location === 'away';
          if (s.hardenFails) return { status: 1, stdout: '', stderr: "harden: GL.iNet's cloud binding did not read back as disabled" };
          if (away && !s.ssh.some((c) => c.startsWith('tailscale up'))) return { status: 1, stdout: '', stderr: "harden: refusing tailnet-only SSH and HTTPS: this KVM hasn't joined a running tailnet, so nothing could reach it" };
          return { status: 0, stdout: `{"gl_cloud": "off (read back)", "ingress": "SSH and HTTPS from ${away ? 'the tailnet only (tailscale0)' : 'the LAN and the tailnet'}"}\n`, stderr: '' };
        }
        if (cmd.includes('sitter.py eyes')) return { status: 0, stdout: `${JSON.stringify({ mode: [2560, 1440], ocr: null, frame: 'desktop', size: [2560, 1440] })}\n`, stderr: '' };
        if (cmd.includes('sitter.py hello')) { s.hello = (s.hello || 0) + 1; return { status: 0, stdout: '{"sent": "posted 200"}\n', stderr: '' }; }
        return { status: 0, stdout: '', stderr: '' };
      },
      createGists: async () => ({ gist: 'fake0utb0x', inbox: 'fake1nb0x' }),
      saveMac: (fn) => fn(s.saved),
    },
  };
}

export function realDeps(name, { secrets, saveMac }) {
  const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts });
  let ssh = null;
  let address = null;
  return {
    bind(x) { address = x.address; },
    request: httpsRequest,
    secrets,
    saveMac,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async candidates() {
      const out = [];
      for (const n of ['glkvm.local', 'pikvm.local']) for (const ip of (sh('/usr/bin/dscacheutil', ['-q', 'host', '-a', 'name', n]).stdout || '').matchAll(/ip_address:\s*(\S+)/g)) out.push(ip[1]);
      for (const l of (sh('/usr/sbin/arp', ['-an']).stdout || '').split('\n')) {
        const a = l.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)/i);
        if (a && GL_OUIS.some((o) => a[2].toLowerCase().split(':').map((b) => b.padStart(2, '0')).join(':').startsWith(o))) out.push(a[1]);
      }
      return [...new Set(out)];
    },
    readDevice: (f) => fs.readFileSync(path.join(DEVICE, f), 'utf8'),
    sshPublicKey(n) {
      const key = sshKeyPath(n);
      if (!fs.existsSync(key)) { fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 }); sh('/usr/bin/ssh-keygen', [...KEYGEN, '-C', `housesitter ${n}`, '-f', key]); }
      return fs.readFileSync(`${key}.pub`, 'utf8').trim();
    },
    // Our key into root's authorized_keys through kvmd's own API (GLKVM /api/system/ssh_key), keeping any already there.
    async addKey(x) {
      const pub = this.sshPublicKey(name);
      const h = { 'X-KVMD-User': 'admin', 'X-KVMD-Passwd': secrets.get(x.refs.admin) };
      const r0 = await httpsRequest({ url: `https://${x.address}/api/system/ssh_key`, pin: x.fingerprint, headers: h });
      const existing = r0.status === 200 ? (JSON.parse(r0.body.toString('utf8')).result?.ssh_key || '') : '';
      if (!existing.includes(pub)) {
        const r = await httpsRequest({ url: `https://${x.address}/api/system/ssh_key`, method: 'POST', pin: x.fingerprint, headers: { ...h, 'Content-Type': 'text/plain' }, body: `${[existing.trim(), pub].filter(Boolean).join('\n')}\n` });
        if (r.status !== 200) return { ok: false, detail: `could not add our SSH key through the KVM's API (HTTP ${r.status}); on PiKVM, add ~/.ssh/housesitter-${name}-ecdsa.pub to root's authorized_keys by hand once` };
      }
      return { ok: true };
    },
    async ssh(cmd, input) { ssh ??= sshRunner(name, address); return ssh(cmd, input); },
    // root's password on GLKVM is the admin password. It reaches ssh only through SSH_ASKPASS, which reads it from the
    // secret store itself: never argv, the environment or a file.
    async sshPassword(x, cmd, input) {
      const r = spawnSync('/usr/bin/ssh', ['-o', `UserKnownHostsFile=${knownHostsPath(name)}`, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=8', `root@${x.address}`, cmd], {
        encoding: 'utf8', input: input ?? '', timeout: 60000,
        env: { ...process.env, SSH_ASKPASS: path.join(DEVICE, '..', 'bin', 'askpass.mjs'), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0', HOUSESITTER_ASKPASS_REF: x.refs.admin },
      });
      return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    async firstRunPerson(x, pw) {
      sh('/usr/bin/pbcopy', [], { input: pw });
      sh('/usr/bin/open', [`https://${x.address}/`]);
      x.say(`    Next, its admin password. The KVM's first-run page is open. Paste (Cmd+V) into both password fields and save: the password is on the clipboard and stored at ${x.refs.admin}. Waiting up to 5 minutes…`);
      for (let i = 0; i < 30; i++) {
        if ((await this.sshPassword(x, 'true')).status === 0) { sh('/usr/bin/pbcopy', [], { input: '' }); return true; }
        await new Promise((r) => setTimeout(r, 10000));
      }
      sh('/usr/bin/pbcopy', [], { input: '' });
      return false;
    },
    async createGists(n) { return O.createGists(n, O.gistClient({ token: O.ghCliToken })); },
  };
}

export function hostIfconfig() { return spawnSync('/sbin/ifconfig', [], { encoding: 'utf8' }).stdout || ''; }
