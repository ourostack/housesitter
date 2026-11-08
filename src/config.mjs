// Where housesitter keeps what it knows about your Macs, and how it reads secrets without holding them.
//
// Config: $HOUSESITTER_CONFIG, else ~/.config/housesitter/config.json. One entry per Mac:
//   { "macs": { "studio": {
//       "kvm":    { "endpoints": [{ "label": "tailnet", "url": "https://kvm-studio.example.ts.net" },
//                                 { "label": "home LAN", "url": "https://192.168.1.50", "fallback": true }],
//                   "tls_sha256": "AB:CD:…", "user": "admin", "admin_password": "keychain:housesitter/studio-kvm" },
//       "mac_password": "keychain:housesitter/studio-mac",        // copied once to the sitter, sealed there
//       "user_names": ["Ada"],                                    // what the FileVault screen shows, to read it
//       "power":  { "kind": "shelly", "url": "http://192.168.1.60" },   // or shelly-ble, fingerbot, command, none
//       "notify": { "kind": "ntfy", "url": "https://ntfy.sh/<your topic>" },  // or webhook
//       "heartbeat": { "url": "https://hc-ping.com/<uuid>" },     // a dead man's switch, pinged every look
//       "outbox": { "gist": "…", "inbox": "…", "token": "keychain:housesitter/studio-outbox" },
//       "tailscale": { "tag": "tag:kvm", "hostname": "kvm-studio", "authkey": "keychain:housesitter/tailnet-kvm" } } } }
//
// Secret references (never the secret itself): keychain:<service>[/<account>] (macOS Keychain), env:<NAME>,
// file:<path>. A secret is read when it's needed and passed on in a request body or on stdin, never in argv.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configPath(env = process.env) {
  return env.HOUSESITTER_CONFIG || path.join(os.homedir(), '.config', 'housesitter', 'config.json');
}

export function loadConfig(file = configPath()) {
  if (!fs.existsSync(file)) return { macs: {} };
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { macs: {}, ...j };
}

export function saveConfig(cfg, file = configPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.new`, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.new`, file);
}

export function macConfig(name, cfg = loadConfig()) {
  const m = cfg.macs?.[name];
  if (!m) {
    const known = Object.keys(cfg.macs || {});
    throw Object.assign(new Error(`no Mac called "${name}" in ${configPath()}${known.length ? ` (known: ${known.join(', ')})` : ' (run: housesitter adopt <name> --address <kvm ip>)'}`), { code: 'input-invalid' });
  }
  return { name, ...m, kvm: { user: 'admin', endpoints: [], ...(m.kvm || {}) } };
}

export function updateMac(name, fn, file = configPath()) {
  const cfg = loadConfig(file);
  cfg.macs[name] = cfg.macs[name] || {};
  fn(cfg.macs[name]);
  saveConfig(cfg, file);
  return cfg.macs[name];
}

// ---------- secrets ----------

export function parseRef(ref) {
  const m = String(ref || '').match(/^(keychain|env|file):(.+)$/);
  if (!m) throw new Error(`not a secret reference: "${ref}" (use keychain:<service>[/<account>], env:<NAME> or file:<path>)`);
  if (m[1] === 'keychain') { const [service, ...rest] = m[2].split('/'); return { kind: 'keychain', service, account: rest.join('/') || null }; }
  return { kind: m[1], value: m[2] };
}

export function secretStore({ run = spawnSync, env = process.env, read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const sec = (args, opts = {}) => run('/usr/bin/security', args, { encoding: 'utf8', timeout: 15000, ...opts });
  return {
    get(ref) {
      if (!ref) return null;
      const r = parseRef(ref);
      if (r.kind === 'env') return env[r.value] || null;
      if (r.kind === 'file') { try { return read(r.value.replace(/^~(?=\/)/, os.homedir())).replace(/\n$/, '') || null; } catch { return null; } }
      const out = sec(['find-generic-password', '-s', r.service, ...(r.account ? ['-a', r.account] : []), '-w']);
      return out.status === 0 ? String(out.stdout).replace(/\n$/, '') : null;
    },
    has(ref) { return this.get(ref) != null; },
    // Keychain only. `security -i` reads the command on stdin, so the value never shows in this process's argv.
    set(ref, value) {
      const r = parseRef(ref);
      if (r.kind !== 'keychain') throw new Error(`can only store into the Keychain, not ${r.kind}:`);
      if (/["\n\\]/.test(value)) throw new Error('refusing to store a value with quotes, backslashes or newlines');
      const out = sec(['-i'], { input: `add-generic-password -U -s "${r.service}" -a "${r.account || os.userInfo().username}" -w "${value}"\n` });
      if (out.status !== 0) throw new Error(`keychain: ${String(out.stderr).trim()}`);
    },
  };
}
