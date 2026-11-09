#!/usr/bin/env python3
"""housesitter's sitter: the always-on watcher that runs on the KVM plugged into your Mac.

It needs nothing else to be up. Every minute it looks at the Mac, with no help from it:
  - the picture: kvmd's own OCR on a snapshot (FileVault/login prompt, desktop, blank), and whether the menu-bar
    clock still changes (a frozen desktop is a hang). Where the KVM has no working OCR (a GL.iNet Comet at 2560x1440),
    it decodes a frame on the device itself and reads it without OCR: a menu bar means a desktop, and a password prompt
    is one an operator taught it (learn-prompt), matched pixel by pixel (the boot watch, below);
  - the HDMI signal (kvmd /streamer);
  - the Mac's network stack, when the Mac is on this KVM's own network: one ping to make the kernel resolve ARP, then
    /proc/net/arp (macOS answers ARP even in stealth mode, and a hung kernel doesn't);
  - optionally a TCP port on the Mac (health), and the smart plug's relay and power draw.
It decides with the same rules as src/watchdog.mjs (both run spec/watchdog-cases.json) and acts locally:
  - unlock FileVault by typing the Mac's password, which it holds itself, sealed, so a panic at 3 am is unlocked in
    minutes with no laptop, cloud or internet. Only where the password field itself is on the KVM's own picture: read
    by OCR, or matched against a prompt an operator taught it from three frames (learn-prompt). By itself only after a
    boot (the screen went dark, then the Mac enumerated the KVM's keyboard again; or the prompt it was taught at a boot
    is on the picture of a KVM that has itself just started); a plain lock screen only when you ask over SSH. Never
    blind: a settled screen without the field is reported, never typed into. At most twice a boot, three times an hour;
  - power-cycle a hung Mac through a smart plug (Shelly Switch.Set with toggle_after, so the plug switches itself
    back on even if this process dies), switch it on, or press its power button with a Fingerbot;
  - tell you when it's stuck (ntfy or any webhook), and once more when the Mac is back.

The outbox (optional): two secret gists. The sitter writes its status to the outbox and polls the inbox for
commands every couple of seconds, with ETags. That is how agents reach it from anywhere with only GitHub.

Secrets are root-only 0600 files, sealed with a key bound to this device's own ids, so a copied file is useless
elsewhere: mac.cred (the Mac's password), kvmd.cred (the KVM's admin password), outbox.cred (a gist-only token).
Written by `sitter.py store-secret <name>` from stdin; never in argv, logs or status.

Files: $HOUSESITTER_HOME (default /etc/kvmd/user/housesitter): config.json, *.cred, state.json, status.json,
sitter.log. Python 3 standard library only: nothing to pip-install, so a firmware update can't break a dependency.
https://github.com/ourostack/housesitter
"""
import base64
import hashlib
import hmac
import http.client
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.1.0"
HOME = os.environ.get("HOUSESITTER_HOME", "/etc/kvmd/user/housesitter")

DEFAULTS = {
    "hung_min": 5, "off_min": 2, "down_min": 10, "filevault_min": 0, "filevault_wait_min": 10, "unlocks_per_hour": 3, "settle_min": 4,
    "cycle_gap_min": 30, "cycles_per_day": 3, "on_gap_min": 10, "max_failed": 2, "remind_hours": 6, "idle_watts": 2,
}


# ---------- the rules (a port of src/watchdog.mjs; both run spec/watchdog-cases.json) ----------

def raw_state(o, cfg=DEFAULTS):
    g = o.get
    up = g("answers") is True or (g("beat_min") is not None and g("beat_min") <= 3 and g("presence") is not False)
    if up:
        return "degraded" if g("screen") == "filevault" else "healthy"
    if g("screen") in ("filevault", "login"):
        return "filevault"
    watts = g("watts")
    powered = (watts is not None and watts >= cfg["idle_watts"]) or g("video") is True or g("arp") is True
    unpowered = g("plug_on") is False or (watts is not None and watts < cfg["idle_watts"])
    if unpowered:
        return "off"
    if not any(g(k) is not None for k in ("answers", "beat_min", "presence", "screen", "video", "arp", "watts")):
        return "unknown"
    if g("video") is False and g("arp") is not True and not powered:
        return "off"
    if g("screen") == "desktop" and g("clock_ticking") is True:
        return "degraded"
    down = g("answers") is False or (g("beat_min") is not None and g("beat_min") > 3) or g("presence") is False or g("arp") is False
    if down and (powered or g("screen") in ("blank", "desktop")):
        return "hung"
    if down and all(g(k) is None for k in ("screen", "video", "watts", "arp")):
        return "down"
    if g("video") is False and powered and g("answers") is not True:
        return "down"
    return "degraded"


def advance(mem, raw, now, cfg=DEFAULTS):
    m = dict(mem or {})
    if m.get("raw") != raw:
        m["raw"], m["raw_since"] = raw, now
    held = (now - m["raw_since"]) / 60000
    need = {"hung": cfg["hung_min"], "off": cfg["off_min"], "filevault": cfg["filevault_min"], "down": cfg["down_min"]}.get(raw, 0)
    state = "degraded" if held < need else raw
    if state != m.get("state"):
        m["state"], m["since"] = state, now
    if state == "healthy":
        m["incident"] = None
    elif not m.get("incident") and state != "degraded":
        m["incident"] = {"started": now, "notified_at": None, "failed": {}}
    return m


def _recent(ledger, kind, now, mins):
    return [a for a in ledger if a["kind"] == kind and now - a["at"] < mins * 60000]


def decide(mem, ledger, now, caps, cfg=DEFAULTS):
    s = mem["state"]
    acts = []
    non_notify = [a for a in ledger if a["kind"] != "notify"]
    last = non_notify[-1] if non_notify else None
    settling = last is not None and now - last["at"] < cfg["settle_min"] * 60000 and last.get("state") == s
    inc = mem.get("incident")

    def failed_twice(kind):
        return ((inc or {}).get("failed") or {}).get(kind, 0) >= cfg["max_failed"]

    def want(kind, why):
        if failed_twice(kind):
            return False
        acts.append({"kind": kind, "why": why})
        return True

    stuck = None
    if s == "healthy":
        if mem.get("recovered_pending"):
            acts.append({"kind": "notify", "why": "recovered", "recovered": True})
        return acts
    if settling and s != "degraded":
        return [{"kind": "wait", "why": "settling after %s" % last["kind"]}]
    if s == "filevault":
        if caps.get("unlock"):
            if len(_recent(ledger, "unlock", now, 60)) >= cfg["unlocks_per_hour"]:
                stuck = "unlock budget used (%d in the last hour): it keeps coming back to FileVault" % cfg["unlocks_per_hour"]
            elif not want("unlock", "at the FileVault/login screen"):
                stuck = "the password was wrong twice. Fix: housesitter secret <mac> mac-password, then housesitter adopt <mac>"
        elif (now - mem["since"]) / 60000 >= cfg["filevault_wait_min"]:
            stuck = "at the FileVault screen for %d+ min and the sitter has not unlocked it. Look: housesitter status <mac>" % cfg["filevault_wait_min"]
    elif s == "hung":
        cycles = len(_recent(ledger, "power_cycle", now, 24 * 60))
        gap_ok = not _recent(ledger, "power_cycle", now, cfg["cycle_gap_min"])
        if caps.get("plug") and gap_ok and cycles < cfg["cycles_per_day"]:
            if not want("power_cycle", "powered but not answering for %d+ min" % cfg["hung_min"]):
                stuck = "power cycles did not bring it back"
        elif caps.get("fingerbot") and gap_ok and cycles < cfg["cycles_per_day"]:
            if not want("press_power", "hung; long press to force off, then press to start"):
                stuck = "Fingerbot presses did not bring it back"
        else:
            stuck = ("power-cycle budget used (%d today)" % cycles) if (caps.get("plug") or caps.get("fingerbot")) else "hung, and no smart plug or Fingerbot to restart it"
    elif s == "off":
        gap_ok = not _recent(ledger, "power_on", now, cfg["on_gap_min"])
        if (caps.get("plug") or caps.get("fingerbot")) and gap_ok:
            if not want("power_on", "no power or no signal"):
                stuck = "it does not come back on"
        elif not caps.get("plug") and not caps.get("fingerbot"):
            stuck = "off, and nothing here can switch it on (power outage, unplugged, or shut down)"
    elif s == "down":
        stuck = "not answering for %d+ min, and nothing here can see why (no picture on the KVM: is FileVault on another display, or did the display sleep?)" % cfg["down_min"]
    elif s == "unknown":
        if (now - mem["since"]) / 60000 >= 15:
            stuck = "this watcher has seen no sign of the Mac for 15 minutes"
    if stuck and caps.get("notify") and inc:
        due = inc.get("notified_at") is None or now - inc["notified_at"] >= cfg["remind_hours"] * 3600000
        if due:
            acts.append({"kind": "notify", "why": stuck})
    return acts


def judge(mem, ledger, now, cfg=DEFAULTS):
    m = dict(mem)
    if m.get("incident"):
        m["incident"] = dict(m["incident"], failed=dict(m["incident"].get("failed") or {}))
    acted = [a for a in ledger if a["kind"] not in ("notify", "wait")]
    last = acted[-1] if acted else None
    if not last or last.get("judged") or now - last["at"] < cfg["settle_min"] * 60000 or not m.get("incident") or last["at"] < m["incident"]["started"]:
        return m, None
    fixed = m["state"] == "healthy" or (last.get("state") != m["state"] and m["state"] not in ("off", "hung"))
    if not fixed:
        m["incident"]["failed"][last["kind"]] = m["incident"]["failed"].get(last["kind"], 0) + 1
    last["judged"], last["fixed"] = True, fixed
    return m, {"kind": last["kind"], "fixed": fixed}


def tick(mem, ledger, obs, now, caps, cfg=DEFAULTS):
    was_bad = (mem or {}).get("incident") is not None
    m = advance(mem, raw_state(obs, cfg), now, cfg)
    if m["state"] == "healthy" and was_bad and ((mem or {}).get("incident") or {}).get("notified_at") is not None:
        m["recovered_pending"] = True
    m, _ = judge(m, ledger, now, cfg)
    actions = decide(m, ledger, now, caps, cfg)
    if any(a.get("recovered") for a in actions):
        m["recovered_pending"] = False
    return m, actions


# ---------- what the screen is (a port of src/screen.mjs) ----------

MENU = re.compile(r"\b(Finder|File|Edit|View|Window|Help|Go)\b[\s\S]*\b(File|Edit|View|Window|Help)\b")
APPS = re.compile(r"\b(Terminal|Safari|Google Chrome|Microsoft Edge|Firefox|Slack|Mail|Messages|Xcode|Visual Studio Code|Ghostty|iTerm|Activity Monitor|System Settings)\b")


def classify_screen(text, user_names=()):
    if text is None:
        return "unknown"
    t = str(text)
    if not t.strip():
        return "blank"
    if MENU.search(t) or APPS.search(t):
        return "desktop"
    names = [re.escape(n) for n in user_names if n]
    around = r"(Restart|Shut Down|Sleep|FileVault|Other|Switch User%s)" % ("|" + "|".join(names) if names else "")
    if re.search(r"Enter Password|Password", t, re.I) and re.search(around, t, re.I):
        return "filevault" if re.search(r"FileVault|Disk Password|unlock", t, re.I) else "login"
    if re.search(r"Screen Time|Lock Screen|is locked", t, re.I):
        return "login"
    return "unknown"


# ---------- keys and pointer (the same tables as src/keys.mjs) ----------

KEY_ALIASES = {"cmd": "MetaLeft", "command": "MetaLeft", "meta": "MetaLeft", "super": "MetaLeft", "shift": "ShiftLeft", "ctrl": "ControlLeft",
               "control": "ControlLeft", "alt": "AltLeft", "option": "AltLeft", "opt": "AltLeft", "return": "Enter", "enter": "Enter",
               "esc": "Escape", "escape": "Escape", "tab": "Tab", "space": "Space", "delete": "Backspace", "backspace": "Backspace",
               "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight", "home": "Home", "end": "End",
               "pageup": "PageUp", "pagedown": "PageDown", "page_up": "PageUp", "page_down": "PageDown"}


def key_names(combo):
    out = []
    for part in [p.strip() for p in str(combo).split("+") if p.strip()]:
        low = part.lower()
        if low in KEY_ALIASES:
            out.append(KEY_ALIASES[low])
        elif len(part) == 1 and part.isascii() and part.isalpha():
            out.append("Key" + part.upper())
        elif len(part) == 1 and part.isdigit():
            out.append("Digit" + part)
        elif re.fullmatch(r"[fF]([1-9]|1[0-2])", part):
            out.append(part.upper())
        elif re.fullmatch(r"[A-Z][A-Za-z0-9]+", part):
            out.append(part)
        else:
            raise ValueError('unknown key "%s"' % part)
    if not out:
        raise ValueError("empty key combo")
    return out


