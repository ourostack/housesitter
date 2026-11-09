# The clock readers

Two models the sitter runs on the KVM's NPU, in one worker. `clock.rknn` reads the time at the right end of the Mac's menu bar ("Mon Nov 9 8:05 AM"), so housesitter can tell a frozen Mac from one whose clock still moves. `lock-clock.rknn` reads the big time on the lock screen, the login window and FileVault ("10:56"), for the record and for messages ("its clock has stopped"). It only feeds that test. It never decides what screen is showing and never leads to typing; the taught prompt stays the only gate for the password.

| | |
|---|---|
| `npu/clock.onnx` (source) | sha256 `aa0ce9483c657b425699a8c4ece967f8024a1a16df76979c2f7433d0bbf1c0ba` |
| `npu/lock-clock.onnx` (source) | sha256 `c33de218d3b5e0b4c2e9d6fa4e919f586737083269586f79731c96bb812e1b90` |
| `lock-clock.rknn` (on the KVM) | sha256 `0be5fe5c7562bda85a31a0230e72f2a97cba6abbe0c8682789a8ddc5e5a81170`, 884 KB, float; the same network, fine-tuned from `clock` on synthetic lock-screen clocks (open variable fonts: Inter, Nunito, Manrope, Figtree), 24,000 samples, 8 epochs |
| `clock.rknn` (on the KVM) | sha256 `e43cecbd5198883dca26ca8ec15983d0746128321ed2962e900e2e1929a5d0e8`, 884 KB, float |
| Network | CTC text line, 414,690 weights; input 32×192, one channel, uint8; output 66 classes × 96 steps |
| Training | Synthetic menu bars only, drawn with open fonts (Inter, Roboto, DejaVu Sans): nobody's screen is in it. 40,000 samples, 24 epochs (`npu/train_clock.py`) |
| Conversion | rknn-toolkit2 2.3.2, target `rv1126b`, in CI (`.github/workflows/npu-models.yml`); it matches the Comet's runtime, librknnrt 2.3.2 with RKNPU driver 0.9.8 |

## Measured on one GL.iNet Comet (GL-RM1PE), 2026-11-09

- NPU time per read: median 1.07 ms over 300 synthetic held-out reads in the spike; live, median 1.42 ms (1.29–2.10) over 120 looks in 30 minutes, and 4.7 ms for the whole round trip from the sitter.
- The worker uses 35 MB of RAM and 1.1 MB of the 48 MB CMA heap with the menu-bar model alone (CmaFree 49,072 KB idle, 47,948 KB with it running); with both models, about 37 MB and 2.2 MB.
- Synthetic held-out set: 300 of 300 read exactly.
- Live on the mini, 30 minutes at 2560×1440: 120 of 120 right; within a minute the time never changed (0 of 89 pairs), and it changed at every minute (30 of 30). 45 live frames without a menu bar (a full-screen app) gave no read, and so no false time.
- Low-resolution recordings (960 wide, scaled up 2.67×): 69 of 113 exact, 10 no read, 34 wrong. Treat this as a floor.

## The lock-screen clock, measured on the same Comet

- 66 of 66 clocks right on real lock-screen, login-window and FileVault frames from our mini (30 different times, at 960, 1280 and 2560 wide); the one frame without a clock gave no read. Median 0.95 ms on the NPU. We watched these frames during training (fixed epochs, nothing chosen by them).
- 157 frames with no lock-screen clock (desktops, boots, wallpaper) gave no time.
- These are recorded frames; a live lock screen is still to come.
- One network trained on both crops read the lock screen as well but lost menu-bar accuracy, so they stay two models.

## Why the NPU needs a trick on the Comet

GL.iNet's device tree turns the NPU's IOMMU off, so every buffer the NPU touches must be physically contiguous. The stock runtime allocates from `/dev/dma_heap/system`, which is not contiguous, and every job times out. The sitter's worker runs in its own mount namespace and binds the Rockchip CMA heap over that path, so the runtime gets contiguous memory. Nothing outside the worker sees the change, and the CMA memory goes back when the worker exits. If anything fails, the worker turns itself off for an hour and housesitter falls back to the clock's pixel fingerprint.
