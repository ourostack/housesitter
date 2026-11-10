// The peer link, the Mac's end: Ouroboros (the agent on the Mac) and Housesitter (the agent on the KVM) talk in
// free text through two secret gists. Ouroboros writes O_TO_H and reads H_TO_O; Housesitter the other way round
// (plugins/housesitter/peer.py).
//
// One immutable gist file per message, <UTC yyyymmddTHHMMSSZ>-<8 hex>.json, holding
// {v: 1, id, at, from, to, text, re?}. A send also deletes the sender's own files older than 24 hours, in the same
// PATCH. A read is conditional (ETag; 304: nothing new) and returns the messages not yet in the seen-set, oldest first.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ghCliToken } from './outbox.mjs';

export const O_TO_H = 'd10a53ca03a65b26aa2a4bbb96cec03d';
export const H_TO_O = '94a9ee97baab459bb32a37d6dbb7c52d';
export const KEEP_MS = 24 * 3600 * 1000;
export const SEEN_MAX = 500;
const NAME = /^(\d{8})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}\.json$/;

export const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function fileTime(name) {
  const m = NAME.exec(name);
  return m ? Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2]}:${m[3]}:${m[4]}Z`) : null;
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };

// dir holds peer-seen.json, peer-etag.json and peer-log.jsonl.
export function peer({ dir, token, env = process.env, fetchFn = globalThis.fetch, from = `ouroboros@${os.hostname().replace(/\.local$/, '')}` } = {}) {
  const api = (env.HOUSESITTER_GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
  const outGist = env.HOUSESITTER_PEER_OUT || O_TO_H;
  const inGist = env.HOUSESITTER_PEER_IN || H_TO_O;
  let tok = null;
  const auth = () => (tok ??= token ? (typeof token === 'function' ? token() : token) : env.GH_TOKEN || env.GITHUB_TOKEN || ghCliToken());
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
      throw new Error(`GitHub ${method} ${url.split('?')[0]} -> HTTP ${r.status}${msg ? `: ${msg}` : ''}`);
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

  return {
    async send(text, { re = null, to = 'housesitter', now = Date.now() } = {}) {
      if (typeof text !== 'string' || !text) throw new Error('peer send: a message needs some text');
      const id = crypto.randomBytes(4).toString('hex');
      const msg = { v: 1, id, at: iso(now), from, to, text, ...(re ? { re } : {}) };
      const name = `${stamp(now)}-${id}.json`;
      let pruned = [];
      try {
        const g = (await gist(outGist)).body;
        pruned = Object.keys(g?.files || {}).filter((n) => fileTime(n) != null && now - fileTime(n) > KEEP_MS).sort();
      } catch { /* pruning is housekeeping: a failed read never stops a message */ }
      const files = Object.fromEntries(pruned.map((n) => [n, null]));
      files[name] = { content: JSON.stringify(msg) };
      await req('PATCH', `${api}/gists/${outGist}`, { body: { files } });
      log({ dir: 'sent', gist: outGist, file: name, msg, pruned });
      return { ok: true, id, at: msg.at, file: name, to, pruned };
    },
    async inbox({ mark = true } = {}) {
      fs.mkdirSync(dir, { recursive: true });
      const etagFile = path.join(dir, 'peer-etag.json');
      const seenFile = path.join(dir, 'peer-seen.json');
      const etags = readJson(etagFile, {}) || {};
      const seen = [].concat(readJson(seenFile, []) || []);
      const r = await gist(inGist, mark ? etags[inGist] : null);
      if (r.status === 304) return { ok: true, messages: [], unchanged: true };
      const fresh = (await messages(r.body)).filter((m) => !seen.includes(m.id));
      if (mark) {
        for (const m of fresh) log({ dir: 'received', gist: inGist, file: m.file, msg: m });
        writeJson(seenFile, [...seen, ...fresh.map((m) => m.id)].slice(-SEEN_MAX));
        if (r.etag) writeJson(etagFile, { ...etags, [inGist]: r.etag });
      }
      return { ok: true, messages: fresh };
    },
  };
}
