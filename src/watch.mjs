// The Mac watches its KVM: `housesitter watch-kvm <mac>`, run on the Mac every minute by a LaunchAgent. The sitter on
// the KVM watches the Mac; this is the other half. If the sitter goes quiet (the KVM is off, unplugged, off the network,
// or its sitter stopped), nothing is left to unlock FileVault or power-cycle the Mac, so the Mac says so: one message
// after `silentMin` minutes of silence, and one when the sitter is back. Same channel as the sitter (ntfy, and email
// through it), same daily email cap: the Mac's sends are handed to the sitter's ledger when it answers again.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SILENT_MIN = 5;
export const EMAIL_PER_DAY = 5;
const DAY = 86400000;

export const statePath = (name, home = os.homedir()) => path.join(home, '.config', 'housesitter', `watch-${name}.json`);
export const loadState = (p, read = fs.readFileSync) => { try { return JSON.parse(read(p, 'utf8')); } catch { return {}; } };

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const ONE_ADDRESS = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

// What the KVM said, if it said anything fresh: the sitter writes status.json every look (interval_sec).
export function fresh(answer, now) {
  const st = answer?.status;
  if (!st?.at) return { ok: false, why: answer ? 'the sitter answered, but has no status yet' : 'no answer from the KVM' };
  const every = (st.interval_sec || 60) * 1000;
  const age = now - st.at;
  return age <= Math.max(3 * every, 180000) ? { ok: true, age } : { ok: false, why: `the sitter's last look was ${Math.round(age / 60000)} min ago` };
}

// Routes to the sitter, tried in order: SSH first (LAN or tailnet), then the outbox gists, so a Mac away from the KVM's
// network still hears it. Each route is { via, ask(a) }; the answer says which one answered.
export function askRoutes(routes) {
  return async (a) => {
    const errors = [];
    for (const r of routes) {
      try { return { ...(await r.ask(a)), via: r.via }; } catch (e) { errors.push(`${r.via}: ${String(e.message || e).slice(0, 160)}`); }
    }
    throw new Error(errors.join('; ') || 'no route to the sitter');
  };
}

// The outbox route: the status the sitter publishes to its outbox gist, read directly; only if that copy is stale, one
// status request through the inbox. (watch_check stays SSH-only on the sitter, so over the outbox the emails this Mac
// sent are handed over later, at the next SSH answer.)
export function outboxAsk({ readStatus, op, now = Date.now }) {
  return async () => {
    const st = await readStatus();
    if (st?.at && fresh({ status: st }, now()).ok) return { status: st };
    const r = await op('status');
    if (!r?.ok) throw new Error(`${r?.code || 'failed'} ${typeof r?.result === 'string' ? r.result : ''}`.trim());
    return { status: r.result };
  };
}

// ntfy, as the sitter sends it (device/sitter.py notify): the email and the account token ride together, and a refused
// email never costs the push.
export async function sendNtfy(n, title, body, { email = null, token = null, fetchFn = fetch } = {}) {
  const post = (headers) => fetchFn(n.url, { method: 'POST', body, headers: { Title: title, Tags: 'house', ...headers } });
  const extra = email ? { Email: email, ...(token ? { Authorization: `Bearer ${token}` } : {}) } : {};
  let r = await post(extra);
  if (email && r.status >= 400 && r.status < 500) {
    let why = '';
    try { why = (await r.json()).error || ''; } catch { /* no body */ }
    r = await post({});
    if (!r.ok) throw new Error(`ntfy answered ${r.status}`);
    return { result: `posted ${r.status} (ntfy wouldn't email: ${(why || `HTTP 400`).slice(0, 100)}; a push only)`, emailed: false };
  }
  if (!r.ok) throw new Error(`ntfy answered ${r.status}`);
  return { result: `posted ${r.status}${email ? ', emailed' : ''}`, emailed: Boolean(email) };
}

