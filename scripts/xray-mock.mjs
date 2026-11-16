// The X-ray's mock KVM: the fake KVM from src/fake.mjs, served over TLS on a loopback address, with a Mac called `mock`
// written into the X-ray's home. It reaches nothing outside this machine. Its identity answer carries a token written to
// the home, which scripts/assert-mock.mjs checks before the X-ray calls anything.
//   node scripts/xray-mock.mjs --home <dir> [--port 5999]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fakeWorld } from '../src/fake.mjs';
import { fingerprint } from '../src/kvmd.mjs';

const argOf = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };

export const MOCK_MAC = 'mock';
export const IDENTITY_PATH = '/__xray/identity';

export function writeHome(home, port, { cert, key, token }) {
  const pin = fingerprint(new crypto.X509Certificate(cert).raw);
  fs.writeFileSync(path.join(home, 'kvm-admin.txt'), 'Fake-admin-pw-1', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'mock.token'), token, { mode: 0o600 });
  const cfg = {
    macs: {
      [MOCK_MAC]: {
        kvm: {
          endpoints: [{ label: 'loopback mock', url: `https://127.0.0.1:${port}` }],
          tls_sha256: pin,
          user: 'admin',
          admin_password: `file:${path.join(home, 'kvm-admin.txt')}`,
        },
      },
    },
  };
  fs.mkdirSync(path.join(home, '.config', 'housesitter'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.config', 'housesitter', 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return { pin };
}

// Header names keep the case the client sent them in: the fake KVM matches `X-KVMD-Passwd` exactly.
function sentHeaders(raw) {
  const out = {};
  for (let i = 0; i < raw.length; i += 2) out[raw[i]] = raw[i + 1];
  return out;
}

export function startMock({ home, port }) {
  const dir = path.resolve(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const certDir = fs.mkdtempSync(path.join(dir, 'tls-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=kvm', '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem')], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('openssl could not make the mock certificate');
  const cert = fs.readFileSync(path.join(certDir, 'c.pem'));
  const key = fs.readFileSync(path.join(certDir, 'k.pem'));
  fs.rmSync(certDir, { recursive: true, force: true });
  const token = crypto.randomUUID();
  writeHome(dir, port, { cert, key, token });

  const world = fakeWorld();
  const server = https.createServer({ cert, key }, (req, res) => {
    if (req.url === IDENTITY_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mock: true, token }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = chunks.length ? Buffer.concat(chunks) : null;
      const out = await world.request({ url: `https://127.0.0.1:${port}${req.url}`, method: req.method, headers: sentHeaders(req.rawHeaders), body });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const home = argOf('--home');
  if (!home) { console.error('usage: node scripts/xray-mock.mjs --home <dir> [--port 5999]'); process.exit(2); }
  await startMock({ home, port: Number(argOf('--port', '5999')) });
  console.log(`mock KVM listening on https://127.0.0.1:${argOf('--port', '5999')}`);
}
