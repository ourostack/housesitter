// Housesitter's MCP walker: the tools its Python MCP server (plugins/housesitter/mcp/server.py) lists. The built-in
// mcp-schemas walker loads a JavaScript module's getToolSchemas(); this server is Python, so the walker reads its
// syntax tree with Python's own parser (ax/walkers/py-tools.py, standard library only). Nothing imports or runs the
// server.
//
// `source` is the server. Each entry of its module-level `TOOLS = [(name, description, schema, timeout_ms, read_only)]`
// list is a door `mcp:<name>`, at the line of its name literal, described by its description; a `True` read-only flag,
// which the server serves as `readOnlyHint`, is the read-only evidence. A name that isn't a literal, a name listed
// twice, a file Python can't parse and a server with no tools are census errors, so the walker can't go blind. `module`
// is the Python command to run the reader with, `python3` when empty.
//
// `cards` is the sidecar, `{ "errors": [ErrorCard], "doors": [DoorCard] }`, where `errors` are the server's own (an
// `unknown-door` card, the answer to a tool name it doesn't serve). A card whose tool the server doesn't list is a
// census error. `handlers` are the Python files or folders that raise the codes: a card's code counts as raised when one
// of them holds it as a string constant outside a {"code", "means", "fix"} dict.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Door, DoorCard, ErrorCard, WalkerOptions, WalkResult } from "../scripts/ouro-census/types.mts";

const READER = join(dirname(fileURLToPath(import.meta.url)), "py-tools.py");
const firstLine = (error: unknown): string => String((error as Error)?.message ?? error).split("\n")[0];

interface Read {
  tools: { name: string; description: string; readOnly: boolean; line: number }[];
  literals: string[];
  errors: string[];
}

function readSidecar(root: string, path: string, errors: string[]): { errors: ErrorCard[]; doors: DoorCard[] } {
  let parsed: { errors?: unknown; doors?: unknown };
  try {
    parsed = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    errors.push(`${path}: can't read the cards: ${firstLine(error)}`);
    return { errors: [], doors: [] };
  }
  const doors = Array.isArray(parsed.doors) ? parsed.doors : [];
  if (!Array.isArray(parsed.doors) || doors.some((d) => typeof (d as DoorCard)?.id !== "string")) errors.push(`${path}: doors must be a list of cards, each with an id`);
  return { errors: Array.isArray(parsed.errors) ? (parsed.errors as ErrorCard[]) : [], doors: doors.filter((d) => typeof (d as DoorCard)?.id === "string") as DoorCard[] };
}

export async function walk(opts: WalkerOptions): Promise<WalkResult> {
  const file = relative(opts.root, resolve(opts.root, opts.source));
  const python = opts.module || "python3";
  let read: Read;
  try {
    read = JSON.parse(execFileSync(python, [READER, file, ...(opts.handlers ?? [])], { cwd: opts.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as Read;
  } catch (error) {
    return { doors: [], errors: [`${relative(opts.root, READER)}: couldn't run it with ${python}: ${firstLine(error)}`] };
  }
  const errors = [...read.errors];
  if (read.tools.length === 0 && !errors.some((e) => e.startsWith(`${file}:`))) errors.push(`${file}: lists no tools, so the walker finds nothing. Fix: point the source at the server that holds TOOLS.`);
  const sidecar = opts.cards ? readSidecar(opts.root, opts.cards, errors) : { errors: [], doors: [] };
  const literals = new Set(read.literals);
  const cards = new Map(sidecar.doors.map((card) => [card.id, card]));
  const doors: Door[] = [];
  const seen = new Set<string>();
  for (const tool of read.tools) {
    const id = `mcp:${tool.name}`;
    if (seen.has(id)) {
      errors.push(`${id}: listed twice in ${file}`);
      continue;
    }
    seen.add(id);
    const card = cards.get(id) ?? null;
    doors.push({
      id,
      kind: "mcp",
      product: opts.product,
      name: tool.name,
      description: tool.description,
      file,
      line: tool.line,
      card,
      evidence: {
        ...(tool.readOnly ? { readOnly: true } : {}),
        ...(card && Array.isArray(card.errors) && opts.handlers ? { raises: card.errors.map((e) => e?.code).filter((code) => typeof code === "string" && literals.has(code)) } : {}),
      },
    });
  }
  for (const id of cards.keys()) if (!seen.has(id)) errors.push(`${id}: a card in ${opts.cards} for a tool ${file} doesn't list. Fix: remove the card, or serve the tool.`);
  if (cards.size > 0) {
    if (!sidecar.errors.some((e) => e?.code === "unknown-door")) errors.push(`${opts.cards}: declares tool cards but no server errors with an unknown-door card, the answer to an unknown tool name`);
    else if (opts.handlers && !literals.has("unknown-door")) errors.push(`${opts.cards}: the unknown-door code is never raised in ${opts.handlers.join(", ")}`);
  }
  return { doors, errors };
}
