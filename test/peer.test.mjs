// The peer link's Mac end (src/peer.mjs and `housesitter peer`), against a local stand-in for GitHub's gist API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peer, stamp, fileTime, O_TO_H, H_TO_O, OWNER } from '../src/peer.mjs';
import { ghCliToken } from '../src/outbox.mjs';
import { peerWatch } from '../src/peer-watch.mjs';

const BIN = fileURLToPath(new URL('../bin/housesitter.mjs', import.meta.url));
const scratchRoot = path.join(fileURLToPath(new URL('..', import.meta.url)), '.scratch');
fs.mkdirSync(scratchRoot, { recursive: true });

async function fakeGists(gists) {
  const requests = [];
  const truncate = new Set();
  const fail = []; // GitHub's answers to the next writes, like { status: 403, headers: { 'Retry-After': '120' }, message }
  const etag = (id) => `"${crypto.createHash('sha1').update(JSON.stringify(gists[id])).digest('hex')}"`;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => { data += d; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, etag: req.headers['if-none-match'], ua: req.headers['user-agent'], body });
      const [kind, id, file] = req.url.split('/').filter(Boolean);
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(obj === undefined ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (kind === 'raw') return send(200, gists[id][file]);
      if (kind !== 'gists' || !gists[id]) return send(404, { message: 'Not Found' });
      if (req.method === 'PATCH' && fail.length) { const f = fail.shift(); return send(f.status, { message: f.message }, f.headers || {}); }
      if (req.method === 'PATCH') {
        for (const [n, f] of Object.entries(body.files)) { if (f === null) delete gists[id][n]; else gists[id][n] = f.content; }
        return send(200, { id }, { ETag: etag(id) });
      }
      if (req.headers['if-none-match'] === etag(id)) return send(304, undefined, { ETag: etag(id) });
      const files = Object.fromEntries(Object.entries(gists[id]).map(([n, c]) => [n, truncate.has(n)
        ? { filename: n, content: c.slice(0, 10), truncated: true, raw_url: `http://127.0.0.1:${server.address().port}/raw/${id}/${n}` }
        : { filename: n, content: c, truncated: false }]));
      send(200, { id, files }, { ETag: etag(id) });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, truncate, fail, close: () => new Promise((r) => server.close(r)) };
}

