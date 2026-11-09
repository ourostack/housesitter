"""The KVM's NPU from Python's standard library: ctypes over Rockchip's librknnrt.so (RKNPU2 C API, runtime 2.3.x).

No numpy, nothing to install on the KVM. Inputs are bytes (uint8 NHWC pixels); outputs come back as raw bytes plus
the tensor's quantisation, so callers threshold or argmax them without converting every value in Python."""
import ctypes
import os
import time

LIB = "/usr/lib/librknnrt.so"
MAX_DIMS, MAX_NAME = 16, 256
QUERY_IN_OUT_NUM, QUERY_INPUT_ATTR, QUERY_OUTPUT_ATTR, QUERY_PERF_RUN, QUERY_SDK_VERSION, QUERY_MEM_SIZE = 0, 1, 2, 4, 5, 6
FLOAT32, FLOAT16, INT8, UINT8 = 0, 1, 2, 3
NCHW, NHWC = 0, 1
TYPE_NAMES = {0: "float32", 1: "float16", 2: "int8", 3: "uint8", 4: "int16", 5: "uint16", 6: "int32", 7: "uint32", 8: "int64", 9: "bool"}

ctx_t = ctypes.c_uint64


class InOutNum(ctypes.Structure):
    _fields_ = [("n_input", ctypes.c_uint32), ("n_output", ctypes.c_uint32)]


class TensorAttr(ctypes.Structure):
    _fields_ = [("index", ctypes.c_uint32), ("n_dims", ctypes.c_uint32), ("dims", ctypes.c_uint32 * MAX_DIMS),
                ("name", ctypes.c_char * MAX_NAME), ("n_elems", ctypes.c_uint32), ("size", ctypes.c_uint32),
                ("fmt", ctypes.c_int), ("type", ctypes.c_int), ("qnt_type", ctypes.c_int), ("fl", ctypes.c_int8),
                ("zp", ctypes.c_int32), ("scale", ctypes.c_float), ("w_stride", ctypes.c_uint32),
                ("size_with_stride", ctypes.c_uint32), ("pass_through", ctypes.c_uint8), ("h_stride", ctypes.c_uint32)]


class Input(ctypes.Structure):
    _fields_ = [("index", ctypes.c_uint32), ("buf", ctypes.c_void_p), ("size", ctypes.c_uint32),
                ("pass_through", ctypes.c_uint8), ("type", ctypes.c_int), ("fmt", ctypes.c_int)]


class Output(ctypes.Structure):
    _fields_ = [("want_float", ctypes.c_uint8), ("is_prealloc", ctypes.c_uint8), ("index", ctypes.c_uint32),
                ("buf", ctypes.c_void_p), ("size", ctypes.c_uint32)]


class SdkVersion(ctypes.Structure):
    _fields_ = [("api_version", ctypes.c_char * 256), ("drv_version", ctypes.c_char * 256)]


class PerfRun(ctypes.Structure):
    _fields_ = [("run_duration", ctypes.c_int64)]


class MemSize(ctypes.Structure):
    _fields_ = [("total_weight_size", ctypes.c_uint32), ("total_internal_size", ctypes.c_uint32),
                ("total_dma_allocated_size", ctypes.c_uint64), ("total_sram_size", ctypes.c_uint32),
                ("free_sram_size", ctypes.c_uint32), ("reserved", ctypes.c_uint32 * 10)]


def attr_dict(a):
    return {"name": a.name.decode(errors="replace"), "dims": list(a.dims[:a.n_dims]), "n_elems": a.n_elems, "size": a.size,
            "fmt": "NHWC" if a.fmt == NHWC else "NCHW" if a.fmt == NCHW else a.fmt, "type": TYPE_NAMES.get(a.type, a.type),
            "zp": a.zp, "scale": a.scale}


class Model:
    def __init__(self, path, lib=LIB):
        self.lib = ctypes.CDLL(lib)
        data = open(path, "rb").read()
        self._blob = ctypes.create_string_buffer(data, len(data))
        self.ctx = ctx_t(0)
        t0 = time.time()
        ret = self.lib.rknn_init(ctypes.byref(self.ctx), self._blob, ctypes.c_uint32(len(data)), ctypes.c_uint32(0), None)
        if ret != 0:
            raise RuntimeError("rknn_init(%s) failed: %d" % (os.path.basename(path), ret))
        self.init_ms = (time.time() - t0) * 1000
        n = InOutNum()
        self._q(QUERY_IN_OUT_NUM, n)
        self.inputs = [self._attr(QUERY_INPUT_ATTR, i) for i in range(n.n_input)]
        self.outputs = [self._attr(QUERY_OUTPUT_ATTR, i) for i in range(n.n_output)]

    def _q(self, cmd, obj):
        ret = self.lib.rknn_query(self.ctx, ctypes.c_int(cmd), ctypes.byref(obj), ctypes.c_uint32(ctypes.sizeof(obj)))
        if ret != 0:
            raise RuntimeError("rknn_query(%d) failed: %d" % (cmd, ret))
        return obj

    def _attr(self, cmd, i):
        a = TensorAttr()
        a.index = i
        return self._q(cmd, a)

    def versions(self):
        v = self._q(QUERY_SDK_VERSION, SdkVersion())
        return {"api": v.api_version.decode(errors="replace"), "driver": v.drv_version.decode(errors="replace")}

    def mem(self):
        try:
            m = self._q(QUERY_MEM_SIZE, MemSize())
            return {"weights": m.total_weight_size, "internal": m.total_internal_size, "dma": m.total_dma_allocated_size}
        except RuntimeError:
            return None

    def run(self, pixels, want_float=False, in_type=UINT8):
        """One inference: pixels is uint8 NHWC bytes. Returns [(bytes, attr)] per output; npu_us is the NPU's own time."""
        buf = ctypes.create_string_buffer(bytes(pixels), len(pixels))
        inp = (Input * 1)()
        inp[0].index, inp[0].buf, inp[0].size, inp[0].pass_through, inp[0].type, inp[0].fmt = 0, ctypes.cast(buf, ctypes.c_void_p), len(pixels), 0, in_type, NHWC
        if self.lib.rknn_inputs_set(self.ctx, ctypes.c_uint32(1), inp) != 0:
            raise RuntimeError("rknn_inputs_set failed")
        t0 = time.time()
        if self.lib.rknn_run(self.ctx, None) != 0:
            raise RuntimeError("rknn_run failed")
        self.run_ms = (time.time() - t0) * 1000
        n = len(self.outputs)
        outs = (Output * n)()
        for i in range(n):
            outs[i].want_float, outs[i].is_prealloc, outs[i].index = 1 if want_float else 0, 0, i
        if self.lib.rknn_outputs_get(self.ctx, ctypes.c_uint32(n), outs, None) != 0:
            raise RuntimeError("rknn_outputs_get failed")
        res = [(ctypes.string_at(outs[i].buf, outs[i].size), self.outputs[i]) for i in range(n)]
        self.lib.rknn_outputs_release(self.ctx, ctypes.c_uint32(n), outs)
        return res

    def close(self):
        if self.ctx.value:
            self.lib.rknn_destroy(self.ctx)
            self.ctx = ctx_t(0)
