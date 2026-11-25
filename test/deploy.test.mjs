// `housesitter deploy`: a release is built and checked before anything points at it, the swap is one rename, jobs that
// ran the clone are rewritten and reloaded once, and only three releases are kept. Fakes only: a temp git remote and
// clone, a temp home, and a fake launchctl. Nothing touches real launchd or the real ~/Library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentLink, deploy, liveBin, programArgs, releasesRoot, renderDeploy, shimPath } from '../src/deploy.mjs';

const UID = 501;
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const binSource = (version, broken = false, dryBroken = false, dryNoMenu = false) => (broken ? 'const x = ;\n' : `if (process.argv.includes('--version')) { console.log('${version}'); process.exit(0); }\n${dryBroken ? "if (process.argv.includes('--dry-run')) console.log('cannot quit: hackamore failed: ERR_MODULE_NOT_FOUND');\n" : ''}${dryNoMenu ? "if (process.argv.includes('--dry-run')) { console.log('  2. cannot quit: hackamore sees no Quit menu item in GitHub Copilot'); process.exit(1); }\n" : ''}`);

// A remote that publishes releases as tags, and a clone of it where the Mac's job used to run from.
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-deploy-'));
  const remote = path.join(base, 'remote');
  const home = path.join(base, 'home');
  const clone = path.join(home, 'code', 'housesitter');
  fs.mkdirSync(remote);
  git(remote, ['init', '-q', '-b', 'main']);
  const f = { base, remote, home, clone, agents: path.join(home, 'Library', 'LaunchAgents'), root: path.join(releasesRoot(home), 'housesitter') };
  f.publish = (version, { broken = false, dryBroken = false, dryNoMenu = false } = {}) => {
    fs.mkdirSync(path.join(remote, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'bin', 'housesitter.mjs'), binSource(version, broken, dryBroken, dryNoMenu));
    fs.writeFileSync(path.join(remote, 'bin', 'shepherd.mjs'), binSource(version));
    fs.writeFileSync(path.join(remote, 'package.json'), `${JSON.stringify({ name: 'fixture', version, private: true, type: 'module' })}\n`);
    git(remote, ['add', '-A']);
    git(remote, ['-c', 'commit.gpgsign=false', 'commit', '-qm', `release ${version}`]);
    git(remote, ['tag', `v${version}`]);
    return git(remote, ['rev-parse', 'HEAD']).slice(0, 12);
  };
  f.publish('0.9.0');
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  git(base, ['clone', '-q', remote, clone]);
  return f;
}

// launchctl with no real effect: `print` answers for the labels in `loaded`; every other call succeeds and is recorded.
function fakeLaunchctl(loaded = new Set()) {
  return statefulLaunchctl(loaded);
}

