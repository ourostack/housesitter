"""The unlock paths our own install runs (housesitter #12-#17): the login window's list of users, the lock screen when
the config allows it, an agent's want_desktop request, attended tests with their own budget, the smart plug's password
and new address, IPv6 without ip6tables, a picture with no viewer, incidents that close, proof frames, and the one
message while it waits to be taught. Real frames where we have them (test/fixtures/comet-grid-20261109.json)."""
import base64
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "device"))
import sitter as W  # noqa: E402

W.SLEEP = lambda sec: None

SCRATCH = os.path.join(ROOT, ".scratch")


def scratch():
    os.makedirs(SCRATCH, exist_ok=True)
    return tempfile.mkdtemp(dir=SCRATCH)


def fixture(name):
    return {k: dict(v, _lum=base64.b64decode(v["_lum"])) for k, v in json.load(open(os.path.join(HERE, "fixtures", name))).items() if not k.startswith("_")}


G = fixture("comet-grid-20261109.json")
FV = fixture("comet-filevault-20261109.json")
LUM = fixture("comet-lum-20261109.json")
TILE = [0.4785, 0.8729]


class Keys:
    """A KVM that records every key, click and print."""

    def __init__(self):
        self.posts = []

    def post(self, path, body=None, timeout=60):
        self.posts.append((path, body))
        return b'{"ok":true}'

    def get(self, path, timeout=15):
        return b'{"ok":true}'

    def json(self, path):
        raise RuntimeError("no OCR on this KVM")

    def typed(self):
        return [b for p, b in self.posts if p.startswith("/hid/print")]

    def escapes(self):
        return [p for p, _ in self.posts if "Escape" in p]


def screens(*frames):
    """grab() for unlock_steps: each call returns the next frame; the last one repeats."""
    seq = list(frames)

    def grab():
        return seq.pop(0) if len(seq) > 1 else seq[0]
    return grab


def armed(trust="verified"):
    W.save("password.json", {"trust": trust, "why": "test", "at": 1})


PW = lambda name: "correct horse" if name == "mac" else None  # noqa: E731


class Base(unittest.TestCase):
    def setUp(self):
        W.HOME = scratch()
        armed()

    def teach(self, lock=True, grid=True):
        if lock:
            W.learn_prompt([G["field-a"], G["field-b"], G["field-c"]], "the login window's field form", kind="lock")
        if grid:
            W.learn_prompt([G["grid-a"], G["grid-b"], G["grid-c"]], "the list of users", kind="grid", click=TILE)


class GridLesson(Base):
    def test_a_grid_lesson_keeps_its_tile_and_is_never_a_password_prompt(self):
        self.teach(lock=False)
        refs = W.lessons()
        self.assertEqual(refs[0]["kind"], "grid")
        self.assertEqual(refs[0]["click"], TILE)
        for k in ("grid-later", "grid-later-2"):
            self.assertIsNotNone(W.grid_seen(G[k]), k)
            self.assertFalse(W.prompt_seen(G[k])[0], "a list of users is never typed into")

    def test_a_grid_needs_the_tile(self):
        with self.assertRaises(ValueError):
            W.learn_prompt([G["grid-a"], G["grid-b"], G["grid-c"]], "x", kind="grid")
        with self.assertRaises(ValueError):
            W.learn_prompt([G["grid-a"], G["grid-b"], G["grid-c"]], "x", kind="grid", click=[1.4, 0.5])

    def test_the_real_screens_stay_apart(self):
        self.teach()
        for k in ("field-a", "lock-x", "folded"):
            self.assertIsNone(W.grid_seen(G[k]), k)
            self.assertEqual(W.prompt_seen(G[k])[3], "lock", k)
        for k in ("filevault-023155", "filevault-023232"):
            self.assertIsNone(W.grid_seen(FV[k]), k)
        self.assertIsNone(W.grid_seen(LUM["desktop"]))
        self.assertEqual(W.lesson_counts(), {"boot": 0, "lock": 1, "grid": 1})


