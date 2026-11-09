"""Reading the Mac's screen on the KVM's NPU: PP-OCRv4 text detection and recognition (from Rockchip's rknn_model_zoo,
converted for the RV1126B in CI), with the pre- and post-processing in plain Python so nothing is installed on the KVM.

    python3 ocr.py <frame.jpg|.png> [--det det.rknn] [--rec rec.rknn] [--keys keys.txt]

ffmpeg (already on the KVM) decodes and scales the picture; the NPU finds text and reads it; Python only thresholds,
groups and decodes."""
import array
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rknn import FLOAT32, UINT8, Model, attr_dict  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def luma_rows(y, w, h, ow, oh):
    """Nearest-neighbour resample of a luma plane to ow x oh (C-speed: itemgetter picks the columns of each row)."""
    import operator
    pick = operator.itemgetter(*[min(w - 1, int((i + 0.5) * w / ow)) for i in range(ow)])
    return b"".join(bytes(pick(y[yy * w:(yy + 1) * w])) for yy in (min(h - 1, int((j + 0.5) * h / oh)) for j in range(oh)))


def gray3(g):
    """Grey bytes as rgb24: the same byte in all three channels. Text reads as well in grey, and the KVM gets the
    picture as YUV, so the luma plane is free and colour would cost a conversion its ffmpeg can't do (no swscale)."""
    out = bytearray(len(g) * 3)
    out[0::3] = g
    out[1::3] = g
    out[2::3] = g
    return bytes(out)


def threshold_table(attr, thresh):
    """For an int8 output: a bytes.translate table mapping each raw byte to 1 (above thresh) or 0."""
    zp, scale = attr["zp"], attr["scale"] or 1.0
    return bytes(1 if ((b - 256 if b > 127 else b) - zp) * scale > thresh else 0 for b in range(256))


def boxes_from_mask(mask, w, h, min_area=12):
    """Connected runs of 1s, row by row (union-find over horizontal runs): [(x0, y0, x1, y1, pixels)]."""
    parent, box = [], []

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    prev = []
    one = re.compile(b"\x01+")
    for y in range(h):
        row = mask[y * w:(y + 1) * w]
        cur = []
        for m in one.finditer(row):
            a, b = m.start(), m.end()
            i = len(parent)
            parent.append(i)
            box.append([a, y, b, y + 1, b - a])
            for (pa, pb, pi) in prev:
                if pa < b and a < pb:
                    ra, rb = find(pi), find(i)
                    if ra != rb:
                        parent[rb] = ra
                        A, B = box[ra], box[rb]
                        box[ra] = [min(A[0], B[0]), min(A[1], B[1]), max(A[2], B[2]), max(A[3], B[3]), A[4] + B[4]]
            cur.append((a, b, i))
        prev = cur
    out = {}
    for i in range(len(parent)):
        r = find(i)
        if r == i:
            out[r] = box[r]
    return [tuple(b) for b in out.values() if b[4] >= min_area and (b[2] - b[0]) >= 3 and (b[3] - b[1]) >= 3]


def unclip(b, ratio=1.5):
    x0, y0, x1, y1 = b[:4]
    w, h = x1 - x0, y1 - y0
    d = w * h * ratio / (2 * (w + h))
    return (x0 - d, y0 - d, x1 + d, y1 + d)


def crop_resize(y, iw, ih, box, th=48, tw=320):
    """Nearest-neighbour crop of the luma plane to th rows, width by aspect (at most tw), black-padded to tw; rgb24."""
    import operator
    x0, y0, x1, y1 = (max(0, int(box[0])), max(0, int(box[1])), min(iw, int(box[2] + 0.999)), min(ih, int(box[3] + 0.999)))
    cw, ch = max(1, x1 - x0), max(1, y1 - y0)
    ow = max(1, min(tw, int(round(cw * th / ch))))
    pick = operator.itemgetter(*[x0 + min(cw - 1, int((i + 0.5) * cw / ow)) for i in range(ow)] + [x0] * 0)
    pad = b"\x00" * (tw - ow)
    rows = []
    for j in range(th):
        yy = y0 + min(ch - 1, int((j + 0.5) * ch / th))
        r = pick(y[yy * iw:(yy + 1) * iw])
        rows.append((bytes(r) if isinstance(r, tuple) else bytes([r])) + pad)
    return gray3(b"".join(rows)), ow


def ctc(out_bytes, steps, classes, keys):
    """Greedy CTC: the best class at each step, repeats collapsed, blanks (0) dropped. Returns (text, mean confidence)."""
    a = array.array("f")
    a.frombytes(out_bytes[:steps * classes * 4])
    text, last, confs = [], 0, []
    for t in range(steps):
        row = a[t * classes:(t + 1) * classes]
        m = max(row)
        k = row.index(m)
        if k != 0 and k != last:
            text.append(keys[k - 1] if k - 1 < len(keys) else " ")
            confs.append(m)
        last = k
    return "".join(text), (sum(confs) / len(confs) if confs else 0.0)


