// The Apple Account password prompt after an update reboot, answered from this Mac's Keychain, narrowly.
//
// After a macOS update the first login runs Setup Assistant, which asks again for the Apple Account password
// ("To set up iCloud, enter the password for …"; its pane is iCloudLoginReprompt). This fills that one prompt:
//
//   Mac only, never the KVM. The prompt is there after login, with the login Keychain open; the KVM never holds it.
//   The secret is keychain:housesitter/<mac>-apple-account, stored once by `housesitter secret <mac> apple-account`.
//   Where: hackamore types it (type_secret), and only into the password field of Setup Assistant
//   (com.apple.SetupAssistant) whose window says "To set up iCloud … enter the password for": a secret_rules entry in
//   hackamore's config (installRule) that hackamore enforces itself, before the Keychain is read. Setup Assistant's other
//   password panes (the Mac's own password) don't say that, so they are refused.
//   When: within 30 minutes of a boot that Housesitter coordinated (a marker written before the reboot by
//   `housesitter apple-account <mac> --expect-reboot`), or when its owner runs `--now`. Any other time the prompt is
//   left alone and the owner is told once.
//   Two-factor: if Apple then asks for a verification code, it stops and tells the owner once. It never types a code,
//   never retries a rejected password, and fills at most once per boot.
//   Audit: every decision is a line of audit.jsonl (no value), and the agent is told once what was filled.
//
// Everything that touches the Mac goes through `deps`, so tests run against a pretend dialog and a pretend Keychain.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WINDOW_MS = 30 * 60000;
export const MARKER_MAX_AGE_MS = 3 * 3600000;
export const APP = 'Setup Assistant';
export const BUNDLE = '^com\\.apple\\.SetupAssistant$';
// The words of the iCloud pane; Setup Assistant's other password panes ("Enter the password for “x”.", "…for the user")
// don't contain them.
export const PROMPT_TEXT = 'to set up icloud.*enter the password for';
export const CODE_TEXT = /verification code|two-factor|6-digit|six-digit|enter the code/i;
export const REJECTED_TEXT = /incorrect|isn.t correct|couldn.t sign in|could not sign in|try again|wrong password/i;

export const accountName = (mac) => `${mac}-apple-account`;
export const appleRef = (mac) => `keychain:housesitter/${accountName(mac)}`;

export const stateDir = (home = os.homedir()) => path.join(home, 'Library', 'Caches', 'housesitter', 'apple-account');
export const hackamoreConfigPath = (home = os.homedir()) => path.join(home, '.config', 'hackamore', 'config.json');

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, `${JSON.stringify(v, null, 2)}\n`, mode ? { mode } : undefined); fs.renameSync(t, f); };

// ---------- hackamore's side: the rule ----------

// The secret_rules entry hackamore enforces. `item` is the name an agent passes to type_secret; the Keychain lookup is
// exactly service housesitter + account <mac>-apple-account, the item `housesitter secret` writes.
export const hackamoreRule = (mac) => ({
  item: accountName(mac), service: 'housesitter', account: accountName(mac), app: BUNDLE, text: PROMPT_TEXT,
  why: 'the Apple Account password pane of Setup Assistant after an update, and nowhere else',
});

// Add (or replace) this Mac's rule in hackamore's config, keeping everything else in it.
export function installRule(mac, { file = hackamoreConfigPath(), dry = false } = {}) {
  const cfg = readJson(file, {}) || {};
  const rule = hackamoreRule(mac);
  const rules = Array.isArray(cfg.secret_rules) ? cfg.secret_rules.filter((r) => r?.item !== rule.item) : [];
  const next = { ...cfg, secret_rules: [...rules, rule] };
  // A plain entry for the same item would offer it to every password field: the rule is its only way in.
  if (Array.isArray(next.secrets)) next.secrets = next.secrets.filter((s) => s !== rule.item);
  if (!dry) writeJson(file, next);
  return { file, rule, changed: JSON.stringify(cfg) !== JSON.stringify(next) };
}

// ---------- reading a screen (pure) ----------

