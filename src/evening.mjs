// `housesitter demo`: the evening of 8 November 2026, replayed. Six real frames our GL.iNet Comet took of our Mac
// mini (only what the sitter keeps of a frame: assets/evening.json, made by scripts/evening.py), read again right now
// by the sitter's own rules (src/frames.mjs, held to device/sitter.py by test/parity.test.mjs). The times and what
// happened between the frames come from the mini's own logs; the last block, a real restart, is the KVM's own log
// beside its frame. No hardware needed, nothing leaves this computer.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyFrame, promptSeen, readsAs } from './frames.mjs';
import { beside, glimpse, painter, wordmark } from './paint.mjs';

export function loadEvening(file = fileURLToPath(new URL('../assets/evening.json', import.meta.url))) {
  const e = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const f of e.frames) if (f.lum) f.lum = Buffer.from(f.lum, 'base64');
  return e;
}

// What happened, from the mini's logs (the incident timeline); the frame each step shows is read live below.
const STORY = {
  incident: {
    before: [['10:11', 'One of our agents changed a display setting on the KVM. Ten seconds later macOS\'s login window and its sign-in services crashed. Every agent on the mini went with them.']],
    did: 'won\'t type: no password field on its own picture. It tells you once, then waits.',
    then: [['10:59', 'What we did that day, before housesitter: typed the right password three times anyway. None of it reached a password field.'], ['17:54', 'I got home and logged in by hand. Seven and a half hours down.']],
  },
  mirror: { before: [['17:59', 'The KVM now sees the main display, so the login window is on its picture.']], did: 'nothing to do: a desktop with a menu bar.' },
  locked: { before: [['18:07', 'We locked the mini and taught the sitter the lock screen from three frames.']], did: 'may type here, once, if the password is verified or one try is armed.' },
  awake: { before: [], did: 'the same prompt, with the wallpaper moving behind it.' },
  unlocked: { before: [['18:15', 'We asked the KVM to unlock it, once. It typed the password at the field it could see.']], did: 'the try reached the desktop, so the password is verified.' },
  restart: {
    before: [['18:31', 'Then the real test: we restarted the mini and left it alone. From the KVM\'s own log:']],
    log: [['18:31:44', 'boot seen: the Mac found the KVM\'s keyboard again'], ['18:31:55', 'FileVault, waiting for a password'], ['18:32:35', 'the password field is on its picture, steady for 6 frames'], ['18:32:37', 'typed the password, once'], ['18:32:56', 'the desktop is up. Nobody touched it.']],
  },
};

export function replay(e = loadEvening()) {
  const refs = [e.prompt_points];
  return e.frames.map((f) => {
    const kind = classifyFrame(f);
    const seen = promptSeen(f, refs);
    return { ...f, kind, seen, reads: readsAs(kind, seen), story: STORY[f.key] || { before: [], did: '' } };
  });
}

const wrap = (s, n) => { const out = []; let line = ''; for (const w of String(s).split(' ')) { if ((line + ' ' + w).trim().length > n) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) out.push(line); return out; };

export function renderEvening(steps, { color = false } = {}) {
  const p = painter(color);
  const blocks = [];
  blocks.push(['', ...beside(wordmark(p).map((l) => `  ${l}`), [p.dim('the evening of 8 November 2026, replayed'), p.dim('real frames from our KVM, read again just now'), p.dim('by the same rules the sitter runs')], 4), '']);
  for (const s of steps) {
    const right = [];
    const say = (t, text) => wrap(text, 52).forEach((l, i) => right.push(`${i ? '       ' : `${p.dim(t)}  `}${p.text(l)}`));
    for (const [t, text] of s.story.before) say(t, text);
    right.push('');
    if (s.story.log) {
      for (const [t, text] of s.story.log) right.push(`${p.dim(t)}  ${/desktop is up/.test(text) ? p.fg([158, 206, 106], text) : text}`);
    } else {
      right.push(`${p.label('IT SEES')}  ${s.reads}${s.seen.visible ? p.fg([158, 206, 106], ` (${Math.round(s.seen.match * 100)}%)`) : ''}`);
      wrap(s.story.did, 50).forEach((l, i) => right.push(`${i ? '         ' : `${p.label('IT DOES')}  `}${s.kind === 'prompt_like' && !s.seen.visible ? p.fg([224, 175, 104], l) : l}`));
    }
    for (const [t, text] of s.story.then || []) { right.push(''); say(t, text); }
    blocks.push([...beside(glimpse(p, s.glimpse, { title: s.at }).map((l) => `  ${l}`), right, 3), '']);
  }
  blocks.push([`  ${p.dim('The morning, it would have refused and told you. The evening, it unlocked. Same rules.')}`, `  ${p.dim('Your own Mac: housesitter adopt <mac> --address <kvm ip>     A rehearsed bad night: housesitter demo night')}`, '']);
  return blocks;
}
