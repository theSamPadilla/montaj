"""A TFLite model rewritten as an ONNX model that onnxruntime runs, in plain
Python and numpy: no TFLite runtime, no onnx package.

It covers what MediaPipe's hand models use, and refuses anything else by name:
ADD, CONCATENATION, CONV_2D, DEPTHWISE_CONV_2D, DEQUANTIZE (of constants),
FULLY_CONNECTED, LOGISTIC, MAX_POOL_2D, MEAN, PAD, PRELU, RESHAPE and
RESIZE_BILINEAR. Weights stay as the model has them: float16 weights become
the float32 values they stand for.

TFLite is NHWC and ONNX's convolutions are NCHW, so the graph transposes its
input once and keeps 4D activations NCHW, going back to NHWC only where a
reshape, a concatenation of non-4D tensors, or an output needs the TFLite
order.

The flatbuffer reader follows the TFLite schema (schema.fbs), and the ONNX
writer follows onnx.proto; each handles only the fields used here.
"""
import math
import struct

import numpy as np

OPSET = 13
IR_VERSION = 8

# BuiltinOperator codes.
ADD, CONCATENATION, CONV_2D, DEPTHWISE_CONV_2D, DEQUANTIZE = 0, 2, 3, 4, 6
FULLY_CONNECTED, LOGISTIC, MAX_POOL_2D, RESHAPE, RESIZE_BILINEAR = 9, 14, 17, 22, 23
PAD, MEAN, PRELU = 34, 40, 54
OP_NAMES = {ADD: "ADD", CONCATENATION: "CONCATENATION", CONV_2D: "CONV_2D",
            DEPTHWISE_CONV_2D: "DEPTHWISE_CONV_2D", DEQUANTIZE: "DEQUANTIZE",
            FULLY_CONNECTED: "FULLY_CONNECTED", LOGISTIC: "LOGISTIC", MAX_POOL_2D: "MAX_POOL_2D",
            RESHAPE: "RESHAPE", RESIZE_BILINEAR: "RESIZE_BILINEAR", PAD: "PAD", MEAN: "MEAN",
            PRELU: "PRELU"}

# TensorType -> numpy.
_DTYPES = {0: np.float32, 1: np.float16, 2: np.int32, 4: np.int64}

# Fused activations: NONE, RELU, RELU6.
ACT_NONE, ACT_RELU, ACT_RELU6 = 0, 1, 3

# Padding: SAME, VALID.
SAME, VALID = 0, 1


class ConversionError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Flatbuffer reading
# ---------------------------------------------------------------------------

class _Table:
    """One flatbuffer table: fields by vtable slot."""

    def __init__(self, buf, pos):
        self.buf, self.pos = buf, pos
        self.vtable = pos - struct.unpack_from("<i", buf, pos)[0]
        self.vsize = struct.unpack_from("<H", buf, self.vtable)[0]

    def _field(self, slot):
        at = 4 + 2 * slot
        if at >= self.vsize:
            return 0
        off = struct.unpack_from("<H", self.buf, self.vtable + at)[0]
        return self.pos + off if off else 0

    def scalar(self, slot, fmt, default=0):
        at = self._field(slot)
        return struct.unpack_from("<" + fmt, self.buf, at)[0] if at else default

    def _target(self, slot):
        at = self._field(slot)
        return at + struct.unpack_from("<I", self.buf, at)[0] if at else 0

    def table(self, slot):
        at = self._target(slot)
        return _Table(self.buf, at) if at else None

    def _vector(self, slot):
        at = self._target(slot)
        if not at:
            return 0, 0
        return at + 4, struct.unpack_from("<I", self.buf, at)[0]

    def tables(self, slot):
        start, n = self._vector(slot)
        out = []
        for i in range(n):
            at = start + 4 * i
            out.append(_Table(self.buf, at + struct.unpack_from("<I", self.buf, at)[0]))
        return out

    def ints(self, slot):
        start, n = self._vector(slot)
        return list(struct.unpack_from(f"<{n}i", self.buf, start)) if n else []

    def bytes(self, slot):
        start, n = self._vector(slot)
        return bytes(self.buf[start:start + n])

    def string(self, slot):
        return self.bytes(slot).decode("utf-8")


