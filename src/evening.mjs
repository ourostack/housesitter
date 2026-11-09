// `housesitter demo`: the evening of 8 November 2026, replayed. Six real frames our GL.iNet Comet took of our Mac
// mini (only what the sitter keeps of a frame: assets/evening.json, made by scripts/evening.py), read again right now
// by the sitter's own rules (src/frames.mjs, held to device/sitter.py by test/parity.test.mjs). The times and what
// happened between the frames come from the mini's own logs; the last two blocks, two real restarts, are the KVM's own
// logs beside their frames (docs/proof/2026-11-09 for the second). No hardware needed, nothing leaves this computer.

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
    before: [['10:11', 'One of our agents changed a display setting on the KVM. Ten seconds later macOS\'s login window and its sign-in services crashed, and every agent on the mini went with them.']],
    did: 'won\'t type: no password field on its picture. It tells you once, then waits.',
    then: [['10:59', 'What we did that day, before housesitter: typed the right password three times anyway. Our first key, Escape, had switched the login window to its list of users, so none of it reached a field.'], ['17:54', 'I logged in by hand. Seven and a half hours down.']],
  },
  mirror: { before: [['17:59', 'The KVM now sees the main display, so a login window would be on its picture.']], did: 'nothing to do.' },
  locked: { before: [['18:07', 'We locked the mini and taught the sitter the lock screen, from three frames.']], did: 'waits. A plain lock screen is your lock: it types there only when you ask.' },
  unlocked: { before: [['18:15', 'We asked it to unlock, once. It typed the password at the prompt on its picture.']], did: 'the desktop followed, so the password is verified.' },
  restart: {
    before: [['18:31', 'The first restart test, on our watchdog, the code housesitter grew from. From the KVM\'s own log:']],
    log: [['18:31:44', 'the screen went dark, then the Mac found its keyboard'], ['18:31:55', 'FileVault: not a screen it was taught, so it waits'], ['18:32:18', 'an agent teaches it this screen, once'], ['18:32:35', 'the prompt it was taught is on its picture'], ['18:32:37', 'typed the password, once, by itself'], ['18:32:56', 'the desktop is up, 1 min 44 s after the restart.']],
  },
  handsoff: {
    before: [['22:55', 'That night, housesitter 0.2, which had learned FileVault on one supervised restart. Our agent pressed Restart, and nothing else touched the Mac. From the sitter\'s log and the KVM\'s frames:']],
    log: [['22:55:55', 'Restart, pressed by our agent'], ['22:56:24', 'the screen went dark, then the Mac found its keyboard'], ['22:56:44', 'FileVault: the prompt it was taught, steady'], ['22:56:51', 'typed the password, once, by itself'], ['22:57:06', 'the desktop is up: 70 s, and nobody touched it.']],
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

// Shown as blocks: the second lock-screen frame folds into the first (same prompt, the wallpaper moved).
export function blocksOf(steps) {
  const out = [];
  for (const s of steps) {
    if (s.key === 'awake' && out.at(-1)?.key === 'locked') { out.at(-1).also = s; continue; }
    out.push({ ...s });
  }
  return out;
}

const greedy = (s, n) => { const out = []; let line = ''; for (const w of String(s).split(' ')) { if ((line + ' ' + w).trim().length > n) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) out.push(line); return out; };
// Balanced: the narrowest width that keeps the same number of lines, so no line ends with one lonely word.
const wrap = (s, n) => { const k = greedy(s, n).length; let w = n; while (w > 20 && greedy(s, w - 1).length === k) w--; return greedy(s, w); };

export function renderEvening(steps, { color = false } = {}) {
  const p = painter(color);
  const blocks = [];
  blocks.push(['', ...beside(wordmark(p).map((l) => `  ${l}`), [p.dim('8 November 2026, replayed'), p.dim('real frames from our KVM, read again just now'), p.dim('by the same rules the sitter runs')], 4), '']);
  for (const s of blocksOf(steps)) {
    const right = [];
    const say = (t, text) => wrap(text, 52).forEach((l, i) => right.push(`${i ? '       ' : `${p.dim(t)}  `}${p.text(l)}`));
    for (const [t, text] of s.story.before) say(t, text);
    right.push('');
    if (s.story.log) {
      for (const [t, text] of s.story.log) right.push(`${p.dim(t)}  ${/desktop is up/.test(text) && s.key === 'handsoff' ? p.fg([158, 206, 106], text) : text}`);
    } else {
      const pct = (x) => `${Math.round(x.seen.match * 100)}%`;
      const sees = s.seen.visible ? `${s.reads}: ${pct(s)}${s.also?.seen.visible ? `, then ${pct(s.also)} as the wallpaper moved` : ''}` : s.reads;
      wrap(sees, 50).forEach((l, i) => right.push(`${i ? '         ' : `${p.label('IT SEES')}  `}${l.replace(/\d+%/g, (m) => p.fg([158, 206, 106], m))}`));
      wrap(s.story.did, 50).forEach((l, i) => right.push(`${i ? '         ' : `${p.label('IT DOES')}  `}${s.kind === 'prompt_like' && !s.seen.visible ? p.fg([224, 175, 104], l) : l}`));
    }
    for (const [t, text] of s.story.then || []) { right.push(''); say(t, text); }
    const head = `╭─ seen ${s.at} ─ a desktop, not shown `;
    const box = s.withheld ? [p.dim(`${head}${'─'.repeat(Math.max(0, 41 - head.length))}╮`)] : glimpse(p, s.glimpse, { title: `seen ${s.at}` });
    blocks.push([...beside(box.map((l) => `  ${l}`), right, 3), '']);
  }
  blocks.push([`  ${p.dim('The morning: it refuses, and tells you. That night: housesitter itself, hands-off, 70 s.')}`, `  ${p.dim('Your own Mac: housesitter adopt <mac> --address <kvm ip>     A rehearsed bad night: housesitter demo night')}`, '']);
  return blocks;
}
