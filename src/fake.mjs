// A pretend KVM and a pretend Mac, for tests, `housesitter demo` and `housesitter adopt --fake`. Nothing here touches
// a network. The KVM answers kvmd's HTTP API the way PiKVM/GLKVM do (including GL's quirks: the REST API shipped
// off, and first-run password setup); the Mac has a screen that is a desktop, the FileVault prompt, or black.

import { fingerprint } from './kvmd.mjs';

// A tiny but well-formed JPEG header (SOI + SOF0 with the size): enough for imageSize, not for a viewer.
export function fakeJpeg(width, height) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

export const FAKE_CERT = Buffer.from('housesitter fake kvm certificate');

export const SCREENS = {
  desktop: 'Finder File Edit View Go Window Help\nTerminal\nThu 3:11 AM',
  filevault: 'Ada\nEnter Password\nRestart Shut Down',
  login: 'Ada\nEnter Password\nSleep Restart Shut Down',
  blank: '',
};

export function fakeWorld({ apiClosed = false, inited = true, adminPassword = 'Fake-admin-pw-1', macPassword = 'correct horse', screen = 'desktop', resolution = [1920, 1080], ocr = true } = {}) {
  const st = {
    apiClosed, inited, adminPassword: inited ? adminPassword : null, macPassword, screen, resolution, keyboard: true, video: true,
    otg: { start_cdrom: true, start_flash: false }, typed: [], keys: [], clicks: [], wheel: [], pointer: null, unlocked: 0, rootKeys: [],
  };
  const pin = fingerprint(FAKE_CERT);
  const ok = (result, extra = {}) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ ok: true, result })), fingerprint: pin, ...extra });
  const raw = (buf) => ({ status: 200, headers: {}, body: buf, fingerprint: pin });
  const no = (status) => ({ status, headers: {}, body: Buffer.from('{}'), fingerprint: pin });
  // The Mac reacts to what the KVM types.
  const onTyped = (text) => {
    st.typed.push(text);
    if ((st.screen === 'filevault' || st.screen === 'login') && text === `${st.macPassword}\n`) { st.screen = 'desktop'; st.unlocked++; }
  };
  async function request({ url, method = 'GET', headers = {}, body = null }) {
    const u = new URL(url);
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams);
    if (p === '/' ) return raw(Buffer.from('<html><title>GLKVM</title></html>'));
    if (st.apiClosed && p.startsWith('/api/')) return no(404);
    if (p === '/api/init/is_inited') return ok({ is_inited: st.inited });
    if (p === '/api/init/init') { if (st.inited) return no(400); st.adminPassword = q.password; st.inited = true; return ok({}); }
    const authed = headers['X-KVMD-Passwd'] != null ? headers['X-KVMD-Passwd'] === st.adminPassword && st.adminPassword : false;
    if (!authed) return no(401);
    if (p === '/api/info') return ok({ hw: { platform: { model: 'fake-rm1pe' } }, system: { kvmd: { version: '4.fake' } } });
    if (p === '/api/hid') return ok({ keyboard: { online: st.keyboard }, mouse: { online: st.keyboard } });
    if (p === '/api/streamer') return ok({ streamer: { source: { online: st.video, resolution: { width: st.resolution[0], height: st.resolution[1] } } } });
    if (p === '/api/streamer/snapshot') {
      // A real GL-RM1PE (V1.7.1) at 2560x1440 answers OCR with HTTP 500: `ocr: false` plays that KVM.
      if (q.ocr) return ocr ? ok(st.video ? SCREENS[st.screen] : '') : no(500);
      const w = q.preview_max_width ? Math.min(Number(q.preview_max_width), st.resolution[0]) : st.resolution[0];
      return raw(fakeJpeg(w, Math.round((w * st.resolution[1]) / st.resolution[0])));
    }
    if (p === '/api/hid/print') { onTyped(String(body)); return ok({}); }
    if (p === '/api/hid/events/send_key') { st.keys.push(q.key); return ok({}); }
    if (p === '/api/hid/events/send_shortcut') { st.keys.push(q.keys); return ok({}); }
    if (p === '/api/hid/events/send_mouse_move') { st.pointer = [Number(q.to_x), Number(q.to_y)]; return ok({}); }
    if (p === '/api/hid/events/send_mouse_button') { if (q.state === 'true') st.clicks.push({ button: q.button, at: st.pointer }); return ok({}); }
    if (p === '/api/hid/events/send_mouse_wheel') { st.wheel.push([Number(q.delta_x), Number(q.delta_y)]); return ok({}); }
    if (p === '/api/system/otg_functions') { if (method === 'POST') { st.otg = { start_cdrom: q.start_cdrom === 'true', start_flash: q.start_flash === 'true' }; } return ok(st.otg); }
    if (p === '/api/system/ssh_key') { if (method === 'POST') st.rootKeys = String(body).trim().split('\n'); return ok({ ssh_key: st.rootKeys.join('\n') }); }
    return no(404);
  }
  return { st, request, pin, url: 'https://kvm.fake' };
}
