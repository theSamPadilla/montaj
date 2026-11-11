"""How far each face key moves the head at weight 1.0, in mm, read from the head's own morph targets.
In code: reach(head) -> {key: mm}; weight_for(reach_mm, key, target_mm) -> weight.
head is a GLB, or the Montaj app's own model.json (told apart by content). Same number from either, within the app's int16
quantisation of its shape keys.
Reach is the p99 of the moved vertices' displacement length (vertices over 1e-5 m), times 1000. Deterministic.

model.json (app importer, library/model3d/import.js + mesh.js): each part has a mesh id; the mesh data is inline in model["meshes"] or in
<dir>/meshes/<id>.json. A mesh's "morphs" are sparse {name, idx, delta, scale}: delta is base64 little-endian int16 x3 per moved vertex,
metres = delta * scale; the part's own "scale" (number or [x,y,z]) multiplies it. The import's 'fit' units rescale the whole model to a
height; that scale is only in the rig.json beside model.json (place.scale), so it is divided back out when that file is there. Without it
the model is taken as real metres (a 'file' import or a model built at real size)."""
import base64, json, os, struct
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


def _is_glb(path):
    with open(path, "rb") as f:
        return f.read(4) == b"glTF"


def variant_base(model, dirname):
    """The folder of the model a variant is made from: <models>/<variantOf>/, a sibling of this model's folder, or None."""
    v = model.get("variantOf") if isinstance(model, dict) else None
    if not isinstance(v, str) or not v or v != os.path.basename(v) or v in (".", ".."):
        return None
    d = os.path.join(os.path.dirname(dirname), v)
    return d if os.path.isfile(os.path.join(d, "model.json")) else None


def _mesh_data(model, dirname, mid):
    inline = model.get("meshes")
    if isinstance(inline, dict) and mid in inline:
        return inline[mid]
    base = variant_base(model, dirname)
    tried = []
    for d in [dirname] + ([base] if base else []):
        f = os.path.join(d, "meshes", mid + ".json")
        tried.append(f)
        if os.path.isfile(f):
            with open(f) as fh:
                return json.load(fh)
    raise ValueError(f"mesh {mid}: not in model['meshes'] and no {' or '.join(tried)}")


def _siblings(a, b):
    """Two part names of one glTF mesh split by material or primitive (<node>_<material>, <node>_part2): they share a prefix
    of at least 3 characters that ends at an underscore."""
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    n = a.rfind("_", 0, n) + 1
    return n >= 3


def _reach_model(path, keys):
    with open(path) as f:
        model = json.load(f)
    dirname = os.path.dirname(os.path.abspath(path))
    if not model.get("parts"):  # a variant that lists no parts of its own wears its base's
        base = variant_base(model, dirname)
        if base:
            with open(os.path.join(base, "model.json")) as f:
                bm = json.load(f)
            model = dict(bm, meshes=model.get("meshes") or bm.get("meshes"), variantOf=model.get("variantOf"))
    rig = os.path.join(dirname, "rig.json")
    placed = 1.0
    if os.path.isfile(rig):
        with open(rig) as f:
            sc = ((json.load(f) or {}).get("place") or {}).get("scale")
        if isinstance(sc, (int, float)) and sc > 0:
            placed = float(sc)
    cand = []  # (part, mesh data, {key name: morph}) for the parts that carry jawOpen
    for p in model.get("parts", []):
        if p.get("shape") != "mesh" or "mesh" not in p:
            continue
        d = _mesh_data(model, dirname, p["mesh"])
        ms = {m["name"]: m for m in d.get("morphs") or []}
        if "jawOpen" in ms:
            cand.append((p, d, ms))
    if not cand:
        raise ValueError("no face mesh: no part has a jawOpen shape key")
    # The face is the part with most vertices that has jawOpen (teeth, gums and tongue have it too); its sibling primitives (one
    # glTF mesh split by material or primitive) share its name's prefix up to an underscore and add the keys it lacks.
    main = max(cand, key=lambda c: c[1]["count"])
    face = [c for c in cand if c is main or _siblings(main[0]["name"], c[0]["name"])]
    out = {}
    for p, d, ms in face:
        ps = p.get("scale", 1)
        ps = np.array(ps if isinstance(ps, list) else [ps] * 3, dtype=np.float64)
        for k, m in ms.items():
            if keys is not None and k not in keys:
                continue
            raw = base64.b64decode(m["delta"])
            dl = np.frombuffer(raw, dtype="<i2").reshape(-1, 3).astype(np.float64) * float(m["scale"]) * ps / placed
            r = np.linalg.norm(dl, axis=1)
            mv = r[r > MOVED]
            v = float(np.percentile(mv, 99)) * 1000 if len(mv) else 0.0
            out[k] = max(out.get(k, 0.0), v)
    return {k: out[k] for k in keys if k in out} if keys is not None else out


def reach(head_path, keys=None):
    if not _is_glb(head_path):
        return _reach_model(head_path, keys)
    glb_path = head_path
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
