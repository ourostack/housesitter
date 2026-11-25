// A small index over ~/.copilot/session-state (about 20,000 folders): what a full walk would find, kept between passes and
// re-read only for a folder that changed. A folder's key is the modification time of the folder and of the parts a session
// writes to (files/, images/, checkpoints/, events.jsonl(.gz), session.db) with their sizes; while the key is the same, the
// size and the "quiet for N" answer from the last walk stand. An entry older than `maxAge` is walked again, and a caller that
// is about to delete something asks the real filesystem first, so a stale entry can only delay a removal, never cause one.
import fs from 'node:fs';
import path from 'node:path';

const PARTS = ['', 'files', 'images', 'checkpoints', 'events.jsonl', 'events.jsonl.gz', 'session.db'];

const stampOf = (p) => {
  try { const s = fs.statSync(p); return `${Math.round(s.mtimeMs)}${s.isDirectory() ? '' : `:${s.size}`}`; } catch { return '-'; }
};
export const sessionKey = (dir) => PARTS.map((n) => stampOf(n ? path.join(dir, n) : dir)).join('|');

// `data` is the saved index (id -> { key, at, size?, heavy?, quietMs? }); `keyOf` and `now` are replaceable for tests.
export function sessionIndex({ data = {}, now = Date.now, maxAge = 7 * 24 * 3600000, keyOf = sessionKey } = {}) {
  const stats = { hits: 0, misses: 0 };
  let dirty = false;
  const entry = (id, dir) => {
    const key = keyOf(dir), e = data[id];
    if (e && e.key === key && now() - e.at < maxAge) { stats.hits++; return e; }
    stats.misses++; dirty = true;
    return (data[id] = { key, at: now() });
  };
  return {
    stats,
    // Bytes under `dir`, from `du(dir)` only when the folder changed.
    size(id, dir, du) { const e = entry(id, dir); if (e.size == null) { e.size = du(dir); dirty = true; } return e.size; },
    // Bytes in the named parts of the folder (the ones that exist).
    heavy(id, dir, parts, du) {
      const e = entry(id, dir);
      if (e.heavy == null) { e.heavy = parts.map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p)).reduce((a, p) => a + du(p), 0); dirty = true; }
      return e.heavy;
    },
    // True when nothing under `dir` changed for `ms`: `find(dir, ms)` runs only when the folder changed since a walk said so.
    quiet(id, dir, ms, find) {
      const e = entry(id, dir);
      if (e.quietMs >= ms) return true;
      const q = find(dir, ms);
      if (q) { e.quietMs = ms; dirty = true; }
      return q;
    },
    // Forget folders that are gone.
    prune(ids) { for (const id of Object.keys(data)) if (!ids.has(id)) { delete data[id]; dirty = true; } },
    dirty: () => dirty,
    data: () => data,
  };
}
