// The sitter (Python, on the KVM) and the library (Node, on agent hosts) must read screens and keys alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyScreen } from '../src/screen.mjs';
import { absPoint, keyNames } from '../src/keys.mjs';

const DEVICE = fileURLToPath(new URL('../device', import.meta.url));
const TEXTS = [
  'Ada Lovelace\nEnter Password\nRestart Shut Down', 'FileVault\nEnter Password\nRestart', 'Finder File Edit View Go Window Help', '',
  'Ada\nEnter Password', 'Terminal — zsh', 'Your screen is locked', 'something else entirely', 'Sleep Restart Shut Down Password',
];
const COMBOS = ['cmd+space', 'ctrl+shift+4', 'Return', 'super+l', 'F5', 'option+tab', 'page_down', 'a', '7'];
const POINTS = [[0, 0, 1920, 1080], [1919, 1079, 1920, 1080], [640, 360, 1280, 720], [5, 9, 2560, 1440]];

test('screen, keys and pointer: Node and Python agree', () => {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(DEVICE)})
import sitter as S
d = json.load(sys.stdin)
print(json.dumps({"screens": [S.classify_screen(t, ["Ada"]) for t in d["texts"]], "keys": [S.key_names(c) for c in d["combos"]], "points": [list(S.abs_point(*p)) for p in d["points"]]}))`;
  const r = spawnSync('python3', ['-c', py], { input: JSON.stringify({ texts: TEXTS, combos: COMBOS, points: POINTS }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.screens, TEXTS.map((t) => classifyScreen(t, { userNames: ['Ada'] }).kind));
  assert.deepEqual(got.keys, COMBOS.map(keyNames));
  assert.deepEqual(got.points, POINTS.map((p) => absPoint(...p)));
});
