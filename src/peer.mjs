// The peer link, the Mac's end: Ouroboros (the agent on the Mac) and Housesitter (the agent on the KVM) talk in
// free text through two secret gists. Ouroboros writes O_TO_H and reads H_TO_O; Housesitter the other way round
// (plugins/housesitter/peer.py).
//
// One immutable gist file per message, <UTC yyyymmddTHHMMSSZ>-<8 hex>.json, holding
// {v: 1, id, at, from, to, text, re?}. A read is conditional (ETag; 304: nothing new) and returns the messages not yet
// in the seen-set, oldest first.
//
// No cap and no batching of our own (the owner, 2026-11-19: "set no caps unless there is some fundamental limit"): a
// message goes into a durable queue (peer-outbox.jsonl) and out at once, everything queued, with the deletion of the
// sender's own files older than 24 hours, in one PATCH. The only limit is GitHub's: when it answers a write with a rate
// limit (429, or 403 with Retry-After, x-ratelimit-reset or "rate limit" in its message), the messages stay queued, the
// wait is logged (peer-wait in peer-log.jsonl) and nothing is written until then. send flushes; inbox,
// `housesitter peer flush` and `housesitter peer watch` (src/peer-watch.mjs) flush whatever is still queued.
// HOUSESITTER_PEER_FLUSH_SEC and HOUSESITTER_PEER_MAX_PER_HOUR are no longer read.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ghCliToken } from './outbox.mjs';

export const O_TO_H = 'd10a53ca03a65b26aa2a4bbb96cec03d';
export const H_TO_O = '94a9ee97baab459bb32a37d6dbb7c52d';
export const KEEP_MS = 24 * 3600 * 1000;
export const SEEN_MAX = 500;
// The peer gists' owner. Without GH_TOKEN the link uses gh's token for this login, not gh's active account: GitHub
// limits gist reads per token, and another account's token may be spent (2026-11-10, on another account).
export const OWNER = 'arimendelow';
const NAME = /^(\d{8})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}\.json$/;

// When GitHub's rate limit lets us write again (ms), for an error from a write; null when it isn't a rate limit (GitHub
// sends x-ratelimit-reset on every answer, so that alone says nothing). Its Retry-After first, then x-ratelimit-reset
// (epoch seconds) when none remain, else a minute (GitHub's advice for a secondary limit).
export function rateLimitedUntil(e, now) {
  const limited = e?.status === 429 || (e?.status === 403 && (e.retryAfter != null || e.remaining === 0 || /rate limit/i.test(e.message || '')));
  if (!limited) return null;
  const at = e.retryAfter != null ? now + e.retryAfter * 1000 : e.remaining === 0 && e.reset != null ? e.reset * 1000 : now + 60e3;
  return Math.max(at, now + 1000);
}

export const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function fileTime(name) {
  const m = NAME.exec(name);
  return m ? Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2]}:${m[3]}:${m[4]}Z`) : null;
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

// An exclusive lock file; returns its release, or null when another process holds it (wait: false) or kept it past
// 10 s. A lock older than staleMs was left by a process that died, and is taken over.
function lock(file, { wait = true, staleMs = 30000 } = {}) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); continue; }
    } catch { continue; }
    if (!wait || Date.now() > deadline) return null;
    Atomics.wait(SLEEP, 0, 0, 20);
  }
}

// dir holds peer-outbox.jsonl, peer-flush.json, peer-seen.json, peer-etag.json and peer-log.jsonl. clock: tests.
// A planned drill (a battle test, a heal test): `housesitter peer drill <label>` writes drill.json beside the peer
// state until it ends. While it runs, everything sent on the link starts with "[planned drill: <label>]", so neither
// agent reports the drill to Ari as a real incident (2026-11-10: a heal test reached Ari as an overnight outage).
export function drillLabel(dir, now = Date.now()) {
  const d = readJson(path.join(dir, 'drill.json'), null);
  return d && typeof d.label === 'string' && d.label && Date.parse(d.until) > now ? d.label : null;
}
export const drillText = (text, label) => (label && !text.startsWith('[planned drill') ? `[planned drill: ${label}] ${text}` : text);
export const DRILL_NOTE = (label) => `This is a planned drill (${label}): handle it for real, but say "planned drill (${label})" in anything you report, and don't relay it to Ari as an incident.`;

// Who a message is from. `ouroboros@host` belongs to Ouroboros's own daemon; anything else on the Mac signs as itself:
// the --as name, or the Copilot session that ran the command.
export function sender({ as, env = process.env, host = os.hostname().replace(/\.local$/, '') } = {}) {
  const clean = (v) => String(v).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const sid = env.COPILOT_SESSION_ID || env.COPILOT_AGENT_SESSION_ID;
  const name = as ? clean(as) : sid ? `copilot-${clean(sid).slice(0, 8)}` : env.COPILOT_CLI ? 'copilot' : 'ouroboros';
  return `${name || 'unknown'}@${host}`;
}

