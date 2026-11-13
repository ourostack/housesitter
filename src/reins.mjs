// The Mac as one Reins screen: `housesitter ls <mac>` and `housesitter do <mac> <action> '<json>'`.
// Same shape as Ouro Reins (ourostack/ouro-ui-apple): the state, and only the actions available right now, each
// with a JSON Schema; refusals are action-unavailable (with the available names), input-invalid (with the JSON
// path) and action-failed. Exit codes: 0 ok, 2 refused, 1 failed. This is the pixel layer's contract: an
// accessibility-tree driver composes with it, and falls back to it when there is no tree (pre-boot, a frozen app):
// hackamore (ourostack/hackamore) is that driver, and uses housesitter's `open(mac)` as its pixel layer's hands.

import { validate } from '@ouro.bot/hackamore/schema';
import { Refusal } from './hands.mjs';

// One copy of the Reins schema check: hackamore's, which drives the apps above the pixels (accessibility tree).
export { validate };

const obj = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const point = { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 2, maxItems: 2 };

export function actionsFor({ kvm, sitter }) {
  const a = [];
  const add = (name, input, summary) => a.push({ name, input, summary });
  if (kvm?.video?.online !== false) add('screenshot', obj({ max_width: { type: 'integer', minimum: 320, maximum: 1920 } }), "the KVM's picture of the screen (JPEG); later coordinates are in its pixels");
  if (kvm?.hid?.keyboard_online !== false) {
    for (const c of ['left_click', 'right_click', 'double_click']) add(c, obj({ coordinate: point }, ['coordinate']), `${c.replace('_', ' ')} at a point in the last screenshot`);
    add('type', obj({ text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['text']), 'type text (never a password: the sitter types that itself)');
    add('key', obj({ text: { type: 'string', minLength: 1 } }, ['text']), 'press a key or combo: cmd+space, Return, ctrl+shift+4');
    add('scroll', obj({ coordinate: point, scroll_direction: { enum: ['up', 'down', 'left', 'right'] }, scroll_amount: { type: 'integer', minimum: 1, maximum: 20 } }, ['scroll_direction']), 'scroll, optionally at a point');
  }
  const st = sitter?.state;
  if (sitter && (st === 'filevault' || st === 'degraded') && sitter.can?.unlock) add('unlock', obj(), 'ask the sitter to type its sealed copy of the password, only if its own fresh look reads the prompt');
  if (sitter && sitter.lock_policy && sitter.obs?.screen !== 'desktop') add('want_desktop', obj({ minutes: { type: 'integer', minimum: 1, maximum: 60 } }), 'ask the sitter to unlock the lock screen so you can drive the UI (it tries now, and keeps the request for some minutes)');
  if (sitter?.can?.plug) { add('power_cycle', obj(), 'smart plug off, then on by itself (one per 30 min, three a day)'); add('power_on', obj(), 'smart plug on'); }
  return a;
}

export function screen(name, { kvm, sitter, via }) {
  return { focus: name, path: [name], state: { kvm, sitter: sitter ? { state: sitter.state, since: sitter.since, at: sitter.at, can: sitter.can, obs: sitter.obs } : null, via }, actions: actionsFor({ kvm, sitter }) };
}

// Run one action against a driver (pixels) or the sitter (unlock, power). Returns { ok, result } or throws Refusal.
export async function run(name, action, input, { scr, hands, sitter }) {
  const a = scr.actions.find((x) => x.name === action);
  if (!a) throw new Refusal('action-unavailable', `${action} isn't available on ${name} right now`, { available: scr.actions.map((x) => x.name) });
  const bad = validate(a.input, input ?? {});
  if (bad) throw new Refusal('input-invalid', bad.message, { path: bad.path });
  if (['unlock', 'want_desktop', 'power_cycle', 'power_on'].includes(action)) {
    const r = await sitter.op(action, action === 'want_desktop' ? (input || {}) : {});
    if (!r.ok) throw new Refusal(r.code === 'action-unavailable' ? r.code : 'action-failed', String(r.result));
    return { ok: true, result: r.result, via: r.via };
  }
  const h = await hands();
  const out = await h.computer({ action, ...input });
  return { ok: true, result: out, via: h.via };
}