// What hackamore's `ls "Setup Assistant"` shows, as far as this needs: is it the iCloud password pane, and is a
// verification code or a rejection on the screen?
export function readScreen(state) {
  const app = state?.app;
  if (!app || !new RegExp(BUNDLE, 'i').test(app.bundle || '')) return { kind: 'other' };
  const els = state.elements || [];
  const said = [state.window?.title, ...els.filter((e) => ['statictext', 'heading'].includes(e.role)).flatMap((e) => [e.label, e.value])].filter(Boolean).map(String);
  const field = els.find((e) => e.role === 'securetextfield');
  const buttons = els.filter((e) => e.role === 'button' && e.label);
  const base = { field: field?.ref || null, buttons, said };
  if (said.some((t) => CODE_TEXT.test(t))) return { kind: 'code', ...base };
  if (field && new RegExp(PROMPT_TEXT, 'i').test(said.join(' \n '))) return { kind: 'prompt', rejected: said.some((t) => REJECTED_TEXT.test(t)), ...base };
  return { kind: 'other', ...base };
}

export function parseBoot(sysctlText) {
  const m = String(sysctlText).match(/sec\s*=\s*(\d+)/);
  return m ? Number(m[1]) * 1000 : null;
}

// ---------- when it may fill (pure) ----------

// marker: { at, why } written before a reboot Housesitter coordinated. explicit: its owner ran it by hand.
export function decide({ now, bootAt, marker, explicit = false, state = {}, windowMs = WINDOW_MS }) {
  if (explicit) return { ok: true, why: 'its owner ran it', reason: 'when asked' };
  if (state.stopped_boot === bootAt && bootAt != null) return { ok: false, code: 'stopped', why: `already ${state.stopped_why || 'handled'} for this boot; it does not try twice` };
  if (state.filled_boot === bootAt && bootAt != null) return { ok: false, code: 'filled', why: 'already filled once for this boot' };
  if (bootAt == null) return { ok: false, code: 'no-boot', why: "the boot time isn't known" };
  if (now - bootAt > windowMs) return { ok: false, code: 'outside', why: `the Mac booted ${Math.round((now - bootAt) / 60000)} min ago (it fills only within ${windowMs / 60000})` };
  if (!marker || !(marker.at <= bootAt + 60000) || bootAt - marker.at > MARKER_MAX_AGE_MS) return { ok: false, code: 'uncoordinated', why: 'this boot was not one Housesitter coordinated' };
  return { ok: true, why: `within ${windowMs / 60000} min of a coordinated boot`, reason: `after ${marker.why || 'the coordinated reboot'}` };
}

export const filledText = ({ at, reason }) => `Housesitter filled the Apple Account password prompt ${reason} (${hhmm(at)}). Tell the owner once, in one line, such as: "filled the Apple Account password prompt ${reason}".`;
export const codeText = ({ at }) => `The Apple Account password prompt was filled at ${hhmm(at)} and Apple then asked for a verification code from another device. I typed nothing more and will not try to get around it. Tell the owner once that the code is needed.`;
export const rejectedText = ({ at }) => `The Apple Account password prompt was filled at ${hhmm(at)} and the prompt is still asking. I will not retry (a wrong password counts against the account). Tell the owner once: it needs a look, and the stored password may be out of date (housesitter secret <mac> apple-account).`;
const hackWhy = (v) => `Housesitter's apple-account job, which Ari set up, fills the Apple Account prompt ${v.reason || 'when asked'}`;
export const leftAloneText = ({ at, why }) => `An Apple Account password prompt appeared at ${hhmm(at)} and was left alone: ${why}. Tell the owner once; it is the owner's to answer, or run housesitter apple-account <mac> --now.`;
export const missingText = ({ at, ref }) => `An Apple Account password prompt appeared at ${hhmm(at)}, but no password is stored at ${ref}. Tell the owner once: run housesitter secret <mac> apple-account.`;

// ---------- one pass ----------

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (r) => r.json?.code || r.json?.refused || null;

