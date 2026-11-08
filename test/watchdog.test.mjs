// The rules, against the shared scenarios that device/sitter.py also runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as W from '../src/watchdog.mjs';

const CASES = JSON.parse(fs.readFileSync(new URL('../spec/watchdog-cases.json', import.meta.url), 'utf8'));

export function play(sc) {
  let mem = null;
  const ledger = [];
  const got = [];
  for (const st of sc.steps) {
    const now = st.t * 60000;
    const r = W.tick(mem, ledger, st.obs, now, sc.caps);
    mem = r.mem;
    for (const a of r.actions) {
      if (a.kind === 'wait') continue;
      ledger.push({ at: now, kind: a.kind, state: mem.state });
      if (a.kind === 'notify' && mem.incident) mem.incident.notified_at = now;
    }
    got.push({ t: st.t, state: mem.state, actions: r.actions.map((a) => a.kind) });
  }
  return got;
}

for (const sc of CASES.scenarios) {
  test(`watchdog: ${sc.name}`, () => {
    const got = play(sc);
    sc.steps.forEach((st, i) => {
      assert.equal(got[i].state, st.state, `t=${st.t} state (got ${JSON.stringify(got[i])})`);
      assert.deepEqual(got[i].actions, st.actions, `t=${st.t} actions (got ${JSON.stringify(got[i])})`);
    });
  });
}

test('message: says what, since when, why it is stuck and where to look; no nulls', () => {
  const m = W.message('studio', { state: 'filevault', since: 0 }, { kind: 'notify', why: 'unlock failed twice (housesitter adopt <mac>)' }, { screen: 'filevault', video: true, answers: null });
  assert.equal(m.subject, 'studio is stuck at FileVault');
  assert.match(m.body, /housesitter adopt studio/);
  assert.match(m.body, /screen=filevault/);
  assert.doesNotMatch(m.body, /answers=null/);
  assert.equal(W.message('studio', { since: 0 }, { recovered: true }, {}).subject, 'studio is back');
});
