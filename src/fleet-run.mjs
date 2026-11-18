// `housesitter fleet run <host> <step>`: one Mac asks another to run a named step, through the fleet gist the Macs already share.
//
// The channel is two small files per request in the fleet gist, neither of which is a health record (no `machine` key, so
// `housesitter fleet` ignores them):
//   run.<id>.req.json   {v, id, from, to, step, at, expires_at}      written by the asking Mac
//   run.<id>.res.json   {v, id, host, step, status, exit_code, output_tail, started_at, finished_at}   written by the target
// Only a step NAME travels. What a step runs is the target's own `caretakers.fleet_run` allowlist in its config; a name that
// is not on it is refused and never run, and nothing but the name, an id and times goes into the gist (output is scrubbed of
// anything that looks like a credential before it is posted).
//
// The target runs `fleet run --serve` from launchd (AGENTS.fleet in recovery.mjs). A pass reads the gist (ETag, so an unchanged
// gist costs nothing), and for each request addressed to this host that has no result and has not been seen: it marks the id
// seen BEFORE acting (a request runs at most once, even if the run dies), refuses it if it is older than a day or off the
// allowlist, else runs the argv with a timeout and posts the exit code and the last lines. A result that could not be posted
// is kept and posted on a later pass. Files older than two days addressed to this host are removed in the same write.
// Both ends append to fleet-run.log.
//
//   "caretakers": { "fleet_run": {
//       "host": "laptop",                                   // this Mac's name in the fleet (default: its hostname)
//       "bootstrap": { "script": "~/…/bootstrap-laptop.sh", "steps": ["copilot-pins", "runner"], "timeout_sec": 900 },
//       "allow": { "<step>": { "argv": ["/path/to/tool", "arg"], "timeout_sec": 600 } } } }

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXPIRES_MS = 24 * 3600 * 1000;
export const KEEP_MS = 48 * 3600 * 1000;
export const DEFAULT_TIMEOUT_SEC = 600;
export const MAX_TIMEOUT_SEC = 3600;
export const TAIL_LINES = 20;
export const TAIL_CHARS = 3000;
export const STEP_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ID_RE = /^[0-9a-f]{12}$/;
const SKEW_MS = 5 * 60000;

export const reqFile = (id) => `run.${id}.req.json`;
export const resFile = (id) => `run.${id}.res.json`;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const home = (p) => String(p).replace(/^~(?=\/)/, os.homedir());
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };

/** This Mac's name in the fleet: the config's, else HOUSESITTER_FLEET_HOST, else its hostname without the domain. */
export function hostName(cfg = {}, env = process.env, hostname = os.hostname()) {
  return (cfg.caretakers?.fleet_run?.host || env.HOUSESITTER_FLEET_HOST || hostname.split('.')[0]).toLowerCase();
}

/** The steps this Mac may run, as { step: { argv, timeoutSec } }: the config's allowlist, and nothing when it has none. */
export function allowlist(cfg = {}) {
  const c = cfg.caretakers?.fleet_run || {};
  const out = {};
  const secs = (v) => Math.min(MAX_TIMEOUT_SEC, Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : DEFAULT_TIMEOUT_SEC);
  const b = c.bootstrap;
  if (b?.script && Array.isArray(b.steps)) {
    for (const s of b.steps) if (STEP_RE.test(s)) out[s] = { argv: ['/bin/bash', home(b.script), '--only', s], timeoutSec: secs(b.timeout_sec) };
  }
  for (const [s, e] of Object.entries(c.allow || {})) {
    if (STEP_RE.test(s) && Array.isArray(e?.argv) && e.argv.length && e.argv.every((a) => typeof a === 'string')) out[s] = { argv: e.argv.map(home), timeoutSec: secs(e.timeout_sec) };
  }
  return out;
}

