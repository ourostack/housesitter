// Deploy: one atomic swap of a tool's live release, so a launchd job never runs half-updated code. A release is a git
// worktree of a tag (or branch, or sha) with its own node_modules, under ~/Library/Application Support/housesitter/
// releases/<name>/<short sha>. `current` is a symlink to the live one, and every job runs its bin from `current`: one
// rename changes what every job runs, and nothing is pulled into a clone a job might be starting from.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Refusal } from './hands.mjs';

export const KEEP = 3;
export const SHA_LEN = 12;

export const TARGETS = {
  housesitter: { bin: 'bin/housesitter.mjs', owns: (label) => label.startsWith('bot.ouro.housesitter') },
  shepherd: { bin: 'bin/shepherd.mjs', owns: (label) => label === 'bot.ouro.shepherd' },
};

export const releasesRoot = (home = os.homedir()) => path.join(home, 'Library', 'Application Support', 'housesitter', 'releases');
export const currentLink = (name, home = os.homedir()) => path.join(releasesRoot(home), name, 'current');
export const defaultClone = (name, home = os.homedir()) => path.join(home, 'code', name);
const historyFile = (name, home) => path.join(releasesRoot(home), name, 'history.json');
const deployLog = (home) => path.join(home, 'Library', 'Logs', 'housesitter', 'deploys.jsonl');

// The bin an installer writes into a plist: the live release's when there is one, else the clone's (the path as today).
export function liveBin(fallback, { home = os.homedir(), name = 'housesitter' } = {}) {
  const live = path.join(currentLink(name, home), TARGETS[name].bin);
  return fs.existsSync(live) ? live : fallback;
}

// The command on PATH: ~/.local/bin/<tool>, a two-line script that runs the live release, so a deploy never changes it and
// a fresh shell finds the tool. Deploy writes it every time; a file there that deploy did not write is left alone.
export const SHIM_MARK = '# written by housesitter deploy';
export const shimPath = (name, home = os.homedir()) => path.join(home, '.local', 'bin', name);
export function shimText(name, { home = os.homedir(), node = process.execPath } = {}) {
  const bin = path.join(currentLink(name, home), TARGETS[name].bin);
  return `#!/bin/sh\n${SHIM_MARK}: runs the live ${name} release\nN=${JSON.stringify(node)}; [ -x "$N" ] || N=node\nexec "$N" ${JSON.stringify(bin)} "$@"\n`;
}
function writeShim(name, { home, dry }) {
  const file = shimPath(name, home);
  const text = shimText(name, { home });
  let have = null;
  try { have = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (have !== null && !have.includes(SHIM_MARK)) return { ok: true, detail: `${file} is not Housesitter's, so it is left alone` };
  if (have === text) return { ok: true, detail: `${file} is current` };
  if (dry) return { ok: true, detail: `would write ${file}, the command that runs the live ${name}` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, file);
  return { ok: true, detail: `${file} ${have === null ? 'written' : 'refreshed'}: ${name} runs the live release from any shell` };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The plist's ProgramArguments, unescaped.
export function programArgs(text) {
  const block = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  return block ? [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unesc(m[1])) : [];
}

const nums = (v) => String(v).replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
export function versionLess(a, b) {
  const x = nums(a), y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d < 0; }
  return false;
}
function liveVersion(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null; } catch { return null; } }

// Tags are v-prefixed versions; the newest by its numbers.
export function newestTag(tags) {
  const nums = (t) => t.slice(1).split(/[.-]/).map((x) => Number(x) || 0);
  const versions = tags.filter((t) => /^v\d/.test(t)).sort((a, b) => {
    const x = nums(a), y = nums(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
    return 0;
  });
  return versions.at(-1) ?? null;
}

const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
};

const defaultLaunchctl = (a) => {
  const r = spawnSync('/bin/launchctl', a, { encoding: 'utf8' });
  return { code: r.status ?? 1, stderr: String(r.stderr || '') };
};

