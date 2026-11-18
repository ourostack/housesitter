"""Synthetic lock widgets, never recordings or evidence of a real unlock."""
import math


FONT = {
    " ": ["00000"] * 7,
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "I": ["111", "010", "010", "010", "010", "010", "111"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "a": ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
    "c": ["00000", "00000", "01111", "10000", "10000", "10000", "01111"],
    "d": ["00001", "00001", "01111", "10001", "10001", "10001", "01111"],
    "e": ["00000", "00000", "01110", "10001", "11111", "10000", "01111"],
    "h": ["10000", "10000", "10110", "11001", "10001", "10001", "10001"],
    "n": ["00000", "00000", "11110", "10001", "10001", "10001", "10001"],
    "o": ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
    "r": ["00000", "00000", "10111", "11000", "10000", "10000", "10000"],
    "s": ["00000", "00000", "01111", "10000", "01110", "00001", "11110"],
    "t": ["01000", "01000", "11110", "01000", "01000", "01001", "00110"],
    "u": ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
    "w": ["00000", "00000", "10001", "10001", "10101", "10101", "01010"],
}

# Fractions of the whole HDMI picture, tightly surrounding the actual widgets.
REGIONS = {"field": [0.430, 0.850, 0.570, 536 / 600], "hint": [0.420, 0.907, 0.580, 0.927]}


def picture(wallpaper=0, dx=0, dy=0, field=True, hint=True, hint_dy=0, desktop=False, scale=1, placeholder=True, field_width=140,
            hint_text="Touch ID or Enter Password"):
    w, h = 1000, 600
    y = bytearray(w * h)
    for row in range(h):
        for col in range(w):
            # Two unrelated, textured wallpapers. Their absolute luminances differ too.
            v = (65 + 25 * math.sin(col / 55) + 15 * math.cos(row / 19)) if wallpaper == 0 else (
                175 + 30 * math.sin((col + row) / 37) + 12 * math.cos(col / 9))
            y[row * w + col] = int(v)

    def rect(x0, y0, x1, y1, value):
        for row in range(y0, y1):
            y[row * w + x0:row * w + x1] = bytes([value]) * (x1 - x0)

    def text(words, cx, top):
        width = sum(len(FONT[c][0]) + 1 for c in words) - 1
        x = cx - width // 2
        for c in words:
            for row, bits in enumerate(FONT[c]):
                for col, bit in enumerate(bits):
                    if bit == "1":
                        y[(top + row) * w + x + col] = 240
            x += len(FONT[c][0]) + 1

    if field:
        left, right = 500 - field_width // 2 + dx, 500 + field_width // 2 + dx
        rect(left, 510 + dy, right, 536 + dy, 200)
        rect(left + 2, 512 + dy, right - 2, 534 + dy, 60)
        if placeholder:
            text("Enter Password", 500 + dx, 519 + dy)
    if hint:
        text(hint_text, 500 + dx, 546 + dy + hint_dy)
    if desktop:
        for row in range(2, 38, 2):
            for col in range(0, 350, 4):
                y[row * w + col] = 250 if col % 8 else 0
    if scale == 1:
        return bytes(y), w, h
    out = bytearray()
    for row in range(h):
        line = bytes(v for v in y[row * w:(row + 1) * w] for _ in range(scale))
        out.extend(line * scale)
    return bytes(out), w * scale, h * scale


def hdmi_picture(width, height, dx=0, dy=0, **changes):
    raw, w, h = picture(**changes)
    xs = [int(x * w / width) for x in range(width)]
    scaled = bytes(raw[int(y * h / height) * w + x] for y in range(height) for x in xs)
    if not dx and not dy:
        return scaled, width, height
    shifted = bytearray([80]) * (width * height)
    x0, x1 = max(0, dx), min(width, width + dx)
    for row in range(max(0, dy), min(height, height + dy)):
        start = (row - dy) * width + x0 - dx
        shifted[row * width + x0:row * width + x1] = scaled[start:start + x1 - x0]
    return bytes(shifted), width, height
