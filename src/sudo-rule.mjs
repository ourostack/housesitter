// `housesitter restart-copilot --grant-softwareupdate`: the narrowest right that lets housesitter install a macOS update
// unattended, and nothing else. One sudoers.d entry, for one user, with no password, for exactly three commands:
//
//   /usr/sbin/softwareupdate --list
//   /usr/sbin/softwareupdate -l
//   /usr/sbin/softwareupdate --install <label> --restart --agree-to-license
//
// `--restart` is softwareupdate's own, so `shutdown` is not granted. Other softwareupdate verbs (a different catalog,
// a full installer, Rosetta) are not.
//
// Installing the file takes the administrator's password once. It is read from the secret store by reference, or typed
// at a hidden prompt, and goes to sudo on stdin (`sudo -S`): never in argv, the environment or a file. The candidate
// is checked with `visudo -cf` before it goes near /etc, installed under a name sudo ignores (a dot in it), checked
// again where it sits, and only then renamed into place. Any failure removes what it left.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig, secretStore } from './config.mjs';
import { Refusal } from './hands.mjs';

export const RULE_FILE = '/etc/sudoers.d/housesitter-softwareupdate';
export const SOFTWAREUPDATE = '/usr/sbin/softwareupdate';
export const INSTALL_PATTERN = [SOFTWAREUPDATE, '--install', 'placeholder', '--restart', '--agree-to-license'];

export function ruleText(user) {
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user || '')) throw new Refusal('input-invalid', `"${user}" is not a user name sudoers accepts`);
  return `# housesitter: install macOS updates unattended, in the quiet hours (housesitter restart-copilot --os-updates).
# Three commands, nothing else. --restart is softwareupdate's own, so shutdown is not granted.
${user} ALL=(root) NOPASSWD: ${SOFTWAREUPDATE} --list, ${SOFTWAREUPDATE} -l, ${SOFTWAREUPDATE} --install * --restart --agree-to-license
`;
}

// run(file, argv, { input }) -> { code, stdout, stderr }; the real one gives input on stdin.
export const realRun = (file, argv, { input = null, timeoutMs = 60000 } = {}) => new Promise((resolve) => {
  const p = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(e.message) }); });
  p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  p.stdin.on('error', () => {});
  p.stdin.end(input == null ? undefined : input);
});

const SUDO = ['-S', '-p', ''];

// Install the rule. deps: { run, password: () => string|null, stage: dir for the candidate }. Returns { ok, steps, ... }.
export async function grant({ user = os.userInfo().username, deps, dry = false }) {
  const text = ruleText(user);
  const steps = [];
  const pending = `${RULE_FILE}.pending`;
  const candidate = path.join(deps.stage, 'softwareupdate.sudoers');
  const note = (s) => steps.push(s);
  fs.mkdirSync(deps.stage, { recursive: true, mode: 0o700 });
  fs.writeFileSync(candidate, text, { mode: 0o600 });
  const check = await deps.run('/usr/sbin/visudo', ['-cf', candidate]);
  if (check.code !== 0) { fs.rmSync(candidate, { force: true }); return { ok: false, steps, why: `visudo rejected the rule: ${check.stderr.trim() || check.stdout.trim()}` }; }
  note('the rule parses (visudo -cf)');
  if (dry) { fs.rmSync(candidate, { force: true }); return { ok: true, dry_run: true, steps, text, file: RULE_FILE }; }
  const already = await deps.run('/usr/bin/sudo', ['-n', '-l', ...INSTALL_PATTERN]);
  if (already.code === 0) { fs.rmSync(candidate, { force: true }); return { ok: true, already: true, steps: [...steps, 'sudo already allows it without a password'], file: RULE_FILE }; }
  const password = await deps.password();
  if (!password) { fs.rmSync(candidate, { force: true }); throw new Refusal('action-unavailable', 'no administrator password to give sudo: store it with `housesitter secret <mac> mac-password` (read from stdin, no echo), or run this in a terminal where it can ask for it'); }
  const sudo = (argv) => deps.run('/usr/bin/sudo', [...SUDO, ...argv], { input: `${password}\n` });
  const cleanup = async () => { await sudo(['/bin/rm', '-f', pending]); fs.rmSync(candidate, { force: true }); };
  const put = await sudo(['/usr/bin/install', '-m', '0440', '-o', 'root', '-g', 'wheel', candidate, pending]);
  if (put.code !== 0) { await cleanup(); return { ok: false, steps, why: `sudo would not install the file (${put.stderr.replace(/\s+/g, ' ').trim().slice(0, 160) || `exit ${put.code}`}): wrong password?` }; }
  note(`installed as ${pending}, which sudo ignores`);
  const again = await sudo(['/usr/sbin/visudo', '-cf', pending]);
  if (again.code !== 0) { await cleanup(); return { ok: false, steps, why: `visudo rejected the installed file: ${again.stderr.trim() || again.stdout.trim()}` }; }
  note('the installed file parses');
  const mv = await sudo(['/bin/mv', '-f', pending, RULE_FILE]);
  if (mv.code !== 0) { await cleanup(); return { ok: false, steps, why: `could not move it into place: ${mv.stderr.trim()}` }; }
  fs.rmSync(candidate, { force: true });
  note(`in place: ${RULE_FILE}`);
  const proof = await deps.run('/usr/bin/sudo', ['-n', SOFTWAREUPDATE, '--list'], { timeoutMs: 180000 });
  const can = await deps.run('/usr/bin/sudo', ['-n', '-l', ...INSTALL_PATTERN]);
  const out = `${proof.stdout}${proof.stderr}`.trim();
  note(`sudo -n softwareupdate --list: ${proof.code === 0 ? 'works' : 'FAILED'}`);
  return { ok: proof.code === 0 && can.code === 0, steps, file: RULE_FILE, listing: out.split('\n').slice(-3).join(' | '), why: proof.code === 0 && can.code === 0 ? null : 'the rule is in place but sudo -n does not use it' };
}

export async function revoke({ deps }) {
  const password = await deps.password();
  if (!password) throw new Refusal('action-unavailable', 'no administrator password to give sudo');
  const r = await deps.run('/usr/bin/sudo', [...SUDO, '/bin/rm', '-f', RULE_FILE], { input: `${password}\n` });
  return { ok: r.code === 0, file: RULE_FILE, why: r.code === 0 ? null : r.stderr.trim() };
}

// The password: the reference in the config, then the usual names; only a person at a terminal is asked. The copy sealed on the KVM is
// never read back: the sitter types it at a prompt and has no way to hand it over.
export function realGrantDeps({ mac = 'mini', stage, run = realRun, store = secretStore(), cfg = loadConfig(), tty = process.stdin } = {}) {
  return {
    run, stage,
    password: async () => {
      // The reference the config names (the FileVault password housesitter holds), then the two names adopt and `secret` use.
      for (const ref of [...new Set([cfg.macs?.[mac]?.mac_password, `keychain:housesitter/${mac}-mac`, `keychain:housesitter/${mac}-mac-password`].filter(Boolean))]) {
        const held = store.get(ref);
        if (held) return held;
      }
      if (!tty.isTTY) return null;
      process.stderr.write(`administrator password for ${os.userInfo().username} (input hidden), then Return: `);
      spawnSync('/bin/stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
      const v = await new Promise((res) => { let b = ''; tty.on('data', (d) => { b += d; if (b.includes('\n')) { tty.pause(); res(b); } }); });
      spawnSync('/bin/stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
      process.stderr.write('\n');
      return v.replace(/\r?\n$/, '') || null;
    },
  };
}
