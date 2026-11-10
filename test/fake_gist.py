"""A local stand-in for GitHub's gist API, for the plugin's tests: GET (with ETags and truncated files), PATCH, raw."""
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


class FakeGists:
    def __init__(self):
        self.gists = {}  # id -> {name: content}
        self.truncate = set()  # file names served truncated, whole at raw_url
        self.requests = []
        self.fail = False
        me = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, body=None, headers=None):
                data = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode("utf-8"))
                self.send_response(code)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def record(self, body=None):
                me.requests.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"),
                                    "etag": self.headers.get("If-None-Match"), "ua": self.headers.get("User-Agent"), "body": body})

            def do_GET(self):
                self.record()
                if me.fail:
                    return self.reply(500, {"message": "boom"})
                parts = self.path.strip("/").split("/")
                if parts[0] == "raw" and len(parts) == 3:
                    c = me.gists.get(parts[1], {}).get(parts[2])
                    return self.reply(200, c.encode("utf-8")) if c is not None else self.reply(404, {"message": "Not Found"})
                if parts[0] != "gists" or parts[1] not in me.gists:
                    return self.reply(404, {"message": "Not Found"})
                gid = parts[1]
                etag = me.etag(gid)
                if self.headers.get("If-None-Match") == etag:
                    return self.reply(304, headers={"ETag": etag})
                files = {}
                for n, c in me.gists[gid].items():
                    f = {"filename": n, "raw_url": "http://127.0.0.1:%d/raw/%s/%s" % (me.port, gid, n), "size": len(c)}
                    if n in me.truncate:
                        f.update(content=c[:10], truncated=True)
                    else:
                        f.update(content=c, truncated=False)
                    files[n] = f
                self.reply(200, {"id": gid, "files": files}, {"ETag": etag})

            def do_PATCH(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                self.record(body)
                gid = self.path.strip("/").split("/")[1]
                if gid not in me.gists:
                    return self.reply(404, {"message": "Not Found"})
                for n, f in (body.get("files") or {}).items():
                    if f is None:
                        me.gists[gid].pop(n, None)
                    else:
                        me.gists[gid][n] = f["content"]
                self.reply(200, {"id": gid}, {"ETag": me.etag(gid)})

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.url = "http://127.0.0.1:%d" % self.port
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def etag(self, gid):
        return '"%s"' % hashlib.sha1(json.dumps(self.gists.get(gid), sort_keys=True).encode("utf-8")).hexdigest()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
