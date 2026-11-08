"""Tests for lib/talk/reach.py: tiny synthetic GLBs with known displacements."""
import json, os, struct, tempfile, unittest
import numpy as np

from lib.talk import reach as R


def pad4(b, fill=b"\0"):
    return b + fill * (-len(b) % 4)


def make_glb(path, prims, names=("jawOpen", "browInnerUp"), face=True):
    """prims: list of dicts {jaw: Nx3 dense, brow: (indices, Mx3) sparse}. Position count N is len(jaw)."""
    bin_ = b""; views = []; accs = []

    def add_view(data):
        nonlocal bin_
        views.append({"buffer": 0, "byteOffset": len(bin_), "byteLength": len(data)})
        bin_ += pad4(data)
        return len(views) - 1

    def add_acc(**a):
        accs.append(a); return len(accs) - 1

    jprims = []
    for p in prims:
        jaw = np.asarray(p["jaw"], "<f4"); n = len(jaw)
        pos = add_acc(bufferView=add_view(np.zeros((n, 3), "<f4").tobytes()), componentType=5126, count=n, type="VEC3")
        jt = add_acc(bufferView=add_view(jaw.tobytes()), componentType=5126, count=n, type="VEC3")
        idx, vals = p["brow"]
        iv = add_view(np.asarray(idx, "<u2").tobytes()); vv = add_view(np.asarray(vals, "<f4").tobytes())
        bt = add_acc(componentType=5126, count=n, type="VEC3",
                     sparse={"count": len(idx), "indices": {"bufferView": iv, "componentType": 5123},
                             "values": {"bufferView": vv}})
        jprims.append({"attributes": {"POSITION": pos}, "targets": [{"POSITION": jt}, {"POSITION": bt}]})
    extras = {"targetNames": list(names)} if face else {}
    j = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(bin_)}], "bufferViews": views, "accessors": accs,
         "meshes": [{"primitives": jprims, "extras": extras}], "nodes": [{"mesh": 0}]}
    jb = pad4(json.dumps(j).encode(), b" ")
    total = 12 + 8 + len(jb) + 8 + len(bin_)
    with open(path, "wb") as f:
        f.write(b"glTF" + struct.pack("<II", 2, total))
        f.write(struct.pack("<I", len(jb)) + b"JSON" + jb)
        f.write(struct.pack("<I", len(bin_)) + b"BIN\0" + bin_)


class ReachTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory(); self.addCleanup(self.d.cleanup)

    def path(self, n="a.glb"):
        return os.path.join(self.d.name, n)

    def test_values(self):
        # jaw: every vertex moves 0.04 m along y (dense). brow: sparse, 2 of 4 vertices move 0.003 m along x.
        jaw = [[0, 0.04, 0]] * 4
        make_glb(self.path(), [{"jaw": jaw, "brow": ([1, 3], [[0.003, 0, 0], [0.003, 0, 0]])}])
        r = R.reach(self.path())
        self.assertAlmostEqual(r["jawOpen"], 40.0, places=3)
        self.assertAlmostEqual(r["browInnerUp"], 3.0, places=3)

    def test_unmoved_vertices_ignored(self):
        jaw = [[0, 0, 0]] * 3 + [[0, 0.01, 0]]
        make_glb(self.path(), [{"jaw": jaw, "brow": ([0], [[0.002, 0, 0]])}])
        self.assertAlmostEqual(R.reach(self.path())["jawOpen"], 10.0, places=3)

    def test_keys_filter(self):
        make_glb(self.path(), [{"jaw": [[0, 0.01, 0]] * 2, "brow": ([0], [[0.002, 0, 0]])}])
        self.assertEqual(list(R.reach(self.path(), keys=["browInnerUp", "nope"])), ["browInnerUp"])

    def test_max_over_primitives(self):
        make_glb(self.path(), [{"jaw": [[0, 0.01, 0]] * 2, "brow": ([0], [[0.005, 0, 0]])},
                               {"jaw": [[0, 0.03, 0]] * 2, "brow": ([0], [[0.002, 0, 0]])}])
        r = R.reach(self.path())
        self.assertAlmostEqual(r["jawOpen"], 30.0, places=3)
        self.assertAlmostEqual(r["browInnerUp"], 5.0, places=3)

    def test_no_face_mesh(self):
        make_glb(self.path(), [{"jaw": [[0, 0.01, 0]], "brow": ([0], [[0.001, 0, 0]])}], face=False)
        with self.assertRaises(ValueError):
            R.reach(self.path())

    def test_non_float_target_raises(self):
        make_glb(self.path(), [{"jaw": [[0, 0.01, 0]] * 2, "brow": ([0], [[0.001, 0, 0]])}])
        j, bin_ = R.load_glb(self.path())
        for edit in ({"normalized": True}, {"componentType": 5123}):
            j2 = json.loads(json.dumps(j)); t = j2["meshes"][0]["primitives"][0]["targets"][0]["POSITION"]; j2["accessors"][t].update(edit)
            jb = pad4(json.dumps(j2).encode(), b" "); p = self.path("b.glb")
            with open(p, "wb") as f:
                f.write(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(jb) + 8 + len(bin_)) + struct.pack("<I", len(jb)) + b"JSON" + jb + struct.pack("<I", len(bin_)) + b"BIN\0" + bin_)
            with self.assertRaises(ValueError): R.reach(p)

    def test_weight_for(self):
        r = {"a": 10.0, "z": 0.0}
        self.assertAlmostEqual(R.weight_for(r, "a", 5.0), 0.5)
        self.assertEqual(R.weight_for(r, "a", 50.0), 1.0)
        self.assertEqual(R.weight_for(r, "a", 50.0, cap=2.0), 2.0)
        self.assertAlmostEqual(R.weight_for(r, "a", 15.0, cap=2.0), 1.5)
        self.assertEqual(R.weight_for(r, "a", -5.0), 0.0)
        self.assertEqual(R.weight_for(r, "missing", 5.0), 0.0)
        self.assertEqual(R.weight_for(r, "z", 5.0), 0.0)

