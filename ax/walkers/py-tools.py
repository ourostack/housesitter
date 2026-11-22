"""Read a Python MCP server's tool list from its syntax tree, for ax/walkers/mcp.mts. Nothing here imports or runs it.

    python3 py-tools.py <server.py> [<handler file or folder> ...]

Prints one JSON object: "tools", each {"name", "description", "readOnly", "line"} from the module-level
`TOOLS = [(name, description, schema, timeout_ms, read_only), ...]` list, and "literals", every string constant in the
handler files outside a {"code", "means", "fix"} dict. A file it can't parse is an "errors" entry, not an exception.
"""
import ast
import json
import os
import sys


def tools_of(path, errors):
    try:
        tree = ast.parse(open(path, encoding="utf-8").read(), path)
    except (OSError, SyntaxError) as e:
        errors.append("%s: can't parse it: %s" % (path, str(e).splitlines()[0]))
        return []
    found = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "TOOLS" for t in node.targets) and isinstance(node.value, ast.List):
            for elt in node.value.elts:
                if not isinstance(elt, ast.Tuple) or len(elt.elts) < 2:
                    errors.append("%s:%d: a TOOLS entry that is not a (name, description, ...) tuple" % (path, elt.lineno))
                    continue
                try:
                    name = ast.literal_eval(elt.elts[0])
                except ValueError:
                    name = None
                if not isinstance(name, str) or not name:
                    errors.append("%s:%d: a tool whose name is not a literal" % (path, elt.lineno))
                    continue
                try:
                    description = ast.literal_eval(elt.elts[1])
                except ValueError:
                    description = ""
                last = elt.elts[-1]
                found.append({"name": name, "description": description if isinstance(description, str) else "",
                              "readOnly": len(elt.elts) >= 5 and isinstance(last, ast.Constant) and last.value is True,
                              "line": elt.elts[0].lineno})
    return found


def is_card(node):
    return isinstance(node, ast.Dict) and {"code", "means", "fix"} <= {k.value for k in node.keys if isinstance(k, ast.Constant)}


def literals_of(path, out, errors):
    try:
        tree = ast.parse(open(path, encoding="utf-8").read(), path)
    except (OSError, SyntaxError) as e:
        errors.append("%s: can't parse it: %s" % (path, str(e).splitlines()[0]))
        return

    def visit(node):
        if is_card(node):
            return
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.add(node.value)
        for child in ast.iter_child_nodes(node):
            visit(child)
    visit(tree)


def py_files(path):
    if not os.path.isdir(path):
        return [path]
    files = []
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = sorted(d for d in dirnames if d not in ("__pycache__", "fixtures"))
        files += [os.path.join(dirpath, f) for f in sorted(filenames) if f.endswith(".py")]
    return files


def main(argv):
    errors = []
    tools = tools_of(argv[1], errors)
    literals = set()
    for handler in argv[2:]:
        for f in py_files(handler):
            literals_of(f, literals, errors)
    print(json.dumps({"tools": tools, "literals": sorted(literals), "errors": errors}))


if __name__ == "__main__":
    main(sys.argv)