def abs_point(x, y, w, h):
    """Screen pixels -> kvmd's absolute mouse range (-32768..32767 on each axis)."""
    if not (0 <= x < w and 0 <= y < h):
        raise ValueError("point %d,%d is off the %dx%d screen" % (x, y, w, h))
    tx = int((x * 65535 / max(1, w - 1)) + 0.5) - 32768
    ty = int((y * 65535 / max(1, h - 1)) + 0.5) - 32768
    return max(-32768, min(32767, tx)), max(-32768, min(32767, ty))


# ---------- kvmd, over its own unix socket (paths without nginx's /api prefix) ----------

class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=10):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._path)


def refuse_reshape(method, path):
    """Never reshape what the Mac sees: no EDID writes, no factory reset, no firmware upgrade through this sitter. An
    EDID change on a live Mac mini froze it (2026-11-08). Checked below every kvmd call, so nothing can get round it."""
    q = str(path).split("?")[0].lower()
    if "edid" in q and method != "GET":
        return "refused: %s changes the display the Mac sees; never reshape a live Mac's displays" % q
    if re.search(r"reset_default|factory|/upgrade(/|$)", q) and (method != "GET" or "reset" in q or "factory" in q):
        return "refused: %s resets or reflashes the KVM, EDID included; never from housesitter" % q
    return None


class Kvmd:
    def __init__(self, sock="/run/kvmd/kvmd.sock", user="admin", passwd=""):
        self.sock, self.user, self.passwd = sock, user, passwd

    def request(self, method, path, body=None, timeout=15):
        refused = refuse_reshape(method, path)
        if refused:
            raise RuntimeError("kvmd: %s" % refused)
        c = UnixHTTPConnection(self.sock, timeout)
        headers = {"X-KVMD-User": self.user, "X-KVMD-Passwd": self.passwd}
        if body is not None:
            headers["Content-Type"] = "text/plain"
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse()
        data = r.read()
        c.close()
        if r.status != 200:
            raise RuntimeError("kvmd %s %s -> HTTP %d" % (method, path.split("?")[0], r.status))
        return data

    def get(self, path, timeout=15):
        return self.request("GET", path, timeout=timeout)

    def post(self, path, body=None, timeout=60):
        return self.request("POST", path, body=body, timeout=timeout)

    def json(self, path):
        j = json.loads(self.get(path).decode("utf-8"))
        return j.get("result", j)


# GLKVM runs its video encoder only while a video client is connected; with none, /streamer reports streamer=null
# and every snapshot (and so OCR) 503s. Holding kvmd's /ws open in stream mode starts it. At high resolutions it can
# hand back a lone H.264 NAL labelled JPEG; switching to MJPEG (video_format=1, GLKVM V1.9.1+) fixes that. Both
# findings are kvm-pilot's, from real GL-RM1PE units: https://github.com/DustinTrap/kvm-pilot (issues 142, 107, 187).

class StreamWarm:
    def __init__(self, kvmd, wait=10.0, sleep=time.sleep):
        self.kvmd, self.wait, self.sleep, self.sock = kvmd, wait, sleep, None

    def __enter__(self):
        if not isinstance(self.kvmd, Kvmd):
            return self
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(self.kvmd.sock)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        s.sendall(("GET /ws?stream=1 HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nX-KVMD-User: %s\r\nX-KVMD-Passwd: %s\r\n\r\n"
                   % (key, self.kvmd.user, self.kvmd.passwd)).encode("utf-8"))
        head = b""
        while b"\r\n\r\n" not in head and len(head) < 8192:
            chunk = s.recv(1024)
            if not chunk:
                break
            head += chunk
        if not head.startswith(b"HTTP/1.1 101"):
            s.close()
            raise RuntimeError("kvmd /ws refused a stream client: %s" % head[:40])
        self.sock = s
        end = time.time() + self.wait
        while time.time() < end:
            try:
                if self.kvmd.json("/streamer").get("streamer"):
                    break
            except Exception:  # noqa: BLE001
                pass
            self.sleep(0.5)
        return self

    def __exit__(self, *a):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        return False


def is_jpeg(b):
    return isinstance(b, (bytes, bytearray)) and b[:2] == b"\xff\xd8"


def snapshot_jpeg(kvmd, query="allow_offline=1"):
    with StreamWarm(kvmd):
        img = kvmd.get("/streamer/snapshot?%s" % query, timeout=20)
        if is_jpeg(img):
            return img
        kvmd.post("/streamer/set_params?video_format=1", timeout=15)
        time.sleep(1.5)
        img = kvmd.get("/streamer/snapshot?%s" % query, timeout=20)
        if is_jpeg(img):
            return img
        # GL-RM1PE V1.7.1 at 2560x1440 stays on H.264 either way (seen 2026-11-08): put the encoder back and decode a
        # keyframe on the device instead. Never change the EDID or the Mac's display mode to get a picture.
        try:
            kvmd.post("/streamer/set_params?video_format=0", timeout=15)
        except Exception:  # noqa: BLE001
            pass
    return frame_jpeg(kvmd)


def ocr_text(kvmd, box=None):
    q = "ocr=1&allow_offline=1" + ("&ocr_left=%d&ocr_top=%d&ocr_right=%d&ocr_bottom=%d" % tuple(box) if box else "")
    with StreamWarm(kvmd):
        text = kvmd.json("/streamer/snapshot?%s" % q)
    return text if isinstance(text, str) else json.dumps(text)


def real_size(kvmd):
    try:
        src = (kvmd.json("/streamer").get("streamer") or {}).get("source") or {}
        r = src.get("resolution") or {}
        if r.get("width"):
            return {"width": int(r["width"]), "height": int(r["height"])}
    except Exception:  # noqa: BLE001
        pass
    return {"width": 1920, "height": 1080}


def is_gl(exists=os.path.exists):
    return exists("/proc/gl-hw-info")


def harden(kvmd, cfg=None, run=subprocess.run, gl=None):
    """GL.iNet's cloud binding (Astrowarp) off, read back as disabled or this fails; then ingress for where the KVM is
    (location "home": the LAN may reach SSH and HTTPS; anywhere else: only tailscale0)."""
    cfg = cfg or {}
    out = {}
    if gl if gl is not None else is_gl():
        kvmd.get("/astrowarp/enable?enable=false", timeout=20)
        st = kvmd.json("/astrowarp/status")
        if not isinstance(st, dict) or st.get("enabled") is not False:
            raise RuntimeError("GL.iNet's cloud binding did not read back as disabled (status: %s); not hardened" % json.dumps(st)[:80])
        out["gl_cloud"] = "off (read back)"
    else:
        out["gl_cloud"] = "n/a (not a GL.iNet KVM)"
    out["ingress"] = apply_ingress(ingress_mode(cfg), run=run)
    return out


INGRESS_PORTS = (22, 443)
CHAIN = "HOUSESITTER_IN"


def ingress_mode(cfg):
    """At home, the LAN may reach the KVM's SSH and HTTPS (setup, and your own devices). Anywhere else (an office's
    guest network, a colo) only the tailnet may."""
    return "lan" if (cfg.get("location") or "home") == "home" else "tailnet"


