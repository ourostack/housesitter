// housesitter restart-copilot --plugin-updates: a fake sessions folder, a fake plugin cache and a pretend Mac decide
// when the app restarts for a plugin update. Nothing here needs the real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedFixed, cmpVersion, decide, findUpdates, installPluginAgent, loadedPlugins, newestReleases, pass, pluginPlist, PLUGIN_LABEL, reasonFor } from '../src/plugin-updates.mjs';

const DESK_RULE_STUB = path.join(import.meta.dirname, 'fixtures', 'desk-plugin-update.stub.mjs');
const HELPER = { 'hooks/lib/current-release.cjs': 'x', 'hooks/copilot-skill-current.cjs': 'x' };
const SKILL = (desc, body = 'body') => `---\ndescription: ${desc}\n---\n${body}\n`;

// A loaded Desk 3.2.154 (with or without the helper files) and a cached 3.2.167 with the given files; `stub` puts Desk's rule
// (or a given module source) in the cached release.
function deskCase({ loaded = {}, next = {}, helper = true, module = null }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-desk-rule-'));
  const sessionsDir = path.join(home, 'sessions'), cacheDir = path.join(home, 'cache');
  const base = { 'skills/s/SKILL.md': SKILL('old'), 'hooks/copilot-hooks.json': '{}', 'hooks/lib/helper.cjs': 'h1' };
  plugin(path.join(sessionsDir, 'agency-plugin-X101.p101', 'root-0', 'desk'), 'desk', '3.2.154', { files: { ...base, ...(helper ? HELPER : {}), ...loaded } });
  const entry = path.join(cacheDir, 'entries', 'entry-0');
  plugin(entry, 'desk', '3.2.167', { files: { ...base, ...HELPER, ...next } });
  if (module === 'stub') { fs.mkdirSync(path.join(entry, 'mcp', 'src', 'runtime'), { recursive: true }); fs.copyFileSync(DESK_RULE_STUB, path.join(entry, 'mcp', 'src', 'runtime', 'plugin-update.js')); }
  else if (module) { fs.mkdirSync(path.join(entry, 'mcp', 'src', 'runtime'), { recursive: true }); fs.writeFileSync(path.join(entry, 'mcp', 'src', 'runtime', 'plugin-update.js'), module); }
  fs.writeFileSync(path.join(cacheDir, 'cache_index.json'), JSON.stringify({ entries: { 'copilot:github:org/repo:plugins/desk@release': { spec: 'copilot:github:org/repo:plugins/desk@release', dir_name: 'entry-0', fetched_at: 1, resolved_sha: SHA } } }));
  return { sessionsDir, cacheDir };
}

async function verdict(ag) {
  const m = mac(ag);
  const r = await pass({ app: 'Fake Copilot' }, m.deps);
  return { restart: m.started.length === 1, code: r.decision.code };
}

const BUNDLE = '/Applications/Fake Copilot.app';
const SHA = 'a'.repeat(40);

function plugin(dir, name, version, { claude = false, files = {} } = {}) {
  const d = claude ? path.join(dir, '.claude-plugin') : dir;
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({ name, version }));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
}

// sessions: { <pid>: { desk: '3.2.154', ... } }; cache: [{ spec, name, version, fetched_at }]
function fakePluginCache(sessions, cache) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-plugins-'));
  const sessionsDir = path.join(home, 'sessions'), cacheDir = path.join(home, 'cache');
  for (const [pid, plugins] of Object.entries(sessions)) {
    Object.entries(plugins).forEach(([name, v], i) => plugin(path.join(sessionsDir, `agency-plugin-X${pid}.p${pid}`, `root-${i}`, name), name, v, { claude: name === 'crew', files: { 'skills/s/SKILL.md': 'old text' } }));
  }
  const entries = {};
  cache.forEach((c, i) => {
    const dir = `entry-${i}`;
    plugin(path.join(cacheDir, 'entries', dir), c.name, c.version, { files: c.files ?? { 'skills/s/SKILL.md': 'new text' } });
    entries[c.spec] = { spec: c.spec, dir_name: dir, fetched_at: c.fetched_at ?? 1000 + i, resolved_sha: SHA };
  });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'cache_index.json'), JSON.stringify({ entries }));
  return { home, sessionsDir, cacheDir };
}

const spec = (n, ref = 'main') => `copilot:github:org/repo:plugins/${n}@${ref}`;

