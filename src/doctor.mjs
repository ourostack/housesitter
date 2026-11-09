// `housesitter doctor <mac>` (and `status`): one screen with everything that matters. What the KVM sees right now,
// the Mac, the KVM, the password gate, the budgets, the last bad stretch and what it did about it, and what to do
// next. Every line comes from a live read (the KVM's API, the sitter's status) or says that it couldn't read it.

import { age, beside, clock, glimpse, painter, rows, wordmark } from './paint.mjs';

const STATE = {
  healthy: ['ok', 'up, at its desktop'], degraded: ['warn', 'up, but something is off'], filevault: ['warn', 'at the FileVault or login screen'],
  hung: ['bad', 'frozen: no answer, the screen is not moving'], off: ['bad', 'off'], down: ['bad', 'not answering'], unknown: ['off', 'unknown: nothing to go on yet'],
};

const SCREEN = {
  desktop: 'a desktop', filevault: 'the FileVault screen', login: 'a login or lock screen', blank: 'black: asleep, off or no picture', unknown: 'not a desktop',
};

// A ledger result, without its parenthetical detail, cut at a word and marked when cut.
const short = (r, n = 70) => { const t = String(r).replace(/ \([^)]*\)?.*$/, ''); return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, '')}…`; };

export function buildDoctor({ name, mac = {}, kvm = null, sit = null, now = Date.now() }) {
  const st = sit?.status || null;
  const todo = [];
  const sec = [];

  // the Mac
  const mItems = [];
  if (st) {
    const [dot, words] = STATE[st.state] || ['off', st.state];
    mItems.push({ dot, text: `${words}${st.since ? ` for at least ${age(now - st.since)} (since ${clock(st.since, now)})` : ''}` });
  } else mItems.push({ dot: 'off', text: `no word from its sitter${sit?.errors?.length ? ` (${sit.errors[0]})` : ''}` });
  sec.push({ label: 'THE MAC', items: mItems });

  // the KVM
  const kItems = [];
  if (!kvm) kItems.push({ dot: 'off', text: 'not asked' });
  else if (kvm.error) { kItems.push({ dot: 'bad', text: `not reached: ${kvm.error}` }); todo.push({ cmd: `housesitter adopt ${name} --address <kvm ip>`, why: 'check the address, the cable and the tailnet' }); }
  else {
    kItems.push({ dot: 'ok', text: `${kvm.model || 'kvmd'}${kvm.version ? ` · kvmd ${kvm.version}` : ''} · via ${String(kvm.via).replace(' (fallback)', '')}` });
    const v = kvm.video || {};
    // GLKVM says "streamer": null while nobody is watching; the sitter reads its HDMI receiver directly.
    const hdmi = v.online ? v.resolution : v.online == null && st?.obs?.hdmi ? `${st.obs.hdmi.replace('x', '×')} (read by the sitter; no viewer open)` : 'no signal';
    const seen = v.online || (v.online == null && st?.obs?.hdmi);
    kItems.push({ dot: kvm.hid?.keyboard_online && seen ? 'ok' : 'warn', text: `keyboard ${kvm.hid?.keyboard_online ? 'online' : 'OFFLINE'} · HDMI ${hdmi}` });
  }
  if (mac.kvm && !mac.kvm.tls_sha256) kItems.push({ dot: 'warn', text: 'its certificate is not pinned' });
  const ing = st?.ingress;
  if (ing?.ok) kItems.push({ dot: 'ok', text: `reached by ${ing.mode === 'tailnet' ? 'the tailnet only' : 'the LAN\'s private addresses and the tailnet'} (SSH, HTTP, HTTPS) · read back ${age(now - (ing.checked_at || ing.at))} ago` });
  else if (ing) {
    kItems.push({ dot: 'bad', text: `NOT filtering who reaches it${ing.since ? ` since ${clock(ing.since, now)}` : ''}: ${short(ing.detail || ing.drifted || 'unknown', 90)}` });
    todo.push({ cmd: `housesitter adopt ${name}`, why: 'puts the KVM\'s rules back in place, and says why if it can\'t' });
  }
  sec.push({ label: 'THE KVM', items: kItems });

  // the password gate
  const pItems = [];
  if (st) {
    const has = st.secrets?.mac;
    if (!has) { pItems.push({ dot: 'off', text: 'no password on the sitter: it never types' }); todo.push({ cmd: `housesitter secret ${name} mac-password`, why: 'then adopt again to seal it on the KVM' }); }
    else if (st.password === 'verified') pItems.push({ dot: 'ok', text: 'verified: our one supervised try reached the desktop' });
    else if (st.password === 'trial') pItems.push({ dot: 'warn', text: 'one supervised try is armed: restart the Mac and watch' });
    else { pItems.push({ dot: 'off', text: 'unverified, so never typed' }); todo.push({ cmd: `housesitter unlock ${name} --trial`, why: 'arm one supervised try, then restart and watch' }); }
    const pr = st.prompt;
    const ls = st.lessons || pr?.lessons;
    if (ls) {
      const have = [['FileVault', ls.boot], ['lock screen', ls.lock], ['list of users', ls.grid]].filter(([, n]) => n).map(([k]) => k);
      pItems.push({ dot: ls.boot ? 'ok' : 'off', text: have.length ? `taught: ${have.join(' · ')}` : 'not taught any screen yet' });
      if (!ls.boot) todo.push({ cmd: `housesitter learn-prompt ${name} --i-see-the-field --filevault`, why: 'at the FileVault screen, during one restart you watch' });
    } else if (pr) {
      pItems.push({ dot: pr.taught ? 'ok' : 'off', text: pr.taught ? `taught the password prompt (${pr.taught} reference${pr.taught > 1 ? 's' : ''})` : 'not taught the password prompt yet' });
      if (!pr.taught) todo.push({ cmd: `housesitter learn-prompt ${name} --i-see-the-field --filevault`, why: 'at the FileVault screen, during one restart you watch' });
    }
    if ('lock_policy' in st) {
      const lp = st.lock_policy;
      pItems.push({ dot: lp ? 'ok' : 'off', text: lp === true ? 'lock screen: unlocks any lock screen it sees (unlock_lock_screen: true)' : lp === 'on_request' ? `lock screen: unlocks it when an agent asks (want-desktop)${st.desktop_wanted ? '; a request stands now' : ''}` : 'lock screen: stays locked unless you ask over SSH' });
    }
  }
  if (pItems.length) sec.push({ label: 'PASSWORD', items: pItems });

  // power and budgets
  const can = st?.can || {};
  const b = st?.budgets;
  const bItems = [];
  if (b) {
    const [u, uMax] = b.unlock_hour;
    const [ub, ubMax] = b.unlock_since_desktop;
    bItems.push({ dot: b.blocked ? 'warn' : 'ok', text: `unlock  ${Math.max(0, ubMax - ub)} of ${ubMax} tries left before it stops (resets at the desktop) · ${Math.max(0, uMax - u)} of ${uMax} left this hour${b.unlock_hour_frees_at ? (b.unlock_hour_frees_at - now < 60000 ? ' (one back within a minute)' : ` (one back at ${clock(b.unlock_hour_frees_at, now)})`) : ''}` });
    if (b.unlock_test_hour?.[0]) bItems.push({ dot: 'ok', text: `tests   ${Math.max(0, b.unlock_test_hour[1] - b.unlock_test_hour[0])} of ${b.unlock_test_hour[1]} attended-test unlocks left this hour (their own budget)` });
    if (b.blocked) bItems.push({ dot: 'warn', text: `stopped: ${b.blocked}` });
  }
  if (st) {
    if (can.plug || can.fingerbot) {
      const [c, cMax] = b?.cycles_day || [0, 3];
      const o = st.obs || {};
      const plug = o.plug_on != null ? ` · plug ${o.plug_on ? 'on' : 'OFF'}${o.watts != null ? `, ${Math.round(o.watts * 10) / 10} W` : ''}` : o.plug_error ? ` · plug NOT read: ${String(o.plug_error).slice(0, 40)}` : '';
      bItems.push({ dot: o.plug_error ? 'warn' : 'ok', text: `power   ${Math.max(0, cMax - c)} of ${cMax} cycles left today${plug} · only a desktop frozen 5 min, then 3 more looks, while nothing answers` });
    } else bItems.push({ dot: 'off', text: 'power   no plug: a frozen Mac is reported, never cycled' });
  }
  if (bItems.length) sec.push({ label: 'BUDGETS', items: bItems });

  // what happened
  const hItems = [];
  if (st?.incident) hItems.push({ dot: 'warn', text: `open since ${clock(st.incident.started, now)} (${age(now - st.incident.started)})${st.incident.notified_at ? ', and it told you' : ''}` });
  const li = st?.last_incident;
  // A restart's FileVault, unlocked by the boot watch, never becomes a rules incident, yet it is the night that went right:
  // show the newer of the two, so LAST INCIDENT and RECENT never disagree.
  const boots = (st?.recent || []).filter((e) => e.kind === 'unlock' && /FileVault/.test(e.result || '') && /^typed/.test(e.result || ''));
  const boot = boots.sort((a, b) => b.at - a.at)[0];
  if (boot && (!li || boot.at > (li.ended || li.started))) hItems.push({ dot: 'ok', text: `${clock(boot.at, now)}: a restart's FileVault, unlocked by the sitter; nobody was woken` });
  else if (li) hItems.push({ dot: 'ok', text: `${clock(li.started, now)} to ${clock(li.ended, now)}: ${li.actions?.length ? li.actions.map((a) => a.replace(/_/g, ' ')).join(', ') : 'it came back by itself'}${li.told_you ? '; it told you' : '; nobody was woken'}` });
  if (st && !hItems.length) hItems.push({ dot: 'ok', text: 'none seen by this sitter yet' });
  if (hItems.length) sec.push({ label: 'LAST INCIDENT', items: hItems });
  // Newest first, apart from the incident: a FileVault unlock after a boot is not an incident, and is often the best news.
  // The Mac's own watch hands its sends to the sitter's ledger as "posted by the Mac's watch (TEST): <title>, emailed".
  const fromMac = (e) => /^posted by the Mac's watch(?: \(TEST\))?: (.*?)(, emailed)?$/.exec(String(e.result || ''));
  const rItems = [...(st?.recent || [])].sort((a, b) => b.at - a.at).slice(0, 3).map((e) => {
    const m = fromMac(e);
    if (m) return { dot: null, text: `${clock(e.at, now)}  ${e.test ? 'TEST ' : ''}from the Mac's watch: ${m[1].replace(/^TEST: /, '')}${m[2] ? ', emailed' : ''}` };
    return { dot: null, text: `${clock(e.at, now)}  ${e.test ? 'TEST alert' : e.kind.replace(/_/g, ' ')}${e.result ? `: ${short(e.result)}` : ''}` };
  });
  if (rItems.length) sec.push({ label: 'RECENT', items: rItems });

  // alerts
  const aItems = [];
  if (mac.notify?.kind) aItems.push({ dot: 'ok', text: `${mac.notify.kind}${mac.notify.email ? ` and email to ${mac.notify.email}` : ''}: it messages you only when it needs you, and when the Mac is back` });
  else { aItems.push({ dot: 'warn', text: 'nowhere to tell you' }); todo.push({ cmd: `housesitter adopt ${name} --notify ntfy`, why: 'a phone notification, no account needed' }); }
  // Who watches the KVM: the Mac itself (housesitter watch-kvm, which checks in over SSH every minute), or a dead man's switch.
  const w = st?.watcher;
  const wAge = w?.at ? now - w.at : null;
  const dms = (mac.watched_by || mac.heartbeat)?.url;
  if (w && wAge < 180000) aItems.push({ dot: 'ok', text: `watched by the Mac itself (${w.by}): last check ${age(wAge)} ago; it tells you if the KVM goes silent` });
  else if (w) aItems.push({ dot: 'warn', text: `the Mac's watch (${w.by}) last checked ${age(wAge)} ago: is housesitter watch-kvm running there?` });
  if (dms) aItems.push({ dot: 'ok', text: 'watched by a dead man\'s switch: it pings every look, so you hear if the KVM itself goes quiet' });
  if (!w && !dms) { aItems.push({ dot: 'off', text: 'nothing outside watches the KVM: if it dies, nobody hears' }); todo.push({ cmd: `housesitter watch-kvm ${name} --install`, why: 'on the Mac: it checks the KVM every minute and tells you if it goes silent (or adopt --watched-by <url>, a dead man\'s switch)' }); }
  sec.push({ label: 'ALERTS', items: aItems });

  // the screen, beside the picture
  const scr = [];
  if (st) {
    const ago = now - st.at;
    const every = (st.interval_sec || 60) * 1000;
    const late = ago > every * 2.5;
    scr.push(['THE SCREEN', '']);
    scr.push(['reads as', `${SCREEN[st.obs?.screen] || 'not read'}${st.obs?.eyes === 'frame' ? ' (from a decoded frame)' : ''}`]);
    if (st.prompt) scr.push(['taught prompt', st.prompt.visible ? `on the picture (${Math.round(st.prompt.match * 100)}%)` : 'not on the picture']);
    if (st.obs?.screen === 'desktop' || st.obs?.clock?.where === 'lock') {
      const c = st.obs.clock;
      const read = c?.text ? `: reads ${c.text.replace(/^.*?(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s*$/, '$1')}${c.where === 'lock' ? ' on the lock screen' : ''}, on the KVM's NPU${c.ms != null ? ` in ${c.ms} ms` : ''}` : '';
      const ticking = c?.where === 'lock' ? st.obs.lock_clock_ticking : st.obs.clock_ticking;
      scr.push(['clock', `${ticking === false ? 'NOT moving' : ticking ? 'moving' : 'not read yet'}${read}`]);
    }
    scr.push(['looked', `${age(ago)} ago${late ? ' (LATE: is the sitter running?)' : ''}`]);
    if (!late) scr.push(['next look', every - ago > 1000 ? `in ${age(every - ago)}` : 'due now']);
    const probeless = st.probes && !st.probes.health && !st.probes.watched_by && !st.probes.heartbeat;
    const beat = st.obs?.heartbeat_age_min;
    scr.push(['answers', st.obs?.answers === true ? (beat != null ? `yes: its heartbeat is ${beat} min old` : 'yes, on the network') : st.obs?.answers === false ? (beat != null ? `NO: its heartbeat is ${beat} min old` : 'NO') : probeless ? 'no probe set: "up" is a desktop whose clock moves' : 'the probe can\'t tell right now']);
  }
  return { name, glimpse: st?.glimpse || null, screen: scr, sections: sec, todo, sitter: st?.sitter, via: sit?.via };
}

