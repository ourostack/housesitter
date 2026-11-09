"""Convert the models housesitter runs on the KVM's NPU, for the Rockchip RV1126B in a GL.iNet Comet.

Runs in CI (rknn-toolkit2 has Linux wheels only), never on the KVM. The toolkit's version must match the runtime on
the device: the Comet's /usr/lib/librknnrt.so reports 2.3.2, so this pins rknn-toolkit2==2.3.2.

    python npu/convert.py <models dir> <quant dataset list>
"""
import json
import os
import sys

import onnx
from rknn.api import RKNN

PLATFORM = "rv1126b"


def shape(path):
    m = onnx.load(path)
    return {i.name: [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim] for i in m.graph.input}


def build(onnx_path, out, quant=False, dataset=None, size=None, mean=None, std=None):
    r = RKNN(verbose=False)
    cfg = {"target_platform": PLATFORM}
    if mean:
        cfg.update(mean_values=[mean], std_values=[std])
    r.config(**cfg)
    kw = {}
    if size:
        m = onnx.load(onnx_path)
        kw = {"inputs": [m.graph.input[0].name], "input_size_list": [size]}
    ret = r.load_onnx(model=onnx_path, **kw)
    if ret == 0:
        ret = r.build(do_quantization=quant, dataset=dataset if quant else None)
    if ret == 0:
        ret = r.export_rknn(out)
    r.release()
    return {"out": os.path.basename(out), "ok": ret == 0, "bytes": os.path.getsize(out) if ret == 0 else None}


def main(d, dataset):
    det, rec = os.path.join(d, "ppocrv4_det.onnx"), os.path.join(d, "ppocrv4_rec.onnx")
    report = {"platform": PLATFORM, "shapes": {"det": shape(det), "rec": shape(rec)}, "built": []}
    dm, ds = [123.675, 116.28, 103.53], [58.395, 57.12, 57.375]
    jobs = [
        (det, "det_480_i8.rknn", dict(quant=True, dataset=dataset, mean=dm, std=ds)),
        (det, "det_480_fp.rknn", dict(mean=dm, std=ds)),
        (det, "det_736x1280_i8.rknn", dict(quant=True, dataset=dataset, size=[1, 3, 736, 1280], mean=dm, std=ds)),
        (det, "det_736x1280_fp.rknn", dict(size=[1, 3, 736, 1280], mean=dm, std=ds)),
        (rec, "rec_48x320_fp.rknn", dict(size=[1, 3, 48, 320])),
        # The same, taking uint8 pixels: (x - 127.5) / 127.5 is PaddleOCR's own normalisation; x / 255 is the zoo demo's.
        (rec, "rec_48x320_fp_pm1.rknn", dict(size=[1, 3, 48, 320], mean=[127.5] * 3, std=[127.5] * 3)),
        (rec, "rec_48x320_fp_01.rknn", dict(size=[1, 3, 48, 320], mean=[0, 0, 0], std=[255, 255, 255])),
    ]
    for src, name, kw in jobs:
        try:
            report["built"].append(build(src, os.path.join(d, name), **kw))
        except Exception as e:  # noqa: BLE001
            report["built"].append({"out": name, "ok": False, "error": str(e)[:300]})
        print(json.dumps(report["built"][-1]), flush=True)
    with open(os.path.join(d, "report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
