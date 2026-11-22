// Housesitter's MCP walker (ax/walkers/mcp.mts), over Python servers shaped like plugins/housesitter/mcp/server.py.
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { walk } from "../../ax/walkers/mcp.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = relative(ROOT, join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp"));
const at = (file: string) => `${FIX}/${file}`;
const options = (more: Record<string, unknown> = {}) => ({ product: "housesitter", module: "", source: at("server.py"), root: ROOT, ...more });

test("each TOOLS entry is a door at its name literal, with the served read-only flag as evidence", async () => {
  const { doors, errors } = await walk(options());
  assert.deepEqual(errors, [`${at("server.py")}:7: a tool whose name is not a literal`, `${at("server.py")}:8: a TOOLS entry that is not a (name, description, ...) tuple`]);
  assert.deepEqual(
    doors.map((d) => [d.id, d.kind, d.product, d.name, d.description, d.file, d.line, d.card, d.evidence]),
    [
      ["mcp:sitter_status", "mcp", "housesitter", "sitter_status", "The sitter's status.", at("server.py"), 4, null, { readOnly: true }],
      ["mcp:sitter_unlock", "mcp", "housesitter", "sitter_unlock", "Ask the sitter to unlock the Mac.", at("server.py"), 5, null, {}],
      // A description that isn't a literal is empty, and a short tuple has no read-only flag.
      ["mcp:peer_inbox", "mcp", "housesitter", "peer_inbox", "", at("server.py"), 6, null, {}],
    ],
  );
});

test("a card from the sidecar is the door's card, and its codes count as raised when a handler holds them outside a card", async () => {
  const { doors, errors } = await walk(options({ cards: at("cards.json"), handlers: [at("server.py")] }));
  assert.deepEqual(errors.slice(2), []);
  const unlock = doors.find((d) => d.id === "mcp:sitter_unlock")!;
  assert.equal(unlock.card?.group, "sitter-hands");
  assert.deepEqual(unlock.evidence, { raises: ["sitter-refused"] });
  assert.equal(doors.find((d) => d.id === "mcp:sitter_status")!.card, null);
  // Without handlers the walker can't tell what is raised, so it claims nothing either way.
  const blind = await walk(options({ cards: at("cards.json") }));
  assert.deepEqual(blind.doors.find((d) => d.id === "mcp:sitter_unlock")!.evidence, {});
});

test("a card for a tool the server doesn't list, a card without an id, and a server card that is missing or never raised are census errors", async () => {
  const stale = await walk(options({ cards: at("stale.json") }));
  assert.deepEqual(stale.errors.slice(2), [
    `${at("stale.json")}: doors must be a list of cards, each with an id`,
    `mcp:gone: a card in ${at("stale.json")} for a tool ${at("server.py")} doesn't list. Fix: remove the card, or serve the tool.`,
  ]);
  const missing = await walk(options({ cards: at("no-server.json") }));
  assert.deepEqual(missing.errors.slice(2), [`${at("no-server.json")}: declares tool cards but no server errors with an unknown-door card, the answer to an unknown tool name`]);
  const unraised = await walk(options({ cards: at("cards.json"), handlers: [at("quiet.py")] }));
  assert.deepEqual(unraised.errors.slice(2), [`${at("cards.json")}: the unknown-door code is never raised in ${at("quiet.py")}`]);
});

test("a name listed twice, a server with no tools, an unparseable file and an unreadable sidecar are census errors", async () => {
  const twice = await walk(options({ source: at("twice.py") }));
  assert.deepEqual(twice.doors.map((d) => d.id), ["mcp:a"]);
  assert.deepEqual(twice.errors, [`mcp:a: listed twice in ${at("twice.py")}`]);
  const none = await walk(options({ source: at("none.py") }));
  assert.deepEqual(none.errors, [`${at("none.py")}: lists no tools, so the walker finds nothing. Fix: point the source at the server that holds TOOLS.`]);
  const broken = await walk(options({ source: at("broken.py") }));
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0], new RegExp(`^${at("broken.py")}: can't parse it: `));
  const sidecar = await walk(options({ cards: at("broken.json") }));
  assert.match(sidecar.errors[2], new RegExp(`^${at("broken.json")}: can't read the cards: `));
});

test("a reader that can't run is a census error, not an empty walk", async () => {
  const { doors, errors } = await walk(options({ module: "no-such-python3" }));
  assert.deepEqual(doors, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^ax\/walkers\/py-tools\.py: couldn't run it with no-such-python3: /);
});
