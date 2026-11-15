// `housesitter restart-copilot --os-updates`: a pending macOS update, handled on our terms. Never in the middle of a
// person's work, never with a session left behind. launchd runs one pass every ten minutes, with no model turns.
//
//   1. Look: `softwareupdate -l`, at most every 6 h. Only an update that restarts the Mac matters here.
//   2. Wait for a quiet time: the local hours of the quiet window (02:00 to 05:00) and a Mac nobody has touched for 20
//      minutes (the HID idle time, which still counts when the screen is locked).
//   3. Coordinate, with the proven restart: ask every working session to reach a safe point (READY or DEFER), wait for
//      them, quit the app. While it is down: write the sessions that are owed a resume to owed-resume.json, arm the
//      Apple Account re-prompt fill for this boot (`apple-account <mac> --expect-reboot`), record that the reboot is
//      planned, then install and restart: `sudo -n softwareupdate --install "<label>" --restart`.
//   4. After the reboot, launchd starts every job again, the resume watcher opens the app and resumes the owed sessions,
//      the heartbeat tells the agent once why the Mac was away, and this pass checks that our own jobs are loaded.
//
// The one thing it cannot do alone is the administrator's password. If `sudo -n` is not allowed to run softwareupdate, it
// tells the agent once, with exactly what is needed, and installs nothing. `--prepare` does steps 3 up to the install,
// for a person who will restart the Mac themselves: it waits 20 minutes for that, then relaunches the app and resumes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEEPER_LABEL, plan, realDeps, restart, stateDir } from './copilot-app.mjs';
import * as Apple from './apple-account.mjs';
import { AGENTS, agentPath, hhmm, iso, readJson, realTell, run, writeJson } from './recovery.mjs';

export const OS = {
  windowStart: 2, windowEnd: 5, // local hours: 02:00 up to 05:00
  idle: 20 * 60000, // nobody has touched the Mac for this long
  recheck: 6 * 3600000, // how often softwareupdate -l is asked
  prepareWait: 20 * 60000, // --prepare: how long to wait for a person to restart the Mac
  installWait: 30 * 60000, // after the install command: how long until the Mac should have gone down
};

// ---------- pure ----------

// `softwareupdate -l`: the updates it lists, and whether each restarts the Mac.
export function parseUpdates(text) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\* (?:Label:\s*)?(.+?)\s*$/);
    if (!m) continue;
    const detail = lines.slice(i + 1, i + 3).join(' ');
    const title = (detail.match(/Title:\s*([^,]+?),/) || [])[1] || m[1];
    out.push({ label: m[1], title, version: (detail.match(/Version:\s*([^,]+?),/) || [])[1] || null, restart: /Action:\s*restart/i.test(detail) || (!/Action:/i.test(detail) && /macOS/i.test(title)), recommended: /Recommended:\s*YES/i.test(detail) });
  }
  return out;
}

// What to do now about the pending update. `x`: { update, state, now, hour, idleMs, canInstall, force }.
export function decide({ update, state, now, hour, idleMs, canInstall, force = false, t = OS }) {
  if (!update) return { action: 'none', code: 'nothing-pending', why: 'no update that restarts the Mac is waiting' };
  if (state.completed?.label === update.label) return { action: 'none', code: 'done', why: `${update.label} was installed by this job at ${state.completed.at}` };
  if (!canInstall && !force) return { action: 'needs-consent', code: 'no-admin', why: 'installing needs an administrator\'s password and sudo would ask for one' };
  if (!force && !(hour >= t.windowStart && hour < t.windowEnd)) return { action: 'hold', code: 'outside-window', why: `${hhmm(now)} is outside the quiet hours ${String(t.windowStart).padStart(2, '0')}:00 to ${String(t.windowEnd).padStart(2, '0')}:00` };
  if (!force && !(idleMs >= t.idle)) return { action: 'hold', code: 'person-active', why: `the Mac was used ${idleMs == null ? 'recently (idle time unknown)' : `${Math.round(idleMs / 60000)} min ago`}; waiting for ${Math.round(t.idle / 60000)} min of quiet` };
  return { action: 'run', code: 'update', why: update.label };
}

