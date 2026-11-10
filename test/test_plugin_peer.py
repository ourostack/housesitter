"""The peer link (plugins/housesitter/peer.py) against a fake gist API: send, prune, inbox with ETags, truncation."""
import json
import os
import subprocess
import sys
import time
import unittest

from plugin_base import jsonl, slurp, IN, OUT, PLUGIN, PluginCase
import peer  # noqa: E402


class PeerTest(PluginCase):
    def test_send_writes_one_immutable_file_and_prunes_files_over_a_day_old_in_the_same_patch(self):
        now = time.time()
        old = "%s-0000000a.json" % peer.stamp(now - 25 * 3600)
        recent = "%s-0000000b.json" % peer.stamp(now - 23 * 3600)
        self.gh.gists[OUT] = {old: "{}", recent: "{}", "README.md": "# peer"}
        r = peer.send("is the mini awake? 🙂", re_id="abc12345", now=now)
        self.assertTrue(r["ok"])
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
        patches = [q for q in self.gh.requests if q["method"] == "PATCH"]
        self.assertEqual(len(patches), 1)
        self.assertEqual(set(patches[0]["body"]["files"]), {old, name})
        self.assertIsNone(patches[0]["body"]["files"][old])
        self.assertTrue(all(q["auth"] == "Bearer test-token" and q["ua"] for q in self.gh.requests))
        log = jsonl(os.path.join(self.state, "peer-log.jsonl"))
        self.assertEqual([(e["dir"], e["msg"]["id"]) for e in log], [("sent", r["id"])])

    def test_send_needs_text(self):
        with self.assertRaises(ValueError):
            peer.send("")

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

    def test_prune_and_errors(self):
        self.gh.gists[OUT] = {"%s-0000000e.json" % peer.stamp(time.time() - 2 * 86400): "{}"}
        self.assertEqual(len(peer.prune()["pruned"]), 1)
        self.assertEqual(self.gh.gists[OUT], {})
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
        self.put_message(IN, "20261109T100000Z-0000000f.json", {"v": 1, "id": "q", "at": "2026-11-09T10:00:00Z", "text": "ok?"})
        i = json.loads(run("inbox").stdout)
        self.assertEqual([m["id"] for m in i["messages"]], ["q"])
        self.assertEqual(run().returncode, 2)


if __name__ == "__main__":
    unittest.main()
