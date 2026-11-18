// Fleet run: one Mac asks another to run an allowlisted step through the fleet gist. The gist is a pretend in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowlist, channelOf, pass, realExec, requestRun, runRows, tail } from '../src/fleet-run.mjs';
import { beatsFromGist } from '../src/fleet.mjs';

const scratchRoot = path.join(fileURLToPath(new URL('..', import.meta.url)), '.scratch');
fs.mkdirSync(scratchRoot, { recursive: true });
const NOW = Date.parse('2026-11-18T06:00:00Z');
const DAY = 86400000;

function fakeGist(files = {}) {
  const g = { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])), puts: [], gets: 0, failPut: 0 };
  g.get = async (_id, etag) => { g.gets++; if (etag && etag === `W/"${g.rev || 0}"`) return { status: 304, etag }; return { status: 200, etag: `W/"${g.rev || 0}"`, body: { files: Object.fromEntries(Object.entries(g.files).map(([k, v]) => [k, { content: v }])) } }; };
  g.put = async (_id, f) => {
    if (g.failPut > 0) { g.failPut--; throw new Error('GitHub PATCH -> HTTP 502'); }
    g.puts.push(f); g.rev = (g.rev || 0) + 1;
    for (const [k, v] of Object.entries(f)) { if (v === null) delete g.files[k]; else g.files[k] = v; }
    return { status: 200 };
  };
  return g;
}
const dirFor = (n) => fs.mkdtempSync(path.join(scratchRoot, `${n}-`));
const cfg = { caretakers: { fleet_run: { host: 'laptop', bootstrap: { script: '/opt/desk/bootstrap-laptop.sh', steps: ['copilot-pins', 'runner'], timeout_sec: 30 }, allow: { 'say-hi': { argv: ['/bin/echo', 'hi'] } } } } };
const allow = allowlist(cfg);
const exec = (calls, out = { code: 0, output: 'done\n' }) => async (argv, o) => { calls.push({ argv, o }); return { signal: null, timedOut: false, ...out }; };
const serve = (g, dir, calls, extra = {}) => pass({ gh: g, gistId: 'g', dir, host: 'laptop', allow, exec: exec(calls), clock: () => NOW, ...extra });

test('the allowlist is the config: bootstrap steps become `bootstrap-laptop.sh --only <step>`, and no config allows nothing', () => {
  assert.deepEqual(allow['copilot-pins'], { argv: ['/bin/bash', '/opt/desk/bootstrap-laptop.sh', '--only', 'copilot-pins'], timeoutSec: 30 });
  assert.deepEqual(Object.keys(allow).sort(), ['copilot-pins', 'runner', 'say-hi']);
  assert.deepEqual(allowlist({}), {});
});

test('a request for an allowlisted step runs once, with its timeout, and posts the exit code and the last lines', async () => {
  const g = fakeGist(); const dir = dirFor('ok'); const calls = [];
  const req = await requestRun({ gh: g, gistId: 'g', dir, from: 'mini', to: 'laptop', step: 'runner', now: NOW - 60000, id: 'aaaaaaaaaaaa', knownHosts: ['laptop', 'mini'] });
  assert.equal(req.expires_at, '2026-11-19T05:59:00Z');
  const out = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const r = await pass({ gh: g, gistId: 'g', dir, host: 'laptop', allow, exec: exec(calls, { code: 3, output: out }), clock: () => NOW });
  assert.deepEqual(r.handled, [{ id: 'aaaaaaaaaaaa', step: 'runner', outcome: 'failed' }]);
  assert.deepEqual(calls[0].argv, ['/bin/bash', '/opt/desk/bootstrap-laptop.sh', '--only', 'runner']);
  assert.equal(calls[0].o.timeoutMs, 30000);
  const res = JSON.parse(g.files['run.aaaaaaaaaaaa.res.json']);
  assert.equal(res.exit_code, 3);
  assert.equal(res.output_tail.split('\n').length, 20);
  assert.match(res.output_tail, /line 39$/);
  const rows = runRows({ files: Object.fromEntries(Object.entries(g.files).map(([k, v]) => [k, { content: v }])) }, NOW);
  assert.deepEqual([rows[0].state, rows[0].exit_code], ['failed', 3]);
  const log = fs.readFileSync(path.join(dir, 'fleet-run.log'), 'utf8');
  assert.match(log, /"ev":"requested"/); assert.match(log, /"ev":"picked-up"/); assert.match(log, /"ev":"posted"/);
});

