"""The peer link between Housesitter (on the KVM) and Ouroboros (on the Mac): free text through two secret gists.

Each message is one immutable gist file, <UTC yyyymmddTHHMMSSZ>-<8 hex>.json, holding
{"v": 1, "id", "at", "from", "to", "text", "re"?}. Reading GETs the in gist with an ETag (304: nothing new) and returns
the messages not yet in the seen-set, oldest first.

GitHub allows about 100 gist writes an hour per user, shared by the whole fleet, so sending is batched: a message goes
into a durable queue (peer-outbox.jsonl) and a flush writes everything queued, and deletes the out gist's files older
than 24 hours, in one PATCH. A flush happens at most once every HOUSESITTER_PEER_FLUSH_SEC (default 360) after the last
one, at once for an urgent message (now), and never more than HOUSESITTER_PEER_MAX_PER_HOUR (default 10) times in any
60 minutes; over the cap, messages wait in the queue and peer-log.jsonl gets a peer-cap line. send tries a flush;
watch.py and inbox flush whatever is due.

    python3 peer.py send <text> [--re <id>] [--to <name>] [--now]
    python3 peer.py inbox [--peek]
    python3 peer.py flush [--now]

Env: HOUSESITTER_PEER_IN, HOUSESITTER_PEER_OUT (gist ids), HOUSESITTER_STATE_DIR (queue, seen-set, ETag, log),
HOUSESITTER_PEER_FLUSH_SEC, HOUSESITTER_PEER_MAX_PER_HOUR, HOUSESITTER_TOKEN_FILE or GH_TOKEN / GITHUB_TOKEN,
HOUSESITTER_GITHUB_API (tests). Python 3 standard library only.
"""
import contextlib
import datetime
import fcntl
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

O_TO_H = "d10a53ca03a65b26aa2a4bbb96cec03d"  # Ouroboros writes, Housesitter reads
H_TO_O = "94a9ee97baab459bb32a37d6dbb7c52d"  # Housesitter writes, Ouroboros reads
KEEP_SEC = 24 * 3600
SEEN_MAX = 500
NAME_RE = re.compile(r"^(\d{8}T\d{6}Z)-([0-9a-f]{8})\.json$")
USER_AGENT = "housesitter-peer"
FLUSH_SEC = 360  # at most one flush every 6 minutes, unless it's urgent
MAX_PER_HOUR = 10  # GitHub allows about 100 gist writes an hour per user, shared by the whole fleet
clock = time.time  # tests replace it


def env(name, default):
    v = os.environ.get(name)
    return v if v else default


def state_dir():
    d = env("HOUSESITTER_STATE_DIR", "/userdata/ouro/housesitter")
    os.makedirs(d, exist_ok=True)
    return d


def api():
    return env("HOUSESITTER_GITHUB_API", "https://api.github.com").rstrip("/")


def token():
    try:
        with open(env("HOUSESITTER_TOKEN_FILE", "/userdata/ouro/secrets/github-token")) as fh:
            t = fh.read().strip()
        if t:
            return t
    except OSError:
        pass
    return os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or None


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, value):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def parse_iso(s):
    """An ISO 8601 time (JavaScript's toISOString or ours) as a Unix time, or None. No zone means UTC."""
    try:
        d = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return (d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)).timestamp()


def log(entry):
    with open(os.path.join(state_dir(), "peer-log.jsonl"), "a") as f:
        f.write(json.dumps(dict(entry, logged=iso(time.time()))) + "\n")


def file_time(name):
    m = NAME_RE.match(name)
    if not m:
        return None
    return datetime.datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()


def request(method, url, body=None, etag=None, timeout=20, raw=False):
    """One GitHub request: (status, etag, parsed body, or text when raw). A 304 is (304, etag, None)."""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28"}
    t = token()
    if t:
        headers["Authorization"] = "Bearer " + t
    if etag:
        headers["If-None-Match"] = etag
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode("utf-8")
            return r.status, r.headers.get("ETag"), (text if raw else (json.loads(text) if text else None))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            if e.code != 304:
                detail = json.loads(e.read().decode("utf-8")).get("message", "")
        except Exception:  # noqa: BLE001
            pass
        finally:
            e.close()
        if e.code == 304:
            return 304, etag, None
        raise RuntimeError("GitHub %s %s -> HTTP %d%s" % (method, url.split("?")[0], e.code, (": " + detail) if detail else ""))
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise RuntimeError("GitHub %s %s: %s" % (method, url.split("?")[0], e))


def get_gist(gist_id, etag=None):
    return request("GET", "%s/gists/%s" % (api(), gist_id), etag=etag)


def file_content(f):
    """A gist file's content. GitHub truncates large files in the gist response; then the whole file is at raw_url."""
    if f.get("truncated") and f.get("raw_url"):
        return request("GET", f["raw_url"], raw=True)[2]
    return f.get("content")