// The app (pid 100) owns the session processes 101 and 102; pid 900 is a terminal CLI that is not the app's.
const procs = [
  { pid: 100, ppid: 1, command: `${BUNDLE}/Contents/MacOS/fake` },
  { pid: 101, ppid: 100, command: 'agency copilot' }, { pid: 102, ppid: 100, command: 'agency copilot' },
  { pid: 900, ppid: 1, command: 'agency copilot' },
];

function mac(ag, { person = { open: true, why: 'open' }, running = true, state = {}, busy = false, lastRun = {}, now = Date.parse('2026-11-15T16:00:00Z') } = {}) {
  const m = { started: [], saved: [], logs: [], state, now };
  m.deps = {
    now: () => m.now, sleep: async () => {}, appDir: () => BUNDLE, ps: async () => (running ? procs : []), appExe: async () => 'fake', startedAt: async () => 5,
    sessionsDir: ag.sessionsDir, cacheDir: ag.cacheDir,
    person: async () => person, runInProgress: () => busy, lastRun: () => lastRun,
    readState: () => m.state, writeState: (o) => { m.state = o; m.saved.push(o); },
    startRestart: async (reason) => { m.started.push(reason); return { ok: true }; },
    log: (l) => m.logs.push(l),
    plan: async () => ({ sessions: { total: 5, busy: 3, idle: 2 } }),
  };
  return m;
}

