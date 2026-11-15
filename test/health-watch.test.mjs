// housesitter restart-copilot --health-watch: after a restart, every resumed session is followed with plain checks, asked
// again once, and reported by name only if it stays broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { counts, diagnose, erroredSince, importRoster, pass, readRecovery, realHealthDeps, renderRecovery } from '../src/health-watch.mjs';
import { DONE, MID_TURN, haveSqlite, makeHome, startApp } from './fake_app.mjs';

const skip = !haveSqlite() || typeof WebSocket !== 'function';
const SCRATCH = path.join(path.dirname(new URL(import.meta.url).pathname), '.scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003', D = 'dddddddd-0000-4000-8000-000000000004', E = 'eeeeeeee-0000-4000-8000-000000000005';
const ev = (type, data = {}, at = Date.now()) => JSON.stringify({ type, data, timestamp: new Date(at).toISOString() });
const MIN = 60000;

test('erroredSince and diagnose: no turn, an error after the last turn, stuck busy and healthy are told apart', () => {
  const since = Date.parse('2026-11-15T12:00:00Z');
  const at = (m) => since + m * MIN;
  const turn = ev('assistant.turn_start', {}, at(2));
  const err = ev('session.error', { message: 'rate limited' }, at(3));
  const base = { since, now: at(30), mtime: at(29), row: { interrupted: 0 }, working: false };
  assert.equal(erroredSince([turn, err], since).message, 'rate limited');
  assert.equal(erroredSince([err, ev('assistant.turn_start', {}, at(4))], since), null, 'a turn after the error is a retry');
  assert.equal(diagnose({ ...base, lines: [turn] }), null);
  assert.equal(diagnose({ ...base, lines: [turn, err] }).kind, 'erroring');
  assert.equal(diagnose({ ...base, lines: [] }).kind, 'silent');
  assert.match(diagnose({ ...base, lines: [], row: { interrupted: 1 } }).why, /still flags it interrupted/);
  assert.equal(diagnose({ ...base, now: at(3), lines: [] }).kind, 'waiting', 'a session has 5 minutes to take a turn');
  assert.equal(diagnose({ ...base, now: at(200), mtime: at(60), working: true, lines: [turn] }).kind, 'stuck');
  assert.equal(diagnose({ ...base, now: at(200), mtime: at(190), working: true, lines: [turn] }), null, 'busy with recent steps is working');
  assert.equal(diagnose({ ...base, row: null, lines: [] }).kind, 'gone');
});

function world() {
  const home = fs.mkdtempSync(path.join(SCRATCH, 'hw-'));
  const root = fs.mkdtempSync(path.join(SCRATCH, 'hw-root-'));
  return { home, root, state: path.join(root, 'state'), told: [] };
}

test('importRoster: the newest record this watch has not followed, never an empty one', () => {
  const w = world();
  fs.mkdirSync(w.state, { recursive: true });
  const put = (f, o) => fs.writeFileSync(path.join(w.state, f), JSON.stringify(o));
  put('resume-only.json', { at: '2026-11-15T20:09:28Z', key: '1856:1794773144000', resumed: [{ id: A, title: 'a', outcome: 'resumed' }, { id: B, outcome: 'NOT RESUMED after 3 tries (socket_error)' }] });
  const r = importRoster(w.state, null);
  assert.equal(r.since, 1794773144000, 'it starts when the app process started');
  assert.equal(r.sessions.length, 2);
  assert.equal(importRoster(w.state, r), null, 'already followed');
  put('resume-only.json', { at: '2026-11-15T20:19:00Z', key: '1856:1794773144000', skipped: 'already resumed', resumed: [] });
  assert.equal(importRoster(w.state, r), null, 'an empty record starts nothing');
  put('resume-last.json', { at: '2026-11-15T20:09:28Z', key: '1856:1794773144000', resumed: [{ id: A, outcome: 'resumed' }] });
  assert.equal(importRoster(w.state, null).sessions[0].id, A, 'the last pass that resumed something is followed, not the later one that skipped');
  fs.rmSync(path.join(w.state, 'resume-last.json'));
  put('last.json', { started_at: '2026-11-15T20:30:00Z', restarted_at: '2026-11-15T20:32:00Z', kind: 'freeze', resume: [{ id: C, outcome: 'resumed' }] });
  const n = importRoster(w.state, r);
  assert.equal(n.why, 'a frozen window');
  assert.equal(n.sessions[0].id, C);
  fs.rmSync(w.root, { recursive: true, force: true }); fs.rmSync(w.home, { recursive: true, force: true });
});

test('a silent session is asked again once, then reported by name once; healthy ones are never mentioned', { skip }, async () => {
  const w = world();
  makeHome(w.home, [
    { id: A, title: 'took its turn', mode: 'autopilot', events: DONE },
    { id: B, title: 'never answers', mode: 'autopilot', ageMs: 3 * 3600000, events: MID_TURN },
    { id: C, title: 'errored out', mode: 'autopilot', events: DONE },
    { id: D, title: 'finished long ago', events: DONE },
  ]);
  const since = Date.now() - 12 * MIN;
  const app = await startApp(w.home, { drop: [B] });
  fs.appendFileSync(path.join(w.home, 'session-state', A, 'events.jsonl'), `${ev('assistant.turn_start', {}, since + 3 * MIN)}\n`);
  fs.appendFileSync(path.join(w.home, 'session-state', C, 'events.jsonl'), `${ev('assistant.turn_start', {}, since + 2 * MIN)}\n${ev('session.error', { message: 'model unavailable' }, since + 3 * MIN)}\n`);
  fs.appendFileSync(path.join(w.home, 'session-state', D, 'events.jsonl'), `${ev('assistant.turn_start', {}, since + 4 * MIN)}\n${ev('assistant.turn_end', {}, since + 5 * MIN)}\n`);
  fs.mkdirSync(w.state, { recursive: true });
  fs.writeFileSync(path.join(w.state, 'resume-only.json'), JSON.stringify({ at: new Date(since + MIN).toISOString(), key: `1:${since}`, resumed: [A, B, C, D].map((id) => ({ id, outcome: 'resumed' })) }));
  const d = realHealthDeps({ home: w.root, copilotHome: w.home, state: w.state });
  d.tell = async (t) => { w.told.push(t); return { ok: true }; };
  const lines = [];
  const opts = { t: { deliver: 3000 } };
  const r1 = await pass(opts, d, (l) => lines.push(l));
  assert.deepEqual(counts(r1.roster), { ok: 2, pending: 0, 'asked-again': 2, broken: 0, gone: 0 });
  assert.deepEqual(app.received.map((m) => m.id).sort(), [B, C], 'only the two with a problem are asked again');
  assert.match(app.received[0].prompt, /^The app was restarted at \d\d:\d\d for the app starting again \(this is a second message/);
  assert.deepEqual(w.told, [], 'asking again is not reported');
  // The second message has had its ten minutes and B still has not taken a turn.
  const st = d.readState();
  st.roster.sessions[B].resent = new Date(Date.now() - 11 * MIN).toISOString();
  st.roster.sessions[C].resent = new Date(Date.now() - 11 * MIN).toISOString();
  fs.appendFileSync(path.join(w.home, 'session-state', C, 'events.jsonl'), `${ev('assistant.turn_start', {}, Date.now())}\n`);
  d.writeState(st);
  const r2 = await pass(opts, d, (l) => lines.push(l));
  assert.equal(r2.roster.sessions[C].status, 'ok', 'C answered the second message');
  assert.equal(r2.roster.sessions[B].status, 'broken');
  assert.equal(w.told.length, 1);
  assert.match(w.told[0], /1 of 4 resumed sessions stayed broken even after I sent the resume a second time: "never answers" \(bbbbbbbb\): silent: no turn since the app came back.*the other 3 are fine\./);
  assert.equal(app.received.length, 2, 'it asks once, not forever');
  await pass(opts, d, (l) => lines.push(l));
  assert.equal(w.told.length, 1, 'told once');
  const text = renderRecovery(readRecovery(w.state));
  assert.match(text, /health watch: 4 session\(s\) resumed after the app starting again.*3 healthy, 0 waiting, 0 asked again, 1 BROKEN/);
  assert.match(text, /broken bbbbbbbb never answers: silent/);
  await new Promise((r) => setTimeout(r, 120));
  await app.close();
  fs.rmSync(w.root, { recursive: true, force: true }); fs.rmSync(w.home, { recursive: true, force: true });
});

test('a session busy with no step for 90 minutes is stuck; after the six hours the watch ends', { skip }, async () => {
  const w = world();
  makeHome(w.home, [{ id: E, title: 'stuck one', mode: 'autopilot', running: true, events: MID_TURN }]);
  const f = path.join(w.home, 'session-state', E, 'events.jsonl');
  const old = new Date(Date.now() - 3 * 3600000);
  fs.utimesSync(f, old, old);
  const since = Date.now() - 4 * 3600000;
  fs.writeFileSync(f, `${ev('user.message', {}, since + 1000)}\n${ev('assistant.turn_start', {}, since + 2000)}\n`);
  fs.utimesSync(f, old, old);
  const app = await startApp(w.home);
  fs.mkdirSync(w.state, { recursive: true });
  fs.writeFileSync(path.join(w.state, 'resume-only.json'), JSON.stringify({ at: new Date(since).toISOString(), key: `1:${since}`, resumed: [{ id: E, outcome: 'resumed' }] }));
  const d = realHealthDeps({ home: w.root, copilotHome: w.home, state: w.state });
  d.tell = async (t) => { w.told.push(t); return { ok: true }; };
  const r = await pass({ t: { deliver: 3000 } }, d);
  assert.match(r.roster.sessions[E].problem, /^stuck: busy, with no step in its history for 1\d\d min/);
  assert.equal(app.received.length, 1);
  const st = d.readState();
  st.roster.until = new Date(Date.now() - 1000).toISOString();
  d.writeState(st);
  assert.equal((await pass({ t: { deliver: 3000 } }, d)).action, 'finished');
  assert.equal(app.received.length, 1, 'nothing is sent after the six hours');
  await new Promise((r) => setTimeout(r, 120));
  await app.close();
  fs.rmSync(w.root, { recursive: true, force: true }); fs.rmSync(w.home, { recursive: true, force: true });
});
