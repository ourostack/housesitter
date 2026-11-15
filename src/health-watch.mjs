// `housesitter restart-copilot --health-watch`: after any restart, crash recovery or reboot, follow every session that was
// resumed for six hours, with no model turns: launchd runs one pass a minute.
//
// For each resumed session it asks four plain questions of the session's own history and the app's database:
//   did it take a turn since the app came back?         not within 5 min → send the resume once more
//   is it erroring (a session error after its last turn, or still flagged interrupted with no turn since)? → same
//   is it stuck busy (working, and no step in its history for 90 min)?                                        → same
//   is it still broken 10 min after that second message?  → it is reported, by name, through the agent, once
// What is healthy is never reported. `restart-copilot --status` shows the watch: how many are healthy, waiting, asked
// again, or broken.
//
// The roster comes from whoever resumed the sessions: the resume watcher (resume-only.json), or a restart or recovery
// job (last.json); the newest one that this watch has not followed yet starts a new six hours.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_APP, T, realDeps, resumeText, sendTo, skipOf, snapshot, stateDir, tookTurnSince } from './copilot-app.mjs';
import { hhmm, iso, readJson, realTell, short, writeJson } from './recovery.mjs';

export const HW = {
  window: 6 * 3600000, // how long a restart's sessions are followed
  turn: 5 * 60000, // a resumed session must take a turn within this
  stuck: 90 * 60000, // busy with no step in its history for this long
  again: 10 * 60000, // how long a session gets after the second resume message before it is called broken
  deliver: 60000, // how long one send may take
};

const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };

// A session error after the last turn that started since `since`: it failed and has not tried again.
export function erroredSince(lines, since) {
  let err = null, turn = null;
  for (const l of lines) {
    if (!l || (!l.includes('error') && !l.includes('assistant.turn_start'))) continue;
    const e = parse(l);
    const at = Date.parse(e?.timestamp || '');
    if (!e || !(at > since)) continue;
    if (e.type === 'assistant.turn_start') turn = at;
    else if (/^session\.error$|\.error$/.test(e.type) && !/tool\./.test(e.type)) err = { at, message: String(e.data?.message || e.data?.error || e.type).slice(0, 160) };
  }
  return err && !(turn && turn > err.at) ? err : null;
}

// What is wrong with one session now, or null. `x`: { since, now, lines, mtime, row, working, asked }.
export function diagnose({ since, now, lines, mtime, row, working, t = HW }) {
  if (!row) return { kind: 'gone' };
  const turned = tookTurnSince(lines, since);
  const err = erroredSince(lines, since);
  if (err) return { kind: 'erroring', why: `an error after its last turn: ${err.message}` };
  if (!turned) {
    if (now - since < t.turn) return { kind: 'waiting', why: 'has not yet had time to take a turn' };
    return { kind: 'silent', why: row.interrupted ? `no turn since the app came back, and the app still flags it interrupted` : 'no turn since the app came back' };
  }
  if (working && mtime && now - mtime > t.stuck) return { kind: 'stuck', why: `busy, with no step in its history for ${Math.round((now - mtime) / 60000)} min` };
  return null;
}

// The roster a new generation of sessions starts with, from the newest record of a resume. null when there is nothing new.
export function importRoster(dir, current) {
  const a = readJson(path.join(dir, 'resume-only.json'));
  const b = readJson(path.join(dir, 'last.json'));
  const cands = [];
  if (a?.resumed) {
    const m = String(a.key || '').match(/:(\d+)$/);
    cands.push({ source: `resume:${a.key}:${a.at}`, since: m ? Number(m[1]) : Date.parse(a.at), at: Date.parse(a.at), why: 'the app starting again', sessions: a.resumed.map((x) => ({ id: x.id, title: x.title || null, outcome: x.outcome })) });
  }
  if (b?.resume && b.restarted_at) cands.push({ source: `run:${b.started_at}`, since: Date.parse(b.restarted_at), at: Date.parse(b.restarted_at), why: b.kind === 'freeze' ? 'a frozen window' : b.kind === 'crash' ? 'a crash' : 'a restart', sessions: b.resume.map((x) => ({ id: x.id, title: x.title || null, outcome: x.outcome })) });
  const fresh = cands.filter((c) => c.sessions.length && c.source !== current?.source && Number.isFinite(c.since) && (!current || c.at > (current.at || 0))).sort((x, y) => y.at - x.at)[0];
  return fresh || null;
}

