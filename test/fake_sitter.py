"""Stands in for `sitter.py do <op> '<json>'` in the plugin's tests: logs each call, answers like the sitter."""
import base64
import json
import os
import sys

JPEG = b"\xff\xd8\xff\xe0fake-jpeg-frame\xff\xd9"

if sys.argv[1] == "peer-verify":
    print(json.dumps({"verified": False, "authorized": False, "reason": "unsigned"}))
    sys.exit(0)
if sys.argv[1] != "do":
    with open(os.environ["FAKE_SITTER_LOG"], "a") as f:
        f.write(json.dumps({"argv1": sys.argv[1], "op": None, "args": sys.argv[2:]}) + "\n")
    if "--hours" in sys.argv and sys.argv[sys.argv.index("--hours") + 1] == "99":
        print("setup-mode: --hours: more than 0, at most 24", file=sys.stderr)
        sys.exit(2)
    print(json.dumps({"setup": {"argv": sys.argv[2:]}}))
    sys.exit(0)
op, args = sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
with open(os.environ["FAKE_SITTER_LOG"], "a") as f:
    f.write(json.dumps({"argv1": sys.argv[1], "op": op, "args": args}) + "\n")
if op == os.environ.get("FAKE_SITTER_REFUSE"):
    print(json.dumps({"ok": False, "code": "action-unavailable", "result": "the Mac is at a password screen; only the sitter types there"}))
    sys.exit(2)
if op == "screenshot":
    print(json.dumps({"ok": True, "result": {"bytes": len(JPEG), "file": "mini.screen.jpg.b64", "real": [2560, 1440]},
                      "files": {"mini.screen.jpg.b64": base64.b64encode(JPEG).decode("ascii")}}))
elif op == "status":
    print(json.dumps({"ok": True, "result": {"v": 1, "state": "healthy", "obs": {"screen": "desktop"}, "interval_sec": 60}}))
elif op == "look":
    print(json.dumps({"ok": True, "result": {"state": "healthy", "obs": {"screen": "desktop"}}}))
else:
    print("a log line before the reply")
    print(json.dumps({"ok": True, "result": {"op": op, "args": args}}))
