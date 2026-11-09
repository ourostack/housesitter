# Hardware proof, 2026-11-09: housesitter's own sitter on a real Comet

The run from [#11](https://github.com/ourostack/housesitter/issues/11). The setup was a Mac mini on macOS 27.2 with FileVault on, and a GL.iNet Comet (GL-RM1PE, kvmd 4.82) at HDMI 2560x1440. It ran `device/sitter.py` at `8ccd065`.

The frames are boot and password screens only. They were decoded on the KVM, which encoded a JPEG only when the frame did not read as a desktop. So no desktop and no notification left the KVM.

- `restart1-taught/`: armed with `unlock --trial` and restarted. At 05:20:53 the sitter refused, because it hadn't been taught this screen. At 05:22:08 it was taught with `learn-prompt --i-see-the-field --filevault` (25 points, kind boot). At 05:22:16 it typed once (trial), and at 05:22:31 the desktop was back and the password verified. Only one frame was kept: the recorder couldn't encode JPEGs until restart 2.
- `restart2-hands-off/`: the only touch was the restart itself (Return at 05:32:23). The boot was seen at 05:33:00, the taught prompt matched from 05:33:03, and it was steady and past the boot's settle time at 05:33:20. It typed once at 05:33:27 (it waits 20 s after a boot before typing), and the desktop was back at 05:33:42: **79 s from Return**. The Return time comes from the agent that pressed it; the KVM's own frames put it between 05:32:21 (the last desktop) and 05:32:24 (shutting down), so 78-81 s.
- `sitter.log`: the sitter's own log for the window, complete. The "ingress NOT applied" lines are housesitter#12 (no ip6tables on this KVM), fixed in 0.2; during these runs the KVM's own firewall rules were not in place.
- The timelines record a look every ~3 s while HDMI had a signal; there are gaps while it had none.
- `restart2-hands-off/frames/053327.jpg` has its password field blurred since 9 November, because the dots give away the password's length.
