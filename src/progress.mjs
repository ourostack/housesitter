// Is the app frozen? Judged only by what the sessions do: the app says several are working, and not one of them has
// written an event for a long while. The socket, the window and the CPU say nothing here: under memory pressure all
// three are slow while the sessions carry on.
export const PROGRESS = {
  silentMs: 10 * 60000, // no session wrote anything for this long (the longest quiet stretch seen on a bad day, 2026-11-15, was 191 s)
  minWorking: 3, // working sessions needed before silence means anything
  recentMs: 90 * 60000, // a "working" session quiet for longer than this was already stuck, and is left out
};

// `sessions`: [{ id, running, lastEventAt }] for every session the app lists. Returns whether the app looks frozen.
export function judgeProgress(sessions, now, t = PROGRESS) {
  const working = sessions.filter((s) => s.running && s.lastEventAt && now - s.lastEventAt <= t.recentMs);
  const newest = sessions.reduce((m, s) => Math.max(m, s.lastEventAt || 0), 0);
  const silent = newest ? now - newest : Infinity;
  const stalled = working.length >= t.minWorking && silent >= t.silentMs;
  return { stalled, working: working.length, silentMs: Number.isFinite(silent) ? silent : null };
}
