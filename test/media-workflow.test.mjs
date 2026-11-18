// #20: vhs-action downloads the latest ffmpeg on every run and fails when that host returns 504, so the media job installs its tools itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const media = readFileSync(new URL('../.github/workflows/media.yml', import.meta.url), 'utf8');

test('media workflow does not use vhs-action, which downloads ffmpeg on every run', () => {
  assert.doesNotMatch(media, /uses:\s*charmbracelet\/vhs-action/);
});

test('media workflow installs ffmpeg and ttyd from apt and pins the vhs release', () => {
  assert.match(media, /apt-get install -y ffmpeg ttyd/);
  assert.match(media, /VHS_VERSION:\s*v\d+\.\d+\.\d+/);
});