def messages(gist):
    """Every well-formed message in a gist, oldest first. A file that isn't one is skipped, never fatal."""
    out = []
    for name, f in sorted(((gist or {}).get("files") or {}).items()):
        if not NAME_RE.match(name) or not isinstance(f, dict):
            continue
        try:
            m = json.loads(file_content(f) or "")
        except (ValueError, RuntimeError):
            continue
        if isinstance(m, dict) and m.get("id") and m.get("at") and isinstance(m.get("text"), str):
            m["file"] = name
            out.append(m)
    out.sort(key=lambda m: (str(m.get("at")), m["file"]))
    return out


def stale_files(gist, now, keep_sec=KEEP_SEC):
    files = (gist or {}).get("files") or {}
    return sorted(n for n in files if file_time(n) is not None and now - file_time(n) > keep_sec)


def new_message(text, to="ouroboros", re_id=None, sender="housesitter@comet", now=None):
    now = time.time() if now is None else now
    mid = uuid.uuid4().hex[:8]
    msg = {"v": 1, "id": mid, "at": iso(now), "from": sender, "to": to, "text": text}
    if re_id:
        msg["re"] = re_id
    return "%s-%s.json" % (stamp(now), mid), msg


def flush_sec():
    return max(0, int(env("HOUSESITTER_PEER_FLUSH_SEC", str(FLUSH_SEC))))


def max_per_hour():
    return max(1, int(env("HOUSESITTER_PEER_MAX_PER_HOUR", str(MAX_PER_HOUR))))


@contextlib.contextmanager
def locked(name, block=True):
    """An exclusive lock on a file in the state dir (the MCP server's copies and the watcher share the queue). Yields
    whether it was taken: with block=False, False means another process holds it."""
    fd = os.open(os.path.join(state_dir(), name), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if block else fcntl.LOCK_NB))
            got = True
        except BlockingIOError:
            got = False
        yield got
    finally:
        os.close(fd)


def read_queue():
    out = []
    try:
        with open(os.path.join(state_dir(), "peer-outbox.jsonl")) as f:
            for ln in f:
                try:
                    e = json.loads(ln)
                except ValueError:
                    continue  # a half-written line is not a message
                if isinstance(e, dict) and isinstance(e.get("msg"), dict) and e.get("file"):
                    out.append(e)
    except OSError:
        pass
    return out


def write_queue(entries):
    path = os.path.join(state_dir(), "peer-outbox.jsonl")
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w") as f:
        f.write("".join(json.dumps(e) + "\n" for e in entries))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def send(text, to="ouroboros", re_id=None, sender="housesitter@comet", now=False, ts=None):
    """Queue one message for the out gist and flush the queue if it's due (now=True: at once, if the hourly cap allows).
    The message is on disk before anything is written to GitHub, so it is never lost; its status is sent or queued."""
    if not isinstance(text, str) or not text:
        raise ValueError("text: a message needs some text")
    ts = clock() if ts is None else ts
    name, msg = new_message(text, to, re_id, sender, ts)
    with locked("peer-outbox.lock"):
        with open(os.path.join(state_dir(), "peer-outbox.jsonl"), "a") as f:
            f.write(json.dumps({"file": name, "msg": msg}) + "\n")
            f.flush()
            os.fsync(f.fileno())
    out = {"ok": True, "id": msg["id"], "at": msg["at"], "file": name, "to": to}
    try:
        r = flush(now=now, ts=ts)
    except RuntimeError as e:
        r = {"error": str(e)}  # it stays queued; the next flush (the watcher's, within minutes) takes it
    sent = msg["id"] in (r.get("sent") or [])
    out["status"] = "sent" if sent else "queued"
    for k in ("pruned", "queued", "next_flush_at", "capped", "next_allowed_at", "busy", "error"):
        if k in r:
            out[k] = r[k]
    return out


def flush_if_due(ts=None):
    """Write the queue to the out gist if the last flush was HOUSESITTER_PEER_FLUSH_SEC (default 6 min) ago."""
    return flush(now=False, ts=ts)


