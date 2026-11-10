#!/usr/bin/env python3
"""Housesitter's MCP server: the sitter's eyes and hands, the peer link with Ouroboros, and the KVM's own health,
as MCP tools over stdio (JSON-RPC 2.0, one message a line). Python 3 standard library only.

It keeps no state of its own and runs nothing in the background: the harness may start several copies at once (the
daemon, each sense, each worker). Background watching is watch.py, its own process.

Env: HOUSESITTER_SITTER_CMD (default "python3 /etc/kvmd/user/housesitter/sitter.py"), HOUSESITTER_HOME (the sitter's
files), HOUSESITTER_STATE_DIR, HOUSESITTER_FLEET_GIST, HOUSESITTER_MAC, HOUSESITTER_DISK, and peer.py's.
"""
import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import peer  # noqa: E402

VERSION = "0.4.8"
PROTOCOL = "2025-06-18"
LONG_OPS = ("type", "unlock", "want_desktop", "power_cycle", "power_on")
SCREENS_KEPT = 50
MINI_STALE_MIN = 15
TIMEOUT_META = "ouro.bot/timeoutMs"


def env(name, default):
    return peer.env(name, default)


def now_iso():
    return peer.iso(time.time())


# ---------- the sitter ----------

def sitter(op, args=None, timeout=None):
    """Run `sitter.py do <op> '<json>'` and return its one JSON reply as it is, refusals included."""
    timeout = timeout or (120 if op in LONG_OPS else 30)
    cmd = shlex.split(env("HOUSESITTER_SITTER_CMD", "python3 /etc/kvmd/user/housesitter/sitter.py")) + ["do", op, json.dumps(args or {})]
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "code": "action-failed", "result": "the sitter didn't answer %s within %d s" % (op, timeout)}
    except OSError as e:
        return {"ok": False, "code": "action-failed", "result": "couldn't run the sitter: %s" % e}
    lines = [ln for ln in r.stdout.decode("utf-8", "replace").splitlines() if ln.strip()]
    try:
        return json.loads(lines[-1])
    except (IndexError, ValueError):
        err = r.stderr.decode("utf-8", "replace").strip().splitlines()
        return {"ok": False, "code": "action-failed", "result": "the sitter exited %d without a JSON reply%s" % (r.returncode, (": " + err[-1][:300]) if err else "")}


def save_screen(b64, label):
    """Write the frame to $HOUSESITTER_STATE_DIR/screens/ (newest 50 kept) and return its path and size."""
    d = os.path.join(peer.state_dir(), "screens")
    os.makedirs(d, exist_ok=True)
    jpg = base64.b64decode(b64)
    path = os.path.join(d, "%s-%s-%d.jpg" % (peer.stamp(time.time()), label, os.getpid()))
    with open(path, "wb") as f:
        f.write(jpg)
    old = sorted(n for n in os.listdir(d) if n.endswith(".jpg"))[:-SCREENS_KEPT]
    for n in old:
        try:
            os.remove(os.path.join(d, n))
        except OSError:
            pass
    return path, len(jpg)


def screenshot(width=None, label="screenshot"):
    """The sitter's screenshot: (reply without the base64, image content or None)."""
    rep = sitter("screenshot", {"width": int(width)} if width else {})
    files = rep.pop("files", None) or {}
    b64 = next((v for k, v in files.items() if k.endswith(".screen.jpg.b64")), None)
    if not b64:
        return rep, None
    path, size = save_screen(b64, label)
    rep["image"] = {"path": path, "bytes": size, "mimeType": "image/jpeg"}
    return rep, {"type": "image", "data": b64, "mimeType": "image/jpeg"}


# ---------- the mini's own heartbeat ----------

