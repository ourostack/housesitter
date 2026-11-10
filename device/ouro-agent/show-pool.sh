#!/bin/sh
. /userdata/ouro/env.sh
echo "$ ouro auth --agent Housesitter --provider github-copilot"
ouro auth --agent Housesitter --provider github-copilot 2>&1 | grep -E "skipped|account pool|credentials stored|verifying" | uniq
echo
echo "# account switches (daemon log, newest last)"
grep -h account_switched $HOME/.ouro-cli/daemon/logs/daemon.ndjson $HOME/AgentBundles/Housesitter.ouro/state/daemon/logs/*.ndjson 2>/dev/null | python3 -c '
import json,sys
for l in sys.stdin:
    d=json.loads(l); print(d["ts"][:19]+"Z ", d["message"])' | sort | tail -4
