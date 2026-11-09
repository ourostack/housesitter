# Hardware proof, 2026-11-09: housesitter's own sitter on a real Comet

The run from [#11](https://github.com/ourostack/housesitter/issues/11). The setup was a Mac mini on macOS 27.2 with FileVault on, and a GL.iNet Comet (GL-RM1PE, kvmd 4.82) at HDMI 2560x1440. It ran `device/sitter.py` at `8ccd065`.

The frames are boot and password screens only. They were decoded on the KVM, which encoded a JPEG only when the frame did not read as a desktop. So no desktop and no notification left the KVM.

- `restart1-taught/`: armed with `unlock --trial` and restarted. At 05:20:53 the sitter refused, because it hadn't been taught this screen. At 05:22:08 it was taught with `learn-prompt --i-see-the-field --filevault` (25 points, kind boot). At 05:22:16 it typed once (trial), and at 05:22:31 the desktop was back and the password verified. Only one frame was kept: the recorder couldn't encode JPEGs until restart 2.
- `restart2-hands-off/`: the only touch was the restart itself (Return at 05:32:23). The boot was seen at 05:33:00 and the taught prompt at 05:33:20. The sitter typed once at 05:33:27, and the desktop was back at 05:33:42: **79 s from Return**.
- `sitter.log`: the sitter's own log, complete.