export function renderDoctor(model, { color = false, now = Date.now(), hidePicture = false } = {}) {
  const p = painter(color);
  const out = [''];
  const head = wordmark(p);
  const tag = [p.dim('looks after the Mac your agents live on'), p.text(p.bold(model.name)) + p.dim(model.via ? `  via ${model.via}` : ''), p.dim(`${new Date(now).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${clock(now, now)}`)];
  out.push(...beside(head.map((l) => `  ${l}`), color ? tag : [`  ${model.name}`], 4), '');
  const right = [];
  for (const [k, v] of model.screen) right.push(k === 'THE SCREEN' ? p.label(k) : `${p.dim(k.padEnd(16))}${p.text(v)}`);
  if (hidePicture) out.push(...right.map((l, i) => `  ${l}${i === 0 ? p.dim('   (picture hidden: --private)') : ''}`), '');
  else out.push(...beside(glimpse(p, model.glimpse, { title: 'what the KVM sees' }).map((l) => `  ${l}`), ['', ...right]), '');
  out.push(...rows(p, model.sections, { labelWidth: 16 }).map((l) => `  ${l}`));
  if (model.todo.length) {
    out.push('', `  ${p.label(model.todo.length === 1 ? 'ONE THING TO DO' : `${model.todo.length} THINGS TO DO`)}`);
    for (const t of model.todo) out.push(`  ${p.fg([255, 158, 100], '→')} ${p.text(t.cmd)}  ${p.dim(t.why)}`);
  }
  out.push('');
  // --private is for a screenshot or a screen share: email addresses lose all but their first letter.
  return hidePicture ? maskEmails(out.join('\n')) : out.join('\n');
}

export const maskEmails = (s) => String(s).replace(/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1…@$2');
