"""Build assets/evening.json: the real evening of 2026-11-08, as `housesitter demo` replays it.

Each frame is a real picture our GL.iNet Comet took of our Mac mini that day. Only what the sitter itself keeps of a
frame is written here (its brightness, menu-bar edges, the luma grid it matches the password prompt on, and a 40x22
glimpse), never the picture: the glimpse is enough to recognise a lock screen and too small to read anything on it. A desktop
gets no glimpse at all, only its numbers: only boot, FileVault and lock-screen pictures are published.
The taught prompt is learned, exactly as `learn-prompt` does, from three real lock-screen frames (test/fixtures).

    python3 scripts/evening.py <folder with the evidence frames>
"""
import base64
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "device"))
import sitter as S  # noqa: E402

FRAMES = [
    ("10:32", "incident-20261108-edid-hang/comet-frame-1832utc-after-two-unlock-attempts.jpg", "incident"),
    ("17:59", "comet-live-20261108/01-comet-sees-main-dell-system-settings-1759.png", "mirror"),
    ("18:07", "comet-live-20261108/04-locked.png", "locked"),
    ("18:07", "comet-live-20261108/05-lock-screen-awake-learned.png", "awake"),
    ("18:15", "comet-live-20261108/06-after-comet-unlock.png", "unlocked"),
    ("18:32", "comet-restart-20261109/frames/023232.jpg", "restart"),
]


def main(root):
    lum = {k: dict(v, _lum=base64.b64decode(v["_lum"])) for k, v in json.load(open(os.path.join(HERE, "..", "test", "fixtures", "comet-lum-20261109.json"))).items() if not k.startswith("_")}
    points = S.prompt_points([lum["lock-a"], lum["lock-b"], lum["lock-c"]])
    out = {"_why": __doc__.split("\n\n")[1].replace("\n", " "), "date": "2026-11-08", "mac": "Mac mini (M5 Pro), FileVault on",
           "kvm": "GL.iNet Comet GL-RM1PE, firmware V1.7.1, HDMI 2560x1440", "prompt_points": points, "frames": []}
    for at, rel, key in FRAMES:
        yuv, w, h = S.decode_picture(os.path.join(root, rel))
        f = S.frame_features(yuv[:w * h], w, h)
        fr = {"at": at, "key": key, "source": os.path.basename(rel), "mean": f["mean"], "top_edges": f["top_edges"]}
        if S.classify_frame(f) == "desktop":
            fr["withheld"] = "a personal desktop"  # only boot, FileVault and lock-screen pictures are published
        else:
            fr["glimpse"] = S.glimpse(yuv, w, h)
            fr["lum"] = base64.b64encode(f["_lum"]).decode("ascii")
        out["frames"].append(fr)
    dest = os.path.join(HERE, "..", "assets", "evening.json")
    with open(dest, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print("wrote %s: %d frames, %d prompt points" % (dest, len(out["frames"]), len(points)))


if __name__ == "__main__":
    main(sys.argv[1])