class FromTheGrid(Base):
    def test_over_ssh_it_clicks_the_tile_types_once_and_sees_the_desktop(self):
        self.teach()
        k, clicks, st = Keys(), [], {"ledger": []}
        res = W.unlock_steps({}, k, st, 10_000_000, "asked for", "request", secret=PW, grab=screens(G["grid-later"], G["field-a"], G["field-a"], LUM["desktop"]),
                             click=lambda x, y: clicks.append((x, y)))
        self.assertIn("desktop is back", res)
        self.assertIn("clicked the account's tile", res)
        self.assertIn("lock-screen prompt it was taught", res)
        self.assertEqual(clicks, [tuple(TILE)])
        self.assertEqual(k.typed(), [b"correct horse"])
        self.assertEqual(k.escapes(), [], "never Escape at a login window")
        self.assertEqual([e["kind"] for e in st["ledger"]], ["unlock"])

    def test_a_dark_screen_gets_a_shift_never_keys(self):
        self.teach()
        k = Keys()
        res = W.unlock_steps({}, k, {"ledger": []}, 10_000_000, "x", "request", secret=PW, grab=screens(None, G["field-a"], LUM["desktop"]), click=lambda x, y: None)
        self.assertIn("woke a dark screen", res)
        self.assertEqual([p for p, _ in k.posts if "send_key" in p][0], "/hid/events/send_key?key=ShiftLeft")
        self.assertEqual(k.typed(), [b"correct horse"])

    def test_at_most_two_clicks_then_it_says_so(self):
        self.teach()
        k, clicks = Keys(), []
        res = W.unlock_steps({}, k, {"ledger": []}, 10_000_000, "x", "request", secret=PW, grab=screens(G["grid-later"]), click=lambda x, y: clicks.append((x, y)))
        self.assertTrue(res.startswith("refused"), res)
        self.assertEqual(len(clicks), 2)
        self.assertEqual(k.typed(), [])

    def test_already_at_the_desktop_types_nothing(self):
        k = Keys()
        res = W.unlock_steps({}, k, {"ledger": []}, 1, "x", "request", secret=PW, grab=screens(LUM["desktop"]))
        self.assertTrue(res.startswith("already at the desktop"))
        self.assertEqual(k.posts, [])

    def test_an_untaught_screen_is_never_typed_into(self):
        k = Keys()
        res = W.unlock_steps({}, k, {"ledger": []}, 1, "x", "request", secret=PW, grab=screens(G["field-a"]), click=lambda x, y: None)
        self.assertIn("blind unlock is unsupported", res)
        self.assertEqual(k.typed(), [])


class WithOcr(Base):
    def test_a_kvm_with_ocr_reads_the_words_and_types_once(self):
        class K(Keys):
            def json(self, path):
                return "FileVault Enter Password Restart"
        k = K()
        res = W.unlock_steps({}, k, {"ledger": []}, 1, "x", "outbox", secret=PW)
        self.assertTrue(res.startswith("typed the password at the filevault prompt it read"), res)
        self.assertEqual(k.typed(), [b"correct horse"])

    def test_with_ocr_a_lock_screen_from_the_outbox_still_needs_the_policy(self):
        class K(Keys):
            def json(self, path):
                return "Ada Enter Password"
        k = K()
        res = W.unlock_steps({"user_names": ["Ada"]}, k, {"ledger": []}, 1, "x", "outbox", secret=PW)
        self.assertTrue(res.startswith("refused"), res)
        self.assertEqual(k.typed(), [])


