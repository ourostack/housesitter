# AGENTS.md

- **Pull requests:** follow ourostack's [every PR merges fast](https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md) and publish with `gh ouro-pr`.
- **What it is:** the [README](README.md).
- **One set of rules, two languages.** `src/watchdog.mjs` and `device/sitter.py` must decide alike. Change both, and add a scenario to `spec/watchdog-cases.json`; both test suites run every scenario.
- **One dependency, and never on the KVM.** The Node CLI depends only on [`@ouro.bot/hackamore`](https://github.com/ourostack/hackamore), pinned to a tag, and only `ls` and `do` load it. The sitter on the KVM has none: a firmware update must not be able to break it.
- **Reusable parts live in hackamore.** What drives any app belongs there; housesitter keeps the KVM, the sitter, the watchdog and the hands. Don't grow a second copy of the engine here.
- **Honest status.** Move a row of the README's "What's verified" table only with evidence (a `housesitter proof` recording, a log). Never show fake footage as real.
- **Commit email:** `16390116+arimendelow@users.noreply.github.com`.