// Checks the built release: every tracked .mjs parses, the bin answers --version with exit 0, and Housesitter's restart-copilot --dry-run plans without a load error.
export function checkRelease(dir, bin) {
  const files = git(dir, ['ls-files', '--', '*.mjs']).out.split('\n').filter(Boolean);
  const bad = files.filter((f) => spawnSync(process.execPath, ['--check', f], { cwd: dir, encoding: 'utf8' }).status !== 0);
  if (bad.length) return { ok: false, detail: `node --check failed on ${bad.join(', ')}` };
  const v = spawnSync(process.execPath, [path.join(dir, bin), '--version'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  if (v.status !== 0) return { ok: false, detail: `${bin} --version exited ${v.status}: ${String(v.stderr || '').trim().slice(0, 200)}` };
  if (path.basename(bin) === 'housesitter.mjs') {
    // The dry run exits 0 even when hackamore fails to load, so the plan text is checked too.
    const d = spawnSync(process.execPath, [path.join(dir, bin), 'restart-copilot', '--dry-run'], { cwd: dir, encoding: 'utf8', timeout: 120000 });
    const text = `${d.stdout || ''}\n${d.stderr || ''}`;
    const m = text.match(/ERR_[A-Z_]+|Cannot find module/);
    // Exit 1 with "cannot quit:" and no load error means this process can't reach the app's menu (a launchd job such as
    // macd's fleet sync has no UI access), which says nothing about the build.
    const noMenuHere = d.status === 1 && /^\s*\d+\. cannot quit: /m.test(text);
    if ((d.status !== 0 && !noMenuHere) || m) return { ok: false, detail: `restart-copilot --dry-run failed (${m ? m[0] : `exit ${d.status}`}): ${text.trim().slice(0, 200)}` };
  }
  return { ok: true, version: String(v.stdout).trim() };
}

// Removes one release folder, only if it is a folder directly under the releases dir for this tool.
function removeRelease({ dir, root, cloneDir }) {
  if (path.dirname(dir) !== root) throw new Error(`refusing to remove ${dir}: it is not a release folder under ${root}`);
  if (!fs.existsSync(dir)) return;
  git(cloneDir, ['worktree', 'remove', '--force', dir]);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  git(cloneDir, ['worktree', 'prune']);
}

// The LaunchAgents this tool owns: the files on disk with its label prefix.
function ownedLabels(agents, name) {
  if (!fs.existsSync(agents)) return [];
  return fs.readdirSync(agents).filter((f) => f.endsWith('.plist')).map((f) => f.slice(0, -'.plist'.length)).filter(TARGETS[name].owns).sort();
}

// Decides what one job needs. Any copy of this tool's bin (the clone, an old copy, or the release) in its ProgramArguments is
// pointed at the live release, in place; a script it runs that names such a copy is pointed there too.
function planJob({ label, text, cur, bin, liveBinPath }) {
  const isCopy = (p) => p.endsWith(`/${bin}`) && !p.startsWith(cur + path.sep);
  const pick = (raw) => (isCopy(raw) ? liveBinPath : raw);
  const args = programArgs(text);
  const next = rewriteArgs(text, pick);
  const scripts = [];
  const scriptRe = toolPathRe(bin);
  for (const a of args) {
    if (!a.endsWith('.sh') || !fs.existsSync(a)) continue;
    const body = fs.readFileSync(a, 'utf8');
    // The whole tool path is replaced, quoted or bare, so a path with a space is never half-replaced.
    const out = body.replace(scriptRe, (m) => {
      const p = m.replace(/^["']|["']$/g, '');
      return isCopy(p) || p.startsWith(cur + path.sep) ? `"${liveBinPath}"` : m;
    });
    if (out !== body) scripts.push({ file: a, next: out });
  }
  const runsLive = args.some((a) => pick(a).startsWith(cur + path.sep));
  if (next === text && !scripts.length && !runsLive) return { label, action: 'left' };
  return { label, rewrite: next !== text, next, scripts, runsLive, keepAlive: /<key>KeepAlive<\/key>\s*<true\/>/.test(text) };
}

// Replaces ProgramArguments elements in place, so the argv keeps its length and order.
export function rewriteArgs(text, pick) {
  return text.replace(/(<key>ProgramArguments<\/key>\s*<array>)([\s\S]*?)(<\/array>)/, (m, open, body, close) => open + body.replace(/<string>([\s\S]*?)<\/string>/g, (s, v) => {
    const raw = unesc(v);
    const next = pick(raw);
    return next === raw ? s : `<string>${esc(next)}</string>`;
  }) + close);
}

// A tool path in a script: double- or single-quoted (it may hold a space, as `Application Support` does), or bare.
const toolPathRe = (bin) => {
  const b = bin.replace(/\./g, '\\.');
  return new RegExp(`"[^"\\n]*/${b}"|'[^'\\n]*/${b}'|[^\\s"'\`;|&()<>]*/${b}(?![^\\s"'\`;|&()<>])`, 'g');
};


export async function deploy({ name, ref = null, clone = null, why = null, home = os.homedir(), uid = process.getuid(), dry = false, allowDowngrade = false, launchctl = defaultLaunchctl, sleep = sleepSync } = {}) {
  if (!Object.hasOwn(TARGETS, name)) throw new Refusal('input-invalid', `deploy takes housesitter or shepherd, not ${name || 'nothing'}`);
  const t = TARGETS[name];
  const cloneDir = path.resolve(clone || defaultClone(name, home));
  const root = path.join(releasesRoot(home), name);
  const cur = currentLink(name, home);
  const agents = path.join(home, 'Library', 'LaunchAgents');
  const steps = [];
  const step = (s, ok, detail) => steps.push({ step: s, ok, detail });

  if (!git(cloneDir, ['rev-parse', '--git-dir']).ok) throw new Refusal('input-invalid', `no git clone at ${cloneDir}: pass --clone <dir>`);
  const link = linkState(cur);
  if (link.isDir) throw new Refusal('action-failed', `${cur} is a folder, not the link deploy keeps: move it aside first`);
  const previous = link.target;

  // Tags: fetched for a real run; a dry run reads the remote's tags and changes nothing.
  let tags;
  if (dry) {
    const ls = git(cloneDir, ['ls-remote', '--tags', 'origin']);
    if (!ls.ok) throw new Refusal('action-failed', `git ls-remote failed in ${cloneDir}: ${ls.err}`);
    tags = ls.out.split('\n').map((l) => l.split('\t')[1] || '').filter((r) => r.startsWith('refs/tags/') && !r.endsWith('^{}')).map((r) => r.slice('refs/tags/'.length));
    step('fetch', true, 'would fetch origin and its tags');
  } else {
    const f = git(cloneDir, ['fetch', '--tags', '--quiet', 'origin']);
    if (!f.ok) throw new Refusal('action-failed', `git fetch failed in ${cloneDir}: ${f.err}`);
    tags = git(cloneDir, ['tag', '--list', 'v*']).out.split('\n').filter(Boolean);
    step('fetch', true, 'origin and its tags');
  }
  const want = ref || newestTag(tags);
  if (!want) throw new Refusal('input-invalid', `${cloneDir} has no v* tag to deploy: pass --ref <tag|branch|sha>`);
  const resolve = (r) => git(cloneDir, ['rev-parse', '--verify', '--quiet', `origin/${r}^{commit}`]).out || git(cloneDir, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]).out || null;
  const full = resolve(want);
  if (!full && !dry) throw new Refusal('input-invalid', `no ref ${want} in ${cloneDir}`);
  const sha = full ? full.slice(0, SHA_LEN) : null;
  const dir = sha ? path.join(root, sha) : null;

  const jobs = [];
  const pruned = [];
  const base = { name, ref: want, sha, release: dir, previous, why, dry_run: dry };
  const fail = (failed, detail, removed) => {
    const out = { ...base, ok: false, failed, detail, removed, steps, jobs, pruned };
    if (!dry) appendLog(home, { at: new Date().toISOString(), ...out });
    return out;
  };

  if (dry) {
    step('build', true, sha ? `would build ${dir}${fs.existsSync(dir) ? ' (already built: reused)' : ''}: git worktree add, npm install --omit=dev, then check` : `would build the release of ${want} once it is fetched`);
  } else {
    fs.mkdirSync(root, { recursive: true });
    let made = false;
    if (fs.existsSync(dir)) {
      step('build', true, `${dir} is already built: reused`);
    } else {
      made = true;
      const w = git(cloneDir, ['worktree', 'add', '--detach', dir, full]);
      if (!w.ok) { removeRelease({ dir, root, cloneDir }); return fail('build', w.err || 'git worktree add failed', true); }
      const n = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8' });
      if (n.status !== 0) { removeRelease({ dir, root, cloneDir }); return fail('npm install', String(n.stderr || n.stdout).trim().slice(0, 300), true); }
      step('build', true, `${dir}: npm install --omit=dev`);
    }
    const c = checkRelease(dir, t.bin);
    if (!c.ok) {
      if (made) removeRelease({ dir, root, cloneDir });
      return fail('check', c.detail, made);
    }
    step('check', true, `node --check on every tracked .mjs; ${t.bin} --version: ${c.version}`);
    base.version = c.version;
  }

  // A release older than the live one is a downgrade: it silently reverts shipped fixes (2026-11-25: a fleet sync that misread
  // the version put v0.6.50 over a build with the restart cap). It takes --allow-downgrade, so a caller cannot do it by mistake.
  if (!dry && !allowDowngrade && previous && base.version) {
    const liveV = liveVersion(previous);
    if (liveV && versionLess(base.version, liveV)) return fail('downgrade', `${want} is ${base.version} and the live release is ${liveV}: not replaced. Pass --allow-downgrade to go back on purpose`, false);
  }

  // The swap: a temporary link next to `current`, renamed over it. A rename replaces the old link in one step.
  const liveBinPath = path.join(cur, t.bin);
  if (dry) step('swap', true, `would point ${cur} at ${dir ?? 'the new release'}`);
  else {
    const tmp = `${cur}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(dir, tmp);
    fs.renameSync(tmp, cur);
    step('swap', true, `${cur} -> ${dir}${previous ? ` (was ${previous})` : ''}`);
  }

  const shim = writeShim(name, { home, dry });
  step('shim', shim.ok, shim.detail);

  // The jobs: a plist (or a script it runs) that names a copy of this tool is pointed at the live release; a loaded job is
  // reloaded to take it, and verified loaded afterwards. A KeepAlive job on the release, or one whose script changed, is kicked.
  // Interval jobs run the new code on their next run.
  const unloaded = [];
  const target = (label) => `gui/${uid}/${label}`;
  for (const label of ownedLabels(agents, name)) {
    const file = path.join(agents, `${label}.plist`);
    const plan = planJob({ label, text: fs.readFileSync(file, 'utf8'), cur, bin: t.bin, liveBinPath });
    if (plan.action === 'left') { jobs.push({ label, action: 'left', detail: 'does not run this tool from a clone, a release or an old copy' }); continue; }
    const loaded = isLoaded(launchctl, uid, label);
    if (plan.rewrite) writeAtomic(file, plan.next, dry);
    for (const s of plan.scripts) writeAtomic(s.file, s.next, dry);
    const reload = plan.rewrite && loaded;
    const kick = !reload && loaded && (plan.scripts.length > 0 || (plan.keepAlive && plan.runsLive));
    if (reload) {
      if (dry) jobs.push({ label, action: 'would-reload', detail: 'its bin path is rewritten, then it is reloaded' });
      else {
        const r = reloadJob({ label, file, uid, launchctl, sleep });
        if (r.ok) jobs.push({ label, action: 'reloaded', detail: `its bin path now runs the live release (${r.attempts} bootstrap ${r.attempts === 1 ? 'try' : 'tries'})` });
        else { unloaded.push({ label, command: `launchctl bootstrap gui/${uid} ${file}` }); jobs.push({ label, action: 'reload-failed', detail: r.error }); }
      }
    } else if (kick) {
      if (dry) jobs.push({ label, action: 'would-kick', detail: 'restarted on the live release' });
      else {
        launchctl(['kickstart', '-k', target(label)]);
        if (isLoaded(launchctl, uid, label)) jobs.push({ label, action: 'kicked', detail: plan.scripts.length ? 'its script now runs the live release' : 'KeepAlive: restarted on the live release' });
        else { unloaded.push({ label, command: `launchctl bootstrap gui/${uid} ${file}` }); jobs.push({ label, action: 'kick-failed', detail: 'not loaded after kickstart' }); }
      }
    } else if (plan.rewrite || plan.scripts.length) {
      jobs.push({ label, action: dry ? 'would-rewrite' : 'rewritten', detail: 'not loaded now: launchd runs the new path when it is loaded' });
    } else {
      jobs.push({ label, action: 'next-run', detail: loaded ? 'runs the live release on its next run' : 'not loaded; the live release runs when it is loaded' });
    }
  }

  // Keep the newest KEEP releases: the history file is most recent first, and the live one is always among them.
  const hist = readJson(historyFile(name, home)) || [];
  const entry = { sha, ref: want, at: new Date().toISOString() };
  const ordered = sha ? [entry, ...hist.filter((h) => h.sha !== sha)] : hist;
  const kept = ordered.slice(0, KEEP);
  for (const h of ordered.slice(KEEP)) {
    const old = path.join(root, h.sha);
    if (old === dir) continue;
    if (dry) { pruned.push({ sha: h.sha, action: 'would-remove' }); continue; }
    if (fs.existsSync(old)) { removeRelease({ dir: old, root, cloneDir }); pruned.push({ sha: h.sha, action: 'removed' }); }
  }
  if (!dry) fs.writeFileSync(historyFile(name, home), `${JSON.stringify(kept, null, 2)}\n`);
  step('prune', true, `keeping ${kept.length} release${kept.length === 1 ? '' : 's'}; ${pruned.length} older ${pruned.length === 1 ? 'folder' : 'folders'} ${dry ? 'would be' : ''} removed`);

  const out = { ...base, ok: unloaded.length === 0, ...(unloaded.length ? { failed: 'reload', unloaded } : {}), previous, steps, jobs, pruned, kept: kept.map((k) => k.sha) };
  if (!dry) appendLog(home, { at: new Date().toISOString(), ...out });
  return dry ? { ...out, nothing_done: true, message: DRY_MESSAGE } : out;
}

const DRY_MESSAGE = 'deploy: dry run; nothing was done. Without --dry-run this acts for the person, and other people see it.';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isLoaded = (launchctl, uid, label) => launchctl(['print', `gui/${uid}/${label}`]).code === 0;

// bootout, wait until launchd has let the label go (up to 10 s), then bootstrap; a bootstrap that fails is retried after a
// pause, up to three tries. The job counts as reloaded only when launchctl print finds it.
function reloadJob({ label, file, uid, launchctl, sleep }) {
  launchctl(['bootout', `gui/${uid}/${label}`]);
  for (let i = 0; i < 20 && isLoaded(launchctl, uid, label); i++) sleep(500);
  let error = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = launchctl(['bootstrap', `gui/${uid}`, file]);
    if (isLoaded(launchctl, uid, label)) return { ok: true, attempts: attempt };
    error = r.stderr.trim() || `launchctl bootstrap exited ${r.code}, and launchctl print does not find it`;
    if (attempt < 3) sleep(2000);
  }
  return { ok: false, error, attempts: 3 };
}

// Writes a file through a temporary, keeping its mode; nothing is written in a dry run.
function writeAtomic(file, text, dry) {
  if (dry) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.chmodSync(tmp, fs.statSync(file).mode & 0o7777);
  fs.renameSync(tmp, file);
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

// The live link as it is on disk: a symlink's target (even a broken one), a folder that is not the link, or nothing.
function linkState(cur) {
  let st = null;
  try { st = fs.lstatSync(cur); } catch { /* no link yet */ }
  if (!st) return { target: null, isDir: false };
  if (!st.isSymbolicLink()) return { target: null, isDir: true };
  return { target: fs.readlinkSync(cur), isDir: false };
}

function appendLog(home, rec) {
  const f = deployLog(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify(rec)}\n`);
}

// What the person reads: the outcome in Housesitter's voice, then each step when it is a dry run.
export function renderDeploy(r) {
  const L = [];
  if (r.dry_run) L.push(r.message, `Deploying ${r.name} ${r.ref}${r.sha ? ` (${r.sha})` : ''}, step by step:`);
  if (!r.ok && r.failed === 'reload') {
    L.push(`✗ ${r.name}: the release is live, but ${r.unloaded.length} job${r.unloaded.length === 1 ? ' is' : 's are'} not loaded. Load ${r.unloaded.length === 1 ? 'it' : 'each'} with:`);
    for (const u of r.unloaded) L.push(`  ${u.command}   (${u.label})`);
    return L.join('\n');
  }
  if (!r.ok) {
    L.push(`✗ ${r.name}: ${r.failed} failed (${r.detail}); the live release is unchanged${r.removed ? ', and the new folder is removed' : ''}.`);
    return L.join('\n');
  }
  if (!r.dry_run) L.push(`✓ ${r.name} ${r.version || r.ref} (${r.sha}) is the live release${r.previous ? `, was ${path.basename(r.previous)}` : ''}.`);
  for (const s of r.steps) L.push(`  ${s.ok ? '·' : '✗'} ${s.step}: ${s.detail}`);
  for (const j of r.jobs) L.push(`  ${j.label}: ${j.action}${j.detail ? ` (${j.detail})` : ''}`);
  if (r.pruned.length) L.push(`  older releases: ${r.pruned.map((p) => `${p.sha} ${p.action}`).join(', ')}`);
  return L.join('\n');
}
