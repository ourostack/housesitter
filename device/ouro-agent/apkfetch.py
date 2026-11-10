#!/usr/bin/env python3
"""Fetch an Alpine package and its runtime dependencies (aarch64) into a prefix, without apk. Usage: apkfetch.py <prefix> <pkg>..."""
import io, os, sys, tarfile, urllib.request
REL = os.environ.get("ALPINE", "v3.22")
ARCH = "aarch64"
REPOS = ["main", "community"]
idx = {}   # name -> record
prov = {}  # provided name -> package name
for repo in REPOS:
    base = "https://dl-cdn.alpinelinux.org/alpine/%s/%s/%s/" % (REL, repo, ARCH)
    data = urllib.request.urlopen(base + "APKINDEX.tar.gz", timeout=60).read()
    t = tarfile.open(fileobj=io.BytesIO(data))
    text = t.extractfile("APKINDEX").read().decode()
    for block in text.split("\n\n"):
        r = {}
        for line in block.splitlines():
            if len(line) > 2 and line[1] == ":":
                r.setdefault(line[0], line[2:])
        if "P" not in r:
            continue
        r["base"] = base
        idx.setdefault(r["P"], r)
        for p in r.get("p", "").split():
            prov.setdefault(p.split("=")[0], r["P"])
        prov.setdefault(r["P"], r["P"])
prefix = sys.argv[1]
want = list(sys.argv[2:])
skip = {"busybox", "ca-certificates-bundle", "ca-certificates", "perl", "git-perl"}
done = set()
while want:
    n = want.pop()
    n = n.split("=")[0].split(">")[0].split("<")[0].split("~")[0]
    if n.startswith("!"):
        continue
    pkg = prov.get(n)
    if not pkg or pkg in done or pkg in skip:
        continue
    done.add(pkg)
    r = idx[pkg]
    want.extend(r.get("D", "").split())
order = sorted(done)
total = 0
for pkg in order:
    r = idx[pkg]
    url = "%s%s-%s.apk" % (r["base"], pkg, r["V"])
    data = urllib.request.urlopen(url, timeout=120).read()
    total += len(data)
    # an .apk is concatenated gzip streams; tarfile reads the data stream after the signature and control streams
    import gzip, zlib
    raw = b""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    buf = data
    while buf:
        raw += d.decompress(buf)
        buf = d.unused_data
        d = zlib.decompressobj(16 + zlib.MAX_WBITS) if buf else d
    t = tarfile.open(fileobj=io.BytesIO(raw))
    for m in t.getmembers():
        if m.name.startswith(".") and "/" not in m.name:
            continue
        if m.name.startswith(("usr/share/man", "usr/share/doc", "usr/share/locale", "usr/share/perl5", "usr/share/git-core/templates/hooks")):
            continue
        try:
            t.extract(m, prefix, set_attrs=m.isdir() is False)
        except Exception as e:
            print("skip", m.name, e)
    print(pkg, r["V"], len(data))
print("packages", len(order), "bytes", total)
