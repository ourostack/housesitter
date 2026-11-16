// Every vendored file must be byte-for-byte the file upstream-sources.lock.json pins: an edit to a vendored file, or a
// lock that drifted from the copy, fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'upstream-sources.lock.json'), 'utf8'));

test('the lock is schema 1 and pins a full commit', () => {
  assert.equal(lock.schemaVersion, 1);
  for (const source of lock.sources) assert.match(source.commit, /^[0-9a-f]{40}$/, source.id);
});

for (const source of lock.sources) {
  for (const file of source.files) {
    test(`vendored ${file.generatedPath} matches its pinned sha256`, () => {
      const bytes = fs.readFileSync(path.join(ROOT, file.generatedPath));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    });
  }
}