const SECRET = [
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(\b[A-Za-z0-9_]*(?:token|secret|password|passwd|apikey|api_key|authkey)[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** The last lines of a run's output, with escape codes and anything credential-shaped removed. */
export function tail(text, { lines = TAIL_LINES, chars = TAIL_CHARS } = {}) {
  let t = String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
  for (const re of SECRET) t = t.replace(re, (m, p1) => (typeof p1 === 'string' && p1 ? `${p1}[redacted]` : '[redacted]'));
  const kept = t.split('\n').filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1)).slice(-lines).join('\n');
  return kept.length > chars ? `…${kept.slice(-chars)}` : kept;
}

export function newRequest({ from, to, step, now = Date.now(), id = crypto.randomBytes(6).toString('hex') }) {
  return { v: 1, id, from, to, step, at: iso(now), expires_at: iso(now + EXPIRES_MS) };
}

/** Requests and results in a gist body, by id. Anything malformed is ignored, never acted on. */
export function channelOf(gist) {
  const requests = [];
  const results = {};
  for (const [file, f] of Object.entries(gist?.files || {})) {
    const m = /^run\.([0-9a-f]{12})\.(req|res)\.json$/.exec(file);
    if (!m) continue;
    let j;
    try { j = JSON.parse(f.content); } catch { continue; }
    if (!j || j.v !== 1 || j.id !== m[1]) continue;
    if (m[2] === 'res') { if (typeof j.status === 'string') results[j.id] = j; continue; }
    if (typeof j.to === 'string' && typeof j.step === 'string' && Number.isFinite(Date.parse(j.at))) requests.push(j);
  }
  return { requests: requests.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), results };
}

/** What a pass does with one request: ignore it (not for this host, or already handled), or expire, refuse or run it. */
export function decide(req, { host, allow, seen, results, now }) {
  if (req.to.toLowerCase() !== host) return { act: 'ignore', why: 'not for this host' };
  if (results[req.id]) return { act: 'ignore', why: 'already has a result' };
  if (seen[req.id]) return { act: 'ignore', why: 'already picked up' };
  const at = Date.parse(req.at);
  if (at > now + SKEW_MS) return { act: 'ignore', why: 'dated in the future' };
  if (now - at > EXPIRES_MS) return { act: 'expire' };
  if (!STEP_RE.test(req.step) || !Object.hasOwn(allow, req.step)) return { act: 'refuse' };
  return { act: 'run', entry: allow[req.step] };
}

/** One request per row, newest first, each with what became of it. */
export function runRows(gist, now = Date.now()) {
  const { requests, results } = channelOf(gist);
  return requests.map((r) => {
    const res = results[r.id];
    const expired = !res && now - Date.parse(r.at) > EXPIRES_MS;
    return {
      id: r.id, from: r.from ?? null, to: r.to, step: r.step, at: r.at,
      state: res ? res.status : expired ? 'expired' : 'pending',
      exit_code: res?.exit_code ?? null, finished_at: res?.finished_at ?? null, output_tail: res?.output_tail ?? '',
    };
  }).reverse();
}

export function renderRows(rows) {
  if (!rows.length) return ['No run requests in the fleet gist.'];
  return rows.flatMap((r) => [
    `${r.state === 'ok' ? '○' : r.state === 'pending' ? '…' : '●'} ${r.id}  ${r.to}: ${r.step}  asked ${r.at} by ${r.from ?? '?'}  → ${r.state}${r.exit_code != null ? ` (exit ${r.exit_code})` : ''}`,
    ...(r.output_tail ? r.output_tail.split('\n').map((l) => `    ${l}`) : []),
  ]);
}

export function logLine(dir, rec, now = Date.now()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'fleet-run.log'), `${JSON.stringify({ t: iso(now), ...rec })}\n`);
  } catch { /* a log that cannot be written must not stop a run */ }
}

/** The asking end: write one request. Refuses a step name that could not be a step, and a host with no health record. */
export async function requestRun({ gh, gistId, dir, from, to, step, now = Date.now(), id, knownHosts }) {
  if (!STEP_RE.test(step || '')) throw Object.assign(new Error(`"${step}" is not a step name (lowercase letters, digits, . _ -)`), { code: 'input-invalid' });
  if (knownHosts && !knownHosts.includes(to)) throw Object.assign(new Error(`no Mac called "${to}" publishes to the fleet gist (known: ${knownHosts.join(', ') || 'none'})`), { code: 'input-invalid' });
  const req = newRequest({ from, to, step, now, id });
  await gh.put(gistId, { [reqFile(req.id)]: JSON.stringify(req) });
  logLine(dir, { end: 'asker', ev: 'requested', id: req.id, to, step }, now);
  return req;
}

const statePath = (dir) => path.join(dir, 'fleet-run.json');

function lock(file, staleMs) {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => { try { fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs > staleMs) fs.unlinkSync(file); else return null; } catch { /* raced */ }
    }
  }
  return null;
}