class TeachingSafely(Base):
    def test_a_list_of_users_is_never_taught_as_filevault(self):
        W.save("config.json", {"name": "mini"})
        self.assertEqual(W.main(["learn-prompt", "--grid", "0.5", "0.6", "--filevault"]), 2)
        self.assertEqual(W.lessons(), [])

    def test_the_waiting_message_never_suggests_filevault_for_a_screen_it_knows(self):
        self.teach()
        sent = []
        saved = W.usb_last_enum, W.hdmi_mode, W.frame_raw, W.frame_features, W.notify, W.kvm_uptime_s, W.kvm_boot_id
        try:
            W.hdmi_mode = lambda read=None, kvmd=None: (2560, 1440)
            W.frame_raw = lambda kvmd, run=None: (b"", 2560, 1440)
            W.kvm_uptime_s = lambda read=None: 40000
            W.kvm_boot_id = lambda read=None: "b1"
            W.notify = lambda cfg, subject, body, opener=None: sent.append(body) or "posted 200"
            usb = [900.0]
            W.usb_last_enum = lambda dmesg=None, run=None: usb[0]
            W.frame_features = lambda y, w, h: LUM["desktop"]
            W.boot_watch({"name": "mini"}, Keys(), lambda m: None, now=1_000_000)
            W.hdmi_mode = lambda read=None, kvmd=None: None
            W.boot_watch({"name": "mini"}, Keys(), lambda m: None, now=1_003_000)
            W.hdmi_mode = lambda read=None, kvmd=None: (2560, 1440)
            usb[0] = 950.0
            W.frame_features = lambda y, w, h: G["grid-later"]
            for i in range(20):
                W.boot_watch({"name": "mini"}, Keys(), lambda m: None, now=1_006_000 + i * 3000)
        finally:
            W.usb_last_enum, W.hdmi_mode, W.frame_raw, W.frame_features, W.notify, W.kvm_uptime_s, W.kvm_boot_id = saved
        self.assertEqual(len(sent), 1)
        self.assertNotIn("--filevault", sent[0])
        self.assertIn("housesitter unlock mini", sent[0])

    def test_a_failing_lock_watch_never_stops_the_rules(self):
        saved = W.observe, W.unlock_steps
        try:
            W.observe = lambda cfg, kvmd, power, mem, now: {"eyes": "frame", "screen": "login", "video": True, "prompt": {"visible": True, "kind": "lock", "taught": 1, "match": 1.0, "grid": False}}

            def boom(*a, **k):
                raise RuntimeError("kvmd /hid/events/send_mouse_move -> HTTP 503")
            W.unlock_steps = boom
            status = W.once({"name": "mini", "unlock_lock_screen": True}, Keys(), None, lambda m: None, now=5_000_000)
        finally:
            W.observe, W.unlock_steps = saved
        self.assertIn("failed: kvmd", status["obs"]["lock_watch"])
        self.assertTrue(os.path.exists(os.path.join(W.HOME, "status.json")))


