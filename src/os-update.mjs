// `housesitter restart-copilot --os-updates`: macOS installs its own updates; housesitter coordinates around them, with no
// administrator rights. launchd runs one pass every 5 minutes, with no model turns.
//
// Why not install it ourselves: on Apple silicon `softwareupdate --install` of a macOS update needs the volume owner's
// credentials passed in every run, so no sudoers rule can make it unattended. macOS does it natively instead: "Install
// macOS updates" (com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates), and, on a managed Mac, an enforcement
// declaration with an install deadline (EnforcedInstallDate). Both are readable without admin rights.
//
//   1. Look, read-only: `softwareupdate -l` (at most every 6 h), the automatic-update settings, and the enforcement
//      declaration softwareupdated logs (its deadline and version).
//   2. When macOS is about to act, run the safe point: ask every working session to say READY or DEFER (work committed
//      and pushed), write the sessions that are owed a resume to owed-resume.json, arm the Apple Account re-prompt fill
//      for this boot (`apple-account <mac> --expect-reboot`) and record that the reboot is planned. The app keeps running.
//      "About to act" is: the enforcement deadline less 90 minutes; the quiet hours (02:00 to 05:00, Mac idle 20 minutes)
//      while macOS has the update downloaded and installs automatically; or softwareupdated showing the install starting.
//   3. Hold until the reboot (the marker is refreshed so the prompt fill stays armed) or until the window is over; if the Mac
//      did not restart, stand down: the sessions are told to carry on and nothing stays armed or owed.
//   4. After the reboot, launchd starts every job again, the resume watcher opens the app and resumes the owed sessions, the
//      heartbeat tells the agent once why the Mac was away, and this pass checks that our own jobs are loaded.
//
// When automatic install is off and nothing is enforced, it tells the agent once which setting to turn on: that takes the
// administrator's password, so a person does it. `--now` runs the safe point at once and tells the agent to restart the
// Mac, for a person who will do that themselves: it holds 20 minutes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEEPER_LABEL, cancelText, plan, realDeps, restart, sendTo, stateDir } from './copilot-app.mjs';
import * as Apple from './apple-account.mjs';
import { AGENTS, agentPath, hhmm, iso, readJson, realTell, run, writeJson } from './recovery.mjs';

export const OS = {
  windowStart: 2, windowEnd: 5, // local hours: 02:00 up to 05:00
  idle: 20 * 60000, // nobody has touched the Mac for this long (the overnight trigger only)
  recheck: 6 * 3600000, // how often softwareupdate -l is asked
  readEnforced: 12 * 3600000, // how often the log is searched for the enforcement declaration
  lead: 90 * 60000, // the safe point starts this long before an enforcement deadline
  settleMax: 60 * 60000, // the longest the sessions are waited for
  afterDeadline: 30 * 60000, // hold this long past the deadline for macOS to restart
  manualWait: 20 * 60000, // --now: how long to wait for a person to restart the Mac
  minHold: 10 * 60000, // the overnight hold lasts until the window ends, but at least this long and at most maxHold
  maxHold: 3 * 3600000,
  imminentWithin: 12 * 60000, // an install seen starting in the log this recently counts
  rearm: 30 * 60000, // refresh the Apple Account marker this often while holding
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

// /Library/Preferences/com.apple.SoftwareUpdate as JSON (world-readable): what macOS will do by itself.
export function parseNative(prefs) {
  const p = prefs || {};
  const on = (k) => p[k] === 1 || p[k] === true;
  return { check: p.AutomaticCheckEnabled === undefined ? true : on('AutomaticCheckEnabled'), download: on('AutomaticDownload'), install: on('AutomaticallyInstallMacOSUpdates'), critical: on('CriticalUpdateInstall'), scheduled: Object.keys(p.FirstInstallTonightDateDictionary || {}), installed: Object.keys(p.InstallDateDictionary || {}) };
}

// `defaults read` of the same file, as an object: the 0/1 settings, and the keys of the dictionaries (their dates are not JSON).
export function parseDefaults(text) {
  const o = {};
  for (const m of String(text).matchAll(/^ {4}(\w+) = (\d+);$/gm)) o[m[1]] = Number(m[2]);
  for (const m of String(text).matchAll(/^ {4}(\w+) = +\{\n([\s\S]*?)^ {4}\};$/gm)) o[m[1]] = Object.fromEntries([...m[2].matchAll(/^ {8}"?([^"=\n]+?)"? = /gm)].map((k) => [k[1], true]));
  return o;
}

// softwareupdated logs the declaration a management server enforces:
//   ...|EnforcedInstallDate:2026-11-21T00:00:00|VersionString:27.2.1|... (local time, no zone)
export function parseEnforced(text) {
  let best = null;
  for (const m of String(text).matchAll(/EnforcedInstallDate:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:?\d\d)?)\|VersionString:([^|)]+)/g)) {
    const at = Date.parse(m[1]);
    if (!Number.isNaN(at)) best = { at, version: m[2].trim(), date: m[1] };
  }
  return best;
}

