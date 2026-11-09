"""A pretend iptables/ip6tables that keeps its chains, so ingress is read back the way the kernel would answer:
`-S` prints rules in iptables' own form (`-m tcp` added, conntrack states reordered). `*-restore --noflush` is one
transaction, as on the Comet: a declared chain is flushed, and a line the kernel refuses leaves every chain as it was."""

import copy


class FakeTables:
    def __init__(self, v6=True, drop_rule=None, lose_input=False, conntrack=True, refuse=None):
        self.chains = {t: {"INPUT": []} for t in ("iptables", "ip6tables")}
        self.v6, self.drop_rule, self.lose_input, self.conntrack, self.refuse = v6, drop_rule, lose_input, conntrack, refuse
        self.calls = []

    def _r(self, code=0, out="", err=""):
        return type("R", (), {"returncode": code, "stdout": out, "stderr": err})()

    def __call__(self, cmd, **k):
        self.calls.append(cmd)
        t, op = cmd[0], cmd[1]
        if t.startswith("ip6tables") and not self.v6:
            return self._r(1, err="modprobe: can't open 'modules.dep'")
        if t.endswith("-restore"):
            return self._restore(t[:-len("-restore")], k.get("input") or "")
        if t not in self.chains:
            return self._r()
        c = self.chains[t]
        if op == "-N":
            if cmd[2] in c:
                return self._r(1, err="Chain already exists")
            c[cmd[2]] = []
        elif op == "-F":
            c[cmd[2]] = []
        elif op == "-A":
            spec = list(cmd[3:])
            if "conntrack" in spec and not self.conntrack:
                return self._r(1, err="Warning: Extension conntrack revision 0 not supported, missing kernel module?")
            if self.refuse and all(w in spec for w in self.refuse):
                return self._r(1, err="iptables: No chain/target/match by that name.")
            if self.drop_rule and all(w in spec for w in self.drop_rule):
                return self._r()
            if "--dport" in spec:
                spec[spec.index("-p") + 2:spec.index("-p") + 2] = ["-m", "tcp"]
            if "ESTABLISHED,RELATED" in spec:
                spec[spec.index("ESTABLISHED,RELATED")] = "RELATED,ESTABLISHED"
            c[cmd[2]].append(spec)
        elif op == "-C":
            return self._r(0 if cmd[3:] in ([["-j", cmd[-1]]] and [r for r in c["INPUT"] if r == cmd[3:]]) else 1)
        elif op == "-I":
            if not self.lose_input:
                at = int(cmd[3]) - 1 if len(cmd) > 3 and cmd[3].isdigit() else 0
                c[cmd[2]].insert(at, list(cmd[4:] if cmd[3].isdigit() else cmd[3:]))
        elif op == "-D":
            spec = list(cmd[3:])
            if spec not in c.get(cmd[2], []):
                return self._r(1, err="Bad rule (does a matching rule exist in that chain?)")
            c[cmd[2]].remove(spec)
        elif op == "-S":
            name = cmd[2]
            lines = ["-N %s" % name] if name != "INPUT" else ["-P INPUT ACCEPT"]
            lines += ["-A %s %s" % (name, " ".join(r)) for r in c.get(name, [])]
            return self._r(out="\n".join(lines) + "\n")
        return self._r()

    def _restore(self, t, text):
        saved = copy.deepcopy(self.chains[t])
        for n, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if not line or line.startswith(("*", "#")) or line == "COMMIT":
                continue
            if line.startswith(":"):
                name = line[1:].split()[0]
                if name != "INPUT":
                    self.chains[t][name] = []
                continue
            r = self([t] + line.split())
            self.calls.pop()
            if r.returncode != 0:
                self.chains[t] = saved
                return self._r(1, err="%s\niptables-restore: line %d failed" % (r.stderr, n))
        return self._r()
