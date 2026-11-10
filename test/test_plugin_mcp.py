"""The plugin's MCP server (plugins/housesitter/mcp/server.py) over real stdio, with a fake sitter and a fake gist API."""
import base64
import json
import os
import subprocess
import sys
import time
import unittest

from plugin_base import slurp, FLEET, IN, OUT, PLUGIN, ROOT, PluginCase, iso

SERVER = os.path.join(PLUGIN, "mcp", "server.py")
TOOLS = {"sitter_status", "sitter_look", "sitter_screenshot", "sitter_unlock", "sitter_want_desktop", "sitter_power_cycle", "sitter_power_on",
         "sitter_click", "sitter_type", "sitter_key", "sitter_scroll", "peer_send", "peer_inbox", "kvm_health"}
JPEG = b"\xff\xd8\xff\xe0fake-jpeg-frame\xff\xd9"


class McpTest(PluginCase):
    def rpc(self, *msgs):
        """Send these JSON-RPC messages to a fresh server, close stdin, and return the replies by id."""
        lines = "".join(json.dumps(m) + "\n" for m in msgs)
        r = subprocess.run([sys.executable, SERVER], input=lines.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=PLUGIN, env=os.environ, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        out = [json.loads(ln) for ln in r.stdout.decode().splitlines() if ln.strip()]
        return {m.get("id"): m for m in out}

    def call(self, name, args=None):
        rep = self.rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args or {}}})[1]["result"]
        return json.loads(rep["content"][0]["text"]), rep

    def test_handshake_and_tool_list(self):
        r = self.rpc(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "ouro"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "ping"},
            {"jsonrpc": "2.0", "id": 4, "method": "resources/list"},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "nope"}},
        )
        self.assertEqual(sorted(r), [1, 2, 3, 4, 5])  # the notification got no reply
        send = [t for t in r[2]["result"]["tools"] if t["name"] == "peer_send"][0]
        self.assertEqual(send["inputSchema"]["properties"]["now"]["type"], "boolean")
        self.assertIn("10/h cap", send["inputSchema"]["properties"]["now"]["description"])
        init = r[1]["result"]
        self.assertEqual(init["protocolVersion"], "2025-03-26")
        self.assertIn("tools", init["capabilities"])
        self.assertEqual(init["serverInfo"]["name"], "housesitter")
        self.assertEqual(init["serverInfo"]["version"], json.loads(slurp(os.path.join(ROOT, "package.json")))["version"])
        tools = r[2]["result"]["tools"]
        self.assertEqual({t["name"] for t in tools}, TOOLS)
        for t in tools:
            self.assertEqual(t["inputSchema"]["type"], "object")
            self.assertGreaterEqual(t["_meta"]["ouro.bot/timeoutMs"], 10000)
        self.assertEqual(r[3]["result"], {})
        self.assertEqual(r[4]["error"]["code"], -32601)
        self.assertEqual(r[5]["error"]["code"], -32602)
        no_version = self.rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})[1]["result"]
        self.assertEqual(no_version["protocolVersion"], "2025-06-18")

    def test_it_answers_each_line_while_stdin_stays_open(self):
        p = subprocess.Popen([sys.executable, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=PLUGIN, env=os.environ)
        try:
            p.stdin.write(b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n')
            p.stdin.flush()
            self.assertEqual(json.loads(p.stdout.readline())["id"], 1)
            p.stdin.write(b'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sitter_key","arguments":{"combo":"return"}}}\n')
            p.stdin.flush()
            self.assertEqual(json.loads(json.loads(p.stdout.readline())["result"]["content"][0]["text"])["result"]["op"], "key")
        finally:
            p.stdin.close()
            p.wait(timeout=30)
            p.stdout.close()
            p.stderr.close()

    def test_each_hand_maps_to_its_sitter_op_with_its_args(self):
        cases = [
            ("sitter_click", {"x": 10, "y": 20, "w": 1280, "h": 720, "button": "right", "double": True}, "click", {"x": 10, "y": 20, "w": 1280, "h": 720, "button": "right", "double": True}),
            ("sitter_click", {"x": 5, "y": 6}, "click", {"x": 5, "y": 6}),
            ("sitter_type", {"text": "Activity Monitor"}, "type", {"text": "Activity Monitor"}),
            ("sitter_key", {"combo": "cmd+space"}, "key", {"combo": "cmd+space"}),
            ("sitter_scroll", {"dx": 0, "dy": -3, "x": 100, "y": 200}, "scroll", {"dx": 0, "dy": -3, "x": 100, "y": 200}),
            ("sitter_unlock", {}, "unlock", {}),
            ("sitter_want_desktop", {"minutes": 5}, "want_desktop", {"minutes": 5, "by": "housesitter"}),
            ("sitter_power_cycle", {}, "power_cycle", {}),
            ("sitter_power_on", {}, "power_on", {}),
        ]
        for tool, args, op, sent in cases:
            open(self.sitter_log, "w").close()
            got, rep = self.call(tool, args)
            self.assertFalse(rep["isError"])
            self.assertEqual(got, {"ok": True, "result": {"op": op, "args": sent}}, tool)
            self.assertEqual([(c["argv1"], c["op"], c["args"]) for c in self.sitter_calls()], [("do", op, sent)], tool)

    def test_refusals_come_back_verbatim(self):
        os.environ["FAKE_SITTER_REFUSE"] = "type"
        got, rep = self.call("sitter_type", {"text": "hello"})
        self.assertEqual(got, {"ok": False, "code": "action-unavailable", "result": "the Mac is at a password screen; only the sitter types there"})
        self.assertFalse(rep["isError"])

    def test_a_sitter_that_cannot_run_is_an_answer_not_a_crash(self):
        os.environ["HOUSESITTER_SITTER_CMD"] = os.path.join(self.dir, "no-such-sitter")
        got, _ = self.call("sitter_key", {"combo": "return"})
        self.assertEqual((got["ok"], got["code"]), (False, "action-failed"))

    def test_screenshot_returns_the_full_image_and_saves_it(self):
        got, rep = self.call("sitter_screenshot", {"width": 800})
        self.assertEqual(self.sitter_calls()[0]["args"], {"width": 800})
        img = rep["content"][1]
        self.assertEqual((img["type"], img["mimeType"]), ("image", "image/jpeg"))
        self.assertEqual(base64.b64decode(img["data"]), JPEG)
        self.assertEqual(got["label"], "screenshot")
        self.assertTrue(got["at"])
        self.assertNotIn("files", got)
        self.assertEqual(slurp(got["image"]["path"], "rb"), JPEG)
        self.assertTrue(got["image"]["path"].startswith(os.path.join(self.state, "screens")))

    def test_look_is_a_fresh_look_then_a_frame(self):
        got, rep = self.call("sitter_look")
        self.assertEqual([c["op"] for c in self.sitter_calls()], ["look", "screenshot"])
        self.assertEqual(got["label"], "look")
        self.assertEqual(got["look"]["result"]["obs"]["screen"], "desktop")
        self.assertEqual(base64.b64decode(rep["content"][1]["data"]), JPEG)

    def test_status_has_the_sitter_and_the_mini_heartbeat_and_simulate_changes_nothing(self):
        got, _ = self.call("sitter_status")
        self.assertEqual(got["sitter"]["result"]["state"], "healthy")
        self.assertEqual(got["mini"]["file"], "aris-mac-mini.json")
        self.assertFalse(got["mini"]["stale"])
        self.assertLess(got["mini"]["age_min"], 2)
        self.assertEqual(got["mini"]["summary"]["uptime_min"], 300)
        self.assertNotIn("simulated", got)
        before = json.dumps(self.gh.gists, sort_keys=True)
        sim, _ = self.call("sitter_status", {"simulate": "stale-heartbeat"})
        self.assertTrue(sim["simulated"])
        self.assertTrue(sim["mini"]["stale"])
        self.assertGreater(sim["mini"]["age_min"], 15)
        self.assertEqual(sim["sitter"], got["sitter"])
        self.assertEqual(json.dumps(self.gh.gists, sort_keys=True), before)
        self.assertFalse([q for q in self.gh.requests if q["method"] != "GET"])
        self.assertEqual({c["op"] for c in self.sitter_calls()}, {"status"})
        _, bad = self.call("sitter_status", {"simulate": "fire"})
        self.assertTrue(bad["isError"])

    def test_status_says_when_the_mini_heartbeat_is_old(self):
        self.gh.gists[FLEET]["aris-mac-mini.json"] = json.dumps({"at": iso(time.time() - 3600)})
        got, _ = self.call("sitter_status")
        self.assertTrue(got["mini"]["stale"])
        self.assertGreater(got["mini"]["age_min"], 59)

    def test_kvm_health(self):
        proc = os.path.join(self.dir, "proc")
        os.makedirs(proc)
        with open(os.path.join(proc, "meminfo"), "w") as f:
            f.write("MemTotal:        1010688 kB\nMemFree:          100000 kB\nMemAvailable:     614400 kB\n")
        with open(os.path.join(proc, "loadavg"), "w") as f:
            f.write("0.52 0.40 0.31 1/123 4567\n")
        with open(os.path.join(proc, "uptime"), "w") as f:
            f.write("7260.12 20000.00\n")
        os.environ.update({"HOUSESITTER_PROC": proc, "HOUSESITTER_DISK": self.dir})
        self.write_status(age=400, interval=60)
        got, _ = self.call("kvm_health")
        self.assertEqual(got["mem"]["available_mb"], 600)
        self.assertEqual(got["mem"]["total_mb"], 987)
        self.assertEqual(got["load"], [0.52, 0.40, 0.31])
        self.assertEqual(got["uptime_min"], 121)
        self.assertGreater(got["disk"]["free_mb"], 0)
        self.assertTrue(got["sitter"]["stale"])
        self.assertGreaterEqual(got["sitter"]["age_sec"], 399)
        self.assertEqual(got["sitter"]["state"], "healthy")
        self.write_status(age=5)
        fresh, _ = self.call("kvm_health")
        self.assertFalse(fresh["sitter"]["stale"])

    def test_peer_tools(self):
        sent, _ = self.call("peer_send", {"text": "which sessions resumed?", "re": "x1"})
        self.assertEqual(sent["status"], "sent")
        msg = json.loads(self.gh.gists[OUT][sent["file"]])
        self.assertEqual((msg["text"], msg["to"], msg["re"]), ("which sessions resumed?", "ouroboros", "x1"))
        queued, _ = self.call("peer_send", {"text": "and the browser?"})
        self.assertEqual(queued["status"], "queued")
        self.assertNotIn(queued["file"], self.gh.gists[OUT])
        urgent, _ = self.call("peer_send", {"text": "about to restart", "now": True})
        self.assertEqual(urgent["status"], "sent")
        self.assertIn(queued["file"], self.gh.gists[OUT])
        self.assertEqual(len([q for q in self.gh.requests if q["method"] == "PATCH"]), 2)
        self.put_message(IN, "20261109T100000Z-00000001.json", {"v": 1, "id": "a1", "at": "2026-11-09T10:00:00Z", "text": "three resumed"})
        got, _ = self.call("peer_inbox")
        self.assertEqual([m["text"] for m in got["messages"]], ["three resumed"])
        again, _ = self.call("peer_inbox")
        self.assertEqual(again["messages"], [])
        _, bad = self.call("peer_send", {"text": ""})
        self.assertTrue(bad["isError"])

    def test_mcp_json_runs_the_server_from_the_plugin_dir(self):
        m = json.loads(slurp(os.path.join(PLUGIN, ".mcp.json")))["mcpServers"]["housesitter"]
        self.assertEqual((m["type"], m["command"], m["args"]), ("stdio", "python3", ["mcp/server.py"]))
        self.assertTrue(os.path.exists(os.path.join(PLUGIN, m["args"][0])))
        for k, v in m["env"].items():
            self.assertTrue(v.startswith("${%s:-" % k) and v.endswith("}"), k)
        self.assertTrue(os.path.exists(os.path.join(PLUGIN, ".claude-plugin", "plugin.json")))
        skill = slurp(os.path.join(PLUGIN, "skills", "housesitter", "SKILL.md"))
        self.assertTrue(skill.startswith("---\nname: housesitter\ndescription: "))
        for t in TOOLS:
            self.assertIn(t, skill)


if __name__ == "__main__":
    unittest.main()
