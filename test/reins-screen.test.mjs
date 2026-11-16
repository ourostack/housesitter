// The screen `ls` returns follows the Reins protocol's section 1: focus, path, state, context and the actions accepted now,
// each {name, title, input?, from}. Checked on a healthy KVM and on a sitter that can type the password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/reins.mjs';

const kvm = { video: { online: true }, hid: { keyboard_online: true } };

test('ls: the screen has the protocol fields, and each action names its title and the node that offers it', () => {
  const scr = R.screen('studio', { kvm, sitter: { state: 'filevault', can: { unlock: true } } });
  assert.equal(scr.focus, 'studio');
  assert.deepEqual(scr.path, ['studio']);
  assert.deepEqual(scr.context, {});
  assert.ok(scr.state && 'kvm' in scr.state && 'sitter' in scr.state);
  assert.ok(scr.actions.length > 0);
  for (const a of scr.actions) {
    assert.equal(typeof a.name, 'string');
    assert.equal(typeof a.title, 'string');
    assert.equal(a.from, 'studio');
  }
  assert.equal(scr.actions.find((a) => a.name === 'want_desktop') === undefined, true, 'offered only when the lock policy allows it');
});

test('ls: an action that takes no input has no input schema, and do refuses input it does not take', async () => {
  const scr = R.screen('studio', { kvm, sitter: { state: 'filevault', can: { unlock: true } } });
  const unlock = scr.actions.find((a) => a.name === 'unlock');
  assert.equal(unlock.title, 'Unlock');
  assert.equal('input' in unlock, false);
  const sitter = { op: async () => ({ ok: true, result: 'typed' }) };
  await assert.rejects(R.run('studio', 'unlock', { surprise: 1 }, { scr, hands: null, sitter }), (e) => e.code === 'input-invalid');
});
