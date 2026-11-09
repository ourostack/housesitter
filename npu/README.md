# Building the clock reader

The sitter runs `device/npu/clock.rknn` on the KVM's NPU; `device/npu/README.md` says what it does and what we measured.

1. Train: `CLOCK_DEVICE=mps python npu/train_clock.py out fonts/` writes `out/clock.onnx` (needs torch and Pillow, and open fonts in `fonts/`).
2. Copy it to `npu/clock.onnx` and push: the `npu-models` workflow converts it with rknn-toolkit2 2.3.2 for `rv1126b` and uploads `clock.rknn`.
3. Put that file at `device/npu/clock.rknn`. `housesitter adopt` copies it to any KVM that has `/dev/rknpu` and `librknnrt`.

The spike that chose this model (PP-OCRv4 on the NPU, the IOMMU and CMA findings, the evaluation scripts) is on the `npu-spike` branch.