class Reader:
    def __init__(self, det=os.path.join(HERE, "det.rknn"), rec=os.path.join(HERE, "rec.rknn"), keys=os.path.join(HERE, "ppocr_keys_v1.txt")):
        self.det, self.rec = Model(det), Model(rec)
        self.keys = [ln.rstrip("\n") for ln in open(keys, encoding="utf-8")] + [" "]
        di = self.det.inputs[0]
        d = list(di.dims[:di.n_dims])
        self.dh, self.dw = (d[1], d[2]) if di.fmt == 1 else (d[2], d[3])
        ri = self.rec.inputs[0]
        r = list(ri.dims[:ri.n_dims])
        self.rh, self.rw = (r[1], r[2]) if ri.fmt == 1 else (r[2], r[3])
        o = self.rec.outputs[0]
        od = list(o.dims[:o.n_dims])
        self.steps, self.classes = od[-2], od[-1]
        # A rec model built without mean/std takes floats: normalise here (pm1: PaddleOCR's own, 01: the zoo demo's).
        self.rec_norm = next((a.split("=")[1] for a in sys.argv if a.startswith("--rec-norm=")), None)

    def read(self, y, src_w=2560, src_h=1440, thresh=0.3, max_boxes=40, region=None):
        """All the text on a frame's luma plane: [{"text", "conf", "box": [x0,y0,x1,y1] in frame pixels}], with timings.
        region (x0, x1, y0, y1 as fractions) limits detection to part of the screen, at a finer scale."""
        t = {}
        t0 = time.time()
        rx0, rx1, ry0, ry1 = region or (0.0, 1.0, 0.0, 1.0)
        cx0, cy0 = int(rx0 * src_w), int(ry0 * src_h)
        cw, ch = int((rx1 - rx0) * src_w), int((ry1 - ry0) * src_h)
        if region:
            y_reg = b"".join(y[(cy0 + j) * src_w + cx0:(cy0 + j) * src_w + cx0 + cw] for j in range(ch))
        else:
            y_reg = y
        scale = min(self.dw / cw, self.dh / ch)
        ow, oh = max(1, int(cw * scale)), max(1, int(ch * scale))
        small = luma_rows(y_reg, cw, ch, ow, oh)
        rows = [small[j * ow:(j + 1) * ow] + b"\x00" * (self.dw - ow) for j in range(oh)]
        det_in = gray3(b"".join(rows) + b"\x00" * (self.dw * (self.dh - oh)))
        t["prep_ms"] = (time.time() - t0) * 1000
        t0 = time.time()
        (raw, _), = self.det.run(det_in, want_float=False)
        t["det_npu_ms"] = self.det.run_ms
        ad = attr_dict(self.det.outputs[0])
        if ad["type"] == "int8":
            mask = raw.translate(threshold_table(ad, thresh))
        else:
            (fraw, _), = self.det.run(det_in, want_float=True)
            prob = array.array("f")
            prob.frombytes(fraw)
            mask = bytes(1 if v > thresh else 0 for v in prob)
        boxes = boxes_from_mask(mask, self.dw, self.dh)
        t["det_post_ms"] = (time.time() - t0) * 1000 - t["det_npu_ms"]
        found, npu = [], 0.0
        t0 = time.time()
        for b in sorted(boxes, key=lambda b: (b[1], b[0]))[:max_boxes]:
            if b[0] >= ow or b[1] >= oh:
                continue
            u = unclip(b)
            sb = (cx0 + u[0] / scale, cy0 + u[1] / scale, cx0 + u[2] / scale, cy0 + u[3] / scale)
            px, _ = crop_resize(y, src_w, src_h, sb, self.rh, self.rw)
            if self.rec_norm:
                lo, k = (-1.0, 2 / 255) if self.rec_norm == "pm1" else (0.0, 1 / 255)
                (out, _), = self.rec.run(array.array("f", (lo + b * k for b in px)).tobytes(), want_float=True, in_type=FLOAT32)
            else:
                (out, _), = self.rec.run(px, want_float=True)
            npu += self.rec.run_ms
            text, conf = ctc(out, self.steps, self.classes, self.keys)
            if text.strip():
                found.append({"text": text, "conf": round(conf, 3), "box": [int(v) for v in sb]})
        t["rec_ms"] = (time.time() - t0) * 1000
        t["rec_npu_ms"] = npu
        t["boxes"] = len(boxes)
        return found, {k: round(v, 1) if isinstance(v, float) else v for k, v in t.items()}


def rss_kb():
    for ln in open("/proc/self/status"):
        if ln.startswith("VmRSS:"):
            return int(ln.split()[1])
    return None


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opt = {a.split("=")[0][2:]: a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--") and "=" in a}
    t0 = time.time()
    r = Reader(det=opt.get("det", os.path.join(HERE, "det.rknn")), rec=opt.get("rec", os.path.join(HERE, "rec.rknn")), keys=opt.get("keys", os.path.join(HERE, "ppocr_keys_v1.txt")))
    load_ms = (time.time() - t0) * 1000
    from rknn import attr_dict
    print(json.dumps({"load_ms": round(load_ms), "versions": r.det.versions(), "det_in": attr_dict(r.det.inputs[0]), "det_out": attr_dict(r.det.outputs[0]),
                      "rec_in": attr_dict(r.rec.inputs[0]), "rec_out": attr_dict(r.rec.outputs[0]), "det_mem": r.det.mem(), "rec_mem": r.rec.mem(), "rss_kb": rss_kb()}))
    region = tuple(float(v) for v in opt["region"].split(",")) if opt.get("region") else None

    def frames():
        # yuv420p frames on stdin, as the KVM's own decoder gives them (8-digit length, 64-char name, 16-char "w h"),
        # so private frames never touch the KVM's disk.
        while True:
            hdr = sys.stdin.buffer.read(88)
            if len(hdr) < 88:
                return
            n, name, (w, h) = int(hdr[:8].decode()), hdr[8:72].decode().strip(), map(int, hdr[72:88].decode().split())
            yield name, sys.stdin.buffer.read(n), w, h

    for name, yuv, w, h in frames():
        t0 = time.time()
        found, t = r.read(yuv[:w * h], w, h, region=region)
        print(json.dumps({"file": name, "total_ms": round((time.time() - t0) * 1000), **t, "rss_kb": rss_kb(), "text": [f["text"] for f in found], "found": found}, ensure_ascii=False), flush=True)
