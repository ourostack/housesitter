// A client for kvmd's HTTP API: PiKVM's daemon, and GL.iNet's GLKVM fork of it on the Comet (GL: "we haven't
// published API docs… refer to PiKVM's, we are consistent with it"). HTTPS to the KVM's self-signed certificate,
// pinned to the fingerprint recorded at adopt. Auth by X-KVMD-User/X-KVMD-Passwd headers, falling back to the
// /api/auth/login cookie, which some GLKVM firmware wants instead.

import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';

export const fingerprint = (der) => crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');

// Never reshape what the Mac sees: no EDID writes, no factory reset, no firmware upgrade. An EDID change on a live Mac
// mini froze it (2026-11-08). Checked in httpsRequest and again in every client call (which may be handed another
// request function), so no entry point, raw included, gets round it.
export function refuseReshape(method, url) {
  const q = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0].toLowerCase();
  if (q.includes('edid') && method !== 'GET') return `refused: ${q} changes the display the Mac sees; never reshape a live Mac's displays`;
  if (/reset_default|factory/.test(q) || (/\/upgrade(\/|$)/.test(q) && method !== 'GET')) return `refused: ${q} resets or reflashes the KVM, EDID included; never from housesitter`;
  return null;
}

// pin=null only for first contact (adopt), which records the fingerprint it saw.
export function httpsRequest({ url, method = 'GET', headers = {}, body = null, pin = null, timeoutMs = 8000 }) {
  const refused = refuseReshape(method, url);
  if (refused) return Promise.reject(new Error(`kvmd: ${refused}`));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // agent: false gives every request its own connection and a full handshake. A pooled, resumed TLS session can
    // report no peer certificate at all, and two requests in parallel then fail the pin (seen on a real GL-RM1PE).
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, rejectUnauthorized: false, timeout: timeoutMs, agent: false }, (res) => {
      const raw = res.socket.getPeerCertificate()?.raw;
      if (!raw?.length) { res.destroy(); return reject(new Error(`${u.host} showed no TLS certificate; refusing`)); }
      const fp = fingerprint(raw);
      if (pin && fp !== pin) { res.destroy(); return reject(new Error(`TLS fingerprint ${fp} isn't the pinned one; refusing (a different device, or it was reset: run adopt again)`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), fingerprint: fp }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${u.host} in ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

export function makeClient({ base, pin, user = 'admin', password, request = httpsRequest, warm = null }) {
  let cookie = null;
  const pw = typeof password === 'function' ? password : () => password;
  const call = async (method, p, { body = null, type = null, timeoutMs } = {}) => {
    const refused = refuseReshape(method, p);
    if (refused) throw new Error(`kvmd: ${refused}`);
    const headers = cookie ? { Cookie: cookie } : { 'X-KVMD-User': user, 'X-KVMD-Passwd': pw() };
    if (type) headers['Content-Type'] = type;
    let r = await request({ url: base + p, method, headers, body, pin, timeoutMs });
    if ((r.status === 401 || r.status === 403) && !cookie) {
      const login = await request({ url: `${base}/api/auth/login`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user, passwd: pw() }).toString(), pin });
      const set = [].concat(login.headers?.['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('auth_token='));
      if (login.status !== 200 || !set) throw new Error(`login refused (HTTP ${login.status}): check the KVM's admin password`);
      cookie = set;
      r = await request({ url: base + p, method, headers: { Cookie: cookie, ...(type ? { 'Content-Type': type } : {}) }, body, pin, timeoutMs });
    }
    return r;
  };
  const json = async (method, p, o) => {
    const r = await call(method, p, o);
    if (r.status === 429) throw new Error('the KVM is rate-limiting logins; wait and try again');
    if (r.status === 404 && p.startsWith('/api/')) throw new Error(`${method} ${p.split('?')[0]} -> HTTP 404 (GL.iNet ships the REST API off: housesitter adopt turns it on)`);
    if (r.status !== 200) throw new Error(`${method} ${p.split('?')[0]} -> HTTP ${r.status}`);
    const j = JSON.parse(r.body.toString('utf8'));
    return j.result ?? j;
  };
  const post = async (p, body = null) => { const r = await call('POST', p, { body, type: body != null ? 'text/plain' : null, timeoutMs: 60000 }); if (r.status !== 200) throw new Error(`POST ${p.split('?')[0]} -> HTTP ${r.status}`); return r; };
  return {
    base,
    raw: call,
    info: () => json('GET', '/api/info'),
    hid: () => json('GET', '/api/hid'),
    streamer: () => json('GET', '/api/streamer'),
    warm: warm === false ? null : warm || (() => streamWarm({ base, pin, user, password: pw })),
    async snapshot() {
      const r = await withWarm(this.warm, () => call('GET', '/api/streamer/snapshot?allow_offline=1', { timeoutMs: 15000 }));
      if (r.status === 503) throw new Error('snapshot -> HTTP 503: no video client is connected, so the encoder is idle (GLKVM). The sitter wakes it; directly, open the web UI once');
      if (r.status !== 200) throw new Error(`snapshot -> HTTP ${r.status}`);
      return r.body;
    },
    // Typed text goes in the body only. slow: pre-boot keyboards drop keys typed at full speed.
    type: (text) => post('/api/hid/print?limit=0&slow=1', text),
    sendKey: (key) => post(`/api/hid/events/send_key?key=${encodeURIComponent(key)}`),
    shortcut: (keys) => post(`/api/hid/events/send_shortcut?keys=${keys.map(encodeURIComponent).join(',')}`),
    moveTo: (tx, ty) => post(`/api/hid/events/send_mouse_move?to_x=${tx}&to_y=${ty}`),
    button: async (b, state) => post(`/api/hid/events/send_mouse_button?button=${b}&state=${state}`),
    wheel: (dx, dy) => post(`/api/hid/events/send_mouse_wheel?delta_x=${dx}&delta_y=${dy}`),
    // kvmd's own OCR (tesseract on the device): the whole picture, or a box of it.
    async ocr(box = null) {
      const b = box ? `&ocr_left=${box[0]}&ocr_top=${box[1]}&ocr_right=${box[2]}&ocr_bottom=${box[3]}` : '';
      const r = await withWarm(this.warm, () => json('GET', `/api/streamer/snapshot?ocr=1&allow_offline=1${b}`, { timeoutMs: 20000 }));
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
    isInited: () => json('GET', '/api/init/is_inited'),
    otg: () => json('GET', '/api/system/otg_functions?wait_ready=false'),
    setOtg: (q) => json('POST', `/api/system/otg_functions?${new URLSearchParams(q)}`),
  };
}

// The first endpoint that answers /api/info, in order; says which one it used.
export async function connect({ endpoints, pin, user, password, request = httpsRequest, warm }) {
  if (!endpoints?.length) throw new Error('no KVM endpoints configured (housesitter adopt records them)');
  const errors = [];
  for (const e of endpoints) {
    const c = makeClient({ base: e.url.replace(/\/$/, ''), pin, user, password, request, warm });
    try { const info = await c.info(); return { client: c, endpoint: e, info, errors }; } catch (err) { errors.push(`${e.label || e.url}: ${err.message}`); }
  }
  throw new Error(`no KVM endpoint answered: ${errors.join('; ')}`);
}

// What kind of KVM this is, from kvmd's /api/info. GL.iNet's GLKVM reports its Rockchip board as the platform base.
export function kvmModel(info) {
  const pl = info?.system?.platform || info?.hw?.platform || {};
  if (/RV1126/i.test(pl.base || '')) return 'GL.iNet Comet (GLKVM)';
  if (pl.model && pl.type === 'rpi' && !pl.base) return `PiKVM ${pl.model}`;
  return pl.base ? pl.base.split(/\s+EVB|\s+Board/)[0] : pl.model ? `kvmd on ${pl.model}` : null;
}

export function summarise({ info, hid, streamer }) {
  const src = streamer?.streamer?.source || streamer?.source || {};
  return {
    model: kvmModel(info),
    version: info?.system?.kvmd?.version || null,
    video: { online: src.online ?? null, resolution: src.resolution ? `${src.resolution.width}x${src.resolution.height}` : null },
    hid: { keyboard_online: Boolean(hid?.keyboard?.online ?? hid?.online), mouse_online: Boolean(hid?.mouse?.online ?? hid?.online) },
  };
}

// GLKVM runs its video encoder only while a stream client is connected: /api/streamer says "streamer": null and
// snapshot/OCR answer 503 until one is (kvm-pilot; seen again on a GL-RM1PE, firmware V1.7.1, 2026-11-08). This holds
// an /api/ws?stream=1 WebSocket open (plain TLS and the RFC 6455 upgrade, so no package, and the pinned certificate
// still applies) until close().
export function streamWarm({ base, pin, user = 'admin', password, connect = tls.connect, timeoutMs = 6000 }) {
  const pw = typeof password === 'function' ? password : () => password;
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const sock = connect({ host: u.hostname, port: Number(u.port || 443), rejectUnauthorized: false });
    const t = setTimeout(() => { sock.destroy(); reject(new Error(`stream warm-up got no answer in ${timeoutMs} ms`)); }, timeoutMs);
    let head = '';
    sock.once('secureConnect', () => {
      const fp = fingerprint(sock.getPeerCertificate()?.raw || Buffer.alloc(0));
      if (pin && fp !== pin) { clearTimeout(t); sock.destroy(); return reject(new Error(`TLS fingerprint ${fp} isn't the pinned one; refusing`)); }
      sock.write(['GET /api/ws?stream=1 HTTP/1.1', `Host: ${u.host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `X-KVMD-User: ${user}`, `X-KVMD-Passwd: ${pw()}`, '', ''].join('\r\n'));
    });
    const onData = (c) => {
      head += c.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      sock.off('data', onData);
      clearTimeout(t);
      const status = Number((head.match(/^HTTP\/1\.1 (\d+)/) || [])[1]);
      if (status !== 101) { sock.destroy(); return reject(new Error(`stream warm-up refused (HTTP ${status || '?'})`)); }
      sock.on('data', () => {});
      resolve({ close: () => sock.destroy() });
    };
    sock.on('data', onData);
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// Run fn with a stream client held open; a KVM that doesn't need one (PiKVM) just runs fn.
export async function withWarm(warm, fn) {
  const w = warm ? await warm().catch(() => null) : null;
  try { return await fn(); } finally { w?.close(); }
}

// kvmd can report "online" with a placeholder resolution when its HDMI chip has no lock: a real picture also has
// frames coming in (captured_fps > 0, where the firmware reports it).
export const hasPicture = (src) => Boolean(src?.online) && (src.captured_fps == null || src.captured_fps > 0);
