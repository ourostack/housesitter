// `housesitter deploy`: a release is built and checked before anything points at it, the swap is one rename, jobs that
// ran the clone are rewritten and reloaded once, and only three releases are kept. Fakes only: a temp git remote and
// clone, a temp home, and a fake launchctl. Nothing touches real launchd or the real ~/Library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentLink, deploy, liveBin, releasesRoot } from '../src/deploy.mjs';

const UID = 501;
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const binSource = (version, broken = false) => (broken ? 'const x = ;\n' : `if (process.argv.includes('--version')) { console.log('${version}'); process.exit(0); }\n`);

// A remote that publishes releases as tags, and a clone of it where the Mac's job used to run from.
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-deploy-'));
  const remote = path.join(base, 'remote');
  const home = path.join(base, 'home');
  const clone = path.join(home, 'code', 'housesitter');
  fs.mkdirSync(remote);
  git(remote, ['init', '-q', '-b', 'main']);
  const f = { base, remote, home, clone, agents: path.join(home, 'Library', 'LaunchAgents'), root: path.join(releasesRoot(home), 'housesitter') };
  f.publish = (version, { broken = false } = {}) => {
    fs.mkdirSync(path.join(remote, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'bin', 'housesitter.mjs'), binSource(version, broken));
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
  const calls = [];
  const fn = (a) => {
    calls.push(a.join(' '));
    if (a[0] === 'print') return { code: loaded.has(a[1].split('/').pop()) ? 0 : 1, stderr: '' };
    return { code: 0, stderr: '' };
  };
  return { calls, fn };
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