def _options(code, t):
    """An operator's builtin options as a dict (schema field order)."""
    if t is None:
        return {}
    if code == CONV_2D:
        return {"padding": t.scalar(0, "b"), "stride_w": t.scalar(1, "i"), "stride_h": t.scalar(2, "i"),
                "activation": t.scalar(3, "b"), "dilation_w": t.scalar(4, "i", 1), "dilation_h": t.scalar(5, "i", 1)}
    if code == DEPTHWISE_CONV_2D:
        return {"padding": t.scalar(0, "b"), "stride_w": t.scalar(1, "i"), "stride_h": t.scalar(2, "i"),
                "depth_multiplier": t.scalar(3, "i"), "activation": t.scalar(4, "b"),
                "dilation_w": t.scalar(5, "i", 1), "dilation_h": t.scalar(6, "i", 1)}
    if code == ADD:
        return {"activation": t.scalar(0, "b")}
    if code == MAX_POOL_2D:
        return {"padding": t.scalar(0, "b"), "stride_w": t.scalar(1, "i"), "stride_h": t.scalar(2, "i"),
                "filter_w": t.scalar(3, "i"), "filter_h": t.scalar(4, "i"), "activation": t.scalar(5, "b")}
    if code == RESIZE_BILINEAR:
        return {"align_corners": bool(t.scalar(2, "B")), "half_pixel_centers": bool(t.scalar(3, "B"))}
    if code == CONCATENATION:
        return {"axis": t.scalar(0, "i"), "activation": t.scalar(1, "b")}
    if code == MEAN:
        return {"keep_dims": bool(t.scalar(0, "B"))}
    if code == FULLY_CONNECTED:
        return {"activation": t.scalar(0, "b"), "weights_format": t.scalar(1, "b"),
                "keep_num_dims": bool(t.scalar(2, "B"))}
    return {}


def read_model(data):
    """A TFLite flatbuffer as {tensors, ops, inputs, outputs}: tensors are
    {name, shape, data (numpy or None)}; ops are {code, inputs, outputs,
    options}. The first subgraph only."""
    buf = bytes(data)
    root = _Table(buf, struct.unpack_from("<I", buf, 0)[0])
    buffers = [b.bytes(0) for b in root.tables(4)]
    codes = []
    for c in root.tables(1):
        # builtin_code (slot 3) supersedes the deprecated byte (slot 0) from 127 up.
        codes.append(max(c.scalar(0, "b"), c.scalar(3, "i")))
    graph = root.tables(2)[0]
    tensors = []
    for t in graph.tables(0):
        ttype = t.scalar(1, "b")
        raw = buffers[t.scalar(2, "I")]
        arr = None
        if raw:
            if ttype not in _DTYPES:
                raise ConversionError(f"tensor type {ttype} is not supported")
            arr = np.frombuffer(raw, _DTYPES[ttype]).reshape(t.ints(0))
        tensors.append({"name": t.string(3), "shape": t.ints(0), "data": arr})
    ops = []
    for o in graph.tables(3):
        code = codes[o.scalar(0, "I")]
        ops.append({"code": code, "inputs": o.ints(1), "outputs": o.ints(2),
                    "options": _options(code, o.table(4))})
    return {"tensors": tensors, "ops": ops, "inputs": graph.ints(1), "outputs": graph.ints(2)}


def convert(data):
    """ONNX bytes for TFLite bytes. Bytes this reader cannot parse (a truncated
    or foreign file) raise ConversionError, never a bare struct or index error."""
    try:
        return to_onnx(read_model(data))
    except ConversionError:
        raise
    except (struct.error, IndexError, KeyError, ValueError) as e:
        raise ConversionError(f"not a TFLite model this converter reads ({type(e).__name__}: {e})") from e


# ---------------------------------------------------------------------------
# ONNX protobuf writing
# ---------------------------------------------------------------------------

def _varint(n):
    n &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _key(field, wire):
    return _varint((field << 3) | wire)


def _len(field, payload):
    return _key(field, 2) + _varint(len(payload)) + payload


def _int(field, n):
    return _key(field, 0) + _varint(n)


def _str(field, s):
    return _len(field, s.encode("utf-8"))


def _tensor(name, arr):
    arr = np.ascontiguousarray(arr)
    dtype = {np.dtype(np.float32): 1, np.dtype(np.int64): 7}[arr.dtype]
    return (b"".join(_int(1, d) for d in arr.shape) + _int(2, dtype) + _str(8, name)
            + _len(9, arr.astype(arr.dtype.newbyteorder("<")).tobytes()))


def _attr(name, value):
    if isinstance(value, str):
        return _str(1, name) + _len(4, value.encode("utf-8")) + _int(20, 3)
    if isinstance(value, (list, tuple)):
        return _str(1, name) + b"".join(_int(8, int(v)) for v in value) + _int(20, 7)
    if isinstance(value, int):
        return _str(1, name) + _int(3, value) + _int(20, 2)
    raise ConversionError(f"attribute {name}: {value!r}")


