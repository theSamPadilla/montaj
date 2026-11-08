"""Tests for lib/talk/reach.py: tiny synthetic GLBs with known displacements."""
import base64, json, os, shutil, struct, tempfile, unittest
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


FIX = os.path.join(os.path.dirname(__file__), "fixtures", "talk")
TINY_GLB = os.path.join(FIX, "tiny-head.glb")
TINY_MODEL = os.path.join(FIX, "tiny-head", "model.json")
QUANT = 0.002  # mm: the app's int16 quantisation of a 52 mm key is 52 / 32767 mm a step


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def morph(name, idx, delta_m):
    """An app shape key: sparse idx, delta in metres quantised to int16 x scale."""
    d = np.asarray(delta_m, float); scale = np.abs(d).max() / 32767
    return {"name": name, "idx": b64(np.asarray(idx, "<u4")), "delta": b64(np.round(d / scale).astype("<i2")), "scale": scale}


def part(name, mid, scale=None):
    p = {"name": name, "bone": "root", "shape": "mesh", "mesh": mid}
    if scale is not None: p["scale"] = scale
    return p


class ReachModelJsonTest(unittest.TestCase):
    """Reach read from the app's model.json (library/model3d/import.js, mesh.js) agrees with the GLB it was imported from."""

    def setUp(self):
        self.d = tempfile.TemporaryDirectory(); self.addCleanup(self.d.cleanup)

    def test_fixture_matches_its_glb(self):
        g, m = R.reach(TINY_GLB), R.reach(TINY_MODEL)
        self.assertEqual(sorted(g), ["browInnerUp", "jawOpen"])
        self.assertEqual(sorted(m), sorted(g))
        for k in g:
            self.assertAlmostEqual(m[k], g[k], delta=QUANT)
        self.assertGreater(g["jawOpen"], 50)  # a real reach, not two zeros agreeing

    def test_detects_by_content_not_extension(self):
        a, b = os.path.join(self.d.name, "head.bin"), os.path.join(self.d.name, "model.glb")
        shutil.copy(TINY_GLB, a); shutil.copytree(os.path.dirname(TINY_MODEL), os.path.join(self.d.name, "m"))
        shutil.copy(os.path.join(self.d.name, "m", "model.json"), b); shutil.copytree(os.path.join(self.d.name, "m", "meshes"), os.path.join(self.d.name, "meshes"))
        self.assertEqual(R.reach(a), R.reach(TINY_GLB))
        self.assertEqual(R.reach(b), R.reach(TINY_MODEL))

    def test_keys_filter_and_order(self):
        self.assertEqual(list(R.reach(TINY_MODEL, keys=["browInnerUp", "nope", "jawOpen"])), ["browInnerUp", "jawOpen"])

    def test_rig_json_place_scale_is_divided_out(self):
        # A 'fit' import scales the model; rig.json beside it records place.scale.
        shutil.copytree(os.path.dirname(TINY_MODEL), os.path.join(self.d.name, "m"))
        with open(os.path.join(self.d.name, "m", "rig.json"), "w") as f: json.dump({"format": 1, "place": {"scale": 2.0}}, f)
        half = R.reach(os.path.join(self.d.name, "m", "model.json"))
        for k, v in R.reach(TINY_GLB).items():
            self.assertAlmostEqual(half[k], v / 2, delta=QUANT)

    def test_part_scale_multiplies(self):
        mesh = {"count": 4, "morphs": [morph("jawOpen", [0, 1, 2, 3], [[0, .01, 0]] * 4)]}
        for sc, mm in ((None, 10.0), (3, 30.0), ([1, 2, 1], 20.0)):
            model = {"parts": [part("head", "a", sc)], "meshes": {"a": mesh}}
            p = os.path.join(self.d.name, "m.json")
            with open(p, "w") as f: json.dump(model, f)
            self.assertAlmostEqual(R.reach(p)["jawOpen"], mm, places=2)

    def test_face_is_the_big_mesh_and_its_siblings_not_teeth(self):
        skin = {"count": 5000, "morphs": [morph("jawOpen", [0, 1], [[0, .04, 0]] * 2)]}
        lash = {"count": 100, "morphs": [morph("jawOpen", [0], [[0, .001, 0]]), morph("browInnerUp", [0], [[0, .005, 0]])]}
        teeth = {"count": 900, "morphs": [morph("jawOpen", [0, 1], [[0, .09, 0]] * 2), morph("tongueOut", [0], [[0, .05, 0]])]}
        model = {"parts": [part("head_lash", "l"), part("head_skin", "s"), part("teeth_lower", "t")], "meshes": {"s": skin, "l": lash, "t": teeth}}
        p = os.path.join(self.d.name, "m.json")
        with open(p, "w") as f: json.dump(model, f)
        r = R.reach(p)
        self.assertAlmostEqual(r["jawOpen"], 40.0, places=2)  # not the teeth's 90
        self.assertAlmostEqual(r["browInnerUp"], 5.0, places=2)  # a sibling primitive's key counts
        self.assertNotIn("tongueOut", r)

    def test_sidecar_and_inline_meshes(self):
        mesh = {"count": 2, "morphs": [morph("jawOpen", [0, 1], [[0, .02, 0]] * 2)]}
        os.makedirs(os.path.join(self.d.name, "meshes"))
        with open(os.path.join(self.d.name, "meshes", "a.json"), "w") as f: json.dump(mesh, f)
        side = os.path.join(self.d.name, "model.json")
        with open(side, "w") as f: json.dump({"parts": [part("head", "a")]}, f)
        self.assertAlmostEqual(R.reach(side)["jawOpen"], 20.0, places=2)

    def test_errors(self):
        p = os.path.join(self.d.name, "m.json")
        with open(p, "w") as f: json.dump({"parts": [part("head", "gone")]}, f)
        with self.assertRaises(ValueError): R.reach(p)  # mesh not found
        with open(p, "w") as f: json.dump({"parts": [part("head", "a")], "meshes": {"a": {"count": 1, "morphs": [morph("browInnerUp", [0], [[0, .01, 0]])]}}}, f)
        with self.assertRaises(ValueError): R.reach(p)  # no jawOpen
