"""A server shaped like plugins/housesitter/mcp/server.py."""
NAME = "computed"
TOOLS = [
    ("sitter_status", "The sitter's status.", {}, 60000, True),
    ("sitter_unlock", "Ask the sitter to " "unlock the Mac.", {}, 130000, False),
    ("peer_inbox", DESCRIPTION, {}),
    (NAME, "a name that is not a literal", {}, 1, True),
    "not a tuple",
]


def call(name):
    if name == "sitter_unlock":
        return {"ok": False, "code": "sitter-refused"}
    card = {"code": "only-in-a-card", "means": "a card, not a raise", "fix": "none"}
    return {"error": {"code": -32602, "data": {"code": "unknown-door"}}, "card": card}
