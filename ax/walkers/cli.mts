// Housesitter's CLI walker: the commands its command table declares with the Ouro AX kit, read from the table's syntax
// tree, never run. The built-in walkers don't fit: argv-entries and ts-parser read TypeScript, and src/cli-table.mjs is
// JavaScript whose commands are `cmd({ ... })` calls (cmd wraps the kit's defineCommand).
//
// `source` is the table. Each `cmd({ name: '<words>', ... })` or `defineCommand({ ... })` call is a door
// `cli:<words>`, at the line of its name literal, described by its `summary`. Its evidence is the table's own: `readOnly:
// true` is read-only, and `effect: 'others'` (the kit asks for --why, since other people see it) mutates others, so such
// a command can't be declared a read. A command whose name isn't a literal, a name declared twice, and a table with no
// commands at all are census errors: without that the walker could go blind and the census would then ask for the doors
// to come off the baseline.
//
// `cards` is the sidecar, `{ "errors": [ErrorCard], "doors": [DoorCard] }`. `errors` are the CLI's own: an
// `unknown-command` card, the code the kit (lib/ouro-ui/registry/ouro/ax/ax-command.ts) answers a word it doesn't know
// with, which is what the census's unknown-door card stands for here. A card whose command the table doesn't declare is
// a census error. `handlers` are the files or folders that raise the codes: a card's code counts as raised when one of
// them holds it as a string literal outside an error card.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, DoorCard, ErrorCard, WalkerOptions, WalkResult } from "../scripts/ouro-census/types.mts";

const SCRIPT = /\.[cm]?[jt]s$/;
const SKIP = new Set(["node_modules", "__tests__", "fixtures"]);
const CALLS = new Set(["cmd", "defineCommand"]);

const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const keyText = (name: ts.PropertyName | undefined): string | null => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null);
const firstLine = (error: unknown): string => String((error as Error)?.message ?? error).split("\n")[0];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

interface Command {
  name: string;
  summary: string;
  readOnly: boolean;
  others: boolean;
  line: number;
}

function commands(path: string, file: string, errors: string[]): Command[] {
  const sf = parse(path);
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const found: Command[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CALLS.has(node.expression.text)) {
      const [arg] = node.arguments;
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const prop = (key: string) => arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && keyText(p.name) === key)?.initializer;
        const name = prop("name");
        if (name && isText(name)) {
          const summary = prop("summary");
          const effect = prop("effect");
          found.push({
            name: name.text,
            summary: summary && isText(summary) ? summary.text : "",
            readOnly: prop("readOnly")?.kind === ts.SyntaxKind.TrueKeyword,
            others: !!effect && isText(effect) && effect.text === "others",
            line: lineOf(name),
          });
        } else if (name) errors.push(`${file}:${lineOf(name)}: a command whose name is not a literal, so the walker can't name its door`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function scriptFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? (SKIP.has(e.name) ? [] : scriptFiles(join(path, e.name))) : SCRIPT.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name) ? [join(path, e.name)] : []));
}

/** Every string literal in the handler files, outside error cards. */
function raisedLiterals(root: string, handlers: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const handler of handlers) {
    for (const file of scriptFiles(resolve(root, handler))) {
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const keys = new Set(node.properties.map((p) => keyText(p.name)));
          if (keys.has("code") && keys.has("means") && keys.has("fix")) return;
        }
        if (isText(node)) found.add(node.text);
        ts.forEachChild(node, visit);
      };
      visit(parse(file));
    }
  }
  return found;
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
  const sourcePath = resolve(opts.root, opts.source);
  const file = relative(opts.root, sourcePath);
  const errors: string[] = [];
  const found = commands(sourcePath, file, errors);
  if (found.length === 0) errors.push(`${file}: declares no commands, so the walker finds nothing. Fix: point the source at the command table.`);
  const sidecar = opts.cards ? readSidecar(opts.root, opts.cards, errors) : { errors: [], doors: [] };
  const literals = raisedLiterals(opts.root, opts.handlers ?? []);
  const cards = new Map(sidecar.doors.map((card) => [card.id, card]));
  const doors: Door[] = [];
  const lines = new Map<string, number>();
  for (const c of found) {
    const id = `cli:${c.name}`;
    const first = lines.get(id);
    if (first !== undefined) {
      errors.push(`${id}: declared twice in ${file}, at lines ${first} and ${c.line}`);
      continue;
    }
    lines.set(id, c.line);
    const card = cards.get(id) ?? null;
    doors.push({
      id,
      kind: "cli",
      product: opts.product,
      name: c.name,
      description: c.summary,
      file,
      line: c.line,
      card,
      evidence: {
        ...(c.readOnly ? { readOnly: true } : {}),
        ...(c.others ? { mutates: "others" } : {}),
        ...(card && Array.isArray(card.errors) && opts.handlers ? { raises: card.errors.map((e) => e?.code).filter((code) => typeof code === "string" && literals.has(code)) } : {}),
      },
    });
  }
  for (const id of cards.keys()) if (!lines.has(id)) errors.push(`${id}: a card in ${opts.cards} for a command ${file} doesn't declare. Fix: remove the card, or declare the command.`);
  if (cards.size > 0) {
    if (!sidecar.errors.some((e) => e?.code === "unknown-command")) errors.push(`${opts.cards}: declares command cards but no CLI errors with an unknown-command card, the answer to an unknown command`);
    else if (opts.handlers && !literals.has("unknown-command")) errors.push(`${opts.cards}: the unknown-command code is never raised in ${opts.handlers.join(", ")}`);
  }
  return { doors, errors };
}
