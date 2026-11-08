# AGENTS.md

## Pull requests merge within 30 minutes

Follow ourostack's shared rule, [every PR merges within 30 minutes](https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md). Finish, review and validate on your branch first, then publish with `gh ouro-pr`, which turns auto-merge on so green means merged.

## What this repo is

housesitter: an always-on sitter that runs on an IP-KVM next to a Mac (`device/sitter.py`, Python 3 standard library only), and a zero-dependency Node CLI and library for the people and agents who use it (`bin/`, `src/`).

- **One set of rules, two languages.** `src/watchdog.mjs` and `device/sitter.py` must decide alike. Change both, and add a scenario to `spec/watchdog-cases.json`; both test suites run every scenario. `test/parity.test.mjs` keeps the screen classifier, key names and pointer maths in step.
- **No dependencies.** Not in Node (the CLI runs from `npx github:`), and never on the KVM (a firmware update must not be able to break the sitter).
- **Secrets by reference only.** Config holds `keychain:`, `env:` or `file:` references. A secret goes in a request body or on stdin, never argv, a log, status or a gist. Tests assert it.
- **Honest status.** The README's "What's verified" table says what has run on real hardware and what only on fakes. Move a row only with evidence (a `housesitter proof` recording, a log). Never show fake footage as real.
- **Tests:** `npm test` (Node and Python, about 5 s). CI runs Node 20 and 22 and Python 3.9, 3.12 and 3.13.
- **Brand:** the README header and social preview come from ourostack/.github `brand/`; see its AGENTS.md before changing either.

## Git

- Commit email: `16390116+arimendelow@users.noreply.github.com`.
- No AI attribution in commits, pull requests or files.
