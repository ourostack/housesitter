"""The sitter (device/sitter.py): the same scenarios as src/watchdog.mjs, plus its own I/O, with fakes."""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "device"))
import sitter as W  # noqa: E402

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
            kvmd = FakeKvmd(online=True, text="Ada Lovelace\nEnter Password\nRestart Shut Down")
            W.arp_alive = lambda ips, macs: None
            st = W.once({"name": "studio"}, kvmd, None, self.logs.append, now=0)
            self.assertEqual(st["state"], "filevault")
            self.assertEqual([a["kind"] for a in st["actions"]], ["unlock"])
            self.assertIn("typed the password", st["actions"][0]["result"])
            self.assertEqual(kvmd.posts[-1], ("/hid/print?limit=0&slow=1", b"fake-filevault-password\n"))
            self.assertNotIn("fake-filevault-password", " ".join(self.logs) + json.dumps(st))
            # The same request at the desktop is refused: it never types into an app.
            kvmd2 = FakeKvmd(online=True)
            self.assertIn("refused", W.unlock({}, kvmd2, secret=lambda n: "pw"))
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
        self.assertEqual(r["chars"], 16)
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

        def opener(url, timeout=5):
            urls.append(url)
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
        self.assertTrue(W.handle({"op": "power_cycle"}, cfg, None, p, print, now, st)["ok"])
        r = W.handle({"op": "power_cycle"}, cfg, None, p, print, now + 60000, st)
        self.assertEqual(r["code"], "action-failed")
        self.assertEqual(P.n, 1)

    def test_scroll_and_triple_click(self):
        class K:
            posts = []
            def post(self, p, body=None, timeout=60):
                K.posts.append(p)
        W.handle({"op": "scroll", "args": {"dy": -3}}, {}, K(), None, print, 0, {})
        self.assertEqual(K.posts[-1], "/hid/events/send_mouse_wheel?delta_x=0&delta_y=-3")
        K.posts = []
        W.handle({"op": "click", "args": {"x": 0, "y": 0, "count": 3}}, {}, K(), None, print, 0, {})
        self.assertEqual(len([p for p in K.posts if "state=true" in p]), 3)


if __name__ == "__main__":
    unittest.main()
