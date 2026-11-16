// A stand-in for Desk's mcp/src/runtime/plugin-update.js in the plugin-update tests, with the answers Desk gives for the cases
// they cover: skill text counts only without the live skill hook, hook scripts only without the live hook, while a skill's
// description and the hook registration always count.
import fs from 'node:fs';
import path from 'node:path';

const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
const description = (text) => (text ?? '').match(/^description:.*$/m)?.[0] ?? null;

export function changesPerProcess(loadedDir, newDir, name, live = {}) {
  if (read(loadedDir, 'hooks/copilot-hooks.json') !== read(newDir, 'hooks/copilot-hooks.json')) return true;
  if (!live.hooks && read(loadedDir, 'hooks/lib/helper.cjs') !== read(newDir, 'hooks/lib/helper.cjs')) return true;
  const rel = 'skills/s/SKILL.md';
  const before = read(loadedDir, rel), after = read(newDir, rel);
  if (description(before) !== description(after)) return true;
  return !live.skills && before !== after;
}
