"""Train the clock reader housesitter runs on the KVM's NPU: a tiny CTC text-line model that reads the Mac's menu-bar
clock ("Sun Nov 8 5:59 PM") from the right end of the menu bar. Synthetic data only (open fonts, drawn here), so the
model holds nothing of anyone's screen; it is tested on real frames on the KVM.

Small on purpose (about 90k weights, activations well under 1 MiB): on the GL.iNet Comet the NPU's IOMMU is off, so
every NPU buffer must be physically contiguous, which the runtime's DMA heap gives only up to 1 MiB.

    python npu/train_clock.py <out dir> <font dir>
"""
import glob
import io
import json
import os
import random
import sys
import time

import torch
import torch.nn as nn
from PIL import Image, ImageDraw, ImageFilter, ImageFont

H, W = 32, 192  # the network's input: the crop, scaled to 32 rows, padded to 192 columns
CROP = (0.94, 1.0, 0.0, 0.0195)  # x0, x1, y0, y1 as fractions of the screen: the menu bar's right end, where the time is
CHARS = "0123456789:. " + "abcdefghijklmnopqrstuvwxyz" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def clock_text(r):
    h, m = r.randrange(24), r.randrange(60)
    h12 = h % 12 or 12
    ampm = "AM" if h < 12 else "PM"
    t = r.choice([f"{h12}:{m:02d} {ampm}", f"{h12}:{m:02d} {ampm}", f"{h:02d}:{m:02d}", f"{h12}:{m:02d}:{r.randrange(60):02d} {ampm}", f"{h12}:{m:02d}"])
    date = r.choice([f"{r.choice(DAYS)} {r.choice(MONTHS)} {r.randrange(1, 32)}", f"{r.choice(DAYS)} {r.randrange(1, 32)} {r.choice(MONTHS)}", r.choice(DAYS), ""])
    return (date + " " + t).strip() if date else t


