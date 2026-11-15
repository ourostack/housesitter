// A session whose history is over the cap is never resumed or re-sent a resume by any housesitter path: it is logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HISTORY_BYTES, pickTargets, resumeAfter, snapshot } from '../src/copilot-app.mjs';
import { pass } from '../src/health-watch.mjs';

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

test('snapshot marks an over-cap history as never-resume, with the reason', async () => {
  const s = await snapshot(mkDeps());
  const big = s.find((x) => x.id === BIG);
  assert.equal(big.state, 'idle');
  assert.match(big.why, /500 MB resume cap/);
  assert.equal(s.find((x) => x.id === SMALL).state, 'busy');
});

test('resumeAfter does not resume an over-cap session, even when named with --also, and records it', async () => {
  const d = mkDeps();
  d.send = async (id) => { d.sent.push(id); return { ok: true, reply: 'ok' }; };
  const lines = [];
  const before = await snapshot(d);
  const res = await resumeAfter({ before: before.map((s) => ({ ...s, state: 'busy' })), opts: { also: [BIG] }, startedAt: 0, restartedAt: 0, t: { grace: 0, concurrency: 1, delivery: 10, retry: 1, tries: 1 } }, d, (l) => lines.push(l)).catch(() => []);
  assert.ok(!d.sent.includes(BIG));
  assert.deepEqual(d.held.map((h) => h.id), [BIG]);
  assert.ok(lines.some((l) => /NOT resumed.*hand-off/.test(l)));
  void res; void pickTargets;
});

test('the health watch does not re-send a resume to an over-cap session', async () => {
  const d = mkDeps();
  const now = Date.now();
  let st = { roster: { source: 's', since: now - 3600000, at: now - 3600000, why: 'x', begun: new Date(now).toISOString(), until: new Date(now + 3600000).toISOString(), told: [], sessions: { [BIG]: { title: 'big', status: 'pending' } } } };
  Object.assign(d, { state: '/nonexistent', readState: () => st, writeState: (o) => { st = o; }, rows: async () => [{ id: BIG }], tell: async () => ({ ok: true }), exchange: async () => { d.sent.push('x'); return []; } });
  const logs = [];
  await pass({}, d, (l) => logs.push(l));
  assert.equal(st.roster.sessions[BIG].status, 'oversize');
  assert.deepEqual(d.sent, []);
});
