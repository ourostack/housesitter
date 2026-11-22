// Housesitter's CLI walker (ax/walkers/cli.mts), over command tables shaped like src/cli-table.mjs.
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { walk } from "../../ax/walkers/cli.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = relative(ROOT, join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli"));
const at = (file: string) => `${FIX}/${file}`;
const options = (more: Record<string, unknown> = {}) => ({ product: "housesitter", module: "", source: at("table.mjs"), root: ROOT, ...more });

test("each command a cmd() or defineCommand() call declares is a door at its name literal, described by its summary", async () => {
  const { doors, errors } = await walk(options());
  assert.deepEqual(errors, [`${at("table.mjs")}:8: a command whose name is not a literal, so the walker can't name its door`]);
  assert.deepEqual(
    doors.map((d) => [d.id, d.kind, d.product, d.name, d.description, d.file, d.line, d.card, d.evidence]),
    [
      ["cli:status", "cli", "housesitter", "status", "whether the KVM answers", at("table.mjs"), 4, null, { readOnly: true }],
      // A command other people see can't be declared a read.
      ["cli:unlock", "cli", "housesitter", "unlock", "ask the sitter to unlock the Mac", at("table.mjs"), 5, null, { mutates: "others" }],
      ["cli:peer send", "cli", "housesitter", "peer send", "send a message", at("table.mjs"), 6, null, { mutates: "others" }],
    ],
  );
});

test("a card from the sidecar is the door's card, and its codes count as raised when a handler holds them outside a card", async () => {
  const { doors, errors } = await walk(options({ source: at("twice.mjs") }));
  assert.deepEqual(errors, [`cli:a: declared twice in ${at("twice.mjs")}, at lines 1 and 1`]);
  assert.deepEqual(doors.map((d) => d.id), ["cli:a"]);
  const carded = await walk(options({ cards: at("cards.json"), handlers: [at("handlers")] }));
  const unlock = carded.doors.find((d) => d.id === "cli:unlock")!;
  assert.equal(unlock.card?.group, "mac-hands");
  assert.deepEqual(unlock.evidence, { mutates: "others", raises: ["sitter-refused"] });
  assert.equal(carded.doors.find((d) => d.id === "cli:status")!.card, null);
});

test("without handlers the walker can't tell what is raised, so it claims nothing either way", async () => {
  const { doors } = await walk(options({ cards: at("cards.json") }));
  assert.deepEqual(doors.find((d) => d.id === "cli:unlock")!.evidence, { mutates: "others" });
});

test("a card for a command the table doesn't declare, and a card without an id, are census errors", async () => {
  const { errors } = await walk(options({ cards: at("stale.json") }));
  assert.deepEqual(errors.slice(1), [
    `${at("stale.json")}: doors must be a list of cards, each with an id`,
    `cli:gone: a card in ${at("stale.json")} for a command ${at("table.mjs")} doesn't declare. Fix: remove the card, or declare the command.`,
  ]);
});

test("a CLI with cards needs an unknown-command error card, the kit's answer to a word it doesn't know, raised by its handlers", async () => {
  const missing = await walk(options({ cards: at("no-server.json") }));
  assert.deepEqual(missing.errors.slice(1), [`${at("no-server.json")}: declares command cards but no CLI errors with an unknown-command card, the answer to an unknown command`]);
  const unraised = await walk(options({ cards: at("cards.json"), handlers: [at("handlers/quiet.mjs")] }));
  assert.deepEqual(unraised.errors.slice(1), [`${at("cards.json")}: the unknown-command code is never raised in ${at("handlers/quiet.mjs")}`]);
});

test("a table with no commands and an unreadable sidecar are census errors, not an empty walk", async () => {
  const none = await walk(options({ source: at("none.mjs") }));
  assert.deepEqual(none.errors, [`${at("none.mjs")}: declares no commands, so the walker finds nothing. Fix: point the source at the command table.`]);
  const broken = await walk(options({ cards: at("broken.json") }));
  assert.equal(broken.errors.length, 2);
  assert.match(broken.errors[1], new RegExp(`^${at("broken.json")}: can't read the cards: `));
});
