// Eyes and hands on a Mac below the accessibility tree: the screen and the keyboard/mouse through its KVM, from
// before login (the FileVault screen) to a frozen app. Import it; agents and other tools build on it.
//
//   import { open } from '@ouro.bot/housesitter';
//   const mac = await open('studio');                          // picks a transport, says which (mac.via)
//   const shot = await mac.screenshot({ maxWidth: 1280 });     // { image, mime, width, height }: JPEG bytes
//   await mac.click(640, 400);                                 // in the last screenshot's pixels, whatever its size
//   await mac.type('hello');                                   // never a secret: see below
//   await mac.key('cmd+space');
//   await mac.computer({ action: 'left_click', coordinate: [640, 400] });  // Anthropic computer-use tool input
//
// Coordinates are always in the picture you last saw: a screenshot shrunk to 1280 px wide maps back to the Mac's
// real resolution, so an agent never does the scaling arithmetic itself.
//
// Transports (pluggable: registerTransport(kind, factory)):
//   direct  kvmd's HTTPS API at a configured endpoint (LAN, or the tailnet): ~0.2-1 s an action. Pinned certificate.
//   outbox  through the sitter's GitHub gists, from anywhere with GitHub: ~2-4 s an action.
// type() refuses anything that looks like a password or token. The Mac's password is typed only by the sitter.

import { absPoint, imageSize, keyNames, looksSecret } from './keys.mjs';
import { connect, httpsRequest, withWarm } from './kvmd.mjs';
import { macConfig, secretStore } from './config.mjs';
import * as O from './outbox.mjs';

export class Refusal extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const transports = new Map();
export function registerTransport(kind, factory) { transports.set(kind, factory); }

// ---------- direct: kvmd over HTTPS ----------

export function directTransport(client, { via = `direct ${client.base}` } = {}) {
  let real = null;
  const realSize = async () => {
    if (real) return real;
    const s = await client.streamer().catch(() => null);
    const r = s?.streamer?.source?.resolution || s?.source?.resolution;
    if (r?.width) real = { width: r.width, height: r.height };
    return real;
  };
  return {
    via,
    async screenshot({ maxWidth } = {}) {
      const q = maxWidth ? `&preview=1&preview_max_width=${maxWidth}&preview_quality=80` : '';
      const r = await withWarm(client.warm, () => client.raw('GET', `/api/streamer/snapshot?allow_offline=1${q}`, { timeoutMs: 15000 }));
      if (r.status !== 200) throw new Refusal('action-failed', `snapshot -> HTTP ${r.status}${r.status === 503 ? ' (no video client: the encoder is idle; GLKVM starts it only while something watches)' : ''}`);
      const size = imageSize(r.body);
      if (!maxWidth) real = size;
      return { image: r.body, ...size, real: (await realSize()) || size };
    },
    async click({ x, y, w, h, button = 'left', count = 1 }) {
      const [tx, ty] = absPoint(x, y, w, h);
      await client.moveTo(tx, ty);
      for (let n = 0; n < count; n++) { await client.button(button, true); await client.button(button, false); }
    },
    async move({ x, y, w, h }) { const [tx, ty] = absPoint(x, y, w, h); await client.moveTo(tx, ty); },
    async button({ button = 'left', down }) { await client.button(button, down); },
    async type(text) { await client.type(text); },
    async key(names) { if (names.length === 1) await client.sendKey(names[0]); else await client.shortcut(names); },
    async scroll({ x, y, w, h, dx = 0, dy = 0 }) { if (x != null) { const [tx, ty] = absPoint(x, y, w, h); await client.moveTo(tx, ty); } await client.wheel(dx, dy); },
  };
}

// ---------- outbox: through the sitter's gists ----------

