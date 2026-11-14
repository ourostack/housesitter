// A pretend GitHub Copilot app for tests and rehearsals: a state folder (database, session histories, socket port and
// token) and a local WebSocket server that answers like the app: a hello, then session_message_sent for send_message,
// and a new turn in that session's history. Standalone: node test/fake_app.mjs <home> [--drop <id>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const haveSqlite = () => spawnSync('/usr/bin/sqlite3', ['-version']).status === 0;

const ev = (type, data = {}, at = Date.now()) => JSON.stringify({ type, data, id: `${type}-${at}`, timestamp: new Date(at).toISOString() });

// sessions: [{ id, title, mode, running, interrupted, loc, archived, events: [[type, data]...] }]
export function makeHome(home, sessions) {
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  const db = path.join(home, 'data.db');
  const q = [
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, mode TEXT, is_running INTEGER, was_interrupted INTEGER, execution_location TEXT, archived_at TEXT);',
    'CREATE TABLE workspaces (id TEXT, session_id TEXT, archived_at TEXT);',
    ...sessions.map((s) => `INSERT INTO sessions VALUES ('${s.id}', '${s.title || s.id}', ${s.mode ? `'${s.mode}'` : 'NULL'}, ${s.running ? 1 : 0}, ${s.interrupted ? 1 : 0}, '${s.loc || 'local'}', ${s.archived ? "'2026-11-01'" : 'NULL'});`),
  ].join('\n');
  fs.rmSync(db, { force: true });
  const r = spawnSync('/usr/bin/sqlite3', [db], { input: q, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr}`);
  for (const s of sessions) {
    const d = path.join(home, 'session-state', s.id);
    fs.mkdirSync(d, { recursive: true });
    const t0 = Date.now() - 600000;
    fs.writeFileSync(path.join(d, 'events.jsonl'), (s.events || []).map(([type, data], i) => ev(type, data, t0 + i * 1000)).join('\n') + '\n');
  }
}

export const MID_TURN = [['user.message'], ['assistant.turn_start']];
export const DONE = [['user.message'], ['assistant.turn_start'], ['assistant.message', { toolRequests: [] }], ['assistant.turn_end']];

function frame(text) {
  const b = Buffer.from(text);
  const head = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]);
  return Buffer.concat([head, b]);
}

function* frames(buf) {
  let i = 0;
  while (i + 2 <= buf.length) {
    let len = buf[i + 1] & 127; let o = i + 2;
    if (len === 126) { len = buf.readUInt16BE(o); o += 2; }
    const masked = buf[i + 1] & 128; const mask = masked ? buf.subarray(o, o + 4) : null; if (masked) o += 4;
    if (o + len > buf.length) return;
    const p = Buffer.from(buf.subarray(o, o + len));
    if (mask) for (let k = 0; k < p.length; k++) p[k] ^= mask[k % 4];
    if ((buf[i] & 15) === 1) yield p.toString('utf8');
    i = o + len;
  }
}

// drop: session ids that get the message accepted but never take a turn; refuse: ids the app answers with an error.
export function startApp(home, { drop = [], refuse = [], token = 'tok' } = {}) {
  const received = [];
  const server = http.createServer();
  const open = new Set();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') !== token) { socket.destroy(); return; }
    const key = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    open.add(socket); socket.on('close', () => open.delete(socket));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    socket.write(frame(JSON.stringify({ type: 'server_hello' })));
    socket.on('data', (buf) => {
      for (const t of frames(buf)) {
        const m = JSON.parse(t);
        if (m.type !== 'send_message') continue;
        received.push({ id: m.session_id, prompt: m.prompt, at: Date.now() });
        if (refuse.includes(m.session_id)) { socket.write(frame(JSON.stringify({ type: 'error', request_id: m.request_id, message: `session ${m.session_id} is archived` }))); continue; }
        const f = path.join(home, 'session-state', m.session_id, 'events.jsonl');
        fs.appendFileSync(f, `${ev('user.message', { content: m.prompt })}\n`);
        if (!drop.includes(m.session_id)) setTimeout(() => fs.appendFileSync(f, `${ev('assistant.turn_start')}\n`), 30);
        socket.write(frame(JSON.stringify({ type: 'session_message_sent', request_id: m.request_id, session_id: m.session_id })));
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(path.join(home, 'run', 'ws.port'), String(server.address().port));
    fs.writeFileSync(path.join(home, 'run', 'ws.token'), token);
    resolve({ received, port: server.address().port, close: () => new Promise((r) => { for (const x of open) x.destroy(); server.close(r); }) });
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.argv[2];
  const drop = process.argv.includes('--drop') ? [process.argv[process.argv.indexOf('--drop') + 1]] : [];
  if (!fs.existsSync(path.join(home, 'data.db'))) makeHome(home, [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'busy one', mode: 'autopilot', running: true, events: MID_TURN },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', title: 'idle two', events: DONE },
    { id: 'cccccccc-0000-4000-8000-000000000003', title: 'busy three', mode: 'interactive', events: MID_TURN },
  ]);
  const app = await startApp(home, { drop });
  console.log(`fake app on ${app.port}, home ${home}`);
  setInterval(() => {}, 1 << 30);
}