def mini_heartbeat(now=None):
    """The watched Mac's fleet heartbeat (<mac>.json in the fleet gist): when it was written, how old, what it says."""
    now = time.time() if now is None else now
    gist, mac = env("HOUSESITTER_FLEET_GIST", "ded3f1d37c2a756becc3333b0e4276b4"), env("HOUSESITTER_MAC", "aris-mac-mini")
    out = {"gist": gist, "file": "%s.json" % mac}
    try:
        g = peer.get_gist(gist)[2] or {}
        f = (g.get("files") or {}).get(out["file"])
        if not f:
            return dict(out, error="no %s in the fleet gist" % out["file"], stale=True)
        rec = json.loads(peer.file_content(f) or "")
    except (RuntimeError, ValueError) as e:
        return dict(out, error=str(e)[:300], stale=None)
    return dict(out, **beat_fields(rec, now))


def beat_fields(rec, now):
    at = peer.parse_iso(rec.get("at")) if isinstance(rec, dict) else None
    age = None if at is None else round((now - at) / 60.0, 1)
    summary = {k: v for k, v in rec.items() if not isinstance(v, (dict, list)) or len(json.dumps(v)) <= 300} if isinstance(rec, dict) else rec
    return {"at": rec.get("at") if isinstance(rec, dict) else None, "age_min": age, "stale": age is None or age > MINI_STALE_MIN, "summary": summary}


# ---------- the KVM itself ----------

def sitter_heartbeat(now=None):
    """The sitter rewrites status.json every interval (sitter.py once()); its mtime is the sitter's heartbeat."""
    now = time.time() if now is None else now
    path = os.path.join(env("HOUSESITTER_HOME", "/etc/kvmd/user/housesitter"), "status.json")
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return {"file": path, "error": "no status.json yet", "stale": True}
    st = peer.read_json(path, {}) or {}
    interval = int(st.get("interval_sec") or 60) if isinstance(st, dict) else 60
    age = int(now - mtime)
    return {"file": path, "written": peer.iso(mtime), "age_sec": age, "interval_sec": interval, "stale": age > 3 * interval,
            "state": st.get("state") if isinstance(st, dict) else None, "screen": ((st.get("obs") or {}).get("screen") if isinstance(st, dict) else None)}


