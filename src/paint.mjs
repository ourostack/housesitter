// How housesitter draws in a terminal: its wordmark, a glimpse of the Mac's screen (two pixels to a character, in
// true colour), and quiet labelled rows. Plain text when colour is off (NO_COLOR, a pipe, --plain): the glimpse turns
// into shades and every row says the same thing in words.

const ESC = '\x1b[';
export const PALETTE = {
  night: [122, 162, 247], dusk: [187, 154, 247], lamp: [255, 158, 100], label: [125, 207, 255], dim: [86, 95, 137],
  text: [192, 202, 245], ok: [158, 206, 106], warn: [224, 175, 104], bad: [247, 118, 142], off: [86, 95, 137],
};

export function painter(color) {
  const fg = (rgb, s) => (color ? `${ESC}38;2;${rgb.join(';')}m${s}${ESC}0m` : s);
  const bold = (s) => (color ? `${ESC}1m${s}${ESC}22m` : s);
  return {
    color, fg, bold,
    dim: (s) => fg(PALETTE.dim, s), label: (s) => fg(PALETTE.label, s), text: (s) => fg(PALETTE.text, s),
    dot: (kind) => fg(PALETTE[kind] || PALETTE.off, (color ? { ok: '●', warn: '●', bad: '●', off: '○' } : { ok: '●', warn: '!', bad: '✗', off: '○' })[kind] || '○'),
  };
}

// Visible width: escape codes take no room.
export const width = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

// A 5-pixel-tall lowercase face, just for the name.
const FONT = {
  h: ['#...', '#...', '###.', '#..#', '#..#'], o: ['....', '.##.', '#..#', '#..#', '.##.'], u: ['....', '#..#', '#..#', '#..#', '.###'],
  s: ['....', '.###', '##..', '..##', '###.'], e: ['....', '.##.', '####', '#...', '.###'], i: ['#', '.', '#', '#', '#'],
  t: ['.#..', '####', '.#..', '.#..', '..##'], r: ['....', '#.##', '##..', '#...', '#...'],
};

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const ramp = (t) => (t < 0.5 ? mix(PALETTE.night, PALETTE.dusk, t * 2) : mix(PALETTE.dusk, PALETTE.lamp, (t - 0.5) * 2));

// "housesitter" in pixels, night blue to porch-lamp amber, three lines tall.
export function wordmark(p, word = 'housesitter') {
  const cols = [];
  for (const ch of word) { const g = FONT[ch]; if (!g) continue; for (let x = 0; x < g[0].length; x++) cols.push(g.map((row) => row[x] === '#')); cols.push([0, 0, 0, 0, 0].map(() => false)); }
  cols.pop();
  if (!p.color) return [word];
  const lines = [];
  for (let y = 0; y < 6; y += 2) {
    let line = '';
    cols.forEach((c, x) => {
      const top = c[y], bot = y + 1 < 5 && c[y + 1];
      const rgb = ramp(x / (cols.length - 1));
      line += top && bot ? p.fg(rgb, '█') : top ? p.fg(rgb, '▀') : bot ? p.fg(rgb, '▄') : ' ';
    });
    lines.push(line);
  }
  return lines;
}

// The glimpse: { w, h, rgb (base64 rgb24) } -> lines of w characters, h/2 tall, framed.
export function glimpse(p, g, { title = '', note = '' } = {}) {
  const w = g?.w || 40, h = g?.h || 22;
  const rows = Math.ceil(h / 2);
  const top = `╭${title ? `─ ${title} ` : ''}${'─'.repeat(Math.max(0, w - (title ? title.length + 3 : 0)))}╮`;
  const out = [p.dim(top)];
  const px = g?.rgb ? Buffer.from(g.rgb, 'base64') : null;
  const at = (x, y) => (px && y < h ? [px[(y * w + x) * 3], px[(y * w + x) * 3 + 1], px[(y * w + x) * 3 + 2]] : null);
  const SHADES = ' .:-=+*#%@';
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let x = 0; x < w; x++) {
      const a = at(x, r * 2), b = at(x, r * 2 + 1) || a;
      if (!a) { line += note ? p.fg([41, 46, 66], (x + r) % 2 ? '·' : ' ') : ' '; continue; }
      if (p.color) line += `${ESC}38;2;${a.join(';')}m${ESC}48;2;${b.join(';')}m▀`;
      else { const l = (a[0] + a[1] + a[2] + b[0] + b[1] + b[2]) / 6; line += SHADES[Math.min(9, Math.floor(l / 25.6))]; }
    }
    out.push(`${p.dim('│')}${line}${p.color ? `${ESC}0m` : ''}${p.dim('│')}`);
  }
  out.push(p.dim(`╰${'─'.repeat(w)}╯`));
  if (!px) {
    const t = ` ${note || 'no picture yet'} `;
    const left = Math.max(0, Math.floor((w - t.length) / 2));
    out.splice(1 + Math.floor(rows / 2), 1, `${p.dim('│')}${' '.repeat(left)}${p.dim(t)}${' '.repeat(Math.max(0, w - left - t.length))}${p.dim('│')}`);
  }
  return out;
}

// Two columns side by side: left lines (fixed width) and right lines.
export function beside(left, right, gap = 3) {
  const lw = Math.max(0, ...left.map(width));
  const n = Math.max(left.length, right.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${pad(left[i] || '', lw)}${' '.repeat(gap)}${right[i] || ''}`.trimEnd());
  return out;
}

// Labelled rows: [{ label, items: [{ dot, text }] }] -> lines, the label column 14 wide.
export function rows(p, sections, { labelWidth = 14 } = {}) {
  const out = [];
  for (const s of sections) {
    (s.items.length ? s.items : [{ dot: 'off', text: '' }]).forEach((it, i) => {
      const label = i === 0 ? p.label(s.label) : '';
      out.push(`${pad(label, labelWidth)}${it.dot ? `${p.dot(it.dot)} ` : '  '}${it.text}`);
    });
  }
  return out;
}

export function clock(ms, now = Date.now()) {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return Math.abs(now - ms) < 20 * 3600000 ? hm : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
}

export function age(ms) {
  // Rounded down: doctor says "for at least …", and 92 minutes is not "2 h".
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.floor(s / 60)} min`;
  if (s < 36000) return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ''}`;
  if (s < 172800) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} days`;
}
