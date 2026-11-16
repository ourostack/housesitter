// The X-ray's guard: passes only when the loopback server on the port is the mock this home was written for, proven by
// the token the mock wrote into the home. Exits 1 with the reason otherwise.
//   node scripts/assert-mock.mjs --home <dir> [--port 5999]
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { IDENTITY_PATH } from './xray-mock.mjs';

const argOf = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const home = path.resolve(argOf('--home', '.'));
const port = Number(argOf('--port', '5999'));

function identity() {
  return new Promise((resolve, reject) => {
    // The mock's certificate is its own, not a public one: the token is what proves it, not the certificate.
    const req = https.get({ host: '127.0.0.1', port, path: IDENTITY_PATH, rejectUnauthorized: false, timeout: 5000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('no answer within 5 s')));
  });
}

try {
  const want = fs.readFileSync(path.join(home, 'mock.token'), 'utf8');
  const got = await identity();
  if (got.mock !== true || got.token !== want) throw new Error('the server on this port is not the mock this home was written for');
  console.log(`mock proven on 127.0.0.1:${port}`);
} catch (e) {
  console.error(`refusing to check: ${e.message}`);
  process.exit(1);
}
