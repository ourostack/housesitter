// Stop the growth where it starts: a `git worktree add` from a clone whose repository ships
// .github/scripts/lean-worktree.sh comes out lean (images, video, audio and bundles stay in Git, not in the tree).
// The repository's script is the one source of the patterns; this only calls it, from the clone's post-checkout hook,
// for a new linked worktree. The block is added once, between markers, to the existing hook (git-lfs's, for one), so
// nothing the hook did before changes, and a repository whose hooks live in a shared core.hooksPath is left alone.

export const BEGIN = '# housesitter: lean worktrees (begin)';
export const END = '# housesitter: lean worktrees (end)';

export const BLOCK = `${BEGIN}
if [ "$1" = "0000000000000000000000000000000000000000" ] && [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
  if [ -f .github/scripts/lean-worktree.sh ]; then lean=$(cat .github/scripts/lean-worktree.sh); else lean=$(git show origin/HEAD:.github/scripts/lean-worktree.sh 2>/dev/null); fi
  [ -n "$lean" ] && printf '%s\\n' "$lean" | COPILOT_WORKSPACE_PATH="$PWD" COPILOT_ROOT_PATH= bash -s >/dev/null 2>&1
fi
${END}`;

// The hook text with the block in it exactly once; same text when it already is.
export function withBlock(existing) {
  const text = existing ?? '#!/bin/sh\n';
  if (text.includes(BEGIN)) return text;
  const lines = text.split('\n');
  const at = lines[0].startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, BLOCK);
  return lines.join('\n');
}
