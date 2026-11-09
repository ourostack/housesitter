// The smart plug on the Mac's power cord: a Shelly Gen2+ (tested against Shelly's documented RPC; a Plug US Gen4 is the
// one we run). `housesitter plug <mac> find|adopt [ip]|status|prove`. The sitter on the KVM is the only thing that
// switches it, and only through its guard and budgets; this file sets it up and reads it.
//   find:   asks every address on this computer's LAN for /shelly (no password needed there).
//   adopt:  power back on after an outage, no auto-off, Shelly's cloud off, Bluetooth RPC on (for a network the plug
//           can't join), a password of its own (made here, kept in your secret store, never in argv or a file), then
//           every setting read back. Records it in your config and hands it to the sitter: the password sealed on the
//           KVM as "plug", the address and the plug's MAC (so the sitter finds it again if DHCP moves it). Then the
//           sitter reads the plug itself.
//   status: the plug from here (found again by its MAC if it moved) and from the sitter.
//   prove:  one real 10 s power cut through the sitter (you must say --attended): the Mac boots by itself, FileVault,
//           the sitter unlocks it, and the KVM itself stays up. Only the Mac's cord may be on the plug.

import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Shelly Gen2+ HTTP digest (RFC 7616, SHA-256), the same as the sitter's shelly_digest.
export function digestHeader(challenge, method, uri, password, { user = 'admin', cnonce = crypto.randomBytes(8).toString('hex'), nc = 1 } = {}) {
  const f = Object.fromEntries([...String(challenge || '').matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
  const ha1 = sha(`${user}:${f.realm || ''}:${password}`);
  const ncs = nc.toString(16).padStart(8, '0');
  const resp = sha(`${ha1}:${f.nonce || ''}:${ncs}:${cnonce}:auth:${sha(`${method}:${uri}`)}`);
  return `Digest username="${user}", realm="${f.realm || ''}", nonce="${f.nonce || ''}", uri="${uri}", algorithm=SHA-256, response="${resp}", qop=auth, nc=${ncs}, cnonce="${cnonce}"`;
}

export function httpReq({ host, path: p, method = 'GET', body = null, headers = {}, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: 80, path: p, method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// One JSON-RPC call (POST /rpc), answering a 401 with the password when there is one.
export async function rpc(host, method, params = {}, { password = null, request = httpReq } = {}) {
  const body = JSON.stringify({ id: 1, src: 'housesitter', method, params });
  let r = await request({ host, path: '/rpc', method: 'POST', body });
  if (r.status === 401) {
    if (!password) throw new Error(`plug ${host}: ${method} needs the plug's password`);
    r = await request({ host, path: '/rpc', method: 'POST', body, headers: { Authorization: digestHeader(r.headers['www-authenticate'], 'POST', '/rpc', password) } });
  }
  const j = JSON.parse(r.body || '{}');
  if (r.status !== 200 || j.error) throw new Error(`plug ${host}: ${method}: ${j.error?.message || `HTTP ${r.status}`}`);
  return j.result ?? j;
}

export async function shellyInfo(ip, { request = httpReq, timeoutMs = 700 } = {}) {
  try {
    const r = await request({ host: ip, path: '/shelly', timeoutMs });
    const j = JSON.parse(r.body);
    return j && (j.id || j.mac) ? { ip, ...j } : null;
  } catch { return null; }
}

export function lanPrefix(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address)) return a.address.split('.').slice(0, 3).join('.');
  return null;
}

export async function find({ prefix = lanPrefix(), probe = shellyInfo, width = 64 } = {}) {
  if (!prefix) throw new Error('plug: no private IPv4 network on this computer to look on');
  const ips = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
  const found = [];
  for (let i = 0; i < ips.length; i += width) found.push(...(await Promise.all(ips.slice(i, i + width).map((ip) => probe(ip)))).filter(Boolean));
  return found;
}

export const isPlug = (d) => /plug/i.test(`${d.app || ''} ${d.model || ''} ${d.id || ''}`);
const sameMac = (a, b) => String(a || '').replace(/[:-]/g, '').toUpperCase() === String(b || '').replace(/[:-]/g, '').toUpperCase();

// The settings that make it safe on a Mac's power cord, then read back. Returns what the plug now says.
export async function configure(ip, info, password, { call = rpc, name = 'mac-power' } = {}) {
  const o = { password };
  const devAuth = info.auth_en === true;
  const steps = [];
  const set = async (m, p) => { await call(ip, m, p, devAuth || steps.includes('Shelly.SetAuth') ? o : {}); steps.push(m); };
  await set('Switch.SetConfig', { id: 0, config: { name, initial_state: 'on', auto_on: false, auto_off: false } });
  await set('Sys.SetConfig', { config: { device: { name } } });
  await set('Cloud.SetConfig', { config: { enable: false } });
  await set('BLE.SetConfig', { config: { enable: true, rpc: { enable: true } } });
  if (!devAuth) await set('Shelly.SetAuth', { user: 'admin', realm: info.id, ha1: sha(`admin:${info.id}:${password}`) });
  const sw = await call(ip, 'Switch.GetConfig', { id: 0 }, o);
  const cloud = await call(ip, 'Cloud.GetConfig', {}, o);
  const ble = await call(ip, 'BLE.GetConfig', {}, o);
  const dev = await call(ip, 'Shelly.GetDeviceInfo', {}, o);
  const st = await call(ip, 'Switch.GetStatus', { id: 0 }, o);
  const checks = {
    'on after an outage': sw.initial_state === 'on',
    'no auto-off': !sw.auto_off,
    'cloud off': cloud.enable === false,
    'Bluetooth RPC on': ble.enable === true && ble.rpc?.enable === true,
    'password set': dev.auth_en === true,
  };
  return { ok: Object.values(checks).every(Boolean), checks, on: Boolean(st.output), watts: st.apower ?? null, mac: dev.mac || info.mac || null, steps };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The sitter's side: the password sealed as "plug", the plug in its config.json, the sitter restarted, then the sitter
// reads the plug itself (plug-status). `ssh(cmd, input)` runs on the KVM; `dir` is the sitter's home there.
export async function handToSitter(power, password, ssh, { dir = '/etc/kvmd/user/housesitter' } = {}) {
  const env = dir === '/etc/kvmd/user/housesitter' ? '' : `HOUSESITTER_HOME=${quote(dir)} `;
  const sealed = await ssh(`${env}python3 ${dir}/sitter.py store-secret plug`, `${password}\n`);
  if (sealed.status !== 0) throw new Error(`the sitter didn't seal the plug's password: ${String(sealed.stderr || sealed.stdout).slice(0, 160)}`);
  const py = `import json; p=${JSON.stringify(`${dir}/config.json`)}; c=json.load(open(p)); c["power"]=json.loads(${JSON.stringify(JSON.stringify(power))}); f=open(p+".new","w"); json.dump(c, f, indent=2); f.close()`;
  const conf = await ssh(`python3 -c ${quote(py)} && mv ${dir}/config.json.new ${dir}/config.json && chmod 600 ${dir}/config.json && (systemctl restart housesitter 2>/dev/null || /etc/init.d/S99housesitter restart >/dev/null 2>&1; true); sleep 2`);
  if (conf.status !== 0) throw new Error(`the sitter's config wasn't updated: ${String(conf.stderr).slice(0, 160)}`);
  const r = await ssh(`${env}python3 ${dir}/sitter.py plug-status`);
  try { return JSON.parse(String(r.stdout).trim().split('\n').at(-1)); } catch { throw new Error(`the sitter couldn't read the plug: ${String(r.stderr || r.stdout).slice(0, 200)}`); }
}

// The plug from this computer: its last address, then (if it doesn't answer) wherever its MAC answers on this LAN.
export async function readPlug(power, password, { call = rpc, findAll = find } = {}) {
  const host = new URL(power.url).hostname;
  try {
    const s = await call(host, 'Switch.GetStatus', { id: 0 }, { password });
    return { on: Boolean(s.output), watts: s.apower ?? null, url: power.url, moved: false };
  } catch (e) {
    if (!power.mac || /password|401/.test(e.message)) throw e;
    const d = (await findAll()).find((x) => sameMac(x.mac, power.mac));
    if (!d) throw new Error(`${e.message}; and no Shelly with MAC ${power.mac} answered on this network`);
    const s = await call(d.ip, 'Switch.GetStatus', { id: 0 }, { password });
    return { on: Boolean(s.output), watts: s.apower ?? null, url: `http://${d.ip}`, moved: true };
  }
}

// One real power cut through the sitter, watched until the Mac is back at its desktop. The KVM's own boot id must not
// change: if it does, the KVM is on the plug too, and a cut takes down the thing that brings the Mac back.
export async function prove({ ssh, dir = '/etc/kvmd/user/housesitter', sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), bootWaitMs = 4 * 60000, desktopWaitMs = 8 * 60000, say = () => {} }) {
  const env = dir === '/etc/kvmd/user/housesitter' ? '' : `HOUSESITTER_HOME=${quote(dir)} `;
  const json = async (cmd) => { const r = await ssh(cmd); try { return JSON.parse(String(r.stdout).trim().split('\n').at(-1)); } catch { return { _error: String(r.stderr || r.stdout).slice(0, 200), _status: r.status }; } };
  const state = () => json(`${env}python3 ${dir}/sitter.py boot-state`);
  const b0 = await state();
  if (b0._error) return { ok: false, why: `the sitter didn't answer: ${b0._error}` };
  const t0 = now();
  const cut = await json(`${env}python3 ${dir}/sitter.py do power_cycle ${quote(JSON.stringify({ attended: true }))}`);
  if (!cut.ok) return { ok: false, why: `the sitter didn't cut the power: ${cut.result || cut._error}` };
  say(`power cut at ${new Date(t0).toLocaleTimeString()}: ${cut.result}`);
  let bootS = null;
  let desktopS = null;
  while (now() - t0 < bootWaitMs) {
    await sleep(3000);
    const b = await state();
    if (!b._error && (b.usb_seen > (b0.usb_seen || 0) || (b.pending && b.pending >= t0))) { bootS = Math.round((now() - t0) / 1000); say(`boot seen at ${bootS} s`); break; }
  }
  if (bootS == null) return { ok: false, why: `no boot seen within ${bootWaitMs / 60000} min of the power cut. Does the Mac start by itself after a power cut? (System Settings > Energy > Start up automatically after a power failure, or sudo pmset -a autorestart 1)` };
  let last = null;
  while (now() - t0 < desktopWaitMs) {
    await sleep(5000);
    last = await state();
    if (!last._error && last.desktop_at && last.desktop_at > t0) { desktopS = Math.round((now() - t0) / 1000); break; }
  }
  if (desktopS == null) return { ok: false, boot_s: bootS, why: `booted, but no desktop within ${desktopWaitMs / 60000} min${last?.stuck ? `: ${last.stuck}` : ''}` };
  if (last.kvm_boot && b0.kvm_boot && last.kvm_boot !== b0.kvm_boot) return { ok: false, boot_s: bootS, desktop_s: desktopS, why: "the KVM rebooted too: it is on the plug. Only the Mac's cord may be; power the KVM separately (PoE, or its own outlet)" };
  return { ok: true, boot_s: bootS, desktop_s: desktopS };
}

export const newPassword = () => crypto.randomBytes(18).toString('base64url');