const setup = async (extraEnv = {}) => {
  const gists = { [O_TO_H]: {}, [H_TO_O]: {} };
  const gh = await fakeGists(gists);
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'peer-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ macs: { studio: {} } }));
  const env = { HOUSESITTER_GITHUB_API: gh.url, GH_TOKEN: 'test-token', ...extraEnv };
  const time = { now: Date.parse('2026-11-09T12:00:00Z') };
  const make = () => peer({ dir, env, from: 'ouroboros@mini', clock: () => time.now });
  const patches = () => gh.requests.filter((q) => q.method === 'PATCH');
  const queue = () => { try { return fs.readFileSync(path.join(dir, 'peer-outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const log = () => fs.readFileSync(path.join(dir, 'peer-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { gists, gh, dir, env, time, make, patches, queue, log, p: make() };
};

test('peer send: the first goes at once, one immutable file in the Ouroboros-to-Housesitter gist; files over a day old go in the same PATCH', async () => {
  const { gists, gh, p, time, patches, queue, log } = await setup();
  const now = time.now;
  const old = `${stamp(now - 25 * 3600e3)}-0000000a.json`;
  const recent = `${stamp(now - 23 * 3600e3)}-0000000b.json`;
  gists[O_TO_H] = { [old]: '{}', [recent]: '{}', 'README.md': '# peer' };
  const r = await p.send('is the KVM awake?', { re: 'abc' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'sent');
  assert.deepEqual(r.pruned, [old]);
  assert.match(r.file, /^20261109T120000Z-[0-9a-f]{8}\.json$/);
  assert.equal(fileTime(r.file), now);
  const msg = JSON.parse(gists[O_TO_H][r.file]);
  assert.deepEqual(msg, { v: 1, id: r.id, at: '2026-11-09T12:00:00Z', from: 'ouroboros@mini', to: 'housesitter', text: 'is the KVM awake?', re: 'abc' });
  assert.deepEqual(Object.keys(gists[O_TO_H]).sort(), ['README.md', r.file, recent].sort());
  assert.equal(patches().length, 1);
  assert.equal(patches()[0].body.files[old], null);
  assert.ok(gh.requests.every((q) => q.auth === 'Bearer test-token' && q.ua));
  assert.deepEqual(log().map((e) => [e.dir, e.msg?.id]), [['sent', r.id], ['flush', undefined]]);
  assert.deepEqual(queue(), []);
  await assert.rejects(p.send(''), /needs some text/);
  await gh.close();
});

test('peer: a burst of 30 sends goes out at once, each when it is sent: no cap and no batching of our own', async () => {
  const { gists, gh, p, time, patches, queue } = await setup();
  const t0 = time.now;
  const sent = [];
  for (let i = 0; i < 30; i++) { time.now = t0 + i * 100; sent.push(await p.send(`news ${i}`)); }
  assert.deepEqual([...new Set(sent.map((r) => r.status))], ['sent']);
  assert.equal(patches().length, 30);
  for (const r of sent) assert.equal(JSON.parse(gists[O_TO_H][r.file]).id, r.id);
  assert.deepEqual(queue(), []);
  assert.deepEqual(await p.flush(), { ok: true, sent: [], queued: 0 });
  await gh.close();
});

test('peer: GitHub\'s rate limit (403 with Retry-After) keeps messages queued, logs the wait, and they go then', async () => {
  const { gh, p, time, patches, queue, log } = await setup();
  const t0 = time.now;
  gh.fail.push({ status: 403, headers: { 'Retry-After': '120' }, message: 'You have exceeded a secondary rate limit' });
  const r = await p.send('signed in');
  assert.deepEqual([r.status, r.rate_limited, r.retry_at, r.queued], ['queued', true, '2026-11-09T12:02:00Z', 1]);
  time.now = t0 + 30e3;
  const q = await p.send('and enrolled');
  assert.deepEqual([q.status, q.retry_at], ['queued', '2026-11-09T12:02:00Z']);
  assert.equal(patches().length, 1, 'nothing written while GitHub asked us to wait');
  assert.deepEqual(log().filter((e) => e.event === 'peer-wait').map((e) => [e.retry_at, e.queued, e.status]), [['2026-11-09T12:02:00Z', 1, 403]]);
  time.now = t0 + 121e3;
  const done = await p.flush();
  assert.deepEqual(done.sent, [r.id, q.id]);
  assert.equal(patches().length, 2);
  assert.deepEqual(queue(), []);
  // A 429 with only x-ratelimit-reset waits until that reset; a 403 that isn't a rate limit is an error, still queued.
  gh.fail.push({ status: 429, headers: { 'X-RateLimit-Reset': String(Math.floor((t0 + 600e3) / 1000)), 'X-RateLimit-Remaining': '0' }, message: 'API rate limit exceeded' });
  assert.equal((await p.send('three')).retry_at, '2026-11-09T12:10:00Z');
  time.now = t0 + 601e3;
  // GitHub sends x-ratelimit-reset on every answer: with some remaining, a 403 is a real refusal, not a wait.
  gh.fail.push({ status: 403, headers: { 'X-RateLimit-Reset': String(Math.floor((t0 + 3000e3) / 1000)), 'X-RateLimit-Remaining': '4000' }, message: 'Resource not accessible by personal access token' });
  const denied = await p.send('four');
  assert.equal(denied.status, 'queued');
  assert.match(denied.error, /HTTP 403/);
  assert.equal(denied.rate_limited, undefined);
  assert.deepEqual((await p.flush()).sent.length, 2);
  await gh.close();
});

test('peer: a failed write keeps the message queued; a fresh process (a restart) sends it', async () => {
  const { gists, gh, dir, env, time, make, queue } = await setup();
  const broken = peer({ dir, env: { ...env, HOUSESITTER_PEER_OUT: 'missing' }, from: 'ouroboros@mini', clock: () => time.now });
  const r = await broken.send('hello?');
  assert.equal(r.status, 'queued');
  assert.match(r.error, /HTTP 404/);
  assert.equal(queue().length, 1);
  time.now += 30e3;
  const again = make();
  assert.deepEqual((await again.flush()).sent, [r.id]);
  assert.equal(JSON.parse(gists[O_TO_H][r.file]).text, 'hello?');
  await gh.close();
});

test('peer inbox flushes what is still queued; a peek does not', async () => {
  const { gists, gh, p, time, patches } = await setup();
  gh.fail.push({ status: 429, headers: { 'Retry-After': '60' }, message: 'rate limit' });
  const q = await p.send('two');
  time.now += 61e3;
  await p.inbox({ mark: false });
  assert.equal(patches().length, 1);
  const got = await p.inbox();
  assert.deepEqual(got.outbox.sent, [q.id]);
  assert.ok(gists[O_TO_H][q.file]);
  assert.equal(patches().length, 2);
  await gh.close();
});

test('peer inbox: Housesitter\'s messages oldest first, each once; 304 is nothing new; truncated files come whole', async () => {
  const { gists, gh, dir, p } = await setup();
  gists[H_TO_O]['20261109T100500Z-00000002.json'] = JSON.stringify({ v: 1, id: 'm2', at: '2026-11-09T10:05:00Z', from: 'housesitter@comet', text: 'second' });
  gists[H_TO_O]['20261109T100000Z-00000001.json'] = JSON.stringify({ v: 1, id: 'm1', at: '2026-11-09T10:00:00Z', from: 'housesitter@comet', text: 'first' });
  gists[H_TO_O]['20261109T100100Z-00000003.json'] = 'not json';
  const r = await p.inbox();
  assert.deepEqual(r.messages.map((m) => m.text), ['first', 'second']);
  assert.deepEqual(await p.inbox(), { ok: true, messages: [], unchanged: true });
  assert.ok(gh.requests.at(-1).etag);
  const big = 'y'.repeat(4000);
  gists[H_TO_O]['20261109T101000Z-00000004.json'] = JSON.stringify({ v: 1, id: 'm4', at: '2026-11-09T10:10:00Z', text: big });
  gh.truncate.add('20261109T101000Z-00000004.json');
  const peek = await p.inbox({ mark: false });
  assert.deepEqual(peek.messages.map((m) => m.id), ['m4']);
  const r3 = await p.inbox();
  assert.equal(r3.messages[0].text, big);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'peer-seen.json'), 'utf8')), ['m1', 'm2', 'm4']);
  await gh.close();
});

const cli = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
});