// The install starting: softwareupdated and the notification manager name the state they are in.
export const INSTALLING = /SUMacControllerProgressState(?:Apply|Install|Restart|Reboot)\w*|SUMAC_PHASE_(?:APPLY|INSTALL|RESTART)\w*|will restart in \d+|restart(?:ing)? in \d+ (?:min|sec)/i;

export const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// What to do now about the pending update. `x`: { update, native, enforced, state, now, hour, idleMs, imminent, force }.
// run: { action: 'run', code, key, until, why }: the safe point, held until `until` (ms).
export function decide({ update, native = {}, enforced = null, state = {}, now, hour, idleMs = null, imminent = false, force = false, t = OS }) {
  if (!update) return { action: 'none', code: 'nothing-pending', why: 'no update that restarts the Mac is waiting' };
  if (state.completed?.label === update.label) return { action: 'none', code: 'done', why: `${update.label} was installed at ${state.completed.at}` };
  const ours = enforced && (!update.version || enforced.version === update.version) ? enforced : null;
  const seen = (key) => state.safe?.key === key;
  if (force) return { action: 'run', code: 'manual', key: `manual:${now}`, until: now + t.manualWait, why: 'asked to' };
  if (imminent && !(state.safe && now - Date.parse(state.safe.at) < t.imminentWithin)) return { action: 'run', code: 'imminent', key: `imminent:${update.label}`, until: now + t.imminentWithin, why: 'softwareupdated shows the install starting' };
  if (ours && now >= ours.at - t.lead && now < ours.at + t.afterDeadline && !seen(`deadline:${update.label}`)) return { action: 'run', code: 'deadline', key: `deadline:${update.label}`, until: ours.at + t.afterDeadline, why: `the enforced install deadline is ${ours.date}` };
  const quiet = hour >= t.windowStart && hour < t.windowEnd;
  if (!ours && !native.install) return { action: 'native-off', code: 'automatic-install-off', why: 'automatic macOS installs are off and no deadline is enforced, so nothing will install the update by itself' };
  if (native.install && native.download !== false && quiet && idleMs != null && idleMs >= t.idle && !seen(`night:${update.label}:${dayOf(now)}`)) {
    const end = new Date(now); end.setHours(t.windowEnd, 0, 0, 0);
    return { action: 'run', code: 'night', key: `night:${update.label}:${dayOf(now)}`, until: Math.min(Math.max(end.getTime(), now + t.minHold), now + t.maxHold), why: 'macOS installs downloaded updates overnight' };
  }
  const when = ours && now < ours.at - t.lead ? `the safe point starts at ${hhmm(ours.at - t.lead)} on ${dayOf(ours.at - t.lead)}, before the deadline ${ours.date}` : native.install ? `waiting for the quiet hours ${String(t.windowStart).padStart(2, '0')}:00 to ${String(t.windowEnd).padStart(2, '0')}:00 with nobody at the Mac, or the install starting` : 'waiting for the install to start';
  return { action: 'hold', code: ours && now < ours.at - t.lead ? 'before-deadline' : 'waiting', why: when };
}

export const nativeOffText = ({ update }) => `macOS ${update.version || update.title} is waiting and nothing will install it by itself: "Install macOS updates" is off and no install deadline is enforced. One step for a person at the Mac, because it takes the administrator's password: System Settings > General > Software Update > the (i) next to Automatic updates > turn on "Install macOS updates". After that macOS installs and restarts on its own, and I get every session to a safe point first and resume them afterwards.`;

// ---------- the Mac ----------

