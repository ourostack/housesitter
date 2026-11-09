"""Stream pictures to `ocr.py` on the KVM as the yuv420p frames its own decoder gives (2560x1440 by default), over stdin.

    python3 npu/send_frames.py a.jpg b.png ... | ssh root@kvm 'cd /userdata/housesitter-npu && python3 ocr.py'
"""
import os
import subprocess
import sys

W, H = 2560, 1440
for f in sys.argv[1:]:
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", f, "-frames:v", "1", "-vf", "scale=%d:%d" % (W, H),
                          "-pix_fmt", "yuv420p", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    sys.stdout.buffer.write(b"%08d" % len(raw) + os.path.basename(f)[:64].ljust(64).encode() + ("%d %d" % (W, H)).ljust(16).encode() + raw)
    sys.stdout.buffer.flush()