// Look at Setup Assistant once and, if it is the iCloud password pane and it may, fill it. Returns { status, ... };
// status is one of no-dialog, waiting, left-alone, filled, needs-code, rejected, failed.
export async function attempt({ mac, explicit = false }, deps) {
  const now = deps.now();
  const state = deps.state.get();
  const pid = await deps.pid(APP);
  if (!pid) return { status: 'no-dialog' };
  const ls = await deps.hk(['ls', APP]);
  if (ls.code !== 0 || !ls.json) return { status: 'no-dialog', why: `hackamore ls failed: ${ls.text || `exit ${ls.code}`}` };
  const screen = readScreen(ls.json.state);
  if (screen.kind !== 'prompt') return { status: 'no-dialog', screen: screen.kind };
  const bootAt = deps.bootAt();
  const v = decide({ now, bootAt, marker: deps.marker(), explicit, state });
  if (!v.ok) {
    if (v.code === 'filled' || v.code === 'stopped') return { status: 'no-dialog', why: v.why };
    // A prompt that isn't ours to answer: the owner hears once per Setup Assistant process.
    if (state.left_alone_pid !== pid) {
      deps.state.set({ ...state, left_alone_pid: pid });
      deps.audit({ at: iso(now), event: 'left-alone', mac, why: v.why });
      await deps.tell({ id: `left-alone-${pid}`, text: leftAloneText({ at: now, why: v.why }) });
    }
    return { status: 'left-alone', why: v.why };
  }
  if (screen.rejected) return stop(deps, { mac, now, bootAt, state, code: 'rejected', text: rejectedText({ at: now }), why: 'the prompt is already rejecting a password' });
  if (!deps.hasSecret(appleRef(mac))) {
    if (state.missing_told !== bootAt) {
      deps.state.set({ ...state, missing_told: bootAt });
      deps.audit({ at: iso(now), event: 'no-secret', mac });
      await deps.tell({ id: `no-secret-${bootAt}`, text: missingText({ at: now, ref: appleRef(mac) }) });
    }
    return { status: 'failed', why: `no password stored at ${appleRef(mac)}` };
  }
  const typed = await deps.hk(['do', 'type_secret', JSON.stringify({ keychain_item: accountName(mac), element: screen.field }), '--app', APP, '--why', hackWhy(v)]);
  if (typed.code !== 0) {
    const code = codeOf(typed);
    // Someone is at the Mac: not a failure, try again next time round.
    if (code === 'person-active') return { status: 'waiting', why: 'someone is using the Mac' };
    return stop(deps, { mac, now, bootAt, state, code: 'failed', text: `Typing the Apple Account password was refused (${code || `exit ${typed.code}`}: ${typed.json?.message || typed.json?.problem || typed.text}). Tell the owner once.`, why: `hackamore refused (${code || typed.code})` });
  }
  deps.audit({ at: iso(now), event: 'typed', mac, boot: iso(bootAt || now), why: v.why });
  const go = screen.buttons.find((b) => /^(continue|next|sign in)$/i.test(String(b.label).trim()));
  const sent = go ? await deps.hk(['do', 'click', JSON.stringify({ element: go.ref }), '--app', APP, '--why', hackWhy(v)]) : await deps.hk(['do', 'press_key', JSON.stringify({ key: 'return' }), '--app', APP, '--why', hackWhy(v)]);
  if (sent.code !== 0 && codeOf(sent) !== 'person-active') deps.audit({ at: iso(now), event: 'submit-refused', mac, why: codeOf(sent) || `exit ${sent.code}` });
  await deps.sleep(deps.settleMs ?? 12000);
  const after = await deps.hk(['ls', APP]);
  const next = after.json ? readScreen(after.json.state) : { kind: 'other' };
  if (next.kind === 'code') return stop(deps, { mac, now, bootAt, state, code: 'needs-code', text: codeText({ at: now }), why: 'Apple asked for a verification code' });
  if (next.kind === 'prompt') return stop(deps, { mac, now, bootAt, state, code: 'rejected', text: rejectedText({ at: now }), why: 'the prompt is still asking' });
  deps.state.set({ ...state, filled_boot: bootAt, filled_at: iso(now) });
  deps.audit({ at: iso(deps.now()), event: 'filled', mac, boot: iso(bootAt || now), why: v.why });
  await deps.tell({ id: `filled-${bootAt || now}`, text: filledText({ at: now, reason: v.reason }) });
  return { status: 'filled', why: v.why };
}

async function stop(deps, { mac, now, bootAt, state, code, text, why }) {
  deps.state.set({ ...state, stopped_boot: bootAt, stopped_why: why });
  deps.audit({ at: iso(now), event: code, mac, boot: iso(bootAt || now), why });
  await deps.tell({ id: `${code}-${bootAt || now}`, text });
  return { status: code === 'needs-code' ? 'needs-code' : code === 'rejected' ? 'rejected' : 'failed', why };
}

