// A live rehearsal of freeze recovery on this Mac, with a stand-in for the Copilot app that this script hangs.
//
//   node scripts/rehearse-freeze.mjs
//
// The stand-in is a real process (this Node, run from a pretend app bundle so `ps` names it like the app) that serves the
// same local socket as the app, from a pretend Copilot folder with three sessions. The script then does what a frozen
// window does: SIGSTOP. A stopped process takes the connection and says nothing, and ignores SIGTERM until it is
// continued, so the whole recovery runs for real: the probe times out, a real `sample` is taken, SIGTERM does nothing,
// SIGKILL goes to the exact pids, the stand-in is started again, and the working sessions are resumed through its socket.
// The only stand-in part is the window probe: a faceless process has no accessibility tree, so it answers "timeout" when
// the process is stopped. Nothing here touches the real app or its sessions. Scratch files are under ./.rehearsal-*/ and
// are removed at the end.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pass, realHeartbeatDeps } from '../src/heartbeat.mjs';
import { DONE, MID_TURN, makeHome } from '../test/fake_app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(process.cwd(), '.rehearsal-'));
const home = path.join(root, 'copilot-home');
const bundle = path.join(root, 'Rehearsal Copilot.app');
const exe = path.join(bundle, 'Contents', 'MacOS', 'rehearsal');
fs.mkdirSync(path.dirname(exe), { recursive: true });
fs.symlinkSync(process.execPath, exe);
const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003'];
makeHome(home, [
  { id: ids[0], title: 'working one', mode: 'autopilot', running: true, events: MID_TURN },
  { id: ids[1], title: 'idle two', events: DONE },
  { id: ids[2], title: 'working three', mode: 'interactive', events: MID_TURN },
]);

const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);
const standIn = () => {
  const child = spawn(exe, [path.join(here, '..', 'test', 'fake_app.mjs'), home], { stdio: 'ignore', detached: true });
  child.unref();
  return child;
};
let child = standIn();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stopped = () => spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim().startsWith('T');
const told = [];

const state = path.join(root, 'state');
const d = realHeartbeatDeps({ home: root, copilotHome: home, state, hackamore: 'none' });
Object.assign(d, {
  appDir: () => bundle,
  hackamore: ['none'],
  probeWindow: async () => (child && alive(child.pid) && stopped() ? { state: 'timeout' } : { state: 'ok' }),
  open: async () => { child = standIn(); return { code: 0, stderr: '' }; },
  tell: async (text) => { told.push(text); say(`TOLD THE AGENT: ${text}`); return { ok: true }; },
  evidenceRoot: path.join(root, 'evidence'),
  related: async () => [],
});
const opts = { app: 'Rehearsal Copilot', t: { freeze: 8000, beatGap: 6000, minBeats: 3, socketMs: 1500, confirmSocketMs: 2500, windowMs: 1000, confirmWindowMs: 1000, term: 4000, kill: 4000, up: 20000, grace: 0, delivery: 8000, retry: 6000, tries: 2 } };

let ok = false;
try {
  await new Promise((r) => setTimeout(r, 1500));
  say(`stand-in running: pid ${child.pid}`);
  const first = await pass(opts, d, () => {});
  say(`beat 1: ${first.action} (socket ${first.socket}, window ${first.window})`);
  const old = child.pid;
  process.kill(child.pid, 'SIGSTOP');
  say(`hung it: kill -STOP ${old}`);
  for (let i = 2; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const r = await pass(opts, d, (l) => say(l.replace(/^\S+ heartbeat: /, '  ')));
    say(`beat ${i}: ${r.action}${r.failures?.length ? ` (${r.failures.join(', ')})` : ''}`);
    if (r.action === 'freeze') {
      say(`recovered: ok=${r.ok}; new pid ${child.pid} (was ${old}); old process alive: ${alive(old)}`);
      say(`evidence: ${r.evidence}: ${fs.readdirSync(r.evidence).join(', ')}`);
      say(`main thread of the hung process, from its sample: ${(r.main_thread || []).join(' > ')}`);
      say(`resumed: ${(r.resume || []).map((x) => `${x.id.slice(0, 8)} ${x.outcome}`).join('; ')}`);
      ok = r.ok && !alive(old) && told.length === 1;
      break;
    }
  }
} finally {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true });
}
say(ok ? 'REHEARSAL PASSED' : 'REHEARSAL FAILED');
process.exit(ok ? 0 : 1);
