// housesitter restart-copilot --load-shed: batch work is reniced only while the load is over the limit, by pattern and by
// ancestry; the app, git, launchd daemons and Housesitter/Shepherd are never touched; a process already low is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLedger, pass, pick, readLedger, renderLoad, settings } from '../src/load-shed.mjs';

const P = (pid, ppid, command, nice = 0) => ({ pid, ppid, nice, command });
const TABLE = [
  P(1, 0, '/sbin/launchd'),
  P(100, 1, '/Applications/GitHub Copilot.app/Contents/MacOS/Copilot'),
  P(101, 100, '/usr/local/bin/node /x/copilot-runtime/index.js'),
  P(102, 101, 'node /w/node_modules/.bin/stryker run'),
  P(103, 102, 'node /w/node_modules/@stryker-mutator/core/worker.js'),
  P(104, 103, 'node --test test/a.test.mjs'),
  P(105, 101, '/usr/bin/git status'),
  P(106, 101, 'python3 brand/tools/derive.py --check'),
  P(107, 106, 'magick in.png out.webp'),
  P(108, 101, 'node /Users/a/housesitter/bin/housesitter.mjs restart-copilot --heartbeat'),
  P(109, 101, 'node /w/shepherd/bin/shepherd.mjs watch'),
  P(110, 1, '/usr/libexec/trustd'),
  P(111, 101, 'zsh'),
  P(112, 102, '/usr/bin/git -C /w log'),
  P(113, 101, 'node --test already', 15),
  P(114, 101, 'Microsoft Edge --headless=new --remote-debugging-port=0'),
  P(115, 101, '/opt/node/bin/node /w/shepherd/bin/shepherd.mjs --playwright-thing'),
];

test('matches by pattern and by ancestry, never the excluded', () => {
  const { matched } = pick(TABLE, settings());
  assert.deepEqual(matched.map((p) => p.pid).sort((a, b) => a - b), [102, 103, 104, 106, 107, 113, 114]);
  assert.equal(matched.find((p) => p.pid === 103).why, 'descendant of 102');
});

test('a git child of a match, the app, launchd daemons, Housesitter and Shepherd stay out', () => {
  const { matched } = pick(TABLE, settings());
  for (const pid of [1, 100, 101, 105, 108, 109, 110, 111, 112, 115]) assert.ok(!matched.some((p) => p.pid === pid), `pid ${pid}`);
});

test('a descendant of a matched root that is itself excluded is skipped with its own children', () => {
  const t = [P(2, 1, 'node stryker run'), P(3, 2, 'git gc'), P(4, 3, 'node child')];
  assert.deepEqual(pick(t, settings()).matched.map((p) => p.pid), [2]);
});

test('Housesitter\'s own process and its ancestors are never reniced', () => {
  const t = [P(2, 1, 'node stryker run'), P(3, 2, 'node something')];
  assert.deepEqual(pick(t, settings(), new Set([3])).matched.map((p) => p.pid), [2]);
});

test('already-niced processes are matched but not touched', () => {
  const { matched, todo } = pick(TABLE, settings());
  assert.ok(matched.some((p) => p.pid === 113));
  assert.ok(!todo.some((p) => p.pid === 113));
});

test('config adds patterns and excludes, or replaces the defaults', () => {
  const t = [P(2, 1, 'node weird-batch.js'), P(3, 1, 'node stryker'), P(4, 1, 'node keepme stryker')];
  const s = settings({ load_shed: { patterns: ['weird-batch'], exclude: ['keepme'] } });
  assert.deepEqual(pick(t, s).matched.map((p) => p.pid), [2, 3]);
  assert.deepEqual(pick(t, settings({ load_shed: { patterns: ['weird-batch'], replace_patterns: true } })).matched.map((p) => p.pid), [2]);
});

