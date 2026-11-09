// `housesitter demo`: one bad night, rehearsed in a few seconds with no hardware. A pretend Mac panics, hangs and
// gets its password changed; the real rules (src/watchdog.mjs) decide, and the real kvmd client reads the pretend
// screen and types into the pretend keyboard. Everything printed is labelled a rehearsal.

import { fakeWorld } from './fake.mjs';
import { makeClient } from './kvmd.mjs';
import { classifyScreen } from './screen.mjs';
import * as W from './watchdog.mjs';

const SEALED = 'correct horse'; // the sitter's sealed copy of the Mac's password
const clock = (min) => { const h = Math.floor(min / 60) % 24; const m = min % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };

export async function night({ name = 'studio', start = 2 * 60 + 58, end = 6 * 60 + 30, events = defaultEvents() } = {}) {
  const world = fakeWorld({ screen: 'desktop' });
  const kvm = makeClient({ base: world.url, pin: world.pin, password: world.st.adminPassword, request: world.request, warm: false });
  const caps = { unlock: true, plug: true, fingerbot: false, notify: true };
  let mac = { phase: 'up', until: null, watts: 18 };
  let mem = null;
  const ledger = [];
  const lines = [];
  const say = (t, text, tag = '') => lines.push({ t, at: clock(t), text, tag });
  const incidents = [];
  let open = null;
  for (let t = start; t <= end; t++) {
    for (const e of events.filter((x) => x.t === t)) {
      say(t, e.say, 'event');
      if ((e.kind === 'panic' || e.kind === 'hang') && !open) open = { from: t, messages: 0 };
      if (e.kind === 'panic') { mac = { phase: 'rebooting', until: t + 2, watts: 9 }; world.st.screen = 'blank'; }
      if (e.kind === 'hang') { mac = { phase: 'hung', watts: 17 }; }
      if (e.kind === 'password-changed') { world.st.macPassword = 'a new password the sitter does not know'; }
    }
    if (mac.phase === 'rebooting' && t >= mac.until) { mac = { phase: 'filevault', watts: 11 }; world.st.screen = 'filevault'; say(t, 'the Mac is back at the FileVault screen, waiting for a password nobody is there to type', 'mac'); }
    if (mac.phase === 'filevault' && world.st.screen === 'desktop') { mac = { phase: 'booting', until: t + 1, watts: 20 }; }
    if (mac.phase === 'booting' && t >= mac.until) { mac = { phase: 'up', watts: 18 }; say(t, 'the Mac is logged in; its login items start your agents again', 'mac'); }
    const screen = mac.phase === 'up' || mac.phase === 'hung' ? 'desktop' : classifyScreen(await kvm.ocr(), { userNames: ['Ada'] }).kind;
    const obs = { answers: mac.phase === 'up', video: true, screen, clock_ticking: mac.phase === 'hung' ? false : mac.phase === 'up' ? true : null, watts: mac.watts, plug_on: true };
    const r = W.tick(mem, ledger, obs, t * 60000, caps);
    const was = mem?.state;
    mem = r.mem;
    const SEES = { filevault: 'sitter: sees the FileVault screen', hung: 'sitter: the clock has not moved in 5 minutes and nothing answers', healthy: 'sitter: sees the desktop, clock ticking' };
    if (mem.state !== was && was && SEES[mem.state]) say(t, SEES[mem.state], 'state');
    for (const a of r.actions) {
      if (a.kind === 'wait') continue;
      ledger.push({ at: t * 60000, kind: a.kind, state: mem.state });
      if (a.kind === 'unlock') {
        await kvm.sendKey('ShiftLeft');
        const s = classifyScreen(await kvm.ocr(), { userNames: ['Ada'] });
        if (s.kind === 'filevault' || s.kind === 'login') { await kvm.type(`${SEALED}\n`); const n = ledger.filter((l) => l.kind === 'unlock' && t * 60000 - l.at < 3600000).length; say(t, n === 1 ? 'sitter: sees the password prompt, types its sealed copy of the password, slowly' : `sitter: still at FileVault after 4 minutes; tries once more (${n} of 3 this hour)`, 'act'); }
      }
      if (a.kind === 'power_cycle') {
        // The sitter's cycle guard: three fresh looks over two more minutes before it cuts the power (device/sitter.py).
        mac = { phase: 'rebooting', until: t + 5, watts: 0 };
        world.st.screen = 'blank';
        say(t, 'sitter: before cutting power, three more looks over two minutes: still frozen, still silent', 'state');
        say(t + 2, 'sitter: smart plug off for 10 s, then on by itself', 'act');
      }
      if (a.kind === 'notify') {
        const m = W.message(name, mem, a, obs);
        if (open) open.messages++;
        if (a.recovered) say(t, `sitter → your phone: "${m.subject}"`, 'notify');
        else {
          // The message itself, word for word: its title and the two lines that matter at 3 a.m. (the other two are the
          // time it got stuck and the raw signs).
          say(t, 'sitter → your phone, once:', 'notify');
          const keep = m.body.split('\n').filter((l) => /^(Stuck because|Look):/.test(l));
          for (const l of [m.subject, ...keep]) lines.push({ t, at: '', text: l, tag: l === m.subject ? 'msg-title' : 'msg' });
        }
        if (mem.incident) mem.incident.notified_at = t * 60000;
      }
    }
    if (mem.state === 'healthy' && open) { incidents.push({ ...open, to: t, fixed: open.messages === 0 }); say(t, open.messages ? 'back, after your help' : `back by itself ${t - open.from} min after it went down; nobody was woken`, 'done'); open = null; }
  }
  if (open) incidents.push({ ...open, to: null, fixed: false });
  return { lines, incidents, world };
}

export function defaultEvents() {
  return [
    { t: 3 * 60 + 12, kind: 'panic', say: 'kernel panic (a display driver this time); the Mac restarts itself' },
    { t: 4 * 60 + 31, kind: 'hang', say: 'the Mac freezes solid: no panic, no answer, fans on' },
    { t: 5 * 60 + 40, kind: 'password-changed', say: '(someone changed the Mac\'s password yesterday and forgot to tell the sitter)' },
    { t: 5 * 60 + 41, kind: 'panic', say: 'another panic; the Mac restarts itself' },
  ];
}

function wrapAt(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

export function render({ lines, incidents }, { color = false } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const tint = { event: '33', mac: '2', state: '36', act: '32', notify: '35', done: '1;32', 'msg-title': '1;97', msg: '97' };
  const out = [c('2', 'housesitter demo night: a pretend Mac and KVM, run by the real rules and client.'), ''];
  for (const l of lines) {
    if (l.tag === 'msg' || l.tag === 'msg-title') {
      // The message, as a block under its line, wrapped at a space so it reads like the notification it is.
      for (const w of wrapAt(l.text, 72)) out.push(`         ${c('32', '│')} ${c(tint[l.tag], w)}`);
    } else out.push(`${c('2', l.at)}  ${c(tint[l.tag] || '0', l.text)}`);
  }
  const fixed = incidents.filter((i) => i.fixed);
  const asked = incidents.filter((i) => !i.fixed);
  out.push('', c('1;97', `${incidents.length} incidents overnight: ${fixed.length} fixed by itself (${fixed.map((i) => `${i.to - i.from} min`).join(', ')}), ${asked.length} needed you, and it said so once.`));
  return out.join('\n');
}
