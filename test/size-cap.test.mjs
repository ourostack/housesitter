// A session whose history is over the cap is never resumed or re-sent a resume by any housesitter path: it is logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HISTORY_BYTES, resumeAfter, snapshot } from '../src/copilot-app.mjs';

const BIG = 'aaaaaaaa-0000-4000-8000-000000000001', SMALL = 'bbbbbbbb-0000-4000-8000-000000000002';
const MID = [JSON.stringify({ type: 'user.message', data: {}, timestamp: new Date().toISOString() }), JSON.stringify({ type: 'assistant.turn_start', data: {}, timestamp: new Date().toISOString() })];
const mkDeps = () => {
  const sent = [], held = [];
  return {
    sent, held,
    now: () => Date.now(),
    sleep: async () => {},
    sql: async () => [{ id: BIG, title: 'big', running: 1 }, { id: SMALL, title: 'small', running: 1 }],
    historySize: (id) => (id === BIG ? MAX_HISTORY_BYTES + 1 : 1000),
    history: () => ({ lines: MID, mtime: Date.now() }),
    heldBack: (l) => held.push(...l),
  };
};

test('resumeAfter does not resume an over-cap session, even when named with --also, and records it', async () => {
  const d = mkDeps();
  d.send = async (id) => { d.sent.push(id); return { ok: true, reply: 'ok' }; };
  const lines = [];
  const before = await snapshot(d);
  const res = await resumeAfter({ before: before.map((s) => ({ ...s, state: 'busy' })), opts: { also: [BIG] }, startedAt: 0, restartedAt: 0, t: { grace: 0, concurrency: 1, delivery: 10, retry: 1, tries: 1 } }, d, (l) => lines.push(l)).catch(() => []);
  assert.ok(!d.sent.includes(BIG));
  assert.deepEqual(d.held.map((h) => h.id), [BIG]);
  assert.ok(lines.some((l) => /NOT resumed.*hand-off/.test(l)));
  void res;
});

