// Talk to the sitter (device/sitter.py on the KVM): its status, and the actions only it may take (unlock, power).
// Two routes, tried in order: SSH to the KVM (LAN or tailnet; root, its own key and known_hosts) and the outbox
// (GitHub gists, from anywhere). Both run the same handler on the sitter, with the same rate limits.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secretStore } from './config.mjs';
import * as O from './outbox.mjs';

export const DIR = '/etc/kvmd/user/housesitter';

export const sshKeyPath = (name, home = os.homedir()) => path.join(home, '.ssh', `housesitter-${name}-ecdsa`);
export const knownHostsPath = (name, home = os.homedir()) => path.join(home, '.ssh', `housesitter-${name}-known_hosts`);

export function kvmHost(mac) {
  const e = mac.kvm?.endpoints?.[0];
  return e ? new URL(e.url).hostname : null;
}

// Root SSH to the KVM with housesitter's own key. Returns run(cmd, input) -> { status, stdout, stderr }.
export function sshRunner(name, address, { run = spawnSync, home = os.homedir(), key = null } = {}) {
  const args = ['-i', key ? key.replace(/^~(?=\/)/, home) : sshKeyPath(name, home), '-o', `UserKnownHostsFile=${knownHostsPath(name, home)}`, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR'];
  return async (cmd, input) => {
    const r = run('/usr/bin/ssh', [...args, `root@${address}`, cmd], { encoding: 'utf8', input: input ?? '', timeout: 120000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function sitterClient(mac, { deps = {} } = {}) {
  const store = deps.secrets || secretStore();
  const routes = [];
  const host = kvmHost(mac);
  const key = mac.kvm?.ssh_key ? mac.kvm.ssh_key.replace(/^~(?=\/)/, os.homedir()) : sshKeyPath(mac.name);
  const dir = mac.kvm?.sitter_home || DIR;
  if (deps.ssh || (host && fs.existsSync(key))) {
    const sh = deps.ssh || sshRunner(mac.name, host, { key });
    routes.push({
      via: `ssh ${host}`,
      async status() { const r = await this.op('status'); return r.ok ? r.result : null; },
      async op(op, args = {}) {
        const r = await sh(`${dir === DIR ? '' : `HOUSESITTER_HOME=${quote(dir)} `}python3 ${dir}/sitter.py do ${op} ${quote(JSON.stringify(args))}`);
        try { return JSON.parse(String(r.stdout).trim().split('\n').at(-1)); } catch { return { ok: false, code: 'action-failed', result: `no answer over SSH (${String(r.stderr).trim().slice(0, 160) || `exit ${r.status}`})` }; }
      },
    });
  }
  if (mac.outbox?.gist) {
    const gh = deps.gh || O.gistClient({ token: () => (mac.outbox.token && store.get(mac.outbox.token)) || O.ghCliToken() });
    routes.push({
      via: 'outbox (GitHub)',
      status: () => O.readStatus(mac.name, mac.outbox, gh),
      async op(op, args = {}) { const { files, ...r } = await O.send(mac.name, mac.outbox, gh, op, args, { timeoutMs: op === 'unlock' || op === 'want_desktop' ? 75000 : 20000, ...(deps.sendOpts || {}) }); return { ...r, files }; },
    });
  }
  return {
    routes,
    async status() {
      const errors = [];
      for (const r of routes) { try { const s = await r.status(); if (s) return { via: r.via, status: s }; errors.push(`${r.via}: no status yet`); } catch (e) { errors.push(`${r.via}: ${e.message}`); } }
      return { via: null, status: null, errors };
    },
    async op(op, args) {
      if (!routes.length) return { ok: false, code: 'action-unavailable', result: `no route to ${mac.name}'s sitter (housesitter adopt sets up SSH; --outbox adds the GitHub route)` };
      let last = null;
      for (const r of routes) {
        try { const rep = await r.op(op, args); if (rep.code !== 'timeout') return { ...rep, via: r.via }; last = { ...rep, via: r.via }; } catch (e) { last = { ok: false, code: 'action-failed', result: e.message, via: r.via }; }
      }
      return last;
    },
  };
}

export function ageText(ms) { const s = Math.round(ms / 1000); return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`; }

export function describeStatus(name, st, now = Date.now()) {
  if (!st) return `${name}: the sitter has not written a status yet`;
  const o = st.obs || {};
  const signs = Object.entries(o).filter(([k, v]) => v != null && !k.endsWith('_error')).map(([k, v]) => `${k}=${v}`).join(' ');
  const can = Object.entries(st.can || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nothing';
  const ts = st.tailnet?.name ? `\n  tailnet: ${st.tailnet.name} (${st.tailnet.state})` : '';
  return `${name} is ${st.state}${st.since ? ` since ${new Date(st.since).toLocaleString()}` : ''} (seen by its sitter ${ageText(now - st.at)} ago)\n  signs: ${signs || 'none'}\n  it can: ${can}${ts}`;
}
