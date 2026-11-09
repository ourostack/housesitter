// The watchdog's brain, with no I/O: what state a Mac is in and what to do about it, with rate limits and
// escalation. The same rules run in two places, and both are tested against spec/watchdog-cases.json:
//   - the sitter on the KVM (device/sitter.py ports this file): always on, holds the Mac's password, acts alone;
//   - any agent host that wants a second opinion (`housesitter watch`): it never types a password, it only tells you.
//
// States: healthy, degraded (some signs bad, not for long enough to act), filevault (at the unlock or login screen),
// hung (powered and not answering for hung_min), off (no power, or no signal and no network for off_min), down (not
// answering, and this watcher has no eyes on it to say why), unknown (this watcher can see nothing).
// Actions: unlock (type the password through the KVM; only a watcher that holds it, which is the sitter), power_cycle
// (smart plug off, then on by itself), power_on, press_power (Fingerbot), notify. A watcher that can't unlock leaves
// the FileVault screen to the sitter for filevault_wait_min, then tells you.
//
// Observation (any field may be null: this watcher can't see it):
//   answers: the Mac answered a health check now   beat_min: minutes since the Mac's last heartbeat
//   presence: a presence service says it's online  screen: desktop|filevault|login|blank|unknown (the KVM's picture)
//   video: the KVM sees an HDMI signal              clock_ticking: the menu-bar clock changed since the last look
//   arp: the Mac's network stack answered           watts: the smart plug's power reading   plug_on: relay state

export const DEFAULTS = {
  hung_min: 5,            // down this long while powered = hung (a boot takes ~1-2 min; a panic reboot ~2)
  off_min: 2,
  down_min: 10,           // down, and this watcher can't see why (no KVM, no plug): tell you after this long
  filevault_min: 0,
  filevault_wait_min: 10, // a watcher that can't unlock gives the sitter this long before telling you
  unlocks_per_hour: 3,    // password guard: at most three typed unlocks an hour, across incidents
  attended_test_unlocks_per_hour: 30, // you, over SSH, locking and unlocking on purpose: a budget of its own
  settle_min: 4,          // after an action, wait this long before judging it
  cycle_gap_min: 30,      // at most one power cycle per 30 min...
  cycles_per_day: 3,      // ...and three a day
  on_gap_min: 10,
  max_failed: 2,          // the same action twice with no change: stop and tell you
  remind_hours: 6,
  idle_watts: 2,          // below this the Mac is off
};

const minutes = (ms) => ms / 60000;

// What the signs say right now, before any persistence.
export function rawState(o, cfg = DEFAULTS) {
  const up = o.answers === true || (o.beat_min != null && o.beat_min <= 3 && o.presence !== false);
  if (up) return o.screen === 'filevault' ? 'degraded' : 'healthy';
  // No health probe and no heartbeat to ask: a desktop whose clock moves (and a network stack that answers, where the
  // KVM can see it) is as up as this watcher can know. Without this an incident would never close.
  if (o.answers == null && o.beat_min == null && o.presence == null && o.screen === 'desktop' && o.clock_ticking === true && o.arp !== false) return 'healthy';
  if (o.screen === 'filevault' || o.screen === 'login') return 'filevault';
  const powered = (o.watts != null && o.watts >= cfg.idle_watts) || o.video === true || o.arp === true;
  const unpowered = o.plug_on === false || (o.watts != null && o.watts < cfg.idle_watts);
  if (unpowered) return 'off';
  const anySign = [o.answers, o.beat_min, o.presence, o.screen, o.video, o.arp, o.watts].some((v) => v != null);
  if (!anySign) return 'unknown';
  if (o.video === false && o.arp !== true && !powered) return 'off';
  if (o.screen === 'desktop' && o.clock_ticking === true) return 'degraded'; // the UI is alive; only the agents' path is down
  const down = o.answers === false || (o.beat_min != null && o.beat_min > 3) || o.presence === false || o.arp === false;
  if (down && (powered || o.screen === 'blank' || o.screen === 'desktop')) return 'hung';
  if (down && o.screen == null && o.video == null && o.watts == null && o.arp == null) return 'down';
  // Powered, but no picture and no answer: maybe FileVault is on another display, maybe the display slept. Never
  // act on that; tell you once it has lasted down_min.
  if (o.video === false && powered && o.answers !== true) return 'down';
  return 'degraded';
}