// The agent's loop: look every few seconds while Setup Assistant is running, until stopped.
export async function watch({ mac, every = 15000, stop: halt = () => false }, deps, log = () => {}) {
  while (!halt()) {
    try {
      const r = await attempt({ mac }, deps);
      if (r.status !== 'no-dialog') log(`${r.status}${r.why ? `: ${r.why}` : ''}`);
    } catch (e) { log(`pass failed: ${e.message || e}`); }
    await deps.sleep(every);
  }
}

// ---------- the Mac ----------

export function realDeps({ hk, home = os.homedir(), tell = null, run = (f, a) => spawnSync(f, a, { encoding: 'utf8', timeout: 15000 }), clock = Date.now, sleep = sleepReal, settleMs } = {}) {
  const dir = stateDir(home);
  const file = (n) => path.join(dir, n);
  const told = () => readJson(file('told.json'), {}) || {};
  return {
    now: clock, sleep, settleMs, hk,
    pid: async (name) => { const r = run('/usr/bin/pgrep', ['-x', name]); const n = Number(String(r.stdout || '').split('\n')[0]); return n > 0 ? n : null; },
    bootAt: () => parseBoot(run('/usr/sbin/sysctl', ['-n', 'kern.boottime']).stdout),
    marker: () => readJson(file('expect-reboot.json'), null),
    state: { get: () => readJson(file('state.json'), {}) || {}, set: (s) => writeJson(file('state.json'), s) },
    // Existence only: asking `security` without -w never reads the value.
    hasSecret: (ref) => { const m = String(ref).match(/^keychain:([^/]+)\/(.+)$/); return Boolean(m) && run('/usr/bin/security', ['find-generic-password', '-s', m[1], '-a', m[2]]).status === 0; },
    audit: (entry) => { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(file('audit.jsonl'), `${JSON.stringify(entry)}\n`); },
    // Once per id: a failed send is tried again at the next pass.
    tell: async ({ id, text }) => {
      const t = told();
      if (t[id]) return;
      if (tell && (await tell(text)) === false) return;
      writeJson(file('told.json'), { ...t, [id]: iso(clock()) });
    },
  };
}

export const expectReboot = ({ why, now = Date.now(), home = os.homedir() }) => { writeJson(path.join(stateDir(home), 'expect-reboot.json'), { at: now, why: why || 'the coordinated reboot' }); return { at: now, why }; };

// What `--status` shows: the audit trail's last lines and what is pending.
export function readStatus({ home = os.homedir() } = {}) {
  const dir = stateDir(home);
  let audit = [];
  try { audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-8).map((l) => JSON.parse(l)); } catch { /* none yet */ }
  return { dir, state: readJson(path.join(dir, 'state.json'), {}), marker: readJson(path.join(dir, 'expect-reboot.json'), null), audit };
}

// ---------- the launchd agent ----------

export const LABEL = 'bot.ouro.housesitter.apple-account';
export const plistPath = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);

export function agentPlist({ node, bin, mac, env = {}, log }) {
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const envs = Object.entries(env).map(([k, v]) => `    <key>${x(k)}</key><string>${x(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[node, bin, 'apple-account', mac, '--watch'].map((a) => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>EnvironmentVariables</key>
  <dict>
${envs}
  </dict>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict>
</plist>
`;
}

const launchctlReal = (a) => { const r = spawnSync('/bin/launchctl', a, { encoding: 'utf8' }); return { code: r.status ?? 1, stderr: String(r.stderr || '') }; };

export async function installAgent({ node, bin, mac, env, home = os.homedir(), dry = false, launchctl = launchctlReal, uid = process.getuid() }) {
  const file = plistPath(home);
  const log = path.join(home, 'Library', 'Logs', 'housesitter-apple-account.launchd.log');
  const text = agentPlist({ node, bin, mac, env, log });
  if (dry) return { ok: true, dry_run: true, plist: file, log, text };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(file, text);
  launchctl(['bootout', `gui/${uid}/${LABEL}`]);
  const r = launchctl(['bootstrap', `gui/${uid}`, file]);
  return { ok: r.code === 0, plist: file, log, error: r.stderr.trim() };
}

export function uninstallAgent({ home = os.homedir(), launchctl = launchctlReal, uid = process.getuid() } = {}) {
  const file = plistPath(home);
  launchctl(['bootout', `gui/${uid}/${LABEL}`]);
  try { fs.unlinkSync(file); } catch { /* not installed */ }
  return { ok: true, plist: file };
}
