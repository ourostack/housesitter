"""Shared set-up for the Ouro plugin's tests: a scratch state dir, a fake gist API, a fake sitter and a fake ouro."""
import json
import os
import shlex
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PLUGIN = os.path.join(ROOT, "plugins", "housesitter")
sys.path.insert(0, PLUGIN)
sys.path.insert(0, HERE)
from fake_gist import FakeGists  # noqa: E402

SCRATCH = os.path.join(ROOT, ".scratch")
IN, OUT, FLEET = "in0000", "out000", "fleet0"


def slurp(path, mode="r"):
    with open(path, mode) as f:
        return f.read()


def jsonl(path):
    return [json.loads(ln) for ln in slurp(path).splitlines() if ln.strip()]


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ts))


class PluginCase(unittest.TestCase):
    def setUp(self):
        os.makedirs(SCRATCH, exist_ok=True)
        self.dir = tempfile.mkdtemp(dir=SCRATCH, prefix="plugin-")
        self.state = os.path.join(self.dir, "state")
        self.home = os.path.join(self.dir, "home")
        os.makedirs(self.home)
        self.gh = FakeGists()
        self.gh.gists = {IN: {}, OUT: {}, FLEET: {"aris-mac-mini.json": json.dumps({"machine": "aris-mac-mini", "at": iso(time.time() - 60), "uptime_min": 300, "screen": {"locked": False}})}}
        with open(os.path.join(self.dir, "token"), "w") as f:
            f.write("test-token\n")
        self.sitter_log = os.path.join(self.dir, "sitter.log")
        self.ouro_log = os.path.join(self.dir, "ouro.log")
        self.saved_env = dict(os.environ)
        for k in ("GH_TOKEN", "GITHUB_TOKEN", "FAKE_SITTER_REFUSE", "FAKE_OURO_EXIT"):
            os.environ.pop(k, None)
        os.environ.update({
            "HOUSESITTER_GITHUB_API": self.gh.url, "HOUSESITTER_STATE_DIR": self.state, "HOUSESITTER_HOME": self.home,
            "HOUSESITTER_TOKEN_FILE": os.path.join(self.dir, "token"), "HOUSESITTER_PEER_IN": IN, "HOUSESITTER_PEER_OUT": OUT,
            "HOUSESITTER_FLEET_GIST": FLEET, "HOUSESITTER_MAC": "aris-mac-mini",
            "HOUSESITTER_SITTER_CMD": "%s %s" % (shlex.quote(sys.executable), shlex.quote(os.path.join(HERE, "fake_sitter.py"))),
            "HOUSESITTER_OURO_BIN": "%s %s" % (shlex.quote(sys.executable), shlex.quote(os.path.join(HERE, "fake_ouro.py"))),
            "FAKE_SITTER_LOG": self.sitter_log, "FAKE_OURO_LOG": self.ouro_log,
        })

    def tearDown(self):
        self.gh.stop()
        os.environ.clear()
        os.environ.update(self.saved_env)

    def write_status(self, state="healthy", screen="desktop", age=0, interval=60):
        p = os.path.join(self.home, "status.json")
        with open(p, "w") as f:
            json.dump({"v": 1, "at": int((time.time() - age) * 1000), "state": state, "obs": {"screen": screen}, "interval_sec": interval}, f)
        os.utime(p, (time.time() - age, time.time() - age))
        return p

    def put_message(self, gist, name, msg):
        self.gh.gists[gist][name] = json.dumps(msg)

    def sitter_calls(self):
        if not os.path.exists(self.sitter_log):
            return []
        return jsonl(self.sitter_log)

    def ouro_calls(self):
        if not os.path.exists(self.ouro_log):
            return []
        return jsonl(self.ouro_log)
