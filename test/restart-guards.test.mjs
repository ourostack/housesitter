// A restart of the Copilot app must lose nothing: every thing that lives only in the app's memory holds it back, and what is on
// disk is compared before and after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openRequests, backgroundOf, liveQueued, draftText, tabDrafts, staleQueued, holds, compareStates, gitState, FRESH_MS } from '../src/restart-guards.mjs';
import { pass } from '../src/app-bloat.mjs';

const ev = (type, data = {}, extra = {}) => JSON.stringify({ type, data, timestamp: '2026-11-18T10:00:00Z', id: Math.random().toString(36), ...extra });
const NOW = Date.parse('2026-11-19T02:00:00Z');
const SID = '34c6f98e-cbf9-44e5-ae9a-d0c524a64f08';
const clean = { sessions: [{ id: SID, title: 't', hist: { open: { waits: [], tools: [] }, background: [] } }], queued: [], drafts: [], automations: [], now: NOW };
const only = (inv) => holds({ ...clean, ...inv }).map((h) => h.guard);

test('a clean inventory holds nothing', () => assert.deepEqual(holds(clean), []));

test('a tool call in flight is seen even when the busy flag is not', () => {
  const l = [ev('session.start'), ev('tool.execution_start', { toolCallId: 'a', toolName: 'bash' })];
  assert.deepEqual(openRequests(l).tools, ['bash']);
  assert.deepEqual(openRequests([...l, ev('tool.execution_complete', { toolCallId: 'a' })]).tools, []);
  assert.deepEqual(only({ sessions: [{ id: SID, hist: { open: openRequests(l), background: [] } }] }), ['mid-tool']);
});

test('an unanswered ask_user, plan or permission wait holds, and answering it releases', () => {
  for (const t of ['user_input', 'exit_plan_mode', 'permission', 'elicitation']) {
    const l = [ev(`${t}.requested`, { requestId: 'r1' })];
    assert.equal(openRequests(l).waits.length, 1, t);
    assert.equal(openRequests([...l, ev(`${t}.completed`, { requestId: 'r1' })]).waits.length, 0, t);
  }
  assert.deepEqual(openRequests([ev('tool.execution_start', { toolCallId: 'x', toolName: 'ask_user' })]).waits, ['ask_user']);
  assert.deepEqual(only({ sessions: [{ id: SID, hist: { open: { waits: ['ask_user'], tools: [] }, background: [] } }] }), ['awaiting']);
});

test('a stop, a shutdown or a resume closes what was open before it', () => {
  const open = ev('tool.execution_start', { toolCallId: 'a', toolName: 'bash' });
  for (const end of [ev('abort', { reason: 'user_initiated' }), ev('session.shutdown'), ev('session.resume')]) assert.deepEqual(openRequests([open, end]).tools, []);
});

test('a background shell or agent a session owns holds the restart', () => {
  const l = [ev('session.start'), ev('tool.execution_start', { toolCallId: 'b', toolName: 'bash', arguments: { mode: 'async', shellId: 'dev', description: 'dev server' } }),
    ev('tool.execution_complete', { toolCallId: 'b', result: 'shellId: dev' }), ev('assistant.message', { toolRequests: [] }), ev('assistant.turn_end')];
  assert.deepEqual(backgroundOf(l), ['shell "dev server"']);
  assert.deepEqual(only({ sessions: [{ id: SID, hist: { open: { waits: [], tools: [] }, background: backgroundOf(l) } }] }), ['background']);
  assert.deepEqual(backgroundOf([...l, ev('system.notification', { kind: { shellId: 'dev' } })]), []);
});

test('a queued message holds while it is fresh; an old durable one does not hold forever', () => {
  const q = (createdAt) => ({ key: `session-queued-restart-recovery-durable:${SID}:main`, value: JSON.stringify({ messages: [{ text: 'hi', createdAt }] }) });
  assert.equal(liveQueued(q(new Date(NOW - 60000).toISOString()).value, NOW), 1);
  assert.deepEqual(only({ queued: [q(new Date(NOW - 60000).toISOString())] }), ['queue']);
  assert.deepEqual(only({ queued: [q(new Date(NOW - FRESH_MS - 1000).toISOString())] }), []);
  assert.equal(liveQueued(JSON.stringify({ messages: [] }), NOW), 0);
});

