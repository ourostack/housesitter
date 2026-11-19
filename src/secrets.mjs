// `housesitter secret <mac> <name> [--kvm]`: where each secret lives in this Mac's Keychain, and how one is sealed on
// the KVM. The value goes from the Keychain to the sitter on SSH stdin, once: never in argv, a log, a gist or a status.
import { appleRef } from './apple-account.mjs';
import { defaultRefs } from './adopt.mjs';

// A secret's name, here and on the KVM (device/sitter.py SECRET_NAME_RE): lower-case letters, digits and dashes.
export const NAME_RULE = /^[a-z][a-z0-9-]{0,31}$/;

// The secrets housesitter already knew by kind, and the name each has on the KVM.
export const KINDS = { 'mac-password': 'mac', 'kvm-admin': 'kvmd', 'outbox-token': 'outbox', 'ntfy-token': 'ntfy', 'apple-account': 'apple-account' };

// The sitter's own names for those, refused as a name so one secret never has two Keychain items.
const RESERVED = { mac: 'mac-password', kvmd: 'kvm-admin', outbox: 'outbox-token', ntfy: 'ntfy-token', plug: null };

const fail = (code, message) => Object.assign(new Error(message), { code });

// Where `which` lives in this Mac's Keychain, and its name on the KVM.
export function secretTarget(name, which, mac = {}) {
  const refs = defaultRefs(name);
  const known = { 'mac-password': mac.mac_password || refs.mac, 'kvm-admin': mac.kvm?.admin_password || refs.admin, 'outbox-token': mac.outbox?.token || refs.outbox, 'ntfy-token': mac.notify?.token || refs.ntfy, 'apple-account': mac.apple_account || appleRef(name) };
  if (known[which]) return { ref: known[which], kvmName: KINDS[which], kind: which };
  if (which in RESERVED) {
    throw fail('input-invalid', RESERVED[which] ? `${which} is the sitter's own name for ${RESERVED[which]}: housesitter secret ${name} ${RESERVED[which]}` : `the plug's password is made by housesitter plug ${name} adopt`);
  }
  if (!NAME_RULE.test(String(which || ''))) throw fail('input-invalid', `"${which}" is not a secret's name: 1-32 lower-case letters, digits and dashes, starting with a letter (like setup-password)`);
  return { ref: `keychain:housesitter/${name}-${which}`, kvmName: which, kind: 'named' };
}

// Seal this Mac's Keychain copy of a secret on the KVM. `ssh(cmd, input)` is root SSH to the KVM; `onSitter(args)`
// builds the sitter's command line. A missing Keychain item fails with the exact fix.
export async function sealOnKvm({ name, which, target, store, ssh, onSitter }) {
  const value = store.get(target.ref);
  if (!value) throw fail('action-unavailable', `no ${which} for ${name} in this Mac's Keychain (${target.ref}). Fix: housesitter secret ${name} ${which} --kvm, type it, then Return`);
  const r = await ssh(onSitter(`store-secret ${target.kvmName}`), value);
  if (r.status !== 0) throw fail('action-failed', `the KVM did not seal ${which}: ${String(r.stderr || r.stdout).trim().slice(0, 200) || `ssh exit ${r.status}`}`);
  try { return JSON.parse(String(r.stdout).trim().split('\n').at(-1)); } catch { throw fail('action-failed', `the KVM gave no receipt for ${which}`); }
}

// A pretend Keychain and KVM for `secret --fake`: nothing leaves this process.
export function fakeSecretDeps(vault = {}) {
  const sealed = {};
  return {
    sealed,
    store: { get: (r) => vault[r] ?? null, set: (r, v) => { vault[r] = v; } },
    ssh: async (cmd, input) => {
      const m = /sitter\.py store-secret ([a-z][a-z0-9-]*)$/.exec(cmd);
      if (!m) return { status: 1, stdout: '', stderr: `unexpected: ${cmd}` };
      sealed[m[1]] = input;
      return { status: 0, stdout: `${JSON.stringify({ stored: m[1], bound_to: 'hardware' })}\n`, stderr: '' };
    },
  };
}