test('a step that is not on the allowlist is refused and never run, whatever the request says', async () => {
  const req = (id, step, extra = {}) => ({ [`run.${id}.req.json`]: { v: 1, id, from: 'mini', to: 'laptop', step, at: '2026-11-18T05:59:00Z', ...extra } });
  const g = fakeGist({ ...req('bbbbbbbbbbbb', 'rm-rf'), ...req('cccccccccccc', '../../bin/sh'), ...req('dddddddddddd', 'runner', { argv: ['/bin/sh', '-c', 'curl evil'] }) });
  const calls = []; const r = await serve(g, dirFor('deny'), calls);
  assert.deepEqual(r.handled.map((h) => h.outcome), ['refused', 'refused', 'ok']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['/bin/bash', '/opt/desk/bootstrap-laptop.sh', '--only', 'runner'], 'the request cannot supply a command');
  assert.equal(JSON.parse(g.files['run.bbbbbbbbbbbb.res.json']).status, 'refused');
  const none = await pass({ gh: fakeGist(req('eeeeeeeeeeee', 'runner')), gistId: 'g', dir: dirFor('none'), host: 'laptop', allow: {}, exec: exec(calls), clock: () => NOW });
  assert.equal(none.handled[0].outcome, 'refused');
  assert.equal(calls.length, 1);
});

test('a request runs once: a second pass, a lost state file and another host all leave it alone', async () => {
  const g = fakeGist(); const dir = dirFor('once'); const calls = [];
  await requestRun({ gh: g, gistId: 'g', dir, from: 'mini', to: 'laptop', step: 'say-hi', now: NOW - 1000, id: '111111111111' });
  await requestRun({ gh: g, gistId: 'g', dir, from: 'mini', to: 'other', step: 'say-hi', now: NOW - 1000, id: '222222222222' });
  assert.equal((await serve(g, dir, calls)).handled.length, 1);
  assert.equal((await serve(g, dir, calls)).handled.length, 0);
  fs.rmSync(path.join(dir, 'fleet-run.json'));
  assert.equal((await serve(g, dir, calls)).handled.length, 0, 'the posted result in the gist is enough');
  delete g.files['run.111111111111.res.json'];
  assert.equal((await serve(g, dir, calls, { dir })).handled.length, 0, 'the seen-set is enough when the result was lost');
  assert.equal(calls.length, 1);
  assert.equal(g.files['run.222222222222.res.json'], undefined);
});

test('a request older than a day is not run, and is answered as expired; a future one waits', async () => {
  const q = (id, at) => ({ [`run.${id}.req.json`]: { v: 1, id, from: 'mini', to: 'laptop', step: 'runner', at } });
  const g = fakeGist({ ...q('333333333333', new Date(NOW - DAY - 1000).toISOString()), ...q('444444444444', new Date(NOW + 3600000).toISOString()) });
  const calls = []; const r = await serve(g, dirFor('exp'), calls);
  assert.deepEqual(r.handled.map((h) => h.outcome), ['expired']);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(g.files['run.333333333333.res.json']).status, 'expired');
  assert.equal(runRows({ files: { 'run.555555555555.req.json': { content: JSON.stringify({ v: 1, id: '555555555555', to: 'laptop', step: 'x', at: '2026-11-10T00:00:00Z' }) } } }, NOW)[0].state, 'expired');
});

