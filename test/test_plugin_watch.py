"""The plugin's watcher (plugins/housesitter/watch.py): wakes the agent once per new thing, with a fake ouro."""
import json
import re
import os
import subprocess
import sys
import time
import unittest

from plugin_base import FLEET, IN, PLUGIN, PluginCase, iso, slurp
import peer  # noqa: E402
import watch  # noqa: E402


class WatchTest(PluginCase):
    def setUp(self):
        super().setUp()
        self.write_status()
        self.lines = []
        self.now = time.time()
        self.w = watch.Watcher(clock=lambda: self.now, out=self.lines.append)

    def wakes(self):
        out = []
        for c in self.ouro_calls():
            self.assertEqual(c[:3], ["msg", "--to", "housesitter"])
            m = re.match(r"^\[housesitter watch\] (\S+) (\S+) \(([^)]+)\): (.*) Details: (\S+)$", c[3], re.S)
            self.assertTrue(m, c[3])
            out.append(dict(zip(("--source", "--type", "--id", "--summary", "--payload"), m.groups())))
        return out

    def test_a_new_peer_message_wakes_the_agent_once_with_the_exact_command_line(self):
        text = "Mini's back up after the restart.\nCan you look at the screen?"
        self.put_message(IN, "20261109T100000Z-0000aa01.json", {"v": 1, "id": "aa01", "at": "2026-11-09T10:00:00Z", "from": "ouroboros@mini", "text": text})
        self.w.tick()
        calls = self.ouro_calls()
        self.assertEqual(len(calls), 1)
        payload = os.path.join(self.state, "events", "peer-aa01.json")
        self.assertEqual(calls[0], ["msg", "--to", "housesitter", "[housesitter watch] peer message (peer-aa01): %s Details: %s" % (text, payload)])
        body = json.loads(slurp(payload))
        self.assertEqual(body["message"]["text"], text)
        self.assertEqual((body["source"], body["type"]), ("peer", "message"))
        self.w.tick()
        self.assertEqual(len(self.ouro_calls()), 1)
        self.assertTrue(self.gh.requests[-2]["etag"])  # the second look at the in gist was conditional
        self.assertFalse(os.path.exists(os.path.join(self.state, "peer-seen.json")))  # peer_inbox's to mark, not the watcher's
        self.assertEqual(json.loads(slurp(os.path.join(self.state, "watch-seen.json"))), ["aa01"])
        wake = [json.loads(ln) for ln in self.lines if json.loads(ln).get("event") == "wake"]
        self.assertEqual([(w["source"], w["id"], w["ok"]) for w in wake], [("peer", "peer-aa01", True)])

    def test_it_flushes_the_queued_peer_messages_when_they_are_due(self):
        peer.send("first", ts=self.now)
        q = peer.send("queued", ts=self.now + 30)
        self.assertEqual(q["status"], "queued")
        patches = lambda: [r for r in self.gh.requests if r["method"] == "PATCH"]
        self.now += 60
        self.w.tick()
        self.assertEqual(len(patches()), 1)  # not due yet
        self.now += 301
        self.w.tick()
        self.assertEqual(len(patches()), 2)
        self.assertEqual(set(patches()[1]["body"]["files"]), {q["file"]})
        flushed = [json.loads(ln) for ln in self.lines if json.loads(ln).get("event") == "flush"]
        self.assertEqual([(f["sent"], f["queued"]) for f in flushed], [([q["id"]], 0)])
        self.w.tick()
        self.assertEqual(len(patches()), 2)

    def test_a_wake_during_a_planned_drill_says_it_is_one(self):
        peer.write_json(os.path.join(self.state, "drill.json"), {"label": "battle test row 9", "until": peer.iso(self.now + 600)})
        self.put_message(IN, "20261110T125123Z-0000dd01.json", {"v": 1, "id": "dd01", "at": "2026-11-10T12:51:23Z", "from": "ouroboros@mini", "text": "daemon down"})
        self.w.tick()
        self.assertTrue(self.ouro_calls()[0][3].endswith(peer.drill_note("battle test row 9")))

    def test_a_message_labelled_on_the_mac_carries_the_drill_into_the_wake(self):
        self.put_message(IN, "20261110T125123Z-0000dd02.json", {"v": 1, "id": "dd02", "at": "2026-11-10T12:51:23Z", "from": "ouroboros@mini", "text": "[planned drill: row 9] daemon down"})
        self.w.tick()
        self.assertTrue(self.ouro_calls()[0][3].endswith(peer.drill_note("row 9")))

    def test_a_message_the_agent_already_read_does_not_wake_it(self):
        os.makedirs(self.state, exist_ok=True)
        with open(os.path.join(self.state, "peer-seen.json"), "w") as f:
            json.dump(["bb01"], f)
        self.put_message(IN, "20261109T100000Z-0000bb01.json", {"v": 1, "id": "bb01", "at": "2026-11-09T10:00:00Z", "text": "old news"})
        self.w.tick()
        self.assertEqual(self.ouro_calls(), [])

    def test_a_failed_wake_is_tried_again(self):
        os.environ["FAKE_OURO_EXIT"] = "1"
        self.put_message(IN, "20261109T100000Z-0000cc01.json", {"v": 1, "id": "cc01", "at": "2026-11-09T10:00:00Z", "text": "hello?"})
        self.w.tick()
        self.assertFalse(json.loads(self.lines[-1])["ok"])
        os.environ["FAKE_OURO_EXIT"] = "0"
        self.w.tick()
        self.assertEqual([w["--id"] for w in self.wakes()], ["peer-cc01", "peer-cc01"])
        self.w.tick()
        self.assertEqual(len(self.ouro_calls()), 2)

    def test_sitter_state_changes_wake_once_each(self):
        self.w.tick()
        self.assertEqual(self.ouro_calls(), [])  # a healthy first look is the baseline
        self.write_status("filevault", "filevault")
        self.w.tick()
        self.w.tick()
        self.write_status("filevault", "login")
        self.w.tick()
        wakes = self.wakes()
        self.assertEqual([(w["--source"], w["--type"]) for w in wakes], [("sitter", "state-changed")] * 2)
        self.assertIn("filevault", wakes[0]["--summary"])
        self.assertIn("(was healthy, desktop)", wakes[0]["--summary"])
        self.assertIn("login", wakes[1]["--summary"])
        self.assertEqual(json.loads(slurp(wakes[1]["--payload"]))["status"]["obs"]["screen"], "login")

    def test_a_quiet_sitter_wakes_once_and_again_when_back(self):
        self.w.tick()
        self.write_status(age=200, interval=60)
        self.w.tick()
        self.w.tick()
        self.write_status()
        self.w.tick()
        self.assertEqual([w["--type"] for w in self.wakes()], ["heartbeat-stale", "heartbeat-back"])
        self.assertTrue(all(w["--source"] == "sitter" for w in self.wakes()))

    def test_no_status_file_is_a_quiet_sitter(self):
        os.rename(os.path.join(self.home, "status.json"), os.path.join(self.home, "gone.json"))
        self.w.tick()
        self.assertEqual([(w["--source"], w["--type"]) for w in self.wakes()], [("sitter", "heartbeat-stale")])

    def test_a_bad_status_file_never_crashes_it(self):
        with open(os.path.join(self.home, "status.json"), "w") as f:
            f.write("{half a file")
        self.w.tick()
        self.assertEqual(self.ouro_calls(), [])

    def test_the_mini_heartbeat_going_stale_and_coming_back(self):
        self.w.tick()
        self.assertEqual(self.ouro_calls(), [])
        self.now += 20 * 60  # nothing new written for 20 minutes
        self.write_status(age=-20 * 60)  # while the sitter kept writing its own
        self.w.tick()
        self.w.tick()
        self.gh.gists[FLEET]["aris-mac-mini.json"] = json.dumps({"at": iso(self.now - 30)})
        self.w.tick()
        wakes = self.wakes()
        self.assertEqual([(w["--source"], w["--type"]) for w in wakes], [("mini", "heartbeat-stale"), ("mini", "heartbeat-back")])
        self.assertIn("aris-mac-mini's heartbeat is stale", wakes[0]["--summary"])
        self.assertNotEqual(wakes[0]["--id"], wakes[1]["--id"])
        self.assertTrue(json.loads(slurp(wakes[0]["--payload"]))["stale"])

    def test_the_drill_file_is_one_simulated_incident_then_renamed(self):
        os.makedirs(self.state, exist_ok=True)
        drill = os.path.join(self.state, "simulate-incident")
        with open(drill, "w") as f:
            f.write("drill at 21:00")
        self.w.tick()
        self.w.tick()
        wakes = self.wakes()
        self.assertEqual([(w["--source"], w["--type"]) for w in wakes], [("mini", "heartbeat-stale")])
        self.assertTrue(wakes[0]["--id"].startswith("mini-simulated-"))
        self.assertTrue(wakes[0]["--summary"].startswith("DRILL"))
        self.assertIn("end to end like a real incident", wakes[0]["--summary"])
        self.assertIn("Note: drill at 21:00", wakes[0]["--summary"])
        p = json.loads(slurp(wakes[0]["--payload"]))
        self.assertEqual((p["simulated"], p["note"]), (True, "drill at 21:00"))
        self.assertFalse(os.path.exists(drill))
        self.assertEqual(len([n for n in os.listdir(self.state) if n.startswith("simulate-incident.consumed-")]), 1)
        self.assertEqual([q for q in self.gh.requests if q["method"] != "GET"], [])

    def test_network_errors_back_off_without_crashing(self):
        self.gh.fail = True
        self.w.tick()
        errs = [json.loads(ln) for ln in self.lines if json.loads(ln).get("event") == "error"]
        self.assertEqual({e["source"] for e in errs}, {"peer", "mini"})
        n = len(self.gh.requests)
        self.w.tick()
        self.assertEqual(len(self.gh.requests), n)  # backing off: not asked again yet
        self.gh.fail = False
        self.now += 120
        self.w.tick()
        self.assertGreater(len(self.gh.requests), n)

    def test_runs_once_as_a_script(self):
        r = subprocess.run([sys.executable, os.path.join(PLUGIN, "watch.py"), "--once"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=os.environ, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        self.assertEqual(json.loads(r.stdout.decode().splitlines()[0])["event"], "start")


if __name__ == "__main__":
    unittest.main()
