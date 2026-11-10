// The outbox transport: reach the sitter from anywhere with only GitHub, no tailnet and no open port.
//
// The sitter writes its status (and screenshots on request) to a secret "outbox" gist and polls a secret "inbox"
// gist every couple of seconds, with ETags, so an unchanged inbox costs nothing against the rate limit. A command
// is {v, id, op, args, at}. The sitter marks the id seen before acting (a request never runs twice), drops requests
// older than 10 minutes, keeps its own rate limits, and replies {v, re, ok, code, result, ms} in the outbox.
// Measured with a stand-in sitter over real GitHub: status ~0.4 s, a command ~1.7-3.8 s.
//
// What it's for: the moment you most need the KVM is when the Mac is down, and an agent host off the tailnet (a
// managed laptop, a CI runner) can still reach GitHub. Typed text passes through a gist, so `type` refuses anything
// that looks like a password; the Mac's password never travels this way (the sitter types its own copy).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';

const API = 'https://api.github.com';
export const OPS = ['status', 'look', 'screenshot', 'unlock', 'power_cycle', 'power_on', 'click', 'type', 'key', 'scroll'];

// gh's token: for `user` (a github.com login) when gh is signed in to it, else gh's active account.
export function ghCliToken(run = spawnSync, { user } = {}) {
  const opts = { encoding: 'utf8', env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` } };
  if (user) {
    const u = run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', user], opts);
    if (u.status === 0 && String(u.stdout).trim()) return String(u.stdout).trim();
  }
  const r = run('gh', ['auth', 'token'], opts);
  if (r.status !== 0) throw new Error('outbox: no GitHub token (set outbox.token in the config, or sign in with `gh auth login`)');
  return String(r.stdout).trim();
}

export function gistClient({ token, fetchFn = globalThis.fetch, userAgent = 'housesitter' } = {}) {
  let tok = null;
  const req = async (method, p, body, etag) => {
    tok ??= typeof token === 'function' ? token() : token;
    const headers = { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': userAgent, 'X-GitHub-Api-Version': '2022-11-28' };
    if (etag) headers['If-None-Match'] = etag;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetchFn(`${API}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    if (r.status === 304) return { status: 304, etag };
    const j = await r.json().catch(() => null);
    if (r.status >= 300) throw new Error(`GitHub ${method} ${p.split('?')[0]} -> HTTP ${r.status}${j?.message ? `: ${j.message}` : ''}`);
    return { status: r.status, etag: r.headers.get('etag'), body: j };
  };
  const files = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { content: v }]));
  return {
    get: (id, etag) => req('GET', `/gists/${id}`, null, etag),
    put: (id, f) => req('PATCH', `/gists/${id}`, { files: files(f) }),
    create: (description, f) => req('POST', '/gists', { description, public: false, files: files(f) }),
  };
}

const fileOf = (g, name) => g?.files?.[name]?.content ?? null;

export async function readStatus(name, o, gh) {
  const r = await gh.get(o.gist);
  const t = fileOf(r.body, `${name}.sitter.json`);
  return t ? JSON.parse(t) : null;
}

// One request through the inbox, then wait for its reply in the outbox.
export async function send(name, o, gh, op, args = {}, { timeoutMs = 15000, pollMs = 600, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), id = crypto.randomUUID() } = {}) {
  if (!o?.gist || !o?.inbox) throw new Error(`${name} has no outbox (housesitter outbox ${name} --create sets one up)`);
  const t0 = now();
  const cmd = { v: 1, id, op: op.replace(/-/g, '_'), args, at: now(), from: os.hostname() };
  await gh.put(o.inbox, { [`${name}.cmd.json`]: JSON.stringify(cmd) });
  let etag = null;
  while (now() - t0 < timeoutMs) {
    await sleep(pollMs);
    const r = await gh.get(o.gist, etag).catch(() => null);
    if (!r || r.status === 304) continue;
    etag = r.etag;
    let rep = null;
    try { rep = JSON.parse(fileOf(r.body, `${name}.reply.json`) || 'null'); } catch { /* half-written: next poll */ }
    if (rep?.re === id) return { ...rep, files: r.body.files, roundTripMs: now() - t0 };
  }
  return { ok: false, code: 'timeout', result: `no reply from the sitter within ${Math.round(timeoutMs / 1000)} s (it polls every few seconds: is it on, and is its internet up? the request is marked seen when it runs, so check status before retrying)`, roundTripMs: now() - t0 };
}

export async function createGists(name, gh) {
  const note = (role) => `# ${name}: housesitter ${role}\n\nWritten by the housesitter sitter on ${name}'s KVM and by the housesitter CLI. https://github.com/ourostack/housesitter\n`;
  const a = await gh.create(`${name} housesitter outbox (status, replies, screenshots)`, { 'README.md': note('outbox') });
  const b = await gh.create(`${name} housesitter inbox (commands)`, { 'README.md': note('inbox') });
  return { gist: a.body.id, inbox: b.body.id };
}