test('cmpVersion: numeric parts, not text; a pre-release sorts first', () => {
  assert.equal(cmpVersion('3.2.154', '3.2.167'), -1);
  assert.equal(cmpVersion('3.2.9', '3.2.10'), -1);
  assert.equal(cmpVersion('3.2', '3.2.0'), 0);
  assert.equal(cmpVersion('v1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(cmpVersion('2.32.0', '2.32.0'), 0);
});

test('loadedPlugins reads both manifest places and only processes the app owns', () => {
  const ag = fakePluginCache({ 101: { desk: '3.2.154', crew: '0.2.23' }, 900: { desk: '1.0.0' } }, []);
  const got = loadedPlugins(ag.sessionsDir, (pid) => pid !== 900);
  assert.deepEqual(got.map((l) => `${l.name} ${l.version} ${l.pid}`).sort(), ['crew 0.2.23 101', 'desk 3.2.154 101']);
});

test('newestReleases: Copilot branch entries only, never a pinned commit or another harness, newest fetch wins', () => {
  const ag = fakePluginCache({}, [
    { spec: spec('desk', 'release'), name: 'desk', version: '3.2.167', fetched_at: 2000 },
    { spec: spec('desk', 'b'.repeat(40)), name: 'desk', version: '3.2.82', fetched_at: 3000 },
    { spec: spec('desk', 'main').replace('copilot:', 'claude:'), name: 'desk', version: '9.9.9', fetched_at: 4000 },
    { spec: spec('cit'), name: 'cit', version: '0.1.81', fetched_at: 100 },
  ]);
  const n = newestReleases(ag.cacheDir);
  assert.equal(n.get('desk').version, '3.2.167');
  assert.equal(n.get('cit').version, '0.1.81');
  assert.equal(newestReleases(path.join(ag.home, 'nope')).size, 0, 'no cache is no news');
});

test('findUpdates: the oldest loaded copy is the from, a newer copy is no update, and a watch list narrows it', () => {
  const ag = fakePluginCache({ 101: { desk: '3.2.154', 'ms-desk': '2.32.0', superpowers: '1.0.0' }, 102: { desk: '3.2.167', 'ms-desk': '2.33.0' } }, [
    { spec: spec('desk', 'release'), name: 'desk', version: '3.2.167' },
    { spec: spec('ms-desk'), name: 'ms-desk', version: '2.32.0' },
    { spec: spec('superpowers'), name: 'superpowers', version: '7.0.0' },
  ]);
  const loaded = loadedPlugins(ag.sessionsDir, () => true), newest = newestReleases(ag.cacheDir);
  const u = findUpdates(loaded, newest, { watched: ['desk', 'ms-desk'] }).updates;
  assert.deepEqual(u.map((x) => [x.name, x.from, x.to, x.sessions]), [['desk', '3.2.154', '3.2.167', 1]]);
  assert.deepEqual(findUpdates(loaded, newest).updates.map((x) => x.name), ['desk', 'superpowers'], 'by default every loaded plugin counts');
  assert.equal(reasonFor(u), 'a plugin update (desk 3.2.154 → 3.2.167)');
});

test('decide: restarts for an update with nobody at the Mac, and holds for each reason, in order', () => {
  const up = [{ name: 'desk', from: '1', to: '2' }];
  const base = { appRunning: true, updates: up, state: {}, now: Date.parse('2026-11-15T16:00:00Z'), person: { open: true } };
  assert.equal(decide(base).action, 'restart');
  assert.equal(decide({ ...base, appRunning: false }).code, 'app-not-running');
  assert.equal(decide({ ...base, updates: [] }).code, 'current');
  assert.equal(decide({ ...base, person: { open: false, why: 'someone used this Mac 3 s ago' } }).code, 'person-active');
  assert.equal(decide({ ...base, person: null }).code, 'person-active', 'an unreadable gate is a person');
  assert.equal(decide({ ...base, runInProgress: true }).code, 'restart-running');
  assert.equal(decide({ ...base, state: { restarted_at: '2026-11-15T10:30:00Z' } }).code, 'cooldown');
  assert.equal(decide({ ...base, state: { restarted_at: '2026-11-15T09:59:00Z' } }).action, 'restart', 'over 6 hours ago');
  assert.equal(decide({ ...base, state: { restarted_at: '2026-11-14T00:00:00Z', attempted: { desk: '2' } } }).code, 'already-restarted');
  assert.equal(decide({ ...base, state: { attempted: { desk: '1.9' } } }).action, 'restart', 'a newer release than the one tried');
});

test('pass: working sessions do not hold it, and the restart runs with the reason', async () => {
  const ag = fakePluginCache({ 101: { desk: '3.2.154' }, 102: { desk: '3.2.167' }, 900: { desk: '1.0.0' } }, [{ spec: spec('desk', 'release'), name: 'desk', version: '3.2.167' }]);
  const m = mac(ag);
  const said = [];
  const r = await pass({ app: 'Fake Copilot' }, m.deps, (l) => said.push(l));
  assert.equal(r.restarted, true);
  assert.deepEqual(m.started, ['a plugin update (desk 3.2.154 → 3.2.167)']);
  assert.equal(r.loaded_processes, 2, 'the terminal CLI (pid 900) is not the app and is not counted');
  assert.match(m.logs[0], /^2026-11-15T16:00:00Z plugin-updates: restart started: a plugin update \(desk 3\.2\.154 → 3\.2\.167\); changed: desk: skills\/s\/SKILL\.md$/);
  assert.equal(m.state.restarted_at, '2026-11-15T16:00:00.000Z');
  assert.deepEqual(m.state.pending, { desk: '3.2.167' });
});

test('pass: holds and logs while a person is using the Mac, for six hours after a restart, and when nothing is behind', async () => {
  const ag = fakePluginCache({ 101: { desk: '3.2.154' } }, [{ spec: spec('desk', 'release'), name: 'desk', version: '3.2.167' }]);
  const a = mac(ag, { person: { open: false, why: 'someone used this Mac 1 s ago (need 90 s idle)' } });
  await pass({ app: 'Fake Copilot' }, a.deps);
  assert.deepEqual(a.started, []);
  assert.match(a.logs[0], /hold \(person-active\): a plugin update \(desk 3\.2\.154 → 3\.2\.167\): someone used this Mac 1 s ago/);
  const b = mac(ag, { state: { restarted_at: '2026-11-15T12:00:00Z' } });
  await pass({ app: 'Fake Copilot' }, b.deps);
  assert.deepEqual(b.started, []);
  assert.match(b.logs[0], /hold \(cooldown\).*last restart was 240 min ago; at most one in 6 h/);
  const current = fakePluginCache({ 101: { desk: '3.2.167' } }, [{ spec: spec('desk', 'release'), name: 'desk', version: '3.2.167' }]);
  const c = mac(current);
  await pass({ app: 'Fake Copilot' }, c.deps);
  assert.deepEqual(c.started, []);
  assert.match(c.logs[0], /hold \(current\)/);
  const d = mac(ag, { running: false });
  await pass({ app: 'Fake Copilot' }, d.deps);
  assert.match(d.logs[0], /hold \(app-not-running\)/);
});

test('pass: a restart that finished stops further restarts for that release; one that failed may be tried after the cooldown', async () => {
  const ag = fakePluginCache({ 101: { desk: '3.2.154' } }, [{ spec: spec('desk', 'release'), name: 'desk', version: '3.2.167' }]);
  const started = '2026-11-14T00:00:00.000Z';
  const done = mac(ag, { state: { restarted_at: started, pending: { desk: '3.2.167' } }, lastRun: { state: 'done', started } });
  await pass({ app: 'Fake Copilot' }, done.deps);
  assert.deepEqual(done.started, []);
  assert.match(done.logs[0], /hold \(already-restarted\)/);
  const failed = mac(ag, { state: { restarted_at: started, pending: { desk: '3.2.167' } }, lastRun: { state: 'failed', step: 'failed at quit', started } });
  await pass({ app: 'Fake Copilot' }, failed.deps);
  assert.deepEqual(failed.started, ['a plugin update (desk 3.2.154 → 3.2.167)']);
  assert.match(failed.logs[0], /did not finish \(failed: failed at quit\)/);
});

test('pass --dry-run: says what it would do, how many working sessions it would ask, and changes and logs nothing', async () => {
  const ag = fakePluginCache({ 101: { desk: '3.2.154' } }, [{ spec: spec('desk', 'release'), name: 'desk', version: '3.2.167' }]);
  const m = mac(ag, { state: { restarted_at: '2026-11-14T00:00:00Z', pending: { desk: '3.2.167' } }, lastRun: { state: 'failed', started: '2026-11-14T00:00:00.000Z' } });
  const before = JSON.stringify(m.state);
  const r = await pass({ app: 'Fake Copilot', dry_run: true }, m.deps);
  assert.equal(r.decision.action, 'restart');
  assert.match(r.would_run, /^housesitter restart-copilot --resume --detach --why "a plugin update \(desk 3\.2\.154 → 3\.2\.167\)" --person-wait 300$/);
  assert.deepEqual(r.sessions, { total: 5, busy: 3, idle: 2 });
  assert.deepEqual([m.started, m.logs, m.saved], [[], [], []]);
  assert.equal(JSON.stringify(m.state), before);
});

test('the launchd agent runs one quiet pass every five minutes and is written where Desk looks', async () => {
  const text = pluginPlist({ node: '/n/node', bin: '/b/housesitter.mjs', env: { HOME: '/h' }, log: '/h/l.log' });
  assert.match(text, new RegExp(`<string>${PLUGIN_LABEL}</string>`));
  assert.match(text, /<string>restart-copilot<\/string>\s*<string>--plugin-updates<\/string>\s*<string>--quiet<\/string>/);
  assert.match(text, /<key>StartInterval<\/key><integer>300<\/integer>/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-plugin-agent-'));
  const calls = [];
  const r = await installPluginAgent({ node: '/n/node', bin: '/b/housesitter.mjs', env: {}, home, uid: 501, launchctl: async (a) => { calls.push(a.join(' ')); return { code: 0, stderr: '' }; } });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${PLUGIN_LABEL}.plist`)), true);
  assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['bootout', 'bootstrap']);
  assert.equal((await installPluginAgent({ node: 'n', bin: 'b', env: {}, home: path.join(home, 'x'), dry: true })).dry_run, true);
  assert.equal(fs.existsSync(path.join(home, 'x')), false, 'a dry run writes nothing');
});

test('changedFixed: a skill, hook, agent or Desk tool schema that differs counts; docs, the version and Desk runtime code do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-fixed-'));
  const make = (name, version, files) => { const d = path.join(dir, `${name}-${version}`); plugin(d, name, version, { files }); return d; };
  const base = { 'skills/a/SKILL.md': 'same', 'hooks/h.cjs': 'same', 'agents/x.md': 'same', 'mcp/src/tools.js': 'v1', 'mcp/src/tool-schemas.js': 'v1', 'README.md': 'v1', 'artifacts/pack.bin': 'v1' };
  const oldDesk = make('desk', '1.0.0', base);
  assert.deepEqual(changedFixed(oldDesk, make('desk', '1.0.1', { ...base, 'mcp/src/tools.js': 'v2', 'README.md': 'v2', 'artifacts/pack.bin': 'v2', 'docs/x.md': 'new' }), 'desk'), [], 'a runtime-only Desk release is not a reason to restart');
  assert.deepEqual(changedFixed(oldDesk, make('desk', '1.0.2', { ...base, 'skills/a/SKILL.md': 'edited' }), 'desk'), ['skills/a/SKILL.md']);
  assert.deepEqual(changedFixed(oldDesk, make('desk', '1.0.3', { ...base, 'hooks/new.cjs': 'x' }), 'desk'), ['hooks/new.cjs'], 'a new hook counts');
  assert.deepEqual(changedFixed(oldDesk, make('desk', '1.0.4', { ...base, 'mcp/src/tool-schemas.js': 'v2' }), 'desk'), ['mcp/src/tool-schemas.js'], "a change to Desk's MCP tool schemas counts");
  const noAgent = { ...base }; delete noAgent['agents/x.md'];
  assert.deepEqual(changedFixed(oldDesk, make('desk', '1.0.5', noAgent), 'desk'), ['agents/x.md'], 'a removed agent counts');
  const other = { 'skills/a.md': 'x', 'hooks/h.cjs': 'x', 'tools/t.js': 'x', 'mcp/src/tool-schemas.js': 'x', 'README.md': 'x' };
  const o1 = make('cit', '0.1.0', other);
  assert.deepEqual(changedFixed(o1, make('cit', '0.1.1', { ...other, 'tools/t.js': 'changed', 'README.md': 'changed', 'mcp/src/tool-schemas.js': 'changed' }), 'cit'), [], 'a version bump, docs, a CLI and a file only Desk treats as fixed are nothing for another plugin');
  assert.deepEqual(changedFixed(o1, make('cit', '0.1.2', { ...other, 'hooks/h.cjs': 'changed' }), 'cit'), ['hooks/h.cjs'], 'any hook change counts for another plugin');
});

test('a newer release that changes nothing fixed per process is runtime-only: no update, no restart, no look at the gate', async () => {
  const ag = fakePluginCache({ 101: { desk: '3.2.154' } }, [{ spec: spec('desk', 'release'), name: 'desk', version: '3.2.167', files: { 'skills/s/SKILL.md': 'old text', 'mcp/src/new.js': 'runtime' } }]);
  let gate = 0;
  const m = mac(ag);
  m.deps.person = async () => { gate++; return { open: true, why: 'open' }; };
  const r = await pass({ app: 'Fake Copilot' }, m.deps);
  assert.equal(r.decision.code, 'runtime-only');
  assert.deepEqual([m.started, gate], [[], 0]);
  assert.deepEqual(r.runtime_only.map((u) => [u.name, u.from, u.to]), [['desk', '3.2.154', '3.2.167']]);
  assert.match(m.logs[0], /hold \(runtime-only\): a plugin update \(desk 3\.2\.154 → 3\.2\.167\): the newer release changes nothing a process fixes at its start/);
});

test("Desk's rule decides with the helper files live: body-only skill and hook script changes are runtime-only, descriptions and hook registration restart", async () => {
  const body = { 'skills/s/SKILL.md': SKILL('old', 'new body') };
  assert.deepEqual(await verdict(deskCase({ next: body, module: 'stub' })), { restart: false, code: 'runtime-only' });
  assert.deepEqual(await verdict(deskCase({ next: { 'skills/s/SKILL.md': SKILL('new words') }, module: 'stub' })), { restart: true, code: 'update' });
  assert.deepEqual(await verdict(deskCase({ next: { 'hooks/lib/helper.cjs': 'h2' }, module: 'stub' })), { restart: false, code: 'runtime-only' });
  assert.deepEqual(await verdict(deskCase({ next: { 'hooks/copilot-hooks.json': '{"new":1}' }, module: 'stub' })), { restart: true, code: 'update' });
});

test("without the helper files the loaded Desk still needs a restart for a skill body change, so Desk's rule says so too", async () => {
  assert.deepEqual(await verdict(deskCase({ helper: false, next: { 'skills/s/SKILL.md': SKILL('old', 'new body') }, module: 'stub' })), { restart: true, code: 'update' });
});

test("no Desk module, or a module that throws or does not load, falls back to changedFixed", async () => {
  const body = { 'skills/s/SKILL.md': SKILL('old', 'new body') };
  assert.deepEqual(await verdict(deskCase({ next: body, module: null })), { restart: true, code: 'update' }, 'changedFixed counts any skill change');
  const throws = 'export function changesPerProcess() { throw new Error("boom"); }\n';
  assert.deepEqual(await verdict(deskCase({ next: body, module: throws })), { restart: true, code: 'update' });
  assert.deepEqual(await verdict(deskCase({ next: body, module: 'export const x = ;\n' })), { restart: true, code: 'update' }, 'a module that does not load');
  const runtime = { 'mcp/src/new.js': 'runtime' };
  assert.deepEqual(await verdict(deskCase({ next: runtime, module: throws })), { restart: false, code: 'runtime-only' }, 'the fallback still ignores Desk runtime');
});