/** Runs argv with no shell; resolves when it exits or after timeoutMs, when its whole process group is killed. */
export function realExec(argv, { timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', ...env } });
    } catch (e) { resolve({ code: null, signal: null, timedOut: false, output: `could not start: ${e.message}` }); return; }
    const add = (d) => { out = (out + d).slice(-65536); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, timeoutMs);
    // A step may leave a service running that holds our pipes; its exit is what counts, so wait only briefly for the rest.
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); resolve({ code, signal, timedOut, output: out }); }, 1500);
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, timedOut: false, output: `${out}could not start: ${e.message}` }); });
  });
}

/**
 * One serving pass for this host. Returns { action, handled: [{ id, step, outcome }] }. `exec` and `clock` are for tests.
 * Nothing here reads a step's command from the gist: the argv comes only from `allow`.
 */
export async function pass({ gh, gistId, dir, host, allow, exec = realExec, clock = Date.now, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const release = lock(path.join(dir, 'fleet-run.lock'), (MAX_TIMEOUT_SEC + 120) * 1000);
  if (!release) return { action: 'busy', handled: [] };
  try {
    const st = { seen: {}, unposted: {}, etag: null, ...readJson(statePath(dir), {}) };
    const save = () => writeJson(statePath(dir), st);
    const handled = [];
    const post = async (files) => gh.put(gistId, files);

    for (const [id, res] of Object.entries(st.unposted)) {
      try { await post({ [resFile(id)]: JSON.stringify(res) }); delete st.unposted[id]; logLine(dir, { end: 'target', host, ev: 'posted', id, status: res.status, late: true }, clock()); } catch { /* try again next pass */ }
    }
    save();

    const r = await gh.get(gistId, Object.keys(st.unposted).length ? null : st.etag);
    if (r.status === 304) return { action: 'unchanged', handled };
    const now = clock();
    const { requests, results } = channelOf(r.body);
    const mine = requests.filter((q) => q.to.toLowerCase() === host);

    for (const req of mine) {
      const d = decide(req, { host, allow, seen: st.seen, results, now: clock() });
      if (d.act === 'ignore') continue;
      st.seen[req.id] = iso(clock());
      save();
      logLine(dir, { end: 'target', host, ev: 'picked-up', id: req.id, step: req.step, from: req.from, decision: d.act }, clock());
      let res;
      if (d.act === 'expire') res = { status: 'expired', exit_code: null, output_tail: `not picked up within a day (asked ${req.at}); not run` };
      else if (d.act === 'refuse') res = { status: 'refused', exit_code: null, output_tail: `"${tail(req.step, { lines: 1, chars: 80 })}" is not on ${host}'s allowlist (caretakers.fleet_run); not run` };
      else {
        const started = iso(clock());
        log(`fleet run ${req.id}: ${req.step} …`);
        const x = await exec(d.entry.argv, { timeoutMs: d.entry.timeoutSec * 1000 });
        const status = x.timedOut ? 'timeout' : x.code === 0 ? 'ok' : 'failed';
        res = { status, exit_code: x.code ?? null, started_at: started, output_tail: tail(x.timedOut ? `${x.output}\n[timed out after ${d.entry.timeoutSec} s and killed]` : x.output) };
      }
      res = { v: 1, id: req.id, host, step: String(req.step).slice(0, 64), finished_at: iso(clock()), ...res };
      logLine(dir, { end: 'target', host, ev: 'ran', id: req.id, step: req.step, status: res.status, exit_code: res.exit_code }, clock());
      const files = { [resFile(req.id)]: JSON.stringify(res) };
      try { await post(files); logLine(dir, { end: 'target', host, ev: 'posted', id: req.id, status: res.status }, clock()); } catch (e) { st.unposted[req.id] = res; logLine(dir, { end: 'target', host, ev: 'post-failed', id: req.id, error: e.message }, clock()); }
      save();
      handled.push({ id: req.id, step: req.step, outcome: res.status });
    }

    const stale = {};
    for (const q of mine) if (now - Date.parse(q.at) > KEEP_MS && (results[q.id] || st.seen[q.id])) { stale[reqFile(q.id)] = null; if (results[q.id]) stale[resFile(q.id)] = null; }
    if (Object.keys(stale).length && !handled.length) { try { await post(stale); } catch { /* next pass */ } }
    for (const [id, at] of Object.entries(st.seen)) if (clock() - Date.parse(at) > 7 * 86400000) delete st.seen[id];
    st.etag = handled.length || Object.keys(stale).length ? null : r.etag;
    save();
    return { action: handled.length ? 'ran' : 'idle', handled };
  } finally { release(); }
}
