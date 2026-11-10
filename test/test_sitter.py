"""The sitter (device/sitter.py): the same scenarios as src/watchdog.mjs, plus its own I/O, with fakes."""
import base64
import hashlib
import json
import urllib.error
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "device"))
import sitter as W  # noqa: E402
from fake_tables import FakeTables  # noqa: E402

W.SLEEP = lambda sec: None  # the guard waits minutes between looks on a real KVM; tests never wait

SCRATCH = os.path.join(ROOT, ".scratch")


def scratch():
    os.makedirs(SCRATCH, exist_ok=True)
    return tempfile.mkdtemp(dir=SCRATCH)


CASES = json.load(open(os.path.join(ROOT, "spec", "watchdog-cases.json")))


def play(sc):
    mem, ledger, got = None, [], []
    for st in sc["steps"]:
        now = st["t"] * 60000
        mem, actions = W.tick(mem, ledger, st["obs"], now, sc["caps"])
        for a in actions:
            if a["kind"] == "wait":
                continue
            ledger.append({"at": now, "kind": a["kind"], "state": mem["state"]})
            if a["kind"] == "notify" and mem.get("incident"):
                mem["incident"]["notified_at"] = now
        got.append({"t": st["t"], "state": mem["state"], "actions": [a["kind"] for a in actions]})
    return got


class Scenarios(unittest.TestCase):
    def test_shared_scenarios(self):
        for sc in CASES["scenarios"]:
            got = play(sc)
            for i, st in enumerate(sc["steps"]):
                with self.subTest(scenario=sc["name"], t=st["t"]):
                    self.assertEqual(got[i]["state"], st["state"], got[i])
                    self.assertEqual(got[i]["actions"], st["actions"], got[i])


class Screen(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(W.classify_screen("Ada Lovelace\nEnter Password\nRestart  Shut Down"), "login")
        self.assertEqual(W.classify_screen("FileVault\nEnter Password\nRestart"), "filevault")
        self.assertEqual(W.classify_screen("Finder File Edit View Go Window Help\nEnter Password"), "desktop")
        self.assertEqual(W.classify_screen(""), "blank")
        self.assertEqual(W.classify_screen(None), "unknown")
        self.assertEqual(W.classify_screen("Ada\nEnter Password", ["Ada"]), "login")
        self.assertEqual(W.classify_screen("Ada\nEnter Password"), "unknown")

    def test_clock(self):
        mem = {}
        self.assertIsNone(W.clock_ticking(mem, "Sat 9:41 PM"))
        self.assertTrue(W.clock_ticking(mem, "Sat 9:42 PM"))
        self.assertTrue(W.clock_ticking(mem, "Sat 9:42 PM"))
        self.assertFalse(W.clock_ticking(mem, "Sat 9:42 PM"))
        self.assertIsNone(W.clock_ticking(mem, ""))


class FakeKvmd:
    def __init__(self, online=True, text="Finder File Edit View Go Window Help", clocks=("9:41", "9:42")):
        self.online, self.text, self.clocks, self.calls, self.posts = online, text, list(clocks), [], []

    def json(self, path):
        self.calls.append(path)
        if path == "/streamer":
            return {"streamer": {"source": {"online": self.online}}}
        if "ocr_left" in path:
            return self.clocks.pop(0) if len(self.clocks) > 1 else self.clocks[0]
        if path.startswith("/streamer/snapshot"):
            return self.text
        raise AssertionError(path)

    def get(self, path, timeout=15):
        self.calls.append(path)
        return b'{"ok":true}'

    def post(self, path, body=None, timeout=60):
        self.posts.append((path, body))
        return b'{"ok":true}'


class FakePlug:
    def __init__(self, on=True, watts=12.0):
        self.on_, self.watts, self.calls = on, watts, []

    def status(self):
        return {"on": self.on_, "watts": self.watts}

    def cycle(self, off_sec=10):
        self.calls.append(("cycle", off_sec))
        return {"was_on": True}

    def on(self):
        self.calls.append(("on",))
        return {"was_on": False}


class Io(unittest.TestCase):
    def setUp(self):
        self.dir = scratch()
        W.HOME = self.dir
        self.logs = []
        self._arp = W.arp_alive

    def tearDown(self):
        W.arp_alive = self._arp

    def test_arp(self):
        table = "IP address HW type Flags HW address Mask Device\n10.0.0.5 0x1 0x2 aa:bb:cc:dd:ee:ff * eth0\n10.0.0.6 0x1 0x0 00:00:00:00:00:00 * eth0\n"
        same = lambda ips: ips  # noqa: E731
        self.assertTrue(W.arp_alive(["10.0.0.5"], [], run=lambda *a, **k: None, read=lambda: table, on_link=same))
        self.assertFalse(W.arp_alive(["10.0.0.6"], [], run=lambda *a, **k: None, read=lambda: table, on_link=same))
        self.assertFalse(W.arp_alive(["10.0.0.5"], ["11:22:33:44:55:66"], run=lambda *a, **k: None, read=lambda: table, on_link=same))
        self.assertIsNone(W.arp_alive([], [], run=lambda *a, **k: None, read=lambda: table, on_link=same))
        # The Mac on another network than the KVM: ARP is skipped, never "down".
        self.assertIsNone(W.arp_alive(["10.0.0.5"], [], run=lambda *a, **k: None, read=lambda: table, on_link=lambda ips: []))

    def test_on_link(self):
        route = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n" \
                "eth0\t00000000\t0100000A\t0003\t0\t0\t0\t00000000\n" \
                "eth0\t0000000A\t00000000\t0001\t0\t0\t0\t00FFFFFF\n"
        self.assertEqual(W.local_ips(["10.0.0.20", "192.168.50.86"], read_route=lambda: route), ["10.0.0.20"])

    def test_hang_power_cycles_through_the_plug_once(self):
        cfg = {"name": "studio", "mac_ips": []}
        kvmd = FakeKvmd(online=True, text="Finder File Edit View Go Window Help", clocks=("9:41",))
        plug = FakePlug(on=True, watts=14)
        W.arp_alive = lambda ips, macs: False
        statuses = [W.once(cfg, kvmd, plug, self.logs.append, now=t * 60000) for t in range(0, 8)]
        self.assertEqual(statuses[0]["state"], "degraded")
        self.assertEqual([s["state"] for s in statuses[5:]], ["hung", "hung", "hung"])
        self.assertEqual(plug.calls, [("cycle", 10)])
        self.assertTrue(any("power_cycle" in l for l in self.logs))
        with open(os.path.join(self.dir, "status.json")) as f:
            st = json.load(f)
        self.assertEqual(st["name"], "studio")

    def test_filevault_without_a_password_on_the_sitter_you_hear_once(self):
        sent = []
        cfg = {"name": "studio", "notify": {"kind": "webhook", "url": "https://example.invalid/hook"}, "rules": {"filevault_wait_min": 0}}
        kvmd = FakeKvmd(online=True, text="FileVault\nAda Lovelace\nEnter Password\nRestart")
        W.arp_alive = lambda ips, macs: None

        class Resp:
            status = 202
            def __enter__(self): return self
            def __exit__(self, *a): return False

        orig = W.notify
        W.notify = lambda cfg, s, b, opener=None: sent.append((s, b)) or "posted 202"
        try:
            for t in range(0, 4):
                W.once(cfg, kvmd, None, self.logs.append, now=t * 60000)
        finally:
            W.notify = orig
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], "studio is stuck at FileVault")
        self.assertNotIn("hid", " ".join(kvmd.calls))

    def test_unlocks_with_its_own_password_only_at_the_prompt(self):
        key = b"k" * 32
        W.store_secret("mac", "fake-filevault-password", key=key)
        orig = W.load_secret
        W.load_secret = lambda name, k=None: orig(name, key)
        try:
            # The FileVault screen after a boot (OCR reads it as such); a plain lock screen stays locked (OnlyAfterABoot).
            kvmd = FakeKvmd(online=True, text="FileVault\nAda Lovelace\nEnter Password\nRestart Shut Down")
            W.arp_alive = lambda ips, macs: None
            st = W.once({"name": "studio"}, kvmd, None, self.logs.append, now=0)
            self.assertEqual(st["state"], "filevault")
            self.assertEqual(st["actions"], [], "disarmed by default: a stored password is never typed")
            self.assertFalse(any(p[0].startswith("/hid/print") for p in kvmd.posts))
            W.set_password_trust("verified", "test")
            st = W.once({"name": "studio"}, kvmd, None, self.logs.append, now=60000)
            self.assertEqual([a["kind"] for a in st["actions"]], ["unlock"])
            self.assertIn("typed the password", st["actions"][0]["result"])
            self.assertIn(("/hid/print?limit=0&slow=1", b"fake-filevault-password"), kvmd.posts)
            self.assertEqual(kvmd.posts[-1][0], "/hid/events/send_key?key=Enter")
            self.assertNotIn("fake-filevault-password", " ".join(self.logs) + json.dumps(st))
            # The same request at the desktop is refused: it never types into an app.
            kvmd2 = FakeKvmd(online=True)
            self.assertIn("refused", W.unlock({}, kvmd2, {"ledger": []}, 120000, secret=lambda n: "pw"))
            self.assertFalse(any(p[0].startswith("/hid/print") for p in kvmd2.posts))
        finally:
            W.load_secret = orig

    def test_dry_run_acts_on_nothing(self):
        cfg = {"name": "m", "dry_run": True}
        plug = FakePlug(on=False, watts=0)
        W.arp_alive = lambda ips, macs: False
        for t in range(0, 5):
            W.once(cfg, FakeKvmd(online=False), plug, self.logs.append, now=t * 60000)
        self.assertEqual(plug.calls, [])
        self.assertTrue(any("dry-run: would power_on" in l for l in self.logs))


class Secrets(unittest.TestCase):
    def setUp(self):
        self.dir = scratch()
        W.HOME = self.dir

    def test_sealed_root_only_and_bound_to_the_device(self):
        a, b = b"a" * 32, b"b" * 32
        r = W.store_secret("mac", "s3cret-Pass_word", key=a)
        self.assertEqual(r, {"stored": "mac", "bound_to": "given"}, "the receipt says nothing about the value, not even its length")
        p = os.path.join(self.dir, "mac.cred")
        self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)
        self.assertNotIn("s3cret", open(p).read())
        self.assertEqual(W.load_secret("mac", a), "s3cret-Pass_word")
        self.assertIsNone(W.load_secret("mac", b), "a copied file does not open on another device")
        with self.assertRaises(ValueError):
            W.store_secret("mac", "two\nlines", key=a)
        with self.assertRaises(ValueError):
            W.store_secret("other", "x", key=a)

    def test_device_key_prefers_hardware_ids(self):
        f = os.path.join(self.dir, "cid")
        with open(f, "w") as h:
            h.write("1501004d4d433332470a\n")
        k1, how = W.device_key([f])
        self.assertEqual(how, "hardware")
        self.assertEqual(k1, W.device_key([f])[0])


class Inbox(unittest.TestCase):
    def setUp(self):
        self.dir = scratch()
        W.HOME = self.dir
        self.logs = []

    def gh(self, cmd):
        class G:
            puts = []

            def get(self, gist, etag=None):
                tag = "e-%s" % cmd.get("id")
                if etag == tag:
                    return 304, etag, None
                return 200, tag, {"files": {"studio.cmd.json": {"content": json.dumps(cmd)}}}

            def put(self, gist, files):
                G.puts.append(files)
                return 200, None, {}
        return G()

    def test_click_key_type_and_replay(self):
        cfg = {"name": "studio", "outbox": {"gist": "o", "inbox": "i"}}
        kvmd = FakeKvmd()
        now = 1_700_000_000_000
        g = self.gh({"v": 1, "id": "r1", "op": "click", "args": {"x": 960, "y": 540, "w": 1920, "h": 1080}, "at": now})
        rep = W.poll_inbox(cfg, g, kvmd, None, self.logs.append, now=now)
        self.assertTrue(rep["ok"])
        self.assertEqual(kvmd.posts[0][0], "/hid/events/send_mouse_move?to_x=17&to_y=30")
        self.assertIn("studio.reply.json", g.puts[-1])
        self.assertIsNone(W.poll_inbox(cfg, g, kvmd, None, self.logs.append, now=now), "unchanged inbox: 304, nothing runs")
        st = W.load("state.json", {})
        st.pop("inbox_etag")
        W.save("state.json", st)
        self.assertIsNone(W.poll_inbox(cfg, g, kvmd, None, self.logs.append, now=now), "the same id never runs twice")
        self.assertEqual(len(kvmd.posts), 3)
        W.save("state.json", {})
        rep = W.poll_inbox(cfg, self.gh({"v": 1, "id": "r2", "op": "key", "args": {"combo": "cmd+space"}, "at": now}), kvmd, None, self.logs.append, now=now)
        self.assertEqual(kvmd.posts[-1][0], "/hid/events/send_shortcut?keys=MetaLeft,Space")
        rep = W.poll_inbox(cfg, self.gh({"v": 1, "id": "r3", "op": "type", "args": {"text": "hello"}, "at": now}), kvmd, None, self.logs.append, now=now)
        self.assertEqual(kvmd.posts[-1], ("/hid/print?limit=0&slow=1", b"hello"))
        rep = W.poll_inbox(cfg, self.gh({"v": 1, "id": "r4", "op": "reboot", "at": now}), kvmd, None, self.logs.append, now=now)
        self.assertEqual(rep["code"], "action-unavailable")
        rep = W.poll_inbox(cfg, self.gh({"v": 1, "id": "r5", "op": "click", "args": {"x": 5000, "y": 1}, "at": now}), kvmd, None, self.logs.append, now=now)
        self.assertEqual(rep["code"], "input-invalid")
        self.assertIsNone(W.poll_inbox(cfg, self.gh({"v": 1, "id": "r6", "op": "status", "at": now - 3600000}), kvmd, None, self.logs.append, now=now), "stale requests are dropped")

    def test_keys(self):
        self.assertEqual(W.key_names("cmd+shift+4"), ["MetaLeft", "ShiftLeft", "Digit4"])
        self.assertEqual(W.key_names("Return"), ["Enter"])
        with self.assertRaises(ValueError):
            W.key_names("cmd+??")


