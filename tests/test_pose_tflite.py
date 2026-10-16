"""lib/pose/tflite.py: TFLite graphs rewritten as ONNX for onnxruntime.

Each op the hand models use is checked on random data against a plain numpy
NHWC implementation of TFLite's semantics (written here, independent of the
converter), through onnxruntime. The flatbuffer reader is checked on a tiny
model built with the flatbuffers package (which onnxruntime depends on).
"""
import math

import pytest

np = pytest.importorskip("numpy")
ort = pytest.importorskip("onnxruntime")

from lib.pose import tflite as T

RNG = np.random.default_rng(7)


def _run(model, x):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = opts.inter_op_num_threads = 1
    opts.log_severity_level = 3
    sess = ort.InferenceSession(T.to_onnx(model), opts, providers=["CPUExecutionProvider"])
    return sess.run(None, {sess.get_inputs()[0].name: x})


class _Model:
    """Builds a read_model-shaped dict."""

    def __init__(self, in_shape):
        self.tensors, self.ops = [], []
        self.input = self.tensor(in_shape, name="input")

    def tensor(self, shape, data=None, name=None):
        self.tensors.append({"name": name or f"t{len(self.tensors)}", "shape": list(shape), "data": data})
        return len(self.tensors) - 1

    def op(self, code, ins, out_shape, **options):
        out = self.tensor(out_shape)
        self.ops.append({"code": code, "inputs": list(ins), "outputs": [out], "options": options})
        return out

    def model(self, *outputs):
        return {"tensors": self.tensors, "ops": self.ops, "inputs": [self.input], "outputs": list(outputs)}


# --- numpy references (NHWC, TFLite semantics) ------------------------------

def _same(size, k, s, d=1):
    eff = (k - 1) * d + 1
    total = max((math.ceil(size / s) - 1) * s + eff - size, 0)
    return total // 2, total - total // 2


def np_conv(x, w, b, stride, padding, depthwise=False):
    """x [1,H,W,C]; w [O,kh,kw,I] (conv) or [1,kh,kw,C] (depthwise)."""
    _, h, wd, c = x.shape
    kh, kw = w.shape[1], w.shape[2]
    if padding == T.SAME:
        (t, bt), (l, r) = _same(h, kh, stride), _same(wd, kw, stride)
    else:
        t = bt = l = r = 0
    xp = np.pad(x[0].astype(np.float64), ((t, bt), (l, r), (0, 0)))
    oh, ow = (xp.shape[0] - kh) // stride + 1, (xp.shape[1] - kw) // stride + 1
    out = np.zeros((oh, ow, w.shape[3] if depthwise else w.shape[0]))
    for i in range(kh):
        for j in range(kw):
            win = xp[i:i + stride * oh:stride, j:j + stride * ow:stride]
            out += win * w[0, i, j] if depthwise else win @ w[:, i, j, :].T
    return (out + (0 if b is None else b))[None]


def np_resize_half_pixel(x, oh, ow):
    _, h, w, _ = x.shape

    def axis(o, n):
        src = (np.arange(o) + 0.5) * n / o - 0.5
        lo = np.floor(src)
        return np.clip(lo, 0, n - 1).astype(int), np.clip(lo + 1, 0, n - 1).astype(int), src - lo

    y0, y1, fy = axis(oh, h)
    x0, x1, fx = axis(ow, w)
    img = x[0]
    top = img[y0][:, x0] * (1 - fx)[None, :, None] + img[y0][:, x1] * fx[None, :, None]
    bot = img[y1][:, x0] * (1 - fx)[None, :, None] + img[y1][:, x1] * fx[None, :, None]
    return (top * (1 - fy)[:, None, None] + bot * fy[:, None, None])[None]


def _f32(*shape):
    return RNG.standard_normal(shape).astype(np.float32)


# --- ops -------------------------------------------------------------------

