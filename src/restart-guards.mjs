// What a restart of the GitHub Copilot app could lose, and the guards that hold it back (used by app-bloat.mjs).
// Only the app's memory is at risk; everything on disk (histories, worktrees, branches, uncommitted files, the database) is not
// touched by a restart. So the guards cover what lives in memory or has not reached disk yet:
//   queue        queued user or cross-session messages (the app keeps a durable copy in app_state, and the web view in
//                localStorage; a fresh one means a message is still waiting to be delivered)
//   awaiting     an ask_user, plan-approval, permission or elicitation request nobody has answered
//   mid-tool     a tool call that started and never finished, which the running flag can miss
//   draft        an unsent composer draft (the web view's localStorage)
//   background   an async shell or background agent a session owns and is still waiting on
//   automation   a schedule that is due now or about to be: it would fire into a closed app
// Anything a guard cannot read holds the restart (never a guess). After a restart, snapshotState() before and after must match
// (compareStates): same sessions, same worktrees (branch and `git status`), schedules re-armed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loopState } from '@ouro.bot/shepherd';

export const FRESH_MS = 24 * 3600000;
export const DUE_LEAD_MS = 3 * 60000;
const AWAIT = /ask_user|user_input|exit_plan|plan_approval|elicitation|permission|ask_question/i;
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const short = (id) => String(id).slice(0, 8);

// Requests in a session's history that were opened and never closed since the session last started or resumed.
// Returns { waits: [what], tools: [what] }. A stop by the person (abort) or a shutdown closes everything.
export function openRequests(lines) {
  let open = new Map();
  for (const l of lines) {
    if (!l) continue;
    const e = parse(l);
    if (!e) continue;
    const d = e.data || {};
    if (e.type === 'session.start' || e.type === 'session.resume' || e.type === 'session.shutdown' || (e.type === 'abort' && (!d.reason || d.reason === 'user_initiated'))) { open = new Map(); continue; }
    if (e.type === 'tool.execution_start') open.set(`t:${d.toolCallId}`, { kind: AWAIT.test(d.toolName || '') ? 'wait' : 'tool', what: d.toolName || 'tool' });
    else if (e.type === 'tool.execution_complete') open.delete(`t:${d.toolCallId}`);
    else if (/\.requested$/.test(e.type || '')) {
      const key = `r:${d.requestId || d.toolCallId || e.id}`;
      const what = e.type.replace(/\.requested$/, '');
      open.set(key, { kind: AWAIT.test(e.type) || AWAIT.test(d.toolName || '') ? 'wait' : 'tool', what: d.toolName ? `${what} ${d.toolName}` : what });
    } else if (/\.(completed|resolved|cancelled|responded)$/.test(e.type || '')) open.delete(`r:${d.requestId || d.toolCallId || ''}`);
  }
  const v = [...open.values()];
  return { waits: v.filter((x) => x.kind === 'wait').map((x) => x.what), tools: v.filter((x) => x.kind === 'tool').map((x) => x.what) };
}

// The shells and background agents a session is still waiting on (Shepherd's loop reading, named for the guard).
export const backgroundOf = (lines) => { const v = loopState(lines); const m = /^waiting on (.+)$/.exec(v.why || ''); return v.working && m ? m[1].split(', ') : []; };

// A queued-message entry: { messages: [{ text, createdAt }] }. Live when any message was queued inside the freshness window.
export function liveQueued(value, now) {
  let o = value;
  if (typeof o === 'string') o = parse(o);
  const ms = Array.isArray(o?.messages) ? o.messages : Array.isArray(o) ? o : [];
  return ms.filter((m) => { const t = Date.parse(m?.createdAt || ''); return !(t > 0) || now - t < FRESH_MS; }).length;
}

// A composer draft's text, whatever the key the web view stores it under.
export function draftText(value) {
  const o = typeof value === 'string' ? parse(value) : value;
  const s = o?.state ?? o;
  const t = s?.promptText ?? s?.text ?? s?.prompt ?? s?.draft ?? s?.content ?? '';
  return String(t).trim();
}

const idIn = (k) => (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(k) || [null])[0];