export function peer({ dir, token, user, ghToken = ghCliToken, env = process.env, fetchFn = globalThis.fetch, from = `ouroboros@${os.hostname().replace(/\.local$/, '')}`, clock = Date.now } = {}) {
  const api = (env.HOUSESITTER_GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
  const outGist = env.HOUSESITTER_PEER_OUT || O_TO_H;
  const inGist = env.HOUSESITTER_PEER_IN || H_TO_O;
  let tok = null;
  const auth = () => (tok ??= token ? (typeof token === 'function' ? token() : token) : env.GH_TOKEN || env.GITHUB_TOKEN || ghToken(undefined, { user: user || env.HOUSESITTER_PEER_USER || OWNER }));
  const req = async (method, url, { body, etag, raw } = {}) => {
    const headers = { Authorization: `Bearer ${auth()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'housesitter-peer', 'X-GitHub-Api-Version': '2022-11-28' };
    if (etag) headers['If-None-Match'] = etag;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetchFn(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    if (r.status === 304) return { status: 304, etag };
    const text = await r.text();
    if (r.status >= 300) {
      let msg = '';
      try { msg = JSON.parse(text).message || ''; } catch { /* not JSON */ }
      const e = new Error(`GitHub ${method} ${url.split('?')[0]} -> HTTP ${r.status}${msg ? `: ${msg}` : ''}`);
      e.status = r.status;
      e.retryAfter = int(r.headers.get('retry-after'), null);
      e.reset = int(r.headers.get('x-ratelimit-reset'), null);
      e.remaining = int(r.headers.get('x-ratelimit-remaining'), null);
      throw e;
    }
    return { status: r.status, etag: r.headers.get('etag'), body: raw ? text : (text ? JSON.parse(text) : null) };
  };
  const gist = (id, etag) => req('GET', `${api}/gists/${id}`, { etag });
  const log = (e) => { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'peer-log.jsonl'), `${JSON.stringify({ ...e, logged: iso(Date.now()) })}\n`); };

  // Every well-formed message in a gist, oldest first; a file that isn't one is skipped.
  async function messages(g) {
    const out = [];
    for (const [name, f] of Object.entries(g?.files || {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (!NAME.test(name) || !f) continue;
      try {
        const content = f.truncated && f.raw_url ? (await req('GET', f.raw_url, { raw: true })).body : f.content;
        const m = JSON.parse(content);
        if (m && m.id && m.at && typeof m.text === 'string') out.push({ ...m, file: name });
      } catch { /* not a message */ }
    }
    return out.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.file.localeCompare(b.file));
  }

  const queueFile = path.join(dir, 'peer-outbox.jsonl');
  const flushFile = path.join(dir, 'peer-flush.json');
  const readQueue = () => {
    let text = '';
    try { text = fs.readFileSync(queueFile, 'utf8'); } catch { return []; }
    return text.split('\n').flatMap((l) => {
      try { const e = JSON.parse(l); return e && e.file && e.msg && typeof e.msg === 'object' ? [e] : []; } catch { return []; } // a half-written line is not a message
    });
  };
  const withQueueLock = (fn) => {
    fs.mkdirSync(dir, { recursive: true });
    const release = lock(path.join(dir, 'peer-outbox.lock'));
    if (!release) throw new Error(`peer: the outbox at ${queueFile} stayed locked`);
    try { return fn(); } finally { release(); }
  };

  // Write the queue to the out gist in one PATCH, with the deletions of files over a day old, unless GitHub asked us to
  // wait. GitHub's rate limit keeps the messages queued until the time it gave; any other failed PATCH throws, and the
  // messages stay queued for the next flush.
  async function flush() {
    const ts = clock();
    fs.mkdirSync(dir, { recursive: true });
    const release = lock(path.join(dir, 'peer-flush.lock'), { wait: false, staleMs: 120000 });
    if (!release) return { ok: true, sent: [], queued: readQueue().length, busy: true };
    try {
      const queue = withQueueLock(readQueue);
      if (!queue.length) return { ok: true, sent: [], queued: 0 };
      const st = readJson(flushFile, {}) || {};
      if (typeof st.retry_at === 'number' && ts < st.retry_at) return { ok: true, sent: [], queued: queue.length, rate_limited: true, retry_at: iso(st.retry_at) };
      let pruned = [];
      try {
        const g = (await gist(outGist)).body;
        pruned = Object.keys(g?.files || {}).filter((n) => fileTime(n) != null && ts - fileTime(n) > KEEP_MS).sort();
      } catch { /* pruning is housekeeping: a failed read never stops a message */ }
      const files = Object.fromEntries(pruned.map((n) => [n, null]));
      for (const e of queue) files[e.file] = { content: JSON.stringify(e.msg) };
      try {
        await req('PATCH', `${api}/gists/${outGist}`, { body: { files } });
      } catch (e) {
        const until = rateLimitedUntil(e, ts);
        if (until == null) throw e;
        writeJson(flushFile, { last: st.last, retry_at: until });
        log({ at: iso(ts), event: 'peer-wait', queued: queue.length, retry_at: iso(until), status: e.status, why: e.message.slice(0, 200) });
        return { ok: true, sent: [], queued: queue.length, rate_limited: true, retry_at: iso(until) };
      }
      writeJson(flushFile, { last: ts });
      const done = new Set(queue.map((e) => e.msg.id));
      const left = withQueueLock(() => {
        const rest = readQueue().filter((e) => !done.has(e.msg.id));
        const t = `${queueFile}.${process.pid}.tmp`;
        fs.writeFileSync(t, rest.map((e) => `${JSON.stringify(e)}\n`).join(''));
        fs.renameSync(t, queueFile);
        return rest;
      });
      for (const e of queue) log({ dir: 'sent', gist: outGist, file: e.file, msg: e.msg });
      log({ dir: 'flush', gist: outGist, at: iso(ts), files: queue.map((e) => e.file), pruned });
      return { ok: true, sent: queue.map((e) => e.msg.id), queued: left.length, pruned };
    } finally {
      release();
    }
  }

  return {
    flush,
    // Queue one message, then flush if due (now: at once, if the hourly cap allows). It is on disk before anything is
    // written to GitHub, so it's never lost; status says whether it went (sent) or waits (queued).
    async send(text, { re = null, to = 'housesitter', now = false } = {}) {
      if (typeof text !== 'string' || !text) throw new Error('peer send: a message needs some text');
      const ts = clock();
      text = drillText(text, drillLabel(dir, ts));
      const id = crypto.randomBytes(4).toString('hex');
      const msg = { v: 1, id, at: iso(ts), from, to, text, ...(re ? { re } : {}) };
      const file = `${stamp(ts)}-${id}.json`;
      withQueueLock(() => {
        const fd = fs.openSync(queueFile, 'a');
        try { fs.writeSync(fd, `${JSON.stringify({ file, msg })}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      });
      let r;
      try { r = await flush(); } catch (e) { r = { error: e.message }; } // it stays queued for the next flush
      const out = { ok: true, id, at: msg.at, file, to, status: (r.sent || []).includes(id) ? 'sent' : 'queued' };
      for (const k of ['pruned', 'queued', 'rate_limited', 'retry_at', 'busy', 'error']) if (k in r) out[k] = r[k];
      return out;
    },
    // The peer's messages not yet read with inbox, without marking them; a conditional GET against etag (from an
    // earlier peek) returns unchanged when the gist hasn't changed. It never writes.
    async peek(etag = null) {
      const r = await gist(inGist, etag);
      if (r.status === 304) return { unchanged: true, etag, messages: [] };
      const seen = [].concat(readJson(path.join(dir, 'peer-seen.json'), []) || []);
      return { etag: r.etag, messages: (await messages(r.body)).filter((m) => !seen.includes(m.id)) };
    },
    // New messages from the peer; unless peeking, it also flushes the out queue if that's due.
    async inbox({ mark = true } = {}) {
      fs.mkdirSync(dir, { recursive: true });
      let flushed = {};
      if (mark) { try { flushed = await flush(); } catch (e) { flushed = { error: e.message }; } }
      const outbox = flushed.sent?.length || flushed.error || flushed.rate_limited ? { outbox: Object.fromEntries(Object.entries(flushed).filter(([k]) => k !== 'ok')) } : {};
      const etagFile = path.join(dir, 'peer-etag.json');
      const seenFile = path.join(dir, 'peer-seen.json');
      const etags = readJson(etagFile, {}) || {};
      const seen = [].concat(readJson(seenFile, []) || []);
      const r = await gist(inGist, mark ? etags[inGist] : null);
      if (r.status === 304) return { ok: true, messages: [], unchanged: true, ...outbox };
      const fresh = (await messages(r.body)).filter((m) => !seen.includes(m.id));
      if (mark) {
        for (const m of fresh) log({ dir: 'received', gist: inGist, file: m.file, msg: m });
        writeJson(seenFile, [...seen, ...fresh.map((m) => m.id)].slice(-SEEN_MAX));
        if (r.etag) writeJson(etagFile, { ...etags, [inGist]: r.etag });
      }
      return { ok: true, messages: fresh, ...outbox };
    },
  };
}