// Persistence: a raw state must hold for its threshold before it becomes the state we act on.
export function advance(mem, raw, now, cfg = DEFAULTS) {
  const m = { ...(mem || {}) };
  if (m.raw !== raw) { m.raw = raw; m.raw_since = now; }
  const held = minutes(now - m.raw_since);
  const need = { hung: cfg.hung_min, off: cfg.off_min, filevault: cfg.filevault_min, down: cfg.down_min }[raw] ?? 0;
  let state = raw;
  if (held < need) state = 'degraded';
  if (state !== m.state) { m.state = state; m.since = now; }
  if (state === 'healthy') { m.incident = null; } else if (!m.incident && state !== 'degraded') m.incident = { started: now, notified_at: null, failed: {} };
  return m;
}

const recent = (ledger, kind, now, mins) => ledger.filter((a) => a.kind === kind && now - a.at < mins * 60000);

// What to do now. caps: what this watcher can do ({ unlock, plug, fingerbot, notify }).
export function decide(mem, ledger, now, caps, cfg = DEFAULTS) {
  const s = mem.state;
  const acts = [];
  const last = ledger.filter((a) => a.kind !== 'notify').at(-1);
  // Settle only while nothing has changed since the action: a power cycle that lands on FileVault is unlocked at once.
  const settling = last && now - last.at < cfg.settle_min * 60000 && last.state === s;
  const inc = mem.incident;
  const failedTwice = (kind) => (inc?.failed?.[kind] || 0) >= cfg.max_failed;
  const want = (kind, why) => {
    if (failedTwice(kind)) return false;
    acts.push({ kind, why });
    return true;
  };
  let stuck = null;
  if (s === 'healthy') {
    if (mem.recovered_pending) acts.push({ kind: 'notify', why: 'recovered', recovered: true });
    return acts;
  }
  if (settling && s !== 'degraded') return [{ kind: 'wait', why: `settling after ${last.kind} (${Math.round(minutes(now - last.at))} of ${cfg.settle_min} min)` }];
  if (s === 'filevault') {
    if (caps.unlock) {
      if (recent(ledger, 'unlock', now, 60).length >= cfg.unlocks_per_hour) stuck = `unlock budget used (${cfg.unlocks_per_hour} in the last hour): it keeps coming back to FileVault`;
      else if (!want('unlock', 'at the FileVault/login screen')) stuck = 'the password was wrong twice. Fix: housesitter secret <mac> mac-password, then housesitter adopt <mac>';
    } else if (minutes(now - mem.since) >= cfg.filevault_wait_min) stuck = `at the FileVault screen for ${cfg.filevault_wait_min}+ min and the sitter has not unlocked it. Look: housesitter status <mac>`;
  } else if (s === 'hung') {
    const cycles = recent(ledger, 'power_cycle', now, 24 * 60).length;
    const gapOk = !recent(ledger, 'power_cycle', now, cfg.cycle_gap_min).length;
    if (caps.plug && gapOk && cycles < cfg.cycles_per_day) { if (!want('power_cycle', `powered but not answering for ${cfg.hung_min}+ min`)) stuck = 'power cycles did not bring it back'; }
    else if (caps.fingerbot && gapOk && cycles < cfg.cycles_per_day) { if (!want('press_power', 'hung; long press to force off, then press to start')) stuck = 'Fingerbot presses did not bring it back'; }
    else stuck = caps.plug || caps.fingerbot ? `power-cycle budget used (${cycles} today)` : 'hung, and no smart plug or Fingerbot to restart it';
  } else if (s === 'off') {
    const gapOk = !recent(ledger, 'power_on', now, cfg.on_gap_min).length;
    if ((caps.plug || caps.fingerbot) && gapOk) { if (!want('power_on', 'no power or no signal')) stuck = 'it does not come back on'; }
    else if (!caps.plug && !caps.fingerbot) stuck = 'off, and nothing here can switch it on (power outage, unplugged, or shut down)';
  } else if (s === 'down') {
    stuck = `not answering for ${cfg.down_min}+ min, and nothing here can see why (no picture on the KVM: is FileVault on another display, or did the display sleep?)`;
  } else if (s === 'unknown') {
    if (minutes(now - mem.since) >= 15) stuck = 'this watcher has seen no sign of the Mac for 15 minutes';
  }
  if (stuck && caps.notify && inc) {
    const due = inc.notified_at == null || now - inc.notified_at >= cfg.remind_hours * 3600000;
    if (due) acts.push({ kind: 'notify', why: stuck });
  }
  return acts;
}