class LockScreenPolicy(Base):
    """unlock_lock_screen: off by default (the public product), "on_request" for our install (Ari, 2026-11-08)."""

    def test_off_by_default_nobody_but_you_unlocks_a_lock_screen(self):
        self.teach()
        self.assertEqual(W.lock_policy({}), False)
        for by in ("outbox", "rules", "boot-watch", "lock-watch"):
            k, clicks = Keys(), []
            res = W.unlock_steps({}, k, {"ledger": []}, 1, "x", by, secret=PW, grab=screens(G["grid-later"], G["field-a"]), click=lambda x, y: clicks.append(1))
            self.assertTrue(res.startswith("refused"), (by, res))
            self.assertEqual((clicks, k.typed()), ([], []), by)

    def test_want_desktop_is_refused_when_off(self):
        r = W.handle({"op": "want_desktop", "args": {"minutes": 5}}, {"name": "mini"}, Keys(), None, lambda m: None, 1, {"ledger": []}, via="outbox")
        self.assertEqual(r["code"], "action-unavailable")
        self.assertIn("unlock_lock_screen", r["result"])
        self.assertFalse(W.desktop_wanted(1))

    def test_on_request_an_agent_asks_and_it_unlocks_from_the_grid(self):
        self.teach()
        cfg = {"name": "mini", "unlock_lock_screen": "on_request"}
        now = 10_000_000
        self.assertFalse(W.lock_allowed(cfg, now))
        self.assertEqual(W.kinds_for(cfg, "outbox", now), ("boot",))
        frames = screens(G["grid-later"], G["field-a"], G["field-a"], LUM["desktop"])
        saved = W.grab_frame, W.click_at
        clicks = []
        try:
            W.grab_frame = lambda kvmd: frames()
            W.click_at = lambda kvmd, x, y: clicks.append((x, y))
            W.load_secret = lambda name, key=None: PW(name)
            k = Keys()
            r = W.handle({"op": "want_desktop", "args": {"minutes": 7}}, cfg, k, None, lambda m: None, now, {"ledger": []}, via="outbox")
        finally:
            W.grab_frame, W.click_at = saved
            W.load_secret = REAL_LOAD_SECRET
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["minutes"], 7)
        self.assertIn("desktop is back", r["result"]["unlock"])
        self.assertEqual(clicks, [tuple(TILE)])
        self.assertTrue(W.desktop_wanted(now + 6 * 60000))
        self.assertFalse(W.desktop_wanted(now + 8 * 60000))
        self.assertEqual(W.kinds_for(cfg, "outbox", now + 60000), ("boot", "lock", "grid"))

    def test_true_means_any_lock_screen(self):
        self.assertTrue(W.lock_allowed({"unlock_lock_screen": True}, 1))
        self.assertFalse(W.lock_allowed({"unlock_lock_screen": "yes"}, 1), "only true or on_request")
        self.assertTrue(W.after_boot({"unlock_lock_screen": True}, {"screen": "login"}, {}, 1))

    def test_the_boot_watch_follows_the_policy_at_the_list_of_users(self):
        bw, now = None, 1_000_000
        bw, _, _ = W.boot_tick(bw, now, {"usb": 900.0, "mode": (2560, 1440), "frame": LUM["desktop"]}, W.BOOT, 31000)
        bw, _, _ = W.boot_tick(bw, now + 2000, {"usb": 900.0, "mode": None, "frame": None}, W.BOOT, 31000)
        acts = {}
        for lock_ok in (False, True):
            b, got = dict(bw), []
            for i in range(12):
                b, act, _ = W.boot_tick(b, now + 30000 + i * 3000, {"usb": 950.0, "mode": (2560, 1440), "frame": G["grid-later"], "prompt_visible": False, "grid": True, "lock_ok": lock_ok}, W.BOOT, 31010)
                got.append(act)
            acts[lock_ok] = got
        self.assertEqual(acts[False].count("blind"), 1)
        self.assertNotIn("steps", acts[False])
        self.assertIn("steps", acts[True])

    def test_the_lock_watch_unlocks_only_when_allowed(self):
        calls = []
        saved = W.observe, W.unlock_steps
        try:
            W.observe = lambda cfg, kvmd, power, mem, now: {"eyes": "frame", "screen": "login", "video": True, "prompt": {"visible": True, "kind": "lock", "taught": 1, "match": 1.0, "grid": False}}
            W.unlock_steps = lambda cfg, kvmd, st, now, why, by, log=None, secret=None: calls.append(by) or "typed the password; the desktop is back (typed)"
            W.once({"name": "mini"}, Keys(), None, lambda m: None, now=5_000_000)
            self.assertEqual(calls, [])
            W.once({"name": "mini", "unlock_lock_screen": "on_request"}, Keys(), None, lambda m: None, now=5_100_000)
            self.assertEqual(calls, [], "on_request with no request standing")
            W.want_desktop(10, "agent", 5_150_000)
            W.once({"name": "mini", "unlock_lock_screen": "on_request"}, Keys(), None, lambda m: None, now=5_200_000)
            self.assertEqual(calls, ["lock-watch"])
        finally:
            W.observe, W.unlock_steps = saved


REAL_LOAD_SECRET = W.load_secret


