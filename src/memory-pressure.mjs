// Per-day memory pressure and swap-ins, sampled on each load-shed pass (every 30 s). Swap % is not a measure on macOS; the
// readings that matter are the worst free-memory percentage of the day and how many pages came back in from swap.
// State: memory-pressure.json { prev_swapins, days: { "YYYY-MM-DD": { min_free_pct, swapins, samples } } }, last 14 days.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, writeJson } from './recovery.mjs';

export const KEEP_DAYS = 14;

export const parseFreePct = (out) => {
  const m = String(out || '').match(/free percentage:\s*(\d+)\s*%/i);
  return m ? Number(m[1]) : null;
};

export const parseSwapins = (out) => {
  const m = String(out || '').match(/^Swapins:\s*(\d+)/m);
  return m ? Number(m[1]) : null;
};

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

// Pure: fold one sample into the state. A swap-ins counter that went down means a reboot reset it, so the new value is the delta.
export function fold(state, { now, freePct, swapins }) {
  const st = { prev_swapins: state?.prev_swapins ?? null, days: { ...(state?.days || {}) } };
  const d = dayOf(now);
  const day = { min_free_pct: null, swapins: 0, samples: 0, ...st.days[d] };
  if (freePct != null) day.min_free_pct = day.min_free_pct == null ? freePct : Math.min(day.min_free_pct, freePct);
  if (swapins != null) {
    if (st.prev_swapins != null) day.swapins += swapins >= st.prev_swapins ? swapins - st.prev_swapins : swapins;
    st.prev_swapins = swapins;
  }
  day.samples += 1;
  st.days[d] = day;
  for (const k of Object.keys(st.days).sort().slice(0, -KEEP_DAYS)) delete st.days[k];
  return st;
}

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 }).stdout;

export function sample({ state, now = Date.now(), platform = process.platform, exec = run } = {}) {
  if (platform !== 'darwin') return null;
  const file = path.join(state, 'memory-pressure.json');
  const next = fold(readJson(file, null), { now, freePct: parseFreePct(exec('/usr/bin/memory_pressure', ['-Q'])), swapins: parseSwapins(exec('/usr/bin/vm_stat', [])) });
  writeJson(file, next);
  return next;
}

export const readMemory = (state) => readJson(path.join(state, 'memory-pressure.json'), null);

export function renderMemory(st, last = 7) {
  const days = Object.keys(st?.days || {}).sort().slice(-last);
  if (!days.length) return 'memory: no readings yet';
  return ['memory pressure and swap-ins per day:', ...days.map((d) => {
    const x = st.days[d];
    return `  ${d.slice(5)} pressure min free ${x.min_free_pct == null ? '?' : `${x.min_free_pct}%`} swap-ins ${x.swapins}`;
  })].join('\n');
}