// Pure. `inv`: { sessions: [{ id, title, hist: { open: {waits, tools}, background: [..] } | null }], queued: [{ key, value }] | null,
// drafts: [{ key, value }] | null, automations: [{ id, session_id, next_run_at, paused }] | null, now }.
// Returns the holds: [{ guard, session, why }]. A source that is null (unreadable) holds the restart.
export function holds(inv) {
  const out = [];
  const add = (guard, session, why) => out.push({ guard, session: session || null, why });
  for (const s of inv.sessions || []) {
    const h = s.hist;
    const who = `${short(s.id)}${s.title ? ` "${String(s.title).slice(0, 30)}"` : ''}`;
    if (!h) { add('unreadable', s.id, `${who}: its history could not be read`); continue; }
    if (h.open?.waits?.length) add('awaiting', s.id, `${who} is waiting on an answer (${h.open.waits.slice(0, 2).join(', ')})`);
    if (h.open?.tools?.length) add('mid-tool', s.id, `${who} is in the middle of a tool call (${h.open.tools.slice(0, 2).join(', ')})`);
    if (h.background?.length) add('background', s.id, `${who} owns ${h.background.slice(0, 2).join(', ')}`);
  }
  if (inv.queued == null) add('unreadable', null, 'the app\'s queued messages could not be read');
  else for (const q of inv.queued) { const n = liveQueued(q.value, inv.now); if (n) add('queue', idIn(q.key), `${n} queued message(s) for ${short(idIn(q.key) || q.key)} are not delivered yet`); }
  if (inv.drafts == null) add('unreadable', null, 'the app\'s composer drafts could not be read');
  else for (const dr of inv.drafts) if (draftText(dr.value)) add('draft', idIn(dr.key), `an unsent composer draft (${dr.key.replace(/[0-9a-f-]{36}/g, (x) => short(x))})`);
  if (inv.automations == null) add('unreadable', null, 'the app\'s schedules could not be read');
  else for (const a of inv.automations) {
    const t = Date.parse(a.next_run_at || '');
    if (!a.paused && t > 0 && Math.abs(t - inv.now) <= DUE_LEAD_MS) add('automation', a.session_id, `a schedule for ${short(a.session_id || a.id)} is due at ${a.next_run_at}`);
  }
  return out;
}

export const renderHolds = (hs) => `${hs.length} thing(s) would be lost or missed: ${hs.slice(0, 4).map((h) => `${h.guard}: ${h.why}`).join('; ')}${hs.length > 4 ? `; and ${hs.length - 4} more` : ''}`;

// What must be the same before and after: sessions, each worktree's branch and uncommitted files, schedules armed.
// `st`: { sessions: [{ id, title, mode }], trees: { [id]: { path, branch, status } }, automations: [{ id, paused, next_run_at }] }.
export function compareStates(before, after) {
  const problems = [];
  const have = new Map((after.sessions || []).map((s) => [s.id, s]));
  for (const s of before.sessions || []) {
    const a = have.get(s.id);
    if (!a) { problems.push({ what: 'session-missing', session: s.id, why: `${short(s.id)} "${s.title || ''}" did not come back` }); continue; }
    if (s.mode !== a.mode) problems.push({ what: 'mode-changed', session: s.id, why: `${short(s.id)} mode ${s.mode} -> ${a.mode}` });
  }
  for (const [id, b] of Object.entries(before.trees || {})) {
    const a = after.trees?.[id];
    if (!a) problems.push({ what: 'worktree-missing', session: id, why: `${short(id)}: worktree ${b.path} is gone` });
    else if (a.branch !== b.branch) problems.push({ what: 'branch-changed', session: id, why: `${short(id)}: branch ${b.branch} -> ${a.branch}` });
    else if (a.status !== b.status) problems.push({ what: 'files-changed', session: id, why: `${short(id)}: uncommitted files changed in ${b.path}` });
  }
  const auto = new Map((after.automations || []).map((a) => [a.id, a]));
  for (const a of before.automations || []) {
    const n = auto.get(a.id);
    if (!n) problems.push({ what: 'schedule-missing', session: null, why: `schedule ${short(a.id)} is gone` });
    else if (!a.paused && !n.paused && !n.next_run_at) problems.push({ what: 'schedule-unarmed', session: null, why: `schedule ${short(a.id)} has no next run` });
    else if (!a.paused && n.paused) problems.push({ what: 'schedule-paused', session: null, why: `schedule ${short(a.id)} was paused by the restart` });
  }
  return { ok: problems.length === 0, sessions: (before.sessions || []).length, problems };
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 26, ...opts });
const SQLITE = '/usr/bin/sqlite3';
const ID_COLS = `SELECT s.id, s.title, s.mode, w.branch AS wbranch, wt.path AS path FROM sessions s LEFT JOIN workspaces w ON w.session_id = s.id LEFT JOIN worktrees wt ON wt.id = w.worktree_id WHERE s.archived_at IS NULL AND (w.id IS NULL OR w.archived_at IS NULL) AND (s.execution_location = 'local' OR s.execution_location IS NULL)`;

