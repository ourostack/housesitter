"""The peer link between Housesitter (on the KVM) and Ouroboros (on the Mac): free text through two secret gists.

Each message is one immutable gist file, <UTC yyyymmddTHHMMSSZ>-<8 hex>.json, holding
{"v": 1, "id", "at", "from", "to", "text", "re"?}. Sending adds a file to the out gist and, in the same PATCH, deletes
files there older than 24 hours. Reading GETs the in gist with an ETag (304: nothing new) and returns the messages not
yet in the seen-set, oldest first.

    python3 peer.py send <text> [--re <id>] [--to <name>]
    python3 peer.py inbox [--peek]
    python3 peer.py prune

Env: HOUSESITTER_PEER_IN, HOUSESITTER_PEER_OUT (gist ids), HOUSESITTER_STATE_DIR (seen-set, ETag, log),
HOUSESITTER_TOKEN_FILE or GH_TOKEN / GITHUB_TOKEN, HOUSESITTER_GITHUB_API (tests). Python 3 standard library only.
"""
import datetime
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


def send(text, to="ouroboros", re_id=None, gist_id=None, sender="housesitter@comet", now=None):
    """Add one message to the out gist, deleting its files older than 24 h in the same PATCH."""
    if not isinstance(text, str) or not text:
        raise ValueError("text: a message needs some text")
    gist_id = gist_id or env("HOUSESITTER_PEER_OUT", H_TO_O)
    now = time.time() if now is None else now
    name, msg = new_message(text, to, re_id, sender, now)
    try:
        pruned = stale_files(get_gist(gist_id)[2], now)
    except RuntimeError:
        pruned = []  # pruning is housekeeping: a failed read never stops a message
    files = {n: None for n in pruned}
    files[name] = {"content": json.dumps(msg)}
    request("PATCH", "%s/gists/%s" % (api(), gist_id), body={"files": files})
    log({"dir": "sent", "gist": gist_id, "file": name, "msg": msg, "pruned": pruned})
    return {"ok": True, "id": msg["id"], "at": msg["at"], "file": name, "to": to, "pruned": pruned}


def prune(gist_id=None, now=None):
    """Delete the out gist's messages older than 24 h, without sending one."""
    gist_id = gist_id or env("HOUSESITTER_PEER_OUT", H_TO_O)
    now = time.time() if now is None else now
    pruned = stale_files(get_gist(gist_id)[2], now)
    if pruned:
        request("PATCH", "%s/gists/%s" % (api(), gist_id), body={"files": {n: None for n in pruned}})
    return {"ok": True, "pruned": pruned}


def inbox(gist_id=None, mark=True):
    """New messages from the peer, oldest first, then marked seen. A 304 means nothing new since the last read."""
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
    if not argv or argv[0] not in ("send", "inbox", "prune"):
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
                else:
                    words.append(argv[i])
                    i += 1
            out = send(" ".join(words), to=to, re_id=re_id)
        elif argv[0] == "inbox":
            out = inbox(mark="--peek" not in argv)
        else:
            out = prune()
    except (RuntimeError, ValueError, OSError) as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