@pytest.mark.parametrize("stride, padding", [(1, T.SAME), (2, T.SAME), (2, T.VALID)])
def test_conv_with_fp16_weights_and_relu6(stride, padding):
    m = _Model([1, 9, 8, 3])
    w16 = (_f32(5, 3, 3, 3) * 0.5).astype(np.float16)
    wq = m.tensor([5, 3, 3, 3], w16)
    w = m.op(T.DEQUANTIZE, [wq], [5, 3, 3, 3])
    b = m.tensor([5], _f32(5))
    oh = math.ceil(9 / stride) if padding == T.SAME else (9 - 3) // stride + 1
    ow = math.ceil(8 / stride) if padding == T.SAME else (8 - 3) // stride + 1
    y = m.op(T.CONV_2D, [m.input, w, b], [1, oh, ow, 5], padding=padding, stride_w=stride, stride_h=stride,
             activation=T.ACT_RELU6, dilation_w=1, dilation_h=1)
    x = _f32(1, 9, 8, 3) * 3
    [got] = _run(m.model(y), x)
    want = np.clip(np_conv(x, w16.astype(np.float32), m.tensors[b]["data"], stride, padding), 0, 6)
    assert got == pytest.approx(want, abs=1e-4)


def test_depthwise_conv_and_prelu():
    m = _Model([1, 8, 8, 4])
    w = m.tensor([1, 5, 5, 4], _f32(1, 5, 5, 4))
    b = m.tensor([4], _f32(4))
    d = m.op(T.DEPTHWISE_CONV_2D, [m.input, w, b], [1, 4, 4, 4], padding=T.SAME, stride_w=2, stride_h=2,
             depth_multiplier=1, activation=T.ACT_NONE, dilation_w=1, dilation_h=1)
    alpha = m.tensor([1, 1, 4], np.array([[[0.1, 0.2, -0.5, 2.0]]], np.float32))
    y = m.op(T.PRELU, [d, alpha], [1, 4, 4, 4])
    x = _f32(1, 8, 8, 4)
    [got] = _run(m.model(y), x)
    z = np_conv(x, m.tensors[w]["data"], m.tensors[b]["data"], 2, T.SAME, depthwise=True)
    want = np.where(z >= 0, z, z * m.tensors[alpha]["data"])
    assert got == pytest.approx(want, abs=1e-4)


def test_max_pool_channel_pad_and_add_with_relu():
    m = _Model([1, 6, 6, 2])
    p = m.op(T.MAX_POOL_2D, [m.input], [1, 3, 3, 2], padding=T.SAME, stride_w=2, stride_h=2,
             filter_w=2, filter_h=2, activation=T.ACT_NONE)
    pads = m.tensor([4, 2], np.array([[0, 0], [0, 0], [0, 0], [0, 2]], np.int32))
    q = m.op(T.PAD, [p, pads], [1, 3, 3, 4])
    w = m.tensor([4, 1, 1, 2], _f32(4, 1, 1, 2))
    c = m.op(T.CONV_2D, [p, w, -1], [1, 3, 3, 4], padding=T.VALID, stride_w=1, stride_h=1,
             activation=T.ACT_NONE, dilation_w=1, dilation_h=1)
    y = m.op(T.ADD, [q, c], [1, 3, 3, 4], activation=T.ACT_RELU)
    x = _f32(1, 6, 6, 2)
    [got] = _run(m.model(y), x)
    pooled = x[0].reshape(3, 2, 3, 2, 2).max(axis=(1, 3))[None]
    padded = np.pad(pooled, ((0, 0), (0, 0), (0, 0), (0, 2)))
    want = np.maximum(padded + np_conv(pooled, m.tensors[w]["data"], None, 1, T.VALID), 0)
    assert got == pytest.approx(want, abs=1e-5)