// listing: a saved `softwareupdate -l` to read instead of asking (a rehearsal of the whole flow with --dry-run).
export function realOsDeps({ home = os.homedir(), copilotHome, hackamore, state = stateDir(home), bin, node = process.execPath, mac = 'mini', listing = null } = {}) {
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
    listUpdates: async () => {
      if (listing) { try { return { ok: true, text: fs.readFileSync(listing, 'utf8') }; } catch (e) { return { ok: false, text: String(e.message) }; } }
      const r = await run('/usr/sbin/softwareupdate', ['-l'], { timeoutMs: 180000 });
      return { ok: r.code === 0, text: r.stdout + r.stderr };
    },
    native: async () => parseNative(parseDefaults((await run('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.SoftwareUpdate'])).stdout)),
    enforced: async () => parseEnforced((await run('/usr/bin/log', ['show', '--last', '2d', '--style', 'compact', '--predicate', 'process == "softwareupdated" AND eventMessage CONTAINS "EnforcedInstallDate"'], { timeoutMs: 170000 })).stdout),
    imminent: async (withinMs) => INSTALLING.test((await run('/usr/bin/log', ['show', '--last', `${Math.ceil(withinMs / 60000)}m`, '--style', 'compact', '--predicate', '(process == "softwareupdated" OR process == "SoftwareUpdateNotificationManager" OR process == "softwareupdate_notify_agent")'], { timeoutMs: 60000 })).stdout),
    idleMs: async () => { const m = (await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeoutMs: 10000 })).stdout.match(/"HIDIdleTime" = (\d+)/); return m ? Math.round(Number(m[1]) / 1e6) : null; },
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

  // Look, read-only: what is pending, what macOS will do by itself, and the deadline a management server enforces.
  if (!st.checked_at || now - Date.parse(st.checked_at) >= t.recheck || opts.force) {
    const r = await deps.listUpdates();
    if (r.ok) {
      const found = parseUpdates(r.text).filter((u) => u.restart);
      st.pending = found[0] || null; st.checked_at = iso(now);
      out(found.length ? `pending: ${found.map((u) => u.label).join(', ')}` : 'no update that restarts the Mac is pending');
    } else out(`softwareupdate -l failed: ${r.text.slice(0, 160)}`);
    save();
  }
  const update = st.pending || null;
  const native = update ? await deps.native() : null;
  if (update && (!st.enforced_read_at || now - Date.parse(st.enforced_read_at) >= t.readEnforced)) {
    const e = await deps.enforced();
    st.enforced = e ? { at: e.at, version: e.version, date: e.date } : null; st.enforced_read_at = iso(now);
    save();
  }
  const enforced = update ? st.enforced || null : null;
  const hour = deps.hour ? deps.hour() : new Date(now).getHours();
  const imminent = update && !opts.force ? await deps.imminent(t.imminentWithin) : false;
  const d = decide({ update, native: native || {}, enforced, state: st, now, hour, idleMs: update ? await deps.idleMs() : null, imminent, force: Boolean(opts.force), t });
  const res = { decision: d, update, native, enforced };
  if (d.action === 'native-off') {
    if (st.native_off_told !== update.label && !opts.dry_run) { await deps.tell(nativeOffText({ update })); save({ native_off_told: update.label }); out('told once which setting to turn on'); }
    out(`hold (${d.code}): ${d.why}`);
    return res;
  }
  if (d.action !== 'run') { out(`${d.action} (${d.code}): ${d.why}`); return res; }
  if (opts.dry_run) { const p = await plan({ ...opts, resume: true, safe_point: true }, deps).catch(() => null); out(`would run the safe point for ${update.label} (${d.code}: ${d.why})${p ? `: ask ${p.sessions.busy} working session(s) to say READY or DEFER, arm the Apple Account prompt, hold until ${hhmm(d.until)}, resume them after the reboot` : ''}`); return { ...res, would: true }; }

  // The safe point: the proven settle step of restart-copilot, with the app left running.
  const why = `a macOS update (${update.version || update.title}) that macOS installs by itself`;
  let asked = [];
  const hold = async ({ before, asked: a }) => {
    asked = a || [];
    deps.owed?.set(before.filter((s) => s.state === 'busy').map((s) => s.id), `the reboot for ${why}`);
    save({ reboot: { at: iso(deps.now()), label: update.label, planned: true, trigger: d.code }, verified: null, safe: { key: d.key, label: update.label, at: iso(deps.now()), outcome: 'holding' } });
    deps.expectReboot?.(`the ${why} reboot`);
    if (d.code === 'manual') await deps.tell(`Ready for the restart: every working session is at a safe point. Restart the Mac now for ${why}; the app and every job come back and the sessions resume by themselves. If you do not restart it within ${Math.round(t.manualWait / 60000)} minutes I stand down.`);
    out(`safe point reached (${d.code}); holding until ${hhmm(d.until)} for the Mac to restart`);
    for (let armed = deps.now(); deps.now() < d.until;) {
      await deps.sleep(10000);
      if (deps.now() - armed >= t.rearm) { armed = deps.now(); deps.expectReboot?.(`the ${why} reboot`); }
    }
  };
  const report = await restart({ ...opts, resume: true, why, what: 'the Mac restarts', safe_point: hold, t: { ...(opts.t || {}), settleMax: t.settleMax } }, deps, (m) => out(m));
  if (report.safe_point) {
    // The Mac is still up: stand down. Nothing stays armed or owed, and the sessions that stopped for the safe point carry on.
    const told = await Promise.all(asked.map((x) => sendTo(deps, x.id, cancelText({ why }), 30000)));
    deps.owed?.clear?.();
    st.reboot = null; st.safe = { ...(st.safe || {}), key: d.key, label: update.label, at: st.safe?.at || iso(now), outcome: 'stood-down' };
    save({ reboot: null, safe: st.safe });
    out(`the Mac did not restart; stood down and told ${told.filter((r) => r.ok).length} of ${asked.length} session(s) to carry on`);
  }
  deps.lastWrite?.(report);
  return { ...res, report };
}

export const renderPass = (r) => `${r.decision.action.toUpperCase()} (${r.decision.code}): ${r.decision.why}${r.update ? `\n  pending: ${r.update.label}` : ''}${r.native ? `\n  macOS: automatic download ${r.native.download ? 'on' : 'off'}, install ${r.native.install ? 'on' : 'off'}, critical ${r.native.critical ? 'on' : 'off'}` : ''}${r.enforced ? `\n  enforced: ${r.enforced.version} by ${r.enforced.date}` : ''}`;

