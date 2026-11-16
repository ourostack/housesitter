// The vendored generator and claim set must be byte-for-byte the files core's release manifest pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/ouro-actions/dist-manifest.json'), 'utf8'));

test('the release manifest names core v0.16.0', () => {
  assert.equal(manifest.coreTag, 'v0.16.0');
});

const vendored = { 'dist/actions/ouro-actions.mts': 'ouro-actions.mts', 'dist/ax/actions.claims.json': 'actions.claims.json' };
for (const [distPath, local] of Object.entries(vendored)) {
  test(`tools/ouro-actions/${local} matches core's ${distPath}`, () => {
    const bytes = fs.readFileSync(path.join(ROOT, 'tools/ouro-actions', local));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[distPath]);
  });
}
