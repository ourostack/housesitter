"""Stands in for `ouro` in the watcher's tests: logs its argv as one JSON line, exits FAKE_OURO_EXIT (default 0)."""
import json
import os
import sys

with open(os.environ["FAKE_OURO_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
sys.exit(int(os.environ.get("FAKE_OURO_EXIT", "0")))
