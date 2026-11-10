// The peer link's Mac end (src/peer.mjs and `housesitter peer`), against a local stand-in for GitHub's gist API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peer, stamp, fileTime, O_TO_H, H_TO_O } from '../src/peer.mjs';

const BIN = fileURLToPath(new URL('../bin/housesitter.mjs', import.meta.url));
const scratchRoot = path.join(fileURLToPath(new URL('..', import.meta.url)), '.scratch');
fs.mkdirSync(scratchRoot, { recursive: true });

async function fakeGists(gists) {
  const requests = [];
  const truncate = new Set();
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
  return { url: `http://127.0.0.1:${server.address().port}`, requests, truncate, close: () => new Promise((r) => server.close(r)) };
}

const setup = async (extraEnv = {}) => {
  const gists = { [O_TO_H]: {}, [H_TO_O]: {} };
  const gh = await fakeGists(gists);
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'peer-'));
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

test('peer send inside six minutes queues without a write; the next flush sends them all and the deletions in one PATCH', async () => {
  const { gists, gh, p, time, patches, queue } = await setup();
  const t0 = time.now;
  await p.send('first');
  const old = `${stamp(t0 - 25 * 3600e3)}-0000000a.json`;
  gists[O_TO_H][old] = '{}';
  const later = [];
  for (let i = 0; i < 3; i++) { time.now = t0 + 10e3 * (i + 1); later.push(await p.send(`later ${i}`)); }
  assert.deepEqual(later.map((r) => r.status), ['queued', 'queued', 'queued']);
  assert.equal(later[2].queued, 3);
  assert.equal(later[2].next_flush_at, '2026-11-09T12:06:00Z');
  assert.equal(patches().length, 1);
  assert.deepEqual(queue().map((e) => e.msg.id), later.map((r) => r.id));
  time.now = t0 + 359e3;
  assert.deepEqual((await p.flush()).sent, []);
  time.now = t0 + 361e3;
  const r = await p.flush();
  assert.deepEqual(r.sent, later.map((x) => x.id));
  assert.deepEqual(r.pruned, [old]);
  assert.equal(patches().length, 2);
  assert.deepEqual(Object.keys(patches()[1].body.files).sort(), [old, ...later.map((x) => x.file)].sort());
  assert.equal(patches()[1].body.files[old], null);
  for (const x of later) assert.equal(JSON.parse(gists[O_TO_H][x.file]).at, x.at);
  assert.deepEqual(queue(), []);
  time.now = t0 + 3600e3;
  assert.deepEqual(await p.flush(), { ok: true, sent: [], queued: 0 });
  assert.equal(patches().length, 2);
  await gh.close();
});

test('peer send --now goes at once inside the window and takes the queue with it', async () => {
  const { gh, p, time, patches, queue } = await setup();
  await p.send('one');
  time.now += 20e3;
  const q = await p.send('two');
  time.now += 10e3;
  const u = await p.send('about to restart', { now: true });
  assert.deepEqual([q.status, u.status], ['queued', 'sent']);
  assert.equal(patches().length, 2);
  assert.deepEqual(Object.keys(patches()[1].body.files).sort(), [q.file, u.file].sort());
  assert.deepEqual(queue(), []);
  await gh.close();
});