// One pass. Returns the state it left and what it did; tells the agent only about sessions that stay broken.
export async function pass(opts, deps, say = () => {}) {
  const t = { ...HW, ...(opts.t || {}) };
  const now = deps.now();
  const out = (m) => say(`${iso(now)} health-watch: ${m}`);
  const st = deps.readState() || {};
  const fresh = importRoster(deps.state, st.roster);
  if (fresh) {
    if (!opts.dry_run) deps.writeState({ ...st, roster: { ...fresh, begun: iso(now), until: iso(fresh.since + t.window), told: [], sessions: Object.fromEntries(fresh.sessions.filter((s) => !/^gone/.test(s.outcome || '')).map((s) => [s.id, { title: s.title, outcome: s.outcome, status: 'pending' }])) } });
    out(`following ${fresh.sessions.length} session(s) resumed after ${fresh.why} (${hhmm(fresh.since)}) until ${hhmm(fresh.since + t.window)}`);
    if (opts.dry_run) return { action: 'import', roster: fresh };
    return pass(opts, deps, say);
  }
  const r = st.roster;
  if (!r) return { action: 'none' };
  if (now >= Date.parse(r.until)) {
    if (!r.finished && !opts.dry_run) { deps.writeState({ ...st, roster: { ...r, finished: iso(now) } }); out('the six hours are over'); }
    return { action: 'finished', roster: r };
  }
  const skip = skipOf(opts, deps);
  const rows = new Map((await deps.rows(Object.keys(r.sessions))).map((x) => [x.id, x]));
  const snap = new Map((await snapshot(deps, now, skip)).map((x) => [x.id, x]));
  const acts = [];
  for (const [id, s] of Object.entries(r.sessions)) {
    if (skip.some((p) => id.startsWith(p)) || s.status === 'gone') continue;
    const h = deps.history(id);
    const sn = snap.get(id);
    const dx = diagnose({ since: r.since, now, lines: h.lines, mtime: h.mtime, row: rows.get(id), working: sn?.state === 'busy', t });
    s.checked = iso(now);
    if (!s.title && sn?.title) s.title = sn.title;
    if (!dx) { if (s.status !== 'ok') out(`${short(id)} ${s.title || ''}: healthy${s.resent ? ' after the second resume' : ''}`); s.status = 'ok'; delete s.problem; continue; }
    if (dx.kind === 'gone') { s.status = 'gone'; continue; }
    if (dx.kind === 'waiting') continue;
    s.problem = `${dx.kind}: ${dx.why}`;
    if (!s.resent) {
      if (opts.dry_run) { acts.push({ id, would: 'resend', problem: s.problem }); continue; }
      const sent = await sendTo(deps, id, resumeText({ at: r.since, why: `${r.why} (this is a second message: you had not taken a turn, or were failing, or had stopped)` }), t.deliver);
      s.resent = iso(now); s.status = 'asked-again';
      out(`${short(id)} ${s.title || ''}: ${s.problem}; sent the resume once more (${sent.ok ? sent.reply : `refused: ${sent.error || sent.reply}`})`);
      acts.push({ id, resent: sent.ok });
    } else if (now - Date.parse(s.resent) >= t.again) {
      if (s.status !== 'broken') out(`${short(id)} ${s.title || ''}: still broken after the second resume: ${s.problem}`);
      s.status = 'broken';
    } else s.status = 'asked-again';
  }
  const broken = Object.entries(r.sessions).filter(([, s]) => s.status === 'broken');
  const key = broken.map(([id]) => id).sort().join(',');
  if (broken.length && !(r.told || []).includes(key) && !opts.dry_run) {
    const lines = broken.map(([id, s]) => `${s.title ? `"${s.title}" ` : ''}(${short(id)}): ${s.problem}`).join('; ');
    const total = Object.keys(r.sessions).length;
    await deps.tell(`After the restart at ${hhmm(r.since)} (${r.why}), ${broken.length} of ${total} resumed session${total === 1 ? '' : 's'} stayed broken even after I sent the resume a second time: ${lines}. They need a person or a fresh message from you; the other ${total - broken.length} are fine.`);
    r.told = [...(r.told || []), key];
    out(`told once about ${broken.length} broken session(s)`);
  }
  if (!opts.dry_run) deps.writeState({ ...st, roster: r, last_pass: iso(now) });
  return { action: 'checked', roster: r, acts, counts: counts(r) };
}

