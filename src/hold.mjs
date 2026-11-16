// Keeping chosen launchd jobs off. A user-domain `launchctl disable` does not survive a restart, so a job that was
// disabled comes back on at the next boot, and one that keeps crashing the Mac is only held off if something disables it
// again. The config's `launchd_disabled` lists those labels; the hold job (every hour) disables each one again if it came
// back on, and stops it if it is running.

import { spawnSync } from 'node:child_process';
import { configPath } from './config.mjs';

const LABEL = /^[A-Za-z0-9._-]{3,128}$/;

// A running job is stopped with SIGTERM to its own PID, read from launchd. `launchctl kill` is refused for Apple's own
// agents on recent macOS, but the process belongs to this user, so a signal to its PID is allowed.
export function holdDisabled(labels, { uid = process.getuid(), run = spawnSync, kill = (pid) => process.kill(pid, 'SIGTERM'), dry = false } = {}) {
  const out = [];
  const lc = (args) => { const r = run('/bin/launchctl', args, { encoding: 'utf8', timeout: 10000 }); return { status: r.status, text: `${r.stdout || ''}${r.stderr || ''}` }; };
  const disabledList = lc(['print-disabled', `gui/${uid}`]).text;
  for (const label of Array.isArray(labels) ? labels : []) {
    if (!LABEL.test(label)) { out.push({ label, error: 'not a launchd label' }); continue; }
    const target = `gui/${uid}/${label}`;
    const was = new RegExp(`"${label.replace(/\./g, '\\.')}" => (true|disabled)`).test(disabledList);
    if (!was && !dry) lc(['disable', target]);
    const info = lc(['print', target]).text;
    const running = /^\s*state = running/m.test(info);
    const pid = Number((/^\s*pid = (\d+)/m.exec(info) || [])[1]);
    const stopNeeded = running && pid > 1;
    let stopped = false;
    if (!dry && stopNeeded) {
      try { kill(pid); stopped = true; } catch (e) {
        out.push({ label, disabled_again: !was, error: `could not stop pid ${pid}: ${e.code || e.message}` });
        continue;
      }
    }
    out.push({ label, disabled_again: !was, stopped: dry ? stopNeeded : stopped, pid: stopNeeded ? pid : null, ...(dry ? { dry_run: true } : {}) });
  }
  return out;
}

export const acted = (rows) => rows.filter((r) => r.disabled_again || r.stopped || r.error);

export function renderHold(rows) {
  return acted(rows).map((r) => {
    if (r.error) return `✗ ${r.label}: ${r.error}`;
    const verb = r.dry_run ? 'would ' : '';
    const steps = [r.disabled_again ? `${verb}disable it again (it had come back on)` : null, r.stopped ? `${verb}stop it (pid ${r.pid})` : null].filter(Boolean);
    return `${r.label}: ${steps.join(' and ')}`;
  }).join('\n');
}

export const NO_LIST = `nothing to hold: no launchd_disabled list in ${configPath()}. Add the labels to keep off, e.g. {"launchd_disabled": ["com.example.job"]}`;
export const PREVIEW = 'hold: dry run; nothing was done. Without --dry-run this acts for the person, and other people see it.';
export const ALL_OFF = (n) => `all ${n} held job${n === 1 ? ' is' : 's are'} off already`;
