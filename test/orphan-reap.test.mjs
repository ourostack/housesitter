import test from 'node:test';
import assert from 'node:assert/strict';
import { pickOrphans, settings, parseEtime, pass } from '../src/orphan-reap.mjs';

const H = 3_600_000;
const P = (pid, ppid, command, ageH = 5, rssKb = 100000) => ({ pid, ppid, ageMs: ageH * H, rssKb, command });
const s = settings({});
const scratch = () => '/Users/a/code/x-worktrees/lane1';

test('parseEtime reads ps elapsed time', () => {
  assert.equal(parseEtime('05:10'), 310000);
  assert.equal(parseEtime('2:03:04'), 7384000);
  assert.equal(parseEtime('1-00:00:01'), 86401000);
  assert.equal(parseEtime('junk'), null);
});

test('an orphaned lane browser and its children are picked', () => {
  const procs = [
    P(10, 1, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --user-data-dir=/tmp/github-browser-abc'),
    P(11, 10, 'Edge Helper (GPU)'),
  ];
  const [r] = pickOrphans(procs, s);
  assert.deepEqual(r.pids, [10, 11]);
  assert.equal(r.kind, 'browser');
});

test('a young browser, a parented browser and Ari\'s own Edge are left alone', () => {
  assert.equal(pickOrphans([P(10, 1, 'chrome-headless-shell --x', 0.5)], s).length, 0);
  assert.equal(pickOrphans([P(10, 99, 'chrome-headless-shell --x')], s).length, 0);
  assert.equal(pickOrphans([P(10, 1, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')], s).length, 0);
});

test('a dev server is reaped only from a scratch folder', () => {
  const procs = [P(20, 1, '/usr/bin/python3 -m http.server 8788')];
  assert.equal(pickOrphans(procs, s, scratch).length, 1);
  assert.equal(pickOrphans(procs, s, () => '/Users/a/code/shepherd').length, 0);
  assert.equal(pickOrphans(procs, s, () => null).length, 0);
});

test('copilot runtimes and protected pids are never picked', () => {
  const procs = [P(30, 1, 'node vite preview --copilot-runtime'), P(31, 1, 'python -m http.server 1')];
  assert.deepEqual(pickOrphans(procs, s, scratch, new Set([31])), []);
});

test('pass kills each tree once and a dry run kills nothing', async () => {
  const killed = [];
  const deps = (dry) => ({
    now: () => 0, cfg: () => ({}), self: () => 999,
    procs: () => [P(999, 5, 'node housesitter'), P(10, 1, 'chrome-headless-shell'), P(11, 10, 'helper')],
    cwd: () => null, kill: (p) => { killed.push(p); return true; },
    readState: () => null, writeState: () => {},
  });
  const dry = await pass({ dry_run: true }, deps(), () => {});
  assert.equal(killed.length, 0);
  assert.equal(dry.reaped.length, 1);
  const r = await pass({}, deps(), () => {});
  assert.deepEqual(killed, [10, 11]);
  assert.equal(r.action, 'reaped');
});

test('orphan_reap.enabled false turns it off', async () => {
  const r = await pass({}, { now: () => 0, cfg: () => ({ orphan_reap: { enabled: false } }) }, () => {});
  assert.equal(r.action, 'disabled');
});

test('an orphaned Playwright WebKit and its helpers are picked, but the system WebKit services of an app never are', () => {
  const pw = '/Users/a/Library/Caches/ms-playwright/webkit-2158/';
  const procs = [
    P(40, 1, `${pw}pw_run.sh --inspector-pipe`),
    P(41, 1, `${pw}Playwright.app/Contents/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent`),
    P(42, 1, '/custom/browsers/webkit-2158/Playwright.app/Contents/MacOS/Playwright --headless'),
    P(50, 1, '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent', 24, 9_000_000),
    P(51, 1, '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking'),
  ];
  const picked = pickOrphans(procs, s);
  assert.deepEqual(picked.map((r) => r.root.pid).sort(), [40, 41, 42]);
  assert.ok(picked.every((r) => r.kind === 'browser'));
});