class AttendedTests(Base):
    def test_attended_tests_have_their_own_budget(self):
        rules = dict(W.DEFAULTS)
        st = {"ledger": [{"at": 1000 + i, "kind": "unlock", "result": "typed"} for i in range(3)], "desktop_at": 5000}
        self.assertIn("unlock budget used", W.typing_budget(st, 10_000, rules))
        self.assertIsNone(W.typing_budget(st, 10_000, rules, kind="unlock_test"))
        st = {"ledger": [{"at": 1000 + i * 10, "kind": "unlock_test", "result": "typed"} for i in range(30)], "desktop_at": 5000}
        self.assertIn("attended-test budget used (30", W.typing_budget(st, 10_000, rules, kind="unlock_test"))
        self.assertIsNone(W.typing_budget(st, 10_000, rules), "tests never use up the 3 an hour")
        b = W.budgets(st, 10_000, rules)
        self.assertEqual(b["unlock_test_hour"], [30, 30])
        self.assertEqual(b["unlock_hour"], [0, 3])

    def test_tries_since_the_desktop_count_every_kind(self):
        st = {"ledger": [{"at": 6000, "kind": "unlock_test"}, {"at": 7000, "kind": "unlock"}], "desktop_at": 5000}
        self.assertIn("2 tries since", W.typing_budget(st, 100_000, dict(W.DEFAULTS)))

    def test_an_attended_test_needs_a_verified_password_and_ssh(self):
        self.teach()
        armed("trial")
        res = W.type_at_field({}, Keys(), {"ledger": []}, 1, "x", "attended-test", secret=PW, visible=(True, "lock-screen", "frame"))
        self.assertIn("needs a verified password", res)
        r = W.handle({"op": "unlock", "args": {"attended_test": True}}, {}, Keys(), None, lambda m: None, 1, {"ledger": []}, via="outbox")
        self.assertEqual(r["code"], "action-unavailable")

    def test_an_attended_test_is_ledgered_as_one(self):
        self.teach()
        k, st = Keys(), {"ledger": []}
        res = W.unlock_steps({}, k, st, 10_000_000, "x", "attended-test", secret=PW, grab=screens(G["field-a"], LUM["desktop"]))
        self.assertIn("desktop is back", res)
        self.assertEqual([e["kind"] for e in st["ledger"]], ["unlock_test"])