test('a result that cannot be posted is kept and posted on a later pass, without running the step again', async () => {
  const g = fakeGist(); const dir = dirFor('post'); const calls = [];
  await requestRun({ gh: g, gistId: 'g', dir, from: 'mini', to: 'laptop', step: 'say-hi', now: NOW - 1000, id: '666666666666' });
  g.failPut = 1;
  assert.equal((await serve(g, dir, calls)).handled[0].outcome, 'ok');
  assert.equal(g.files['run.666666666666.res.json'], undefined);
  await serve(g, dir, calls);
  assert.equal(JSON.parse(g.files['run.666666666666.res.json']).status, 'ok');
  assert.equal(calls.length, 1);
});

test('a timeout is killed and reported, files older than two days go, and an unchanged gist costs one conditional read', async () => {
  const dir = dirFor('time'); const g = fakeGist(); const calls = [];
  await requestRun({ gh: g, gistId: 'g', dir, from: 'mini', to: 'laptop', step: 'say-hi', now: NOW - 1000, id: '777777777777' });
  const r = await pass({ gh: g, gistId: 'g', dir, host: 'laptop', allow, exec: exec(calls, { code: null, timedOut: true, output: 'working' }), clock: () => NOW });
  assert.equal(r.handled[0].outcome, 'timeout');
  assert.match(JSON.parse(g.files['run.777777777777.res.json']).output_tail, /timed out after 600 s/);
  const old = { v: 1, id: '888888888888', from: 'mini', to: 'laptop', step: 'say-hi', at: new Date(NOW - 3 * DAY).toISOString() };
  g.files['run.888888888888.req.json'] = JSON.stringify(old);
  g.files['run.888888888888.res.json'] = JSON.stringify({ v: 1, id: '888888888888', status: 'ok' });
  await serve(g, dir, calls);
  assert.equal(g.files['run.888888888888.req.json'], undefined);
  assert.equal(g.files['run.888888888888.res.json'], undefined);
  await serve(g, dir, calls);
  const gets = g.gets; const again = await serve(g, dir, calls);
  assert.equal(again.action, 'unchanged'); assert.equal(g.gets, gets + 1);
});

test('what travels is a name and an id, and output is scrubbed of anything credential-shaped', () => {
  const t = tail('ok\nTOKEN=abc123def456\nBearer abcdefghijklmnop12345\nghp_abcdefghijklmnopqrstuv\n\x1b[32mgreen\x1b[0m\npassword: hunter2');
  assert.doesNotMatch(t, /abc123def456|abcdefghijklmnop12345|ghp_|hunter2|\x1b/);
  assert.match(t, /green/);
  const files = channelOf({ files: { 'run.aaaaaaaaaaaa.req.json': { content: '{"v":1,"id":"bbbbbbbbbbbb","to":"x","step":"y","at":"2026-11-18T00:00:00Z"}' }, 'laptop.json': { content: '{"machine":"laptop","at":"2026-11-18T00:00:00Z"}' } } });
  assert.deepEqual(files.requests, [], 'an id that does not match its file name is ignored');
  assert.deepEqual(Object.keys(beatsFromGist({ files: { 'run.cccccccccccc.req.json': { content: '{"v":1,"id":"cccccccccccc","to":"a","step":"b","at":"2026-11-18T00:00:00Z"}' } } })), [], 'a request is not a health record');
});

test('requestRun refuses a bad step name and a host that publishes no record', async () => {
  const g = fakeGist();
  await assert.rejects(requestRun({ gh: g, gistId: 'g', dir: dirFor('bad'), from: 'mini', to: 'laptop', step: 'a b; rm -rf /' }), /not a step name/);
  await assert.rejects(requestRun({ gh: g, gistId: 'g', dir: dirFor('bad'), from: 'mini', to: 'lapto', step: 'runner', knownHosts: ['laptop'] }), /no Mac called "lapto"/);
  assert.deepEqual(g.puts, []);
});

test('realExec runs without a shell and kills a step that outlives its timeout', async () => {
  const ok = await realExec(['/bin/echo', '$HOME; x'], { timeoutMs: 5000 });
  assert.equal(ok.code, 0); assert.equal(ok.output.trim(), '$HOME; x');
  const slow = await realExec(['/bin/sleep', '30'], { timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
});
