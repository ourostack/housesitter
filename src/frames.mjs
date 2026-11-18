// What the sitter makes of a decoded frame, in Node: the same rules as device/sitter.py (classify_frame, prompt_match),
// so `housesitter demo` and `doctor` read a frame exactly as the sitter on the KVM does. test/parity.test.mjs holds
// the two together on real frames.

export const BOOT = { desktop_edges: 40, black_mean: 10 };
export const PROMPT_SEEN_LUMA = 160;
export const PROMPT_RECALL = 0.9;
export const PROMPT_MIN_POINTS = 12;
// Two-sided: a frame bright nearly everywhere (white, grey, a bright app) never matches. See device/sitter.py.
export const PROMPT_MAX_BRIGHT = 0.15;
const LOCK_SHIFT = [0.012, 0.0456];

// A frame's features: { mean, top_edges } (and lum, a Buffer of the prompt grid, when there is one).
export function classifyFrame(f, cfg = BOOT) {
  if (!f) return 'none';
  if (f.mean < cfg.black_mean) return 'black';
  if (f.top_edges >= cfg.desktop_edges) return 'desktop';
  return 'prompt_like';
}

export function promptMatch(points, lum) {
  if (!lum || !points || points.length < PROMPT_MIN_POINTS) return 0;
  let bright = 0;
  for (const v of lum) if (v >= PROMPT_SEEN_LUMA) bright++;
  if (bright > PROMPT_MAX_BRIGHT * lum.length) return 0;
  let n = 0;
  for (const i of points) if (i < lum.length && lum[i] >= PROMPT_SEEN_LUMA) n++;
  return n / points.length;
}

// Signed edges in two operator-marked widgets; both must match at the same translation.
export function lockMatch(ref, lum, size) {
  const widgets = ref.widgets;
  if (ref.v !== 2 || !lum || !size || !ref.size || lum.length !== size[0] * size[1] || !widgets || widgets.length !== 2
    || new Set(widgets.map((w) => w.name)).size !== 2
    || !widgets.every((w) => ['field', 'hint'].includes(w.name))) return 0;
  const [gx, gy] = size;
  const [sx, sy] = ref.size;
  const index = (i) => Math.floor((Math.floor(i / sx) + 0.5) * gy / sy) * gx + Math.floor((i % sx + 0.5) * gx / sx);
  const mapped = widgets.map((w) => {
    const [x0, y0, x1, y1] = w.box;
    return {
      box: [Math.floor(x0 * gx / sx), Math.floor(y0 * gy / sy), Math.ceil(x1 * gx / sx), Math.ceil(y1 * gy / sy)],
      pairs: w.pairs.map(([i, j, sign]) => [index(i), index(j), sign]),
    };
  });
  const mx = Math.floor(gx * LOCK_SHIFT[0]), my = Math.floor(gy * LOCK_SHIFT[1]);
  let best = 0;
  for (let dy = -my; dy <= my; dy++) {
    for (let dx = -mx; dx <= mx; dx++) {
      let score = 1;
      for (const widget of mapped) {
        const [x0, y0, x1, y1] = widget.box;
        const pairs = widget.pairs;
        if (x0 + dx < 0 || y0 + dy < 0 || x1 + dx > gx || y1 + dy > gy || pairs.length < 24) {
          score = 0;
          break;
        }
        const off = dy * gx + dx;
        let missed = 0;
        for (const [i, j, sign] of pairs) {
          if (sign * (lum[i + off] - lum[j + off]) < 12 && ++missed > (1 - PROMPT_RECALL) * pairs.length) break;
        }
        score = Math.min(score, 1 - missed / pairs.length);
        if (score < PROMPT_RECALL) break;
      }
      best = Math.max(best, score);
    }
  }
  return best >= PROMPT_RECALL ? best : 0;
}

// { visible, match } for a frame against the taught prompts (each a list of grid points).
export function promptSeen(f, refs = []) {
  refs = refs.filter((r) => !r.kind || ['boot', 'lock'].includes(r.kind));
  const taught = refs.length;
  if (classifyFrame(f) !== 'prompt_like' || !f.lum) return { visible: false, match: 0, taught };
  if (refs.some((r) => r.kind === 'lock' && r.v === 2)) {
    refs = refs.filter((r) => r.kind === 'boot' || r.v === 2);
  }
  const match = Math.max(0, ...refs.map((r) => ('v' in r ? lockMatch(r, f.lockLum, f.size) : promptMatch(r.points || r, f.lum))));
  return { visible: match >= PROMPT_RECALL, match: Math.round(match * 1000) / 1000, taught };
}

// The sitter's own words for what a frame is.
export function readsAs(kind, seen) {
  if (kind === 'desktop') return 'a desktop: a menu bar, top left';
  if (kind === 'black') return 'black: asleep, off, or no picture';
  if (kind === 'none') return 'nothing: no frame decoded';
  if (seen?.visible) return 'the prompt it was taught';
  return seen?.taught ? 'no menu bar, and not the taught prompt' : 'no menu bar (no prompt taught yet)';
}
