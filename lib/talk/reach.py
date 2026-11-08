"""How far each face key moves the head at weight 1.0, in mm, read from the head's own GLB morph targets.
In code: reach(glb) -> {key: mm}; weight_for(reach_mm, key, target_mm) -> weight.
Reach is the p99 of the moved vertices' displacement length (vertices over 1e-5 m), times 1000. Deterministic."""
import json, struct
import numpy as np

MOVED = 1e-5
CT = {5126: "<f4", 5123: "<u2", 5125: "<u4", 5121: "u1", 5120: "i1", 5122: "<i2"}
IT = {5123: "<u2", 5125: "<u4", 5121: "u1"}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def load_glb(path):
    with open(path, "rb") as f:
        b = f.read()
    if b[:4] != b"glTF":
        raise ValueError(f"{path}: not a GLB")
    n = struct.unpack("<I", b[12:16])[0]
    return json.loads(b[20:20 + n]), b[20 + n + 8:]


def _view(j, bin_, vi, off, count, cc, dt):
    v = j["bufferViews"][vi]
    stride = v.get("byteStride", 0)
    if stride not in (0, np.dtype(dt).itemsize * cc):
        raise ValueError(f"bufferView {vi}: byteStride {stride} is not tight packing")
    o = v.get("byteOffset", 0) + off
    return np.frombuffer(bin_, dtype=dt, count=count * cc, offset=o).reshape(-1, cc)


def read_accessor(j, bin_, i):
    a = j["accessors"][i]
    cc = NC[a["type"]]
    dt = CT[a["componentType"]]
    if "bufferView" in a:
        t = _view(j, bin_, a["bufferView"], a.get("byteOffset", 0), a["count"], cc, dt).astype(np.float64)
    else:
        t = np.zeros((a["count"], cc))
    if "sparse" in a:
        sp = a["sparse"]
        ix, vals = sp["indices"], sp["values"]
        idx = _view(j, bin_, ix["bufferView"], ix.get("byteOffset", 0), sp["count"], 1, IT[ix["componentType"]]).ravel()
        t = t.copy()
        t[idx] = _view(j, bin_, vals["bufferView"], vals.get("byteOffset", 0), sp["count"], cc, dt)
    return t


def face_mesh(j):
    for m in j.get("meshes", []):
        if "jawOpen" in ((m.get("extras") or {}).get("targetNames") or []):
            return m
    raise ValueError("no face mesh: no mesh has jawOpen in extras.targetNames")


def reach(glb_path, keys=None):
    j, bin_ = load_glb(glb_path)
    mesh = face_mesh(j)
    names = mesh["extras"]["targetNames"]
    want = names if keys is None else [k for k in keys if k in names]
    out = {}
    for pr in mesh["primitives"]:
        targets = pr.get("targets", [])
        for k in want:
            ti = names.index(k)
            if ti >= len(targets) or "POSITION" not in targets[ti]:
                continue
            pa = j["accessors"][targets[ti]["POSITION"]]
            if pa.get("normalized") or pa["componentType"] != 5126:
                raise ValueError(f"{k}: morph target POSITION accessor must be float (5126, not normalized); got componentType {pa['componentType']}, normalized {bool(pa.get('normalized'))}")
            r = np.linalg.norm(read_accessor(j, bin_, targets[ti]["POSITION"]), axis=1)
            mv = r[r > MOVED]
            v = float(np.percentile(mv, 99)) * 1000 if len(mv) else 0.0
            out[k] = max(out.get(k, 0.0), v)
    return out


def weight_for(reach_mm, key, target_mm, cap=1.0):
    r = reach_mm.get(key, 0.0)
    if not r or r <= 0:
        return 0.0
    return float(min(max(target_mm / r, 0.0), cap))
