# Housesitter, the Ouro plugin

Housesitter is an [Ouro](https://github.com/ourostack/ouroboros) agent that lives on the IP-KVM beside a Mac. This plugin gives it:

- **The sitter's eyes and hands** as MCP tools: `sitter_status`, `sitter_look`, `sitter_screenshot`, `sitter_unlock`, `sitter_want_desktop`, `sitter_power_cycle`, `sitter_power_on`, `sitter_click`, `sitter_type`, `sitter_key`, `sitter_scroll`. Each runs `sitter.py do <op>` on the KVM and returns the sitter's reply as it is.
- **A peer link with Ouroboros**, the agent on the Mac: `peer_send` and `peer_inbox`, free text through two secret gists (`peer.py`).
- **`kvm_health`**: the KVM's memory, load, uptime, free space and the sitter's heartbeat.
- **A watcher** (`watch.py`) that wakes the agent with `ouro msg --to <agent>` (an ordinary turn with all its tools) when Ouroboros writes, the sitter's state or the screen changes, the sitter goes quiet, or the Mac's fleet heartbeat goes stale or comes back.
- **The skill** (`skills/housesitter/SKILL.md`) for using all of it.

Everything is Python 3 standard library only (3.9 and up); nothing to install on the KVM.

## Install

On the KVM (no git there), copy this directory to `~/.ouro-cli/plugins/housesitter/` in the agent's home, so that `~/.ouro-cli/plugins/housesitter/.mcp.json` exists. On a host with git:

```sh
ouro plugin install github:ourostack/housesitter:plugins/housesitter --agent housesitter
```

Then enable it in the agent's `agent.json` (the install command does this when given `--agent`):

```json
"plugins": [{ "id": "housesitter", "enabled": true, "source": "github:ourostack/housesitter:plugins/housesitter" }]
```

The harness starts the MCP server with the plugin directory as its working directory, so `.mcp.json` runs `python3 mcp/server.py`.

Start the watcher as its own long-running process (from the KVM's init script), with the same environment:

```sh
python3 ~/.ouro-cli/plugins/housesitter/watch.py >> /userdata/ouro/housesitter/watch.log 2>&1
```

## Environment

| Variable | Default | What |
| --- | --- | --- |
| `HOUSESITTER_SITTER_CMD` | `python3 /etc/kvmd/user/housesitter/sitter.py` | how to run the sitter |
| `HOUSESITTER_HOME` | `/etc/kvmd/user/housesitter` | the sitter's files (its `status.json` is its heartbeat) |
| `HOUSESITTER_STATE_DIR` | `/userdata/ouro/housesitter` | the plugin's own state: peer seen-set, ETags, `peer-log.jsonl`, `screens/`, `events/`, the watcher's memory |
| `HOUSESITTER_TOKEN_FILE` | `/userdata/ouro/secrets/github-token` | a GitHub token with gist scope; else `GH_TOKEN` or `GITHUB_TOKEN` |
| `HOUSESITTER_PEER_IN` | `d10a53ca03a65b26aa2a4bbb96cec03d` | the gist Ouroboros writes and Housesitter reads |
| `HOUSESITTER_PEER_OUT` | `94a9ee97baab459bb32a37d6dbb7c52d` | the gist Housesitter writes and Ouroboros reads |
| `HOUSESITTER_FLEET_GIST` | `ded3f1d37c2a756becc3333b0e4276b4` | the fleet gist with the Mac's heartbeat |
| `HOUSESITTER_MAC` | `aris-mac-mini` | the Mac's heartbeat file there, `<mac>.json` |
| `HOUSESITTER_DISK` | `/userdata` | the disk `kvm_health` reports on |
| `HOUSESITTER_WATCH_SEC` | `30` | the watcher's interval |
| `HOUSESITTER_OURO_BIN` | `ouro` | the `ouro` command the watcher runs |
| `HOUSESITTER_AGENT` | `housesitter` | the agent the watcher wakes |

## The peer link

One immutable gist file per message, `<UTC yyyymmddTHHMMSSZ>-<8 hex>.json`, holding `{"v":1,"id","at","from","to","text","re"?}`. A send also deletes the sender's own files older than 24 hours. A read uses ETags, so an unchanged gist costs nothing. From the shell: `python3 peer.py send <text> [--re <id>]`, `python3 peer.py inbox`, `python3 peer.py prune`. On the Mac, Ouroboros uses `housesitter peer send <text> [--re <id>]` and `housesitter peer inbox`.
