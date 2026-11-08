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


FRAMES = json.load(open(os.path.join(HERE, "fixtures", "comet-frames-20261108.json")))


class BootWatch(unittest.TestCase):
    """No OCR on a real Comet at 2K: the post-boot password prompt is known by the boot and a steady screen with no menu
    bar. The frames are features of real frames from a GL-RM1PE (V1.7.1) on a Mac mini, 2026-11-08."""

    def run_boot(self, frames, typed_effect=None, ledger=None, start_usb=16.8, kvm_up=1200):
        bw, ledger = None, ledger if ledger is not None else []
        now, usb = 1_000_000, start_usb
        log = []
        bw, act, note = W.boot_tick(bw, ledger, now, {"usb": usb, "mode": (2560, 1440), "frame": None}, W.BOOT, kvm_up)
        self.assertIsNone(bw.get("boot_at"), "a running KVM does not count its own boot enumeration as the Mac's")
        now += 2000
        bw, act, note = W.boot_tick(bw, ledger, now, {"usb": usb + 900, "mode": None, "frame": None}, W.BOOT, kvm_up)
        self.assertTrue(bw.get("pending"), "a boot is pending until a desktop shows")
        queue = list(frames)
        while queue:
            f = queue.pop(0)
            now += 3000
            bw, act, note = W.boot_tick(bw, ledger, now, {"usb": usb + 900, "mode": (2560, 1440), "frame": f}, W.BOOT, kvm_up)
            log.append((act, note))
            if act == "type":
                ledger.append({"at": now, "kind": "unlock"})
                bw["typed"] = (bw.get("typed") or []) + [now]
                bw["stable"] = 0
                if typed_effect:
                    queue = list(typed_effect)
            if act in ("verified", "stuck"):
                break
        return bw, ledger, log

    def test_real_frames_classify(self):
        self.assertEqual(W.classify_frame(FRAMES["desktop-2560"]), "desktop")
        for k in ("lock-1080", "lock-2560-after-edid-restore", "lock-2560-after-unlock-attempt", "lock-2560-later"):
            self.assertEqual(W.classify_frame(FRAMES[k]), "prompt_like", k)
        self.assertLess(W.thumb_diff(FRAMES["lock-2560-after-edid-restore"]["thumb"], FRAMES["lock-2560-later"]["thumb"]), W.BOOT["same_diff"])
        self.assertGreater(W.thumb_diff(FRAMES["desktop-2560"]["thumb"], FRAMES["lock-2560-later"]["thumb"]), W.BOOT["same_diff"])

    def test_boot_to_prompt_types_once_after_it_settles_then_sees_the_desktop(self):
        lock, desk = FRAMES["lock-2560-later"], FRAMES["desktop-2560"]
        bw, ledger, log = self.run_boot([lock] * 12, typed_effect=[desk])
        acts = [a for a, _ in log]
        self.assertEqual(acts.count("type"), 1)
        self.assertGreaterEqual((acts.index("type") + 1) * 3, W.BOOT["settle_sec"], "waits for the boot to settle")
        self.assertEqual(acts[-1], "verified")
        self.assertIsNone(bw.get("pending"))
        self.assertEqual([e["kind"] for e in ledger], ["unlock"])

    def test_wrong_password_retries_once_then_stops_and_says_how_to_fix_it(self):
        bw, ledger, log = self.run_boot([FRAMES["lock-2560-later"]] * 60)
        acts = [a for a, _ in log]
        self.assertEqual(acts.count("type"), W.BOOT["per_boot"])
        self.assertEqual(acts[-1], "stuck")
        self.assertIn("housesitter secret <mac> mac-password", bw["stuck"])
        self.assertTrue(bw.get("pending"))

    def test_hourly_budget_is_shared_with_earlier_unlocks(self):
        earlier = [{"at": 1_000_000 - 60000 * k, "kind": "unlock"} for k in (5, 10, 15)]
        bw, ledger, log = self.run_boot([FRAMES["lock-2560-later"]] * 20, ledger=earlier)
        self.assertNotIn("type", [a for a, _ in log])
        self.assertIn("budget", log[-1][1])

    def test_no_boot_no_typing(self):
        bw = None
        for k in range(30):
            bw, act, _ = W.boot_tick(bw, [], 1_000_000 + k * 3000, {"usb": 16.8, "mode": (2560, 1440), "frame": FRAMES["lock-2560-later"]}, W.BOOT, 1200)
            self.assertNotEqual(act, "type")

    def test_hdmi_back_alone_is_not_a_boot(self):
        bw, _, _ = W.boot_tick(None, [], 0, {"usb": 16.8, "mode": (2560, 1440), "frame": None}, W.BOOT, 1200)
        bw, _, _ = W.boot_tick(bw, [], 2000, {"usb": 16.8, "mode": None, "frame": None}, W.BOOT, 1200)
        bw, act, note = W.boot_tick(bw, [], 9000, {"usb": 16.8, "mode": (2560, 1440), "frame": None}, W.BOOT, 1200)
        self.assertIn("not a boot", note)
        self.assertIsNone(bw.get("boot_at"))
        for k in range(30):
            bw, act, _ = W.boot_tick(bw, [], 12000 + k * 3000, {"usb": 16.8, "mode": (2560, 1440), "frame": FRAMES["lock-2560-later"]}, W.BOOT, 1200)
            self.assertNotEqual(act, "type")

    def test_a_kvm_that_booted_with_the_mac_counts_that_enumeration(self):
        bw, _, _ = W.boot_tick(None, [], 0, {"usb": 16.8, "mode": (2560, 1440), "frame": None}, W.BOOT, 40)
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
