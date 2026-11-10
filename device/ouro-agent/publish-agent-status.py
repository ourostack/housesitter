#!/usr/bin/env python3
"""Publish Housesitter's own status as housesitter.agent.json in the Comet's outbox gist (read by `./mac arrival`).
Shape agreed with the office-reach lane: {"at", "telegram": {"last_in_at", "last_out_at", "chat_bound"}} plus the agent's
own facts. Run hourly from root's crontab; one gist write each run (the account's gist writes are budgeted)."""
import json, os, subprocess, time, urllib.request
GIST = os.environ.get("HOUSESITTER_OUTBOX_GIST", "45d5b649868399a96ea2b02e5afedab4")
TOKEN = open("/userdata/ouro/secrets/github-token").read().strip()
TG = "/userdata/ouro/housesitter/telegram.json"  # written by whatever binds Telegram; absent means not bound
iso = lambda t=None: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20).stdout.decode().strip()
    except Exception as e:
        return "error: %s" % e
tg = {"last_in_at": None, "last_out_at": None, "chat_bound": False}
if os.path.exists(TG):
    try:
        tg.update(json.load(open(TG)))
    except ValueError:
        pass
mem = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo") if l.startswith(("MemAvailable", "MemTotal"))}
peer_log = "/userdata/ouro/housesitter/peer-log.jsonl"
last_peer = None
if os.path.exists(peer_log):
    lines = open(peer_log).read().strip().splitlines()
    last_peer = json.loads(lines[-1]) if lines else None
body = {"at": iso(), "telegram": tg,
        "channel_to_ari": "telegram" if tg.get("chat_bound") else "through Ouroboros (Telegram not bound yet)",
        "daemon": sh("/etc/init.d/S99ouro status"), "watcher": sh("/etc/init.d/S99housesitter-watch status"),
        "sitter": sh("/etc/init.d/S99housesitter status"),
        "mem_available_mb": mem.get("MemAvailable", 0) // 1024, "mem_total_mb": mem.get("MemTotal", 0) // 1024,
        "last_peer": {"dir": last_peer.get("dir"), "at": (last_peer.get("msg") or {}).get("at"), "id": (last_peer.get("msg") or {}).get("id")} if isinstance(last_peer, dict) else None}
req = urllib.request.Request("https://api.github.com/gists/" + GIST, method="PATCH",
                             data=json.dumps({"files": {"housesitter.agent.json": {"content": json.dumps(body, indent=1)}}}).encode(),
                             headers={"Authorization": "token " + TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "housesitter-agent"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(iso(), "published", r.status)
except Exception as e:
    print(iso(), "publish failed", e)
