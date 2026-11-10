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

const setup = async () => {
  const gists = { [O_TO_H]: {}, [H_TO_O]: {} };
  const gh = await fakeGists(gists);
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'peer-'));
  const env = { HOUSESITTER_GITHUB_API: gh.url, GH_TOKEN: 'test-token' };
  return { gists, gh, dir, env, p: peer({ dir, env, from: 'ouroboros@mini' }) };
};

test('peer send: one immutable file in the Ouroboros-to-Housesitter gist; files over a day old go in the same PATCH', async () => {
  const { gists, gh, dir, p } = await setup();
  const now = Date.parse('2026-11-09T12:00:00Z');
  const old = `${stamp(now - 25 * 3600e3)}-0000000a.json`;
  const recent = `${stamp(now - 23 * 3600e3)}-0000000b.json`;
  gists[O_TO_H] = { [old]: '{}', [recent]: '{}', 'README.md': '# peer' };
  const r = await p.send('is the KVM awake?', { re: 'abc', now });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pruned, [old]);
  assert.match(r.file, /^20261109T120000Z-[0-9a-f]{8}\.json$/);
  assert.equal(fileTime(r.file), now);
  const msg = JSON.parse(gists[O_TO_H][r.file]);
  assert.deepEqual(msg, { v: 1, id: r.id, at: '2026-11-09T12:00:00Z', from: 'ouroboros@mini', to: 'housesitter', text: 'is the KVM awake?', re: 'abc' });
  assert.deepEqual(Object.keys(gists[O_TO_H]).sort(), ['README.md', r.file, recent].sort());
  const patches = gh.requests.filter((q) => q.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].body.files[old], null);
  assert.ok(gh.requests.every((q) => q.auth === 'Bearer test-token' && q.ua));
  const log = fs.readFileSync(path.join(dir, 'peer-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => [e.dir, e.msg.id]), [['sent', r.id]]);
  await assert.rejects(p.send(''), /needs some text/);
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

test('housesitter peer send and inbox from the shell', async () => {
  const { gists, gh, dir, env } = await setup();
  const e = { ...env, HOUSESITTER_CONFIG: path.join(dir, 'config.json') };
  const s = await cli(['peer', 'send', 'which', 'sessions', 'resumed?', '--re', 'h1', '--json'], e);
  assert.equal(s.status, 0, s.stderr);
  const sent = JSON.parse(s.stdout);
  const msg = JSON.parse(gists[O_TO_H][sent.file]);
  assert.equal(msg.text, 'which sessions resumed?');
  assert.equal(msg.re, 'h1');
  assert.match(msg.from, /^ouroboros@/);
  gists[H_TO_O]['20261109T100000Z-0000000c.json'] = JSON.stringify({ v: 1, id: 'c1', at: '2026-11-09T10:00:00Z', from: 'housesitter@comet', text: 'unlocked; desktop is back' });
  const i = await cli(['peer', 'inbox'], e);
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /housesitter@comet {2}c1\nunlocked; desktop is back/);
  assert.equal((await cli(['peer', 'inbox'], e)).stdout.trim(), 'nothing new');
  assert.ok(fs.existsSync(path.join(dir, 'peer-seen.json')));
  assert.equal((await cli(['peer', 'send'], e)).status, 2);
  assert.equal((await cli(['peer', 'shout'], e)).status, 2);
  assert.match((await cli(['help'], e)).stdout, /housesitter peer send <text>/);
  await gh.close();
});