class Plug(unittest.TestCase):
    def setUp(self):
        W.HOME = scratch()

    def test_digest_auth_answers_a_401(self):
        seen = []

        class R:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return self.body

        def opener(req, timeout=5):
            seen.append(req)
            if not req.get_header("Authorization"):
                raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {"WWW-Authenticate": 'Digest qop="auth", realm="shellyplugusg4-abc", nonce="60dc59c6", algorithm=SHA-256'}, io.BytesIO(b""))
            return R(b'{"output": true, "apower": 9.5}')
        p = W.ShellyHttp("http://10.0.0.9", opener=opener, password="s3cret")
        self.assertEqual(p.status(), {"on": True, "watts": 9.5})
        auth = seen[-1].get_header("Authorization")
        f = dict(x.split("=", 1) for x in auth[len("Digest "):].replace('"', "").split(", "))
        h = lambda s: hashlib.sha256(s.encode()).hexdigest()  # noqa: E731
        want = h("%s:%s:%s:%s:auth:%s" % (h("admin:shellyplugusg4-abc:s3cret"), "60dc59c6", f["nc"], f["cnonce"], h("GET:/rpc/Switch.GetStatus?id=0")))
        self.assertEqual(f["response"], want)
        self.assertNotIn("s3cret", auth)

    def test_a_moved_plug_is_found_again_by_its_mac(self):
        urls = []

        class R:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b'{"output": false, "apower": 0}'

        def opener(req, timeout=5):
            urls.append(req.full_url)
            if "10.0.0.9" in req.full_url:
                raise urllib.error.URLError("no route to host")
            return R()
        p = W.ShellyHttp("http://10.0.0.9", opener=opener, mac="AA:BB:CC:00:11:22", refind=lambda mac: "http://10.0.0.42" if mac == "AA:BB:CC:00:11:22" else None)
        self.assertEqual(p.status(), {"on": False, "watts": 0})
        self.assertEqual(p.url, "http://10.0.0.42")

    def test_find_shelly_asks_every_address_for_the_mac(self):
        got = W.find_shelly("aa:bb:cc:00:11:22", subnet="192.168.50", probe=lambda ip: {"mac": "AABBCC001122"} if ip.endswith(".77") else {"mac": "000000000000"})
        self.assertEqual(got, "http://192.168.50.77")
        self.assertIsNone(W.find_shelly("aa:bb:cc:00:11:22", subnet="192.168.50", probe=lambda ip: {}))

    def test_bluetooth_answers_a_401_with_the_auth_object(self):
        sent = []

        class Gatt:
            def __init__(self):
                self.out = b""

            def __enter__(self): return self
            def __exit__(self, *a): return False

            def write(self, uuid, data):
                if uuid == W.SHELLY_BLE["tx_ctl"]:
                    self.want, self.buf = int.from_bytes(data, "big"), b""
                if uuid == W.SHELLY_BLE["data"]:
                    self.buf += data
                    if len(self.buf) < self.want:
                        return
                    sent.append(json.loads(self.buf))
                    req = sent[-1]
                    rep = {"id": req["id"], "result": {"output": True, "apower": 3}} if "auth" in req else {"id": req["id"], "error": {"code": 401, "message": json.dumps({"realm": "shellyplugusg4-abc", "nonce": 7, "nc": 1})}}
                    self.out = json.dumps(rep).encode()
                    self.parts = [self.out]

            def read(self, uuid):
                if uuid == W.SHELLY_BLE["rx_ctl"]:
                    return len(self.out).to_bytes(4, "big")
                return self.parts.pop(0) if self.parts else b""
        g = Gatt()
        p = W.ShellyBle("AA:BB", connect=lambda mac: g, password="s3cret")
        self.assertEqual(p.status(), {"on": True, "watts": 3})
        auth = sent[-1]["auth"]
        self.assertEqual(sent[-1]["params"], {"id": 0}, "auth goes in the frame, beside params")
        self.assertEqual((auth["realm"], auth["nc"]), ("shellyplugusg4-abc", 1), "firmware before 2.0 sends nc")
        self.assertNotIn("s3cret", json.dumps(sent))
        h = lambda s: hashlib.sha256(s.encode()).hexdigest()  # noqa: E731
        self.assertEqual(auth["response"], h("%s:7:1:%s:auth:%s" % (h("admin:shellyplugusg4-abc:s3cret"), auth["cnonce"], h("dummy_method:dummy_uri"))))
        a2 = W.shelly_rpc_auth({"message": json.dumps({"realm": "r", "nonce": "AAAA"})}, "pw", cnonce=5)
        self.assertEqual(a2["nc"], "00000001", "firmware 2.0+: eight hex digits")

    def test_make_power_reads_the_sealed_password(self):
        key = b"k" * 32
        W.store_secret("plug", "s3cret", key)
        saved = W.load_secret
        try:
            W.load_secret = lambda name, k=None: saved(name, key)
            p = W.make_power({"power": {"kind": "shelly", "url": "http://10.0.0.9", "mac": "AA", "auth": True}})
        finally:
            W.load_secret = saved
        self.assertEqual((p.password, p.mac), ("s3cret", "AA"))
        self.assertIsNone(W.make_power({"power": {"kind": "shelly", "url": "http://10.0.0.9"}}).password)


class Ipv6WithoutIp6tables(unittest.TestCase):
    """#12: a GL-RM1PE can't load ip6tables (no modules.dep)."""

    def run_(self, cmd, **k):
        ok = cmd[0] == "iptables"
        return type("R", (), {"returncode": 0 if ok else 1, "stderr": "" if ok else "modprobe: can't open 'modules.dep'"})()

    def test_at_home_there_is_nothing_for_ipv6_to_filter(self):
        out = W.apply_ingress("lan", run=self.run_, v6=True)
        self.assertIn("IPv6: nothing to filter at home", out)

    def test_away_it_fails_closed_unless_ipv6_reads_back_off(self):
        with self.assertRaises(RuntimeError) as e:
            W.apply_ingress("tailnet", run=self.run_, iface_up=lambda i: True, joined=True, v6=True, v6_off=lambda: (False, {"eth0": False, "wlan0": True}))
        self.assertIn("eth0", str(e.exception))
        out = W.apply_ingress("tailnet", run=self.run_, iface_up=lambda i: True, joined=True, v6=True, v6_off=lambda: (True, {"eth0": True}))
        self.assertIn("IPv6: off on eth0 (read back)", out)

    def test_ipv6_off_skips_the_tailnet_and_reads_back(self):
        files = {"/proc/sys/net/ipv6/conf/eth0/disable_ipv6": "0", "/proc/sys/net/ipv6/conf/tailscale0/disable_ipv6": "0"}
        ok, seen = W.ipv6_off_except_tailnet(ifaces=["all", "default", "lo", "eth0", "tailscale0"], read=lambda p: files[p], write=lambda p, v: files.__setitem__(p, v))
        self.assertTrue(ok)
        self.assertEqual(seen, {"eth0": True})
        self.assertEqual(files["/proc/sys/net/ipv6/conf/tailscale0/disable_ipv6"], "0")
        ok, seen = W.ipv6_off_except_tailnet(ifaces=["eth0"], read=lambda p: "0", write=lambda p, v: None)
        self.assertFalse(ok)

    def test_a_kernel_without_ipv6(self):
        self.assertIn("this kernel has none", W.apply_ingress("tailnet", run=self.run_, iface_up=lambda i: True, joined=True, v6=False))