test('peer: the hourly cap keeps messages queued, logs a peer-cap line at most once a minute, and they go when it frees', async () => {
  const { gh, dir, p, time, patches, queue, log } = await setup();
  const t0 = time.now;
  for (let i = 0; i < 10; i++) { time.now = t0 + i * 1e3; assert.equal((await p.send(`urgent ${i}`, { now: true })).status, 'sent'); }
  time.now = t0 + 20e3;
  const r = await p.send('eleventh', { now: true });
  assert.deepEqual([r.status, r.capped, r.queued, r.next_allowed_at], ['queued', true, 1, '2026-11-09T13:00:00Z']);
  time.now = t0 + 30e3;
  await p.send('twelfth', { now: true });
  time.now = t0 + 40e3;
  assert.equal((await p.flush({ now: true })).capped, true);
  assert.equal(patches().length, 10);
  const caps = () => log().filter((e) => e.event === 'peer-cap');
  assert.deepEqual(caps().map(({ at, event, queued, next_allowed_at }) => ({ at, event, queued, next_allowed_at })),
    [{ at: '2026-11-09T12:00:20Z', event: 'peer-cap', queued: 1, next_allowed_at: '2026-11-09T13:00:00Z' }]);
  time.now = t0 + 95e3;
  await p.send('thirteenth', { now: true });
  assert.deepEqual(caps().map((e) => [e.queued, e.at]), [[1, '2026-11-09T12:00:20Z'], [3, '2026-11-09T12:01:35Z']]);
  assert.equal(queue().length, 3);
  time.now = t0 + 3599e3;
  assert.equal((await p.flush()).capped, true);
  time.now = t0 + 3601e3;
  const done = await p.flush();
  assert.equal(done.sent.length, 3);
  assert.equal(patches().length, 11);
  assert.deepEqual(queue(), []);
  assert.ok(fs.existsSync(path.join(dir, 'peer-flush.json')));
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
  assert.deepEqual((await again.flush()).sent, [r.id]); // never flushed yet, so it's due
  assert.equal(JSON.parse(gists[O_TO_H][r.file]).text, 'hello?');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'peer-flush.json'), 'utf8')).writes.length, 2);
  await gh.close();
});

test('peer inbox flushes what is due; a peek does not', async () => {
  const { gists, gh, p, time, patches } = await setup();
  await p.send('one');
  time.now += 60e3;
  const q = await p.send('two');
  time.now += 60e3;
  await p.inbox({ mark: false });
  assert.equal(patches().length, 1);
  time.now += 300e3;
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
  const e = { ...env, HOUSESITTER_CONFIG: path.join(dir, 'config.json') };
  const s = await cli(['peer', 'send', 'which', 'sessions', 'resumed?', '--re', 'h1', '--json'], e);
  assert.equal(s.status, 0, s.stderr);
  const sent = JSON.parse(s.stdout);
  assert.equal(sent.status, 'sent');
  const msg = JSON.parse(gists[O_TO_H][sent.file]);
  assert.equal(msg.text, 'which sessions resumed?');
  assert.equal(msg.re, 'h1');
  assert.match(msg.from, /^ouroboros@/);
  const q = await cli(['peer', 'send', 'and', 'the', 'browser?'], e);
  assert.match(q.stdout, /^queued [0-9a-f]{8} for housesitter: it goes out by \d{4}-/);
  assert.equal(Object.keys(gists[O_TO_H]).length, 1);
  assert.match((await cli(['peer', 'flush'], e)).stdout, /^1 queued: they go out by /);
  const q2 = JSON.parse((await cli(['peer', 'send', 'later', '--json'], e)).stdout);
  assert.equal(q2.status, 'queued');
  gists[H_TO_O]['20261109T100000Z-0000000c.json'] = JSON.stringify({ v: 1, id: 'c1', at: '2026-11-09T10:00:00Z', from: 'housesitter@comet', text: 'unlocked; desktop is back' });
  const i = await cli(['peer', 'inbox'], { ...e, HOUSESITTER_PEER_FLUSH_SEC: '0' }); // due: the inbox sends the queue
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /housesitter@comet {2}c1\nunlocked; desktop is back/);
  assert.equal(Object.keys(gists[O_TO_H]).length, 3);
  assert.ok(gists[O_TO_H][q2.file]);
  const u = await cli(['peer', 'send', 'about', 'to', 'restart', '--now'], e);
  assert.match(u.stdout, /^sent [0-9a-f]{8} to housesitter/);
  assert.equal((await cli(['peer', 'flush', '--now'], e)).stdout.trim(), 'nothing queued');
  assert.equal((await cli(['peer', 'inbox'], e)).stdout.trim(), 'nothing new');
  assert.ok(fs.existsSync(path.join(dir, 'peer-seen.json')));
  assert.equal((await cli(['peer', 'send'], e)).status, 2);
  assert.equal((await cli(['peer', 'shout'], e)).status, 2);
  const help = (await cli(['help'], e)).stdout;
  assert.match(help, /housesitter peer send <text>/);
  assert.match(help, /housesitter peer flush \[--now\]/);
  await gh.close();
});
