// Signing for the peer link: the Mac's key, the same HMAC-SHA256 over the same bytes that device/sitter.py checks
// (spec/peer-sign-cases.json holds vectors both languages read). Unsigned messages are plain text anyone on the Mac can
// write; a signed one is the owner's own, once `adopt` has sealed this key on the KVM.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PEER_OPS = ['root-key', 'seal-secret'];
export const DEFAULT_STANDING_OPS = PEER_OPS;

export function canonical(msg) {
  for (const k of ['id', 'at', 'from', 'to', 'op', 're']) if (String(msg[k] ?? '').includes('\n')) throw new Error(`a newline in ${k}`);
  return ['housesitter-peer-v1', msg.id ?? '', msg.at ?? '', msg.from ?? '', msg.to ?? '', msg.op ?? '', msg.re ?? '', msg.text ?? ''].join('\n');
}

export const signMac = (keyHex, msg) => crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(canonical(msg), 'utf8').digest('hex');

export const keyFile = (dir) => path.join(dir, 'peer-key.json');

export function loadKey(dir) {
  try {
    const k = JSON.parse(fs.readFileSync(keyFile(dir), 'utf8'));
    return /^[a-z][a-z0-9-]{0,26}$/.test(k.kid) && /^[0-9a-f]{64}$/.test(k.key) ? k : null;
  } catch { return null; }
}

// This Mac's key, made once (0600, next to the config). kid names the Mac: it is the key's id on the KVM.
export function ensureKey(dir, kid) {
  const have = loadKey(dir);
  if (have) return have;
  const k = { kid, key: crypto.randomBytes(32).toString('hex') };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile(dir), `${JSON.stringify(k)}\n`, { mode: 0o600 });
  return k;
}

export const sign = (k, msg) => ({ kid: k.kid, mac: signMac(k.key, msg) });
