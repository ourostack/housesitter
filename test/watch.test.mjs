// The Mac watches its KVM (housesitter watch-kvm): one message when the sitter goes silent, one when it's back, the
// email cap shared with the sitter. All fakes: a pretend sitter that answers or doesn't, a pretend ntfy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askRoutes, fresh, outboxAsk, plist, sendNtfy, stableNode, watchOnce } from '../src/watch.mjs';

const T0 = Date.UTC(2026, 10, 9, 9, 0);
const MIN = 60000;
const notify = { kind: 'ntfy', url: 'https://ntfy.sh/topic', email: 'ada@example.com' };

function world() {
  const w = { up: true, frozen: false, statusAt: T0, sent: [], asked: [], emailsToday: 0, merged: new Set() };
  w.ask = async (a) => {
    w.asked.push(a);
    if (!w.up) throw new Error('ssh: connect to host 192.168.1.50 port 22: Operation timed out');
    for (const e of a.sent) if (!w.merged.has(e.at)) { w.merged.add(e.at); if (e.emailed) w.emailsToday++; }
    return { status: { at: w.statusAt, interval_sec: 60, state: 'healthy' }, emails_today: w.emailsToday }; };
  w.send = async (title, body, { email }) => { w.sent.push({ title, body, email }); return { result: `posted 200${email ? ', emailed' : ''}`, emailed: Boolean(email) }; };
  return w;
}
async function run(w, minutes, opts = {}) {
  let state = opts.state || {};
  const said = [];
  for (let i = 0; i <= minutes; i++) {
    const now = (opts.start || T0) + i * MIN;
    if (opts.each) opts.each(w, i, now);
    if (w.up && !w.frozen) w.statusAt = now - 20000;
    const out = await watchOnce({ name: 'mini', by: 'aris-mac-mini', notify, ask: w.ask, send: w.send, state, now, silentMin: opts.silentMin ?? 5, test: opts.test });
    state = out.state;
    if (out.said) said.push([i, out.said]);
  }
  return { state, said };
}

