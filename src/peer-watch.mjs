// `housesitter peer watch`: the Mac's counterpart of plugins/housesitter/watch.py. Each tick it peeks at
// Housesitter's gist (a conditional GET, cheap when nothing changed) and wakes the agent on the Mac with
// `ouro msg --to <agent>` once per new message; then it flushes the agent's queued sends if they're due. It marks
// nothing read (the agent does that with `peer inbox`) and writes to GitHub only through flush().
//
// State, beside the peer log: peer-watch.json {etag, woken[], wake_fails, wake_until, read_until}; peer-watch.log,
// one line per action.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SEEN_MAX } from './peer.mjs';

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
const oneLine = (t, n) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const LOG_MAX = 1 << 20;

// The first executable called name on PATH, or null.
export function which(name, PATH = process.env.PATH || '') {
  if (name.includes('/')) return name;
  for (const d of PATH.split(':').filter(Boolean)) {
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
  }
  return null;
}

const runFile = (file, argv) => new Promise((res) => {
  execFile(file, argv, { timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }));
});

// p: a peer() from src/peer.mjs. ouro: the ouro executable (null: not found). bin: the housesitter CLI the wake names.
// exec, clock and print are for tests.
export function peerWatch({ p, dir, agent = 'ouroboros', ouro, bin, every = 30, exec = runFile, clock = Date.now, print = () => {} }) {
  const stateFile = path.join(dir, 'peer-watch.json');
  const logFile = path.join(dir, 'peer-watch.log');
  const log = (line) => {
    const l = `${iso(clock())} ${line}`;
    fs.mkdirSync(dir, { recursive: true });
    try { if (fs.statSync(logFile).size > LOG_MAX) fs.renameSync(logFile, `${logFile}.1`); } catch { /* no log yet */ }
    fs.appendFileSync(logFile, `${l}\n`);
    print(l);
  };

  const wakeText = (fresh) => {
    const n = fresh.length;
    return `${n} new message${n === 1 ? '' : 's'} from Housesitter on the peer link (latest: ${oneLine(fresh.at(-1).text, 200)}). `
      + `Read ${n === 1 ? 'it' : 'them'} with: node ${bin} peer inbox — then answer with peer send `
      + '(add --now only if urgent; a message that says tell-ari: relay it to Ari on Teams).';
  };

  async function read(st) {
    const now = clock();
    if (now < (st.read_until || 0)) return;
    let r;
    try {
      r = await p.peek(st.etag || null);
    } catch (e) {
      if (e.status === 403 || e.status === 429) {
        const until = e.reset ? e.reset * 1000 : now + (e.retryAfter ?? 60) * 1000;
        st.read_until = Math.max(until, now + 1000);
        log(`read rate-limited (HTTP ${e.status}); next read after ${iso(st.read_until)}`);
      } else {
        log(`read failed: ${oneLine(e.message, 300)}`);
      }
      return;
    }
    delete st.read_until;
    if (r.unchanged) { log('tick: unchanged'); return; }
    const woken = new Set(st.woken || []);
    const fresh = r.messages.filter((m) => !woken.has(m.id));
    if (!fresh.length) { st.etag = r.etag; log(`tick: ${r.messages.length} unread, none new`); return; }
    if (now < (st.wake_until || 0)) return; // the etag stays old, so the next read sees them again
    if (!ouro) { backoff(st, now, 'ouro is not on PATH (use --ouro <path>)'); return; }
    const res = await exec(ouro, ['msg', '--to', agent, wakeText(fresh)]);
    if (res.code !== 0) { backoff(st, now, `ouro msg exited ${res.code}: ${oneLine(res.stderr || res.stdout, 300)}`); return; }
    st.woken = [...(st.woken || []), ...fresh.map((m) => m.id)].slice(-SEEN_MAX);
    st.etag = r.etag;
    delete st.wake_fails; delete st.wake_until;
    log(`woke ${agent} for ${fresh.map((m) => m.id).join(', ')}`);
  }

  function backoff(st, now, why) {
    st.wake_fails = (st.wake_fails || 0) + 1;
    const wait = Math.min(900, every * 2 ** st.wake_fails);
    st.wake_until = now + wait * 1000;
    log(`wake failed: ${why}; retry in ${wait} s`);
  }

  async function tick() {
    fs.mkdirSync(dir, { recursive: true });
    const st = readJson(stateFile, {}) || {};
    await read(st);
    writeJson(stateFile, st);
    try {
      const f = await p.flush();
      if (f.sent?.length) log(`flushed ${f.sent.length} queued message${f.sent.length === 1 ? '' : 's'}: ${f.sent.join(', ')}`);
      else if (f.capped) log(`flush capped: ${f.queued} queued until ${f.next_allowed_at}`);
    } catch (e) {
      log(`flush failed: ${oneLine(e.message, 300)}`);
    }
  }

  return {
    tick,
    async run() {
      log(`watching for ${agent} every ${every} s (ouro: ${ouro || 'not found'})`);
      for (;;) {
        await tick().catch((e) => log(`tick failed: ${oneLine(e.message, 300)}`));
        await new Promise((r) => setTimeout(r, every * 1000));
      }
    },
  };
}
