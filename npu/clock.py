"""The Mac's menu-bar clock, read on the KVM's NPU (see train_clock.py): crop the right end of the menu bar from the
frame's luma plane, scale it to the network's 32 rows, run, and decode. Standard library only.

    python3 clock.py sample <n> <every sec>   (spike: read the live screen, off the sitter's loop; prints JSON lines)
"""
import array
import json
import operator
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rknnrt import Model  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CHARS = "0123456789:. " + "abcdefghijklmnopqrstuvwxyz" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
H, W = 32, 192
CROP = (0.94, 1.0, 0.0, 0.0195)  # the menu bar's right end, where the time is
TIME = re.compile(r"(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?")


def crop_input(y, w, h, crop=CROP, W=W):
    """The menu bar's right end as the network's input: nearest-neighbour to 32 rows by aspect, black-padded to 416."""
    x0, x1 = int(crop[0] * w), int(crop[1] * w)
    y0, y1 = int(crop[2] * h), max(int(crop[2] * h) + 8, int(crop[3] * h))
    cw, ch = x1 - x0, y1 - y0
    ow = min(W, max(1, round(cw * H / ch)))
    pick = operator.itemgetter(*[x0 + min(cw - 1, int((i + 0.5) * cw / ow)) for i in range(ow)])
    pad = b"\x00" * (W - ow)
    rows = []
    for j in range(H):
        yy = y0 + min(ch - 1, int((j + 0.5) * ch / H))
        rows.append(bytes(pick(y[yy * w:(yy + 1) * w])) + pad)
    return b"".join(rows)


def decode(logits, classes, steps):
    """Greedy CTC over the network's (classes x steps) output, channel-major as the NPU returns it."""
    a = array.array("f")
    a.frombytes(logits[:classes * steps * 4])
    out, last = [], 0
    for t in range(steps):
        col = a[t::steps]
        k = col.index(max(col))
        if k != 0 and k != last:
            out.append(CHARS[k - 1] if k - 1 < len(CHARS) else "?")
        last = k
    return "".join(out)


def minutes(text):
    """The time the clock shows, as minutes since midnight (12-hour clocks need their AM/PM), or None."""
    m = TIME.search(text or "")
    if not m:
        return None
    hh, mm, ap = int(m.group(1)), int(m.group(2)), m.group(3)
    if ap:
        hh = hh % 12 + (12 if ap == "PM" else 0)
    return hh * 60 + mm if hh < 24 and mm < 60 else None


class ClockReader:
    def __init__(self, path=os.path.join(HERE, "clock.rknn")):
        self.m = Model(path)
        d = self.m.outputs[0].dims
        self.classes, self.steps = d[1], d[3]
        i = self.m.inputs[0].dims
        self.w = i[2]  # NHWC: 1, 32, W, 1

    def read(self, y, w, h):
        px = crop_input(y, w, h, W=self.w, crop=CROP if self.w == 192 else (0.86, 1.0, 0.0, 0.0195))
        (out, _), = self.m.run(px, want_float=True)
        return decode(out, self.classes, self.steps), self.m.run_ms


def sample(n, every):
    sys.path.insert(0, "/etc/kvmd/user/housesitter")
    import sitter as S
    cfg = S.load("config.json", {})
    kvmd = S.Kvmd(cfg.get("kvmd_socket", "/run/kvmd/kvmd.sock"), cfg.get("kvmd_user", "admin"), S.load_secret("kvmd") or "")
    t0 = time.time()
    r = ClockReader()
    load_ms = (time.time() - t0) * 1000
    print(json.dumps({"load_ms": round(load_ms, 1), "out": list(r.m.outputs[0].dims[:r.m.outputs[0].n_dims]), "mem": r.m.mem()}), flush=True)
    for i in range(n):
        t = time.time()
        rec = {"i": i, "utc": time.strftime("%H:%M:%S", time.gmtime(t))}
        try:
            raw = S.frame_raw(kvmd)
            rec["grab_ms"] = round((time.time() - t) * 1000)
            if raw:
                y, w, h = raw
                f = S.frame_features(y, w, h)
                rec["kind"] = S.classify_frame(f)
                rec["sig"] = S.clock_sig(y, w, h)
                t1 = time.time()
                txt, npu = r.read(y, w, h)
                rec.update(text=txt, minutes=minutes(txt), npu_ms=round(npu, 2), read_ms=round((time.time() - t1) * 1000, 1), size=[w, h])
                if "--keep-crops" in sys.argv:
                    rec["crop_b64"] = __import__("base64").b64encode(crop_input(y, w, h, W=r.w)).decode()
        except Exception as e:  # noqa: BLE001
            rec["error"] = str(e)[:160]
        for ln in open("/proc/self/status"):
            if ln.startswith("VmRSS:"):
                rec["rss_kb"] = int(ln.split()[1])
        print(json.dumps(rec), flush=True)
        time.sleep(max(0, every - (time.time() - t)))


if __name__ == "__main__":
    if sys.argv[1:2] == ["sample"]:
        sample(int(sys.argv[2]), float(sys.argv[3]))