test('housesitter peer send, flush and inbox from the shell; the queue outlives each process', async () => {
  const { gists, gh, dir, env } = await setup();
  const e = { ...env, HOUSESITTER_CONFIG: path.join(dir, 'config.json'), COPILOT_SESSION_ID: '', COPILOT_AGENT_SESSION_ID: '', COPILOT_CLI: '' };
  const s = await cli(['peer', 'send', 'which', 'sessions', 'resumed?', '--re', 'h1', '--json', '--why', 'the person asked'], e);
  assert.equal(s.status, 0, s.stderr);
  const sent = JSON.parse(s.stdout);
  assert.equal(sent.status, 'sent');
  const msg = JSON.parse(gists[O_TO_H][sent.file]);
  assert.equal(msg.text, 'which sessions resumed?');
  assert.equal(msg.re, 'h1');
  assert.match(msg.from, /^ouroboros@/);
  gh.fail.push({ status: 403, headers: { 'Retry-After': '3600' }, message: 'You have exceeded a secondary rate limit' });
  const q = await cli(['peer', 'send', 'and', 'the', 'browser?', '--why', 'the person asked'], e);
  assert.match(q.stdout, /^queued [0-9a-f]{8} for housesitter: GitHub asked us to wait; it goes out after \d{4}-/);
  assert.equal(Object.keys(gists[O_TO_H]).length, 1);
  assert.match((await cli(['peer', 'flush', 'studio', '--why', 'the person asked'], e)).stdout, /^1 queued: GitHub asked us to wait; they go out after /);
  fs.writeFileSync(path.join(dir, 'peer-flush.json'), '{}'); // the wait is over
  const q2 = JSON.parse((await cli(['peer', 'send', 'later', '--json', '--why', 'the person asked'], e)).stdout);
  assert.equal(q2.status, 'sent');
  gists[H_TO_O]['20261109T100000Z-0000000c.json'] = JSON.stringify({ v: 1, id: 'c1', at: '2026-11-09T10:00:00Z', from: 'housesitter@comet', text: 'unlocked; desktop is back' });
  const i = await cli(['peer', 'inbox'], e);
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /housesitter@comet {2}c1\nunlocked; desktop is back/);
  assert.equal(Object.keys(gists[O_TO_H]).length, 3);
  assert.ok(gists[O_TO_H][q2.file]);
  const u = await cli(['peer', 'send', 'about', 'to', 'restart', '--now', '--why', 'the person asked'], e);
  assert.match(u.stdout, /^sent [0-9a-f]{8} to housesitter/);
  assert.equal((await cli(['peer', 'flush', 'studio', '--now', '--why', 'the person asked'], e)).stdout.trim(), 'nothing queued');
  assert.equal((await cli(['peer', 'inbox'], e)).stdout.trim(), 'nothing new');
  assert.ok(fs.existsSync(path.join(dir, 'peer-seen.json')));
  assert.equal((await cli(['peer', 'send'], e)).status, 2);
  assert.equal((await cli(['peer', 'shout'], e)).status, 2);
  const help = (await cli(['help', 'peer', 'send'], e)).stdout;
  assert.match(help, /housesitter peer send <text>/);
  assert.match((await cli(['help', 'peer', 'flush'], e)).stdout, /housesitter peer flush/);
  await gh.close();
});

