// What the sitter makes of a decoded frame, in Node: the same rules as device/sitter.py (classify_frame, prompt_match),
// so `housesitter demo` and `doctor` read a frame exactly as the sitter on the KVM does. test/parity.test.mjs holds
// the two together on real frames.

export const BOOT = { desktop_edges: 40, black_mean: 10 };
export const PROMPT_SEEN_LUMA = 160;
export const PROMPT_RECALL = 0.9;
export const PROMPT_MIN_POINTS = 20;

// A frame's features: { mean, top_edges } (and lum, a Buffer of the prompt grid, when there is one).
export function classifyFrame(f, cfg = BOOT) {
  if (!f) return 'none';
  if (f.mean < cfg.black_mean) return 'black';
  if (f.top_edges >= cfg.desktop_edges) return 'desktop';
  return 'prompt_like';
}

export function promptMatch(points, lum) {
  if (!lum || !points || points.length < PROMPT_MIN_POINTS) return 0;
  let n = 0;
  for (const i of points) if (i < lum.length && lum[i] >= PROMPT_SEEN_LUMA) n++;
  return n / points.length;
}

// { visible, match } for a frame against the taught prompts (each a list of grid points).
export function promptSeen(f, refs = []) {
  if (classifyFrame(f) !== 'prompt_like' || !f.lum) return { visible: false, match: 0, taught: refs.length };
  const match = Math.max(0, ...refs.map((p) => promptMatch(p, f.lum)));
  return { visible: match >= PROMPT_RECALL, match: Math.round(match * 1000) / 1000, taught: refs.length };
}

// The sitter's own words for what a frame is.
export function readsAs(kind, seen) {
  if (kind === 'desktop') return 'a desktop: a menu bar, top left';
  if (kind === 'black') return 'black: asleep, off, or no picture';
  if (kind === 'none') return 'nothing: no frame decoded';
  if (seen?.visible) return 'a password prompt it was taught';
  return seen?.taught ? 'no menu bar, and not the taught prompt' : 'no menu bar (no prompt taught yet)';
}
