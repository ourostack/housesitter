// Pure helpers shared by every transport: key names, mouse coordinates, picture sizes, and the secret guard.
// device/sitter.py carries the same tables (key_names, abs_point); test/parity.test.mjs keeps them in step.

const ALIASES = {
  cmd: 'MetaLeft', command: 'MetaLeft', meta: 'MetaLeft', super: 'MetaLeft', shift: 'ShiftLeft', ctrl: 'ControlLeft', control: 'ControlLeft',
  alt: 'AltLeft', option: 'AltLeft', opt: 'AltLeft', return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape',
  tab: 'Tab', space: 'Space', delete: 'Backspace', backspace: 'Backspace', up: 'ArrowUp', down: 'ArrowDown',
  left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  page_up: 'PageUp', page_down: 'PageDown',
};

// 'cmd+shift+4' -> ['MetaLeft', 'ShiftLeft', 'Digit4'] (kvmd's web key names). Also takes xdotool-style names, which
// is what agents trained on computer-use tools send ('ctrl+l', 'Return', 'super+space').
export function keyNames(combo) {
  const out = String(combo).split('+').map((p) => p.trim()).filter(Boolean).map((part) => {
    const low = part.toLowerCase();
    if (ALIASES[low]) return ALIASES[low];
    if (/^[a-z]$/i.test(part)) return `Key${part.toUpperCase()}`;
    if (/^\d$/.test(part)) return `Digit${part}`;
    if (/^f([1-9]|1[0-2])$/i.test(part)) return part.toUpperCase();
    if (/^[A-Z][A-Za-z0-9]+$/.test(part)) return part;
    throw new Error(`unknown key "${part}"`);
  });
  if (!out.length) throw new Error('empty key combo');
  return out;
}

// Screen pixels -> kvmd's absolute mouse range (-32768..32767 on each axis).
export function absPoint(x, y, w, h) {
  if (!(x >= 0 && x < w && y >= 0 && y < h)) throw new Error(`point ${x},${y} is off the ${w}x${h} screen`);
  const clamp = (v) => Math.max(-32768, Math.min(32767, v));
  return [clamp(Math.round((x * 65535) / Math.max(1, w - 1)) - 32768), clamp(Math.round((y * 65535) / Math.max(1, h - 1)) - 32768)];
}

// Text that must never be typed through a relay: tokens by their prefixes, and anything shaped like a password
// (one long word mixing upper, lower, digits and symbols). The Mac's password is typed only by the sitter itself.
export function looksSecret(text) {
  const t = String(text);
  return /\b(gh[opsu]_|github_pat_|tskey-|xox[bp]-|sk-)[\w-]{8,}/.test(t) || (/^\S{10,}$/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t) && /[^\w]/.test(t));
}

// Picture size from the image bytes (JPEG SOF or PNG IHDR).
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  let i = 2;
  while (i + 9 < buf.length && buf[i] === 0xff) {
    const m = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  throw new Error('could not read the picture size');
}

export const isJpeg = (b) => Buffer.isBuffer(b) && b[0] === 0xff && b[1] === 0xd8;
export const isPng = (b) => Buffer.isBuffer(b) && b.length > 8 && b.readUInt32BE(0) === 0x89504e47;