export function outboxTransport(name, { send }) {
  const ask = async (op, args) => {
    const r = await send(op, args);
    if (!r.ok) throw new Refusal(r.code === 'action-unavailable' || r.code === 'input-invalid' ? r.code : 'action-failed', `${op} via the outbox: ${r.code || ''} ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}`);
    return r;
  };
  return {
    via: 'outbox (GitHub)',
    async screenshot({ maxWidth = 1280 } = {}) {
      const r = await ask('screenshot', { width: maxWidth });
      const b64 = r.files?.[`${name}.screen.jpg.b64`]?.content;
      if (!b64) throw new Refusal('action-failed', 'the sitter answered without a picture');
      const image = Buffer.from(b64, 'base64');
      const size = imageSize(image);
      const real = r.result?.real || size;
      return { image, ...size, real };
    },
    // The sitter maps pixels itself: send the size these coordinates are in, so both sides agree.
    async click({ x, y, w, h, button = 'left', count = 1 }) { await ask('click', { x, y, w, h, button, double: count === 2, count }); },
    async move() { throw new Refusal('action-unavailable', 'mouse_move is direct-only (the outbox moves and clicks in one request)', { available: ['screenshot', 'left_click', 'right_click', 'double_click', 'type', 'key', 'scroll'] }); },
    async button() { throw new Refusal('action-unavailable', 'press-and-hold is direct-only', { available: ['screenshot', 'left_click', 'right_click', 'double_click', 'type', 'key', 'scroll'] }); },
    async type(text) { await ask('type', { text }); },
    async key(names) { await ask('key', { combo: names.join('+') }); },
    async scroll({ x, y, w, h, dx = 0, dy = 0 }) { await ask('scroll', { x, y, w, h, dx, dy }); },
  };
}

// ---------- the driver agents hold ----------