def ingress_rules(mode, ports=INGRESS_PORTS):
    """The firewall commands for a mode, for iptables and ip6tables alike. Pure, so it is tested."""
    rules = []
    for t in ("iptables", "ip6tables"):
        rules += [[t, "-N", CHAIN], [t, "-F", CHAIN]]
        if mode == "tailnet":
            rules += [[t, "-A", CHAIN, "-i", "lo", "-j", "RETURN"], [t, "-A", CHAIN, "-i", "tailscale0", "-j", "RETURN"],
                      [t, "-A", CHAIN, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"]]
            rules += [[t, "-A", CHAIN, "-p", "tcp", "--dport", str(p), "-j", "DROP"] for p in ports]
        rules += [[t, "-C", "INPUT", "-j", CHAIN]]
    return rules


def tailnet_running(run=subprocess.run):
    """Joined and running, with a tailnet address: only then can tailnet-only ingress still reach the KVM."""
    try:
        r = run(["tailscale", "status", "--json", "--peers=false"], capture_output=True, text=True, timeout=10)
        j = json.loads(r.stdout or "{}")
        return j.get("BackendState") == "Running" and bool((j.get("Self") or {}).get("TailscaleIPs") or j.get("TailscaleIPs"))
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def apply_ingress(mode, run=subprocess.run, iface_up=lambda i: os.path.exists("/sys/class/net/%s" % i), joined=None):
    if mode == "tailnet" and not (iface_up("tailscale0") and (joined if joined is not None else tailnet_running(run))):
        raise RuntimeError("refusing tailnet-only SSH and HTTPS: this KVM hasn't joined a running tailnet, so nothing could reach it. Join first (adopt does, with a tagged auth key)")
    for cmd in ingress_rules(mode):
        r = run(cmd, capture_output=True, text=True, timeout=10)
        if cmd[1] == "-C" and r.returncode != 0:
            r = run([cmd[0], "-I", "INPUT", "-j", CHAIN], capture_output=True, text=True, timeout=10)
        if r.returncode != 0 and cmd[1] not in ("-N",):
            raise RuntimeError("%s failed: %s" % (" ".join(cmd), (r.stderr or "")[:120]))
    return "SSH and HTTPS from %s" % ("the LAN and the tailnet" if mode == "lan" else "the tailnet only (tailscale0)")


CERT_PATHS = ("/etc/kvmd/nginx/ssl/server.crt", "/etc/kvmd/nginx/ssl/server.pem", "/etc/nginx/ssl/server.crt")


def cert_fingerprint(paths=CERT_PATHS, read=lambda p: open(p).read()):
    """The SHA-256 fingerprint of the KVM's own HTTPS certificate, read on the KVM itself: compare it, out of band,
    with the one adopt pinned on first contact."""
    for path in paths:
        try:
            pem = read(path)
        except OSError:
            continue
        m = re.search(r"-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----", pem, re.S)
        if m:
            der = base64.b64decode("".join(m.group(1).split()))
            h = hashlib.sha256(der).hexdigest().upper()
            return {"path": path, "sha256": ":".join(h[i:i + 2] for i in range(0, len(h), 2))}
    raise RuntimeError("no certificate found at %s" % ", ".join(paths))


NGINX_CONF = "/etc/kvmd/nginx-kvmd.conf"


def enable_api(path=NGINX_CONF):
    """GL.iNet ships the kvmd REST API off (every /api/* 404s): uncomment the commented `location /api...` blocks in
    nginx-kvmd.conf. Keeps a copy of the original; returns how many blocks it opened. Idempotent."""
    with open(path) as f:
        lines = f.read().split("\n")
    out, opened, depth, inside = [], 0, 0, False
    for line in lines:
        m = re.match(r"^(\s*)#(.*)$", line)
        body = m.group(2) if m else None
        if not inside and body is not None and re.match(r"location\s+(=\s*)?/api\b", body.strip()):
            inside, depth, opened = True, 0, opened + 1
        if inside and body is not None:
            out.append(m.group(1) + body)
            depth += body.count("{") - body.count("}")
            if depth <= 0 and "}" in body:
                inside = False
            continue
        inside = inside and body is not None
        out.append(line)
    if opened:
        if not os.path.exists(path + ".orig-housesitter"):
            with open(path + ".orig-housesitter", "w") as f:
                f.write("\n".join(lines))
        with open(path + ".new", "w") as f:
            f.write("\n".join(out))
        os.replace(path + ".new", path)
    return opened


# ---------- the Mac's network, when it's on ours ----------

def _ip(a):
    return int.from_bytes(socket.inet_aton(a), "big")


def local_ips(ips, read_route=lambda: open("/proc/net/route").read()):
    """The Mac addresses on a network this KVM is directly on. When the KVM sits on a different network from the Mac
    (a guest network at an office, say), ARP could only ever say "no", so it is skipped (None), never read as down."""
    nets = []
    for line in read_route().splitlines()[1:]:
        f = line.split()
        if len(f) >= 8 and f[2] == "00000000" and f[1] != "00000000":
            dest = int.from_bytes(bytes.fromhex(f[1])[::-1], "big")
            mask = int.from_bytes(bytes.fromhex(f[7])[::-1], "big")
            nets.append((dest, mask))
    return [ip for ip in ips if any((_ip(ip) & m) == d for d, m in nets)]


def arp_alive(ips, macs, run=subprocess.run, read=lambda: open("/proc/net/arp").read(), on_link=local_ips):
    if ips:
        try:
            ips = on_link(ips)
        except (OSError, ValueError):
            ips = []
    if not ips:
        return None
    for ip in ips:
        run(["ping", "-c", "1", "-W", "1", ip], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for line in read().splitlines()[1:]:
        f = line.split()
        if len(f) >= 4 and f[0] in ips and f[2] == "0x2" and (not macs or f[3].lower() in macs):
            return True
    return False


def tcp_answers(health, connect=socket.create_connection):
    """An optional health probe: True if the Mac accepts a TCP connection on host:port now (an SSH port, an agent's
    own health endpoint). None when not configured."""
    if not health or not health.get("host") or not health.get("port"):
        return None
    try:
        s = connect((health["host"], int(health["port"])), timeout=3)
        s.close()
        return True
    except OSError:
        return False


# ---------- power: pluggable adapters ----------

class ShellyHttp:
    """Shelly Gen2+ local RPC over the LAN. Switch.Set with toggle_after: the plug switches itself back on."""
    kind = "shelly"

    def __init__(self, url, opener=urllib.request.urlopen):
        self.url, self.opener = url.rstrip("/"), opener

    def rpc(self, method, **params):
        q = urllib.parse.urlencode({k: (str(v).lower() if isinstance(v, bool) else v) for k, v in params.items()})
        with self.opener("%s/rpc/%s?%s" % (self.url, method, q), timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))

    def status(self):
        s = self.rpc("Switch.GetStatus", id=0)
        return {"on": bool(s.get("output")), "watts": s.get("apower")}

    def cycle(self, off_sec=10):
        return self.rpc("Switch.Set", id=0, on=False, toggle_after=off_sec)

    def on(self):
        return self.rpc("Switch.Set", id=0, on=True)


SHELLY_BLE = {
    "service": "5f6d4f53-5f52-5043-5f53-56435f49445f",
    "data": "5f6d4f53-5f52-5043-5f64-6174615f5f5f",
    "tx_ctl": "5f6d4f53-5f52-5043-5f74-785f63746c5f",
    "rx_ctl": "5f6d4f53-5f52-5043-5f72-785f63746c5f",
}


class ShellyBle(ShellyHttp):
    """The same Shelly plug over Bluetooth, for a network the plug can't join (a captive-portal guest network).
    Shelly's documented RPC-over-GATT framing: write the request length (4 bytes, big-endian) to tx_ctl, the JSON to
    data, then read the reply length from rx_ctl and the reply from data. `connect(mac)` gives a context manager with
    write(uuid, bytes) and read(uuid) -> bytes (bleak on a KVM with a Bluetooth adapter, a fake in tests)."""
    kind = "shelly-ble"

    def __init__(self, mac, connect=None, chunk=180):
        self.mac, self.connect, self.chunk, self._id = mac, connect or bleak_connect, chunk, 0

    def rpc(self, method, **params):
        self._id += 1
        req = json.dumps({"id": self._id, "src": "housesitter", "method": method, "params": params}).encode("utf-8")
        with self.connect(self.mac) as g:
            g.write(SHELLY_BLE["tx_ctl"], len(req).to_bytes(4, "big"))
            for i in range(0, len(req), self.chunk):
                g.write(SHELLY_BLE["data"], req[i:i + self.chunk])
            n = int.from_bytes(g.read(SHELLY_BLE["rx_ctl"]), "big")
            buf = b""
            while len(buf) < n:
                part = g.read(SHELLY_BLE["data"])
                if not part:
                    break
                buf += part
        reply = json.loads(buf.decode("utf-8"))
        if "error" in reply:
            raise RuntimeError("plug: %s" % reply["error"].get("message", reply["error"]))
        return reply.get("result", {})


class _BleakConn:
    def __init__(self, mac):
        import asyncio
        from bleak import BleakClient  # noqa: PLC0415 (only where a Bluetooth adapter and bleak exist)
        self.loop = asyncio.new_event_loop()
        self.c = BleakClient(mac)
        self.loop.run_until_complete(self.c.connect(timeout=10))

    def write(self, uuid, data):
        self.loop.run_until_complete(self.c.write_gatt_char(uuid, data, response=True))

    def read(self, uuid):
        return bytes(self.loop.run_until_complete(self.c.read_gatt_char(uuid)))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        try:
            self.loop.run_until_complete(self.c.disconnect())
        finally:
            self.loop.close()
        return False


def bleak_connect(mac):
    return _BleakConn(mac)


class CommandPower:
    """Any plug or relay you can drive from a shell: {"kind": "command", "cycle": "...", "on": "...", "status": "..."}.
    status prints JSON {"on": bool, "watts": number} (optional). Commands run without a shell from a word list."""
    kind = "command"

    def __init__(self, cfg, run=subprocess.run):
        self.cfg, self.run = cfg, run

    def _do(self, key):
        cmd = self.cfg.get(key)
        if not cmd:
            raise RuntimeError("no %s command configured" % key)
        args = cmd if isinstance(cmd, list) else cmd.split()
        r = self.run(args, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise RuntimeError("%s command failed: %s" % (key, (r.stderr or r.stdout)[:120]))
        return r.stdout

    def status(self):
        if not self.cfg.get("status"):
            raise RuntimeError("no status command")
        j = json.loads(self._do("status"))
        return {"on": j.get("on"), "watts": j.get("watts")}

    def cycle(self, off_sec=10):
        return self._do("cycle").strip()[:120]

    def on(self):
        return self._do("on").strip()[:120]


def make_power(cfg):
    p = cfg.get("power") or {}
    k = p.get("kind")
    if k == "shelly" and p.get("url"):
        return ShellyHttp(p["url"])
    if k == "shelly-ble" and p.get("mac"):
        return ShellyBle(p["mac"])
    if k == "command":
        return CommandPower(p)
    return None


# ---------- secrets at rest ----------

HW_IDS = ("/sys/block/mmcblk0/device/cid", "/sys/block/mmcblk1/device/cid", "/proc/device-tree/serial-number")
SOFT_IDS = ("/etc/machine-id",)
SECRET_NAMES = ("mac", "kvmd", "outbox")


def device_key(paths=None):
    """A key from this device's own ids: the eMMC CID and the SoC serial (hardware), else machine-id. Returns
    (key, binding). Not a defence against root on this KVM; it makes a copied file (a backup, a support bundle, a
    pulled card image) useless anywhere else."""
    found = []
    for group, label in ((paths or HW_IDS, "hardware"), (SOFT_IDS if paths is None else (), "machine-id")):
        for p in group:
            try:
                with open(p, "rb") as f:
                    v = f.read().strip(b"\x00\n ")
                if v:
                    found.append(v)
            except OSError:
                pass
        if found:
            return hashlib.sha256(b"housesitter secret v1\x00" + b"\x00".join(found)).digest(), label
    raise RuntimeError("no device id to bind secrets to")


def _stream(key, nonce, n):
    out, i = b"", 0
    while len(out) < n:
        out += hmac.new(key, nonce + i.to_bytes(4, "big"), hashlib.sha256).digest()
        i += 1
    return out[:n]


def seal(plain, key):
    """HMAC-SHA256 in counter mode, then encrypt-then-MAC: standard library only, because a KVM's Python may have no
    AES module and nothing should need installing on it."""
    ek = hmac.new(key, b"enc", hashlib.sha256).digest()
    mk = hmac.new(key, b"mac", hashlib.sha256).digest()
    nonce = os.urandom(16)
    ct = bytes(a ^ b for a, b in zip(plain, _stream(ek, nonce, len(plain))))
    tag = hmac.new(mk, nonce + ct, hashlib.sha256).digest()
    return "hs1:" + base64.b64encode(nonce + ct + tag).decode("ascii")


def unseal(text, key):
    if not text.startswith("hs1:"):
        raise ValueError("not a sealed secret")
    raw = base64.b64decode(text[4:])
    nonce, ct, tag = raw[:16], raw[16:-32], raw[-32:]
    ek = hmac.new(key, b"enc", hashlib.sha256).digest()
    mk = hmac.new(key, b"mac", hashlib.sha256).digest()
    if not hmac.compare_digest(tag, hmac.new(mk, nonce + ct, hashlib.sha256).digest()):
        raise ValueError("secret does not open on this device (moved, or the device ids changed)")
    return bytes(a ^ b for a, b in zip(ct, _stream(ek, nonce, len(ct))))


def store_secret(name, value, key=None):
    if name not in SECRET_NAMES:
        raise ValueError("unknown secret %r (one of %s)" % (name, ", ".join(SECRET_NAMES)))
    if not value or len(value) > 512 or "\n" in value:
        raise ValueError("refusing: empty, too long, or more than one line")
    key, binding = (key, "given") if key else device_key()
    p = os.path.join(HOME, name + ".cred")
    fd = os.open(p + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(seal(value.encode("utf-8"), key))
    os.chmod(p + ".new", 0o600)
    os.replace(p + ".new", p)
    if load_secret(name, key) != value:
        raise RuntimeError("stored secret did not read back")
    return {"stored": name, "chars": len(value), "bound_to": binding}


def load_secret(name, key=None):
    try:
        with open(os.path.join(HOME, name + ".cred")) as f:
            text = f.read().strip()
    except OSError:
        return None
    if not text.startswith("hs1:"):
        return None
    try:
        return unseal(text, key or device_key()[0]).decode("utf-8")
    except (ValueError, RuntimeError):
        return None


def has_secret(name):
    return load_secret(name) is not None


# ---------- unlock: only at the password prompt, typed by the sitter itself ----------

def look_now(kvmd, cfg):
    """Wake the display with a lone Shift (it types nothing), then read the whole screen fresh."""
    try:
        kvmd.post("/hid/events/send_key?key=ShiftLeft", timeout=10)
    except Exception:  # noqa: BLE001
        pass
    SLEEP(1.5)
    return classify_screen(ocr_text(kvmd), cfg.get("user_names") or ())


SLEEP = time.sleep


def see_field(cfg, kvmd):
    """A fresh look: is the FileVault or login password field itself visible on the KVM's own picture? Returns
    (visible, what the screen reads as, how). With OCR, the field's own words; without, a match of a frame against a
    password prompt an operator taught the sitter while looking at it (learn-prompt). Nothing else counts."""
    try:
        kind = look_now(kvmd, cfg)
        return kind in ("filevault", "login"), kind, "ocr"
    except Exception:  # noqa: BLE001
        pass
    raw = frame_raw(kvmd)
    if not raw:
        return False, "unknown", "frame"
    f = frame_features(*raw)
    return prompt_visible(f), classify_frame(f), "frame"


# ---------- the password gate ----------
# A stored password is never typed until it has proven itself (a wrong password typed again and again risks a FileVault
# or account lockout). "unverified" is the default, and every new password starts there: never typed. "trial": an
# operator armed exactly one supervised try. "verified": that try was followed by the Mac's own desktop within
# VERIFY_SEC. A desktop that appears without our try (someone else unlocked it, or it never locked) never counts.
VERIFY_SEC = 120
TRUST = ("unverified", "trial", "verified")


def password_gate():
    g = load("password.json", {}) or {}
    return g if g.get("trust") in TRUST else {"trust": "unverified", "why": "never verified"}


def set_password_trust(trust, why, now=None, **extra):
    if trust not in TRUST:
        raise ValueError("trust must be one of %s" % ", ".join(TRUST))
    g = dict(trust=trust, why=why, at=now if now is not None else int(time.time() * 1000), **extra)
    save("password.json", g)
    return g


def gate_refusal(g):
    if g["trust"] == "verified":
        return None
    if g["trust"] == "trial" and not g.get("tried_at"):
        return None
    if g["trust"] == "trial":
        return "the one trial try is used; waiting to see whether it reached the desktop"
    return "the stored password is unverified, so it is never typed. Arm one supervised try: housesitter unlock <mac> --trial"


def settle_trial(now, desktop, log=None):
    """After the trial try: verified only when that try is followed by the desktop within VERIFY_SEC; back to
    unverified once the window passes without it."""
    g = password_gate()
    t = g.get("tried_at")
    if g["trust"] != "trial" or not t:
        return g["trust"]
    if desktop and 0 <= now - t <= VERIFY_SEC * 1000:
        set_password_trust("verified", "the trial try at %d reached the desktop at %d" % (t, now), now)
        if log:
            log("password verified: the trial try reached the desktop")
        return "verified"
    if now - t > VERIFY_SEC * 1000:
        set_password_trust("unverified", "the trial try at %d did not reach the desktop within %d s" % (t, VERIFY_SEC), now)
        if log:
            log("the trial password did not unlock the Mac: back to unverified, nothing more is typed")
        return "unverified"
    return "trial"


def typing_budget(st, now, rules=DEFAULTS, bcfg=None):
    """Limits that live in state.json, so a KVM reboot can't reset them: tries since the Mac was last seen at its
    desktop (per boot), tries in the last hour, and a pause after each try. Write-ahead entries count too."""
    bcfg = bcfg or BOOT
    ledger = st.get("ledger") or []
    since = st.get("desktop_at") or 0
    tries = [e for e in ledger if e.get("kind") == "unlock" and e.get("at", 0) > since]
    if len(tries) >= bcfg["per_boot"]:
        return "%d tries since the Mac was last at its desktop, so it stops. Fix: housesitter secret <mac> mac-password, then housesitter adopt <mac>" % len(tries)
    if len(_recent(ledger, "unlock", now, 60)) >= rules["unlocks_per_hour"]:
        return "unlock budget used (%d in the last hour)" % rules["unlocks_per_hour"]
    if tries and now - tries[-1]["at"] < bcfg["retry_sec"] * 1000:
        return "waiting %d s after the last try" % bcfg["retry_sec"]
    return None


def budgets(st, now, rules=DEFAULTS, bcfg=None):
    """What `housesitter doctor` shows: each limit, how much of it is used, and when the hourly and daily ones free up."""
    bcfg = bcfg or BOOT
    ledger = st.get("ledger") or []
    since = st.get("desktop_at") or 0
    hour = _recent(ledger, "unlock", now, 60)
    day = _recent(ledger, "power_cycle", now, 24 * 60)
    return {"unlock_since_desktop": [len([e for e in ledger if e.get("kind") == "unlock" and e.get("at", 0) > since]), bcfg["per_boot"]],
            "unlock_hour": [len(hour), rules["unlocks_per_hour"]], "unlock_hour_frees_at": min(e["at"] for e in hour) + 3600000 if hour else None,
            "cycles_day": [len(day), rules["cycles_per_day"]], "cycles_day_frees_at": min(e["at"] for e in day) + 86400000 if day else None,
            "blocked": typing_budget(st, now, rules, bcfg)}


def merge_ledger(a, b):
    """Two copies of the ledger (the file's, then this process's) into one: by id where there is one, field by field
    (so `judged` and the like survive), a finished result beating "started" either way; oldest first, the last 200."""
    out, idx = [], {}
    for e in (a or []) + (b or []):
        k = e.get("id") or "%s@%s" % (e.get("kind"), e.get("at"))
        if k in idx:
            old = out[idx[k]]
            m = dict(old, **e)
            if e.get("result") == "started" and old.get("result") not in (None, "started"):
                m["result"] = old["result"]
            out[idx[k]] = m
            continue
        idx[k] = len(out)
        out.append(dict(e))
    out.sort(key=lambda e: e.get("at", 0))
    return out[-200:]


class _Locked:
    """An exclusive lock on state.json's neighbour, so the daemon and `sitter.py do` never interleave a read-modify-write."""

    def __enter__(self):
        try:
            import fcntl
            os.makedirs(HOME, mode=0o700, exist_ok=True)
            self.f = open(os.path.join(HOME, "state.lock"), "a")
            fcntl.flock(self.f, fcntl.LOCK_EX)
        except (ImportError, OSError):
            self.f = None
        return self

    def __exit__(self, *a):
        if self.f:
            self.f.close()
        return False


def save_state(st, keys=()):
    """Write back this process's ledger (merged with the file's) and only the other fields it owns (`keys`). Everything
    else in state.json stays as the file has it, so a slow writer can't roll back another's inbox ETag, seen ids,
    boot watch or rules memory."""
    with _Locked():
        disk = load("state.json", {"mem": None, "ledger": []})
        disk["ledger"] = merge_ledger(disk.get("ledger"), st.get("ledger"))
        for k in keys:
            if k in st:
                disk[k] = st[k]
        save("state.json", disk)
    st["ledger"] = disk["ledger"]


def write_ahead(st, entry):
    """Record an unlock or power action as started, on disk, before doing it: a crash or a KVM reboot mid-action still
    counts it against every budget."""
    entry = dict(entry, result="started", id="%s-%d-%s" % (entry["kind"], entry["at"], base64.b16encode(os.urandom(3)).decode("ascii").lower()))
    st.setdefault("ledger", []).append(entry)
    save_state(st)
    return entry


def finish(st, entry, result):
    for e in st.get("ledger") or []:
        if e.get("id") == entry["id"]:
            e["result"] = result
    entry["result"] = result
    save_state(st)
    return result


def type_at_field(cfg, kvmd, st, now, why, by, log=lambda m: None, secret=None, visible=None):
    """The only way the password is typed. Gate, then budgets, then a fresh look for the field itself, then a
    write-ahead entry, then the keys. `visible` lets the boot watch pass the look it has just taken."""
    if cfg.get("unlock") is False:
        return "refused: unlock is off in this sitter's config"
    g = password_gate()
    r = gate_refusal(g)
    if r:
        return "refused: %s" % r
    r = typing_budget(st, now, dict(DEFAULTS, **cfg.get("rules", {})), dict(BOOT, **cfg.get("boot", {})))
    if r:
        return "refused: %s" % r
    pw = (secret or load_secret)("mac")
    if not pw:
        return "refused: no password on the sitter (housesitter adopt <mac> provisions it)"
    seen, kind, how = visible if visible is not None else see_field(cfg, kvmd)
    if not seen:
        return "refused: no password field visible on the KVM's own picture (it reads as %s, by %s); blind unlock is unsupported" % (kind, how)
    if cfg.get("dry_run"):
        return "dry-run: would type at the %s prompt" % kind
    if g["trust"] == "trial":
        set_password_trust("trial", g.get("why", "armed"), now, tried_at=now)
    entry = write_ahead(st, {"at": now, "kind": "unlock", "state": "filevault", "by": by, "why": why, "trust": g["trust"]})
    try:
        type_password(kvmd, pw)
        res = "typed the password at the %s prompt (%s, %s)" % (kind, how, g["trust"])
    except Exception as e:  # noqa: BLE001
        res = "failed: %s" % str(e)[:120]
    log("unlock: %s" % res)
    return finish(st, entry, res)


def unlock(cfg, kvmd, st=None, now=None, by="rules", log=lambda m: None, secret=None):
    st = st if st is not None else load("state.json", {"mem": None, "ledger": []})
    now = now if now is not None else int(time.time() * 1000)
    return type_at_field(cfg, kvmd, st, now, "at the FileVault/login screen", by, log, secret)


# ---------- eyes without kvmd snapshots, and the boot watch ----------
# On a GL.iNet Comet (GL-RM1PE, firmware V1.7.1) driving 2560x1440, kvmd's snapshot hands back raw H.264 and its OCR
# answers HTTP 500 (no tesseract on the device). The Comet's own ffmpeg decodes one keyframe from ustreamer's H.264
# memory sink instead (about 2 s at 2560x1440). Without OCR, the FileVault prompt is recognised by when and what it is:
# the Mac has just booted (it enumerated the KVM's USB keyboard again; HDMI coming back alone doesn't count), the frame
# is not a desktop (no menu bar), and it has stopped changing. After a reboot with FileVault on, the unlock prompt is
# the only thing on screen that takes keys. Never reshape the picture to suit this: an EDID change on a live Mac mini
# hung it (2026-11-08). The sitter adapts to whatever arrives. Built and first armed on a real Comet by our own fleet
# tooling, from real frames of that day.

H264_DUMP = "ustreamer-dump --sink kvmd::ustreamer::h264 --key-required --count 30 --sink-timeout 3 --output - 2>/dev/null"
FRAME_RAW = H264_DUMP + " | ffmpeg -hide_banner -loglevel quiet -f h264 -i - -frames:v 1 -f rawvideo -pix_fmt yuv420p -"
FRAME_JPEG = H264_DUMP + " | ffmpeg -hide_banner -loglevel quiet -f h264 -i - -frames:v 1 -c:v mjpeg -strict -1 -q:v 5 -f image2pipe -"
SIZES = {w * h * 3 // 2: (w, h) for w, h in ((2560, 1440), (1920, 1080), (1920, 1200), (3840, 2160), (1280, 720), (1680, 1050), (1440, 900), (2560, 1600), (3008, 1692))}

BOOT = {"tick_sec": 2, "frame_every_sec": 3, "armed_min": 15, "settle_sec": 20, "black_settle_sec": 60, "stable_frames": 2,
        "retry_sec": 40, "per_boot": 2, "desktop_edges": 40, "black_mean": 10, "same_diff": 6}


def hdmi_mode(read=lambda p: open(p).read(), kvmd=None):
    """(w, h) the KVM's HDMI receiver is locked on, or None with no signal. GL.iNet's receiver first, then kvmd."""
    try:
        dev = read("/proc/gl-hw-info/hdmipatch").strip()
        m = re.match(r"(\d+)x(\d+)", read("/sys/bus/i2c/devices/%s/resolution" % dev).strip())
        return (int(m.group(1)), int(m.group(2))) if m else None
    except OSError:
        pass
    if kvmd is None:
        return None
    try:
        src = ((kvmd.json("/streamer").get("streamer") or {}).get("source") or {})
        r = src.get("resolution") or {}
        return (int(r["width"]), int(r["height"])) if src.get("online") and r.get("width") else None
    except Exception:  # noqa: BLE001
        return None


def usb_last_enum(dmesg=None, run=subprocess.run):
    """Kernel time (s) of the last time the Mac (re)enumerated the KVM's USB gadget: a Mac boot shows up here."""
    text = dmesg if dmesg is not None else run(["dmesg"], capture_output=True, text=True, timeout=10).stdout
    last = 0.0
    for m in re.finditer(r"^\[\s*([\d.]+)\][^\n]*(?:dwc[23][^\n]*(?:device reset|USB RESET)|USB_STATE=CONFIGURED)", text, re.M):
        last = max(last, float(m.group(1)))
    return last


def frame_raw(kvmd, run=subprocess.run):
    with StreamWarm(kvmd):
        out = run(["sh", "-c", FRAME_RAW], capture_output=True, timeout=20).stdout
    wh = SIZES.get(len(out))
    if not wh:
        return None
    global LAST_FRAME
    LAST_FRAME = (out, wh[0], wh[1])  # the whole yuv420p frame, for glimpse(): colour lives past the luma plane
    return (out[:wh[0] * wh[1]], wh[0], wh[1])


LAST_FRAME = None

GLIMPSE = (40, 22)  # cells x half-cells: `housesitter doctor` draws it as 40x11 characters, two pixels to a character


def glimpse(yuv, w, h, size=GLIMPSE):
    """A tiny colour picture of the frame (rgb24, gw*gh pixels), each pixel the average of a 4x4 sample of its cell.
    It is what `housesitter doctor` and `look` draw in the terminal: enough to see a lock screen, never enough to read."""
    gw, gh = size
    if not yuv or len(yuv) < w * h * 3 // 2:
        return None
    u0, v0, cw = w * h, w * h + (w // 2) * (h // 2), w // 2
    out = bytearray()
    for j in range(gh):
        for i in range(gw):
            r = g = b = 0
            for sy in range(4):
                for sx in range(4):
                    x = int((i + (sx + 0.5) / 4) * w / gw)
                    yy = int((j + (sy + 0.5) / 4) * h / gh)
                    Y = yuv[yy * w + x] - 16
                    U = yuv[u0 + (yy // 2) * cw + x // 2] - 128
                    V = yuv[v0 + (yy // 2) * cw + x // 2] - 128
                    r += 1.164 * Y + 1.596 * V
                    g += 1.164 * Y - 0.392 * U - 0.813 * V
                    b += 1.164 * Y + 2.017 * U
            out += bytes(max(0, min(255, int(c / 16))) for c in (r, g, b))
    return {"w": gw, "h": gh, "rgb": base64.b64encode(bytes(out)).decode("ascii")}


def frame_jpeg(kvmd, run=subprocess.run):
    with StreamWarm(kvmd):
        out = run(["sh", "-c", FRAME_JPEG], capture_output=True, timeout=20).stdout
    if not is_jpeg(out):
        raise RuntimeError("no picture: kvmd gave no JPEG and the KVM couldn't decode a frame itself (is ffmpeg there?)")
    return out


def frame_features(y, w, h):
    """Mean brightness, menu-bar text edges in the top rows, a 32x18 thumbnail (luma only), and the luma grid the
    password prompt is matched on."""
    step = max(1, len(y) // 4000)
    sample = y[::step]
    mean = sum(sample) / max(1, len(sample))
    edges = 0
    # Only the left 40%: the Apple menu and the app's menus. A lock screen has its own status icons top right
    # (keyboard layout, Wi-Fi) and nothing top left. Real frames, 2026-11-08: desktop 458-498 edges, lock screen 0.
    for row in range(2, min(40, h), 2):
        r = y[row * w:row * w + int(w * 0.4):2]
        edges += sum(1 for a, b in zip(r, r[1:]) if abs(a - b) > 30)
    thumb = []
    for ty in range(18):
        for tx in range(32):
            yy, xx = int((ty + 0.5) * h / 18), int((tx + 0.5) * w / 32)
            thumb.append(y[yy * w + xx])
    return {"mean": round(mean, 1), "top_edges": edges, "thumb": thumb, "size": [w, h], "_lum": lum_grid(y, w, h)}


# The password prompt's own pixels: the avatar, the name and "Enter Password" are white and never move; an aerial
# wallpaper behind them does (two lock-screen frames 40 s apart differ by 17 in the thumbnail). Sampled on a fixed
# grid over the lower middle of the screen, so it doesn't depend on the resolution the Mac sends.
PROMPT_REGION = (0.30, 0.70, 0.40, 0.97)
PROMPT_GRID = (200, 150)
PROMPT_LEARN_LUMA, PROMPT_SEEN_LUMA, PROMPT_RECALL, PROMPT_MIN_POINTS = 200, 160, 0.9, 20
# Two-sided: the prompt is a little white on a darker screen. Real lock and FileVault frames have 0.1-1% of the grid
# that bright; a desktop has 62%. A frame brighter than this nearly everywhere (white, grey, a bright app) never matches.
PROMPT_MAX_BRIGHT = 0.15


def lum_grid(y, w, h, region=PROMPT_REGION, grid=PROMPT_GRID):
    x0, x1, y0, y1 = region[0] * w, region[1] * w, region[2] * h, region[3] * h
    gx, gy = grid
    xs = [int(x0 + (i + 0.5) * (x1 - x0) / gx) for i in range(gx)]
    out = bytearray(gx * gy)
    for j in range(gy):
        row = int(y0 + (j + 0.5) * (y1 - y0) / gy) * w
        for i, x in enumerate(xs):
            out[j * gx + i] = y[row + x]
    return bytes(out)


def prompt_points(frames):
    """Grid points bright in every frame: the prompt's own pixels, with the moving wallpaper dropped out."""
    lums = [f["_lum"] for f in frames if f and f.get("_lum")]
    if not lums:
        return []
    return [i for i in range(len(lums[0])) if all(l[i] >= PROMPT_LEARN_LUMA for l in lums)]


def prompt_match(points, f):
    """The share of a taught prompt's points that are bright in this frame (0..1)."""
    lum = (f or {}).get("_lum")
    if not lum or len(points) < PROMPT_MIN_POINTS:
        return 0.0
    if sum(1 for v in lum if v >= PROMPT_SEEN_LUMA) > PROMPT_MAX_BRIGHT * len(lum):
        return 0.0
    return sum(1 for i in points if i < len(lum) and lum[i] >= PROMPT_SEEN_LUMA) / len(points)


def clock_sig(y, w, h):
    """A fingerprint of the menu bar's right end, where the clock is: it changes every minute on a live desktop."""
    rows = max(2, int(h * 0.022))
    x0 = int(w * 0.8)
    return hashlib.sha256(b"".join(bytes(y[r * w + x0:(r + 1) * w]) for r in range(rows))).hexdigest()[:16]


def classify_frame(f, cfg=BOOT):
    if not f:
        return "none"
    if f["mean"] < cfg["black_mean"]:
        return "black"
    if f["top_edges"] >= cfg["desktop_edges"]:
        return "desktop"
    return "prompt_like"


def thumb_diff(a, b):
    if not a or not b or len(a) != len(b):
        return 255
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def prompt_seen(f):
    """(visible, best match 0..1, references taught, the best one's kind) for this frame against the prompts an
    operator taught. kind "boot" was taught while a boot was pending (the FileVault screen); "lock" any other time."""
    refs = [r for r in (load("prompt_refs.json", []) or []) if r.get("points")]
    if not f or not f.get("_lum") or classify_frame(f) != "prompt_like":
        return False, 0.0, len(refs), None
    scored = sorted(((prompt_match(r["points"], f), r.get("kind") or "lock") for r in refs), key=lambda m: -m[0])
    best, kind = scored[0] if scored else (0.0, None)
    return best >= PROMPT_RECALL, round(best, 3), len(refs), (kind if best >= PROMPT_RECALL else None)


def prompt_visible(f):
    """Does this frame show the password prompt an operator taught the sitter (learn-prompt) while looking at the KVM's
    own picture? A desktop or a black frame never does. So a prompt drawn on another display never matches."""
    return prompt_seen(f)[0]


def learn_prompt(frames, why, now=None, kind="lock"):
    """Keep the steady bright pixels of the password prompt, from several frames a few seconds apart (one frame is
    accepted too), as a reference. Only an operator who is looking at the KVM's picture and sees the password field on
    it runs this (housesitter learn-prompt <mac>)."""
    frames = frames if isinstance(frames, list) else [frames]
    for f in frames:
        k = classify_frame(f)
        if k != "prompt_like":
            raise ValueError("that frame reads as %s, not a password prompt; show the FileVault or login screen on the KVM's display first" % k)
    pts = prompt_points(frames)
    if len(pts) < PROMPT_MIN_POINTS:
        raise ValueError("nothing steady and bright enough to learn (%d points); is the password prompt on the KVM's picture?" % len(pts))
    refs = [r for r in (load("prompt_refs.json", []) or []) if r.get("points")][-4:]
    refs.append({"points": pts, "frames": len(frames), "at": now if now is not None else int(time.time() * 1000), "why": why, "kind": kind})
    save("prompt_refs.json", refs)
    return len(refs)


def type_password(kvmd, pw):
    kvmd.post("/hid/print?limit=0&slow=1", body=pw.encode("utf-8"), timeout=90)
    SLEEP(0.6)
    kvmd.post("/hid/events/send_key?key=Enter", timeout=10)


def boot_tick(bw, now, obs, cfg=BOOT, kvm_up_s=None):
    """Pure: given what was seen this tick and the boot-watch memory, decide. Returns (bw, action, note).
    obs: {"usb": last enumeration (kernel s), "mode": (w, h) or None, "frame": features or None, "prompt_visible": bool}.
    A boot only tells the sitter when to look closely. It types only where the password field is visible on the KVM's
    own picture ("type"); a settled screen without it is "blind", which is refused and reported, never typed into.
    bw["pending"] is a boot that hasn't reached a desktop yet. Budgets and the password gate live in state.json, so a
    KVM reboot can't reset them (type_at_field)."""
    bw = dict(bw or {})
    note = None
    if obs.get("kvm_boot") and obs["kvm_boot"] != bw.get("kvm_boot"):
        # The KVM itself rebooted: kernel time (dmesg) started again from zero, so the old mark means nothing.
        if bw.get("kvm_boot"):
            bw["usb_seen"] = None
        bw["kvm_boot"] = obs["kvm_boot"]
    f0 = obs.get("frame")
    if obs.get("mode") is None or (f0 is not None and classify_frame(f0, cfg) == "black"):
        bw["dark_at"] = now
    if bw.get("usb_seen") is None:
        # A KVM that has just started reads its own first enumeration as new; it counts only after a dark screen.
        bw["usb_seen"] = 0.0 if (kvm_up_s is not None and kvm_up_s < 180) else obs.get("usb", 0.0)
    if obs.get("usb", 0.0) > bw["usb_seen"]:
        # A KVM that has just started proves nothing about the Mac by itself: pulling the KVM's power must never unlock
        # a lock screen. Only a dark screen this KVM saw shortly before counts.
        dark = bw.get("dark_at")
        if dark is not None and now - dark <= cfg.get("boot_dark_sec", 180) * 1000:
            bw.update(usb_seen=obs["usb"], boot_at=now, pending=now, stable=0, last_thumb=None, stuck=None, blind_noted=None)
            note = "boot seen: the screen went dark, then the Mac enumerated the KVM's keyboard again"
        else:
            # A wake from sleep or a reseated cable re-enumerates too. A restart always darkens HDMI first.
            bw["usb_seen"] = obs["usb"]
            note = "the Mac enumerated the KVM's keyboard again with no dark screen before it (a wake, or a cable?): not a boot"
    if obs.get("mode") is None:
        if bw.get("no_signal_since") is None:
            bw["no_signal_since"] = now
        return bw, None, note
    if bw.get("no_signal_since") is not None:
        # HDMI coming back alone is NOT a boot (display sleep, a cable, a full-screen app).
        if now - bw["no_signal_since"] >= 3000 and not note:
            note = "HDMI back after %d s without signal (not a boot by itself)" % ((now - bw["no_signal_since"]) // 1000)
        bw["no_signal_since"] = None
    f = obs.get("frame")
    if (not bw.get("pending") and obs.get("prompt_kind") == "boot" and kvm_up_s is not None and kvm_up_s < 180
            and f is not None and classify_frame(f, cfg) == "prompt_like"):
        # The KVM has just started (a power cut takes both down) and missed the Mac's dark screen, but the prompt it
        # was taught at a boot, the FileVault screen, is on its picture: only a boot shows that screen.
        bw.update(boot_at=now, pending=now, stable=0, last_thumb=None, stuck=None, blind_noted=None)
        note = "boot seen: the KVM just started, and the FileVault prompt it was taught at a boot is on its picture"
    if f is not None and classify_frame(f, cfg) == "desktop":
        was = bw.get("pending")
        bw.update(boot_at=None, pending=None, stuck=None, last_kind="desktop", desktop_at=now)
        return bw, "desktop", ("the desktop is up after the boot" if was else None)
    boot_at = bw.get("boot_at")
    if not boot_at or now - boot_at > cfg["armed_min"] * 60000:
        return bw, None, note
    if f is None:
        return bw, "frame", note
    kind = classify_frame(f, cfg)
    bw["last_kind"] = kind
    # A prompt the sitter recognises is steady by definition; an aerial wallpaper behind it never is.
    same = thumb_diff(f.get("thumb"), bw.get("last_thumb")) <= cfg["same_diff"] or bool(obs.get("prompt_visible"))
    bw["stable"] = bw.get("stable", 0) + 1 if same else 0
    bw["last_thumb"] = f.get("thumb")
    wait = cfg["black_settle_sec"] if kind == "black" else cfg["settle_sec"]
    if now - boot_at < wait * 1000 or bw["stable"] < cfg["stable_frames"]:
        return bw, None, note
    if not obs.get("prompt_visible"):
        bw["stuck"] = "no password field visible on the KVM's own picture after the boot (it reads as %s); blind unlock is unsupported, so it never types" % kind
        if bw.get("blind_noted"):
            return bw, None, note
        bw["blind_noted"] = now
        return bw, "blind", bw["stuck"]
    return bw, "type", "the Mac booted and its password field is on the KVM's picture (steady for %d frames)" % bw["stable"]


def kvm_boot_id(read=lambda: open("/proc/sys/kernel/random/boot_id").read()):
    try:
        return read().strip() or None
    except OSError:
        return None


def kvm_uptime_s(read=lambda: open("/proc/uptime").read()):
    try:
        return float(read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def boot_watch(cfg, kvmd, log, now=None, run=subprocess.run, secret=None):
    """One boot-watch tick: look, decide, act. The main loop calls it every couple of seconds."""
    now = now if now is not None else int(time.time() * 1000)
    bcfg = dict(BOOT, **cfg.get("boot", {}))
    st = load("state.json", {"mem": None, "ledger": []})
    bw = st.get("boot") or {}
    obs = {"usb": usb_last_enum(run=run), "mode": hdmi_mode(kvmd=kvmd), "kvm_boot": kvm_boot_id()}
    armed = bool(bw.get("boot_at")) and now - bw["boot_at"] <= bcfg["armed_min"] * 60000
    new_usb = bw.get("usb_seen") is not None and obs["usb"] > bw["usb_seen"]
    obs["frame"] = None
    if obs["mode"] and (armed or new_usb or bw.get("pending")) and now - bw.get("frame_at", 0) >= bcfg["frame_every_sec"] * 1000:
        try:
            raw = frame_raw(kvmd, run=run)
            obs["frame"] = frame_features(*raw) if raw else None
        except Exception as e:  # noqa: BLE001
            log("boot-watch: frame failed: %s" % str(e)[:120])
        bw["frame_at"] = now
    if obs["frame"]:
        seen = prompt_seen(obs["frame"])
        obs["prompt_visible"], obs["prompt_kind"] = seen[0], seen[3]
    b2, act, note = boot_tick(bw, now, obs, bcfg, kvm_uptime_s())
    if note and note != bw.get("last_note"):
        log("boot-watch: %s" % note)
        b2["last_note"] = note
    st["boot"] = b2
    if act == "desktop":
        st["desktop_at"] = now
        settle_trial(now, True, log)
    else:
        settle_trial(now, False, log)
    if act == "type":
        res = type_at_field(cfg, kvmd, st, now, note, "boot-watch", log, secret, visible=(True, obs["frame"] and classify_frame(obs["frame"]), "frame"))
        if res.startswith("refused"):
            b2["stuck"] = res[len("refused: "):]
        b2["stable"] = 0
    st["boot"] = b2
    save_state(st, ("boot", "desktop_at"))
    return {"obs": {k: v for k, v in obs.items() if k != "frame"}, "frame": {k: v for k, v in (obs.get("frame") or {}).items() if k != "thumb" and not k.startswith("_")},
            "act": act, "note": note, "boot": {k: v for k, v in b2.items() if k != "last_thumb"}}


def glimpse_of_jpeg(jpg, run=subprocess.run, size=GLIMPSE):
    """The same glimpse from a kvmd JPEG snapshot, scaled by the KVM's own ffmpeg."""
    gw, gh = size
    out = run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-i", "-", "-vf", "scale=%d:%d:flags=area" % (gw, gh),
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], input=jpg, capture_output=True, timeout=20).stdout
    return {"w": gw, "h": gh, "rgb": base64.b64encode(out).decode("ascii")} if len(out) == gw * gh * 3 else None


def decode_picture(path, run=subprocess.run, w=2560):
    """A saved picture (PNG, JPEG) as a yuv420p frame w wide, with ffmpeg: (yuv, w, h) or None."""
    out = run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-vf", "scale=%d:-2" % w,
               "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], capture_output=True, timeout=60).stdout
    h = len(out) * 2 // (3 * w)
    return (out, w, h) if out and len(out) == w * h * 3 // 2 else None


def look(kvmd, src=None, run=subprocess.run, now=None):
    """One read-only look at the screen (or at a saved picture): what it reads as, and whether the password field the
    operator taught is on it. Presses and types nothing."""
    now = now if now is not None else int(time.time() * 1000)
    mode = None
    if src:
        dec = decode_picture(src, run=run)
    else:
        mode = hdmi_mode(kvmd=kvmd)
        raw = frame_raw(kvmd, run=run) if mode else None
        dec = LAST_FRAME if raw else None
    out = {"at": now, "from": os.path.basename(src) if src else "kvm", "mode": list(mode) if mode else None}
    if not dec:
        out.update(reads_as="none", why="no signal" if not src and not mode else "no frame decoded")
        return out
    yuv, w, h = dec
    f = frame_features(yuv[:w * h], w, h)
    visible, match, refs, kind = prompt_seen(f)
    out.update(size=[w, h], reads_as=classify_frame(f), mean=f["mean"], menu_edges=f["top_edges"],
               prompt={"taught": refs, "match": match, "visible": visible, "kind": kind}, glimpse=glimpse(yuv, w, h))
    return out


GUARD = {"reads": 3, "gap_sec": 65}


def screen_read(cfg, kvmd):
    """(what the screen reads as, a fingerprint of the menu-bar clock) from one fresh look, with OCR or without."""
    try:
        kind = classify_screen(ocr_text(kvmd), cfg.get("user_names") or ())
        box = cfg.get("clock_box", [1500, 0, 1920, 32])
        return kind, re.sub(r"\s+", " ", str(ocr_text(kvmd, box))).strip() if kind == "desktop" else None
    except Exception:  # noqa: BLE001
        pass
    raw = frame_raw(kvmd)
    if not raw:
        return "unknown", None
    k = classify_frame(frame_features(*raw))
    return {"desktop": "desktop", "black": "blank"}.get(k, "unknown"), clock_sig(*raw) if k == "desktop" else None


def cycle_guard(cfg, kvmd, now, attended=False):
    """Re-observe before cutting the power. Only a frozen desktop, seen several times across more than a minute with
    its clock never moving, while the health probes fail. Never during a boot, or at FileVault, a login window, a
    black or unknown screen, or anything else (an update's progress screen reads as one of those). `attended` is
    the explicit override for a person who has looked: it skips the screen and probe checks, never the budgets."""
    if attended:
        return None
    bw = load("state.json", {}).get("boot") or {}
    if bw.get("pending") or (bw.get("boot_at") and now - bw["boot_at"] <= BOOT["armed_min"] * 60000):
        return "the Mac is booting"
    g = dict(GUARD, **cfg.get("cycle_guard", {}))
    sigs = []
    for i in range(g["reads"]):
        if i:
            SLEEP(g["gap_sec"])
        kind, sig = screen_read(cfg, kvmd)
        if kind != "desktop":
            return "the screen reads as %s; only a frozen desktop is ever power-cycled" % kind
        sigs.append(sig)
    if None in sigs or len(set(sigs)) > 1:
        return "the desktop's clock is still moving (or unreadable): it isn't frozen"
    answers = tcp_answers(cfg.get("health"))
    arp = arp_alive(cfg.get("mac_ips") or [], [m.lower() for m in cfg.get("mac_macs") or []])
    if answers is True or arp is True:
        return "it still answers on the network"
    if answers is None and arp is None:
        return "nothing confirms the hang: give the sitter a health probe, or run adopt on the Mac with --this-mac"
    return None


def off_guard(cfg, kvmd):
    """For a button press that switches the Mac on: only when it reads as off (no picture, no network answer)."""
    try:
        src = ((kvmd.json("/streamer").get("streamer") or {}).get("source") or {})
        if src.get("online"):
            return "the KVM still sees a picture"
    except Exception:  # noqa: BLE001
        return "the KVM can't tell whether there's a picture"
    if tcp_answers(cfg.get("health")) is True or arp_alive(cfg.get("mac_ips") or [], [m.lower() for m in cfg.get("mac_macs") or []]) is True:
        return "it still answers on the network"
    return None


def power_action(kind, cfg, kvmd, power, st, now, by, attended=False, log=lambda m: None):
    """The only way power is touched: budgets, the guard (for a cycle or a forced press), a write-ahead entry, then
    the plug or the Fingerbot."""
    rules = dict(DEFAULTS, **cfg.get("rules", {}))
    ledger = st.setdefault("ledger", [])
    fingerbot = (cfg.get("power") or {}).get("kind") == "fingerbot"
    if not power and not fingerbot:
        return "refused: no smart plug or Fingerbot configured on this sitter"
    if kind == "power_cycle" and not power:
        kind = "press_power"  # no plug: a forced power-off and on is the Fingerbot's long press
    if kind == "power_on" and not power:
        r = off_guard(cfg, kvmd)
        if r:
            return "refused: %s; pressing the power button of a running Mac would sleep it or ask it to shut down" % r
    if kind in ("power_cycle", "press_power"):
        cycles = _recent(ledger, kind, now, 24 * 60)
        if _recent(ledger, kind, now, rules["cycle_gap_min"]) or len(cycles) >= rules["cycles_per_day"]:
            return "refused: power-cycle budget used (%d today; one per %d min)" % (len(cycles), rules["cycle_gap_min"])
        r = cycle_guard(cfg, kvmd, now, attended)
        if r:
            return "refused: %s. If you have looked and want it anyway: housesitter power-cycle <mac> --attended" % r
    elif _recent(ledger, "power_on", now, rules["on_gap_min"]):
        return "refused: switched on less than %d min ago" % rules["on_gap_min"]
    if cfg.get("dry_run"):
        return "dry-run: would %s" % kind
    entry = write_ahead(st, {"at": now, "kind": kind, "by": by, "attended": bool(attended)})
    try:
        if kind == "power_cycle" and power:
            res = "plug: %s" % power.cycle(cfg.get("off_sec", 10))
        elif kind == "power_on" and power:
            res = "plug: %s" % power.on()
        elif kind == "press_power":
            kvmd.get("/fingerbot/click?press_time=10000&angle_enum=2", timeout=30)
            SLEEP(15)
            res = "fingerbot: %s" % kvmd.get("/fingerbot/click?press_time=500&angle_enum=2", timeout=30)[:80]
        else:
            res = "fingerbot: %s" % kvmd.get("/fingerbot/click?press_time=500&angle_enum=2", timeout=30)[:80]
    except Exception as e:  # noqa: BLE001
        res = "failed: %s" % str(e)[:120]
    log("%s: %s" % (kind, res))
    return finish(st, entry, res)


def eyes_without_ocr(cfg, mem, raw, boot):
    """What the rules see when kvmd can't OCR: a decoded frame, read for a menu bar, and the boot watch's memory."""
    if not raw:
        return {"screen": "unknown", "eyes": "frame"}
    y, w, h = raw
    f = frame_features(y, w, h)
    kind = classify_frame(f, dict(BOOT, **cfg.get("boot", {})))
    last = LAST_FRAME
    g = glimpse(*last) if last and last[1:] == (w, h) else None
    seen = prompt_seen(f)
    prompt = {"taught": seen[2], "match": seen[1], "visible": seen[0], "kind": seen[3]}
    if kind == "desktop":
        return {"screen": "desktop", "eyes": "frame", "clock_ticking": clock_ticking(mem, clock_sig(y, w, h)), "glimpse": g, "prompt": prompt}
    out = {"eyes": "frame", "screen": "blank" if kind == "black" else "unknown", "glimpse": g, "prompt": prompt}
    if seen[0]:
        out["screen"] = "filevault" if seen[3] == "boot" else "login"
    if (boot or {}).get("pending"):
        # A boot that hasn't reached a desktop: the FileVault screen. The boot watch types; the rules only wait and tell.
        out["screen"] = "filevault"
        if boot.get("stuck"):
            out["boot"] = boot["stuck"].replace("<mac>", cfg.get("name", "<mac>"))
    return out


# ---------- notify: ntfy or any webhook ----------

def notify(cfg, subject, body, opener=urllib.request.urlopen):
    n = cfg.get("notify") or {}
    url = n.get("url")
    if not url:
        return "no notify target; recorded in status.json only"
    if n.get("kind") == "ntfy":
        req = urllib.request.Request(url, data=body.encode("utf-8"), headers={"Title": subject.encode("utf-8"), "Tags": "house"}, method="POST")
    else:
        data = json.dumps({"subject": subject, "body": body, "text": "%s\n%s" % (subject, body)}).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with opener(req, timeout=10) as r:
        return "posted %d" % r.status


# ---------- the outbox: status out, commands in, through two secret gists ----------

class Gists:
    def __init__(self, token, opener=urllib.request.urlopen, api="https://api.github.com"):
        self.token, self.opener, self.api = token, opener, api

    def _req(self, method, path, body=None, etag=None):
        h = {"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json", "User-Agent": "housesitter-sitter", "X-GitHub-Api-Version": "2022-11-28"}
        if etag:
            h["If-None-Match"] = etag
        data = json.dumps(body).encode("utf-8") if body is not None else None
        if data is not None:
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.api + path, data=data, headers=h, method=method)
        try:
            with self.opener(req, timeout=10) as r:
                return r.status, r.headers.get("ETag"), json.loads(r.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return 304, etag, None
            raise

    def get(self, gist, etag=None):
        return self._req("GET", "/gists/" + gist, etag=etag)

    def put(self, gist, files):
        return self._req("PATCH", "/gists/" + gist, body={"files": {k: {"content": v} for k, v in files.items()}})


def tailnet_self(run=subprocess.run):
    try:
        r = run(["tailscale", "status", "--json", "--peers=false"], capture_output=True, text=True, timeout=4)
        j = json.loads(r.stdout)
        me = j.get("Self") or {}
        return {"state": j.get("BackendState"), "name": (me.get("DNSName") or "").rstrip("."), "ips": me.get("TailscaleIPs") or []}
    except Exception:  # noqa: BLE001
        return None


def should_publish(st, status, now, beat_min=10):
    last = st.get("published") or {}
    return status["state"] != last.get("state") or bool(status.get("actions")) or now - last.get("at", 0) >= beat_min * 60000


OPS = ("status", "look", "screenshot", "unlock", "power_cycle", "power_on", "click", "type", "key", "scroll")


def at_password_screen(st=None):
    """Does the sitter's last look, or a boot still in progress, say the Mac is at a login, lock or FileVault screen?"""
    last = (load("status.json", {}) or {}).get("obs") or {}
    boot = ((st or {}).get("boot") or load("state.json", {}).get("boot") or {})
    return last.get("screen") in ("filevault", "login") or bool(boot.get("pending"))


def hands_refusal(cfg, kvmd, st):
    """An agent's typing and Escape go only to a desktop, read fresh from the KVM's picture right now. At a login, lock
    or FileVault screen (or anything that doesn't read as a desktop: a full-screen app hides its menu bar, so show it
    first) only the sitter types, its own copy, at a field it can see."""
    if at_password_screen(st):
        return "the Mac is at a password screen; only the sitter types there, its own copy, at a field it can see: use unlock"
    try:
        kind = screen_read(cfg, kvmd)[0]
    except Exception:  # noqa: BLE001
        kind = "unknown"
    if kind != "desktop":
        return "the KVM's picture reads as %s right now, not a desktop with its menu bar; agents type only on a desktop (a full-screen app: show its menu bar first)" % kind
    return None


def handle(cmd, cfg, kvmd, power, log, now, st, via="ssh"):
    """One command (from the inbox, or `sitter.py do` over SSH). Unlock and power ops keep the sitter's own budgets and
    checks; screenshot, click, type and key are an agent's hands and pass through, except at a password screen.
    Refusals use Ouro Reins' codes: action-unavailable, input-invalid, action-failed."""
    op = cmd.get("op")
    name = cfg.get("name", "mac")
    if op not in OPS:
        return {"ok": False, "code": "action-unavailable", "result": "unknown op %r; available: %s" % (op, ", ".join(OPS))}
    if cfg.get("dry_run") and op in ("unlock", "power_cycle", "power_on"):
        return {"ok": True, "result": "dry-run: would %s" % op}
    st.setdefault("ledger", [])
    a = cmd.get("args") or {}
    if op == "status":
        return {"ok": True, "result": load("status.json", {})}
    if op == "look":
        return {"ok": True, "result": once(cfg, kvmd, power, log, now=now)}
    if op == "screenshot":
        w = int(a.get("width", 1280))
        jpg = snapshot_jpeg(kvmd, "allow_offline=1&preview=1&preview_max_width=%d&preview_quality=70" % max(320, min(w, 1920)))
        return {"ok": True, "result": {"bytes": len(jpg), "file": "%s.screen.jpg.b64" % name, "real": real_size(kvmd)}, "_files": {"%s.screen.jpg.b64" % name: base64.b64encode(jpg).decode("ascii")}}
    if op in ("click", "scroll"):
        try:
            w, h = int(a.get("w", 1920)), int(a.get("h", 1080))
            if op == "click" or a.get("x") is not None:
                tx, ty = abs_point(int(a["x"]), int(a["y"]), w, h)
                kvmd.post("/hid/events/send_mouse_move?to_x=%d&to_y=%d" % (tx, ty))
        except (KeyError, ValueError, TypeError) as e:
            return {"ok": False, "code": "input-invalid", "result": "args: %s" % e}
        if op == "scroll":
            dx, dy = int(a.get("dx", 0)), int(a.get("dy", 0))
            kvmd.post("/hid/events/send_mouse_wheel?delta_x=%d&delta_y=%d" % (dx, dy))
            return {"ok": True, "result": "scrolled %d,%d" % (dx, dy)}
        button = a.get("button") if a.get("button") in ("left", "right", "middle") else "left"
        for _ in range(max(1, min(3, int(a.get("count") or (2 if a.get("double") else 1))))):
            kvmd.post("/hid/events/send_mouse_button?button=%s&state=true" % button)
            kvmd.post("/hid/events/send_mouse_button?button=%s&state=false" % button)
        return {"ok": True, "result": "clicked %s at %d,%d" % (button, int(a["x"]), int(a["y"]))}
    if op == "type":
        text = a.get("text")
        if not isinstance(text, str) or not text or len(text) > 2000:
            return {"ok": False, "code": "input-invalid", "result": "args.text: 1-2000 characters"}
        why = hands_refusal(cfg, kvmd, st)
        if why:
            return {"ok": False, "code": "action-unavailable", "result": why}
        kvmd.post("/hid/print?limit=0&slow=1", body=text.encode("utf-8"), timeout=120)
        return {"ok": True, "result": "typed %d characters" % len(text)}
    if op == "key":
        try:
            names = key_names(a.get("combo", ""))
        except ValueError as e:
            return {"ok": False, "code": "input-invalid", "result": "args.combo: %s" % e}
        if "Escape" in names and hands_refusal(cfg, kvmd, st):
            return {"ok": False, "code": "action-unavailable", "result": "no Escape unless the KVM's picture reads as a desktop right now: at a login window it switches to the list of users, where no password field has focus (2026-11-08)"}
        if len(names) == 1:
            kvmd.post("/hid/events/send_key?key=%s" % names[0])
        else:
            kvmd.post("/hid/events/send_shortcut?keys=%s" % ",".join(names))
        return {"ok": True, "result": "pressed %s" % "+".join(names)}
    if op == "unlock":
        boot = (st.get("boot") or load("state.json", {}).get("boot") or {})
        if via != "ssh" and not boot.get("pending"):
            return {"ok": False, "code": "action-unavailable", "result": "a plain lock screen is your lock: unlock it over SSH from your own machine (housesitter unlock <mac>); through the outbox only during a boot"}
        res = type_at_field(cfg, kvmd, st, now, "asked for", "request", log)
        return {"ok": res.startswith("typed"), "code": None if res.startswith("typed") else "action-failed", "result": res}
    if a.get("attended") is True and via != "ssh":
        return {"ok": False, "code": "action-unavailable", "result": "attended is an operator's override, over SSH only (housesitter power-cycle <mac> --attended from your own machine), never through the outbox"}
    if not power and (cfg.get("power") or {}).get("kind") != "fingerbot":
        return {"ok": False, "code": "action-unavailable", "result": "no smart plug configured on this sitter"}
    res = power_action(op, cfg, kvmd, power, st, now, "request", attended=a.get("attended") is True, log=log)
    ok = not res.startswith(("refused", "failed"))
    return {"ok": ok, "code": None if ok else "action-failed", "result": res}


def poll_inbox(cfg, gh, kvmd, power, log, now=None):
    """Check the inbox gist once (ETag: an unchanged inbox costs nothing). Runs any new command and replies."""
    now = now if now is not None else int(time.time() * 1000)
    o = cfg.get("outbox") or {}
    name = cfg.get("name", "mac")
    st = load("state.json", {"mem": None, "ledger": []})
    code, etag, g = gh.get(o["inbox"], st.get("inbox_etag"))
    if code == 304 or not g:
        return None
    st["inbox_etag"] = etag
    f = (g.get("files") or {}).get("%s.cmd.json" % name)
    try:
        cmd = json.loads(f["content"]) if f else None
    except (ValueError, KeyError, TypeError):
        cmd = None
    seen = st.get("seen_ids") or []
    if not cmd or not cmd.get("id") or cmd["id"] in seen or cmd.get("v") != 1:
        save_state(st, ("inbox_etag",))
        return None
    st["seen_ids"] = (seen + [cmd["id"]])[-100:]
    save_state(st, ("inbox_etag", "seen_ids"))  # marked seen before acting: a crash never runs the same request twice
    if abs(now - int(cmd.get("at") or 0)) > 10 * 60000:
        return None
    t0 = time.time()
    try:
        rep = handle(cmd, cfg, kvmd, power, log, now, st, via="outbox")
    except Exception as e:  # noqa: BLE001
        rep = {"ok": False, "code": "action-failed", "result": "failed: %s" % str(e)[:200]}
    if cmd.get("op") in ("unlock", "power_cycle", "power_on"):
        save_state(st)
    files = rep.pop("_files", {})
    reply = dict(v=1, re=cmd["id"], op=cmd.get("op"), at=now, ms=int((time.time() - t0) * 1000), **rep)
    files["%s.reply.json" % name] = json.dumps(reply)
    gh.put(o["gist"], files)
    log("request %s %s -> %s" % (cmd["id"][:8], cmd.get("op"), "ok" if rep.get("ok") else rep.get("code")))
    return reply


# ---------- one look ----------

def clock_ticking(mem, clock):
    """The menu-bar clock, read once a minute: frozen only if the last three reads are the same text."""
    if not clock:
        return None
    seen = (mem.get("clock_seen") or [])[-2:] + [clock]
    mem["clock_seen"] = seen
    if len(seen) < 3:
        return True if len(set(seen)) > 1 else None
    return len(set(seen)) > 1


def observe(cfg, kvmd, power, mem, now):
    obs = {"answers": tcp_answers(cfg.get("health")), "beat_min": None, "presence": None}
    try:
        st = kvmd.json("/streamer")
        src = (st.get("streamer") or {}).get("source") or {}
        obs["video"] = bool(src.get("online")) if "online" in src else None
    except Exception as e:  # noqa: BLE001
        obs["video"], obs["kvmd_error"] = None, str(e)[:120]
    if obs.get("video"):
        try:
            obs["screen"] = classify_screen(ocr_text(kvmd), cfg.get("user_names") or ())
            box = cfg.get("clock_box", [1500, 0, 1920, 32])
            obs["clock_ticking"] = clock_ticking(mem, re.sub(r"\s+", " ", str(ocr_text(kvmd, box))).strip())
            try:
                obs["glimpse"] = glimpse_of_jpeg(snapshot_jpeg(kvmd))
            except Exception:  # noqa: BLE001
                pass
        except Exception as e:  # noqa: BLE001
            obs["ocr_error"] = str(e)[:120]
            try:
                raw = frame_raw(kvmd)
            except Exception as e2:  # noqa: BLE001
                raw, obs["frame_error"] = None, str(e2)[:120]
            obs.update(eyes_without_ocr(cfg, mem, raw, load("state.json", {}).get("boot")))
    elif obs.get("video") is False:
        obs["screen"] = "blank"
    if obs.get("screen") == "desktop":
        obs["desktop"] = True
    obs["arp"] = arp_alive(cfg.get("mac_ips") or [], [m.lower() for m in cfg.get("mac_macs") or []])
    if power:
        try:
            p = power.status()
            obs["plug_on"], obs["watts"] = p["on"], p["watts"]
        except Exception as e:  # noqa: BLE001
            obs["plug_error"] = str(e)[:120]
    return obs


def perform(act, cfg, kvmd, power, mem, obs, log, st=None, now=None):
    k = act["kind"]
    st = st if st is not None else {"ledger": []}
    now = now if now is not None else int(time.time() * 1000)
    if k == "unlock":
        return type_at_field(cfg, kvmd, st, now, act.get("why", ""), "rules", log)
    if k in ("power_cycle", "power_on", "press_power"):
        return power_action(k, cfg, kvmd, power, st, now, "rules", log=log)
    if cfg.get("dry_run"):
        return "dry-run: would %s" % k
    if k == "notify":
        name = cfg.get("name", "your Mac")
        if act.get("recovered"):
            return notify(cfg, "%s is back" % name, "%s is healthy again (seen by its housesitter)." % name)
        signs = ", ".join("%s=%s" % (a, b) for a, b in sorted(obs.items()) if b is not None and not a.endswith("_error"))
        stuck = {"filevault": "is stuck at FileVault", "hung": "is frozen", "off": "is off", "down": "is not answering", "unknown": "is out of sight"}.get(mem["state"], "needs you (%s)" % mem["state"])
        return notify(cfg, "%s %s" % (name, stuck), "Seen by the housesitter on its KVM.\nStuck because: %s.\nSigns: %s." % (act["why"].replace("<mac>", name), signs))
    return "nothing to do for %s here" % k


def load(name, default):
    try:
        with open(os.path.join(HOME, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(name, value):
    p = os.path.join(HOME, name)
    with open(p + ".new", "w") as f:
        json.dump(value, f)
    os.replace(p + ".new", p)


def caps_of(cfg, power):
    fingerbot = (cfg.get("power") or {}).get("kind") == "fingerbot"
    # Typing is disarmed until the password gate says otherwise: unverified (the default) never types.
    armed = gate_refusal(password_gate()) is None
    return {"unlock": cfg.get("unlock") is not False and has_secret("mac") and armed, "plug": bool(power), "fingerbot": fingerbot, "notify": bool((cfg.get("notify") or {}).get("url"))}


def after_boot(cfg, obs, boot):
    """May the sitter type by itself here? Only at a prompt that follows a boot: the boot watch saw the Mac enumerate the
    KVM's keyboard again and no desktop since, or OCR read the FileVault screen itself. A plain lock screen is the
    owner's lock, and the sitter can't tell it from a dead session, so it stays locked (and you hear about it) unless an
    operator asks (housesitter unlock <mac>) or the config says "unlock_lock_screen": true. Learned live, 2026-11-08."""
    # Without OCR, "filevault" is a matched picture; the boot watch alone decides when that follows a boot.
    ocr_filevault = obs.get("screen") == "filevault" and obs.get("eyes") != "frame"
    return bool((boot or {}).get("pending")) or ocr_filevault or cfg.get("unlock_lock_screen") is True


def once(cfg, kvmd, power, log, now=None, gh=None):
    now = now if now is not None else int(time.time() * 1000)
    st = load("state.json", {"mem": None, "ledger": []})
    mem, ledger = st.get("mem") or {}, st.get("ledger") or []
    obs = observe(cfg, kvmd, power, mem, now)
    seen = {"glimpse": obs.pop("glimpse", None), "prompt": obs.pop("prompt", None)}
    if obs.pop("desktop", False):
        st["desktop_at"] = now
    settle_trial(now, obs.get("screen") == "desktop", log)
    caps = caps_of(cfg, power)
    if not after_boot(cfg, obs, st.get("boot")):
        caps["unlock"] = False
    if obs.get("eyes") == "frame":
        caps["unlock"] = False  # without OCR, only the boot watch types, and only at a field it can match
    clock_seen = mem.get("clock_seen")
    open_incident = mem.get("incident")
    mem, actions = tick(mem or None, ledger, {k: v for k, v in obs.items() if not k.endswith("_error")}, now, caps, dict(DEFAULTS, **cfg.get("rules", {})))
    if clock_seen is not None:
        mem["clock_seen"] = clock_seen[-4:]
    done = []
    for a in actions:
        if a["kind"] == "wait":
            continue
        try:
            res = perform(a, cfg, kvmd, power, mem, obs, log, st, now)
        except Exception as e:  # noqa: BLE001
            res = "failed: %s" % str(e)[:160]
        guarded = a["kind"] in ("unlock", "power_cycle", "power_on", "press_power")
        if not guarded:
            st.setdefault("ledger", []).append({"at": now, "kind": a["kind"], "state": mem["state"], "result": res})
        elif res.startswith(("refused", "dry-run")):
            # Not done, so it counts against no budget; noted so the rules settle, and you hear why once.
            st.setdefault("ledger", []).append({"at": now, "kind": a["kind"] + "_refused", "state": mem["state"], "result": res})
            inc = mem.get("incident")
            remind = dict(DEFAULTS, **cfg.get("rules", {}))["remind_hours"] * 3600000
            if res.startswith("refused") and inc and caps.get("notify") and (inc.get("notified_at") is None or now - inc["notified_at"] >= remind):
                try:
                    n = perform({"kind": "notify", "why": "it won't %s: %s" % (a["kind"].replace("_", " "), res[len("refused: "):])}, cfg, kvmd, power, mem, obs, log, st, now)
                except Exception as e:  # noqa: BLE001
                    n = "failed: %s" % str(e)[:160]
                st["ledger"].append({"at": now, "kind": "notify", "state": mem["state"], "result": n})
                inc["notified_at"] = now
        if a["kind"] == "notify" and mem.get("incident"):
            mem["incident"]["notified_at"] = now
        done.append({"kind": a["kind"], "why": a["why"], "result": res})
        log("%s %s -> %s: %s" % (mem["state"], a["kind"], a["why"], res))
    if open_incident and not mem.get("incident"):
        # Over: keep a short record, so `housesitter doctor` can say what the last bad stretch was and how it ended.
        acts = [e.get("kind") for e in st.get("ledger") or [] if e.get("at", 0) >= open_incident.get("started", now) and e.get("kind") != "notify"]
        st["last_incident"] = {"started": open_incident.get("started"), "ended": now, "actions": acts[-6:],
                               "told_you": open_incident.get("notified_at") is not None}
    status = {"v": 1, "sitter": VERSION, "at": now, "name": cfg.get("name"), "state": mem["state"], "since": mem.get("since"), "obs": obs,
              "actions": done, "can": caps, "incident": mem.get("incident"), "password": password_gate().get("trust"), "secrets": {n: has_secret(n) for n in SECRET_NAMES},
              "interval_sec": cfg.get("interval_sec", 60), "budgets": budgets(st, now, dict(DEFAULTS, **cfg.get("rules", {})), dict(BOOT, **cfg.get("boot", {}))),
              "recent": [{k: e.get(k) for k in ("at", "kind", "result")} for e in (st.get("ledger") or [])[-5:]], "last_incident": st.get("last_incident"),
              **{k: v for k, v in seen.items() if v}}
    o = cfg.get("outbox") or {}
    if gh and o.get("gist"):
        status["tailnet"] = tailnet_self()
    st["mem"] = mem
    if gh and o.get("gist") and should_publish(st, status, now, o.get("beat_min", 10)):
        try:
            gh.put(o["gist"], {"%s.sitter.json" % cfg.get("name", "mac"): json.dumps(status, indent=1)})
            st["published"] = {"at": now, "state": status["state"]}
        except Exception as e:  # noqa: BLE001
            log("outbox publish failed: %s" % str(e)[:160])
    save_state(st, ("mem", "desktop_at", "published", "last_incident"))
    save("status.json", status)
    heartbeat(cfg, status)
    return status


def heartbeat(cfg, status, opener=urllib.request.urlopen):
    """Ping a dead man's switch (healthchecks.io, Uptime Kuma, cronitor…) every look, so that if this KVM, its power or
    its network dies, something else notices and tells you. Healthy pings the URL; anything else pings URL/fail."""
    url = (cfg.get("heartbeat") or {}).get("url")
    if not url:
        return None
    u = url if status["state"] in ("healthy", "degraded") else url.rstrip("/") + "/fail"
    try:
        with opener(urllib.request.Request(u, data=status["state"].encode("utf-8"), method="POST"), timeout=8) as r:
            return r.status
    except Exception:  # noqa: BLE001
        return None


def forget():
    """Wipe the sitter's secrets and memory from this KVM (the files, not just their contents)."""
    gone = []
    for n in list(SECRET_NAMES) + ["state", "status"]:
        p = os.path.join(HOME, n + (".cred" if n in SECRET_NAMES else ".json"))
        if os.path.exists(p):
            with open(p, "w") as f:
                f.write("")
            os.remove(p)
            gone.append(os.path.basename(p))
    return {"forgot": gone}


def make_logger():
    logf = os.path.join(HOME, "sitter.log")

    def log(msg):
        line = "%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg)
        try:
            if os.path.exists(logf) and os.path.getsize(logf) > 512 * 1024:
                os.replace(logf, logf + ".1")
            with open(logf, "a") as f:
                f.write(line)
        except OSError:
            pass
    return log


def main(argv):
    if argv[:1] == ["version"]:
        print(json.dumps({"sitter": VERSION}))
        return 0
    if argv[:1] == ["store-secret"] and len(argv) == 2:
        os.makedirs(HOME, mode=0o700, exist_ok=True)
        value = sys.stdin.read()
        if value.endswith("\n"):
            value = value[:-1]
        try:
            print(json.dumps(store_secret(argv[1], value)))
            if argv[1] == "mac":
                set_password_trust("unverified", "a new password was stored")
            return 0
        except (ValueError, RuntimeError) as e:
            print("store-secret: %s" % e, file=sys.stderr)
            return 2
    if argv[:1] == ["enable-api"]:
        print(json.dumps({"opened_blocks": enable_api(), "conf": NGINX_CONF}))
        return 0
    if argv[:1] == ["forget"]:
        print(json.dumps(forget()))
        return 0
    if argv[:1] == ["secrets"]:
        print(json.dumps({n: has_secret(n) for n in SECRET_NAMES}))
        return 0
    if argv[:1] == ["password-trial"]:
        # One supervised try, armed by an operator over SSH. Never from the GitHub inbox.
        if not has_secret("mac"):
            print("password-trial: no password on the sitter", file=sys.stderr)
            return 2
        print(json.dumps(set_password_trust("trial", "armed by an operator for one supervised try")))
        return 0
    if argv[:1] == ["password-hold"]:
        print(json.dumps(set_password_trust("unverified", "held by an operator")))
        return 0
    if argv[:1] == ["password"]:
        print(json.dumps(password_gate()))
        return 0
    if argv[:1] == ["fingerprint"]:
        print(json.dumps(cert_fingerprint()))
        return 0
    kvmd_default = Kvmd(user="admin", passwd=load_secret("kvmd") or "")
    if argv[:1] == ["look"]:
        # Read-only, and fine before adopt: one frame, what it reads as, the taught prompt's match and a glimpse. It
        # presses nothing, types nothing and writes nothing. --from <image> reads a saved picture instead (with ffmpeg),
        # so you can see what the sitter would make of a screenshot. --passwd-stdin: kvmd's admin password on stdin, for a
        # KVM that has no sitter yet.
        src = argv[argv.index("--from") + 1] if "--from" in argv else None
        if "--passwd-stdin" in argv:
            kvmd_default.passwd = sys.stdin.readline().rstrip("\n")
        print(json.dumps(look(kvmd_default, src)))
        return 0
    if argv[:1] == ["harden"]:
        try:
            print(json.dumps(harden(kvmd_default, load("config.json", None) or {})))
            return 0
        except Exception as e:  # noqa: BLE001
            print("harden: %s" % e, file=sys.stderr)
            return 1
    cfg = load("config.json", None)
    if not cfg:
        print("housesitter: no %s/config.json (housesitter adopt writes it)" % HOME, file=sys.stderr)
        return 2
    kvmd = Kvmd(cfg.get("kvmd_socket", "/run/kvmd/kvmd.sock"), cfg.get("kvmd_user", "admin"), load_secret("kvmd") or "")
    token = load_secret("outbox")
    o = cfg.get("outbox") or {}
    gh = Gists(token) if token and o.get("gist") else None
    power = make_power(cfg)
    log = make_logger()
    if argv[:1] == ["once"]:
        print(json.dumps(once(cfg, kvmd, power, log, gh=gh)))
        return 0
    if argv[:1] == ["learn-prompt"]:
        # An operator looking at the KVM's own picture, with the password field on it, teaches the sitter that screen:
        # three frames a few seconds apart, so a moving wallpaper drops out and only the prompt's own pixels stay.
        frames = []
        for i in range(3):
            raw = frame_raw(kvmd)
            if not raw:
                print("learn-prompt: no frame decoded from the KVM's picture", file=sys.stderr)
                return 1
            frames.append(frame_features(*raw))
            if i < 2:
                SLEEP(4)
        try:
            pending = bool((load("state.json", {}).get("boot") or {}).get("pending"))
            kind = "boot" if pending else "lock"
            print(json.dumps({"references": learn_prompt(frames, " ".join(argv[1:]) or "taught by an operator", kind=kind), "points": len(prompt_points(frames)), "kind": kind}))
            return 0
        except ValueError as e:
            print("learn-prompt: %s" % e, file=sys.stderr)
            return 2
    if argv[:1] == ["boot-watch"]:
        print(json.dumps(boot_watch(cfg, kvmd, log)))
        return 0
    if argv[:1] == ["frame"]:
        sys.stdout.buffer.write(frame_jpeg(kvmd))
        return 0
    if argv[:1] == ["eyes"]:
        # adopt's check: can this KVM see the Mac, with OCR or by decoding a frame itself?
        out = {"mode": hdmi_mode(kvmd=kvmd)}
        try:
            out["ocr"] = classify_screen(ocr_text(kvmd), cfg.get("user_names") or ())
        except Exception as e:  # noqa: BLE001
            out["ocr"], out["ocr_error"] = None, str(e)[:120]
        try:
            raw = frame_raw(kvmd)
            out["frame"] = classify_frame(frame_features(*raw)) if raw else None
            out["size"] = list(raw[1:]) if raw else None
        except Exception as e:  # noqa: BLE001
            out["frame"], out["frame_error"] = None, str(e)[:120]
        print(json.dumps(out))
        return 0 if (out["ocr"] or out["frame"]) else 1
    if argv[:1] == ["hello"]:
        # Sent once by adopt, so the first message you get from the sitter is a calm one.
        name = cfg.get("name") or "your Mac"
        try:
            print(json.dumps({"sent": notify(cfg, "%s has a housesitter" % name, "It watches %s from the KVM beside it, and messages you here only when it needs you, and again when %s is back." % (name, name))}))
            return 0
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"sent": False, "error": str(e)[:200]}))
            return 1
    if argv[:1] == ["do"] and len(argv) >= 2:
        # The same handler as the inbox, for a client that reaches this KVM over SSH (LAN or tailnet).
        st = load("state.json", {"mem": None, "ledger": []})
        now = int(time.time() * 1000)
        args = json.loads(argv[2]) if len(argv) > 2 else {}
        try:
            rep = handle({"op": argv[1], "args": args}, cfg, kvmd, power, log, now, st)
        except Exception as e:  # noqa: BLE001
            rep = {"ok": False, "code": "action-failed", "result": "failed: %s" % str(e)[:200]}
        if argv[1] in ("unlock", "power_cycle", "power_on"):
            save_state(st)
        files = rep.pop("_files", {})
        if files:
            rep["files"] = files
        print(json.dumps(rep))
        return 0 if rep.get("ok") else (2 if rep.get("code") in ("action-unavailable", "input-invalid") else 1)
    log("start: sitter %s watching %s every %ss; unlock %s; outbox %s" % (VERSION, cfg.get("name"), cfg.get("interval_sec", 60), "ready" if has_secret("mac") else "NOT provisioned", "on" if gh else "off"))
    interval, poll = cfg.get("interval_sec", 60), o.get("poll_sec", 2)
    boot_every = dict(BOOT, **cfg.get("boot", {}))["tick_sec"]
    next_ingress, ingress_ok = 0, False
    next_look = 0
    next_boot = 0 if cfg.get("boot_watch", True) is not False else float("inf")
    while True:
        if not ingress_ok and time.time() >= next_ingress:
            # iptables rules don't survive the KVM's reboot: put them back at every start, and until they hold.
            next_ingress = time.time() + 60
            try:
                log("ingress: %s" % apply_ingress(ingress_mode(cfg)))
                ingress_ok = True
            except Exception as e:  # noqa: BLE001
                log("ingress NOT applied (retrying every minute): %s" % str(e)[:160])
        if cfg.get("boot_watch", True) is not False and time.time() >= next_boot:
            next_boot = time.time() + boot_every
            try:
                boot_watch(cfg, kvmd, log)
            except Exception as e:  # noqa: BLE001
                log("boot-watch failed: %s" % str(e)[:160])
        if time.time() >= next_look:
            next_look = time.time() + interval
            try:
                once(cfg, kvmd, power, log, gh=gh)
            except Exception as e:  # noqa: BLE001
                log("tick failed: %s" % e)
        if gh and o.get("inbox"):
            try:
                poll_inbox(cfg, gh, kvmd, power, log)
            except Exception as e:  # noqa: BLE001
                log("inbox poll failed: %s" % str(e)[:160])
                time.sleep(10)
        time.sleep(min(poll if gh else max(1, next_look - time.time()), max(0.2, next_boot - time.time())))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
