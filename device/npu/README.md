# The clock reader

`clock.rknn` is the model the sitter runs on the KVM's NPU. It reads the time at the right end of the Mac's menu bar ("Mon Nov 9 8:05 AM"), so housesitter can tell a frozen Mac from one whose clock still moves. It only feeds that test. It never decides what screen is showing and never leads to typing; the taught prompt stays the only gate for the password.

| | |
|---|---|
| `npu/clock.onnx` (source) | sha256 `aa0ce9483c657b425699a8c4ece967f8024a1a16df76979c2f7433d0bbf1c0ba` |
| `clock.rknn` (on the KVM) | sha256 `e43cecbd5198883dca26ca8ec15983d0746128321ed2962e900e2e1929a5d0e8`, 884 KB, float |
| Network | CTC text line, 414,690 weights; input 32×192, one channel, uint8; output 66 classes × 96 steps |
| Training | Synthetic menu bars only, drawn with open fonts (Inter, Roboto, DejaVu Sans): nobody's screen is in it. 40,000 samples, 24 epochs (`npu/train_clock.py`) |
| Conversion | rknn-toolkit2 2.3.2, target `rv1126b`, in CI (`.github/workflows/npu-models.yml`); it matches the Comet's runtime, librknnrt 2.3.2 with RKNPU driver 0.9.8 |

## Measured on one GL.iNet Comet (GL-RM1PE), 2026-11-09

- NPU time per read: median 1.07 ms over 300 reads, 1.4–2.1 ms inside the live sitter; about 4.5 ms for the whole round trip from the sitter.
- The worker process uses 35 MB of RAM and 1.1 MB of the 48 MB CMA heap (CmaFree 49,072 KB idle, 47,948 KB with the worker running).
- Synthetic held-out set: 300 of 300 read exactly.
- Real frames from the mini: both full-resolution frames we could check read the right time (one live, one recorded), and six 1280-wide frames read plausible times. That is few, because Ari's full-screen apps hide the menu bar. 45 live frames without a menu bar gave no read, and so no false time.
- Low-resolution recordings (960 wide, scaled up 2.67×): 69 of 113 exact, 10 no read, 34 wrong. Treat this as a floor.

## Why the NPU needs a trick on the Comet

GL.iNet's device tree turns the NPU's IOMMU off, so every buffer the NPU touches must be physically contiguous. The stock runtime allocates from `/dev/dma_heap/system`, which is not contiguous, and every job times out. The sitter's worker runs in its own mount namespace and binds the Rockchip CMA heap over that path, so the runtime gets contiguous memory. Nothing outside the worker sees the change, and the CMA memory goes back when the worker exits. If anything fails, the worker turns itself off for an hour and housesitter falls back to the clock's pixel fingerprint.