test('an unsent composer draft holds; an empty one does not', () => {
  const d = (text) => ({ key: `session-composer-draft:${SID}`, value: JSON.stringify({ state: { promptText: text }, version: 1 }) });
  assert.equal(draftText(d('  ').value), '');
  assert.deepEqual(only({ drafts: [d('half a thought')] }), ['draft']);
  assert.deepEqual(only({ drafts: [d('')] }), []);
});

test('a schedule due now or within minutes holds; a paused or distant one does not', () => {
  const a = (min, paused = false) => ({ id: 'a1', session_id: SID, next_run_at: new Date(NOW + min * 60000).toISOString(), paused });
  assert.deepEqual(only({ automations: [a(1)] }), ['automation']);
  assert.deepEqual(only({ automations: [a(-1)] }), ['automation']);
  assert.deepEqual(only({ automations: [a(1, true)] }), []);
  assert.deepEqual(only({ automations: [a(30)] }), []);
});

test('anything unreadable holds the restart', () => {
  for (const k of ['queued', 'drafts', 'automations']) assert.deepEqual(only({ [k]: null }), ['unreadable'], k);
  assert.deepEqual(only({ sessions: [{ id: SID, hist: null }] }), ['unreadable']);
});

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
test('uncommitted and untracked files and the branch are compared before and after', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-g-'));
  try {
    git(d, 'init', '-q', '-b', 'work'); git(d, 'config', 'user.email', 'a@b'); git(d, 'config', 'user.name', 'a');
    fs.writeFileSync(path.join(d, 'a.txt'), '1'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'one');
    fs.writeFileSync(path.join(d, 'a.txt'), '2'); fs.writeFileSync(path.join(d, 'new.txt'), 'x');
    const b = gitState(d);
    assert.equal(b.branch, 'work'); assert.equal(b.files, 2);
    assert.deepEqual(gitState(d), b);
    const st = (tree) => ({ sessions: [{ id: SID, title: 't', mode: 'autopilot' }], trees: { [SID]: tree }, automations: [] });
    assert.equal(compareStates(st(b), st(gitState(d))).ok, true);
    fs.unlinkSync(path.join(d, 'new.txt'));
    assert.equal(compareStates(st(b), st(gitState(d))).problems[0].what, 'files-changed');
    assert.equal(gitState(path.join(d, 'nope')), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('after a restart a missing session, a lost branch or an unarmed schedule is reported', () => {
  const before = { sessions: [{ id: SID, title: 't', mode: 'plan' }, { id: 'b'.repeat(8), title: 'u', mode: null }], trees: { [SID]: { path: '/x', branch: 'w', status: 's' } }, automations: [{ id: 'au', paused: false, next_run_at: 'z' }, { id: 'ap', paused: false, next_run_at: 'z' }] };
  const after = { sessions: [{ id: SID, title: 't', mode: 'plan' }], trees: { [SID]: { path: '/x', branch: 'other', status: 's' } }, automations: [{ id: 'au', paused: false, next_run_at: null }] };
  assert.deepEqual(compareStates(before, after).problems.map((p) => p.what), ['session-missing', 'branch-changed', 'schedule-unarmed', 'schedule-missing']);
  assert.equal(compareStates(before, before).ok, true);
});

const mk = (o = {}) => {
  let st = null; let now = 1e12; const calls = [];
  return { calls, tick: (ms) => { now += ms; }, d: { now: () => now, cfg: () => ({}), webMb: () => ({ mb: 11000, pids: [5] }), idleMs: () => 3e6, busy: async () => 0, restarting: () => false, guards: async () => [], snapshot: async () => ({ sessions: [{ id: SID, title: 't', mode: null }], trees: {}, automations: [] }),
    detach: async (w) => { calls.push(w); return { ok: true, log: 'l' }; }, readState: () => st, writeState: (x) => { st = x; }, ...o } };
};

test('a guard holds the rule even when everything else says restart, and the reason is recorded', async () => {
  const { calls, d } = mk({ guards: async () => [{ guard: 'draft', session: SID, why: 'an unsent composer draft' }] });
  const r = await pass({}, d);
  assert.equal(r.action, 'held');
  assert.match(r.why, /guard.*draft/);
  assert.equal(calls.length, 0);
  assert.equal((await pass({ dry_run: true }, d)).action, 'held');
});

test('a guard that cannot be read holds the restart', async () => {
  const { calls, d } = mk({ guards: async () => { throw new Error('boom'); } });
  assert.equal((await pass({}, d)).action, 'held');
  assert.equal(calls.length, 0);
});

test('a restart records what was there, and the next calm pass verifies it', async () => {
  const { calls, tick, d } = mk();
  assert.equal((await pass({}, d)).action, 'restarted');
  assert.equal(calls.length, 1);
  assert.equal(d.readState().before.sessions.length, 1);
  tick(60_000);
  await pass({}, d);
  assert.equal(d.readState().verified, undefined, 'not before the app has had time to resume');
  tick(6 * 60_000);
  await pass({}, d);
  const v = d.readState().verified;
  assert.equal(v.ok, true);
  assert.equal(v.sessions_after, 1);
  assert.equal(d.readState().before.sessions.length, 1, 'the record survives later passes');
});

test('a session that does not come back is recorded as a failed verification', async () => {
  let n = 0;
  const { tick, d } = mk({ snapshot: async () => ({ sessions: n++ === 0 ? [{ id: SID, title: 't', mode: null }] : [], trees: {}, automations: [] }) });
  await pass({}, d);
  tick(6 * 60_000);
  await pass({}, d);
  const v = d.readState().verified;
  assert.equal(v.ok, false);
  assert.equal(v.problems[0].what, 'session-missing');
});

test('a dry run records nothing and starts nothing', async () => {
  const { calls, d } = mk();
  assert.equal((await pass({ dry_run: true }, d)).action, 'would-restart');
  assert.equal(calls.length, 0);
  assert.equal(d.readState(), null);
});

test('per-session drafts inside workspace-tabs are drafts; empty ones are not', () => {
  const tabs = { key: 'workspace-tabs', value: JSON.stringify({ state: { workspaceSessions: {
    'aaaaaaaa-1111-2222-3333-444444444444': { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', draftPrompt: 'otherwise, half a thought', draftAttachments: [] },
    'bbbbbbbb-1111-2222-3333-444444444444': { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', draftPrompt: '  ', draftAttachments: [] },
    'cccccccc-1111-2222-3333-444444444444': { sessionId: 'cccccccc-1111-2222-3333-444444444444', draftPrompt: '', draftAttachments: [{ name: 'shot.png' }] },
  } }, version: 5 }) };
  const d = tabDrafts([tabs, { key: 'other', value: '{}' }]);
  assert.deepEqual(d.map((x) => x.key.slice(-36, -28)), ['aaaaaaaa', 'cccccccc']);
  const h = holds({ sessions: [], queued: [], drafts: d, automations: [], now: 0 });
  assert.deepEqual(h.map((x) => [x.guard, x.session?.slice(0, 8)]), [['draft', 'aaaaaaaa'], ['draft', 'cccccccc']], 'the restart holds for them');
});

test('a queued message still undelivered a day after it was typed is stale; a fresh one is not', () => {
  const now = Date.parse('2026-11-19T05:00:00Z');
  const rows = [{ key: 'session-queued-restart-recovery:34c6f98e-cbf9-44e5-ae9a-d0c524a64f08:main', value: JSON.stringify({ messages: [
    { text: 'was not me!!!', createdAt: '2026-11-12T21:31:55.895Z', messageId: 'm1' },
    { text: 'just now', createdAt: '2026-11-19T04:50:00Z', messageId: 'm2' },
  ] }) }, { key: 'session-queued-restart-recovery-steering-cancellations', value: '{}' }];
  assert.deepEqual(staleQueued(rows, now), [{ session: '34c6f98e-cbf9-44e5-ae9a-d0c524a64f08', id: 'm1', createdAt: '2026-11-12T21:31:55.895Z', text: 'was not me!!!' }]);
});