def kvm_health():
    proc = env("HOUSESITTER_PROC", "/proc")
    out = {"at": now_iso()}
    try:
        mem = {}
        with open(os.path.join(proc, "meminfo")) as f:
            for line in f:
                k, _, v = line.partition(":")
                mem[k.strip()] = int(v.split()[0])
        out["mem"] = {"available_mb": mem.get("MemAvailable", 0) // 1024, "total_mb": mem.get("MemTotal", 0) // 1024,
                      "available_pct": round(100.0 * mem.get("MemAvailable", 0) / max(1, mem.get("MemTotal", 1)), 1)}
    except (OSError, ValueError, IndexError) as e:
        out["mem"] = {"error": str(e)}
    try:
        with open(os.path.join(proc, "loadavg")) as f:
            out["load"] = [float(x) for x in f.read().split()[:3]]
    except (OSError, ValueError) as e:
        out["load"] = {"error": str(e)}
    try:
        with open(os.path.join(proc, "uptime")) as f:
            out["uptime_min"] = int(float(f.read().split()[0]) // 60)
    except (OSError, ValueError, IndexError) as e:
        out["uptime_min"] = {"error": str(e)}
    disk = env("HOUSESITTER_DISK", "/userdata")
    try:
        u = shutil.disk_usage(disk)
        out["disk"] = {"path": disk, "free_mb": u.free // (1024 * 1024), "total_mb": u.total // (1024 * 1024)}
    except OSError as e:
        out["disk"] = {"path": disk, "error": str(e)}
    out["sitter"] = sitter_heartbeat()
    return out


# ---------- tools ----------

def schema(props=None, required=None):
    s = {"type": "object", "properties": props or {}, "additionalProperties": False}
    if required:
        s["required"] = required
    return s


NUM = {"type": "number"}
TOOLS = [
    ("sitter_status", "The sitter's status (state, what the screen reads as, its budgets, last incident) and the Mac's own fleet heartbeat from the fleet gist: when it was written, its age, whether it's stale (over 15 min), what it says. simulate \"stale-heartbeat\" is for drills: the same answer with the Mac's heartbeat marked stale and simulated: true; it changes nothing anywhere.",
     schema({"simulate": {"type": "string", "enum": ["stale-heartbeat"]}}), 60000, True),
    ("sitter_look", "A fresh look at the Mac's screen through the KVM: what the sitter makes of it (desktop, lock screen, FileVault, black), then the full picture as it is. The picture is attached as an image and saved as a JPEG; its path is in the answer.",
     schema({"width": NUM}), 70000, True),
    ("sitter_screenshot", "The Mac's screen through the KVM, the full picture as it is (default 1280 px wide). Attached as an image and saved as a JPEG; its path is in the answer. Click coordinates are in this picture's pixels with w and h set to its size.",
     schema({"width": NUM}), 40000, True),
    ("sitter_unlock", "Ask the sitter to unlock the Mac: FileVault or the lock screen, typing its own sealed copy of the password at a field it can see. Its reply comes back as it is, refusals included.",
     schema(), 130000, False),
    ("sitter_want_desktop", "Ask the sitter for the desktop for some minutes (default 10): it unlocks now, and again if the Mac locks meanwhile.",
     schema({"minutes": NUM}), 130000, False),
    ("sitter_power_cycle", "Ask the sitter to power-cycle the Mac through its smart plug (it keeps its own checks).", schema(), 130000, False),
    ("sitter_power_on", "Ask the sitter to power the Mac on (it keeps its own checks).", schema(), 130000, False),
    ("sitter_click", "Click on the Mac's screen. x, y are in the pixels of a picture w by h (default 1920x1080: pass the screenshot's own size). button left, right or middle; double for a double click.",
     schema({"x": NUM, "y": NUM, "w": NUM, "h": NUM, "button": {"type": "string", "enum": ["left", "right", "middle"]}, "double": {"type": "boolean"}}, ["x", "y"]), 40000, False),
    ("sitter_type", "Type text on the Mac through the KVM's keyboard (up to 2000 characters).", schema({"text": {"type": "string"}}, ["text"]), 130000, False),
    ("sitter_key", "Press a key or combination on the Mac, like \"cmd+space\", \"return\" or \"ctrl+alt+delete\".", schema({"combo": {"type": "string"}}, ["combo"]), 40000, False),
    ("sitter_scroll", "Scroll on the Mac: dx, dy wheel steps (negative dy is up), optionally at x, y first (same pixels as sitter_click).",
     schema({"dx": NUM, "dy": NUM, "x": NUM, "y": NUM, "w": NUM, "h": NUM}, ["dx", "dy"]), 40000, False),
    ("peer_send", "Send Ouroboros (the agent on the Mac) a message: free text, anything you want to say or ask. re is the id of the message you're answering. Messages are batched and go out within 6 minutes (status sent or queued); GitHub's gist writes are capped at 10 an hour each way.",
     schema({"text": {"type": "string"}, "to": {"type": "string"}, "re": {"type": "string"},
             "now": {"type": "boolean", "description": "send at once (counts against the 10/h cap); use for anything Ari or Ouroboros must hear now, like 'tell Ari' or 'about to restart'"}}, ["text"]), 45000, False),
    ("peer_inbox", "New messages from Ouroboros, oldest first, each with its id, time and text. Each comes back once; then it's marked read. It also sends any of your queued messages that are due.", schema(), 45000, False),
    ("kvm_health", "This KVM's own health: memory available, load, uptime, free space on /userdata, and whether the sitter's heartbeat (its status.json, rewritten every interval) is fresh. The sitter comes first: keep memory free for it.",
     schema(), 10000, True),
]


def tool_list():
    out = []
    for name, desc, sch, ms, ro in TOOLS:
        t = {"name": name, "description": desc, "inputSchema": sch, "_meta": {TIMEOUT_META: ms}}
        if ro:
            t["annotations"] = {"readOnlyHint": True}
        out.append(t)
    return out


def pick(a, keys):
    return {k: a[k] for k in keys if a.get(k) is not None}


def call(name, a):
    """Run one tool: (answer object, extra content items)."""
    if name == "sitter_status":
        if a.get("simulate") not in (None, "stale-heartbeat"):
            raise ValueError("simulate: only \"stale-heartbeat\"")
        out = {"at": now_iso(), "sitter": sitter("status"), "mini": mini_heartbeat()}
        if a.get("simulate"):
            out["mini"]["stale"] = True
            out["mini"]["age_min"] = max(out["mini"].get("age_min") or 0, MINI_STALE_MIN + 1)
            out["simulated"] = True
        return out, []
    if name == "sitter_look":
        look = sitter("look")
        shot, img = screenshot(a.get("width"), "look")
        return {"label": "look", "at": now_iso(), "look": look, "screenshot": shot}, [img] if img else []
    if name == "sitter_screenshot":
        shot, img = screenshot(a.get("width"))
        return dict({"label": "screenshot", "at": now_iso()}, **shot), [img] if img else []
    if name == "sitter_want_desktop":
        return sitter("want_desktop", dict(pick(a, ["minutes"]), by="housesitter")), []
    if name in ("sitter_unlock", "sitter_power_cycle", "sitter_power_on"):
        return sitter(name[len("sitter_"):]), []
    if name == "sitter_click":
        args = pick(a, ["x", "y", "w", "h", "button"])
        if a.get("double"):
            args["double"] = True
        return sitter("click", args), []
    if name == "sitter_type":
        return sitter("type", pick(a, ["text"])), []
    if name == "sitter_key":
        return sitter("key", pick(a, ["combo"])), []
    if name == "sitter_scroll":
        return sitter("scroll", pick(a, ["dx", "dy", "x", "y", "w", "h"])), []
    if name == "peer_send":
        return peer.send(a.get("text"), to=a.get("to") or "ouroboros", re_id=a.get("re"), now=a.get("now") is True), []
    if name == "peer_inbox":
        return peer.inbox(), []
    if name == "kvm_health":
        return kvm_health(), []
    raise KeyError(name)


# ---------- JSON-RPC over stdio ----------

NAMES = {t[0] for t in TOOLS}
WRITE = threading.Lock()


def send(msg, out):
    with WRITE:
        out.write(json.dumps(msg) + "\n")
        out.flush()


def tool_result(name, args):
    try:
        obj, extra = call(name, args or {})
        return {"content": [{"type": "text", "text": json.dumps(obj)}] + extra, "isError": False}
    except Exception as e:  # noqa: BLE001
        return {"content": [{"type": "text", "text": json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})}], "isError": True}


