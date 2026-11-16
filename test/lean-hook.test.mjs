// A new linked worktree comes out lean through the clone's post-checkout hook; what the hook did before still runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BEGIN, withBlock } from '../src/lean-hook.mjs';
import { realDiskDeps } from '../src/disk-prune.mjs';

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });

test('withBlock adds the block once, after the shebang, and keeps the old hook', () => {
  const old = '#!/bin/sh\necho lfs-ran >> "$HOOK_LOG"\n';
  const once = withBlock(old);
  assert.ok(once.startsWith('#!/bin/sh\n' + BEGIN));
  assert.ok(once.includes('echo lfs-ran'));
  assert.equal(withBlock(once), once, 'a second pass changes nothing');
  assert.ok(withBlock(null).startsWith('#!/bin/sh'));
});

test('git worktree add comes out sparse; the main clone, and an existing hook\'s work, are untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leanhook-'));
  const home = path.join(root, 'home'); const main = path.join(home, 'code', 'repo'); fs.mkdirSync(main, { recursive: true });
  g(main, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(main, '.github/scripts'), { recursive: true });
  fs.writeFileSync(path.join(main, '.github/scripts/lean-worktree.sh'), "#!/usr/bin/env bash\nset -euo pipefail\ncd \"${COPILOT_WORKSPACE_PATH:-.}\"\ngit sparse-checkout set --no-cone '/*' '!*.png'\n");
  fs.writeFileSync(path.join(main, 'pic.png'), 'x'); fs.writeFileSync(path.join(main, 'doc.md'), 'x');
  g(main, 'add', '-A'); g(main, 'commit', '-qm', 'one');
  const log = path.join(root, 'hook.log');
  fs.writeFileSync(path.join(main, '.git/hooks/post-checkout'), `#!/bin/sh\necho ran >> ${log}\n`, { mode: 0o755 });
  realDiskDeps({ home }).ensureLeanHooks();
  realDiskDeps({ home }).ensureLeanHooks();
  assert.equal(fs.readFileSync(path.join(main, '.git/hooks/post-checkout'), 'utf8').split(BEGIN).length, 2, 'installed once');
  const wt = path.join(root, 'wt'); g(main, 'worktree', 'add', '-q', '-b', 'b', wt);
  assert.ok(!fs.existsSync(path.join(wt, 'pic.png')), 'media is not in the new worktree');
  assert.ok(fs.existsSync(path.join(wt, 'doc.md')));
  assert.ok(fs.existsSync(path.join(main, 'pic.png')), 'the main clone keeps its media');
  assert.ok(fs.readFileSync(log, 'utf8').includes('ran'), 'the hook\'s earlier work still ran');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a repository whose hooks live in core.hooksPath is left alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leanhook-'));
  const home = path.join(root, 'home'); const main = path.join(home, 'code', 'repo'); fs.mkdirSync(main, { recursive: true });
  g(main, 'init', '-q', '-b', 'main'); g(main, 'config', 'core.hooksPath', path.join(root, 'shared'));
  fs.mkdirSync(path.join(main, '.github/scripts'), { recursive: true });
  fs.writeFileSync(path.join(main, '.github/scripts/lean-worktree.sh'), '#!/bin/sh\n'); g(main, 'add', '-A'); g(main, 'commit', '-qm', 'one');
  realDiskDeps({ home }).ensureLeanHooks();
  assert.ok(!fs.existsSync(path.join(main, '.git/hooks/post-checkout')));
  fs.rmSync(root, { recursive: true, force: true });
});