class NoViewer(unittest.TestCase):
    """#13: with nobody watching, GLKVM says "streamer": null; the HDMI receiver still knows, and the sitter reads."""

    def setUp(self):
        W.HOME = scratch()

    def test_the_receiver_decides_video_and_a_frame_is_read(self):
        class K(Keys):
            def json(self, path):
                if path == "/streamer":
                    return {"streamer": None}
                raise RuntimeError("no OCR")
        saved = W.hdmi_mode, W.frame_raw, W.frame_features
        try:
            W.hdmi_mode = lambda read=None, kvmd=None: (2560, 1440)
            W.frame_raw = lambda kvmd, run=None: (b"", 2560, 1440)
            W.frame_features = lambda y, w, h: LUM["desktop"]
            obs = W.observe({}, K(), None, {}, 1)
        finally:
            W.hdmi_mode, W.frame_raw, W.frame_features = saved
        self.assertTrue(obs["video"])
        self.assertEqual(obs["hdmi"], "2560x1440")
        self.assertEqual(obs["screen"], "desktop")
        self.assertEqual(obs["eyes"], "frame")


class IncidentsClose(unittest.TestCase):
    """#14: no probe and no heartbeat: a ticking desktop is up."""

    def test_a_ticking_desktop_is_healthy_without_a_probe(self):
        self.assertEqual(W.raw_state({"screen": "desktop", "clock_ticking": True, "arp": True, "video": True}), "healthy")
        self.assertEqual(W.raw_state({"screen": "desktop", "clock_ticking": True, "arp": None, "video": True}), "healthy")
        self.assertNotEqual(W.raw_state({"screen": "desktop", "clock_ticking": True, "arp": False, "video": True}), "healthy")
        self.assertNotEqual(W.raw_state({"screen": "desktop", "clock_ticking": None, "arp": True, "video": True}), "healthy")
        self.assertEqual(W.raw_state({"answers": False, "screen": "desktop", "clock_ticking": True, "video": True}), "degraded", "a probe that fails still counts")

    def test_a_filevault_incident_closes_and_is_remembered(self):
        mem, ledger = None, []
        mem, _ = W.tick(mem, ledger, {"screen": "filevault", "video": True, "arp": True}, 0, {"unlock": False, "notify": True})
        self.assertIsNotNone(mem["incident"])
        mem, _ = W.tick(mem, ledger, {"screen": "desktop", "clock_ticking": True, "video": True, "arp": True}, 120000, {"unlock": False, "notify": True})
        self.assertEqual(mem["state"], "healthy")
        self.assertIsNone(mem["incident"])


