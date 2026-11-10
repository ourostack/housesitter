#!/usr/bin/env python3
"""Housesitter's one background watcher, its own process (the KVM's init script starts it; the MCP server never does).

Every HOUSESITTER_WATCH_SEC (default 30) it looks at four things and wakes the agent when one of them has news, with
`ouro msg --to <agent> <message>` (the daemon queues it and wakes an ordinary turn with all of the agent's tools;
`ouro event submit` turns are scoped to the Sanctuary Butler's capability profiles, so they aren't used here):
  peer    a new message from Ouroboros in the in gist (ETag: an unchanged gist costs nothing)
  sitter  the sitter's state or what the screen reads as changed, or its heartbeat (status.json, rewritten every
          interval) is older than 3 intervals, or back
  mini    the Mac's own fleet heartbeat (<mac>.json in the fleet gist) is older than 15 minutes, or back
  drill   $HOUSESITTER_STATE_DIR/simulate-incident exists: one stale-heartbeat incident, marked simulated; the file is
          then renamed to simulate-incident.consumed-<time>
Each tick it also flushes the agent's queued peer messages when they're due (peer.flush_if_due), so what peer_send
queued goes out within HOUSESITTER_PEER_FLUSH_SEC (6 minutes) without the agent doing anything more.

It remembers what it has woken the agent for in watch-seen.json and watch-state.json, and only reads peer-seen.json
(peer_inbox's), so a message the agent hasn't read is never hidden from it. One line on stdout per event.

    python3 watch.py [--once]
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import peer  # noqa: E402

MINI_STALE_MIN = 15
WOKEN_MAX = 500


def env(name, default):
    return peer.env(name, default)


def one_line(text, limit=240):
    t = " ".join(str(text).split())
    return t if len(t) <= limit else t[: limit - 1] + "…"


def safe_id(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(s)).strip("-")[:150] or "event"


class Watcher:
    def __init__(self, clock=time.time, run=subprocess.run, out=None):
        self.clock, self.run = clock, run
        self.out = out or (lambda line: (sys.stdout.write(line + "\n"), sys.stdout.flush()))
        self.dir = peer.state_dir()
        self.state_path = os.path.join(self.dir, "watch-state.json")
        self.woken_path = os.path.join(self.dir, "watch-seen.json")
        self.backoff = {}

    # ---------- memory ----------

    def load(self):
        st = peer.read_json(self.state_path, {})
        return st if isinstance(st, dict) else {}

    def save(self, st):
        peer.write_json(self.state_path, st)

    def say(self, **kv):
        self.out(json.dumps(dict({"at": peer.iso(self.clock())}, **kv)))

    # ---------- waking the agent ----------

    def wake(self, source, etype, eid, summary, payload):
        d = os.path.join(self.dir, "events")
        os.makedirs(d, exist_ok=True)
        eid = safe_id(eid)
        path = os.path.join(d, "%s.json" % eid)
        peer.write_json(path, dict(payload, source=source, type=etype, id=eid, at=peer.iso(self.clock())))
        text = (payload.get("message") or {}).get("text") if source == "peer" else None
        message = "[housesitter watch] %s %s (%s): %s Details: %s" % (source, etype, eid, text or one_line(summary) or etype, path)
        cmd = shlex.split(env("HOUSESITTER_OURO_BIN", "ouro")) + ["msg", "--to", env("HOUSESITTER_AGENT", "housesitter"), message]
        try:
            r = self.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            ok, why = r.returncode == 0, (r.stderr or b"").decode("utf-8", "replace").strip()[-200:]
        except (OSError, subprocess.SubprocessError) as e:
            ok, why = False, str(e)[:200]
        self.say(event="wake", source=source, type=etype, id=eid, summary=one_line(summary), ok=ok, **({} if ok else {"error": why}))
        return ok

    # ---------- the four things it watches ----------

    def watch_peer(self, st):
        status, etag, gist = peer.get_gist(env("HOUSESITTER_PEER_IN", peer.O_TO_H), st.get("peer_etag"))
        if status == 304:
            return
        read = set(peer.read_json(os.path.join(self.dir, "peer-seen.json"), []) or [])
        woken = peer.read_json(self.woken_path, [])
        woken = woken if isinstance(woken, list) else []
        missed = False
        for m in peer.messages(gist):
            if m["id"] in woken or m["id"] in read:
                continue
            if self.wake("peer", "message", "peer-%s" % m["id"], "Ouroboros: %s" % m["text"],
                         {"kind": "peer-message", "message": m, "read_with": "peer_inbox", "reply_with": "peer_send with re=%s" % m["id"]}):
                woken.append(m["id"])
            else:
                missed = True
        peer.write_json(self.woken_path, woken[-WOKEN_MAX:])
        st["peer_etag"] = None if missed else etag  # a wake that failed is tried again next time

    def watch_outbox(self, st):
        r = peer.flush_if_due(ts=self.clock())
        if r.get("sent"):
            self.say(event="flush", sent=r["sent"], queued=r.get("queued", 0), pruned=len(r.get("pruned") or []))

    def watch_sitter(self, st):
        path = os.path.join(env("HOUSESITTER_HOME", "/etc/kvmd/user/housesitter"), "status.json")
        now = self.clock()
        try:
            mtime = os.stat(path).st_mtime
            status = peer.read_json(path, None)
        except OSError:
            mtime, status = None, None
        status = status if isinstance(status, dict) else {}
        interval = int(status.get("interval_sec") or 60)
        age = None if mtime is None else int(now - mtime)
        stale = age is None or age > 3 * interval
        prev = st.get("sitter_stale")
        if stale and prev is not True:
            what = "no status.json at %s" % path if age is None else "its status.json is %d s old (every %d s normally)" % (age, interval)
            if self.wake("sitter", "heartbeat-stale", "sitter-stale-%d" % int(mtime or now), "The sitter has gone quiet: %s" % what,
                         {"kind": "sitter-heartbeat", "stale": True, "age_sec": age, "interval_sec": interval, "file": path}):
                st["sitter_stale"] = True
            return
        if not stale and prev is True:
            if self.wake("sitter", "heartbeat-back", "sitter-back-%d" % int(mtime), "The sitter is writing its status again (%d s old)" % age,
                         {"kind": "sitter-heartbeat", "stale": False, "age_sec": age, "interval_sec": interval, "status": status}):
                st["sitter_stale"] = False
        elif not stale:
            st["sitter_stale"] = False
        if stale or not status.get("state"):
            return  # a half-written status.json is read again next time
        seen = [status.get("state"), (status.get("obs") or {}).get("screen")]
        last = st.get("sitter_seen")
        if seen == last:
            return
        if last is None and seen[0] == "healthy":
            st["sitter_seen"] = seen  # the first look at a healthy Mac is a baseline, not news
            return
        summary = "The sitter says %s, the screen reads as %s%s" % (seen[0], seen[1], "" if last is None else " (was %s, %s)" % tuple(last))
        if self.wake("sitter", "state-changed", "sitter-%s-%s-%s" % (seen[0], seen[1], status.get("at") or int(mtime)), summary,
                     {"kind": "sitter-state", "was": last, "now": seen, "status": status}):
            st["sitter_seen"] = seen

    def watch_mini(self, st):
        mac = env("HOUSESITTER_MAC", "aris-mac-mini")
        status, etag, gist = peer.get_gist(env("HOUSESITTER_FLEET_GIST", "ded3f1d37c2a756becc3333b0e4276b4"), st.get("fleet_etag"))
        if status != 304:
            f = ((gist or {}).get("files") or {}).get("%s.json" % mac)
            try:
                rec = json.loads(peer.file_content(f) or "") if f else None
            except ValueError:
                rec = None
            st["fleet_at"] = rec.get("at") if isinstance(rec, dict) else None
            st["fleet_etag"] = etag
        at = peer.parse_iso(st.get("fleet_at"))
        age = None if at is None else round((self.clock() - at) / 60.0, 1)
        stale = age is None or age > MINI_STALE_MIN
        prev = st.get("mini_stale")
        tag = re.sub(r"\D", "", str(st.get("fleet_at") or ""))[:14] or "none"
        if stale and prev is not True:
            if self.wake("mini", "heartbeat-stale", "mini-stale-%s" % tag,
                         "%s's heartbeat is stale: %s" % (mac, "none in the fleet gist" if age is None else "last written %s min ago (%s)" % (age, st.get("fleet_at"))),
                         {"kind": "mini-heartbeat", "mac": mac, "stale": True, "heartbeat_at": st.get("fleet_at"), "age_min": age}):
                st["mini_stale"] = True
        elif not stale and prev is True:
            if self.wake("mini", "heartbeat-back", "mini-back-%s" % tag, "%s's heartbeat is back (%s min old)" % (mac, age),
                         {"kind": "mini-heartbeat", "mac": mac, "stale": False, "heartbeat_at": st.get("fleet_at"), "age_min": age}):
                st["mini_stale"] = False
        elif not stale:
            st["mini_stale"] = False

    def watch_drill(self, st):
        path = os.path.join(self.dir, "simulate-incident")
        if not os.path.exists(path):
            return
        try:
            with open(path) as f:
                note = f.read(2000).strip()
        except OSError:
            note = ""
        ts = peer.stamp(self.clock())
        mac = env("HOUSESITTER_MAC", "aris-mac-mini")
        if self.wake("mini", "heartbeat-stale", "mini-simulated-%s" % ts, "DRILL: %s's heartbeat is stale (simulated)" % mac,
                     {"kind": "mini-heartbeat", "mac": mac, "stale": True, "simulated": True, "note": note,
                      "how": "a drill: sitter_status with simulate \"stale-heartbeat\" answers the same way; nothing on the Mac changed"}):
            os.rename(path, "%s.consumed-%s" % (path, ts))

    # ---------- the loop ----------

    def tick(self):
        st = self.load()
        for name in ("drill", "peer", "outbox", "sitter", "mini"):
            b = self.backoff.get(name) or {"fails": 0, "until": 0}
            if self.clock() < b["until"]:
                continue
            try:
                getattr(self, "watch_" + name)(st)
                self.backoff.pop(name, None)
            except Exception as e:  # noqa: BLE001 - one bad source never stops the others
                b["fails"] += 1
                wait = min(600, int(env("HOUSESITTER_WATCH_SEC", "30")) * (2 ** b["fails"]))
                b["until"] = self.clock() + wait
                self.backoff[name] = b
                self.say(event="error", source=name, error=one_line("%s: %s" % (type(e).__name__, e), 300), retry_in_sec=wait)
            self.save(st)
        return st


def main(argv):
    w = Watcher()
    w.say(event="start", every_sec=int(env("HOUSESITTER_WATCH_SEC", "30")), agent=env("HOUSESITTER_AGENT", "housesitter"))
    while True:
        w.tick()
        if "--once" in argv:
            return 0
        time.sleep(int(env("HOUSESITTER_WATCH_SEC", "30")))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
