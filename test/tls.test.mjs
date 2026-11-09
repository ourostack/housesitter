// The pinned HTTPS client against a real TLS server: requests in parallel must each see the KVM's certificate.
// On a real GL-RM1PE (2026-11-08), pooled connections reported no certificate, and parallel requests failed the pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { closeAgents, fingerprint, httpsRequest, makeClient } from '../src/kvmd.mjs';

function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-tls-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=kvm', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  if (r.status !== 0) return null;
  return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
}

test('parallel pinned requests each see the certificate', async (t) => {
  const kc = selfSigned();
  if (!kc) return t.skip('no openssl here');
  const server = https.createServer(kc, (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { path: req.url } })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pin = fingerprint(new crypto.X509Certificate(kc.cert).raw);
  const base = `https://127.0.0.1:${server.address().port}`;
  try {
    const c = makeClient({ base, pin, password: 'x' });
    assert.equal((await c.info()).path, '/api/info'); // a first connection leaves a TLS session to resume
    const got = await Promise.all([c.hid(), c.streamer(), c.info(), c.hid()]);
    assert.deepEqual(got.map((g) => g.path), ['/api/hid', '/api/streamer', '/api/info', '/api/hid']);
    await assert.rejects(httpsRequest({ url: `${base}/api/info`, pin: 'AA:BB' }), /isn't the pinned one/);
  } finally {
    closeAgents();
    server.close();
  }
});

async function kvm(kc, { keepAliveTimeout = 5000 } = {}) {
  const seen = { tls: 0, requests: [], resumed: 0 };
  const server = https.createServer(kc, (req, res) => {
    seen.requests.push({ url: req.url, passwd: req.headers['x-kvmd-passwd'] || null, cookie: req.headers.cookie || null });
    if (req.socket.isSessionReused()) seen.resumed++;
    if (req.url === '/api/auth/login') res.setHeader('Set-Cookie', 'auth_token=tok; Path=/');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { path: req.url } }));
  });
  server.keepAliveTimeout = keepAliveTimeout;
  server.on('secureConnection', () => { seen.tls++; });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, base: `https://127.0.0.1:${server.address().port}`, pin: fingerprint(new crypto.X509Certificate(kc.cert).raw) };
}

test('pinned requests in a row share one kept-alive TLS connection', async (t) => {
  const kc = selfSigned();
  if (!kc) return t.skip('no openssl here');
  const { server, seen, base, pin } = await kvm(kc);
  try {
    for (let i = 0; i < 6; i++) assert.equal((await httpsRequest({ url: `${base}/api/hid?i=${i}`, pin })).status, 200);
    assert.equal(seen.tls, 1);
    assert.equal(seen.requests.length, 6);
  } finally { closeAgents(); server.close(); }
});

test('a wrong pin is refused before any request byte: the password header never reaches the server', async (t) => {
  const kc = selfSigned();
  if (!kc) return t.skip('no openssl here');
  const { server, seen, base } = await kvm(kc);
  try {
    await assert.rejects(httpsRequest({ url: `${base}/api/hid`, pin: 'AA:BB', headers: { 'X-KVMD-User': 'admin', 'X-KVMD-Passwd': 'secret' } }), /isn't the pinned one/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.requests.length, 0);
  } finally { closeAgents(); server.close(); }
});

test('after the KVM drops an idle connection, the next socket is a full handshake, pinned again', async (t) => {
  const kc = selfSigned();
  if (!kc) return t.skip('no openssl here');
  const { server, seen, base, pin } = await kvm(kc, { keepAliveTimeout: 40 });
  try {
    assert.equal((await httpsRequest({ url: `${base}/api/a`, pin })).status, 200);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await httpsRequest({ url: `${base}/api/b`, pin })).status, 200);
    assert.equal(seen.tls, 2);
    assert.equal(seen.resumed, 0, 'never a resumed TLS session: it would carry no certificate to pin');
  } finally { closeAgents(); server.close(); }
});

test('the real client logs in once and uses the cookie; the password goes only into the login body', async (t) => {
  const kc = selfSigned();
  if (!kc) return t.skip('no openssl here');
  const { server, seen, base, pin } = await kvm(kc);
  try {
    const c = makeClient({ base, pin, password: () => 'secret', warm: false });
    await c.hid(); await c.hid(); await c.info();
    assert.deepEqual(seen.requests.map((r) => r.url), ['/api/auth/login', '/api/hid', '/api/hid', '/api/info']);
    assert.ok(seen.requests.slice(1).every((r) => r.cookie === 'auth_token=tok' && r.passwd === null));
    assert.equal(seen.tls, 1);
  } finally { closeAgents(); server.close(); }
});

test('a cookie the KVM refuses falls back to the header once; injected request functions keep header auth', async () => {
  const calls = [];
  let cookieOk = true;
  const request = async (o) => {
    calls.push(o);
    if (o.url.endsWith('/api/auth/login')) return { status: 200, headers: { 'set-cookie': ['auth_token=t1; Path=/'] }, body: Buffer.from('{}') };
    if (o.headers.Cookie && !cookieOk) return { status: 401, headers: {}, body: Buffer.from('{}') };
    return { status: 200, headers: {}, body: Buffer.from('{"result":{}}') };
  };
  const c = makeClient({ base: 'https://k', pin: 'P', password: 'pw', request, preferCookie: true, warm: false });
  await c.hid();
  cookieOk = false;
  await c.hid();
  assert.equal(calls.at(-1).headers['X-KVMD-Passwd'], 'pw');
  const plain = [];
  await makeClient({ base: 'https://k2', pin: 'P', password: 'pw', request: async (o) => { plain.push(o.url); return { status: 200, headers: {}, body: Buffer.from('{"result":{}}') }; }, warm: false }).hid();
  assert.deepEqual(plain, ['https://k2/api/hid']);
});
