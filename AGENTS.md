# AGENTS.md

- **Pull requests:** follow ourostack's [every PR merges fast](https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md) and publish with `gh ouro-pr`.
- **[Interfaces follow Ouro UI](https://github.com/ourostack/.github/blob/main/agents/interfaces-follow-ouro-ui.md).** Every screen a person uses is built from Ouro HX, every door an agent uses is declared once with `ouro-actions` and checked by the Ouro AX X-ray in CI, Ouro is taken from its release tags (never copied by hand) and kept within a day of them, and what Ouro lacks is fixed in Ouro first.
- **[Images must load on the recipient's phone](https://github.com/ourostack/.github/blob/main/agents/images-load-on-mobile.md).** Attach images with the platform's own attachment (never a blob/ or raw.githubusercontent.com link, never a copy to a public place), and say only what was observed: a served upload is not a rendered page, and native Mobile and Teams rendering is unverified.
- **What it is:** the [README](README.md).
- **One set of rules, two languages.** `src/watchdog.mjs` and `device/sitter.py` must decide alike. Change both, and add a scenario to `spec/watchdog-cases.json`; both test suites run every scenario.
- **Two dependencies, and never on the KVM.** The Node CLI depends only on [`@ouro.bot/hackamore`](https://github.com/ourostack/hackamore) and [`@ouro.bot/shepherd`](https://github.com/ourostack/shepherd), both pinned to a tag, and only `ls` and `do` load hackamore. The sitter on the KVM has none: a firmware update must not be able to break it.
- **Reusable parts live in hackamore.** What drives any app belongs there; housesitter keeps the KVM, the sitter, the watchdog and the hands. Don't grow a second copy of the engine here.
- **The house and the flock.** Housesitter keeps the house (the Mac and the app as a running process); the app's sessions are Shepherd's, and Housesitter calls its library for safe points, progress and resume messages. Resume-and-verify and the six-hour health watch are Shepherd's too (`resume()`, `shepherd watch`); Housesitter only notices the app came back and asks Shepherd to resume.
- **Honest status.** Move a row of the README's "What's verified" table only with evidence (a `housesitter proof` recording, a log). Never show fake footage as real.
- **Deploy through `housesitter deploy`.** Never `git pull` in a live clone: `housesitter deploy <housesitter|shepherd>` builds and checks a release, then swaps `current` in one rename, and the jobs run from `current`.
- **Commit email:** `16390116+arimendelow@users.noreply.github.com`.

<!-- ouro-ui:bar -->
**The bar, for people and agents alike** ([design craft](https://ui.ouroboros.bot/docs/design-craft/#the-bar)): would the people who made the Mac and the iPhone ship it? Whenever you scope or design something a person or an agent meets (a screen, a menu, a setting, a command, an action, a tool, a line of output):

1. Start from the jobs people do, in their words. Read a reference product's items, a service's functions or an API's fields as evidence of jobs, never as the list to build.
2. Make the first cut restraint: for each thing, name the job it serves and ask what breaks if it goes; if nothing does, leave it out and say why. Give each job one way in, not one per item or function, and extend the one that exists before adding another.
3. Build what is left well, the basics people use daily among it, for the person and for agents, with a result that says what it did.
4. Write how fresh people or fresh agents doing a real job will prove it, and rerun them after each small change.
5. Before you show a scope or design, follow the [`the-bar` skill](.agents/skills/the-bar/SKILL.md): a fresh agent that didn't write it checks every item against these steps, and you fix what it finds.
<!-- /ouro-ui:bar -->