export const consentText = ({ update, bin, node }) => `macOS ${update.version || update.title} is waiting to install, and I will not install it without an administrator's password, which I do not have. Two ways forward, either is fine: (1) allow just this once for good, and I will do every later update in the 02:00 to 05:00 quiet window, with every session at a safe point first and resumed after the restart: run \`echo "$USER ALL=(root) NOPASSWD: /usr/sbin/softwareupdate" | sudo tee /etc/sudoers.d/housesitter-softwareupdate\`; or (2) run \`${node} ${bin} restart-copilot --os-updates --prepare\` when you want it: I get the sessions to a safe point, quit the app and arm the Apple Account prompt, then you restart the Mac yourself and everything comes back and resumes.`;

// ---------- the Mac ----------

export function realOsDeps({ home = os.homedir(), copilotHome, hackamore, state = stateDir(home), bin, node = process.execPath, mac = 'mini' } = {}) {
  const base = realDeps({ copilotHome, hackamore, state });
  const file = path.join(state, 'os-update.json');
  const d = {
    ...base,
    state, bin, node, mac,
    readState: () => readJson(file, {}),
    writeState: (o) => writeJson(file, o),
    tell: realTell({ state, home }),
    status: (o) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify(o)); },
    lastWrite: (o) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'last.json'), JSON.stringify(o, null, 2)); },
    listUpdates: async () => { const r = await run('/usr/sbin/softwareupdate', ['-l'], { timeoutMs: 180000 }); return { ok: r.code === 0, text: r.stdout + r.stderr }; },
    idleMs: async () => { const m = (await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeoutMs: 10000 })).stdout.match(/"HIDIdleTime" = (\d+)/); return m ? Math.round(Number(m[1]) / 1e6) : null; },
    canInstall: async () => (await run('/usr/bin/sudo', ['-n', '-l', '/usr/sbin/softwareupdate'], { timeoutMs: 10000 })).code === 0,
    install: async (label) => { const r = await run('/usr/bin/sudo', ['-n', '/usr/sbin/softwareupdate', '--install', label, '--restart', '--agree-to-license'], { timeoutMs: 45 * 60000 }); return { ok: r.code === 0, text: (r.stdout + r.stderr).trim().slice(-400) }; },
    expectReboot: (why) => Apple.expectReboot({ why, home }),
    bootTime: async () => { const m = (await run('/usr/sbin/sysctl', ['-n', 'kern.boottime'])).stdout.match(/sec = (\d+)/); return m ? Number(m[1]) * 1000 : null; },
    loaded: async () => new Set((await run('/bin/launchctl', ['list'])).stdout.split('\n').map((l) => l.split(/\s+/)[2]).filter(Boolean)),
    wantedJobs: () => [...Object.values(AGENTS).map((a) => a.label), KEEPER_LABEL, 'bot.ouro.housesitter.apple-account', 'bot.ouro.housesitter.keep-awake'].filter((l) => fs.existsSync(agentPath(l, home))),
  };
  return d;
}

// ---------- the pass ----------