// After an action's settle time: if the state did not change, count it as failed for this incident.
export function judge(mem, ledger, now, cfg = DEFAULTS) {
  const m = { ...mem, incident: mem.incident ? { ...mem.incident, failed: { ...(mem.incident.failed || {}) } } : null };
  const last = ledger.filter((a) => a.kind !== 'notify' && a.kind !== 'wait').at(-1);
  // Only an action taken in this incident is judged against it: an old one already ended its own incident.
  if (!last || last.judged || now - last.at < cfg.settle_min * 60000 || !m.incident || last.at < m.incident.started) return { mem: m, judged: null };
  const fixed = m.state === 'healthy' || (last.state !== m.state && m.state !== 'off' && m.state !== 'hung');
  if (!fixed) m.incident.failed[last.kind] = (m.incident.failed[last.kind] || 0) + 1;
  return { mem: m, judged: { kind: last.kind, fixed } };
}

// One tick: observation in, new memory and actions out. The runner performs the actions, then appends each to the
// ledger as { at, kind, state } and, for notify, sets mem.incident.notified_at.
export function tick(mem, ledger, obs, now, caps, cfg = DEFAULTS) {
  const wasBad = mem?.incident != null;
  let m = advance(mem, rawState(obs, cfg), now, cfg);
  if (m.state === 'healthy' && wasBad && mem?.incident?.notified_at != null) m.recovered_pending = true;
  const j = judge(m, ledger, now, cfg);
  m = j.mem;
  if (j.judged) { const l = ledger.filter((a) => a.kind !== 'notify' && a.kind !== 'wait').at(-1); l.judged = true; l.fixed = j.judged.fixed; }
  const actions = decide(m, ledger, now, caps, cfg);
  if (actions.some((a) => a.recovered)) m.recovered_pending = false;
  return { mem: m, actions };
}

// The message a watcher sends when it's stuck (or when the Mac is back). Never carries a secret: only signs.
const STUCK = { filevault: 'is stuck at FileVault', hung: 'is frozen', off: 'is off', down: 'is not answering', unknown: 'is out of sight', degraded: 'needs a look' };

const SCREEN_WORDS = { filevault: 'FileVault', desktop: 'a desktop', lock: 'a lock screen', login: 'a login window', blank: 'black', black: 'black', unknown: 'nothing it knows' };

// What the sitter saw, in words a person reads at 3 a.m. (the same words in device/sitter.py).
export function plainSigns(obs) {
  const out = [];
  for (const [k, v] of Object.entries(obs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v == null || k.endsWith('_error') || k === 'eyes') continue;
    if (k === 'video') out.push(v ? 'picture on HDMI' : 'no picture on HDMI');
    else if (k === 'screen') out.push(`the screen shows ${SCREEN_WORDS[v] || v}`);
    else if (k === 'arp') out.push(v ? 'on the network' : 'gone from the network');
    else if (k === 'answers') out.push(v ? 'answers its health check' : "doesn't answer its health check");
    else if (k === 'clock_ticking') out.push(v ? 'its clock is moving' : 'its clock has stopped');
    else if (k === 'heartbeat_age_min') out.push(`its heartbeat is ${v} min old`);
    else if (k === 'beat_min') out.push(`last heartbeat ${v} min ago`);
    else if (k === 'presence') out.push(v ? 'someone is logged in' : 'nobody is logged in');
    else out.push(`${k}=${v}`);
  }
  return out.join('; ') || 'none';
}

export function message(name, mem, act, obs) {
  const since = mem.since != null ? new Date(mem.since).toISOString() : '?';
  if (act.recovered) return { subject: `${name} is back`, body: `${name} is healthy again (state since ${since}).` };
  return {
    subject: `${name} ${STUCK[mem.state] || `needs you (${mem.state})`}`,
    body: [
      `${name} has been ${mem.state} since ${since}.`,
      `Stuck because: ${act.why.replaceAll('<mac>', name)}.`,
      `Signs: ${plainSigns(obs)}.`,
      `Look: housesitter status ${name}; housesitter screenshot ${name}.`,
    ].join('\n'),
  };
}