const hmsg = (id, at, text) => [`${stamp(Date.parse(at))}-${id.padStart(8, '0')}.json`, JSON.stringify({ v: 1, id, at, from: 'housesitter@comet', text })];
const fakeExec = (codes = []) => { const calls = []; return { calls, exec: async (file, argv) => { calls.push([file, ...argv]); const code = codes.shift() ?? 0; return { code, stdout: '', stderr: code ? 'daemon down' : '' }; } }; };
const watchLog = (dir) => fs.readFileSync(path.join(dir, 'peer-watch.log'), 'utf8').trim().split('\n');

test('peer watch wakes the agent once per new message, marks nothing read and never writes', async () => {
  const { gists, gh, dir, time, p, patches } = await setup();
  const x = fakeExec();
  const w = peerWatch({ p, dir, restartDir: path.join(scratchRoot, 'no-restart'), agent: 'ouroboros', ouro: '/bin/ouro', bin: '/h/bin/housesitter.mjs', exec: x.exec, clock: () => time.now, probe: async () => true });
  await w.tick();
  assert.equal(x.calls.length, 0);
  const [f1, c1] = hmsg('a1', '2026-11-09T11:59:00Z', 'the Mac is at the login window');
  gists[H_TO_O][f1] = c1;
  await w.tick();
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.calls[0].slice(0, 4), ['/bin/ouro', 'msg', '--to', 'ouroboros']);
  assert.match(x.calls[0][6], /^1 new message from Housesitter on the peer link \(latest: the Mac is at the login window\)\. Read it with: node \/h\/bin\/housesitter\.mjs peer inbox — then answer with peer send/);
  assert.equal(x.calls[0][4], '--why');
  assert.match(x.calls[0][5], /relays what Housesitter/, 'the reason says why the wake comes');
  await w.tick();
  assert.equal(gh.requests.at(-1).etag !== undefined, true);
  assert.equal(x.calls.length, 1);
  const [f2, c2] = hmsg('a2', '2026-11-09T12:00:30Z', `tell-ari: ${'z'.repeat(400)}`);
  gists[H_TO_O][f2] = c2;
  await w.tick();
  assert.equal(x.calls.length, 2);
  assert.match(x.calls[1][6], /^1 new message .*latest: tell-ari: z+…\)/);
  assert.ok(x.calls[1][6].length < 500);
  assert.equal(fs.existsSync(path.join(dir, 'peer-seen.json')), false);
  assert.deepEqual((await p.inbox()).messages.map((m) => m.id), ['a1', 'a2']);
  await w.tick();
  assert.equal(x.calls.length, 2);
  assert.equal(patches().length, 0);
  assert.match(watchLog(dir).join('\n'), /woke ouroboros for a1\n.*tick: unchanged\n.*woke ouroboros for a2/);
  await gh.close();
});

