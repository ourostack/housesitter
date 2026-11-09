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
import { fingerprint, httpsRequest, makeClient } from '../src/kvmd.mjs';

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
    server.close();
  }
});