// The web view's localStorage, read from a copy of its files (the app keeps it open). Rows: { key, value }.
export function readLocalStorage(home = os.homedir()) {
  const root = path.join(home, 'Library', 'WebKit', 'com.github.githubapp', 'WebsiteData');
  const found = [];
  const walk = (d, depth = 0) => { if (depth > 8) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.name === 'localstorage.sqlite3') found.push(p); } };
  walk(root);
  if (!found.length) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ls-'));
  try {
    const rows = [];
    for (const f of found) {
      const copy = path.join(tmp, `${rows.length}-${path.basename(f)}`);
      for (const sfx of ['', '-wal', '-shm']) { try { fs.copyFileSync(f + sfx, copy + sfx); } catch { /* the side files may not exist */ } }
      const r = run(SQLITE, ['-readonly', '-json', copy, 'SELECT key, hex(value) AS h FROM ItemTable']);
      if (r.status !== 0) return null;
      for (const x of r.stdout.trim() ? JSON.parse(r.stdout) : []) rows.push({ key: x.key, value: Buffer.from(x.h, 'hex').toString('utf16le') });
    }
    return rows;
  } catch { return null; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export const gitState = (dir) => {
  if (!dir || !fs.existsSync(dir)) return null;
  const b = run('/usr/bin/git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const s = run('/usr/bin/git', ['-C', dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (b.status !== 0 || s.status !== 0) return null;
  return { path: dir, branch: b.stdout.trim(), status: crypto.createHash('sha1').update(s.stdout).digest('hex'), files: s.stdout.split('\0').filter(Boolean).length };
};

// The real reads. `app` is Shepherd's deps (sql, history); `localStorage` is injectable for tests.
export function realGuardDeps({ app, now = () => Date.now(), localStorage = readLocalStorage, git = gitState } = {}) {
  const rows = () => app.sql(ID_COLS);
  const inventory = async () => {
    const t = now();
    const sessions = [];
    for (const r of await rows()) {
      let hist = null;
      try { const h = app.history(r.id); const fresh = h.mtime >= t - FRESH_MS; hist = fresh ? { open: openRequests(h.lines), background: backgroundOf(h.lines) } : { open: { waits: [], tools: [] }, background: [] }; } catch { hist = null; }
      sessions.push({ id: r.id, title: r.title, hist });
    }
    let queued = null, automations = null;
    try {
      queued = await app.sql("SELECT key, value FROM app_state WHERE key LIKE 'session-queued-restart-recovery-durable:%'");
      automations = [...await app.sql('SELECT id, session_id, next_run_at, paused_at IS NOT NULL AS paused FROM session_automations'),
        ...(await app.sql("SELECT id, NULL AS session_id, next_run_at, 0 AS paused FROM workflows WHERE enabled = 1 AND interval != 'manual'")).map((w) => w)].map((a) => ({ ...a, paused: Boolean(a.paused) }));
    } catch { /* null holds */ }
    const ls = localStorage();
    if (queued && ls) queued = [...queued, ...ls.filter((x) => /^session-queued-restart-recovery:/.test(x.key))];
    return { sessions, queued: ls ? queued : null, drafts: ls ? ls.filter((x) => /draft/i.test(x.key)) : null, automations, now: t };
  };
  const state = async () => {
    const trees = {};
    const sessions = [];
    for (const r of await rows()) {
      sessions.push({ id: r.id, title: r.title, mode: r.mode || null });
      const g = r.path ? git(r.path) : null;
      if (g) trees[r.id] = g;
    }
    const automations = (await app.sql('SELECT id, next_run_at, paused_at IS NOT NULL AS paused FROM session_automations')).map((a) => ({ ...a, paused: Boolean(a.paused) }));
    return { at: new Date(now()).toISOString(), sessions, trees, automations };
  };
  return { inventory, state };
}