test('a quiet KVM gets one message after 5 minutes, and one when it is back; never more', async () => {
  const w = world();
  const { said, state } = await run(w, 30, { each: (x, i) => { x.up = !(i >= 3 && i < 20); } });
  assert.deepEqual(said, [[8, 'silent'], [20, 'back']], 'silence counts from the first check that got no answer (minute 3)');
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[0].title, /^mini's KVM is silent$/);
  assert.match(w.sent[0].body, /aris-mac-mini, the Mac, hasn't heard from housesitter on its KVM for 5 min \(last heard at \d\d:\d\d\): no answer from the KVM\. Until it answers, nothing unlocks FileVault/);
  assert.match(w.sent[1].title, /^mini's KVM is back$/);
  assert.match(w.sent[1].body, /answers again, after about 17 min/);
  assert.equal(state.alerted_at, null);
});

test('a sitter that answers SSH but has stopped looking is silent too (a stale status)', async () => {
  const w = world();
  const { said } = await run(w, 12, { each: (x, i) => { x.frozen = i >= 2; } });
  assert.equal(fresh({ status: { at: T0, interval_sec: 60 } }, T0 + 4 * MIN).ok, false);
  assert.deepEqual(said, [[9, 'silent']], 'first stale at minute 4; alerted 5 minutes later');
});

test('--test marks both messages TEST in their first words', async () => {
  const w = world();
  await run(w, 12, { test: true, silentMin: 2, each: (x, i) => { x.up = !(i >= 1 && i < 6); } });
  assert.deepEqual(w.sent.map((m) => m.title), ["TEST: mini's KVM is silent", "TEST: mini's KVM is back"]);
  assert.match(w.sent[0].body, /^TEST \(housesitter watch-kvm --test; nothing is wrong\)\. /);
});

test('the daily email cap is shared: the sitter\'s count, plus what this Mac sent and has not yet handed over', async () => {
  const w = world();
  w.emailsToday = 4;
  const { state } = await run(w, 20, { each: (x, i) => { x.up = !(i >= 1 && i < 10); } });
  assert.equal(w.sent[0].email, 'ada@example.com', 'the 5th email of the day');
  assert.equal(w.sent[1].email, null, 'the sitter now counts 5: the back message is a push only');
  assert.equal(w.emailsToday, 5, 'the silent alert was handed to the sitter, once');
  assert.ok(state.sent.every((e) => e.reported), 'everything handed over');
});

test('while the KVM is silent, its own count is unknown: unreported emails still count', async () => {
  const w = world();
  w.emailsToday = 4;
  await run(w, 12, { silentMin: 1, each: (x, i) => { x.up = i < 1; } });
  assert.deepEqual(w.sent.map((m) => m.email), ['ada@example.com']);
});

test('ntfy from the Mac: the email and token ride together; a refused email still sends the push', async () => {
  const calls = [];
  const ok = async (url, o) => { calls.push(o.headers); return { ok: true, status: 200, json: async () => ({}) }; };
  assert.deepEqual(await sendNtfy(notify, 't', 'b', { email: 'ada@example.com', token: 'tk_x', fetchFn: ok }), { result: 'posted 200, emailed', emailed: true });
  assert.equal(calls[0].Authorization, 'Bearer tk_x');
  const refused = [];
  const no = async (url, o) => { refused.push(o.headers); return o.headers.Email ? { ok: false, status: 400, json: async () => ({ error: 'limit reached' }) } : { ok: true, status: 200 }; };
  const r = await sendNtfy(notify, 't', 'b', { email: 'ada@example.com', token: 'tk_x', fetchFn: no });
  assert.equal(r.emailed, false);
  assert.match(r.result, /ntfy wouldn't email: limit reached; a push only/);
  assert.equal(refused[1].Authorization, undefined);
});

test('the LaunchAgent runs watch-kvm --once every minute', () => {
  const x = plist({ name: 'mini', node: '/opt/homebrew/bin/node', bin: '/Users/a/housesitter/bin/housesitter.mjs', args: ['--silent-min', '5'], home: '/Users/a' });
  assert.match(x, /<string>bot\.ouro\.housesitter\.watch-kvm\.mini<\/string>/);
  assert.match(x, /<string>watch-kvm<\/string><string>mini<\/string><string>--once<\/string><string>--silent-min<\/string><string>5<\/string>/);
  assert.match(x, /<key>StartInterval<\/key><integer>60<\/integer>/);
});

test('a gap in the Mac\'s own checks (asleep, restarting) is not the KVM\'s silence', async () => {
  const w = world();
  w.up = false;
  const { said } = await run(w, 3, { state: { last_ok_at: T0 - 30 * MIN, last_check_at: T0 - 30 * MIN } });
  assert.deepEqual(said, [], 'the first failed checks after a 30-minute gap start a fresh count');
});

test('a failed alert is tried again next minute, and a "back" is sent only for an alert that got through', async () => {
  const w = world();
  let fail = 2;
  const send = w.send;
  w.send = async (...a) => { if (fail-- > 0) throw new Error('ntfy answered 502'); return send(...a); };
  const { said } = await run(w, 12, { silentMin: 2, each: (x, i) => { x.up = !(i >= 1 && i < 10); } });
  assert.deepEqual(said, [[5, 'silent'], [10, 'back']]);
  const quiet = world();
  quiet.send = async () => { throw new Error('offline'); };
  const r = await run(quiet, 8, { silentMin: 2, each: (x, i) => { x.up = !(i >= 1 && i < 6); } });
  assert.deepEqual(r.said, [], 'never delivered, so no back message either');
});

test('the LaunchAgent names a node that survives brew upgrade', () => {
  const has = (p) => p === '/opt/homebrew/bin/node';
  assert.equal(stableNode('/opt/homebrew/Cellar/node@22/22.23.4_2/bin/node', has), '/opt/homebrew/bin/node');
  assert.equal(stableNode('/Users/a/.nvm/versions/node/v22.1.0/bin/node', has), '/Users/a/.nvm/versions/node/v22.1.0/bin/node');
  assert.equal(stableNode('/opt/homebrew/Cellar/node/23.1/bin/node', () => false), '/opt/homebrew/Cellar/node/23.1/bin/node');
});

// Away from the KVM's network (the KVM at home, the Mac at the office), SSH can't reach the sitter: the watch reads the
// outbox gist the sitter publishes to, and asks it for a status through the inbox only when that copy is stale.
test('SSH unreachable: the watch hears the sitter through the outbox, and says which route answered', async () => {
  const ssh = { via: 'ssh 192.168.50.14', ask: async () => { throw new Error('ssh: connect to host 192.168.50.14 port 22: Operation timed out'); } };
  const outbox = { via: 'outbox', ask: outboxAsk({ readStatus: async () => ({ at: T0 - 20000, interval_sec: 60, state: 'healthy' }) }) };
  const ask = askRoutes([ssh, outbox]);
  const out = await watchOnce({ name: 'mini', by: 'Aris-MacBook-Pro', notify, ask, send: async () => assert.fail('nothing to say'), state: {}, now: T0 });
  assert.equal(out.ok, true);
  assert.equal(out.state.last_via, 'outbox');
});

test('over the outbox, a copy published within one beat (10 min) plus a look is fresh; older is silence', async () => {
  const ask = (age) => askRoutes([{ via: 'outbox', ask: outboxAsk({ readStatus: async () => ({ at: T0 - age, interval_sec: 60 }) }) }]);
  const ok = await watchOnce({ name: 'mini', by: 'x', notify, ask: ask(9 * MIN), send: async () => assert.fail('nothing to say'), state: {}, now: T0 });
  assert.equal(ok.ok, true);
  const old = await watchOnce({ name: 'mini', by: 'x', notify, ask: ask(12 * MIN), send: async () => ({ result: 'posted', emailed: false }), state: {}, now: T0 });
  assert.equal(old.ok, false);
});

test('the outbox route that gets no answer is an error, so silence still counts', async () => {
  const ask = askRoutes([
    { via: 'ssh', ask: async () => { throw new Error('timed out'); } },
    { via: 'outbox', ask: outboxAsk({ readStatus: async () => null }) },
  ]);
  await assert.rejects(ask({ by: 'x', sent: [] }), (e) => /ssh: timed out/.test(e.message) && /outbox: nothing published/.test(e.message));
  const out = await watchOnce({ name: 'mini', by: 'x', notify, ask, send: async () => ({ result: 'posted', emailed: false }), state: {}, now: T0 });
  assert.equal(out.ok, false);
  assert.match(out.state.last_error, /outbox: nothing published/);
});

test('SSH first: when it answers, the outbox is never asked', async () => {
  const ask = askRoutes([
    { via: 'ssh', ask: async () => ({ status: { at: T0, interval_sec: 60 } }) },
    { via: 'outbox', ask: async () => assert.fail('outbox asked while SSH answers') },
  ]);
  const a = await ask({ by: 'x', sent: [] });
  assert.equal(a.via, 'ssh');
});
