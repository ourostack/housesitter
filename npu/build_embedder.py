"""A small, generic picture embedder for the KVM's NPU: MobileNetV1 (width 0.25, 128x128, ImageNet weights), pooled to a
256-number vector. Small on purpose: on the GL.iNet Comet the NPU's IOMMU is disabled in the device tree, so the NPU can
only use buffers that happen to be physically contiguous, and the runtime's DMA heap gives that only up to 1 MiB each.

    python npu/build_embedder.py <out dir> <calibration image list>
"""
import json
import os
import sys

import tensorflow as tf
import tf2onnx
from rknn.api import RKNN

out, calib = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
m = tf.keras.applications.MobileNet(alpha=0.25, input_shape=(128, 128, 3), include_top=False, weights="imagenet", pooling="avg")
spec = (tf.TensorSpec((1, 128, 128, 3), tf.float32, name="x"),)
onnx_path = os.path.join(out, "embed_mnv1_025_128.onnx")
tf2onnx.convert.from_keras(m, input_signature=spec, opset=13, output_path=onnx_path)
report = {"params": int(m.count_params()), "built": []}
for name, quant in (("embed_fp.rknn", False), ("embed_i8.rknn", True)):
    r = RKNN(verbose=False)
    r.config(mean_values=[[127.5] * 3], std_values=[[127.5] * 3], target_platform="rv1126b")
    ret = r.load_onnx(model=onnx_path)
    ret = ret or r.build(do_quantization=quant, dataset=calib if quant else None)
    ret = ret or r.export_rknn(os.path.join(out, name))
    r.release()
    report["built"].append({"out": name, "ok": ret == 0, "bytes": os.path.getsize(os.path.join(out, name)) if ret == 0 else None})
json.dump(report, open(os.path.join(out, "embed-report.json"), "w"), indent=1)
print(json.dumps(report))