test('test runners match: Go test binaries, go/cargo test, pytest, vitest, jest, npm/pnpm test and their children', () => {
  const t = [
    P(2, 1, '/var/folders/ab/xyz/T/go-build123456/b001/cli.test -test.v'),
    P(3, 1, 'go test ./...'), P(4, 1, 'cargo test --all'), P(5, 1, 'python -m pytest -x'),
    P(6, 1, 'node /w/node_modules/.bin/vitest run'), P(7, 1, 'node /w/node_modules/.bin/jest'),
    P(8, 1, 'npm test'), P(9, 8, 'sh -c tsc'), P(10, 1, 'pnpm run test'),
    P(11, 1, 'go build ./...'), P(12, 1, 'node server.js'), P(13, 3, '/usr/bin/git diff'),
  ];
  assert.deepEqual(pick(t, settings()).matched.map((p) => p.pid), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

function fake({ load, cores = 18, procs = TABLE, cfg = {}, fail = [] } = {}) {
  const log = { renice: [], bg: [], rows: [], state: null };
  return {
    log,
    deps: {
      now: () => Date.parse('2026-11-17T20:20:00Z'), load: () => load, cores: () => cores, procs: () => procs, self: () => 999, cfg: () => cfg,
      renice: (pid, n) => { if (fail.includes(pid)) return false; log.renice.push([pid, n]); return true; },
      background: (pid) => { log.bg.push(pid); return true; },
      readState: () => log.state, writeState: (o) => { log.state = o; }, ledger: (r) => log.rows.push(r),
    },
  };
}

test('under 2x the cores nothing is reniced, but the load is recorded', async () => {
  const f = fake({ load: 36 });
  const r = await pass({}, f.deps);
  assert.equal(r.action, 'ok');
  assert.deepEqual(f.log.renice, []);
  assert.equal(f.log.rows[0].load1, 36);
  assert.equal(f.log.rows[0].reniced, 0);
});

test('over the limit every batch process goes to +15 with background QoS, each logged with pid, command and load', async () => {
  const f = fake({ load: 94.2 });
  const lines = [];
  const r = await pass({}, f.deps, (l) => lines.push(l));
  assert.equal(r.action, 'shed');
  assert.deepEqual(f.log.renice.map((x) => x[0]), [102, 103, 104, 106, 107, 114]);
  assert.ok(f.log.renice.every(([, n]) => n === 15));
  assert.deepEqual(f.log.bg, [102, 103, 104, 106, 107, 114]);
  assert.equal(lines.length, 6);
  assert.match(lines[0], /load-shed: renice \+15 \+ taskpolicy -b pid 102 node .*stryker run \(load 94.2 > 36/);
  assert.equal(f.log.state.reniced.length, 6);
  assert.equal(f.log.rows[0].reniced, 6);
});

test('a second pass over the same processes (now at +15) renices nothing', async () => {
  const again = TABLE.map((p) => (p.nice === 0 && [102, 103, 104, 106, 107, 114].includes(p.pid) ? { ...p, nice: 15 } : p));
  const f = fake({ load: 94, procs: again });
  const lines = [];
  const r = await pass({}, f.deps, (l) => lines.push(l));
  assert.deepEqual(f.log.renice, []);
  assert.equal(r.action, 'busy-nothing');
  await pass({}, f.deps, (l) => lines.push(l));
  assert.equal(lines.length, 1, 'the "nothing left" line is said once, not every 30 s');
});

test('the threshold is configurable per core or absolute, and the job can be disabled', async () => {
  assert.equal((await pass({}, fake({ load: 30, cfg: { load_shed: { threshold_per_core: 1 } } }).deps)).action, 'shed');
  assert.equal((await pass({}, fake({ load: 50, cfg: { load_shed: { threshold: 60 } } }).deps)).action, 'ok');
  const off = fake({ load: 500, cfg: { load_shed: { enabled: false } } });
  assert.equal((await pass({}, off.deps)).action, 'disabled');
  assert.deepEqual(off.log.renice, []);
});

test('a dry run renices and records nothing; a process that would not renice is not claimed', async () => {
  const d = fake({ load: 94 });
  await pass({ dry_run: true }, d.deps);
  assert.deepEqual(d.log.renice, []);
  assert.equal(d.log.rows.length, 0);
  const f = fake({ load: 94, fail: [102] });
  const r = await pass({}, f.deps);
  assert.ok(!r.reniced.some((x) => x.pid === 102));
});

test('the ledger keeps a bounded tail and the status line shows the last pass and the trend', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
  const file = path.join(dir, 'load-ledger.jsonl');
  for (let i = 0; i < 30; i++) appendLedger(file, { at: `t${i}`, load1: 100 - i * 3, action: i < 10 ? 'shed' : 'ok', reniced: i === 0 ? 6 : 0 }, 10);
  assert.ok(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length <= 210);
  const rows = readLedger(dir, 5);
  assert.equal(rows.length, 5);
  const text = renderLoad({ at: 'x', load1: 13, cores: 18, limit: 36, action: 'ok', matched: 0, reniced: [] }, rows);
  assert.match(text, /load 13 on 18 cores \(limit 36\); under the limit/);
  assert.match(text, /last 5 passes: load min 13 \/ max 25 \/ now 13/);
  assert.match(renderLoad(null), /not running yet/);
  fs.rmSync(dir, { recursive: true, force: true });
});
