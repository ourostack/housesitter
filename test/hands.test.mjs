// Eyes and hands: the pixel driver over a pretend KVM, both transports, and Anthropic computer-use input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driver, directTransport, outboxTransport, open, Refusal } from '../src/hands.mjs';
import { makeClient } from '../src/kvmd.mjs';
import { fakeWorld, fakeJpeg } from '../src/fake.mjs';
import { absPoint, keyNames, looksSecret } from '../src/keys.mjs';

const kvm = (opts) => {
  const w = fakeWorld(opts);
  const c = makeClient({ base: w.url, pin: w.pin, password: w.st.adminPassword, request: w.request, warm: false });
  return { w, mac: driver(directTransport(c)) };
};

test('a shrunk screenshot maps clicks back to the real resolution', async () => {
  const { w, mac } = kvm({ resolution: [2560, 1440] });
  const s = await mac.screenshot({ maxWidth: 1280 });
  assert.deepEqual([s.width, s.height, s.real.width, s.real.height], [1280, 720, 2560, 1440]);
  await mac.click(640, 360);
  assert.deepEqual(w.st.clicks[0].at, absPoint(1280, 720, 2560, 1440));
  await assert.rejects(mac.click(1280, 10), (e) => e instanceof Refusal && e.code === 'input-invalid');
});

test('type refuses secrets; keys take xdotool-style names', async () => {
  const { w, mac } = kvm();
  await mac.type('hello world');
  assert.deepEqual(w.st.typed, ['hello world']);
  await assert.rejects(mac.type('ghp_abcdefghijklmnop1234'), /looks like a password/);
  await assert.rejects(mac.type('Tr0ub4dor&3xyz'), /looks like a password/);
  assert.equal(looksSecret('open the Terminal app'), false);
  await mac.key('ctrl+shift+4');
  await mac.key('Return');
  assert.deepEqual(w.st.keys, ['ControlLeft,ShiftLeft,Digit4', 'Enter']);
  assert.deepEqual(keyNames('super+space'), ['MetaLeft', 'Space']);
  assert.throws(() => keyNames('cmd+??'), /unknown key/);
});

test('computer(): Anthropic actions in, a tool_result-shaped answer out', async () => {
  const { w, mac } = kvm();
  const shot = await mac.computer({ action: 'screenshot' });
  assert.equal(shot.type, 'image');
  assert.equal(shot.source.media_type, 'image/jpeg');
  await mac.computer({ action: 'double_click', coordinate: [100, 100] });
  assert.equal(w.st.clicks.length, 2);
  await mac.computer({ action: 'scroll', coordinate: [10, 10], scroll_direction: 'down', scroll_amount: 5 });
  assert.deepEqual(w.st.wheel.at(-1), [0, -5]);
  await mac.computer({ action: 'left_click_drag', start_coordinate: [1, 1], coordinate: [50, 50] });
  assert.equal((await mac.computer({ action: 'cursor_position' })).text, 'X=50,Y=50');
  await assert.rejects(mac.computer({ action: 'hold_key' }), (e) => e.code === 'action-unavailable' && e.available.includes('left_click'));
});

test('outbox transport: the sitter maps pixels; refusals keep their codes', async () => {
  const sent = [];
  const send = async (op, args) => {
    sent.push({ op, args });
    if (op === 'screenshot') return { ok: true, result: { real: { width: 1920, height: 1080 } }, files: { 'studio.screen.jpg.b64': { content: fakeJpeg(960, 540).toString('base64') } } };
    if (op === 'type') return { ok: false, code: 'input-invalid', result: 'args.text: 1-2000 characters' };
    return { ok: true, result: 'done' };
  };
  const mac = driver(outboxTransport('studio', { send }));
  await mac.screenshot({ maxWidth: 960 });
  await mac.click(480, 270);
  assert.deepEqual(sent[1], { op: 'click', args: { x: 960, y: 540, w: 1920, h: 1080, button: 'left', double: false, count: 1 } });
  await assert.rejects(mac.type('x'), (e) => e.code === 'input-invalid');
  await assert.rejects(mac.move(1, 1), (e) => e.code === 'action-unavailable');
});

test('open(): direct first, the outbox when the KVM does not answer, and a pinned certificate', async () => {
  const w = fakeWorld();
  const mac = { name: 'studio', kvm: { endpoints: [{ label: 'LAN', url: w.url }], tls_sha256: w.pin, user: 'admin', admin_password: 'env:X' } };
  const d = await open('studio', { deps: { mac, request: w.request, password: () => w.st.adminPassword, warm: false } });
  assert.match(d.via, /^direct LAN/);
  const down = async () => { throw new Error('no route'); };
  const o = await open('studio', { deps: { mac: { ...mac, outbox: { gist: 'g', inbox: 'i' } }, request: down, password: () => 'x', send: async () => ({ ok: true }) } });
  assert.equal(o.via, 'outbox (GitHub)');
  await assert.rejects(open('studio', { deps: { mac, request: down, password: () => 'x' } }), (e) => e.code === 'action-failed');
});

test('a GLKVM 503 snapshot falls back to asking the sitter for the picture', async () => {
  const w = fakeWorld();
  const req = async (o) => (o.url.includes('/snapshot') ? { status: 503, headers: {}, body: Buffer.alloc(0) } : w.request(o));
  const mac = { name: 'studio', kvm: { endpoints: [{ url: w.url }], tls_sha256: w.pin, user: 'admin' } };
  const sitter = { op: async () => ({ ok: true, result: { real: { width: 1920, height: 1080 } }, files: { 'studio.screen.jpg.b64': fakeJpeg(1280, 720).toString('base64') } }) };
  const d = await open('studio', { transport: 'direct', deps: { mac, request: req, password: () => w.st.adminPassword, sitter, warm: false } });
  const s = await d.screenshot({ maxWidth: 1280 });
  assert.deepEqual([s.width, s.real.width], [1280, 1920]);
});

test('stream warm-up: a WebSocket upgrade over pinned TLS, held open until close()', async () => {
  const { streamWarm, withWarm, hasPicture } = await import('../src/kvmd.mjs');
  const { EventEmitter } = await import('node:events');
  const sent = [];
  const sock = Object.assign(new EventEmitter(), { getPeerCertificate: () => ({ raw: Buffer.from('cert') }), write: (d) => sent.push(d), destroy() { this.destroyed = true; } });
  const { fingerprint } = await import('../src/kvmd.mjs');
  const p = streamWarm({ base: 'https://kvm.local', pin: fingerprint(Buffer.from('cert')), password: 'pw', connect: () => { setImmediate(() => { sock.emit('secureConnect'); sock.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n')); }); return sock; } });
  const w = await p;
  assert.match(sent[0], /^GET \/api\/ws\?stream=1 HTTP\/1\.1/);
  let ran = false;
  await withWarm(async () => w, async () => { ran = true; });
  assert.ok(ran && sock.destroyed);
  assert.equal(hasPicture({ online: true, captured_fps: 0 }), false, 'online with no frames is no picture');
  assert.equal(hasPicture({ online: true, captured_fps: 30 }), true);
});