def _value_info(name, shape):
    dims = b"".join(_len(1, _int(1, d)) for d in shape)
    tensor_type = _int(1, 1) + _len(2, dims)
    return _str(1, name) + _len(2, _len(1, tensor_type))


class _Graph:
    def __init__(self):
        self.nodes, self.inits, self.count = [], [], 0

    def fresh(self, base):
        self.count += 1
        return f"{base}_{self.count}"

    def const(self, arr, base="const"):
        name = self.fresh(base)
        self.inits.append(_tensor(name, arr))
        return name

    def node(self, op, inputs, base=None, **attrs):
        out = self.fresh(base or op.lower())
        self.nodes.append(b"".join(_str(1, i) for i in inputs) + _str(2, out) + _str(3, out) + _str(4, op)
                          + b"".join(_len(5, _attr(k, v)) for k, v in attrs.items()))
        return out

    def named(self, op, inputs, out):
        self.nodes.append(b"".join(_str(1, i) for i in inputs) + _str(2, out) + _str(3, out) + _str(4, op))


def _same_pads(size, kernel, stride, dilation):
    """TFLite's SAME padding: (before, after), the odd pixel after."""
    effective = (kernel - 1) * dilation + 1
    total = max((math.ceil(size / stride) - 1) * stride + effective - size, 0)
    return total // 2, total - total // 2


def _spatial_pads(opts, shape, kh, kw, sh, sw, dh=1, dw=1):
    """ONNX pads [top, left, bottom, right] for an NHWC input shape."""
    if opts["padding"] == VALID:
        return [0, 0, 0, 0]
    (t, b), (l, r) = _same_pads(shape[1], kh, sh, dh), _same_pads(shape[2], kw, sw, dw)
    return [t, l, b, r]


# NHWC axis -> NCHW axis.
_TO_NCHW = [0, 2, 3, 1]