def flush(now=False, ts=None, gist_id=None):
    """Write every queued message to the out gist in one PATCH, which also deletes its files older than 24 h. Only when
    it's due (or now=True) and the hourly cap allows; otherwise the messages stay queued. A failed PATCH leaves them
    queued too and raises. Each PATCH tried counts against the cap."""
    gist_id = gist_id or env("HOUSESITTER_PEER_OUT", H_TO_O)
    ts = clock() if ts is None else ts
    with locked("peer-flush.lock", block=False) as got:
        if not got:
            return {"ok": True, "sent": [], "queued": len(read_queue()), "busy": True}
        with locked("peer-outbox.lock"):
            queue = read_queue()
        if not queue:
            return {"ok": True, "sent": [], "queued": 0}
        state_path = os.path.join(state_dir(), "peer-flush.json")
        st = read_json(state_path, {})
        st = st if isinstance(st, dict) else {}
        writes = sorted(w for w in (st.get("writes") or []) if isinstance(w, (int, float)) and ts - w < 3600)
        last = st.get("last")
        every = flush_sec()
        if not now and isinstance(last, (int, float)) and ts - last < every:
            return {"ok": True, "sent": [], "queued": len(queue), "next_flush_at": iso(last + every)}
        cap = max_per_hour()
        if len(writes) >= cap:
            next_allowed = iso(writes[len(writes) - cap] + 3600)
            if not isinstance(st.get("cap_logged"), (int, float)) or ts - st["cap_logged"] >= 60:
                log({"at": iso(ts), "event": "peer-cap", "queued": len(queue), "next_allowed_at": next_allowed})
                st["cap_logged"] = ts
                write_json(state_path, dict(st, writes=writes))
            return {"ok": True, "sent": [], "queued": len(queue), "capped": True, "next_allowed_at": next_allowed}
        try:
            pruned = stale_files(get_gist(gist_id)[2], ts)
        except RuntimeError:
            pruned = []  # pruning is housekeeping: a failed read never stops a message
        files = {n: None for n in pruned}
        for e in queue:
            files[e["file"]] = {"content": json.dumps(e["msg"])}
        st["writes"] = writes + [ts]
        write_json(state_path, st)
        request("PATCH", "%s/gists/%s" % (api(), gist_id), body={"files": files})
        st["last"] = ts
        write_json(state_path, st)
        done = {e["msg"]["id"] for e in queue}
        with locked("peer-outbox.lock"):
            left = [e for e in read_queue() if e["msg"]["id"] not in done]
            write_queue(left)
        for e in queue:
            log({"dir": "sent", "gist": gist_id, "file": e["file"], "msg": e["msg"]})
        log({"dir": "flush", "gist": gist_id, "at": iso(ts), "files": [e["file"] for e in queue], "pruned": pruned, "urgent": bool(now)})
        return {"ok": True, "sent": [e["msg"]["id"] for e in queue], "queued": len(left), "pruned": pruned}


def inbox(gist_id=None, mark=True):
    """New messages from the peer, oldest first, then marked seen. A 304 means nothing new since the last read.
    Unless peeking, it also flushes the out queue if that's due."""
    flushed = {}
    if mark:
        try:
            flushed = flush_if_due()
        except RuntimeError as e:
            flushed = {"error": str(e)}
    out = _read_inbox(gist_id, mark)
    if flushed.get("sent") or flushed.get("error") or flushed.get("capped"):
        out["outbox"] = {k: v for k, v in flushed.items() if k != "ok"}
    return out


def _read_inbox(gist_id, mark):
    gist_id = gist_id or env("HOUSESITTER_PEER_IN", O_TO_H)
    d = state_dir()
    etags = read_json(os.path.join(d, "peer-etag.json"), {})
    seen = read_json(os.path.join(d, "peer-seen.json"), [])
    etags = etags if isinstance(etags, dict) else {}
    seen = seen if isinstance(seen, list) else []
    status, etag, gist = get_gist(gist_id, etags.get(gist_id) if mark else None)
    if status == 304:
        return {"ok": True, "messages": [], "unchanged": True}
    fresh = [m for m in messages(gist) if m["id"] not in seen]
    if mark:
        for m in fresh:
            log({"dir": "received", "gist": gist_id, "file": m["file"], "msg": m})
        write_json(os.path.join(d, "peer-seen.json"), (seen + [m["id"] for m in fresh])[-SEEN_MAX:])
        if etag:
            etags[gist_id] = etag
            write_json(os.path.join(d, "peer-etag.json"), etags)
    return {"ok": True, "messages": fresh}


def main(argv):
    if not argv or argv[0] not in ("send", "inbox", "flush"):
        print(__doc__.strip())
        return 2
    try:
        if argv[0] == "send":
            words, re_id, to, i = [], None, "ouroboros", 1
            while i < len(argv):
                if argv[i] in ("--re", "--to") and i + 1 < len(argv):
                    if argv[i] == "--re":
                        re_id = argv[i + 1]
                    else:
                        to = argv[i + 1]
                    i += 2
                elif argv[i] == "--now":
                    i += 1
                else:
                    words.append(argv[i])
                    i += 1
            out = send(" ".join(words), to=to, re_id=re_id, now="--now" in argv)
        elif argv[0] == "inbox":
            out = inbox(mark="--peek" not in argv)
        else:
            out = flush(now="--now" in argv)
    except (RuntimeError, ValueError, OSError) as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