def test_resize_half_pixel_reshape_and_concat_keep_tflite_order():
    m = _Model([1, 3, 3, 6])
    size = m.tensor([2], np.array([6, 6], np.int32))
    r = m.op(T.RESIZE_BILINEAR, [m.input, size], [1, 6, 6, 6], align_corners=False, half_pixel_centers=True)
    a = m.op(T.RESHAPE, [r], [1, 108, 2])
    b = m.op(T.RESHAPE, [m.input], [1, 27, 2])
    y = m.op(T.CONCATENATION, [a, b], [1, 135, 2], axis=1, activation=T.ACT_NONE)
    x = _f32(1, 3, 3, 6)
    [got] = _run(m.model(y), x)
    want = np.concatenate([np_resize_half_pixel(x, 6, 6).reshape(1, 108, 2), x.reshape(1, 27, 2)], axis=1)
    assert got == pytest.approx(want, abs=1e-5)


def test_mean_fully_connected_and_logistic():
    m = _Model([1, 4, 5, 6])
    axes = m.tensor([2], np.array([1, 2], np.int32))
    g = m.op(T.MEAN, [m.input, axes], [1, 6], keep_dims=False)
    w = m.tensor([3, 6], _f32(3, 6))
    b = m.tensor([3], _f32(3))
    f = m.op(T.FULLY_CONNECTED, [g, w, b], [1, 3], activation=T.ACT_NONE, weights_format=0, keep_num_dims=False)
    y = m.op(T.LOGISTIC, [f], [1, 3])
    x = _f32(1, 4, 5, 6)
    got = _run(m.model(f, y), x)
    lin = x.mean(axis=(1, 2)) @ m.tensors[w]["data"].T + m.tensors[b]["data"]
    assert got[0] == pytest.approx(lin, abs=1e-5)
    assert got[1] == pytest.approx(1 / (1 + np.exp(-lin)), abs=1e-6)


def test_a_4d_output_comes_back_nhwc():
    m = _Model([1, 2, 3, 4])
    y = m.op(T.LOGISTIC, [m.input], [1, 2, 3, 4])
    x = _f32(1, 2, 3, 4)
    [got] = _run(m.model(y), x)
    assert got.shape == (1, 2, 3, 4)
    assert got == pytest.approx(1 / (1 + np.exp(-x)), abs=1e-6)


def test_an_unsupported_op_is_refused_by_name():
    m = _Model([1, 2, 2, 1])
    y = m.op(25, [m.input], [1, 2, 2, 1])   # SOFTMAX
    with pytest.raises(T.ConversionError, match="25"):
        T.to_onnx(m.model(y))
    m = _Model([1, 2, 2, 1])
    y = m.op(T.CONV_2D, [m.input, m.input], [1, 2, 2, 1], padding=T.SAME, stride_w=1, stride_h=1,
             activation=T.ACT_NONE, dilation_w=1, dilation_h=1)
    with pytest.raises(T.ConversionError, match="constant"):
        T.to_onnx(m.model(y))


# --- the flatbuffer reader ---------------------------------------------------