def to_onnx(model):
    """ONNX ModelProto bytes for a model read by read_model."""
    tensors, g = model["tensors"], _Graph()
    if len(model["inputs"]) != 1:
        raise ConversionError("only single-input models are supported")
    consts = {i: t["data"] for i, t in enumerate(tensors) if t["data"] is not None}
    names, nchw = {}, set()

    def const(i):
        a = consts.get(i)
        if a is None:
            raise ConversionError(f"tensor {tensors[i]['name']!r} must be a constant")
        return a.astype(np.float32) if a.dtype == np.float16 else a

    def activation(name, act):
        if act == ACT_NONE:
            return name
        if act == ACT_RELU:
            return g.node("Relu", [name])
        if act == ACT_RELU6:
            return g.node("Clip", [name, g.const(np.array(0, np.float32)), g.const(np.array(6, np.float32))])
        raise ConversionError(f"fused activation {act} is not supported")

    def nhwc(i):
        if i in nchw:
            return g.node("Transpose", [names[i]], perm=[0, 2, 3, 1])
        return names[i]

    in_index = model["inputs"][0]
    in_name = tensors[in_index]["name"]
    names[in_index] = g.node("Transpose", [in_name], perm=[0, 3, 1, 2])
    nchw.add(in_index)

    for op in model["ops"]:
        code, ins, outs, opts = op["code"], op["inputs"], op["outputs"], op["options"]
        out = outs[0]
        if code == DEQUANTIZE:
            consts[out] = const(ins[0])
            continue
        if code in (CONV_2D, DEPTHWISE_CONV_2D):
            shape = tensors[ins[0]]["shape"]
            w = const(ins[1])
            if code == CONV_2D:
                weight, group = w.transpose(0, 3, 1, 2), 1                  # OHWI -> OIHW
            else:
                weight, group = w.transpose(3, 0, 1, 2), shape[3]           # 1HW(C*M) -> (C*M)1HW
            kh, kw = weight.shape[2], weight.shape[3]
            sh, sw, dh, dw = opts["stride_h"], opts["stride_w"], opts["dilation_h"], opts["dilation_w"]
            inputs = [names[ins[0]], g.const(weight, "weight")]
            if len(ins) > 2 and ins[2] >= 0:
                inputs.append(g.const(const(ins[2]), "bias"))
            y = g.node("Conv", inputs, group=group, strides=[sh, sw], dilations=[dh, dw],
                       kernel_shape=[kh, kw], pads=_spatial_pads(opts, shape, kh, kw, sh, sw, dh, dw))
            names[out] = activation(y, opts["activation"])
            nchw.add(out)
        elif code == ADD:
            if not all(i in names and i in nchw for i in ins):
                raise ConversionError("ADD is supported between two activations only")
            names[out] = activation(g.node("Add", [names[i] for i in ins]), opts.get("activation", ACT_NONE))
            nchw.add(out)
        elif code == PRELU:
            alpha = const(ins[1]).reshape(-1, 1, 1)
            names[out] = g.node("PRelu", [names[ins[0]], g.const(alpha, "alpha")])
            nchw.add(out)
        elif code == MAX_POOL_2D:
            shape = tensors[ins[0]]["shape"]
            kh, kw, sh, sw = opts["filter_h"], opts["filter_w"], opts["stride_h"], opts["stride_w"]
            y = g.node("MaxPool", [names[ins[0]]], kernel_shape=[kh, kw], strides=[sh, sw],
                       pads=_spatial_pads(opts, shape, kh, kw, sh, sw))
            names[out] = activation(y, opts["activation"])
            nchw.add(out)
        elif code == PAD:
            p = const(ins[1]).astype(np.int64)                                  # [4, 2], NHWC
            order = [0, 3, 1, 2]
            pads = np.array([p[a, 0] for a in order] + [p[a, 1] for a in order], np.int64)
            names[out] = g.node("Pad", [names[ins[0]], g.const(pads, "pads")])
            nchw.add(out)
        elif code == RESIZE_BILINEAR:
            if opts["align_corners"]:
                mode = "align_corners"
            elif opts["half_pixel_centers"]:
                mode = "half_pixel"
            else:
                mode = "asymmetric"
            h, w = const(ins[1]).astype(np.int64)
            c = tensors[ins[0]]["shape"][3]
            sizes = g.const(np.array([1, c, h, w], np.int64), "sizes")
            names[out] = g.node("Resize", [names[ins[0]], "", "", sizes], mode="linear",
                                coordinate_transformation_mode=mode)
            nchw.add(out)
        elif code == RESHAPE:
            shape = np.array(tensors[out]["shape"], np.int64)
            names[out] = g.node("Reshape", [nhwc(ins[0]), g.const(shape, "shape")])
        elif code == CONCATENATION:
            axis = opts["axis"]
            if all(i in nchw for i in ins):
                names[out] = g.node("Concat", [names[i] for i in ins], axis=_TO_NCHW[axis % 4])
                nchw.add(out)
            else:
                names[out] = g.node("Concat", [nhwc(i) for i in ins], axis=axis)
            names[out] = activation(names[out], opts["activation"])
        elif code == MEAN:
            axes = [int(a) for a in const(ins[1]).ravel()]
            keep = opts["keep_dims"]
            if ins[0] in nchw:
                axes = [_TO_NCHW[a % 4] for a in axes]
            names[out] = g.node("ReduceMean", [names[ins[0]]], axes=axes, keepdims=int(keep))
            if keep and ins[0] in nchw:
                nchw.add(out)
        elif code == FULLY_CONNECTED:
            if opts.get("weights_format", 0) != 0 or opts.get("keep_num_dims"):
                raise ConversionError("FULLY_CONNECTED with shuffled weights or kept dims is not supported")
            inputs = [nhwc(ins[0]), g.const(const(ins[1]), "weight")]
            if len(ins) > 2 and ins[2] >= 0:
                inputs.append(g.const(const(ins[2]), "bias"))
            names[out] = activation(g.node("Gemm", inputs, transB=1), opts.get("activation", ACT_NONE))
        elif code == LOGISTIC:
            names[out] = g.node("Sigmoid", [names[ins[0]]])
            if ins[0] in nchw:
                nchw.add(out)
        else:
            raise ConversionError(f"TFLite op {OP_NAMES.get(code, code)} is not supported")

    outputs = []
    for i in model["outputs"]:
        name = tensors[i]["name"]
        g.named("Identity", [nhwc(i)], name)
        outputs.append(_value_info(name, tensors[i]["shape"]))
    graph = (b"".join(_len(1, n) for n in g.nodes) + _str(2, "graph")
             + b"".join(_len(5, t) for t in g.inits)
             + _len(11, _value_info(in_name, tensors[in_index]["shape"]))
             + b"".join(_len(12, o) for o in outputs))
    opset = _str(1, "") + _int(2, OPSET)
    return _int(1, IR_VERSION) + _str(2, "montaj") + _len(7, graph) + _len(8, opset)