// One minute of the watch. Pure but for `ask` (SSH to the sitter) and `send` (the message); returns the new state.
export async function watchOnce({ name, by, notify, ask, send, state = {}, now = Date.now(), silentMin = SILENT_MIN, test = false, emailPerDay }) {
  const s = { ...state, sent: [...(state.sent || [])] };
  const pending = s.sent.filter((e) => !e.reported && now - e.at < DAY);
  let answer = null;
  try { answer = await ask({ by, sent: pending.map(({ at, title, emailed, test: t }) => ({ at, title, emailed, test: t })) }); } catch (e) { s.last_error = String(e.message || e).slice(0, 160); }
  const f = fresh(answer, now);
  // A gap in the watch's own checks (the Mac asleep, restarting, off) is not the KVM's silence: start counting again.
  if (s.last_check_at && now - s.last_check_at > 150000) s.silent_since = null;
  s.last_check_at = now;
  const say = async (title, body) => {
    const t = test ? `TEST: ${title}` : title;
    const b = test ? `TEST (housesitter watch-kvm --test; nothing is wrong). ${body}` : body;
    const cap = emailPerDay ?? notify?.email_per_day ?? EMAIL_PER_DAY;
    const used = (s.sitter_emails_today_at && now - s.sitter_emails_today_at < DAY ? s.sitter_emails_today || 0 : 0) + s.sent.filter((e) => e.emailed && !e.reported && now - e.at < DAY).length;
    const email = notify?.email && ONE_ADDRESS.test(notify.email) && used < cap ? notify.email : null;
    if (!notify?.url) return { result: 'no notify target', emailed: false };
    try {
      const r = await send(t, b, { email });
      s.sent.push({ at: now, title: t, emailed: r.emailed, test: test || undefined });
      return { ...r, delivered: true };
    } catch (e) {
      return { result: `failed: ${String(e.message || e).slice(0, 120)}`, emailed: false, delivered: false };
    }
  };
  if (f.ok) {
    s.last_ok_at = now;
    s.last_error = null;
    if (answer.via) s.last_via = answer.via;
    for (const e of s.sent) if (pending.some((p) => p.at === e.at)) e.reported = true;
    if (answer.emails_today != null) { s.sitter_emails_today = answer.emails_today; s.sitter_emails_today_at = now; }
    let said = null;
    if (s.alerted_at) {
      const silent = s.silent_since ? Math.round((now - s.silent_since) / 60000) : null;
      const r = await say(`${name}'s KVM is back`, `housesitter on the KVM beside ${name} answers again${silent != null ? `, after about ${silent} min` : ''}. It watches ${name} again: FileVault after a restart, a frozen desktop. Look: housesitter doctor ${name}.`);
      s.last_result = r.result;
      said = 'back';
    }
    s.silent_since = null;
    s.alerted_at = null;
    s.sent = s.sent.filter((e) => now - e.at < DAY);
    return { state: s, ok: true, said };
  }
  s.silent_since = s.silent_since || now;
  const quiet = now - s.silent_since;
  if (!s.alerted_at && quiet >= silentMin * 60000) {
    const last = s.last_ok_at ? ` (last heard at ${clock(s.last_ok_at)})` : '';
    const r = await say(`${name}'s KVM is silent`, `${by}, the Mac, hasn't heard from housesitter on its KVM for ${Math.round(quiet / 60000)} min${last}: ${f.why}. Until it answers, nothing unlocks FileVault after a restart or power-cycles a frozen ${name}. The KVM may be off, unplugged or off the network, or its sitter stopped. Look: housesitter doctor ${name}.`);
    s.last_result = r.result;
    // Only a delivered alert counts: a failed one is tried again next minute, and only a delivered one earns a "back".
    if (!r.delivered) return { state: s, ok: false, said: null, why: f.why };
    s.alerted_at = now;
    return { state: s, ok: false, said: 'silent', why: f.why };
  }
  return { state: s, ok: false, said: null, why: f.why };
}

// A node path that survives `brew upgrade`: Homebrew's versioned Cellar path disappears, its bin/ link doesn't.
export function stableNode(execPath, exists = fs.existsSync) {
  if (!/\/Cellar\//.test(execPath)) return execPath;
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => exists(p)) || execPath;
}

// The LaunchAgent: every minute, `housesitter watch-kvm <mac> --once`.
export const agentLabel = (name) => `bot.ouro.housesitter.watch-kvm.${name.replace(/[^A-Za-z0-9.-]/g, '-')}`;
export function plist({ name, node, bin, args = [], home = os.homedir(), pathEnv = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const argv = [node, bin, 'watch-kvm', name, '--once', ...args];
  const log = path.join(home, 'Library', 'Logs', `housesitter-watch-${name}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(agentLabel(name))}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(pathEnv)}</string></dict>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}
