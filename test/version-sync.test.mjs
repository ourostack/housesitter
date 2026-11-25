// One version, three places: package.json (what `housesitter --version` prints), the plugin manifest and the MCP server.
// On a tag build (GITHUB_REF_NAME=vX.Y.Z) the tag must be that version too, so a release can't ship an old number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const versions = () => ({
  'package.json': JSON.parse(read('package.json')).version,
  'plugin.json': JSON.parse(read('plugins/housesitter/.claude-plugin/plugin.json')).version,
  'server.py': /^VERSION = "([^"]+)"/m.exec(read('plugins/housesitter/mcp/server.py'))?.[1],
});

test('package.json, the plugin manifest and server.py carry the same version', () => {
  const v = versions();
  assert.equal(v['plugin.json'], v['package.json'], JSON.stringify(v));
  assert.equal(v['server.py'], v['package.json'], JSON.stringify(v));
});

test('a release tag build matches package.json', { skip: !/^v\d/.test(process.env.GITHUB_REF_NAME ?? '') }, () => {
  assert.equal(process.env.GITHUB_REF_NAME, `v${versions()['package.json']}`);
});
