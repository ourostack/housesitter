// Is the app frozen? Judged only by what the sessions do: the app says several are working, and not one of them has
// written an event for a long while. The socket, the window and the CPU say nothing here: under memory pressure all
// three are slow while the sessions carry on.
export const PROGRESS = {
  silentMs: 10 * 60000, // no session wrote anything for this long (the longest quiet stretch seen on a bad day, 2026-11-15, was 191 s)
  minWorking: 3, // working sessions needed before silence means anything
  recentMs: 90 * 60000, // a "working" session quiet for longer than this was already stuck, and is left out
  hookMs: 5 * 60000, // a hook its session started this long ago and never ended (hooks time out in seconds): the runtime is stuck
  minHung: 3, // sessions stuck in a hook needed to call it a freeze
};

// Hooks that legitimately wait: a permission request waits for a person, and a session's end hook is never closed.
const WAITING_HOOKS = new Set(['permissionRequest', 'sessionEnd']);

// `sessions`: [{ id, running, lastEventAt, lastType?, hookType? }] for every session the app lists. Returns whether the app
// looks frozen. Two ways: every session has gone silent, or several are stuck inside a hook. The second catches the freeze of
// 2026-11-19, when memory ran out and 21 sessions each stopped at a `hook.start` (a 5-second curl) for 50 minutes while two
// sessions waiting on their shells still wrote now and then, which hid the freeze from the first test.
// `blind`: the app lists running sessions but none has a history that could be read, so progress cannot be judged at all.
export function judgeProgress(sessions, now, t = PROGRESS) {
  const working = sessions.filter((s) => s.running && s.lastEventAt && now - s.lastEventAt <= t.recentMs);
  const newest = sessions.reduce((m, s) => Math.max(m, s.lastEventAt || 0), 0);
  const silent = newest ? now - newest : Infinity;
  const hung = working.filter((s) => s.lastType === 'hook.start' && !WAITING_HOOKS.has(s.hookType) && now - s.lastEventAt >= (t.hookMs ?? PROGRESS.hookMs));
  const quiet = working.length >= t.minWorking && silent >= t.silentMs;
  const stuckInHooks = hung.length >= (t.minHung ?? PROGRESS.minHung);
  const running = sessions.filter((s) => s.running).length;
  return {
    stalled: quiet || stuckInHooks, working: working.length, silentMs: Number.isFinite(silent) ? silent : null,
    hung: hung.map((s) => s.id), ...(stuckInHooks && !quiet ? { why: `${hung.length} sessions stuck in a hook` } : {}),
    blind: running >= t.minWorking && !newest,
  };
}

// The last event of a history: its type, and for a hook its kind. Reads only the file's tail; a last line longer than the tail
// (a hook.start carries its tool's arguments) still starts with its type when it fits, and is unknown otherwise.
export function lastEvent(text) {
  const line = text.trimEnd().split('\n').pop() || '';
  const type = /^\{"type":"([^"]+)"/.exec(line)?.[1] || null;
  const hookType = type === 'hook.start' ? /"hookType":"([^"]+)"/.exec(line)?.[1] || null : null;
  return { lastType: type, hookType };
}
