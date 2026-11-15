// What each Mac in the fleet says about itself, read from the fleet gist where every Mac publishes a small health record
// (`<machine>.json`, written by whatever runs on that Mac) and turned into one row per Mac: how old its last record is, and
// what is wrong. Read-only: it never changes a Mac or the gist. The pure parts take plain records and a clock, so they run
// without a network; `readFleet` is the one function that reaches GitHub.

import { spawnSync } from 'node:child_process';
import { ghCliToken, gistClient } from './outbox.mjs';
import { OWNER } from './peer.mjs';

export const STALE_MIN = 15;
export const DISK_FLOOR_GB = 20;
// The same fleet gist the Housesitter plugin reads (HOUSESITTER_FLEET_GIST).
export const DEFAULT_GIST = 'ded3f1d37c2a756becc3333b0e4276b4';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What is wrong in one health record, as short sentences; empty when it is healthy. `alwaysOn` names the Macs that must never sleep. */
export function problems(rec, { diskFloorGb = DISK_FLOOR_GB, alwaysOn = [] } = {}) {
  const p = [];
  if (rec.panic?.this_boot) p.push(`booted after a kernel panic (${rec.panic.latest ?? 'no report named'})`);
  if (rec.hub && rec.hub.connected === false) p.push('agent hub not connected');
  for (const d of rec.drains || []) if (!d.ok) p.push(`drain ${d.name}: ${d.loaded === false ? 'not loaded' : `${d.detectors} detectors`}`);
  const free = rec.disk?.free_gb;
  if (free != null && free < diskFloorGb) p.push(`disk ${free} GB free, below ${diskFloorGb} GB`);
  if (alwaysOn.includes(rec.machine) && rec.power && !rec.power.caffeinate) p.push('no caffeinate assertion, so it can sleep');
  if (rec.thermal?.warning || (rec.thermal?.speed_limit != null && rec.thermal.speed_limit < 80)) p.push(`throttling for heat (CPU speed limit ${rec.thermal.speed_limit ?? '?'}%)`);
  if (rec.tokens?.az === false) p.push('az is signed out');
  if (rec.tokens?.gh_personal === false) p.push('gh is signed out of the personal account');
  const missing = rec.usb?.missing || [];
  if (missing.length) p.push(`${plural(missing.length, 'USB device')} missing: ${missing.map((d) => `${d.name}${d.why?.length ? ` (${d.why.join(', ')})` : ''}`).join('; ')}`);
  if (rec.net && rec.net.default_if === null) p.push('no network route');
  if (rec.alerts?.length) p.push(`${plural(rec.alerts.length, 'system alert')} waiting for a person`);
  return p;
}

/** The health records in a gist body (`{ files }`): every `<name>.json` file that holds a record with a `machine` and an `at`. */
export function beatsFromGist(gist) {
  const beats = {};
  for (const [file, f] of Object.entries(gist?.files || {})) {
    if (!file.endsWith('.json')) continue;
    let rec;
    try { rec = JSON.parse(f.content); } catch { continue; }
    if (rec && typeof rec.machine === 'string' && typeof rec.at === 'string') beats[rec.machine] = rec;
  }
  return beats;
}

/** One row per machine, sorted by name. */
export function fleetRows(beats, { now = Date.now(), staleMin = STALE_MIN, diskFloorGb, alwaysOn } = {}) {
  return Object.keys(beats).sort().map((name) => {
    const b = beats[name];
    const age = Math.max(0, Math.round((now - Date.parse(b.at)) / 60000));
    const issues = problems(b, { diskFloorGb, alwaysOn });
    const stale = Number.isNaN(age) || age > staleMin;
    if (stale) issues.unshift(Number.isNaN(age) ? 'its last record has no usable time' : `last record ${age} min old; the Mac is off, asleep or cannot publish`);
    return {
      name, age_min: Number.isNaN(age) ? null : age, stale, healthy: issues.length === 0,
      uptime_min: b.uptime_min ?? null, disk_free_gb: b.disk?.free_gb ?? null,
      screen: b.screen ? (b.screen.locked ? 'locked' : `unlocked, idle ${b.screen.idle_sec} s`) : null,
      accounts: b.app_accounts || [], issues,
    };
  });
}

const span = (m) => (m == null ? '?' : m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);

/** The rows as lines for a person. */
export function renderFleet(rows) {
  if (!rows.length) return ['No health records in the fleet gist. Whatever runs on each Mac publishes `<machine>.json` there; check HOUSESITTER_FLEET_GIST.'];
  return rows.flatMap((r) => [
    `${r.healthy ? '○' : '●'} ${r.name.padEnd(16)} record ${span(r.age_min)} ago · up ${span(r.uptime_min)} · disk ${r.disk_free_gb ?? '?'} GB free${r.screen ? ` · screen ${r.screen}` : ''}`,
    ...(r.accounts.length ? [`    app accounts: ${r.accounts.join(', ')}`] : []),
    ...(r.issues.length ? r.issues.map((i) => `    ⚠ ${i}`) : ['    healthy']),
  ]);
}

/** Reads the fleet gist's records. The token is gh's for `user`, because GitHub limits gist reads per token. */
export async function readFleet({ gistId = process.env.HOUSESITTER_FLEET_GIST || DEFAULT_GIST, user = process.env.HOUSESITTER_FLEET_USER || OWNER, token, fetchFn } = {}) {
  const gh = gistClient({ token: token ?? (() => ghCliToken(spawnSync, { user })), ...(fetchFn ? { fetchFn } : {}) });
  const r = await gh.get(gistId);
  return beatsFromGist(r.body);
}