def respond(req, out):
    mid, method, params = req.get("id"), req.get("method"), req.get("params") or {}
    if mid is None:
        return  # a notification (notifications/initialized and friends): no reply
    if method == "initialize":
        result = {"protocolVersion": params.get("protocolVersion") or PROTOCOL, "capabilities": {"tools": {"listChanged": False}},
                  "serverInfo": {"name": "housesitter", "version": VERSION}}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": tool_list()}
    elif method == "tools/call":
        if params.get("name") not in NAMES:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "unknown tool %r" % params.get("name")}}, out)
            return
        result = tool_result(params["name"], params.get("arguments"))
    else:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found: %s" % method}}, out)
        return
    send({"jsonrpc": "2.0", "id": mid, "result": result}, out)


def serve(inp=sys.stdin, out=sys.stdout):
    workers = []
    for line in inp:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except ValueError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}, out)
            continue
        if not isinstance(req, dict):
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}, out)
            continue
        if req.get("method") == "tools/call":
            # A long unlock never holds up a status or a look asked for meanwhile.
            t = threading.Thread(target=respond, args=(req, out), daemon=True)
            t.start()
            workers = [w for w in workers if w.is_alive()] + [t]
        else:
            respond(req, out)
    for t in workers:
        t.join()


if __name__ == "__main__":
    serve()