class ProofFrames(unittest.TestCase):
    """#15: a desktop never leaves the KVM in a proof, unless asked."""

    def setUp(self):
        W.HOME = scratch()
        self.saved = W.frame_raw, W.frame_features, W.LAST_FRAME

    def tearDown(self):
        W.frame_raw, W.frame_features, W.LAST_FRAME = self.saved

    def fake(self, f):
        def raw(kvmd, run=None):
            W.LAST_FRAME = (bytes(16 * 16 * 3 // 2), 16, 16)
            return (bytes(256), 16, 16)
        W.frame_raw = raw
        W.frame_features = lambda y, w, h: f

    def test_desktop_withheld_prompt_kept(self):
        calls = []
        jpeg = b"\xff\xd8" + b"x" * 300 + b"\xff\xd9"
        run = lambda cmd, **k: calls.append(cmd) or type("R", (), {"stdout": jpeg})()  # noqa: E731
        self.fake(LUM["desktop"])
        out = W.proof_frame(Keys(), run=run, now=5)
        self.assertEqual((out["reads_as"], out["jpeg"]), ("desktop", None))
        self.assertEqual(calls, [])
        out = W.proof_frame(Keys(), all_frames=True, run=run, now=5)
        self.assertTrue(out["jpeg"])
        self.fake(FV["filevault-023232"])
        out = W.proof_frame(Keys(), run=run, now=6)
        self.assertEqual(base64.b64decode(out["jpeg"]), jpeg)
        self.assertNotIn("scale", " ".join(calls[-1]), "the Comet's ffmpeg has no scale filter")


class WaitingToBeTaught(unittest.TestCase):
    """#16: one message while it waits at a password screen it can't type at, and the log names the lesson."""

    def setUp(self):
        W.HOME = scratch()

    def test_one_message_a_boot_and_the_rules_count_it(self):
        sent = []
        saved = W.usb_last_enum, W.hdmi_mode, W.frame_raw, W.frame_features, W.notify, W.kvm_uptime_s, W.kvm_boot_id
        try:
            W.hdmi_mode = lambda read=None, kvmd=None: (2560, 1440)
            W.frame_raw = lambda kvmd, run=None: (b"", 2560, 1440)
            W.kvm_uptime_s = lambda read=None: 40000
            W.kvm_boot_id = lambda read=None: "b1"
            W.notify = lambda cfg, subject, body, opener=None: sent.append((subject, body)) or "posted 200"
            usb = [900.0]
            W.usb_last_enum = lambda dmesg=None, run=None: usb[0]
            W.frame_features = lambda y, w, h: LUM["desktop"]
            W.boot_watch({"name": "mini"}, Keys(), lambda m: None, now=1_000_000)
            W.hdmi_mode = lambda read=None, kvmd=None: None
            W.boot_watch({"name": "mini"}, Keys(), lambda m: None, now=1_003_000)
            W.hdmi_mode = lambda read=None, kvmd=None: (2560, 1440)
            usb[0] = 950.0
            W.frame_features = lambda y, w, h: FV["filevault-023232"]
            for i in range(20):
                W.boot_watch({"name": "mini"}, Keys(), lambda m: None, now=1_006_000 + i * 3000)
        finally:
            W.usb_last_enum, W.hdmi_mode, W.frame_raw, W.frame_features, W.notify, W.kvm_uptime_s, W.kvm_boot_id = saved
        self.assertEqual(len(sent), 1, sent)
        self.assertIn("mini is waiting at a password screen", sent[0][0])
        self.assertIn("learn-prompt mini --i-see-the-field --filevault", sent[0][1])
        told = W.load("state.json", {})["boot"]["told_at"]
        st = W.load("state.json", {})
        st["mem"] = {"state": "filevault", "since": told, "raw": "filevault", "raw_since": told, "incident": {"started": told - 1000, "notified_at": None, "failed": {}}}
        W.save("state.json", st)
        saved = W.observe
        try:
            W.observe = lambda cfg, kvmd, power, mem, now: {"eyes": "frame", "screen": "filevault", "video": True}
            status = W.once({"name": "mini", "notify": {"url": "x"}}, Keys(), None, lambda m: None, now=told + 11 * 60000)
        finally:
            W.observe = saved
        self.assertEqual(status["incident"]["notified_at"], told)
        self.assertNotIn("notify", [a["kind"] for a in status["actions"]], "it already told you")

    def test_the_log_names_the_lesson(self):
        W.save("password.json", {"trust": "verified"})
        res = W.type_at_field({}, Keys(), {"ledger": []}, 1, "x", "boot-watch", secret=PW, visible=(True, "FileVault", "frame"))
        self.assertTrue(res.startswith("typed the password at the FileVault prompt it was taught"), res)
        self.assertNotIn("prompt_like", res)


if __name__ == "__main__":
    unittest.main()