export function counts(r) {
  const c = { ok: 0, pending: 0, 'asked-again': 0, broken: 0, gone: 0 };
  for (const s of Object.values(r?.sessions || {})) c[s.status] = (c[s.status] || 0) + 1;
  return c;
}

export function realHealthDeps({ home = os.homedir(), copilotHome, hackamore, state = stateDir(home) } = {}) {
  const base = realDeps({ copilotHome, hackamore, state });
  const file = path.join(state, 'health-watch.json');
  return {
    ...base,
    state,
    readState: () => readJson(file, {}),
    writeState: (o) => writeJson(file, o),
    tell: realTell({ state, home }),
    // The app's own flags for these sessions.
    rows: async (ids) => {
      if (!ids.length) return [];
      const list = ids.map((i) => `'${String(i).replace(/[^0-9a-f-]/gi, '')}'`).join(',');
      return (await base.sql(`SELECT id, is_running AS running, was_interrupted AS interrupted FROM sessions WHERE archived_at IS NULL AND id IN (${list})`));
    },
  };
}

// ---------- what --status shows ----------

export function readRecovery(dir = stateDir(), now = Date.now()) {
  const w = readJson(path.join(dir, 'health-watch.json'), {});
  const b = readJson(path.join(dir, 'heartbeat.json'), {});
  let incidents = [];
  try { incidents = fs.readFileSync(path.join(dir, 'incidents.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-5); } catch { /* none yet */ }
  return { watch: w.roster || null, last_pass: w.last_pass || null, beat_at: b.beat_at || null, beat_age_s: b.beat_at ? Math.round((now - Date.parse(b.beat_at)) / 1000) : null, app: b.app || null, bad: b.bad || null, incidents };
}

export function renderRecovery(r, now = Date.now()) {
  const L = [];
  if (r.beat_at) L.push(`heartbeat: last run ${r.beat_age_s} s ago${r.beat_age_s > 180 ? ' (STALE: the job may not be running)' : ''}${r.bad ? `; the app is failing its probe since ${r.bad.since} (${r.bad.failures.join(', ')})` : '; the app answers'}`);
  else L.push('heartbeat: not running yet (restart-copilot --install-recovery)');
  const w = r.watch;
  if (w) {
    const c = counts(w);
    const over = now >= Date.parse(w.until);
    L.push(`health watch: ${Object.keys(w.sessions).length} session(s) resumed after ${w.why} at ${hhmm(w.since)}: ${c.ok} healthy, ${c.pending} waiting, ${c['asked-again']} asked again, ${c.broken} BROKEN${c.gone ? `, ${c.gone} gone` : ''}; ${over ? 'the six hours ended ' : 'following until '}${hhmm(Date.parse(w.until))}`);
    for (const [id, s] of Object.entries(w.sessions)) if (s.status !== 'ok' && s.status !== 'gone') L.push(`  ${s.status} ${short(id)} ${s.title || ''}${s.problem ? `: ${s.problem}` : ''}`);
  } else L.push('health watch: nothing to follow yet');
  for (const i of r.incidents) L.push(`  ${i.at} ${i.kind}${i.cause ? ` (${i.cause})` : ''}${i.ok === false ? ' FAILED' : ''}${i.evidence ? `: ${i.evidence}` : ''}`);
  return L.join('\n');
}

export { DEFAULT_APP, T };
