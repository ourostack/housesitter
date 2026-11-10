# Housesitter's Ouro agent on the KVM: the deploy scripts

These are the files [docs/agent-setup.md](../../docs/agent-setup.md) puts on the KVM, exactly as they run on the Comet. Paths assume `/userdata/ouro`.

| File | Goes to | What it does |
| --- | --- | --- |
| `env.sh` | `/userdata/ouro/env.sh` | `HOME`, `PATH` (node, ouro, git, gh), the npm cache on `/userdata/media`, `NODE_COMPILE_CACHE`, `OURO_VAULT_UNLOCK_STORE=plaintext-file` |
| `apkfetch.py` | `/userdata/ouro/bin/` | Fetches Alpine `aarch64` packages (git and its libraries) without apk |
| `git-wrapper.sh` | `/userdata/ouro/git/bin/git` | Runs Alpine's git through musl's loader, with `GIT_EXEC_PATH` and the CA bundle |
| `hotfix-unlock-store.py` | `/userdata/ouro/bin/` | Makes `vault-unlock.js` honor `OURO_VAULT_UNLOCK_STORE`, until the harness release has it |
| `upgrade-ouro.sh` | `/userdata/ouro/bin/` | Upgrades `@ouro.bot/cli` in place: stop, install into the current folder, rename, relink, hotfix, start |
| `S99housesitter-watch` | `/etc/init.d/` | Runs `plugins/housesitter/watch.py`, niced, `oom_score_adj` 900 |
| `memsample.sh`, `S99housesitter-samples` | `/userdata/ouro/bin/`, `/etc/init.d/` | Every 30 s: MemAvailable, the sitter's heartbeat age and the agent's RSS, to `samples/mem.csv` |
| `boot-start.sh` | `/userdata/ouro/bin/`, root crontab `* * * * *` | Starts the sitter if it's down; once per boot, starts the agent's daemon, watcher and sampler |
| `publish-agent-status.py` | `/userdata/ouro/bin/`, root crontab `7 * * * *` | Writes `housesitter.agent.json` (Telegram state) to the KVM's outbox gist, once an hour |
| `show-pool.sh` | `/userdata/ouro/bin/` | Shows the discovered Copilot account pool and the latest account switches |

`/etc/init.d/S99ouro` isn't here: `ouro service install --init sysv …` writes it. No secret is in any of these files. Tokens live in `/userdata/ouro/secrets/` (root-only, 0600) and in the agent's vault.
