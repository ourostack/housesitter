"""The peer link (plugins/housesitter/peer.py) against a fake gist API: queued sends, batched flushes, the hourly cap,
inbox with ETags, truncation."""
import json
import os
import subprocess
import sys
import time
import unittest

from plugin_base import jsonl, slurp, IN, OUT, PLUGIN, PluginCase
import peer  # noqa: E402


class PeerTest(PluginCase):
    def patches(self):
        return [q for q in self.gh.requests if q["method"] == "PATCH"]

    def queue(self):
        p = os.path.join(self.state, "peer-outbox.jsonl")
        return jsonl(p) if os.path.exists(p) else []

    def test_the_first_send_goes_at_once_one_immutable_file_and_prunes_files_over_a_day_old_in_the_same_patch(self):
        now = time.time()
        old = "%s-0000000a.json" % peer.stamp(now - 25 * 3600)
        recent = "%s-0000000b.json" % peer.stamp(now - 23 * 3600)
        self.gh.gists[OUT] = {old: "{}", recent: "{}", "README.md": "# peer"}
        r = peer.send("is the mini awake? 🙂", re_id="abc12345", ts=now)
        self.assertTrue(r["ok"])
        self.assertEqual(r["status"], "sent")
        self.assertEqual(r["pruned"], [old])
        name = r["file"]
        self.assertRegex(name, r"^\d{8}T\d{6}Z-[0-9a-f]{8}\.json$")
        msg = json.loads(self.gh.gists[OUT][name])
        self.assertEqual({k: msg[k] for k in ("v", "from", "to", "text", "re")},
                         {"v": 1, "from": "housesitter@comet", "to": "ouroboros", "text": "is the mini awake? 🙂", "re": "abc12345"})
        self.assertEqual(msg["id"], r["id"])
        self.assertEqual(peer.parse_iso(msg["at"]), int(now))
        self.assertNotIn(old, self.gh.gists[OUT])
        self.assertIn(recent, self.gh.gists[OUT])
        self.assertIn("README.md", self.gh.gists[OUT])
        self.assertEqual(len(self.patches()), 1)
        self.assertEqual(set(self.patches()[0]["body"]["files"]), {old, name})
        self.assertIsNone(self.patches()[0]["body"]["files"][old])
        self.assertTrue(all(q["auth"] == "Bearer test-token" and q["ua"] for q in self.gh.requests))
        log = jsonl(os.path.join(self.state, "peer-log.jsonl"))
        self.assertEqual([(e["dir"], (e.get("msg") or {}).get("id")) for e in log], [("sent", r["id"]), ("flush", None)])
        self.assertEqual(self.queue(), [])

    def test_sends_inside_six_minutes_queue_then_go_together_in_one_patch_with_the_deletions(self):
        t0 = time.time()
        first = peer.send("first", ts=t0)
        self.assertEqual(first["status"], "sent")
        old = "%s-0000000a.json" % peer.stamp(t0 - 25 * 3600)
        self.gh.gists[OUT][old] = "{}"
        later = [peer.send("later %d" % i, ts=t0 + 10 * (i + 1)) for i in range(3)]
        self.assertEqual([r["status"] for r in later], ["queued"] * 3)
        self.assertEqual(later[-1]["queued"], 3)
        self.assertEqual(later[-1]["next_flush_at"], peer.iso(t0 + 360))
        self.assertEqual(len(self.patches()), 1)  # no write inside the window
        self.assertEqual([e["msg"]["id"] for e in self.queue()], [r["id"] for r in later])
        self.assertEqual(peer.flush_if_due(ts=t0 + 359)["sent"], [])
        self.assertEqual(len(self.patches()), 1)
        r = peer.flush_if_due(ts=t0 + 361)
        self.assertEqual(r["sent"], [x["id"] for x in later])
        self.assertEqual(r["pruned"], [old])
        self.assertEqual(len(self.patches()), 2)
        files = self.patches()[1]["body"]["files"]
        self.assertEqual(set(files), {old} | {x["file"] for x in later})
        self.assertIsNone(files[old])
        for x in later:
            m = json.loads(self.gh.gists[OUT][x["file"]])
            self.assertEqual((m["id"], m["at"]), (x["id"], x["at"]))
        self.assertNotIn(old, self.gh.gists[OUT])
        self.assertEqual(self.queue(), [])
        self.assertEqual(peer.flush_if_due(ts=t0 + 2000), {"ok": True, "sent": [], "queued": 0})
        self.assertEqual(len(self.patches()), 2)  # an empty queue writes nothing

    def test_an_urgent_send_goes_at_once_inside_the_window_and_takes_the_queue_with_it(self):
        t0 = time.time()
        peer.send("one", ts=t0)
        q = peer.send("two", ts=t0 + 20)
        u = peer.send("about to restart", now=True, ts=t0 + 30)
        self.assertEqual((q["status"], u["status"]), ("queued", "sent"))
        self.assertEqual(len(self.patches()), 2)
        self.assertEqual(set(self.patches()[1]["body"]["files"]), {q["file"], u["file"]})
        self.assertEqual(self.queue(), [])
        st = json.loads(slurp(os.path.join(self.state, "peer-flush.json")))
        self.assertEqual(st["writes"], [t0, t0 + 30])
        self.assertEqual(st["last"], t0 + 30)

    def test_a_bring_back_request_goes_at_once_as_free_text_with_do_ouro_up(self):
        r = peer.send("your daemon went quiet at 12:01; bringing it back", now=True, do="ouro-up", ts=time.time())
        self.assertEqual(r["status"], "sent")
        msg = json.loads(self.patches()[0]["body"]["files"][r["file"]]["content"])
        self.assertEqual((msg["do"], msg["text"]), ("ouro-up", "your daemon went quiet at 12:01; bringing it back"))
        plain = peer.send("hello", ts=time.time())
        self.assertNotIn("do", [e["msg"] for e in self.queue() if e["msg"]["id"] == plain["id"]][0])

    def test_during_a_planned_drill_everything_sent_is_labelled_and_after_it_nothing_is(self):
        now = time.time()
        peer.write_json(os.path.join(peer.state_dir(), "drill.json"), {"label": "battle test row 9", "until": peer.iso(now + 600)})
        r = peer.send("bring it back", now=True, do="ouro-up", ts=now)
        msg = json.loads(self.patches()[0]["body"]["files"][r["file"]]["content"])
        self.assertEqual(msg["text"], "[planned drill: battle test row 9] bring it back")
        self.assertEqual(peer.drill_text(msg["text"], "battle test row 9"), msg["text"])  # never twice
        self.assertIsNone(peer.drill_label(now + 601))
        later = peer.send("a real one", ts=now + 700)
        sent = [json.loads(f["content"]) for q in self.patches() for n, f in q["body"]["files"].items() if f and n == later["file"]]
        queued = [e["msg"] for e in self.queue() if e["msg"]["id"] == later["id"]]
        self.assertEqual([m["text"] for m in sent + queued], ["a real one"])

    def test_the_hourly_cap_keeps_messages_queued_logs_once_a_minute_and_lets_them_go_when_it_frees(self):
        t0 = time.time()
        for i in range(10):
            self.assertEqual(peer.send("urgent %d" % i, now=True, ts=t0 + i)["status"], "sent")
        r = peer.send("eleventh", now=True, ts=t0 + 20)
        self.assertEqual((r["status"], r["capped"], r["queued"]), ("queued", True, 1))
        self.assertEqual(r["next_allowed_at"], peer.iso(t0 + 3600))
        peer.send("twelfth", now=True, ts=t0 + 30)
        self.assertTrue(peer.flush(now=True, ts=t0 + 40)["capped"])
        self.assertEqual(len(self.patches()), 10)
        caps = lambda: [e for e in jsonl(os.path.join(self.state, "peer-log.jsonl")) if e.get("event") == "peer-cap"]
        self.assertEqual(len(caps()), 1)  # three refusals inside a minute: one audit line
        self.assertEqual({k: caps()[0][k] for k in ("at", "event", "queued", "next_allowed_at")},
                         {"at": peer.iso(t0 + 20), "event": "peer-cap", "queued": 1, "next_allowed_at": peer.iso(t0 + 3600)})
        self.assertEqual(peer.send("thirteenth", ts=t0 + 90)["status"], "queued")  # not due yet: no refusal, no line
        self.assertEqual(len(caps()), 1)
        peer.send("fourteenth", now=True, ts=t0 + 95)
        self.assertEqual([(e["queued"], e["at"]) for e in caps()], [(1, peer.iso(t0 + 20)), (4, peer.iso(t0 + 95))])
        self.assertEqual(len(self.queue()), 4)
        self.assertTrue(peer.flush_if_due(ts=t0 + 3599)["capped"])  # due, but the first write is not an hour old
        self.assertEqual(len(self.patches()), 10)
        done = peer.flush_if_due(ts=t0 + 3601)
        self.assertEqual(len(done["sent"]), 4)
        self.assertEqual(len(self.patches()), 11)
        self.assertEqual(self.queue(), [])

    def test_the_cadence_and_cap_come_from_the_environment(self):
        os.environ.update({"HOUSESITTER_PEER_FLUSH_SEC": "60", "HOUSESITTER_PEER_MAX_PER_HOUR": "2"})
        t0 = time.time()
        peer.send("a", ts=t0)
        self.assertEqual(peer.send("b", ts=t0 + 30)["next_flush_at"], peer.iso(t0 + 60))
        self.assertEqual(len(peer.flush_if_due(ts=t0 + 61)["sent"]), 1)
        self.assertTrue(peer.send("c", now=True, ts=t0 + 70)["capped"])

    def test_a_failed_write_keeps_the_messages_queued_and_counts_against_the_cap(self):
        os.environ["HOUSESITTER_PEER_OUT"] = "missing"
        t0 = time.time()
        r = peer.send("hello?", ts=t0)
        self.assertEqual(r["status"], "queued")
        self.assertIn("HTTP 404", r["error"])
        self.assertEqual(len(self.queue()), 1)
        os.environ["HOUSESITTER_PEER_OUT"] = OUT
        self.assertEqual(peer.flush_if_due(ts=t0 + 30)["sent"], [r["id"]])  # never flushed yet, so it's due
        self.assertIn(r["file"], self.gh.gists[OUT])
        st = json.loads(slurp(os.path.join(self.state, "peer-flush.json")))
        self.assertEqual(st["writes"], [t0, t0 + 30])

    def test_queued_messages_survive_a_restart(self):
        t0 = time.time()
        peer.send("before", ts=t0)
        q = peer.send("queued when the process died", ts=t0 + 5)
        self.assertEqual(q["status"], "queued")
        r = subprocess.run([sys.executable, os.path.join(PLUGIN, "peer.py"), "flush", "--now"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=os.environ)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["sent"], [q["id"]])
        self.assertEqual(json.loads(self.gh.gists[OUT][q["file"]])["text"], "queued when the process died")

    def test_inbox_flushes_what_is_due(self):
        t0 = time.time()
        peer.send("one", ts=t0 - 400)
        q = peer.send("two", ts=t0 - 300)
        self.assertEqual(q["status"], "queued")
        got = peer.inbox()
        self.assertEqual(got["outbox"]["sent"], [q["id"]])
        self.assertIn(q["file"], self.gh.gists[OUT])
        peer.inbox(mark=False)
        self.assertEqual(len(self.patches()), 2)

    def test_inbox_returns_new_messages_oldest_first_once_then_304_means_nothing_new(self):
        self.put_message(IN, "20261109T100500Z-00000002.json", {"v": 1, "id": "m2", "at": "2026-11-09T10:05:00Z", "from": "ouroboros@mini", "to": "housesitter", "text": "second"})
        self.put_message(IN, "20261109T100000Z-00000001.json", {"v": 1, "id": "m1", "at": "2026-11-09T10:00:00Z", "from": "ouroboros@mini", "to": "housesitter", "text": "first"})
        self.gh.gists[IN]["20261109T100100Z-00000003.json"] = "not json"
        self.gh.gists[IN]["notes.txt"] = "ignored"
        r = peer.inbox()
        self.assertEqual([m["text"] for m in r["messages"]], ["first", "second"])
        again = peer.inbox()
        self.assertEqual(again, {"ok": True, "messages": [], "unchanged": True})
        self.assertTrue(self.gh.requests[-1]["etag"])
        self.put_message(IN, "20261109T101000Z-00000004.json", {"v": 1, "id": "m4", "at": "2026-11-09T10:10:00Z", "text": "third, free text\nwith lines"})
        r3 = peer.inbox()
        self.assertEqual([m["id"] for m in r3["messages"]], ["m4"])
        self.assertEqual(json.loads(slurp(os.path.join(self.state, "peer-seen.json"))), ["m1", "m2", "m4"])
        log = jsonl(os.path.join(self.state, "peer-log.jsonl"))
        self.assertEqual([e["msg"]["id"] for e in log if e["dir"] == "received"], ["m1", "m2", "m4"])

    def test_inbox_fetches_raw_url_when_github_truncates_a_file(self):
        long_text = "x" * 5000
        name = "20261109T100000Z-0000000c.json"
        self.put_message(IN, name, {"v": 1, "id": "big", "at": "2026-11-09T10:00:00Z", "text": long_text})
        self.gh.truncate.add(name)
        r = peer.inbox()
        self.assertEqual(r["messages"][0]["text"], long_text)
        self.assertTrue(any(q["path"].startswith("/raw/") for q in self.gh.requests))

    def test_seen_set_keeps_the_last_500(self):
        os.makedirs(self.state, exist_ok=True)
        with open(os.path.join(self.state, "peer-seen.json"), "w") as f:
            json.dump(["old%d" % i for i in range(500)], f)
        self.put_message(IN, "20261109T100000Z-0000000d.json", {"v": 1, "id": "new", "at": "2026-11-09T10:00:00Z", "text": "hi"})
        peer.inbox()
        seen = json.loads(slurp(os.path.join(self.state, "peer-seen.json")))
        self.assertEqual(len(seen), 500)
        self.assertEqual(seen[-1], "new")
        self.assertNotIn("old0", seen)

    def test_token_falls_back_to_env(self):
        os.environ["HOUSESITTER_TOKEN_FILE"] = os.path.join(self.dir, "missing")
        os.environ["GH_TOKEN"] = "env-token"
        peer.inbox()
        self.assertEqual(self.gh.requests[-1]["auth"], "Bearer env-token")

    def test_errors(self):
        self.gh.fail = True
        with self.assertRaises(RuntimeError):
            peer.inbox()

    def test_cli(self):
        run = lambda *a: subprocess.run([sys.executable, os.path.join(PLUGIN, "peer.py")] + list(a), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=os.environ)
        s = run("send", "hello", "there", "--re", "r1")
        self.assertEqual(s.returncode, 0, s.stderr)
        sent = json.loads(s.stdout)
        msg = json.loads(self.gh.gists[OUT][sent["file"]])
        self.assertEqual((msg["text"], msg["re"]), ("hello there", "r1"))
        q = json.loads(run("send", "later").stdout)
        self.assertEqual(q["status"], "queued")
        u = json.loads(run("send", "now", "please", "--now").stdout)
        self.assertEqual(u["status"], "sent")
        self.assertEqual(json.loads(self.gh.gists[OUT][u["file"]])["text"], "now please")
        self.assertIn(q["file"], self.gh.gists[OUT])
        self.assertEqual(json.loads(run("flush").stdout)["queued"], 0)
        self.put_message(IN, "20261109T100000Z-0000000f.json", {"v": 1, "id": "q", "at": "2026-11-09T10:00:00Z", "text": "ok?"})
        i = json.loads(run("inbox").stdout)
        self.assertEqual([m["id"] for m in i["messages"]], ["q"])
        self.assertEqual(run().returncode, 2)


if __name__ == "__main__":
    unittest.main()
