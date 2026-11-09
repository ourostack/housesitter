"""The sitter (device/sitter.py): the same scenarios as src/watchdog.mjs, plus its own I/O, with fakes."""
import base64
import hashlib
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "device"))
import sitter as W  # noqa: E402

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
            kvmd = FakeKvmd(online=True, text="Ada Lovelace\nEnter Password\nRestart Shut Down")
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

    def test_it_only_claims_it_can_tell_you_when_it_has_somewhere_to_say_it(self):
        self.assertFalse(W.caps_of({}, None)["notify"])
        self.assertFalse(W.caps_of({"notify": {"kind": "ntfy"}}, None)["notify"])
        self.assertTrue(W.caps_of({"notify": {"kind": "ntfy", "url": "https://ntfy.sh/t"}}, None)["notify"])


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
        W.handle({"op": "scroll", "args": {"dy": -3}}, {}, K(), None, print, 0, {})
        self.assertEqual(K.posts[-1], "/hid/events/send_mouse_wheel?delta_x=0&delta_y=-3")
        K.posts = []
        W.handle({"op": "click", "args": {"x": 0, "y": 0, "count": 3}}, {}, K(), None, print, 0, {})
        self.assertEqual(len([p for p in K.posts if "state=true" in p]), 3)


if __name__ == "__main__":
    unittest.main()


FRAMES = json.load(open(os.path.join(HERE, "fixtures", "comet-frames-20261108.json")))
# Luma grids (lum_grid) from real Comet frames of a Mac's lock screen, with a moving aerial wallpaper behind it.
LUM = {k: dict(v, _lum=base64.b64decode(v["_lum"])) for k, v in json.load(open(os.path.join(HERE, "fixtures", "comet-lum-20261109.json"))).items() if not k.startswith("_")}


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
            bw, act, note = W.boot_tick(bw, now, {"usb": usb + 900, "mode": (2560, 1440), "frame": f, "prompt_visible": visible}, W.BOOT, kvm_up)
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

    def test_a_kvm_that_booted_with_the_mac_counts_that_enumeration(self):
        bw, _, _ = W.boot_tick(None, 0, {"usb": 16.8, "mode": (2560, 1440), "frame": None}, W.BOOT, 40)
        self.assertEqual(bw["boot_at"], 0)

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
        o = W.eyes_without_ocr({"name": "studio"}, {}, self.lock(), {"pending": 1})
        self.assertEqual(o["screen"], "filevault")
        self.assertEqual(W.raw_state(dict(o, answers=False, video=True)), "filevault")

    def test_stuck_at_the_prompt_says_why_in_the_message_signs(self):
        o = W.eyes_without_ocr({"name": "studio"}, {}, self.lock(), {"pending": 1, "stuck": "the password didn't take, 2 tries this boot. Fix: housesitter secret <mac> mac-password"})
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
            W.save("state.json", {"mem": None, "ledger": [], "boot": {"pending": 1}})

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
        W.learn_prompt([LUM["lock-a"], LUM["lock-b"], LUM["lock-c"]], "an operator saw the FileVault field on the KVM's picture")

    def boot(self, cfg=None, start=1_000_000, ticks=20):
        cfg = cfg or {"name": "studio"}
        W.boot_watch(cfg, self.kvmd, self.logs.append, now=start)
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
        self.assertIn("no password field visible", r["result"])
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
        ok = lambda cmd, **k: type("R", (), {"returncode": 0, "stderr": ""})()  # noqa: E731
        self.assertEqual(W.harden(K({"enabled": False}), {}, run=ok, gl=True)["gl_cloud"], "off (read back)")
        for bad in ({"enabled": True}, {}, RuntimeError("HTTP 500")):
            with self.assertRaises(Exception):
                W.harden(K(bad), {}, run=ok, gl=True)

    def test_ingress_is_lan_at_home_and_tailnet_only_elsewhere(self):
        self.assertEqual(W.ingress_mode({}), "lan")
        self.assertEqual(W.ingress_mode({"location": "home"}), "lan")
        self.assertEqual(W.ingress_mode({"location": "office"}), "tailnet")
        home = W.ingress_rules("lan")
        self.assertFalse(any("DROP" in c for c in home))
        away = W.ingress_rules("tailnet")
        for t in ("iptables", "ip6tables"):
            self.assertIn([t, "-A", W.CHAIN, "-i", "tailscale0", "-j", "RETURN"], away)
            for p in ("22", "443"):
                self.assertIn([t, "-A", W.CHAIN, "-p", "tcp", "--dport", p, "-j", "DROP"], away)
        with self.assertRaises(RuntimeError):
            W.apply_ingress("tailnet", run=lambda c, **k: None, iface_up=lambda i: False)

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
        ok = lambda c, **k: type("R", (), {"returncode": 0, "stderr": "", "stdout": ""})()  # noqa: E731
        self.assertIn("tailnet only", W.apply_ingress("tailnet", run=ok, iface_up=lambda i: True, joined=True))
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
        seen, match, refs = W.prompt_seen(LUM["lock-later"])
        self.assertTrue(seen)
        self.assertGreaterEqual(match, W.PROMPT_RECALL)
        self.assertEqual(refs, 1)
        self.assertFalse(W.prompt_seen(LUM["desktop"])[0])


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
        self.assertEqual(out["prompt"], {"taught": 0, "match": 0.0, "visible": False})
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
        self.assertNotIn("Escape", re.sub(r'"esc(ape)?": "Escape"', "", src.split("def key_names")[0] + src.split("def key_names")[1].split("\n\n\n", 1)[1]))