def _tiny_tflite():
    """input [1,2,2,1] -> CONV_2D with a 1x1 float16 weight (via DEQUANTIZE), no bias."""
    flatbuffers = pytest.importorskip("flatbuffers")
    b = flatbuffers.Builder(0)

    def ints(xs):
        b.StartVector(4, len(xs), 4)
        for v in reversed(xs):
            b.PrependInt32(v)
        return b.EndVector()

    def tables(offs):
        b.StartVector(4, len(offs), 4)
        for o in reversed(offs):
            b.PrependUOffsetTRelative(o)
        return b.EndVector()

    weight = np.array([2.5], np.float16).reshape(1, 1, 1, 1)
    data = b.CreateByteVector(weight.tobytes())
    buffers = []
    for d in (None, data):
        b.StartObject(1)
        if d is not None:
            b.PrependUOffsetTRelativeSlot(0, d, 0)
        buffers.append(b.EndObject())

    def tensor(name, shape, ttype, buf):
        n, s = b.CreateString(name), ints(shape)
        b.StartObject(4)
        b.PrependUOffsetTRelativeSlot(0, s, 0)
        b.PrependInt8Slot(1, ttype, 0)
        b.PrependUint32Slot(2, buf, 0)
        b.PrependUOffsetTRelativeSlot(3, n, 0)
        return b.EndObject()

    ts = [tensor("input_1", [1, 2, 2, 1], 0, 0), tensor("w16", [1, 1, 1, 1], 1, 1),
          tensor("w", [1, 1, 1, 1], 0, 0), tensor("Identity", [1, 2, 2, 1], 0, 0)]
    b.StartObject(6)                       # Conv2DOptions: VALID, stride 1, 1
    b.PrependInt8Slot(0, T.VALID, 0)
    b.PrependInt32Slot(1, 1, 0)
    b.PrependInt32Slot(2, 1, 0)
    conv_opts = b.EndObject()

    def operator(index, ins, outs, opts=None):
        i, o = ints(ins), ints(outs)
        b.StartObject(5)
        b.PrependUint32Slot(0, index, 0)
        b.PrependUOffsetTRelativeSlot(1, i, 0)
        b.PrependUOffsetTRelativeSlot(2, o, 0)
        if opts is not None:
            b.PrependUint8Slot(3, 1, 0)
            b.PrependUOffsetTRelativeSlot(4, opts, 0)
        return b.EndObject()

    ops = [operator(0, [1], [2]), operator(1, [0, 2, -1], [3], conv_opts)]
    codes = []
    for code in (T.DEQUANTIZE, T.CONV_2D):
        b.StartObject(4)
        b.PrependInt8Slot(0, code, 0)
        b.PrependInt32Slot(3, code, 0)
        codes.append(b.EndObject())
    t_vec, o_vec, i_vec, out_vec = tables(ts), tables(ops), ints([0]), ints([3])
    b.StartObject(5)
    b.PrependUOffsetTRelativeSlot(0, t_vec, 0)
    b.PrependUOffsetTRelativeSlot(1, i_vec, 0)
    b.PrependUOffsetTRelativeSlot(2, out_vec, 0)
    b.PrependUOffsetTRelativeSlot(3, o_vec, 0)
    sub = b.EndObject()
    code_vec, sub_vec, buf_vec = tables(codes), tables([sub]), tables(buffers)
    b.StartObject(5)
    b.PrependUint32Slot(0, 3, 0)
    b.PrependUOffsetTRelativeSlot(1, code_vec, 0)
    b.PrependUOffsetTRelativeSlot(2, sub_vec, 0)
    b.PrependUOffsetTRelativeSlot(4, buf_vec, 0)
    b.Finish(b.EndObject())
    return bytes(b.Output())


def test_read_model_reads_tensors_ops_and_options():
    model = T.read_model(_tiny_tflite())
    names = [t["name"] for t in model["tensors"]]
    assert names == ["input_1", "w16", "w", "Identity"]
    assert model["tensors"][1]["data"].dtype == np.float16
    assert model["tensors"][1]["data"].ravel().tolist() == [2.5]
    assert model["tensors"][0]["data"] is None
    assert [o["code"] for o in model["ops"]] == [T.DEQUANTIZE, T.CONV_2D]
    assert model["ops"][1]["inputs"] == [0, 2, -1]
    assert model["ops"][1]["options"]["padding"] == T.VALID
    assert model["ops"][1]["options"]["stride_h"] == 1
    assert model["ops"][1]["options"]["dilation_w"] == 1     # absent: the schema default
    assert (model["inputs"], model["outputs"]) == ([0], [3])


def test_a_read_model_runs():
    x = _f32(1, 2, 2, 1)
    [got] = _run(T.read_model(_tiny_tflite()), x)
    assert got == pytest.approx(x * 2.5, abs=1e-6)