function plist(label, args, { keepAlive = false, interval = null } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}\n  </array>\n  <key>RunAtLoad</key><true/>\n${interval ? `  <key>StartInterval</key><integer>${interval}</integer>\n` : ''}${keepAlive ? '  <key>KeepAlive</key><true/>\n' : ''}</dict>\n</plist>\n`;
}

function writePlist(f, label, text) {
  fs.mkdirSync(f.agents, { recursive: true });
  fs.writeFileSync(path.join(f.agents, `${label}.plist`), text);
}

const readPlist = (f, label) => fs.readFileSync(path.join(f.agents, `${label}.plist`), 'utf8');
const liveTarget = (f, name = 'housesitter') => fs.readlinkSync(currentLink(name, f.home));
const folders = (f) => fs.readdirSync(path.join(releasesRoot(f.home), 'housesitter')).filter((x) => x !== 'current' && x !== 'history.json').sort();

test('a good deploy swaps current, rewrites and reloads the clone-pointing jobs, kicks the KeepAlive job that runs the release, and a second deploy rewrites nothing', async () => {
  const f = fixture();
  const first = await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  assert.equal(first.ok, true, JSON.stringify(first));
  const cloneBin = path.join(f.clone, 'bin', 'housesitter.mjs');
  const liveBinPath = path.join(currentLink('housesitter', f.home), 'bin', 'housesitter.mjs');
  writePlist(f, 'bot.ouro.housesitter.heartbeat', plist('bot.ouro.housesitter.heartbeat', ['/usr/local/bin/node', cloneBin, 'restart-copilot', '--heartbeat', '--quiet'], { interval: 30 }));
  writePlist(f, 'bot.ouro.housesitter.copilot-resume', plist('bot.ouro.housesitter.copilot-resume', ['/usr/local/bin/node', liveBinPath, 'restart-copilot', '--resume-only'], { keepAlive: true }));
  writePlist(f, 'bot.ouro.housesitter.keep-awake', plist('bot.ouro.housesitter.keep-awake', ['/usr/bin/caffeinate', '-imsu'], { keepAlive: true }));
  writePlist(f, 'bot.ouro.housesitter.watch-kvm.mini', plist('bot.ouro.housesitter.watch-kvm.mini', ['/usr/local/bin/node', cloneBin, 'watch-kvm', 'mini', '--once'], { interval: 60 }));
  writePlist(f, 'com.example.other', plist('com.example.other', ['/usr/local/bin/node', cloneBin]));
  const other = readPlist(f, 'com.example.other');
  const loaded = new Set(['bot.ouro.housesitter.heartbeat', 'bot.ouro.housesitter.copilot-resume', 'bot.ouro.housesitter.keep-awake']);

  const sha = f.publish('0.10.0');
  const lc = fakeLaunchctl(loaded);
  const r = await deploy({ name: 'housesitter', clone: f.clone, why: 'the operator asked for the update', home: f.home, uid: UID, launchctl: lc.fn });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.ref, 'v0.10.0', 'the default ref is the newest v* tag, by its numbers');
  assert.equal(liveTarget(f), r.release);
  assert.equal(path.basename(r.release), sha);

  const hb = readPlist(f, 'bot.ouro.housesitter.heartbeat');
  assert.ok(hb.includes(liveBinPath) && !hb.includes(cloneBin), 'the heartbeat now runs the live release');
  assert.ok(lc.calls.includes(`bootout gui/${UID}/bot.ouro.housesitter.heartbeat`) && lc.calls.some((c) => c.startsWith(`bootstrap gui/${UID} `) && c.includes('heartbeat.plist')));
  assert.ok(lc.calls.includes(`kickstart -k gui/${UID}/bot.ouro.housesitter.copilot-resume`), 'a KeepAlive job on the release is kicked');
  assert.ok(!lc.calls.some((c) => c.includes('keep-awake') && c.startsWith('kickstart')), 'a job that does not run this code is not restarted');
  const watch = readPlist(f, 'bot.ouro.housesitter.watch-kvm.mini');
  assert.ok(watch.includes(liveBinPath) && !watch.includes(cloneBin), 'an unloaded job is rewritten, so it loads the live release');
  assert.ok(!lc.calls.some((c) => c.includes('watch-kvm') && !c.startsWith('print')), 'and nothing is reloaded for it');
  assert.equal(readPlist(f, 'com.example.other'), other, 'a job this tool does not own is untouched');

  const lc2 = fakeLaunchctl(loaded);
  const again = await deploy({ name: 'housesitter', clone: f.clone, why: 'again', home: f.home, uid: UID, launchctl: lc2.fn });
  assert.equal(again.ok, true);
  assert.ok(again.steps.some((s) => /already built: reused/.test(s.detail)), 'a release already built is reused');
  assert.ok(!lc2.calls.some((c) => c.startsWith('bootout') && c.includes('heartbeat')), 'a job already on the release is not reloaded again');
  assert.equal(liveBin('/clone/bin/housesitter.mjs', { home: f.home }), liveBinPath, 'the installers write the live bin once a current link exists');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('a failed check leaves current on the old release, and removes only the folder it just made', async () => {
  const f = fixture();
  await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const before = liveTarget(f);
  f.publish('0.11.0', { broken: true });
  const lc = fakeLaunchctl();
  const r = await deploy({ name: 'housesitter', ref: 'v0.11.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc.fn });
  assert.equal(r.ok, false);
  assert.equal(r.failed, 'check');
  assert.equal(r.removed, true);
  assert.equal(liveTarget(f), before, 'current still points at the old release');
  assert.deepEqual(folders(f), [path.basename(before)], 'only the new folder was removed');
  assert.ok(lc.calls.every((c) => c.startsWith('print')), 'launchd was not touched');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('a release whose restart-copilot --dry-run fails is refused and not swapped', async () => {
  const f = fixture();
  await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const before = liveTarget(f);
  f.publish('0.11.0', { dryBroken: true });
  const lc = fakeLaunchctl();
  const r = await deploy({ name: 'housesitter', ref: 'v0.11.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc.fn });
  assert.equal(r.ok, false);
  assert.equal(r.failed, 'check');
  assert.match(JSON.stringify(r), /restart-copilot --dry-run failed/);
  assert.equal(liveTarget(f), before);
  assert.ok(lc.calls.every((c) => c.startsWith('print')));
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('a release whose dry run only says it cannot reach the app menu from here is deployed, as from a launchd job', async () => {
  const f = fixture();
  f.publish('0.11.0', { dryNoMenu: true });
  const r = await deploy({ name: 'housesitter', ref: 'v0.11.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, '0.11.0');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('older releases beyond the three newest are pruned, and the live one is kept', async () => {
  const f = fixture();
  const shas = [];
  for (const v of ['0.9.0', '0.10.0', '0.11.0', '0.12.0']) {
    if (v !== '0.9.0') shas.push(f.publish(v)); else shas.push(git(f.remote, ['rev-parse', 'HEAD']).slice(0, 12));
    const r = await deploy({ name: 'housesitter', ref: `v${v}`, clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  assert.deepEqual(folders(f), shas.slice(-3).sort(), 'the three newest releases are kept');
  assert.equal(path.basename(liveTarget(f)), shas.at(-1));
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('a dry run prints every step and changes nothing', async () => {
  const f = fixture();
  await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const cloneBin = path.join(f.clone, 'bin', 'housesitter.mjs');
  writePlist(f, 'bot.ouro.housesitter.heartbeat', plist('bot.ouro.housesitter.heartbeat', ['/usr/local/bin/node', cloneBin, 'restart-copilot', '--heartbeat'], { interval: 30 }));
  f.publish('0.10.0');
  const before = { live: liveTarget(f), plist: readPlist(f, 'bot.ouro.housesitter.heartbeat'), folders: folders(f) };
  const lc = fakeLaunchctl(new Set(['bot.ouro.housesitter.heartbeat']));
  const r = await deploy({ name: 'housesitter', clone: f.clone, why: 'test', dry: true, home: f.home, uid: UID, launchctl: lc.fn });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.ref, 'v0.10.0', 'a dry run reads the remote tags');
  assert.ok(r.steps.some((s) => /would/.test(s.detail)));
  assert.deepEqual({ live: liveTarget(f), plist: readPlist(f, 'bot.ouro.housesitter.heartbeat'), folders: folders(f) }, before);
  assert.ok(lc.calls.every((c) => c.startsWith('print')), 'launchd was only read');
  fs.rmSync(f.base, { recursive: true, force: true });
});

// launchctl with state: bootout unloads, bootstrap loads (and can be made to fail a number of times first), print reads the state.
function statefulLaunchctl(loaded = new Set(), failBootstrap = {}) {
  const calls = [];
  const fn = (a) => {
    calls.push(a.join(' '));
    const label = a[0] === 'bootstrap' ? path.basename(a[2], '.plist') : (a[2] || a[1] || '').split('/').pop();
    if (a[0] === 'print') return { code: loaded.has(label) ? 0 : 1, stderr: '' };
    if (a[0] === 'bootout') { loaded.delete(label); return { code: 0, stderr: '' }; }
    if (a[0] === 'bootstrap') {
      if ((failBootstrap[label] ?? 0) > 0) { failBootstrap[label]--; return { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }; }
      loaded.add(label);
      return { code: 0, stderr: '' };
    }
    return { code: loaded.has(label) ? 0 : 1, stderr: '' };
  };
  return { calls, fn, loaded };
}

test('a bootstrap that fails once is retried after a pause, and the job is verified loaded', async () => {
  const f = fixture();
  await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const cloneBin = path.join(f.clone, 'bin', 'housesitter.mjs');
  writePlist(f, 'bot.ouro.housesitter.apple-account', plist('bot.ouro.housesitter.apple-account', ['/usr/local/bin/node', cloneBin, 'apple-account', 'mini', '--watch'], { keepAlive: true }));
  f.publish('0.10.0');
  const pauses = [];
  const lc = statefulLaunchctl(new Set(['bot.ouro.housesitter.apple-account']), { 'bot.ouro.housesitter.apple-account': 1 });
  const r = await deploy({ name: 'housesitter', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc.fn, sleep: (ms) => pauses.push(ms) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(lc.calls.filter((c) => c.startsWith('bootstrap') && c.includes('apple-account')).length, 2);
  assert.ok(pauses.includes(2000), 'the retry waits before it tries again');
  assert.ok(lc.loaded.has('bot.ouro.housesitter.apple-account'));
  assert.equal(r.jobs.find((j) => j.label === 'bot.ouro.housesitter.apple-account').action, 'reloaded');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('a job that stays unloaded fails the deploy loudly, with the bootstrap command to run', async () => {
  const f = fixture();
  await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const cloneBin = path.join(f.clone, 'bin', 'housesitter.mjs');
  writePlist(f, 'bot.ouro.housesitter.disk-prune', plist('bot.ouro.housesitter.disk-prune', ['/usr/local/bin/node', cloneBin, 'restart-copilot', '--disk-prune'], { interval: 600 }));
  f.publish('0.10.0');
  const file = path.join(f.agents, 'bot.ouro.housesitter.disk-prune.plist');
  const lc = statefulLaunchctl(new Set(['bot.ouro.housesitter.disk-prune']), { 'bot.ouro.housesitter.disk-prune': 99 });
  const r = await deploy({ name: 'housesitter', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc.fn, sleep: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.failed, 'reload');
  assert.deepEqual(r.unloaded.map((u) => u.command), [`launchctl bootstrap gui/${UID} ${file}`]);
  assert.match(renderDeploy(r), new RegExp(`launchctl bootstrap gui/${UID} ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('a script a job runs that names this tool is repointed to the live release, and the job is kicked', async () => {
  const f = fixture();
  await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const cloneBin = path.join(f.clone, 'bin', 'housesitter.mjs');
  const script = path.join(f.home, '.config', 'housesitter', 'peer-watch.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `#!/bin/sh\nexec /usr/local/bin/node ${cloneBin} peer watch mini --once\n`, { mode: 0o755 });
  writePlist(f, 'bot.ouro.housesitter-peer-watch', plist('bot.ouro.housesitter-peer-watch', ['/bin/sh', script], { interval: 60 }));
  const plistBefore = readPlist(f, 'bot.ouro.housesitter-peer-watch');
  f.publish('0.10.0');
  const lc = statefulLaunchctl(new Set(['bot.ouro.housesitter-peer-watch']));
  const r = await deploy({ name: 'housesitter', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc.fn, sleep: () => {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  const live = path.join(currentLink('housesitter', f.home), 'bin', 'housesitter.mjs');
  const body = fs.readFileSync(script, 'utf8');
  assert.ok(body.includes(live) && !body.includes(cloneBin), body);
  assert.equal(fs.statSync(script).mode & 0o777, 0o755, 'the script keeps its mode');
  assert.equal(readPlist(f, 'bot.ouro.housesitter-peer-watch'), plistBefore, 'the plist itself names no copy and is not rewritten');
  assert.ok(lc.calls.includes(`kickstart -k gui/${UID}/bot.ouro.housesitter-peer-watch`));
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('an old copy of the tool in a job is pointed at the live release in place, and the argv keeps its length', async () => {
  const f = fixture();
  await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const old = path.join(f.home, 'Library', 'Application Support', 'housesitter', 'app', 'bin', 'housesitter.mjs');
  const argv = ['/usr/local/bin/node', old, 'restart-copilot', '--heartbeat'];
  writePlist(f, 'bot.ouro.housesitter.heartbeat', plist('bot.ouro.housesitter.heartbeat', argv, { interval: 30 }));
  f.publish('0.10.0');
  const r = await deploy({ name: 'housesitter', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn, sleep: () => {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  const now = programArgs(readPlist(f, 'bot.ouro.housesitter.heartbeat'));
  assert.equal(now.length, argv.length, 'the same number of arguments');
  assert.deepEqual(now.filter((_, i) => i !== 1), argv.filter((_, i) => i !== 1), 'every other argument is untouched, in place');
  assert.equal(now[1], path.join(currentLink('housesitter', f.home), 'bin', 'housesitter.mjs'));
  fs.rmSync(f.base, { recursive: true, force: true });
});
test('a script whose tool path has a space is repointed to the quoted live release, and three deploys leave the line as it is', async () => {
  const f = fixture();
  await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const old = path.join(f.home, 'Library', 'Application Support', 'housesitter', 'app', 'bin', 'housesitter.mjs');
  const script = path.join(f.home, '.config', 'housesitter', 'peer-watch.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `#!/bin/sh\nexec /usr/local/bin/node "${old}" peer watch mini --once\n`, { mode: 0o755 });
  writePlist(f, 'bot.ouro.housesitter-peer-watch', plist('bot.ouro.housesitter-peer-watch', ['/bin/sh', script], { interval: 60 }));
  f.publish('0.10.0');
  const live = path.join(currentLink('housesitter', f.home), 'bin', 'housesitter.mjs');
  const want = `#!/bin/sh\nexec /usr/local/bin/node "${live}" peer watch mini --once\n`;
  const lc = statefulLaunchctl(new Set(['bot.ouro.housesitter-peer-watch']));
  for (let i = 1; i <= 3; i++) {
    const r = await deploy({ name: 'housesitter', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc.fn, sleep: () => {} });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.readFileSync(script, 'utf8'), want, `after deploy ${i}`);
  }
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('an unquoted clone path in a script becomes the quoted live release, keeps the arguments after it, and a second deploy changes nothing', async () => {
  const f = fixture();
  await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const cloneBin = path.join(f.clone, 'bin', 'housesitter.mjs');
  const script = path.join(f.home, '.config', 'housesitter', 'peer-watch.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `#!/bin/sh\nexec /usr/local/bin/node ${cloneBin} peer watch mini --once --every 60\n`, { mode: 0o755 });
  writePlist(f, 'bot.ouro.housesitter-peer-watch', plist('bot.ouro.housesitter-peer-watch', ['/bin/sh', script], { interval: 60 }));
  f.publish('0.10.0');
  const live = path.join(currentLink('housesitter', f.home), 'bin', 'housesitter.mjs');
  const want = `#!/bin/sh\nexec /usr/local/bin/node "${live}" peer watch mini --once --every 60\n`;
  const lc = statefulLaunchctl(new Set(['bot.ouro.housesitter-peer-watch']));
  for (const i of [1, 2]) {
    const r = await deploy({ name: 'housesitter', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc.fn, sleep: () => {} });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.readFileSync(script, 'utf8'), want, `after deploy ${i}`);
  }
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('shepherd gets the same swap: its clone-pointing plist is rewritten and reloaded, and housesitter\'s jobs are not its', async () => {
  const f = fixture();
  const cloneBin = path.join(f.clone, 'bin', 'shepherd.mjs');
  writePlist(f, 'bot.ouro.shepherd', plist('bot.ouro.shepherd', ['/usr/local/bin/node', cloneBin, 'watch'], { keepAlive: true }));
  writePlist(f, 'bot.ouro.housesitter.heartbeat', plist('bot.ouro.housesitter.heartbeat', ['/usr/local/bin/node', path.join(f.clone, 'bin', 'housesitter.mjs'), 'restart-copilot', '--heartbeat'], { interval: 30 }));
  const lc = fakeLaunchctl(new Set(['bot.ouro.shepherd', 'bot.ouro.housesitter.heartbeat']));
  const r = await deploy({ name: 'shepherd', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc.fn });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(readPlist(f, 'bot.ouro.shepherd').includes(path.join(currentLink('shepherd', f.home), 'bin', 'shepherd.mjs')));
  assert.ok(lc.calls.includes(`bootout gui/${UID}/bot.ouro.shepherd`));
  assert.ok(!lc.calls.some((c) => c.includes('heartbeat') && !c.startsWith('print')), 'housesitter\'s jobs are not shepherd\'s to reload');
  assert.ok(readPlist(f, 'bot.ouro.housesitter.heartbeat').includes(path.join(f.clone, 'bin', 'housesitter.mjs')));
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('deploy writes the ~/.local/bin command for the tool, refreshes it, runs the live release, and leaves a file that is not its own', async () => {
  const f = fixture();
  const lc = fakeLaunchctl().fn;
  const shim = shimPath('shepherd', f.home);
  const dry = await deploy({ name: 'shepherd', ref: 'v0.9.0', clone: f.clone, why: 'test', dry: true, home: f.home, uid: UID, launchctl: lc });
  assert.match(dry.steps.find((s) => s.step === 'shim').detail, /would write/);
  assert.equal(fs.existsSync(shim), false, 'a dry run writes nothing');

  const r = await deploy({ name: 'shepherd', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.steps.find((s) => s.step === 'shim').detail, /written/);
  assert.ok(fs.statSync(shim).mode & 0o100, 'it is executable');
  const run = (extra = {}) => spawnSync(shim, ['--version'], { encoding: 'utf8', env: { HOME: f.home, PATH: '/usr/bin:/bin', ...extra } });
  assert.equal(run().stdout.trim(), '0.9.0', 'it runs the live release from a bare environment');

  f.publish('0.10.0');
  fs.rmSync(shim);
  const again = await deploy({ name: 'shepherd', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc });
  assert.match(again.steps.find((s) => s.step === 'shim').detail, /written/, 'a deleted shim is regenerated');
  assert.equal(run().stdout.trim(), '0.10.0', 'and it follows the new release');
  const third = await deploy({ name: 'shepherd', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc });
  assert.match(third.steps.find((s) => s.step === 'shim').detail, /is current/);

  fs.writeFileSync(shim, '#!/bin/sh\necho mine\n');
  const kept = await deploy({ name: 'shepherd', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: lc });
  assert.match(kept.steps.find((s) => s.step === 'shim').detail, /left alone/);
  assert.match(fs.readFileSync(shim, 'utf8'), /echo mine/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('a release older than the live one is refused unless the downgrade is asked for', async () => {
  const f = fixture();
  f.publish('0.11.0');
  await deploy({ name: 'housesitter', ref: 'v0.11.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  const before = liveTarget(f);
  const r = await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, launchctl: fakeLaunchctl().fn });
  assert.equal(r.ok, false);
  assert.equal(r.failed, 'downgrade');
  assert.equal(liveTarget(f), before, 'current still points at the newer release');
  const back = await deploy({ name: 'housesitter', ref: 'v0.9.0', clone: f.clone, why: 'test', home: f.home, uid: UID, allowDowngrade: true, launchctl: fakeLaunchctl().fn });
  assert.equal(back.ok, true);
  assert.notEqual(liveTarget(f), before);
  fs.rmSync(f.base, { recursive: true, force: true });
});