test('peer watch: a failed ouro msg backs off and retries; a rate-limited read waits for the reset', async () => {
  const { gists, gh, dir, env, time } = await setup();
  let limited = 0;
  const fetchFn = async (url, o) => (limited-- > 0
    ? new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-reset': String(time.now / 1000 + 600) } })
    : fetch(url, o));
  const p = peer({ dir, env, fetchFn, clock: () => time.now });
  const x = fakeExec([1]);
  const w = peerWatch({ p, dir, restartDir: path.join(scratchRoot, 'no-restart'), ouro: '/bin/ouro', bin: 'hs', every: 30, exec: x.exec, clock: () => time.now, probe: async () => true });
  const [f1, c1] = hmsg('b1', '2026-11-09T11:59:00Z', 'hello');
  gists[H_TO_O][f1] = c1;
  await w.tick();
  assert.equal(x.calls.length, 1);
  assert.match(watchLog(dir).at(-1), /wake failed: ouro msg exited 1: daemon down; retry in 60 s/);
  time.now += 30e3;
  await w.tick();
  assert.equal(x.calls.length, 1);
  time.now += 31e3;
  await w.tick();
  assert.equal(x.calls.length, 2);
  assert.match(watchLog(dir).at(-1), /woke ouroboros for b1/);
  const [f2, c2] = hmsg('b2', '2026-11-09T12:02:00Z', 'again');
  gists[H_TO_O][f2] = c2;
  limited = 1;
  await w.tick();
  assert.match(watchLog(dir).at(-1), /read rate-limited \(HTTP 403\); next read after 2026-11-09T12:11:01Z/);
  const gets = gh.requests.length;
  time.now += 300e3;
  await w.tick();
  assert.equal(gh.requests.length, gets);
  time.now += 301e3;
  await w.tick();
  assert.equal(x.calls.length, 3);
  assert.match(x.calls[2][6], /latest: again/);
  const nowhere = peerWatch({ p, restartDir: path.join(scratchRoot, 'no-restart'), dir: fs.mkdtempSync(path.join(scratchRoot, 'peer-')), ouro: null, bin: 'hs', exec: x.exec, clock: () => time.now, probe: async () => true });
  await nowhere.tick();
  assert.equal(x.calls.length, 3);
  await gh.close();
});

test('peer watch sends what GitHub\'s rate limit kept queued, once the wait is over', async () => {
  const { gh, dir, time, p, patches, queue } = await setup();
  gh.fail.push({ status: 429, headers: { 'Retry-After': '120' }, message: 'rate limit' });
  await p.send('first');
  const w = peerWatch({ p, dir, restartDir: path.join(scratchRoot, 'no-restart'), ouro: '/bin/ouro', bin: 'hs', exec: fakeExec().exec, clock: () => time.now, probe: async () => true });
  await w.tick();
  assert.equal(patches().length, 1);
  assert.equal(queue().length, 1);
  assert.match(watchLog(dir).at(-1), /GitHub asked us to wait: 1 queued until /);
  time.now += 121e3;
  await w.tick();
  assert.equal(patches().length, 2);
  assert.deepEqual(queue(), []);
  assert.match(watchLog(dir).at(-1), /flushed 1 queued message: /);
  await gh.close();
});

test('peer send signs as who sent it: --as, a Copilot session, else Ouroboros', async () => {
  const { gists, gh, dir, env } = await setup();
  const e = { ...env, HOUSESITTER_CONFIG: path.join(dir, 'config.json'), COPILOT_SESSION_ID: '', COPILOT_AGENT_SESSION_ID: '', COPILOT_CLI: '' };
  const as = JSON.parse((await cli(['peer', 'send', 'hi', '--as', 'Ari Mini!', '--json', '--now', '--why', 'the person asked'], e)).stdout);
  assert.match(JSON.parse(gists[O_TO_H][as.file]).from, /^ari-mini@/);
  const cp = JSON.parse((await cli(['peer', 'send', 'hi', '--json', '--now', '--why', 'the person asked'], { ...e, COPILOT_SESSION_ID: '0e4b7d7c-aaaa' })).stdout);
  assert.match(JSON.parse(gists[O_TO_H][cp.file]).from, /^copilot-0e4b7d7c@/);
  await gh.close();
});

