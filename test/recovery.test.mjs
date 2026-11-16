// The recovery jobs: the retired health-watch job is unloaded and removed, and --status points at Shepherd's watch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, agentPath, renderRecovery, retireAgents, RETIRED } from '../src/recovery.mjs';

test('the retired health-watch job is unloaded and its plist removed; nothing else is touched', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-retire-'));
  const label = RETIRED[0];
  fs.mkdirSync(path.dirname(agentPath(label, home)), { recursive: true });
  fs.writeFileSync(agentPath(label, home), '<plist/>');
  const calls = [];
  const out = await retireAgents({ home, uid: 501, launchctl: async (a) => { calls.push(a.join(' ')); return { code: 0, stderr: '' }; } });
  assert.deepEqual(out.map((r) => [r.label, r.ok]), [[label, true]]);
  assert.deepEqual(calls, [`bootout gui/501/${label}`]);
  assert.equal(fs.existsSync(agentPath(label, home)), false);
  assert.deepEqual(await retireAgents({ home, launchctl: async () => ({ code: 0, stderr: '' }) }), [], 'a machine without it has nothing to retire');
  assert.equal(AGENTS.health, undefined, 'the installable agents no longer include it');
  fs.rmSync(home, { recursive: true, force: true });
});

test('--status says the six-hour watch is Shepherd\'s and where to see it', () => {
  const text = renderRecovery({ beat_at: null, incidents: [] });
  assert.match(text, /health watch: Shepherd's; `shepherd watch --status`/);
});