export function driver(t) {
  let seen = null;   // the last screenshot's size: coordinates come in this space
  let real = null;   // the Mac's real output size: what the KVM maps to
  let cursor = null;
  const space = async () => {
    if (!seen) { const s = await api.screenshot(); seen = { width: s.width, height: s.height }; }
    return seen;
  };
  const toReal = async (x, y) => {
    const s = await space();
    if (!(Number.isFinite(x) && Number.isFinite(y))) throw new Refusal('input-invalid', 'coordinates must be numbers', { path: '$.coordinate' });
    if (x < 0 || y < 0 || x >= s.width || y >= s.height) throw new Refusal('input-invalid', `point ${x},${y} is off the ${s.width}x${s.height} screenshot`, { path: '$.coordinate' });
    const r = real || s;
    return { x: Math.round((x * r.width) / s.width), y: Math.round((y * r.height) / s.height), w: r.width, h: r.height };
  };
  const api = {
    get via() { return t.via; },
    async screenshot({ maxWidth } = {}) {
      const s = await t.screenshot({ maxWidth });
      seen = { width: s.width, height: s.height };
      real = s.real || seen;
      return { image: s.image, mime: s.image[0] === 0x89 ? 'image/png' : 'image/jpeg', width: s.width, height: s.height, real, via: t.via };
    },
    async click(x, y, { button = 'left', double = false, count = double ? 2 : 1 } = {}) {
      if (!['left', 'right', 'middle'].includes(button)) throw new Refusal('input-invalid', `button must be left, right or middle (got ${button})`, { path: '$.button' });
      const p = await toReal(x, y);
      await t.click({ ...p, button, count });
      cursor = [x, y];
      return { ok: true, via: t.via };
    },
    async move(x, y) { const p = await toReal(x, y); await t.move(p); cursor = [x, y]; return { ok: true, via: t.via }; },
    async drag(from, to) {
      await api.move(from[0], from[1]);
      await t.button({ button: 'left', down: true });
      try { await api.move(to[0], to[1]); } finally { await t.button({ button: 'left', down: false }); }
      return { ok: true, via: t.via };
    },
    async type(text) {
      if (typeof text !== 'string' || !text || text.length > 2000) throw new Refusal('input-invalid', 'type takes 1-2000 characters', { path: '$.text' });
      if (looksSecret(text)) throw new Refusal('input-invalid', 'refusing to type something that looks like a password or token (the sitter types the Mac password itself, at the prompt)', { path: '$.text' });
      await t.type(text);
      return { ok: true, via: t.via };
    },
    async key(combo) {
      let names;
      try { names = keyNames(combo); } catch (e) { throw new Refusal('input-invalid', e.message, { path: '$.text' }); }
      await t.key(names);
      return { ok: true, via: t.via };
    },
    async scroll(x, y, { direction = 'down', amount = 3 } = {}) {
      const step = Math.max(1, Math.min(20, Math.round(amount)));
      const d = { up: [0, step], down: [0, -step], left: [-step, 0], right: [step, 0] }[direction];
      if (!d) throw new Refusal('input-invalid', 'scroll_direction is up, down, left or right', { path: '$.scroll_direction' });
      const p = x == null ? {} : await toReal(x, y);
      await t.scroll({ ...p, dx: d[0], dy: d[1] });
      return { ok: true, via: t.via };
    },
    // Anthropic's computer-use tool input, as-is. Returns what a tool_result needs: an image for screenshot, else text.
    async computer(input = {}) {
      const a = input.action;
      const at = input.coordinate;
      switch (a) {
        case 'screenshot': {
          const s = await api.screenshot({ maxWidth: input.max_width || 1280 });
          return { type: 'image', source: { type: 'base64', media_type: s.mime, data: s.image.toString('base64') }, width: s.width, height: s.height };
        }
        case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click': {
          if (!at) throw new Refusal('input-invalid', `${a} needs coordinate [x, y]`, { path: '$.coordinate' });
          const button = a === 'right_click' ? 'right' : a === 'middle_click' ? 'middle' : 'left';
          await api.click(at[0], at[1], { button, count: a === 'double_click' ? 2 : a === 'triple_click' ? 3 : 1 });
          return { type: 'text', text: `${a} at ${at[0]},${at[1]}` };
        }
        case 'mouse_move': await api.move(at[0], at[1]); return { type: 'text', text: `moved to ${at[0]},${at[1]}` };
        case 'left_click_drag': await api.drag(input.start_coordinate || cursor || at, at); return { type: 'text', text: `dragged to ${at[0]},${at[1]}` };
        case 'type': await api.type(input.text); return { type: 'text', text: `typed ${String(input.text).length} characters` };
        case 'key': await api.key(input.text); return { type: 'text', text: `pressed ${input.text}` };
        case 'scroll': await api.scroll(at?.[0], at?.[1], { direction: input.scroll_direction, amount: input.scroll_amount }); return { type: 'text', text: `scrolled ${input.scroll_direction}` };
        case 'wait': await new Promise((r) => setTimeout(r, Math.min(10, Math.max(0, Number(input.duration) || 1)) * 1000)); return { type: 'text', text: 'waited' };
        case 'cursor_position': return { type: 'text', text: cursor ? `X=${cursor[0]},Y=${cursor[1]}` : 'unknown (nothing has moved the pointer yet)' };
        default: throw new Refusal('action-unavailable', `unknown action ${a}`, { available: ['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'mouse_move', 'left_click_drag', 'type', 'key', 'scroll', 'wait', 'cursor_position'] });
      }
    },
  };
  return api;
}

registerTransport('direct', async (mac, deps) => {
  const store = deps.secrets || secretStore();
  const password = deps.password || (() => store.get(mac.kvm.admin_password) || '');
  const { client, endpoint } = await connect({ endpoints: mac.kvm.endpoints, pin: mac.kvm.tls_sha256, user: mac.kvm.user, password, request: deps.request || httpsRequest, warm: deps.warm });
  const t = directTransport(client, { via: `direct ${endpoint.label || endpoint.url}${endpoint.fallback ? ' (fallback)' : ''}` });
  // GLKVM encodes video only while a viewer is connected, so a headless snapshot can 503. The sitter on the KVM knows
  // how to wake the encoder: ask it for the picture instead (deps.sitter is a sitterClient).
  if (deps.sitter) {
    const direct = t.screenshot;
    t.screenshot = async (o = {}) => {
      try { return await direct(o); } catch (e) {
        if (!/503/.test(e.message)) throw e;
        const r = await deps.sitter.op('screenshot', { width: o.maxWidth || 1920 });
        const b64 = r.ok && Object.values(r.files || {})[0];
        if (!b64) throw e;
        const image = Buffer.from(typeof b64 === 'string' ? b64 : b64.content, 'base64');
        return { image, ...imageSize(image), real: r.result?.real };
      }
    };
  }
  return t;
});

registerTransport('outbox', async (mac, deps) => {
  const o = mac.outbox;
  if (!o?.gist) throw new Error('no outbox configured');
  const store = deps.secrets || secretStore();
  const gh = deps.gh || O.gistClient({ token: () => (o.token && store.get(o.token)) || O.ghCliToken() });
  const send = deps.send || ((op, args) => O.send(mac.name, o, gh, op, args, { timeoutMs: op === 'type' ? 60000 : 15000 }));
  return outboxTransport(mac.name, { send });
});

// Open a Mac by its config name. transport: 'auto' tries direct, then outbox.
export async function open(name, { transport = 'auto', deps = {} } = {}) {
  const mac = deps.mac || macConfig(name, deps.cfg);
  const order = transport === 'auto' ? ['direct', 'outbox'] : [transport];
  const errors = [];
  for (const kind of order) {
    const f = transports.get(kind);
    if (!f) { errors.push(`${kind}: no such transport`); continue; }
    try { return driver(await f(mac, deps)); } catch (e) { errors.push(`${kind}: ${e.message}`); }
  }
  throw new Refusal('action-failed', `no route to ${name}'s KVM (${errors.join('; ')})`);
}