test('housesitter peer send signs when a key exists, and refuses an unknown --op', async () => {
  const { gists, gh, dir, env } = await setup();
  const { ensureKey, signMac } = await import('../src/peer-sign.mjs');
  const e = { ...env, HOUSESITTER_CONFIG: path.join(dir, 'config.json') };
  const nokey = await cli(['peer', 'send', 'x', '--op', 'root-key', '--why', 'the person asked'], e);
  assert.notEqual(nokey.status, 0, '--op without a key is refused');
  const k = ensureKey(dir, 'mac-mini');
  const r = JSON.parse((await cli(['peer', 'send', 'install this key', '--op', 'root-key', '--json', '--now', '--why', 'the person asked'], e)).stdout);
  const m = JSON.parse(gists[O_TO_H][r.file]);
  assert.equal(m.op, 'root-key');
  assert.deepEqual(m.sig, { kid: 'mac-mini', mac: signMac(k.key, m) });
  const bad = await cli(['peer', 'send', 'x', '--op', 'format-disk', '--why', 'the person asked'], e);
  assert.notEqual(bad.status, 0);
  await gh.close();
});

test('housesitter peer watch --once from the shell', async () => {
  const { gists, gh, dir, env } = await setup();
  const calls = path.join(dir, 'ouro-calls.txt');
  const ouro = path.join(dir, 'ouro');
  fs.writeFileSync(ouro, `#!/bin/sh\nprintf '%s|' "$@" >> '${calls}'\necho >> '${calls}'\n`, { mode: 0o755 });
  const [f1, c1] = hmsg('c9', '2026-11-09T11:59:00Z', 'up again');
  gists[H_TO_O][f1] = c1;
  const r = await cli(['peer', 'watch', 'studio', '--once', '--agent', 'ouroboros', '--ouro', ouro, '--why', 'the person asked'], { ...env, HOUSESITTER_CONFIG: path.join(dir, 'config.json') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /woke ouroboros for c9/);
  assert.match(fs.readFileSync(calls, 'utf8'), /^msg\|--to\|ouroboros\|--why\|Housesitter's peer watch on this Mac relays what Housesitter.*\|1 new message from Housesitter .*bin\/housesitter\.mjs peer inbox/);
  await gh.close();
});

test('peer: without GH_TOKEN it reads with gh\'s token for the gists\' owner, not gh\'s active account', async () => {
  const { gh, dir, env } = await setup();
  delete env.GH_TOKEN;
  const calls = [];
  const ghToken = (_run, o) => { calls.push(o.user); return `tok-${o.user}`; };
  const r = await peer({ dir, env, ghToken }).inbox({ mark: false });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [OWNER]);
  assert.equal(gh.requests.at(-1).auth, `Bearer tok-${OWNER}`);
  await peer({ dir, env, ghToken, user: 'someone' }).inbox({ mark: false });
  assert.equal(calls.at(-1), 'someone');
  await gh.close();
});

test('ghCliToken: asks gh for the named login, and falls back to gh\'s active account when gh has no such login', () => {
  const seen = [];
  const run = (cmd, args) => { seen.push(args.join(' ')); return args.includes('--user') ? (args.includes('arimendelow') ? { status: 0, stdout: 'owner\n' } : { status: 1, stdout: '' }) : { status: 0, stdout: 'active\n' }; };
  assert.equal(ghCliToken(run, { user: 'arimendelow' }), 'owner');
  assert.equal(ghCliToken(run, { user: 'nobody' }), 'active');
  assert.equal(ghCliToken(run), 'active');
  assert.deepEqual(seen, ['auth token --hostname github.com --user arimendelow', 'auth token --hostname github.com --user nobody', 'auth token', 'auth token']);
});

test('peer watch tells Housesitter after two ticks without the daemon, and once when it answers again', async () => {
  const { gists, gh, dir, time, p } = await setup();
  let alive = true;
  const w = peerWatch({ p, dir, restartDir: path.join(scratchRoot, 'no-restart'), ouro: '/bin/ouro', bin: 'hs', exec: fakeExec().exec, clock: () => time.now, probe: async () => alive, host: 'mini' });
  const sent = () => Object.values(gists[O_TO_H]).map((c) => JSON.parse(c).text);
  await w.tick();
  alive = false;
  await w.tick();
  assert.equal(sent().length, 0, 'one missed tick is not news');
  time.now += 30e3;
  await w.tick();
  time.now += 30e3;
  await w.tick();
  assert.equal(sent().length, 1);
  assert.match(sent()[0], /^peer-watch on mini: ouroboros's Ouro daemon on this Mac isn't answering on \/tmp\/ouroboros-daemon\.sock \(since .*\)\. If you want it back, peer_bring_back_ouroboros/);
  alive = true;
  time.now += 30e3;
  await w.tick();
  assert.equal(sent().length, 2);
  assert.match(sent()[1], /^peer-watch on mini: ouroboros's daemon answers again \(down since /);
  await gh.close();
});

test('peer watch runs `ouro up` once for a do: ouro-up message, reports back, then wakes the agent', async () => {
  const { gists, gh, dir, time, p } = await setup();
  let alive = false;
  const calls = [];
  const exec = async (file, argv, opts) => { calls.push([file, ...argv, opts?.timeoutMs]); if (argv[0] === 'up') alive = true; return { code: 0, stdout: '', stderr: '' }; };
  const w = peerWatch({ p, dir, restartDir: path.join(scratchRoot, 'no-restart'), ouro: '/bin/ouro', bin: 'hs', exec, clock: () => time.now, probe: async () => alive, host: 'mini' });
  const name = `${stamp(Date.parse('2026-11-09T11:59:00Z'))}-000000c1.json`;
  gists[H_TO_O][name] = JSON.stringify({ v: 1, id: 'c1', at: '2026-11-09T11:59:00Z', from: 'housesitter@comet', text: 'your daemon went quiet; bringing it back', do: 'ouro-up' });
  await w.tick();
  assert.deepEqual(calls[0], ['/bin/ouro', 'up', 300000]);
  assert.deepEqual(calls[1].slice(0, 4), ['/bin/ouro', 'msg', '--to', 'ouroboros']);
  const back = Object.values(gists[O_TO_H]).map((c) => JSON.parse(c));
  assert.equal(back.length, 1);
  assert.equal(back[0].re, 'c1');
  assert.match(back[0].text, /^peer-watch on mini: ran `ouro up` for your c1 at .*: exit 0; ouroboros's daemon is answering again\.$/);
  time.now += 30e3;
  await w.tick();
  assert.equal(calls.filter((c) => c[1] === 'up').length, 1, 'once per request');
  await gh.close();
});

test('a planned drill: `peer drill` labels everything sent until it ends, and the watch says so when it wakes the agent', async () => {
  const { gists, gh, dir, env, time, p } = await setup();
  const e = { ...env, HOUSESITTER_CONFIG: path.join(dir, 'config.json') };
  const d = await cli(['peer', 'drill', 'battle', 'test', 'row', '9', '--minutes', '30', '--json', '--why', 'the person asked'], e);
  assert.equal(d.status, 0, d.stderr);
  const drill = JSON.parse(fs.readFileSync(path.join(dir, 'drill.json'), 'utf8'));
  assert.equal(drill.label, 'battle test row 9');
  time.now = Date.parse(drill.from) + 60e3;
  await p.send('your daemon is down', { now: true });
  const sent = () => Object.values(gists[O_TO_H]).map((c) => JSON.parse(c).text);
  assert.deepEqual(sent(), ['[planned drill: battle test row 9] your daemon is down']);
  await p.send('[planned drill: battle test row 9] already labelled', { now: true });
  assert.equal(sent()[1], '[planned drill: battle test row 9] already labelled');

  const x = fakeExec();
  const w = peerWatch({ p, dir, restartDir: path.join(scratchRoot, 'no-restart'), ouro: '/bin/ouro', bin: 'hs', exec: x.exec, clock: () => time.now, probe: async () => true });
  const [f1, c1] = hmsg('d1', '2026-11-10T12:51:50Z', 'please run ouro up');
  gists[H_TO_O][f1] = c1;
  await w.tick();
  assert.match(x.calls.at(-1)[6], /This is a planned drill \(battle test row 9\): handle it for real, but say "planned drill \(battle test row 9\)" in anything you report, and don't relay it to Ari as an incident\.$/);

  assert.equal((await cli(['peer', 'drill', '--end', '--why', 'the person asked'], e)).status, 0);
  time.now = Date.now() + 1000;
  await p.send('all clear', { now: true });
  assert.equal(sent().at(-1), 'all clear');
  const [f2, c2] = hmsg('d2', '2026-11-10T13:10:00Z', '[planned drill: row 9] a message labelled on the Comet');
  gists[H_TO_O][f2] = c2;
  await w.tick();
  assert.match(x.calls.at(-1)[6], /This is a planned drill \(row 9\)/, 'a label from the other side carries into the wake');
  const [f3, c3] = hmsg('d3', '2026-11-10T13:11:00Z', 'a real one');
  delete gists[H_TO_O][f2];
  gists[H_TO_O][f3] = c3;
  await w.tick();
  assert.doesNotMatch(x.calls.at(-1)[6], /planned drill/);
  await gh.close();
});

test('peer watch tells Housesitter and the agent, once, when a Copilot app restart fails or its job stops updating', async () => {
  const { gists, gh, dir, time, p } = await setup();
  const restartDir = fs.mkdtempSync(path.join(scratchRoot, 'restart-'));
  const x = fakeExec();
  const w = peerWatch({ p, dir, ouro: '/bin/ouro', bin: 'hs', exec: x.exec, clock: () => time.now, probe: async () => true, restartDir });
  const status = (o) => fs.writeFileSync(path.join(restartDir, 'status.json'), JSON.stringify(o));
  const sent = () => Object.values(gists[O_TO_H]).map((c) => JSON.parse(c).text).filter((t) => /Copilot app restart/.test(t));
  status({ started: '2026-11-09T12:00:00Z', updated: new Date(time.now).toISOString(), state: 'running', step: 'quit sent' });
  await w.tick();
  assert.equal(sent().length, 0, 'a running restart is left alone');
  time.now += 21 * 60000;
  await w.tick();
  assert.equal(sent().length, 1);
  assert.match(sent()[0], /stopped updating at step "quit sent" \(the job may have died\)/);
  assert.match(x.calls.at(-1)[6], /restart-copilot --status; then check each session with app_sessions_list/);
  assert.equal(x.calls.at(-1)[4], '--why');
  assert.match(x.calls.at(-1)[5], /restart problem/);
  await w.tick();
  assert.equal(sent().length, 1, 'told once');
  status({ started: '2026-11-09T13:00:00Z', updated: new Date(time.now).toISOString(), state: 'failed', failed: { stage: 'quit', why: 'someone is using this Mac' }, not_resumed: ['abc'] });
  await w.tick();
  assert.equal(sent().length, 2);
  assert.match(sent()[1], /failed at quit: someone is using this Mac\. Sessions not resumed: abc\./);
  await gh.close();
});

test('housesitter peer flush names the Mac itself when the config has exactly one', async () => {
  const { gh, dir, env } = await setup();
  const e = { ...env, HOUSESITTER_CONFIG: path.join(dir, 'config.json') };
  const one = await cli(['peer', 'flush', '--why', 'the person asked'], e);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout.trim(), 'nothing queued');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ macs: { studio: {}, laptop: {} } }));
  const two = await cli(['peer', 'flush', '--why', 'the person asked'], e);
  assert.notEqual(two.status, 0);
  assert.match(two.stdout + two.stderr, /peer flush: needs <mac>/);
  const wrong = await cli(['peer', 'flush', 'bogus', '--why', 'the person asked'], e);
  assert.match(wrong.stdout + wrong.stderr, /no Mac called "bogus".*name one of the Macs in the config: studio, laptop/);
  await gh.close();
});