def render(r, fonts, sw=2560, sh=1440):
    """One menu-bar crop at a random screen size, as the KVM's luma plane would show it, and its label."""
    scale = r.choice([1.0, 1.0, 0.75, 1.5])  # 2560x1440, 1920x1080, 3840x2160
    sw, sh = int(sw * scale), int(sh * scale)
    cw, ch = int((CROP[1] - CROP[0]) * sw), max(8, int((CROP[3] - CROP[2]) * sh))
    dark = r.random() < 0.75
    bg = r.randrange(20, 110) if dark else r.randrange(170, 245)
    img = Image.new("L", (cw, ch), bg)
    d = ImageDraw.Draw(img)
    for x in range(0, cw, 8):  # a translucent menu bar over a wallpaper: slow bands of light
        d.rectangle([x, 0, x + 8, ch], fill=max(0, min(255, bg + r.randrange(-12, 13))))
    fg = r.randrange(215, 256) if dark else r.randrange(0, 50)
    size = int(ch * r.uniform(0.47, 0.6))
    font = ImageFont.truetype(r.choice(fonts), size)
    text = clock_text(r)
    tw = d.textlength(text, font=font)
    right = cw - int(r.uniform(0.004, 0.02) * sw)
    x = right - tw
    if right - d.textlength(text.split(" ")[-1] if not text.endswith("M") else " ".join(text.split(" ")[-2:]), font=font) < 2:
        return render(r, fonts)  # the time itself must fit
    y = (ch - size) // 2 - int(size * 0.1) + r.randrange(-1, 2)
    d.text((x, y), text, font=font, fill=fg)
    # The label is what the crop shows whole: a date that runs off its left edge is cut where a character is cut.
    first = next(i for i in range(len(text)) if x + d.textlength(text[:i], font=font) >= 1)
    label = text[first:].lstrip()
    ix = x - r.randrange(10, 30)
    while ix > 10:  # status icons to the clock's left: shapes, never letters
        s = r.randrange(int(ch * 0.35), int(ch * 0.6))
        k = r.random()
        box = [ix - s, (ch - s) // 2, ix, (ch + s) // 2]
        if k < 0.4:
            d.ellipse(box, outline=fg, width=max(1, s // 8))
        elif k < 0.7:
            d.rectangle(box, outline=fg, width=max(1, s // 8))
        else:
            d.pieslice(box, 0, r.randrange(90, 330), fill=fg)
        ix -= s + r.randrange(int(ch * 0.4), int(ch * 1.2))
    if r.random() < 0.5:
        img = img.filter(ImageFilter.GaussianBlur(r.uniform(0.2, 0.8)))
    if r.random() < 0.7:  # H.264 and JPEG both blur and ring at edges
        b = io.BytesIO()
        img.save(b, "JPEG", quality=r.randrange(35, 90))
        img = Image.open(io.BytesIO(b.getvalue())).convert("L")
    return img, label


def to_input(img):
    """Exactly what the KVM does: nearest-neighbour to 32 rows by aspect, black-padded to 416 columns."""
    cw, ch = img.size
    ow = min(W, max(1, round(cw * H / ch)))
    img = img.resize((ow, H), Image.NEAREST)
    out = Image.new("L", (W, H), 0)
    out.paste(img, (0, 0))
    return out


class ClockNet(nn.Module):
    def __init__(self, n=len(CHARS) + 1):
        super().__init__()
        c = lambda i, o, k=3, p=1: nn.Sequential(nn.Conv2d(i, o, k, padding=p), nn.BatchNorm2d(o), nn.ReLU())
        self.f = nn.Sequential(c(1, 16), nn.MaxPool2d(2), c(16, 32), nn.MaxPool2d((2, 1)), c(32, 64), c(64, 64), nn.MaxPool2d((2, 1)),
                               c(64, 128, (4, 3), (0, 1)))
        # Context along the line: each step sees about two characters either side (1x5 convolutions, NPU-friendly).
        self.ctx = nn.Sequential(c(128, 128, (1, 5), (0, 2)), c(128, 128, (1, 5), (0, 2)), c(128, 128, (1, 5), (0, 2)))
        self.head = nn.Conv2d(128, n, 1)

    def forward(self, x):  # x: N,1,32,192 in [0,1] -> N,classes,1,96 (two steps per 4 pixels of a 32-row line)
        f = self.f(x)
        return self.head(f + self.ctx(f))


def encode(t):
    return [CHARS.index(ch) + 1 for ch in t]


def decode(seq):
    out, last = [], 0
    for k in seq:
        if k != 0 and k != last:
            out.append(CHARS[k - 1])
        last = k
    return "".join(out)


def batch(r, fonts, n):
    xs, ys, ls = [], [], []
    for _ in range(n):
        img, t = render(r, fonts)
        xs.append(torch.frombuffer(bytearray(to_input(img).tobytes()), dtype=torch.uint8).float().view(1, H, W) / 255)
        e = encode(t)
        ys += e
        ls.append(len(e))
    return torch.stack(xs), torch.tensor(ys), torch.tensor(ls)


def _render_chunk(args):
    seed, n, fonts = args
    r = random.Random(seed)
    xs, labels = bytearray(), []
    for _ in range(n):
        img, t = render(r, fonts)
        xs += to_input(img).tobytes()
        labels.append(t)
    return bytes(xs), labels


def dataset(n, seed, fonts, procs=os.cpu_count() or 2):
    import multiprocessing as mp
    per = (n + procs - 1) // procs
    with mp.Pool(procs) as p:
        parts = p.map(_render_chunk, [(seed * 1000 + k, per, fonts) for k in range(procs)])
    x = torch.frombuffer(bytearray(b"".join(a for a, _ in parts)), dtype=torch.uint8).view(-1, 1, H, W)
    return x, [t for _, ls in parts for t in ls]


def main(out, font_dir):
    torch.manual_seed(7)
    torch.set_num_threads(os.cpu_count() or 2)
    fonts = sorted(glob.glob(os.path.join(font_dir, "*.ttf")) + glob.glob(os.path.join(font_dir, "*.otf")))
    t0 = time.time()
    n = int(os.environ.get("CLOCK_N", 40000))
    X, labels = dataset(n, 1, fonts)
    Xv, lv = dataset(1024, 2, fonts)
    Y = [torch.tensor(encode(t)) for t in labels]
    print(json.dumps({"rendered": n, "sec": round(time.time() - t0)}), flush=True)
    net = ClockNet()
    budget = float(os.environ.get("CLOCK_BUDGET_SEC", 1200))
    epochs, bs = int(os.environ.get("CLOCK_EPOCHS", 30)), 128
    opt = torch.optim.AdamW(net.parameters(), 2e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 3e-3, total_steps=epochs * (n // bs))
    ctc = nn.CTCLoss(blank=0, zero_infinity=True)

    def exact():
        net.eval()
        with torch.no_grad():
            p = net(Xv.float() / 255).squeeze(2).argmax(1).tolist()
        net.train()
        return sum(decode(q) == t for q, t in zip(p, lv)) / len(lv)

    t1, done = time.time(), 0
    for e in range(epochs):
        perm = torch.randperm(n)
        for i in range(0, n - bs + 1, bs):
            idx = perm[i:i + bs]
            lp = net(X[idx].float() / 255).squeeze(2).permute(2, 0, 1).log_softmax(2)
            y = torch.cat([Y[j] for j in idx.tolist()])
            loss = ctc(lp, y, torch.full((bs,), lp.shape[0], dtype=torch.long), torch.tensor([len(Y[j]) for j in idx.tolist()]))
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
        done = e + 1
        print(json.dumps({"epoch": e, "loss": round(loss.item(), 4), "val_exact": exact(), "sec": round(time.time() - t0)}), flush=True)
        if time.time() - t1 > budget:
            break
    net.eval()
    os.makedirs(out, exist_ok=True)
    calib = os.path.join(out, "clock-calib")
    os.makedirs(calib, exist_ok=True)
    with open(os.path.join(out, "clock-calib.txt"), "w") as f:
        for i in range(64):
            p = os.path.join(calib, "%02d.png" % i)
            Image.frombytes("L", (W, H), bytes(Xv[i].view(-1).tolist())).save(p)
            f.write(os.path.abspath(p) + "\n")
    torch.onnx.export(net, torch.zeros(1, 1, H, W), os.path.join(out, "clock.onnx"), input_names=["x"], output_names=["logits"], opset_version=12)
    rep = {"params": sum(p.numel() for p in net.parameters()), "epochs": done, "train_sec": round(time.time() - t1), "synthetic_exact": exact(),
           "synthetic_n": len(lv), "fonts": [os.path.basename(f) for f in fonts], "chars": CHARS, "input": [H, W], "crop": CROP}
    json.dump(rep, open(os.path.join(out, "clock-train.json"), "w"), indent=1)
    print(json.dumps(rep))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
