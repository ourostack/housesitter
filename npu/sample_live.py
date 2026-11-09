"""Spike: sample the live screen off the sitter's loop, keeping only the menu bar's right end (the clock), the frame's
kind, and the sitter's current clock fingerprint (clock_sig). Read-only: it presses and types nothing.

    python3 sample_live.py <n> <every sec>
"""
import base64
import json
import sys
import time

sys.path.insert(0, "/etc/kvmd/user/housesitter")
import sitter as S  # noqa: E402

CROP = (0.94, 1.0, 0.0, 0.0195)
cfg = S.load("config.json", {})
kvmd = S.Kvmd(cfg.get("kvmd_socket", "/run/kvmd/kvmd.sock"), cfg.get("kvmd_user", "admin"), S.load_secret("kvmd") or "")
n, every = int(sys.argv[1]), float(sys.argv[2])
for i in range(n):
    t = time.time()
    rec = {"i": i, "utc": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t))}
    try:
        raw = S.frame_raw(kvmd)
        rec["grab_ms"] = round((time.time() - t) * 1000)
        if raw:
            y, w, h = raw
            f = S.frame_features(y, w, h)
            rec.update(kind=S.classify_frame(f), sig=S.clock_sig(y, w, h), size=[w, h])
            x0, x1, y1 = int(CROP[0] * w), w, int(CROP[3] * h)
            rec["crop"] = base64.b64encode(b"".join(bytes(y[r * w + x0:r * w + x1]) for r in range(y1))).decode()
            rec["crop_wh"] = [x1 - x0, y1]
    except Exception as e:  # noqa: BLE001
        rec["error"] = str(e)[:160]
    print(json.dumps(rec), flush=True)
    time.sleep(max(0, every - (time.time() - t)))