class Glkvm(unittest.TestCase):
    """kvm-pilot's live GL-RM1PE findings (github.com/DustinTrap/kvm-pilot): API off by default, H.264 snapshots."""

    def test_enable_api_uncomments_only_the_api_blocks_once(self):
        d = scratch()
        conf = os.path.join(d, "nginx-kvmd.conf")
        with open(conf, "w") as f:
            f.write("server {\n    location / { root /usr/share/kvmd/web; }\n#    location /api {\n#        rewrite ^/api/(.*)$ /$1 break;\n#        proxy_pass http://kvmd;\n#    }\n    # a comment that stays\n}\n")
        self.assertEqual(W.enable_api(conf), 1)
        text = open(conf).read()
        self.assertIn("    location /api {\n        rewrite", text)
        self.assertIn("    # a comment that stays", text)
        self.assertTrue(os.path.exists(conf + ".orig-housesitter"))
        self.assertEqual(W.enable_api(conf), 0, "idempotent")

    def test_snapshot_flips_to_mjpeg_when_handed_h264(self):
        class K:
            posts, n = [], 0
            def get(self, p, timeout=15):
                K.n += 1
                return b"\x00\x00\x00\x01\x41" if K.n == 1 else b"\xff\xd8jpeg"
            def post(self, p, body=None, timeout=60):
                K.posts.append(p)
        orig = W.time.sleep
        W.time.sleep = lambda s: None
        try:
            self.assertEqual(W.snapshot_jpeg(K()), b"\xff\xd8jpeg")
        finally:
            W.time.sleep = orig
        self.assertEqual(K.posts, ["/streamer/set_params?video_format=1"])

    def test_snapshot_http_500_falls_through_to_the_decoded_keyframe(self):
        class K:
            posts = []
            def get(self, p, timeout=15):
                raise RuntimeError("kvmd GET /streamer/snapshot -> HTTP 500")
            def post(self, p, body=None, timeout=60):
                K.posts.append(p)
        orig = W.time.sleep
        W.time.sleep = lambda s: None
        try:
            self.assertEqual(W.snapshot_jpeg(K(), frame=lambda k: b"\xff\xd8frame"), b"\xff\xd8frame")
        finally:
            W.time.sleep = orig
        self.assertEqual(K.posts, ["/streamer/set_params?video_format=1", "/streamer/set_params?video_format=0"])

    def test_shrink_yuv420_keeps_every_nth_pixel_and_both_chroma_planes(self):
        w, h = 8, 4
        y = bytes(range(w * h)); u = bytes(100 + i for i in range(w * h // 4)); v = bytes(200 + i for i in range(w * h // 4))
        out, nw, nh = W.shrink_yuv420(y + u + v, w, h, 4)
        self.assertEqual((nw, nh), (4, 2))
        self.assertEqual(out[:8], bytes([0, 2, 4, 6, 16, 18, 20, 22]))
        self.assertEqual(out[8:], bytes([100, 102, 200, 202]))
        self.assertEqual(len(out), nw * nh * 3 // 2)
        same = W.shrink_yuv420(y + u + v, w, h, 1920)
        self.assertEqual(same, (y + u + v, w, h))

    def test_the_decoded_keyframe_is_shrunk_to_the_width_asked(self):
        w, h = 2560, 1440
        frame = bytes(w * h * 3 // 2)
        calls = []
        def run(cmd, capture_output=True, timeout=20, input=None):
            calls.append((cmd, input))
            if cmd[0] == "sh":
                return types.SimpleNamespace(stdout=frame)
            return types.SimpleNamespace(stdout=b"\xff\xd8small")
        self.assertEqual(W.frame_jpeg(object(), run=run, width=1280), b"\xff\xd8small")
        enc, data = calls[-1]
        self.assertIn("1280x720", enc)
        self.assertEqual(len(data), 1280 * 720 * 3 // 2)


class Ble(unittest.TestCase):
    def test_shelly_gatt_framing(self):
        log = []

        class Conn:
            reply = json.dumps({"id": 1, "result": {"was_on": True}}).encode()

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def write(self, uuid, data):
                log.append((uuid, data))

            def read(self, uuid):
                if uuid == W.SHELLY_BLE["rx_ctl"]:
                    return len(Conn.reply).to_bytes(4, "big")
                out, Conn.reply = Conn.reply[:20], Conn.reply[20:]
                return out

        p = W.ShellyBle("AA:BB:CC:DD:EE:FF", connect=lambda mac: Conn(), chunk=16)
        self.assertEqual(p.cycle(10), {"was_on": True})
        n = int.from_bytes(log[0][1], "big")
        body = b"".join(d for u, d in log[1:])
        self.assertEqual(log[0][0], W.SHELLY_BLE["tx_ctl"])
        self.assertEqual(len(body), n)
        req = json.loads(body)
        self.assertEqual((req["method"], req["params"]), ("Switch.Set", {"id": 0, "on": False, "toggle_after": 10}))
        self.assertIsInstance(W.make_power({"power": {"kind": "shelly-ble", "mac": "AA:BB:CC:DD:EE:FF"}}), W.ShellyBle)
        self.assertIsInstance(W.make_power({"power": {"kind": "shelly", "url": "http://10.0.0.9"}}), W.ShellyHttp)
        self.assertIsInstance(W.make_power({"power": {"kind": "command", "cycle": "true"}}), W.CommandPower)
        self.assertIsNone(W.make_power({}))


class Power(unittest.TestCase):
    def test_shelly_http_rpc(self):
        urls = []

        class R:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return self.body

        def opener(req, timeout=5):
            urls.append(getattr(req, "full_url", req))
            return R(b'{"output": true, "apower": 17.5}')
        p = W.ShellyHttp("http://10.0.0.9/", opener=opener)
        self.assertEqual(p.status(), {"on": True, "watts": 17.5})
        p.cycle(10)
        self.assertEqual(urls[-1], "http://10.0.0.9/rpc/Switch.Set?id=0&on=false&toggle_after=10")

    def test_command_power_runs_word_lists_without_a_shell(self):
        calls = []

        class Done:
            returncode, stdout, stderr = 0, '{"on": true, "watts": 3}', ""
        p = W.CommandPower({"cycle": "hass-cli switch toggle switch.mac", "status": ["plug", "status"]}, run=lambda a, **k: calls.append(a) or Done())
        self.assertEqual(p.status(), {"on": True, "watts": 3})
        p.cycle()
        self.assertEqual(calls, [["plug", "status"], ["hass-cli", "switch", "toggle", "switch.mac"]])
        with self.assertRaises(RuntimeError):
            p.on()


class Notify(unittest.TestCase):
    def test_ntfy_and_webhook(self):
        reqs = []

        class R:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False

        op = lambda req, timeout=10: reqs.append(req) or R()  # noqa: E731
        self.assertEqual(W.notify({"notify": {"kind": "ntfy", "url": "https://ntfy.sh/t"}}, "studio needs you", "body", opener=op), "posted 200")
        self.assertEqual(reqs[0].data, b"body")
        self.assertEqual(reqs[0].headers["Title"], b"studio needs you")
        W.notify({"notify": {"kind": "webhook", "url": "https://example.invalid/h"}}, "s", "b", opener=op)
        self.assertEqual(json.loads(reqs[1].data)["subject"], "s")
        self.assertIn("no notify target", W.notify({}, "s", "b", opener=op))

    def test_it_only_claims_it_can_tell_you_when_it_has_somewhere_to_say_it(self):
        self.assertFalse(W.caps_of({}, None)["notify"])
        self.assertFalse(W.caps_of({"notify": {"kind": "ntfy"}}, None)["notify"])
        self.assertTrue(W.caps_of({"notify": {"kind": "ntfy", "url": "https://ntfy.sh/t"}}, None)["notify"])


class NotifyEmail(unittest.TestCase):
    """notify.email: ntfy forwards the message to one address (its Email header), from an account, at most a few a day."""

    def setUp(self):
        W.HOME = scratch()
        self.reqs, self.refuse = [], None
        self.saved = W.load_secret
        W.load_secret = lambda name, key=None: "tk_fake" if name == "ntfy" else None
        cfg = {"name": "mini", "notify": {"kind": "ntfy", "url": "https://ntfy.sh/t", "email": "ari@example.com"}}
        self.cfg = cfg

        class R:
            status = 200
            def __enter__(s): return s
            def __exit__(s, *a): return False

        def op(req, timeout=10):
            self.reqs.append(req)
            if self.refuse and (req.get_header("Email") or (self.refuse[0] == 401 and req.get_header("Authorization"))):
                import io
                raise urllib.error.HTTPError(req.full_url, self.refuse[0], "Bad Request", {}, io.BytesIO(json.dumps({"code": self.refuse[1], "error": self.refuse[2]}).encode()))
            return R()
        self.op = op

    def tearDown(self):
        W.load_secret = self.saved

    def test_the_email_header_and_the_account_token(self):
        r = W.notify(self.cfg, "mini is stuck at FileVault", "body", opener=self.op, now=10 ** 12, ledger=[])
        self.assertEqual(r, "posted 200, emailed", "the address stays in the config, out of the log and ledger")
        self.assertEqual(self.reqs[0].get_header("Email"), "ari@example.com")
        self.assertEqual(self.reqs[0].get_header("Authorization"), "Bearer tk_fake")

    def test_no_email_without_the_option(self):
        cfg = {"notify": {"kind": "ntfy", "url": "https://ntfy.sh/t"}}
        self.assertEqual(W.notify(cfg, "s", "b", opener=self.op, now=1, ledger=[]), "posted 200")
        self.assertIsNone(self.reqs[0].get_header("Email"))
        self.assertIsNone(self.reqs[0].get_header("Authorization"), "the token rides only with an email")

    def test_one_address_only(self):
        cfg = {"notify": dict(self.cfg["notify"], email="a@example.com, b@example.com")}
        r = W.notify(cfg, "s", "b", opener=self.op, now=1, ledger=[])
        self.assertIn("no email", r)
        self.assertNotIn("@", r, "an address never reaches the log or ledger")
        self.assertIsNone(self.reqs[0].get_header("Email"))

    def test_the_daily_cap_counts_the_ledger(self):
        now = 10 ** 12
        ledger = [{"at": now - i * 3600000, "kind": "notify", "result": "posted 200, emailed ari@example.com"} for i in range(5)]
        r = W.notify(self.cfg, "s", "b", opener=self.op, now=now, ledger=ledger)
        self.assertEqual(r, "posted 200 (no email: today's 5 are used; a push only)")
        self.assertIsNone(self.reqs[0].get_header("Email"))
        self.assertIsNone(self.reqs[0].get_header("Authorization"))
        old = [dict(e, at=now - 25 * 3600000) for e in ledger]
        self.assertIn("emailed", W.notify(self.cfg, "s", "b", opener=self.op, now=now, ledger=old))
        cfg = {"notify": dict(self.cfg["notify"], email_per_day=1)}
        self.assertIn("today's 1 are used", W.notify(cfg, "s", "b", opener=self.op, now=now, ledger=ledger[:1]))

    def test_a_refused_email_still_sends_the_push(self):
        self.refuse = (400, 40053, "invalid request: anonymous email sending is not allowed")
        r = W.notify(self.cfg, "s", "b", opener=self.op, now=1, ledger=[])
        self.assertEqual(r, "posted 200 (ntfy wouldn't email: invalid request: anonymous email sending is not allowed; a push only)")
        self.assertEqual(len(self.reqs), 2)
        self.assertIsNone(self.reqs[1].get_header("Email"))
        self.assertIsNone(self.reqs[1].get_header("Authorization"))

    def test_a_revoked_token_never_costs_the_push(self):
        self.refuse = (401, 40101, "unauthorized")
        r = W.notify(self.cfg, "s", "b", opener=self.op, now=1, ledger=[])
        self.assertEqual(r, "posted 200 (ntfy wouldn't email: unauthorized; a push only)")
        self.assertIsNone(self.reqs[-1].get_header("Authorization"))

    def test_a_server_error_is_not_swallowed(self):
        self.refuse = (502, 0, "bad gateway")
        with self.assertRaises(urllib.error.HTTPError):
            W.notify(self.cfg, "s", "b", opener=self.op, now=1, ledger=[])

    def test_alert_test_emails_and_the_ledger_counts_it(self):
        W.save("state.json", {"mem": {"state": "healthy"}, "ledger": []})
        r = W.alert_test(self.cfg, None, None, lambda m: None, now=10 ** 12, opener=self.op)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.reqs[0].get_header("Email"), "ari@example.com")
        self.assertTrue(self.reqs[0].get_header("Title").startswith(b"TEST: "))
        self.assertEqual(W.emails_today(W.load("state.json", {})["ledger"], 10 ** 12 + 1), 1)

    def test_ntfy_is_a_secret_name(self):
        self.assertIn("ntfy", W.SECRET_NAMES)


class JsonAgeProbe(unittest.TestCase):
    """A health probe that reads a heartbeat the Mac keeps rewriting (a secret gist, say) and counts the Mac up while
    its timestamp is fresh. Unreachable is unknown, never down."""

    NOW = 1794212400000  # 2026-11-09T08:20:00Z

    def opener(self, doc=None, raise_=None):
        seen = []

        class R:
            def __init__(s, body):
                s.body = body
            def read(s, n=-1): return s.body
            def __enter__(s): return s
            def __exit__(s, *a): return False

        def op(req, timeout=5):
            seen.append(req)
            if raise_:
                raise raise_
            return R(json.dumps(doc).encode() if not isinstance(doc, bytes) else doc)
        op.seen = seen
        return op

    H = {"kind": "json_age", "url": "https://gist.example/raw/mac.json", "field": "at", "max_age_min": 3}

    def test_fresh_stale_and_ages(self):
        self.assertTrue(W.tcp_answers(self.H, opener=self.opener({"at": "2026-11-09T08:18:30.049Z"}), now=self.NOW))
        self.assertEqual(W.LAST_PROBE["age_min"], 1.5)
        self.assertFalse(W.tcp_answers(self.H, opener=self.opener({"at": "2026-11-09T08:10:57Z"}), now=self.NOW))
        self.assertEqual(W.LAST_PROBE["age_min"], 9.1)

    def test_unreachable_or_unreadable_is_unknown_not_down(self):
        import urllib.error as ue
        self.assertIsNone(W.tcp_answers(self.H, opener=self.opener(raise_=ue.URLError("no route")), now=self.NOW))
        self.assertIsNone(W.tcp_answers(self.H, opener=self.opener(b"<html>"), now=self.NOW))
        self.assertIsNone(W.tcp_answers(self.H, opener=self.opener({"other": 1}), now=self.NOW))
        self.assertNotIn("gist.example", json.dumps(W.LAST_PROBE), "the URL may be a secret: never in what the sitter reports")

    def test_nested_fields_epoch_numbers_and_offsets(self):
        h = dict(self.H, field="beat.at")
        self.assertTrue(W.tcp_answers(h, opener=self.opener({"beat": {"at": self.NOW // 1000 - 60}}), now=self.NOW))
        self.assertTrue(W.tcp_answers(h, opener=self.opener({"beat": {"at": self.NOW - 60000}}), now=self.NOW))
        self.assertTrue(W.tcp_answers(h, opener=self.opener({"beat": {"at": "2026-11-09T00:19:00-08:00"}}), now=self.NOW))
        self.assertIsNone(W.parse_when("2026-11-09T08:19:00"), "a time without a zone is refused, not guessed")
        self.assertIsNone(W.parse_when(True))

    def test_cache_buster_and_threshold(self):
        op = self.opener({"at": "2026-11-09T08:15:00Z"})
        self.assertTrue(W.tcp_answers(dict(self.H, bust_cache=True, max_age_min=12), opener=op, now=self.NOW))
        self.assertTrue(op.seen[0].full_url.endswith("?hs=%d" % (self.NOW // 1000)))
        self.assertFalse(W.tcp_answers(self.H, opener=self.opener({"at": "2026-11-09T08:15:00Z"}), now=self.NOW))

    def test_rules_a_stale_heartbeat_with_a_moving_clock_is_never_hung(self):
        obs = {"answers": False, "beat_min": None, "presence": None, "screen": "desktop", "clock_ticking": True, "video": True, "arp": True, "heartbeat_age_min": 9.1}
        self.assertEqual(W.raw_state(obs), "degraded")
        self.assertEqual(W.raw_state(dict(obs, answers=True)), "healthy")
        self.assertIn("its heartbeat is 9.1 min old", W.plain_signs(obs))


class Heartbeat(unittest.TestCase):
    def test_pings_and_fails(self):
        urls = []

        class R:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False
        op = lambda req, timeout=8: urls.append(req.full_url) or R()  # noqa: E731
        self.assertEqual(W.heartbeat({"heartbeat": {"url": "https://hc-ping.com/abc"}}, {"state": "healthy"}, opener=op), 200)
        W.heartbeat({"heartbeat": {"url": "https://hc-ping.com/abc"}}, {"state": "filevault"}, opener=op)
        self.assertEqual(urls, ["https://hc-ping.com/abc", "https://hc-ping.com/abc/fail"])
        self.assertIsNone(W.heartbeat({}, {"state": "healthy"}, opener=op))

    def test_forget_removes_the_files(self):
        W.HOME = scratch()
        W.store_secret("mac", "pw-1234", key=b"k" * 32)
        W.save("state.json", {})
        self.assertEqual(sorted(W.forget()["forgot"]), ["mac.cred", "state.json"])
        self.assertFalse(os.path.exists(os.path.join(W.HOME, "mac.cred")))


class Health(unittest.TestCase):
    def test_tcp_probe(self):
        class S:
            def close(self): pass
        self.assertTrue(W.tcp_answers({"host": "m", "port": 22}, connect=lambda a, timeout=3: S()))
        def refuse(a, timeout=3):
            raise OSError("refused")
        self.assertFalse(W.tcp_answers({"host": "m", "port": 22}, connect=refuse))
        self.assertIsNone(W.tcp_answers(None))


class Do(unittest.TestCase):
    def setUp(self):
        self.dir = scratch()
        W.HOME = self.dir

    def test_power_budget_and_no_plug(self):
        st, now = {}, 10**12
        cfg = {"name": "studio"}
        self.assertEqual(W.handle({"op": "power_cycle"}, cfg, None, None, print, now, st)["code"], "action-unavailable")

        class P:
            n = 0
            def cycle(self, s=10):
                P.n += 1
                return "ok"
        p = P()
        self.assertTrue(W.handle({"op": "power_cycle", "args": {"attended": True}}, cfg, None, p, print, now, st)["ok"])
        r = W.handle({"op": "power_cycle", "args": {"attended": True}}, cfg, None, p, print, now + 60000, st)
        self.assertEqual(r["code"], "action-failed")
        self.assertEqual(P.n, 1)

    def test_scroll_and_triple_click(self):
        class K:
            posts = []
            def post(self, p, body=None, timeout=60):
                K.posts.append(p)
            def get(self, p, timeout=15):
                return b'{"ok":true}'
            def json(self, p):
                return {"streamer": {"source": {"online": True}}} if p == "/streamer" else "Finder File Edit View Go Window Help 9:41"
        W.handle({"op": "scroll", "args": {"dy": -3}}, {}, K(), None, print, 0, {})
        self.assertEqual(K.posts[-1], "/hid/events/send_mouse_wheel?delta_x=0&delta_y=-3")
        K.posts = []
        W.handle({"op": "click", "args": {"x": 0, "y": 0, "count": 3}}, {}, K(), None, print, 0, {})
        self.assertEqual(len([p for p in K.posts if "state=true" in p]), 3)


class MutualWatch(unittest.TestCase):
    """The Mac's half of the mutual watch: `housesitter watch-kvm` asks `do watch_check` every minute over SSH."""

    def setUp(self):
        self.dir = scratch()
        W.HOME = self.dir

    def ask(self, args, now, via="ssh"):
        st = W.load("state.json", {"mem": None, "ledger": []})
        return W.handle({"op": "watch_check", "args": args}, {"name": "mini"}, None, None, print, now, st, via=via), st

    def test_records_who_watches_and_answers_with_the_status(self):
        W.save("status.json", {"at": 10**12 - 5000, "state": "healthy", "interval_sec": 60})
        r, _ = self.ask({"by": "aris-mac-mini", "sent": []}, 10**12)
        self.assertTrue(r["ok"])
        self.assertEqual(r["result"]["status"]["state"], "healthy")
        self.assertEqual(r["result"]["emails_today"], 0)
        self.assertEqual(W.load("state.json", {})["watcher"], {"by": "aris-mac-mini", "at": 10**12})

    def test_only_over_ssh(self):
        r, _ = self.ask({"by": "x"}, 10**12, via="outbox")
        self.assertEqual(r["code"], "action-unavailable")
        self.assertNotIn("watcher", W.load("state.json", {}))

    def test_the_macs_emails_join_the_ledger_once_and_count_against_the_cap(self):
        now = 10**12
        sent = [{"at": now - 120000, "title": "TEST: mini's KVM is silent", "emailed": True, "test": True}]
        r, _ = self.ask({"by": "m", "sent": sent}, now)
        self.assertEqual(r["result"]["emails_today"], 1)
        r, _ = self.ask({"by": "m", "sent": sent}, now + 60000)
        self.assertEqual(r["result"]["emails_today"], 1, "the same send handed over twice counts once")
        led = [e for e in W.load("state.json", {})["ledger"] if e.get("by") == "watcher"]
        self.assertEqual(len(led), 1)
        self.assertIn("(TEST)", led[0]["result"])
        self.assertEqual(W.emails_today(W.load("state.json", {})["ledger"], now), 1)

    def test_the_status_says_who_watches(self):
        self.ask({"by": "aris-mac-mini", "sent": []}, 10**12)
        st = W.load("state.json", {})
        self.assertEqual(st["watcher"]["by"], "aris-mac-mini")

    def test_a_watch_key_may_ask_only_watch_check_or_status(self):
        ok = W.watch_only("python3 /etc/kvmd/user/housesitter/sitter.py do watch_check '{\"by\": \"m\", \"sent\": []}'")
        self.assertEqual(ok[:2], ["do", "watch_check"])
        self.assertEqual(W.watch_only("HOUSESITTER_HOME='/x' python3 /etc/kvmd/user/housesitter/sitter.py do status"), ["do", "status"])
        for bad in ["id", "python3 /etc/kvmd/user/housesitter/sitter.py do unlock '{}'", "python3 sitter.py do status; id",
                    "python3 sitter.py do watch_check '{}' extra", "python3 sitter.py store-secret mac", "", "python3 sitter.py do 'unterminated"]:
            self.assertIsNone(W.watch_only(bad), bad)

    def test_alert_test_ignores_the_macs_test_sends(self):
        now = 10**12
        self.ask({"by": "m", "sent": [{"at": now - 1000, "title": "TEST: x", "emailed": False, "test": True}]}, now)
        st = W.load("state.json", {})
        last = [e for e in st["ledger"] if e.get("kind") == "notify" and e.get("test") and e.get("by") != "watcher"]
        self.assertEqual(last, [])


FAKE_WORKER = r"""
import json, struct, sys
mode = sys.argv[1]
if mode == "slow-start":
    import time; time.sleep(0.7)
print(json.dumps({"ready": True, "models": 2}), flush=True)
reads = sys.argv[2:]
k = 0
while True:
    h = sys.stdin.buffer.read(5)
    if len(h) < 5:
        break
    which, n = struct.unpack("<BI", h)
    sys.stdin.buffer.read(n)
    if which == 1:
        print(json.dumps({"text": "10:56", "ms": 0.95, "model": 1}), flush=True); continue
    if mode in ("hang", "slow-start"):
        import time; time.sleep(30)
    if mode == "error":
        print(json.dumps({"error": "the NPU job failed"}), flush=True); continue
    print(json.dumps({"text": reads[min(k, len(reads) - 1)], "ms": 1.07}), flush=True)
    k += 1
"""


def fake_npu(mode="ok", reads=("Mon Nov 9 8:05 AM",), timeout=2.0, lock_model=True):
    started = []

    def popen(args, **kw):
        started.append(args[3:])
        return subprocess.Popen([sys.executable, "-c", FAKE_WORKER, mode, *reads], **kw)
    npu = W.NpuClock(model="/fake/clock.rknn", lock_model="/fake/lock-clock.rknn", timeout=timeout, popen=popen,
                     exists=lambda p: lock_model or "lock-clock" not in p)
    npu.started = started
    return npu


def desktop_frame(w=640, h=360):
    """A luma plane that reads as a desktop: menu-bar edges at the top left."""
    y = bytearray(b"\x60" * (w * h))
    for row in range(2, 40, 2):
        for x in range(0, int(w * 0.4), 4):
            y[row * w + x] = 250
    return bytes(y), w, h


class NpuClockReading(unittest.TestCase):
    """The menu-bar clock, read on the KVM's NPU: it only ever feeds the frozen test; it never decides the screen or types."""

    def test_the_first_lock_screen_read_of_each_stretch_is_logged_with_the_kvms_time(self):
        st, logs = {}, []
        lock = {"screen": "login", "clock": {"text": "3:42", "on": "npu", "ms": 0.9, "where": "lock"}}
        W.note_lock_read(st, lock, 1794267720000, logs.append)
        W.note_lock_read(st, lock, 1794267780000, logs.append)
        self.assertEqual(len(logs), 1, "once a stretch, not every look")
        self.assertIn("the NPU read 3:42 in 0.9 ms at the login screen; the KVM's clock said 23:42:00 UTC", logs[0])
        W.note_lock_read(st, {"screen": "login", "clock": None}, 1794267840000, logs.append)
        W.note_lock_read(st, {"screen": "desktop", "clock": {"text": "3:44", "on": "npu"}}, 1794267900000, logs.append)
        self.assertIsNone(st["lock_read_at"])
        W.note_lock_read(st, dict(lock, screen="filevault"), 1794268000000, logs.append)
        self.assertEqual(len(logs), 2)
        self.assertIn("at the filevault screen", logs[1])

    def setUp(self):
        self.dir = scratch()
        W.HOME = self.dir
        self.saved = W.NPU

    def tearDown(self):
        if W.NPU.proc:
            W.NPU.proc.kill()
        W.NPU = self.saved

    def test_minutes_from_what_the_menu_bar_says(self):
        self.assertEqual(W.clock_minutes("Mon Nov 9 8:05 AM"), 485)
        self.assertEqual(W.clock_minutes("Sun Nov 8 5:59 PM"), 1079)
        self.assertEqual(W.clock_minutes("12:30 AM"), 30)
        self.assertEqual(W.clock_minutes("ue 15:43"), 943)
        self.assertEqual(W.clock_minutes("10:37:04 PM"), 1357)
        for bad in ("Sun Nov", "", None, "13:05 PM", "25:00", "8:61"):
            self.assertIsNone(W.clock_minutes(bad), bad)

    def test_ctc_decoding(self):
        import array
        classes, steps = len(W.CLOCK_CHARS) + 1, 12
        seq = [W.CLOCK_CHARS.index(c) + 1 for c in "8:05"]
        picks = [0, seq[0], seq[0], 0, seq[1], 0, seq[2], seq[3], seq[3], 0, 0, 0]
        a = array.array("f", [0.0] * (classes * steps))
        for t, k in enumerate(picks):
            a[k * steps + t] = 1.0
        self.assertEqual(W.clock_decode(a, classes, steps), "8:05")

    def test_the_input_is_the_menu_bars_right_end_only(self):
        w, h = 2560, 1440
        y = bytearray(w * h)
        x0, y1 = int(0.94 * w), int(0.0195 * h)
        for r in range(y1):
            y[r * w + x0:(r + 1) * w] = b"\xc8" * (w - x0)
        px = W.clock_input(bytes(y), w, h)
        self.assertEqual(len(px), 32 * 192)
        ow = round((w - x0) * 32 / (y1 - int(0)))
        self.assertTrue(all(b == 200 for b in px[:ow]), "the crop is all clock region")
        self.assertTrue(all(b == 0 for b in px[ow:192]), "padded with black")

    def test_a_worker_reads_and_a_frozen_clock_reads_as_stopped(self):
        W.NPU = fake_npu(reads=("Mon Nov 9 8:05 AM",))
        mem = {}
        y, w, h = desktop_frame()
        outs = [W.eyes_without_ocr({}, mem, (y, w, h), None) for _ in range(3)]
        self.assertEqual(outs[0]["clock"]["text"], "Mon Nov 9 8:05 AM")
        self.assertEqual(outs[0]["clock"]["on"], "npu")
        self.assertIs(outs[2]["clock_ticking"], False, "three reads of the same time: stopped")

    def test_a_moving_clock_reads_as_moving(self):
        W.NPU = fake_npu(reads=("8:05 AM", "8:06 AM", "8:07 AM"))
        mem = {}
        y, w, h = desktop_frame()
        outs = [W.eyes_without_ocr({}, mem, (y, w, h), None) for _ in range(3)]
        self.assertIs(outs[2]["clock_ticking"], True)

    def test_no_time_in_the_read_falls_back_to_the_fingerprint(self):
        W.NPU = fake_npu(reads=("",))
        y, w, h = desktop_frame()
        out = W.eyes_without_ocr({}, {}, (y, w, h), None)
        self.assertIsNone(out["clock"])
        mem = {}
        W.eyes_without_ocr({}, mem, (y, w, h), None)
        self.assertEqual(mem["clock_seen"][-1], W.clock_sig(y, w, h))

    def test_a_hung_worker_is_turned_off_for_an_hour(self):
        W.NPU = fake_npu(mode="hang", timeout=1.0)
        y, w, h = desktop_frame()
        out = W.eyes_without_ocr({}, {}, (y, w, h), None)
        self.assertIsNone(out["clock"])
        self.assertIn("didn't answer", W.NPU.why)
        self.assertFalse(W.NPU.available())
        self.assertIsNone(W.NPU.proc)

    def test_one_budget_covers_start_up_and_the_read(self):
        W.NPU = fake_npu(mode="slow-start", timeout=1.0)
        t = time.monotonic()
        self.assertIsNone(W.NPU.read(b"\x00" * 6144))
        self.assertLess(time.monotonic() - t, 1.6, "a slow start and a hung job share one timeout")
        self.assertIn("didn't answer", W.NPU.why)

    def test_the_worker_is_recycled_after_its_reads(self):
        W.NPU = fake_npu(reads=("8:05 AM",))
        W.NPU.RECYCLE_READS = 2
        self.assertEqual(W.NPU.read(b"\x00" * 6144), "8:05 AM")
        first = W.NPU.proc
        self.assertEqual(W.NPU.read(b"\x00" * 6144), "8:05 AM")
        self.assertIsNone(W.NPU.proc, "recycled after two reads")
        self.assertIsNotNone(first.poll(), "the old worker exited on end of input")
        self.assertEqual(W.NPU.read(b"\x00" * 6144), "8:05 AM", "and a fresh one starts on the next read")
        self.assertIsNone(W.NPU.why)

    def test_a_failed_job_is_turned_off_too(self):
        W.NPU = fake_npu(mode="error")
        self.assertIsNone(W.NPU.read(b"\x00" * 6144))
        self.assertEqual(W.NPU.why, "the NPU job failed")

    def test_config_can_turn_it_off(self):
        calls = []
        W.NPU = fake_npu()
        W.NPU.read = lambda px, now=None: calls.append(1)
        y, w, h = desktop_frame()
        W.eyes_without_ocr({"npu": False}, {}, (y, w, h), None)
        self.assertEqual(calls, [])

    def test_it_is_never_asked_about_anything_but_a_desktop(self):
        calls = []
        W.NPU = fake_npu()
        W.NPU.read = lambda px, now=None: calls.append(1)
        w, h = 640, 360
        dark = (b"\x30" * (w * h), w, h)
        out = W.eyes_without_ocr({}, {}, dark, None)
        self.assertEqual(calls, [], "a non-desktop frame never reaches the NPU")
        self.assertNotIn("clock", out)

    def test_the_lock_screen_clock_is_read_and_never_changes_the_state(self):
        W.NPU = fake_npu(reads=("Mon Nov 9 8:05 AM",))
        crops = []
        real = W.clock_input
        W.clock_input = lambda y, w, h, crop=W.CLOCK_CROP, size=W.CLOCK_IN: crops.append(crop) or real(y, w, h, crop, size)
        saved = W.prompt_seen
        try:
            W.prompt_seen = lambda f: (True, 1.0, None, "lock")
            w, h = 640, 360
            frame = (b"\x80" * (w * h), w, h)
            mem = {}
            outs = [W.eyes_without_ocr({}, mem, frame, None) for _ in range(3)]
        finally:
            W.clock_input, W.prompt_seen = real, saved
        self.assertEqual(crops, [W.LOCK_CROP] * 3, "the big clock's crop, not the menu bar's")
        self.assertEqual(outs[0]["screen"], "login")
        self.assertEqual(outs[0]["clock"], {"text": "10:56", "on": "npu", "ms": 0.95, "where": "lock"}, "read by the lock-screen model")
        self.assertEqual(W.NPU.started, [["/fake/clock.rknn", "/fake/lock-clock.rknn"]], "one worker holds both models")
        self.assertIs(outs[2]["lock_clock_ticking"], False, "three looks at the same time: stopped")
        self.assertNotIn("clock_ticking", outs[2], "its own key: the rules never see it, even if the lock watch then reaches the desktop")
        self.assertNotIn("clock_seen", mem, "and its own memory, apart from the menu bar's")
        for probe in ({"answers": None}, {"answers": False}):
            obs = dict(outs[2], beat_min=None, presence=None, video=True, arp=True, **probe)
            self.assertEqual(W.raw_state(dict(obs, screen="desktop")), W.raw_state({k: v for k, v in obs.items() if k not in ("clock", "lock_clock_ticking")} | {"screen": "desktop"}))
        self.assertIn("its lock-screen clock has stopped", W.plain_signs(outs[2]))

    def test_no_lock_model_means_no_lock_read_and_the_menu_bar_still_works(self):
        W.NPU = fake_npu(lock_model=False)
        self.assertIsNone(W.NPU.read(b"\x00" * 6144, lock=True))
        self.assertIsNone(W.NPU.why, "a missing lock model isn't a failure")
        self.assertEqual(W.NPU.read(b"\x00" * 6144), "Mon Nov 9 8:05 AM")
        self.assertEqual(W.NPU.started, [["/fake/clock.rknn"]])

    def test_signs_say_what_the_clock_reads(self):
        self.assertIn("its clock reads Mon Nov 9 8:05 AM", W.plain_signs({"clock": {"text": "Mon Nov 9 8:05 AM", "on": "npu"}}))


if __name__ == "__main__":
    unittest.main()


FRAMES = json.load(open(os.path.join(HERE, "fixtures", "comet-frames-20261108.json")))
# Luma grids (lum_grid) from real Comet frames of a Mac's lock screen, with a moving aerial wallpaper behind it.
LUM = {k: dict(v, _lum=base64.b64decode(v["_lum"])) for k, v in json.load(open(os.path.join(HERE, "fixtures", "comet-lum-20261109.json"))).items() if not k.startswith("_")}
FV = {k: dict(v, _lum=base64.b64decode(v["_lum"])) for k, v in json.load(open(os.path.join(HERE, "fixtures", "comet-filevault-20261109.json"))).items() if not k.startswith("_")}


class BootWatch(unittest.TestCase):
    """The boot watch only decides when to look closely. It asks to type only where the password field is visible on
    the KVM's own picture; a settled screen without it is "blind": reported, never typed into. The frames are features
    of real frames from a GL-RM1PE (V1.7.1) on a Mac mini, 2026-11-08."""

    def run_boot(self, frames, visible, kvm_up=1200):
        now, usb = 1_000_000, 16.8
        bw, act, note = W.boot_tick(None, now, {"usb": usb, "mode": (2560, 1440), "frame": None}, W.BOOT, kvm_up)
        self.assertIsNone(bw.get("boot_at"), "a running KVM does not count its own boot enumeration as the Mac's")
        now += 2000
        bw, act, note = W.boot_tick(bw, now, {"usb": usb + 900, "mode": None, "frame": None}, W.BOOT, kvm_up)
        self.assertTrue(bw.get("pending"), "a boot is pending until a desktop shows")
        log = []
        for f in frames:
            now += 3000
            bw, act, note = W.boot_tick(bw, now, {"usb": usb + 900, "mode": (2560, 1440), "frame": f, "prompt_visible": visible, "prompt_kind": "boot" if visible else None}, W.BOOT, kvm_up)
            log.append((act, note))
        return bw, log

    def test_real_frames_classify(self):
        self.assertEqual(W.classify_frame(FRAMES["desktop-2560"]), "desktop")
        for k in ("lock-1080", "lock-2560-after-edid-restore", "lock-2560-after-unlock-attempt", "lock-2560-later"):
            self.assertEqual(W.classify_frame(FRAMES[k]), "prompt_like", k)
        self.assertLess(W.thumb_diff(FRAMES["lock-2560-after-edid-restore"]["thumb"], FRAMES["lock-2560-later"]["thumb"]), W.BOOT["same_diff"])
        self.assertGreater(W.thumb_diff(FRAMES["desktop-2560"]["thumb"], FRAMES["lock-2560-later"]["thumb"]), W.BOOT["same_diff"])

    def test_a_boot_and_no_menu_bar_never_types_without_the_field(self):
        bw, log = self.run_boot([FRAMES["lock-2560-later"]] * 30, visible=False)
        acts = [a for a, _ in log]
        self.assertNotIn("type", acts)
        self.assertEqual(acts.count("blind"), 1, "blind is reported once a boot, never typed into")
        self.assertIn("blind unlock is unsupported", bw["stuck"])

    def test_the_visible_field_after_a_settled_boot_asks_to_type(self):
        bw, log = self.run_boot([FRAMES["lock-2560-later"]] * 12, visible=True)
        acts = [a for a, _ in log]
        first = acts.index("type")
        self.assertGreaterEqual((first + 1) * 3, W.BOOT["settle_sec"], "waits for the boot to settle")

    def test_the_desktop_ends_the_boot(self):
        bw, log = self.run_boot([FRAMES["lock-2560-later"]] * 3 + [FRAMES["desktop-2560"]], visible=True)
        self.assertEqual(log[-1][0], "desktop")
        self.assertIsNone(bw.get("pending"))

    def test_no_boot_no_typing(self):
        bw = None
        for k in range(30):
            bw, act, _ = W.boot_tick(bw, 1_000_000 + k * 3000, {"usb": 16.8, "mode": (2560, 1440), "frame": FRAMES["lock-2560-later"], "prompt_visible": True}, W.BOOT, 1200)
            self.assertNotEqual(act, "type")

    def test_hdmi_back_alone_is_not_a_boot(self):
        bw, _, _ = W.boot_tick(None, 0, {"usb": 16.8, "mode": (2560, 1440), "frame": None}, W.BOOT, 1200)
        bw, _, _ = W.boot_tick(bw, 2000, {"usb": 16.8, "mode": None, "frame": None}, W.BOOT, 1200)
        bw, act, note = W.boot_tick(bw, 9000, {"usb": 16.8, "mode": (2560, 1440), "frame": None}, W.BOOT, 1200)
        self.assertIn("not a boot", note)
        self.assertIsNone(bw.get("boot_at"))
        for k in range(30):
            bw, act, _ = W.boot_tick(bw, 12000 + k * 3000, {"usb": 16.8, "mode": (2560, 1440), "frame": FRAMES["lock-2560-later"], "prompt_visible": True}, W.BOOT, 1200)
            self.assertNotEqual(act, "type")

    def test_a_kvm_that_just_started_proves_nothing_by_itself(self):
        bw, _, note = W.boot_tick(None, 5000, {"usb": 16.8, "mode": (2560, 1440), "frame": None}, W.BOOT, 40)
        self.assertIsNone(bw.get("boot_at"), note)
        # Its HDMI receiver often hasn't locked yet: that dark proves nothing either.
        bw, _, _ = W.boot_tick(None, 5000, {"usb": 16.8, "mode": None, "frame": None}, W.BOOT, 40)
        bw, _, _ = W.boot_tick(bw, 8000, {"usb": 16.8, "mode": (2560, 1440), "frame": None}, W.BOOT, 43)
        self.assertIsNone(bw.get("boot_at"))

    def test_usb_and_hdmi_readers(self):
        d = "[   16.786538] dwc3 21500000.usb: device reset\n[   16.856062] android_work: sent uevent USB_STATE=CONFIGURED\n[ 2001.5] lt6911c x\n[ 2050.25] dwc3 21500000.usb: device reset\n"
        self.assertEqual(W.usb_last_enum(dmesg=d), 2050.25)
        files = {"/proc/gl-hw-info/hdmipatch": "1-002b\n", "/sys/bus/i2c/devices/1-002b/resolution": "2560x1440@60\n"}
        self.assertEqual(W.hdmi_mode(read=lambda p: files[p]), (2560, 1440))
        files["/sys/bus/i2c/devices/1-002b/resolution"] = "no signal\n"
        self.assertIsNone(W.hdmi_mode(read=lambda p: files[p]))

        def missing(p):
            raise OSError(p)

        class K:
            def json(self, p):
                return {"streamer": {"source": {"online": True, "resolution": {"width": 1920, "height": 1080}}}}
        self.assertEqual(W.hdmi_mode(read=missing, kvmd=K()), (1920, 1080), "a PiKVM without GL.iNet's receiver files asks kvmd")

    def test_frame_features_see_menu_bar_text(self):
        w, h = 320, 180
        smooth = bytes([90]) * (w * h)
        text = bytearray(smooth)
        for row in range(4, 20):
            for x in range(0, w, 4):
                text[row * w + x] = 230
        self.assertEqual(W.classify_frame(W.frame_features(smooth, w, h)), "prompt_like")
        self.assertEqual(W.classify_frame(W.frame_features(bytes(text), w, h)), "desktop")
        self.assertEqual(W.classify_frame(W.frame_features(bytes([3]) * (w * h), w, h)), "black")


class EyesWithoutOcr(unittest.TestCase):
    """What the rules see when kvmd can't OCR: they must never power-cycle a Mac that is only waiting at FileVault,
    and never one whose desktop clock still ticks."""

    w, h = 320, 180

    def desktop(self, minute):
        y = bytearray(bytes([90]) * (self.w * self.h))
        for row in range(4, 20):
            for x in range(0, self.w, 4):
                y[row * self.w + x] = 230
        y[2 * self.w + self.w - 10 - minute] = 7  # the clock's pixels move each minute
        return bytes(y), self.w, self.h

    def lock(self):
        return bytes([90]) * (self.w * self.h), self.w, self.h

    def test_after_a_boot_the_steady_prompt_is_filevault_and_the_rules_dont_type(self):
        o = W.eyes_without_ocr({"name": "studio"}, {}, self.lock(), {"pending": int(time.time() * 1000)})
        self.assertEqual(o["screen"], "filevault")
        self.assertEqual(W.raw_state(dict(o, answers=False, video=True)), "filevault")

    def test_stuck_at_the_prompt_says_why_in_the_message_signs(self):
        o = W.eyes_without_ocr({"name": "studio"}, {}, self.lock(), {"pending": int(time.time() * 1000), "stuck": "the password didn't take, 2 tries this boot. Fix: housesitter secret <mac> mac-password"})
        self.assertIn("housesitter secret studio mac-password", o["boot"])

    def test_no_boot_and_no_menu_bar_while_not_answering_is_a_hang(self):
        o = W.eyes_without_ocr({}, {}, self.lock(), {})
        self.assertEqual(o["screen"], "unknown")
        self.assertEqual(W.raw_state(dict(o, answers=False, video=True)), "hung")

    def test_a_ticking_desktop_clock_overrules_a_lost_network(self):
        mem = {}
        for minute in range(3):
            o = W.eyes_without_ocr({}, mem, self.desktop(minute), {})
        self.assertEqual(o["screen"], "desktop")
        self.assertTrue(o["clock_ticking"])
        self.assertEqual(W.raw_state(dict(o, answers=False, video=True)), "degraded", "never power-cycle a working Mac")

    def test_a_frozen_desktop_clock_is_a_hang(self):
        mem = {}
        for _ in range(3):
            o = W.eyes_without_ocr({}, mem, self.desktop(0), {})
        self.assertFalse(o["clock_ticking"])
        self.assertEqual(W.raw_state(dict(o, answers=False, video=True)), "hung")

    def test_once_with_frame_eyes_leaves_typing_to_the_boot_watch(self):
        d = scratch()
        old = W.HOME
        W.HOME = d
        try:
            W.save("state.json", {"mem": None, "ledger": [], "boot": {"pending": int(time.time() * 1000)}})

            class K:
                calls = []
                def json(self, p):
                    if "ocr" in p:
                        raise RuntimeError("HTTP 500")
                    return {"streamer": {"source": {"online": True, "resolution": {"width": 320, "height": 180}}}}
                def post(self, p, **kw):
                    self.calls.append(p)
                def get(self, p, **kw):
                    self.calls.append(p)
                    return b""
            orig_raw, orig_arp = W.frame_raw, W.arp_alive
            W.frame_raw = lambda kvmd, run=None: self.lock()
            W.arp_alive = lambda ips, macs: None
            try:
                k = K()
                cfg = {"name": "studio", "rules": {"filevault_wait_min": 0, "settle_min": 0}}
                for t in range(3):
                    st = W.once(cfg, k, None, lambda m: None, now=t * 60000)
            finally:
                W.frame_raw, W.arp_alive = orig_raw, orig_arp
            self.assertEqual(st["state"], "filevault")
            self.assertEqual(st["obs"]["eyes"], "frame")
            self.assertFalse(st["can"]["unlock"])
            self.assertFalse(any("hid/print" in c for c in k.calls), "the rules never type without OCR")
        finally:
            W.HOME = old


class OcrlessKvmd:
    """A real Comet at 2K: OCR answers 500, so every look is a frame decoded on the KVM (stubbed below)."""

    def __init__(self):
        self.posts, self.gets = [], []

    def json(self, path):
        if "snapshot" in path:
            raise RuntimeError("kvmd GET /streamer/snapshot -> HTTP 500")
        return {"streamer": {"source": {"online": True, "resolution": {"width": 2560, "height": 1440}}}}

    def get(self, path, timeout=15):
        self.gets.append(path)
        return b'{"ok":true}'

    def post(self, path, body=None, timeout=60):
        self.posts.append((path, body))
        return b'{"ok":true}'

    def typed(self):
        return [b for p, b in self.posts if p.startswith("/hid/print")]


class Safety(unittest.TestCase):
    """The independent safety review, 2026-11-08: no blind typing, a password gate, a guarded power cycle, write-ahead
    entries, limits that survive a KVM reboot, no reshaping, and a hardened KVM."""

    def setUp(self):
        self.dir = scratch()
        W.HOME = self.dir
        self.saved = (W.usb_last_enum, W.hdmi_mode, W.frame_raw, W.frame_features, W.kvm_uptime_s, W.load_secret, W.arp_alive, W.tcp_answers)
        self.usb, self.frame, self.logs = 16.8, LUM["lock-later"], []
        W.usb_last_enum = lambda run=None: self.usb
        W.hdmi_mode = lambda read=None, kvmd=None: (2560, 1440)
        W.frame_raw = lambda kvmd, run=None: (b"", 2560, 1440)
        W.frame_features = lambda y, w, h: self.frame
        W.kvm_uptime_s = lambda read=None: 5000.0
        W.load_secret = lambda name, key=None: "pw-from-keychain" if name == "mac" else None
        self.kvmd = OcrlessKvmd()

    def tearDown(self):
        (W.usb_last_enum, W.hdmi_mode, W.frame_raw, W.frame_features, W.kvm_uptime_s, W.load_secret, W.arp_alive, W.tcp_answers) = self.saved

    def teach(self):
        # Taught during a boot: the kind the sitter may type at by itself.
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "an operator saw the FileVault field on the KVM's picture", kind="boot")

    def boot(self, cfg=None, start=1_000_000, ticks=20):
        cfg = cfg or {"name": "studio"}
        W.boot_watch(cfg, self.kvmd, self.logs.append, now=start)
        # A restart: HDMI goes dark, then the Mac enumerates the KVM's keyboard again.
        mode, W.hdmi_mode = W.hdmi_mode, lambda read=None, kvmd=None: None
        W.boot_watch(cfg, self.kvmd, self.logs.append, now=start + 1000)
        W.hdmi_mode = mode
        self.usb += 900
        t = start
        for k in range(1, ticks):
            t = start + k * 3000
            W.boot_watch(cfg, self.kvmd, self.logs.append, now=t)
        return t

    # 1. blind typing
    def test_blind_multi_display_is_refused_and_reported_even_when_verified(self):
        W.set_password_trust("verified", "test")
        self.boot()  # no taught prompt: the field is not on the KVM's picture
        self.assertEqual(self.kvmd.typed(), [])
        st = W.load("state.json", {})
        self.assertIn("blind unlock is unsupported", st["boot"]["stuck"])
        self.assertTrue(any("blind unlock is unsupported" in l for l in self.logs))

    def test_an_inbox_unlock_refuses_without_a_visible_field(self):
        W.set_password_trust("verified", "test")
        r = W.handle({"op": "unlock"}, {"name": "studio"}, self.kvmd, None, self.logs.append, 10**6, {"ledger": []})
        self.assertFalse(r["ok"])
        self.assertIn("no password prompt it was taught", r["result"])
        self.assertEqual(self.kvmd.typed(), [])

    def test_learn_prompt_takes_only_a_prompt_like_frame(self):
        with self.assertRaises(ValueError):
            W.learn_prompt([LUM["lock-a"], LUM["desktop"]], "x")
        self.assertFalse(W.prompt_visible(LUM["lock-later"]))
        self.teach()
        self.assertTrue(W.prompt_visible(LUM["lock-later"]))
        self.assertFalse(W.prompt_visible(LUM["desktop"]))
        self.assertFalse(W.prompt_visible(LUM["third-display-lock"]))

    # 2. the password gate
    def test_unverified_by_default_never_types_even_at_a_visible_field(self):
        self.teach()
        self.assertEqual(W.password_gate()["trust"], "unverified")
        self.boot()
        self.assertEqual(self.kvmd.typed(), [])
        self.assertIn("unverified", W.load("state.json", {})["boot"]["stuck"])

    def test_one_armed_trial_types_once_then_the_desktop_verifies_it(self):
        self.teach()
        W.set_password_trust("trial", "armed")
        t = self.boot(ticks=12)
        self.assertEqual(self.kvmd.typed(), [b"pw-from-keychain"])
        self.assertEqual(W.password_gate()["trust"], "trial")
        self.frame = LUM["desktop"]
        W.boot_watch({"name": "studio"}, self.kvmd, self.logs.append, now=t + 3000)
        self.assertEqual(W.password_gate()["trust"], "verified")

    def test_a_trial_that_never_reaches_the_desktop_goes_back_to_unverified_and_types_no_more(self):
        self.teach()
        W.set_password_trust("trial", "armed")
        self.boot(ticks=80)
        self.assertEqual(len(self.kvmd.typed()), 1, "one try on trial")
        self.assertEqual(W.password_gate()["trust"], "unverified")

    def test_a_desktop_without_our_try_never_verifies(self):
        self.teach()
        W.set_password_trust("trial", "armed")
        self.frame = LUM["desktop"]
        self.boot(ticks=5)
        self.assertEqual(self.kvmd.typed(), [])
        self.assertEqual(W.password_gate()["trust"], "trial")
        W.set_password_trust("unverified", "test")
        self.boot(ticks=5)
        self.assertEqual(W.password_gate()["trust"], "unverified")

    def test_a_new_password_resets_the_gate(self):
        W.set_password_trust("verified", "test")
        old = W.load_secret
        W.load_secret = self.saved[5]
        orig_stdin, orig_store = sys.stdin, W.store_secret
        try:
            import io
            sys.stdin = io.StringIO("new-password\n")
            W.store_secret = (lambda f: (lambda name, value, key=None: f(name, value, key=b"k" * 32)))(W.store_secret)
            self.assertEqual(W.main(["store-secret", "mac"]), 0)
        finally:
            sys.stdin, W.store_secret = orig_stdin, orig_store
            W.load_secret = old
        self.assertEqual(W.password_gate()["trust"], "unverified")

    def test_trial_is_only_armed_by_an_operator_command_never_from_the_inbox(self):
        self.assertNotIn("password_trial", W.OPS)
        r = W.handle({"op": "password_trial"}, {"name": "studio"}, self.kvmd, None, print, 0, {"ledger": []})
        self.assertEqual(r["code"], "action-unavailable")

    # limits survive a KVM reboot; write-ahead entries count
    def test_per_boot_and_hourly_limits_survive_a_kvm_reboot(self):
        self.teach()
        W.set_password_trust("verified", "test")
        self.boot(ticks=60)
        self.assertEqual(len(self.kvmd.typed()), W.BOOT["per_boot"])
        # The KVM reboots: its boot-watch memory comes back with it, but say it lost everything except the ledger.
        st = W.load("state.json", {})
        st.pop("boot", None)
        W.save("state.json", st)
        W.kvm_uptime_s = lambda read=None: 30.0
        self.boot(start=1_400_000, ticks=40)
        self.assertEqual(len(self.kvmd.typed()), W.BOOT["per_boot"], "no fresh tries after the KVM's own reboot")

    def test_a_started_entry_left_by_a_crash_counts(self):
        st = {"ledger": []}
        W.write_ahead(st, {"at": 1000, "kind": "unlock"})
        W.write_ahead(st, {"at": 50000, "kind": "unlock"})
        disk = W.load("state.json", {})
        self.assertEqual([e["result"] for e in disk["ledger"]], ["started", "started"])
        self.assertIn("tries since the Mac was last at its desktop", W.typing_budget(disk, 200000))
        W.write_ahead(st, {"at": 60000, "kind": "power_cycle"})
        self.assertEqual(len(W._recent(W.load("state.json", {})["ledger"], "power_cycle", 70000, 30)), 1)

    def test_a_request_is_written_ahead_before_the_plug_moves(self):
        seen = []

        class P:
            def cycle(self, s=10):
                seen.append([e["result"] for e in W.load("state.json", {}).get("ledger", []) if e["kind"] == "power_cycle"])
                return "ok"
        r = W.handle({"op": "power_cycle", "args": {"attended": True}}, {"name": "studio"}, self.kvmd, P(), print, 10**6, {"ledger": []})
        self.assertTrue(r["ok"])
        self.assertEqual(seen, [["started"]])
        self.assertEqual([e["result"] for e in W.load("state.json", {})["ledger"]], ["plug: ok"])

    def test_merge_never_loses_another_writer_s_entry(self):
        W.save("state.json", {"ledger": [{"id": "a", "at": 1, "kind": "unlock", "result": "started"}]})
        mine = {"ledger": [{"id": "a", "at": 1, "kind": "unlock", "result": "typed"}, {"id": "b", "at": 2, "kind": "notify", "result": "x"}]}
        W.save_state(mine)
        self.assertEqual([(e["id"], e["result"]) for e in W.load("state.json", {})["ledger"]], [("a", "typed"), ("b", "x")])

    # 3. the power-cycle guard
    def guard(self, frames, answers=False, arp=False, cfg=None, now=10**9):
        it = iter(frames)
        W.frame_features = lambda y, w, h: next(it)
        W.tcp_answers = lambda health, connect=None: answers
        W.arp_alive = lambda ips, macs, **k: arp
        return W.cycle_guard(cfg or {"name": "studio", "mac_ips": ["10.0.0.5"]}, self.kvmd, now)

    def frozen(self):
        y = bytearray(bytes([90]) * (320 * 180))
        for row in range(4, 20):
            for x in range(0, 320, 4):
                y[row * 320 + x] = 230
        return bytes(y)

    def test_guard_allows_only_a_frozen_desktop_with_failing_probes(self):
        y = self.frozen()
        W.frame_raw = lambda kvmd, run=None: (y, 320, 180)
        real = self.saved[3]
        W.frame_features = real
        W.tcp_answers = lambda health, connect=None: False
        W.arp_alive = lambda ips, macs, **k: False
        self.assertIsNone(W.cycle_guard({"name": "studio", "mac_ips": ["10.0.0.5"]}, self.kvmd, 10**9))

    def test_guard_refuses_boot_filevault_login_black_unknown_and_live_clocks(self):
        for f in (FRAMES["lock-2560-later"], {"mean": 3, "top_edges": 0, "thumb": [3] * 576, "size": [2560, 1440]}):
            self.assertIn("only a frozen desktop", self.guard([f] * 3))
        W.save("state.json", {"boot": {"pending": 1}})
        self.assertEqual(self.guard([FRAMES["desktop-2560"]] * 3), "the Mac is booting")
        W.save("state.json", {})
        ticks = iter([(bytes([1]) * 10, 320, 180), (bytes([2]) * 10, 320, 180), (bytes([3]) * 10, 320, 180)])
        W.frame_raw = lambda kvmd, run=None: next(ticks)
        W.clock_sig = (lambda f: (lambda y, w, h: y[:1].hex()))(W.clock_sig)
        try:
            self.assertIn("still moving", self.guard([FRAMES["desktop-2560"]] * 3))
        finally:
            W.clock_sig = self.__class__.real_clock_sig

    def test_guard_refuses_when_the_mac_still_answers_or_nothing_can_tell(self):
        y = self.frozen()
        W.frame_raw = lambda kvmd, run=None: (y, 320, 180)
        self.assertEqual(self.guard([FRAMES["desktop-2560"]] * 3, answers=True), "it still answers on the network")
        self.assertIn("nothing confirms the hang", self.guard([FRAMES["desktop-2560"]] * 3, answers=None, arp=None))

    def test_the_rules_never_cut_power_on_a_screen_that_isnt_a_frozen_desktop(self):
        plug = FakePlug(on=True, watts=14)
        W.arp_alive = lambda ips, macs, **k: False
        W.tcp_answers = lambda health, connect=None: False
        cfg = {"name": "studio", "mac_ips": ["10.0.0.5"], "notify": {"kind": "webhook", "url": "https://example.invalid/h"}}
        sent = []
        orig = W.notify
        W.notify = lambda cfg, s, b, opener=None: sent.append((s, b)) or "posted 200"
        try:
            for t in range(0, 12):
                W.once(cfg, self.kvmd, plug, self.logs.append, now=10**9 + t * 60000)
        finally:
            W.notify = orig
        self.assertEqual(plug.calls, [])
        self.assertTrue(any("won't power cycle" in b for _, b in sent), sent)

    def test_attended_is_an_explicit_override_but_budgets_still_hold(self):
        class P:
            n = 0
            def cycle(self, s=10):
                P.n += 1
                return "ok"
        st = {"ledger": []}
        self.assertFalse(W.handle({"op": "power_cycle"}, {"name": "studio"}, self.kvmd, P(), print, 10**9, st)["ok"])
        self.assertTrue(W.handle({"op": "power_cycle", "args": {"attended": True}}, {"name": "studio"}, self.kvmd, P(), print, 10**9, st)["ok"])
        self.assertFalse(W.handle({"op": "power_cycle", "args": {"attended": True}}, {"name": "studio"}, self.kvmd, P(), print, 10**9 + 60000, st)["ok"])
        self.assertEqual(P.n, 1)

    # 4. no reshaping, below every call
    def test_refuse_reshape_at_the_lowest_level(self):
        for method, path in (("POST", "/upgrade/edid"), ("POST", "/api/upgrade/edid?x=1"), ("GET", "/upgrade/reset_default"), ("POST", "/system/factory_reset"), ("POST", "/upgrade/firmware")):
            self.assertIsNotNone(W.refuse_reshape(method, path), path)
            with self.assertRaises(RuntimeError):
                W.Kvmd("/nonexistent.sock").request(method, path)
        self.assertIsNone(W.refuse_reshape("GET", "/upgrade/edid"))
        self.assertIsNone(W.refuse_reshape("POST", "/hid/events/send_key?key=ShiftLeft"))

    # 5. harden
    def test_harden_fails_unless_the_cloud_reads_back_disabled(self):
        class K:
            def __init__(self, status):
                self.status = status
            def get(self, p, timeout=15):
                return b"{}"
            def json(self, p):
                if isinstance(self.status, Exception):
                    raise self.status
                return self.status
        self.assertEqual(W.harden(K({"enabled": False}), {}, run=FakeTables(), gl=True)["gl_cloud"], "off (read back)")
        for bad in ({"enabled": True}, {}, RuntimeError("HTTP 500")):
            with self.assertRaises(Exception):
                W.harden(K(bad), {}, run=FakeTables(), gl=True)

    def test_ingress_is_lan_at_home_and_tailnet_only_elsewhere(self):
        self.assertEqual(W.ingress_mode({}), "lan")
        self.assertEqual(W.ingress_mode({"location": "home"}), "lan")
        self.assertEqual(W.ingress_mode({"location": "office"}), "tailnet")
        home = W.ingress_rules("lan")
        for t, nets in (("iptables", W.PRIVATE_V4), ("ip6tables", W.PRIVATE_V6)):
            for net in nets:
                self.assertIn([t, "-A", W.CHAIN, "-s", net, "-j", "RETURN"], home)
            for p in ("22", "80", "443"):
                self.assertIn([t, "-A", W.CHAIN, "-p", "tcp", "--dport", p, "-j", "DROP"], home, "#27: home drops what isn't private too")
        self.assertFalse(any("-s" in c for c in W.ingress_rules("tailnet")), "away: no address gets in, only tailscale0")
        away = W.ingress_rules("tailnet")
        for t in ("iptables", "ip6tables"):
            self.assertIn([t, "-A", W.CHAIN, "-i", "tailscale0", "-j", "RETURN"], away)
            for p in ("22", "80", "443"):
                self.assertIn([t, "-A", W.CHAIN, "-p", "tcp", "--dport", p, "-j", "DROP"], away)
        with self.assertRaises(RuntimeError):
            W.apply_ingress("tailnet", run=lambda c, **k: None, iface_up=lambda i: False)

    def test_ingress_is_read_back_and_fails_closed(self):
        t = FakeTables()
        self.assertIn("home: the LAN's private addresses and the tailnet, read back", W.apply_ingress("lan", run=t))
        rules = t.chains["iptables"][W.CHAIN]
        self.assertEqual(rules[-1][-1], "DROP")
        self.assertEqual(t.chains["iptables"]["INPUT"], [["-j", W.CHAIN]])
        W.apply_ingress("lan", run=t)
        self.assertEqual(t.chains["iptables"]["INPUT"], [["-j", W.CHAIN]], "applying twice jumps once")
        for broken in (FakeTables(drop_rule=["-s", "192.168.0.0/16"]), FakeTables(drop_rule=["--dport", "443"]), FakeTables(lose_input=True)):
            with self.assertRaises(RuntimeError) as e:
                W.apply_ingress("lan", run=broken)
            self.assertIn("refusing to call it done", str(e.exception))
        self.assertIsNone(W.ingress_readback("iptables", "lan", run=t))
        # The Comet's kernel, as found on hardware: no conntrack match. Both modes still apply, and say so.
        for mode in ("lan", "tailnet"):
            gl = FakeTables(conntrack=False)
            out = W.apply_ingress(mode, run=gl, iface_up=lambda i: True, joined=True)
            self.assertIn("no connection tracking", out)
            self.assertEqual(gl.chains["iptables"][W.CHAIN][-1][-1], "DROP")
        self.assertIsNotNone(W.ingress_readback("iptables", "tailnet", run=FakeTables()), "an empty chain never passes")

    def test_ingress_that_drifts_after_it_was_read_back_is_noticed(self):
        t = FakeTables()
        W.apply_ingress("lan", run=t)
        self.assertIsNone(W.ingress_drift("lan", run=t))
        self.assertIsNotNone(W.ingress_drift("tailnet", run=t), "home rules aren't away rules")
        t.chains["iptables"][W.CHAIN] = [r for r in t.chains["iptables"][W.CHAIN] if "80" not in r]
        self.assertIn("doesn't read back", W.ingress_drift("lan", run=t))
        t = FakeTables()
        W.apply_ingress("lan", run=t)
        t.chains["iptables"]["INPUT"] = []
        self.assertIn("INPUT doesn't jump", W.ingress_drift("lan", run=t))
        # The Comet: no ip6tables, so IPv6 must stay off on every interface but lo and tailscale0, new ones included.
        gl = FakeTables(v6=False)
        W.apply_ingress("tailnet", run=gl, iface_up=lambda i: True, joined=True, v6=True, v6_off=lambda: (True, {"eth0": True}))
        off = {"eth0": "1", "lo": "0", "tailscale0": "0", "all": "0"}
        read = lambda p: off[p.split("/")[-2]]  # noqa: E731
        self.assertIsNone(W.ingress_drift("tailnet", run=gl, v6=True, read=read, ifaces=list(off)))
        off["usb0"] = "0"
        self.assertIn("usb0", W.ingress_drift("tailnet", run=gl, v6=True, read=read, ifaces=list(off)))

    def test_weakened_rules_never_read_back_as_ours(self):
        """Morgan, on the 0.3.2 draft: rules that only contain the right words passed the readback."""
        weakenings = [
            lambda c: c.__setitem__(0, ["!", "-i", "lo", "-j", "RETURN"]),
            lambda c: [r.__setitem__(slice(0, 0), ["-i", "wg0"]) for r in c if r[-1] == "DROP"],
            lambda c: c.__setitem__(len(c) - 3, ["-p", "tcp", "-m", "tcp", "!", "--dport", "22", "-j", "DROP"]),
        ]
        for weaken in weakenings:
            t = FakeTables(conntrack=False)
            W.apply_ingress("lan", run=t)
            weaken(t.chains["iptables"][W.CHAIN])
            self.assertIsNotNone(W.ingress_readback("iptables", "lan", run=t, track=False), t.chains["iptables"][W.CHAIN])
            self.assertIsNotNone(W.ingress_drift("lan", run=t))
        t = FakeTables(conntrack=False)
        W.apply_ingress("lan", run=t)
        t.chains["iptables"]["INPUT"].insert(0, ["-p", "tcp", "--dport", "22", "-j", "ACCEPT"])
        self.assertIn("before jumping", W.ingress_drift("lan", run=t))
        W.apply_ingress("lan", run=t)
        self.assertEqual(t.chains["iptables"]["INPUT"][0], ["-j", W.CHAIN], "applying again puts the jump first")
        t.chains["iptables"]["INPUT"].append(["-j", W.CHAIN])
        self.assertIn("2 times", W.ingress_drift("lan", run=t))

    def test_the_sitter_rechecks_puts_back_and_tells_you_once_when_it_cant(self):
        told, kept, logs = [], [], []
        cfg = {"name": "mini"}
        step = lambda ing, now, apply, drift=lambda m: None: W.ingress_step(cfg, ing, now, logs.append, apply=apply, drift=drift, tell=lambda s, b: told.append(s) or "posted", keep=kept.append)  # noqa: E731
        ing = step({}, 0, lambda m: "home, read back")
        self.assertTrue(ing["ok"])
        self.assertEqual(kept[-1]["detail"], "home, read back")
        self.assertEqual(ing["next"], W.INGRESS_RECHECK_SEC)
        ing = step(ing, 300000, lambda m: self.fail("no drift, so nothing to apply"))
        self.assertEqual(ing["checked_at"], 300000)
        ing = step(ing, 600000, lambda m: "home, read back", drift=lambda m: "INPUT doesn't jump to HOUSESITTER_IN")
        self.assertTrue(ing["ok"])
        self.assertTrue(any("drifted" in x for x in logs))

        def broken(m):
            raise RuntimeError("iptables-restore refused it (x); the rules from before are still in force")
        for minute in range(7):
            ing = step(ing if minute else {}, 1000000 + minute * 60000, broken)
        self.assertFalse(ing["ok"])
        self.assertEqual(told, ["mini's KVM isn't filtering who reaches it"], "once, after 5 minutes")
        self.assertEqual(ing["since"], 1000000)
        ing = step(ing, 1500000, lambda m: "home, read back")
        self.assertEqual(told[-1], "mini's KVM filters again")
        self.assertNotIn("alerted_at", ing)

    def test_a_kvm_with_no_ip6tables_binary_is_handled_like_one_that_cant_load_it(self):
        t = FakeTables()

        def run(cmd, **k):
            if cmd[0].startswith("ip6tables"):
                raise FileNotFoundError(2, "No such file or directory", cmd[0])
            return t(cmd, **k)
        out = W.apply_ingress("lan", run=run, v6=True, v6_off=lambda: (True, {"eth0": True}))
        self.assertIn("IPv6: off on eth0 (read back)", out)
        self.assertIsNone(W.ingress_drift("lan", run=run, v6=True, read=lambda p: "1", ifaces=["eth0"]))
        t.chains["iptables"][W.CHAIN].append(list(t.chains["iptables"][W.CHAIN][-1]))
        self.assertIn("a rule twice", W.ingress_drift("lan", run=run, v6=True, read=lambda p: "1", ifaces=["eth0"]))

    def test_a_refused_change_keeps_the_rules_that_were_there(self):
        t = FakeTables(conntrack=False)
        W.apply_ingress("lan", run=t)
        before = [list(r) for r in t.chains["iptables"][W.CHAIN]]
        t.refuse = ["--dport", "80"]
        with self.assertRaises(RuntimeError) as e:
            W.apply_ingress("tailnet", run=t, iface_up=lambda i: True, joined=True)
        self.assertIn("still in force", str(e.exception))
        self.assertEqual(t.chains["iptables"][W.CHAIN], before)
        self.assertIsNone(W.ingress_drift("lan", run=t))

    def test_the_kvm_reads_its_own_certificate_fingerprint(self):
        der = b"0\x82fake-der"
        pem = "-----BEGIN CERTIFICATE-----\n%s\n-----END CERTIFICATE-----\n" % base64.b64encode(der).decode()
        fp = W.cert_fingerprint(paths=("/x",), read=lambda p: pem)
        h = hashlib.sha256(der).hexdigest().upper()
        self.assertEqual(fp["sha256"], ":".join(h[i:i + 2] for i in range(0, len(h), 2)))


Safety.real_clock_sig = W.clock_sig


class ReviewFixes(unittest.TestCase):
    """Found by the independent code review of the safety change, 2026-11-08."""

    def setUp(self):
        self.dir = scratch()
        W.HOME = self.dir

    def test_judging_survives_a_save_so_one_failure_counts_once(self):
        mem = {"state": "hung", "since": 0, "incident": {"started": 0, "failed": {}}}
        st = {"ledger": []}
        W.write_ahead(st, {"at": 60000, "kind": "power_cycle", "state": "hung"})
        W.finish(st, st["ledger"][-1], "plug: ok")
        for t in (20, 21, 22):
            st = W.load("state.json", {})
            mem, _ = W.judge(mem, st["ledger"], t * 60000)
            W.save_state(st)
        self.assertEqual(mem["incident"]["failed"].get("power_cycle", 0), 1)

    def test_a_slow_writer_never_rolls_back_another_s_fields(self):
        W.save("state.json", {"ledger": [], "seen_ids": ["old"], "inbox_etag": "e1"})
        slow = W.load("state.json", {})
        W.save("state.json", {"ledger": [], "seen_ids": ["old", "new"], "inbox_etag": "e2"})
        W.write_ahead(slow, {"at": 1, "kind": "power_cycle"})
        disk = W.load("state.json", {})
        self.assertEqual(disk["seen_ids"], ["old", "new"])
        self.assertEqual(disk["inbox_etag"], "e2")
        self.assertEqual(len(disk["ledger"]), 1)

    def test_away_needs_a_running_tailnet_not_just_an_interface(self):
        with self.assertRaises(RuntimeError):
            W.apply_ingress("tailnet", run=lambda c, **k: None, iface_up=lambda i: True, joined=False)
        self.assertIn("tailnet only", W.apply_ingress("tailnet", run=FakeTables(), iface_up=lambda i: True, joined=True))
        self.assertIn(["iptables", "-A", W.CHAIN, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"], W.ingress_rules("tailnet"))
        status = lambda c, **k: type("R", (), {"returncode": 0, "stdout": json.dumps({"BackendState": "NeedsLogin"})})()  # noqa: E731
        self.assertFalse(W.tailnet_running(run=status))

    def test_a_fingerbot_never_presses_a_running_mac_and_a_cycle_is_its_long_press(self):
        class K(OcrlessKvmd):
            def __init__(self, online):
                OcrlessKvmd.__init__(self)
                self.online = online
            def json(self, path):
                return {"streamer": {"source": {"online": self.online}}}
        cfg = {"name": "studio", "power": {"kind": "fingerbot"}}
        orig = (W.arp_alive, W.tcp_answers)
        W.arp_alive, W.tcp_answers = (lambda ips, macs, **k: None), (lambda h, connect=None: None)
        try:
            k = K(True)
            r = W.handle({"op": "power_on"}, cfg, k, None, print, 10**9, {"ledger": []})
            self.assertFalse(r["ok"])
            self.assertEqual(k.gets, [])
            k = K(False)
            self.assertTrue(W.handle({"op": "power_on"}, cfg, k, None, print, 10**9, {"ledger": []})["ok"])
            k = K(False)
            r = W.handle({"op": "power_cycle", "args": {"attended": True}}, cfg, k, None, print, 10**9, {"ledger": []})
            self.assertTrue(r["ok"])
            self.assertIn("press_time=10000", k.gets[0], "a long press, not a tap")
            self.assertEqual(W.load("state.json", {})["ledger"][-1]["kind"], "press_power")
        finally:
            W.arp_alive, W.tcp_answers = orig


class LockScreenIsNotADesktop(unittest.TestCase):
    """Real frames through the GLKVM mirror, 2026-11-08: the lock screen's top-right icons once read as a menu bar."""

    def setUp(self):
        W.HOME = scratch()

    def test_real_mirror_frames(self):
        self.assertEqual(W.classify_frame(FRAMES["desktop-mirror-2560"]), "desktop")
        self.assertEqual(W.classify_frame(FRAMES["lockscreen-mirror-2560"]), "prompt_like")
        self.assertEqual(W.classify_frame(FRAMES["lockscreen-mirror-awake-2560"]), "prompt_like")

    def test_status_icons_top_right_are_not_a_menu_bar(self):
        w, h = 400, 60
        y = bytearray([100] * (w * h))
        for row in range(0, 40):
            for x in range(300, 400, 4):
                y[row * w + x] = 250
        self.assertEqual(W.frame_features(bytes(y), w, h)["top_edges"], 0)
        for row in range(0, 40):
            for x in range(0, 120, 4):
                y[row * w + x] = 250
        self.assertGreater(W.frame_features(bytes(y), w, h)["top_edges"], 40)

    def test_the_prompt_is_learned_through_a_moving_wallpaper(self):
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "test")
        seen, match, refs, _ = W.prompt_seen(LUM["lock-later"])
        self.assertTrue(seen)
        self.assertGreaterEqual(match, W.PROMPT_RECALL)
        self.assertEqual(refs, 1)
        self.assertFalse(W.prompt_seen(LUM["desktop"])[0])

    def test_a_plain_bright_or_grey_frame_never_matches(self):
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "test")
        n = len(LUM["lock-a"]["_lum"])
        for luma in (255, 200, 128, 3):
            f = {"mean": luma, "top_edges": 0, "_lum": bytes([luma]) * n}
            self.assertEqual(W.prompt_seen(f)[1], 0.0, luma)
            self.assertFalse(W.prompt_seen(f)[0], luma)


class Look(unittest.TestCase):
    """`housesitter look` and `doctor`: a read-only look and a tiny colour glimpse of the screen."""

    def setUp(self):
        W.HOME = scratch()

    @staticmethod
    def solid(w, h, y, u, v):
        return bytes([y]) * (w * h) + bytes([u]) * ((w // 2) * (h // 2)) + bytes([v]) * ((w // 2) * (h // 2))

    def test_glimpse_is_a_small_colour_picture(self):
        g = W.glimpse(self.solid(160, 90, 81, 90, 240), 160, 90)  # BT.601 red
        rgb = base64.b64decode(g["rgb"])
        self.assertEqual((g["w"], g["h"], len(rgb)), (40, 22, 40 * 22 * 3))
        r, gg, b = rgb[0], rgb[1], rgb[2]
        self.assertGreater(r, 200)
        self.assertLess(gg, 40)
        self.assertLess(b, 40)
        self.assertIsNone(W.glimpse(b"short", 160, 90))

    def test_look_from_a_picture_reads_it_and_presses_nothing(self):
        w, h = 2560, 1440
        frame = self.solid(w, h, 120, 128, 128)
        calls = []

        def run(cmd, **kw):
            calls.append(cmd)
            return type("R", (), {"stdout": frame})()

        class NoKeys:
            def post(self, *a, **k):
                raise AssertionError("look must not press or type anything")

        out = W.look(NoKeys(), "/some/where/shot.png", run=run, now=5)
        self.assertEqual(out["from"], "shot.png")
        self.assertEqual(out["size"], [w, h])
        self.assertEqual(out["reads_as"], "prompt_like")
        self.assertEqual(out["prompt"], {"taught": 0, "match": 0.0, "visible": False, "kind": None, "grid": False, "click": None, "lessons": {"boot": 0, "lock": 0, "grid": 0}})
        self.assertEqual(out["glimpse"]["w"], 40)
        self.assertEqual(calls[0][0], "ffmpeg")
        self.assertEqual(W.look(NoKeys(), "x.png", run=lambda c, **k: type("R", (), {"stdout": b""})())["reads_as"], "none")

    def test_budgets_show_use_and_when_they_free_up(self):
        now = 10_000_000
        st = {"desktop_at": now - 50 * 60000, "ledger": [{"at": now - 40 * 60000, "kind": "unlock"}, {"at": now - 2 * 3600000, "kind": "power_cycle"}]}
        b = W.budgets(st, now)
        self.assertEqual(b["unlock_since_desktop"], [1, W.BOOT["per_boot"]])
        self.assertEqual(b["unlock_hour"], [1, W.DEFAULTS["unlocks_per_hour"]])
        self.assertEqual(b["unlock_hour_frees_at"], now - 40 * 60000 + 3600000)
        self.assertEqual(b["cycles_day"], [1, W.DEFAULTS["cycles_per_day"]])
        self.assertIsNone(b["blocked"])


class NeverEscape(unittest.TestCase):
    """At a macOS login window, Escape leaves the password field for the list of users (2026-11-08). The sitter's own
    keys are a lone Shift to wake the screen, and the password, then Return, at a field it can see. (An agent's own
    `key` request is that agent's choice, and passes through as asked.)"""

    def test_the_only_key_the_sitter_presses_by_itself_is_shift(self):
        src = open(os.path.join(HERE, "..", "device", "sitter.py")).read()
        import re
        self.assertEqual(sorted(set(re.findall(r"send_key\?key=(\w+)", src))), ["Enter", "ShiftLeft"])
        # Its only key of its own besides Return is a lone Shift; an agent's Escape at a login window is refused (LiveFindings).


class OnlyAfterABoot(unittest.TestCase):
    """By itself the sitter types only at a prompt that follows a boot. A plain lock screen is the owner's lock: it
    stays locked unless an operator asks or the config opts in (live finding, 2026-11-08; housesitter#7)."""

    def setUp(self):
        W.HOME = scratch()
        self.saved = (W.load_secret, W.arp_alive, W.has_secret)
        W.load_secret = lambda name, key=None: "pw" if name == "mac" else None
        W.has_secret = lambda name: name == "mac"
        W.arp_alive = lambda ips, macs: None
        W.set_password_trust("verified", "test")

    def tearDown(self):
        (W.load_secret, W.arp_alive, W.has_secret) = self.saved

    def test_the_rule(self):
        self.assertFalse(W.after_boot({}, {"screen": "login"}, {}))
        self.assertTrue(W.after_boot({}, {"screen": "login"}, {"pending": 5}, now=60000))
        self.assertFalse(W.after_boot({}, {"screen": "login"}, {"pending": 5}, now=5 + 16 * 60000), "a boot older than the watch's window grants nothing")
        self.assertTrue(W.after_boot({}, {"screen": "filevault"}, {}))
        self.assertTrue(W.after_boot({"unlock_lock_screen": True}, {"screen": "login"}, {}))

    def test_a_plain_lock_screen_stays_locked(self):
        kvmd = FakeKvmd(online=True, text="Ada Lovelace\nEnter Password\nSleep Restart Shut Down")
        for t in range(0, 6):
            st = W.once({"name": "studio", "user_names": ["Ada"]}, kvmd, None, lambda m: None, now=t * 60000)
            self.assertFalse(st["can"]["unlock"])
        self.assertEqual([p for p in kvmd.posts if "print" in p[0]], [])
        self.assertFalse(any(e.get("kind") == "unlock" for e in W.load("state.json", {}).get("ledger", [])))


class LiveFindings(unittest.TestCase):
    """From the independent review after the real restart (2026-11-08)."""

    def setUp(self):
        W.HOME = scratch()

    def tick(self, bw, now, usb, mode=(2560, 1440), frame=None, kvm_boot="b1", up=5000):
        return W.boot_tick(bw, now, {"usb": usb, "mode": mode, "frame": frame, "kvm_boot": kvm_boot}, W.BOOT, up)

    def test_a_usb_reset_without_a_dark_screen_is_not_a_boot(self):
        bw, _, _ = self.tick(None, 0, 10.0)
        bw, _, note = self.tick(bw, 3000, 900.0)
        self.assertIsNone(bw.get("pending"))
        self.assertIn("not a boot", note)
        bw, _, _ = self.tick(bw, 6000, 900.0, mode=None)
        bw, _, note = self.tick(bw, 9000, 1500.0)
        self.assertTrue(bw.get("pending"))
        self.assertIn("boot seen", note)

    def test_a_kvm_reboot_during_a_power_cut_still_sees_the_mac_boot(self):
        bw, _, _ = self.tick(None, 0, 30960.7, up=31000)
        # Power cut: the KVM reboots too, so its kernel clock restarts from zero and its boot id changes. Its own dark
        # proves nothing; the FileVault screen it was taught at a boot does.
        W.learn_prompt([FV["filevault-023210"], FV["filevault-023218"], FV["filevault-023224"]], "boot", kind="boot")
        bw, _, note = self.tick(bw, 60000, 16.9, mode=None, kvm_boot="b2", up=40)
        self.assertFalse(bw.get("pending"), note)
        f = FV["filevault-023232"]
        seen = W.prompt_seen(f)
        bw, _, note = W.boot_tick(bw, 63000, {"usb": 16.9, "mode": (2560, 1440), "frame": f, "kvm_boot": "b2", "prompt_visible": seen[0], "prompt_kind": seen[3]}, W.BOOT, 43)
        self.assertTrue(bw.get("pending"), note)

    def test_pulling_the_kvms_power_never_unlocks_a_lock_screen(self):
        # Morgan's review, round 2: a KVM reboot (a PoE blip, or someone pulling its cable) while the Mac sits at a
        # taught lock screen. No dark screen, so no boot, so never a type.
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "test")
        bw, _, _ = self.tick(None, 0, 30960.7, up=31000)
        for k in range(40):
            f = LUM["lock-later"]
            bw, act, note = W.boot_tick(bw, 60000 + k * 3000, {"usb": 16.9, "mode": (2560, 1440), "frame": f, "kvm_boot": "b2",
                                                                "prompt_visible": W.prompt_seen(f)[0], "prompt_kind": W.prompt_seen(f)[3]}, W.BOOT, 40 + k * 3)
            self.assertNotEqual(act, "type", note)
        self.assertIsNone(bw.get("pending"))

    def test_the_outbox_cannot_attend(self):
        r = W.handle({"op": "power_cycle", "args": {"attended": True}}, {"name": "studio"}, None, None, lambda m: None, 10**6, {"ledger": []}, via="outbox")
        self.assertFalse(r["ok"])
        self.assertIn("SSH only", r["result"])

    def test_no_escape_and_no_typing_from_agents_at_a_password_screen(self):
        W.save("status.json", {"obs": {"screen": "login"}})
        k = FakeKvmd()
        r = W.handle({"op": "key", "args": {"combo": "esc"}}, {"name": "studio"}, k, None, lambda m: None, 10**6, {"ledger": []})
        self.assertEqual(r["code"], "action-unavailable")
        r = W.handle({"op": "type", "args": {"text": "hunter2"}}, {"name": "studio"}, k, None, lambda m: None, 10**6, {"ledger": []})
        self.assertEqual(r["code"], "action-unavailable")
        self.assertEqual(k.posts, [])
        W.save("status.json", {"obs": {"screen": "desktop"}})
        self.assertTrue(W.handle({"op": "key", "args": {"combo": "esc"}}, {"name": "studio"}, k, None, lambda m: None, 10**6, {"ledger": []})["ok"])


class TaughtAtFileVault(unittest.TestCase):
    """The restart of 2026-11-09 on real frames: the sitter refused a FileVault screen it had only been taught as a lock
    screen; taught at the FileVault screen itself (during the boot, once), it matches every FileVault frame and nothing
    else: not the lock screen, and not the wallpaper the KVM saw on 2026-11-08, when no field ever reached its picture."""

    def setUp(self):
        W.HOME = scratch()

    def test_a_lock_screen_lesson_does_not_open_filevault(self):
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "lock")
        for k in ("filevault-023155", "filevault-023232"):
            self.assertFalse(W.prompt_seen(FV[k])[0], k)
            self.assertLess(W.prompt_seen(FV[k])[1], W.PROMPT_RECALL, k)

    def test_taught_at_filevault_it_sees_filevault_and_nothing_else(self):
        n = W.learn_prompt([FV["filevault-023210"], FV["filevault-023218"], FV["filevault-023224"]], "boot", kind="boot")
        self.assertEqual(n, 1)
        for k in ("filevault-023155", "filevault-023203", "filevault-023232"):
            seen = W.prompt_seen(FV[k])
            self.assertTrue(seen[0], k)
            self.assertEqual(seen[3], "boot", k)
        for k, f in (("lock", LUM["lock-a"]), ("lock later", LUM["lock-later"]), ("incident", FV["incident-no-field"]), ("third display", LUM["third-display-lock"])):
            seen = W.prompt_seen(f)
            self.assertFalse(seen[0], k)
            self.assertLess(seen[1], 0.1, k)
        self.assertFalse(W.prompt_seen(LUM["desktop"])[0])

    def test_the_restart_types_once_at_the_field(self):
        W.learn_prompt([FV["filevault-023210"], FV["filevault-023218"], FV["filevault-023224"]], "boot", kind="boot")
        bw, now = None, 1_000_000
        bw, _, _ = W.boot_tick(bw, now, {"usb": 30960.7, "mode": (2560, 1440), "frame": LUM["desktop"]}, W.BOOT, 31000)
        bw, _, _ = W.boot_tick(bw, now + 2000, {"usb": 30960.7, "mode": None, "frame": None}, W.BOOT, 31000)
        acts = []
        for k in range(12):
            f = FV["filevault-023232"]
            seen = W.prompt_seen(f)
            bw, act, note = W.boot_tick(bw, now + 32000 + k * 3000, {"usb": 30990.0, "mode": (2560, 1440), "frame": f, "prompt_visible": seen[0], "prompt_kind": seen[3]}, W.BOOT, 31040)
            acts.append(act)
        self.assertIn("type", acts)

    def test_a_kvm_that_just_started_sees_filevault_only_by_its_lesson(self):
        W.learn_prompt([FV["filevault-023210"], FV["filevault-023218"], FV["filevault-023224"]], "boot", kind="boot")
        f = FV["filevault-023232"]
        seen = W.prompt_seen(f)
        bw, _, note = W.boot_tick(None, 50000, {"usb": 16.9, "mode": (2560, 1440), "frame": f, "kvm_boot": "b2", "prompt_visible": seen[0], "prompt_kind": seen[3]}, W.BOOT, 40)
        self.assertTrue(bw.get("pending"), note)
        self.assertIn("FileVault prompt it was taught at a boot", note)
        # A running KVM never infers a boot from the picture alone.
        bw, _, _ = W.boot_tick(None, 0, {"usb": 16.9, "mode": (2560, 1440), "frame": f, "kvm_boot": "b2", "prompt_visible": seen[0], "prompt_kind": seen[3]}, W.BOOT, 4000)
        self.assertIsNone(bw.get("pending"))

    def test_a_lock_lesson_never_counts_as_a_boot(self):
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "lock")
        f = LUM["lock-later"]
        seen = W.prompt_seen(f)
        self.assertEqual(seen[3], "lock")
        bw, _, _ = W.boot_tick(None, 0, {"usb": 16.9, "mode": (2560, 1440), "frame": f, "kvm_boot": "b2", "prompt_visible": seen[0], "prompt_kind": seen[3]}, W.BOOT, 40)
        self.assertIsNone(bw.get("pending"))


class AgentsHands(unittest.TestCase):
    """An agent types and presses Escape only on a desktop read fresh from the KVM's picture; the outbox can't unlock a
    plain lock screen."""

    def setUp(self):
        W.HOME = scratch()

    def test_a_stale_desktop_status_does_not_let_an_agent_type_at_a_login_window(self):
        W.save("status.json", {"obs": {"screen": "desktop"}})
        k = FakeKvmd(text="Ari Mendelow Enter Password")
        r = W.handle({"op": "type", "args": {"text": "hello"}}, {"name": "studio", "user_names": ["Ari Mendelow"]}, k, None, lambda m: None, 10**6, {"ledger": []})
        self.assertEqual(r["code"], "action-unavailable", r)
        r = W.handle({"op": "key", "args": {"combo": "esc"}}, {"name": "studio", "user_names": ["Ari Mendelow"]}, k, None, lambda m: None, 10**6, {"ledger": []})
        self.assertEqual(r["code"], "action-unavailable", r)
        self.assertEqual(k.posts, [])

    def test_a_desktop_read_fresh_lets_an_agent_type(self):
        k = FakeKvmd()
        r = W.handle({"op": "type", "args": {"text": "hello"}}, {"name": "studio"}, k, None, lambda m: None, 10**6, {"ledger": []})
        self.assertTrue(r["ok"], r)

    def test_the_outbox_cannot_unlock_a_lock_screen(self):
        k = FakeKvmd(text="Ari Mendelow Enter Password")
        W.set_password_trust("verified", "test")
        saved = W.load_secret
        W.load_secret = lambda name, key=None: "pw" if name == "mac" else None
        try:
            r = W.handle({"op": "unlock"}, {"name": "studio", "user_names": ["Ari Mendelow"]}, k, None, lambda m: None, 10**6, {"ledger": []}, via="outbox")
        finally:
            W.load_secret = saved
        self.assertFalse(r["ok"], r)
        self.assertIn("blind unlock is unsupported", r["result"])
        self.assertFalse([p for p, _ in k.posts if "print" in p or "Enter" in p], "a lone Shift to wake the screen, nothing typed")


class OnlyTheBootLesson(unittest.TestCase):
    """Morgan's review, round 3: a dark screen and a keyboard re-enumeration also come from a sleep and wake, or a
    reseated cable. So the sitter types by itself only at the prompt taught during a boot, never at the lock screen."""

    def setUp(self):
        W.HOME = scratch()

    def test_a_wake_at_a_taught_lock_screen_is_reported_never_typed(self):
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "lock")
        bw, now = None, 1_000_000
        bw, _, _ = W.boot_tick(bw, now, {"usb": 900.0, "mode": (2560, 1440), "frame": LUM["desktop"]}, W.BOOT, 31000)
        bw, _, _ = W.boot_tick(bw, now + 2000, {"usb": 900.0, "mode": None, "frame": None}, W.BOOT, 31000)
        acts = []
        for k in range(20):
            f = LUM["lock-later"]
            seen = W.prompt_seen(f)
            bw, act, note = W.boot_tick(bw, now + 5000 + k * 3000, {"usb": 950.0, "mode": (2560, 1440), "frame": f, "prompt_visible": seen[0], "prompt_kind": seen[3]}, W.BOOT, 31010)
            acts.append(act)
        self.assertNotIn("type", acts)
        self.assertEqual(acts.count("blind"), 1)
        self.assertIn("only when you ask", bw["stuck"])

    def test_the_rules_never_type_at_a_lock_lesson_by_themselves(self):
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "lock")
        saved = W.frame_raw, W.frame_features
        try:
            W.frame_raw = lambda kvmd, run=None: (b"", 1, 1)
            W.frame_features = lambda y, w, h: LUM["lock-later"]
            class K:
                def json(self, p):
                    raise RuntimeError("no OCR on this KVM")
            self.assertFalse(W.see_field({}, K(), kinds=("boot",))[0])
            self.assertTrue(W.see_field({}, K(), kinds=W.kinds_for({}, "request"))[0], "asked for over SSH, the lock screen is fine")
        finally:
            W.frame_raw, W.frame_features = saved

    def test_ocr_unlock_alone_is_not_filevault(self):
        self.assertNotEqual(W.classify_screen("Ari Mendelow Enter Password Touch ID or Enter Password to Unlock", ["Ari Mendelow"]), "filevault")

    def test_no_keys_or_clicks_from_agents_at_a_password_screen(self):
        W.save("status.json", {"obs": {"screen": "login"}})
        k = FakeKvmd(text="Ari Mendelow Enter Password")
        for cmd in ({"op": "key", "args": {"combo": "enter"}}, {"op": "key", "args": {"combo": "a"}}, {"op": "click", "args": {"x": 1, "y": 1}}):
            r = W.handle(cmd, {"name": "studio"}, k, None, lambda m: None, 10**6, {"ledger": []})
            self.assertEqual(r["code"], "action-unavailable", cmd)
        self.assertEqual(k.posts, [])

    def test_filevault_lessons_need_a_recent_boot(self):
        self.assertFalse(W.boot_recent({"pending": 1000}, now=1000 + 16 * 60000))
        self.assertTrue(W.boot_recent({"pending": 1000}, now=1000 + 60000))
        self.assertFalse(W.boot_recent({}, now=1000))

    def test_a_lock_screen_cannot_be_filed_as_filevault(self):
        # Morgan's review, round 5: after a wake looks like a boot, someone runs learn-prompt --filevault at the lock
        # screen. If the sitter already knows that screen as the lock screen, it refuses.
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "lock")
        with self.assertRaises(ValueError) as e:
            W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-later"]], "wrong", kind="boot")
        self.assertIn("can't tell your lock screen from FileVault", str(e.exception))
        # The real FileVault screen is distinct, so it is learned.
        self.assertEqual(W.learn_prompt([FV["filevault-023210"], FV["filevault-023218"], FV["filevault-023224"]], "boot", kind="boot"), 2)

    def test_a_wake_reads_as_the_lock_screen_not_filevault(self):
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "lock")
        saved = W.LAST_FRAME
        try:
            raw = (bytes(2560 * 1440), 2560, 1440)
            ff = W.frame_features
            W.frame_features = lambda y, w, h: LUM["lock-later"]
            o = W.eyes_without_ocr({"name": "studio"}, {}, raw, {"pending": int(time.time() * 1000)})
        finally:
            W.frame_features = ff
            W.LAST_FRAME = saved
        self.assertEqual(o["screen"], "login")



class AlertTest(unittest.TestCase):
    """alert-test: one real stuck message through the rules and the notify path, marked TEST, ledgered, once a day."""

    def setUp(self):
        self.dir = scratch()
        W.HOME = self.dir
        self.cfg = {"name": "mini", "notify": {"kind": "ntfy", "url": "https://ntfy.sh/topic"}}
        self.reqs = []

        class R:
            status = 200

            def __enter__(s):
                return s

            def __exit__(s, *a):
                return False

        def opener(req, timeout=10):
            self.reqs.append(req)
            return R()
        self.opener = opener

    def test_sends_the_rules_stuck_message_marked_test_and_ledgers_it(self):
        W.save("state.json", {"mem": {"state": "healthy"}, "ledger": []})
        logs = []
        r = W.alert_test(self.cfg, None, None, logs.append, now=10 ** 12, opener=self.opener)
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(self.reqs), 1)
        title = self.reqs[0].get_header("Title")
        title = title.decode() if isinstance(title, bytes) else title
        self.assertEqual(title, "TEST: mini is stuck at FileVault")
        body = self.reqs[0].data.decode()
        self.assertTrue(body.startswith("TEST (housesitter alert-test; nothing is wrong). Seen by the housesitter on its KVM."))
        self.assertIn("at the FileVault screen for 10+ min and the sitter has not unlocked it", body)
        self.assertEqual(r["sent"]["title"], title)
        st = W.load("state.json", {})
        self.assertEqual(st["mem"], {"state": "healthy"}, "the real memory is untouched")
        self.assertEqual([(e["kind"], e["test"]) for e in st["ledger"]], [("notify", True)])
        again = W.alert_test(self.cfg, None, None, logs.append, now=10 ** 12 + 3600000, opener=self.opener)
        self.assertFalse(again["ok"])
        self.assertIn("one a day", again["result"])
        self.assertEqual(len(self.reqs), 1)
        self.assertTrue(W.alert_test(self.cfg, None, None, logs.append, now=10 ** 12 + 3600000, opener=self.opener, again=True)["ok"])

    def test_no_target_sends_nothing(self):
        r = W.alert_test({"name": "mini"}, None, None, lambda m: None, opener=self.opener)
        self.assertFalse(r["ok"])
        self.assertEqual(self.reqs, [])

    def test_a_real_message_is_not_marked(self):
        W.notify(self.cfg, "mini is stuck at FileVault", "body", opener=self.opener)
        t = self.reqs[0].get_header("Title")
        self.assertEqual(t.decode() if isinstance(t, bytes) else t, "mini is stuck at FileVault")