export async function pass(opts, deps, say = () => {}) {
  const t = { ...OS, ...(opts.os || {}) };
  const now = deps.now();
  const out = (m) => say(`${iso(now)} os-updates${opts.dry_run ? ' (dry run)' : ''}: ${m}`);
  const st = deps.readState() || {};
  const save = (extra = {}) => { if (!opts.dry_run) deps.writeState({ ...st, ...extra }); };

  // After a planned reboot: did our own jobs come back?
  if (st.reboot && !st.verified) {
    const boot = await deps.bootTime();
    if (boot && boot > Date.parse(st.reboot.at)) {
      const up = await deps.loaded();
      const missing = deps.wantedJobs().filter((l) => !up.has(l));
      const rec = { at: iso(boot), label: st.reboot.label, missing };
      out(`the Mac restarted at ${hhmm(boot)} for ${st.reboot.label}; jobs ${missing.length ? `NOT loaded: ${missing.join(', ')}` : 'all loaded'}`);
      if (!opts.dry_run && missing.length) await deps.tell(`After the macOS update (${st.reboot.label}) these of my launchd jobs did not come back by themselves: ${missing.join(', ')}. Everything else did. Reload with: ${deps.node} ${deps.bin} restart-copilot --install-recovery`);
      st.completed = { label: st.reboot.label, at: iso(boot) }; st.pending = null; st.verified = rec;
      save();
    }
  }

  // Look for an update (cached for six hours).
  if (!st.checked_at || now - Date.parse(st.checked_at) >= t.recheck || opts.force || opts.prepare) {
    const r = await deps.listUpdates();
    if (r.ok) {
      const found = parseUpdates(r.text).filter((u) => u.restart);
      st.pending = found[0] || null; st.checked_at = iso(now);
      out(found.length ? `pending: ${found.map((u) => u.label).join(', ')}` : 'no update that restarts the Mac is pending');
    } else out(`softwareupdate -l failed: ${r.text.slice(0, 160)}`);
    save();
  }
  const update = st.pending || null;
  const canInstall = update && !opts.prepare ? await deps.canInstall() : true;
  const d = decide({ update, state: st, now, hour: deps.hour ? deps.hour() : new Date(now).getHours(), idleMs: update ? await deps.idleMs() : null, canInstall, force: Boolean(opts.force || opts.prepare), t });
  const res = { decision: d, update };
  if (d.action === 'needs-consent') {
    if (st.consent_told !== update.label && !opts.dry_run) { await deps.tell(consentText({ update, bin: deps.bin, node: deps.node })); save({ consent_told: update.label }); out('told once what is needed'); }
    out(`hold (${d.code}): ${d.why}`);
    return res;
  }
  if (d.action !== 'run') { out(`${d.action} (${d.code}): ${d.why}`); return res; }
  if (opts.dry_run) { const p = await plan({ ...opts, resume: true }, deps).catch(() => null); out(`would ${opts.prepare ? 'prepare for' : 'install'} ${update.label}${p ? `: ask ${p.sessions.busy} working session(s) to reach a safe point, quit the app, ${opts.prepare ? 'wait for a person to restart' : 'install and restart'}, resume them after the reboot` : ''}`); return { ...res, would: true }; }

  // Coordinate: the proven restart, with the install in place of the relaunch.
  const why = `a macOS update (${update.version || update.title})`;
  let installed = null;
  const whileDown = async ({ before }) => {
    deps.owed?.set(before.filter((s) => s.state === 'busy').map((s) => s.id), `the reboot for ${why}`);
    deps.expectReboot?.(`the ${hhmm(deps.now())} ${why} reboot`);
    save({ reboot: { at: iso(deps.now()), label: update.label, planned: true }, verified: null });
    if (opts.prepare) {
      await deps.tell(`Ready for the restart: every working session is at a safe point and the app is closed. Restart the Mac now for ${why}; everything comes back and resumes by itself. If you do not restart it within ${Math.round(t.prepareWait / 60000)} minutes I reopen the app and resume the sessions.`);
      for (const end = deps.now() + t.prepareWait; deps.now() < end;) await deps.sleep(10000);
      save({ reboot: null });
      return { ok: false };
    }
    installed = await deps.install(update.label);
    out(installed.ok ? 'install started; the Mac restarts' : `the install did not start: ${installed.text}`);
    if (!installed.ok) { save({ reboot: null }); return { ok: false }; }
    for (const end = deps.now() + t.installWait; deps.now() < end;) await deps.sleep(10000);
    save({ reboot: null });
    return { ok: false };
  };
  const report = await restart({ ...opts, resume: true, why, while_down: whileDown }, deps, (m) => out(m));
  deps.lastWrite?.(report);
  if (installed && !installed.ok) await deps.tell(`I tried to install ${update.label} and it did not start (${installed.text.slice(0, 200)}); the app is open again and the sessions were resumed. Nothing else changed.`);
  return { ...res, report };
}

export const renderPass = (r) => `${r.decision.action.toUpperCase()} (${r.decision.code}): ${r.decision.why}${r.update ? `\n  pending: ${r.update.label}` : ''}`;

