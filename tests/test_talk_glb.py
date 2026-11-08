"""Tests for lib/talk/glb.py: write a talk clip as a GLB, read it back with a minimal reader, and check it carries the clip.

The app half of the round trip (add_clips' retarget gives the clip's values back) is montaj-app's
desktop/test/model-add-clips.test.mjs; these pin the file itself."""
import json, math, os, tempfile, unittest

import numpy as np

from lib.talk import glb as G
from lib.talk.reach import load_glb, read_accessor

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'talk')
F32 = 1e-6  # float32 on values near 1 (and times to 6 s)


def golden(key='en-x1'):
    with open(os.path.join(FIX, 'golden_clips.json')) as f:
        return json.load(f)[key]


def read(path):
    """-> (json, {node index: world 4x4}, {node name: index}, channels: [(node, path, times, values)])."""
    j, b = load_glb(path)
    nodes = j['nodes']

    def local(n):
        m = np.eye(4)
        if 'rotation' in n:
            x, y, z, w = n['rotation']
            m[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                         [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                         [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]]
        if 'scale' in n:
            m[:3, :3] = m[:3, :3] @ np.diag(n['scale'])
        m[:3, 3] = n.get('translation', [0, 0, 0])
        return m

    world = {}

    def walk(i, pm):
        world[i] = pm @ local(nodes[i])
        for c in nodes[i].get('children', []):
            walk(c, world[i])

    for i in j['scenes'][j.get('scene', 0)]['nodes']:
        walk(i, np.eye(4))
    a = j['animations'][0]
    ch = [(c['target']['node'], c['target']['path'], read_accessor(j, b, a['samplers'][c['sampler']]['input'])[:, 0],
           read_accessor(j, b, a['samplers'][c['sampler']]['output'])) for c in a['channels']]
    return j, world, {n.get('name'): i for i, n in enumerate(nodes)}, ch


def lerp(keys, t):
    a = np.array([k[0] for k in keys])
    v = np.array([k[1] for k in keys], dtype=float)
    return np.interp(t, a, v) if v.ndim == 1 else np.array([np.interp(t, a, v[:, i]) for i in range(v.shape[1])])


def placement(place):
    """retarget.js placement as a 4x4: S(scale) T(-centre) Rz(yaw) A."""
    s, c, yaw = (place['scale'], np.array(place['centre'], float), place['yaw']) if place else (1, np.zeros(3), 0)
    m = np.eye(4)
    rz = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
    m[:3, :3] = s * rz @ G.A
    m[:3, 3] = -s * c
    return m


class Tmp(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.addCleanup(self.d.cleanup)

    def p(self, n):
        return os.path.join(self.d.name, n)


class RoundTrip(Tmp):
    def check(self, skeleton, place=None):
        g = golden()
        face = {k: v for k, v in g['bones'].items() if k in ('head', 'neck')}
        path = self.p('face.glb')
        info = G.write_glb(path, g['duration'], g['morphs'], face, skeleton, name='face')
        j, world, ix, ch = read(path)
        self.assertEqual(j['asset']['version'], '2.0')
        self.assertEqual(j['animations'][0]['name'], 'face')
        self.assertEqual(info['dropped'], [])
        rows = (skeleton or G.REFERENCE)['rows']
        by = {r[0]: r for r in rows}
        # The skeleton: each node, placed as add_clips places the file, at its engine head (the bind pose).
        P = placement(place)
        for b in ('hips', 'spine', 'mixamorig_Spine1', 'chest', 'neck', 'head'):
            self.assertIn(b, ix)
            np.testing.assert_allclose((P @ world[ix[b]])[:3, 3], by[b][2], atol=2e-6)
            np.testing.assert_allclose((P @ world[ix[b]])[:3, :3], np.eye(3), atol=2e-6)
        self.assertEqual(j['nodes'][ix['neck']]['children'], [ix['head']])
        self.assertNotIn('thigh.L', ix)
        self.assertNotIn('root', ix)
        # Morphs: the names, and every key's time and value.
        mesh = j['meshes'][0]
        self.assertEqual(mesh['extras']['targetNames'], sorted(g['morphs']))
        tgt = mesh['primitives'][0]['targets']
        self.assertEqual(len(tgt), len(g['morphs']))
        jb = load_glb(path)
        d = read_accessor(jb[0], jb[1], tgt[0]['POSITION'])
        self.assertAlmostEqual(float(np.abs(d).max()), G.STUB_DELTA, places=9)
        (node, _, tw, w), = [c for c in ch if c[1] == 'weights']
        self.assertEqual(j['nodes'][node]['name'], G.MESH_NODE)
        w = w.reshape(len(tw), -1)
        for i, k in enumerate(sorted(g['morphs'])):
            keys = g['morphs'][k]
            for t, v in keys:
                hit = np.nonzero(np.abs(tw - t) < 1e-5)[0]
                self.assertEqual(len(hit), 1, (k, t))
                self.assertAlmostEqual(float(w[hit[0], i]), v, delta=F32, msg=(k, t))
            np.testing.assert_allclose(w[:, i], lerp(keys, tw), atol=1e-5)  # at float32 times, off a key
        self.assertAlmostEqual(float(tw[0]), 0)
        self.assertAlmostEqual(float(tw[-1]), g['duration'], places=5)
        # Bones: each key's local rotation, rest taken off, is the clip's Euler value.
        for b, keys in face.items():
            (_, _, tr, q), = [c for c in ch if c[0] == ix[b] and c[1] == 'rotation']
            rq = G._rest_quat(by[b])
            for t, v in keys:
                hit = np.nonzero(np.abs(tr - t) < 1e-5)[0]
                self.assertEqual(len(hit), 1, (b, t))
                qq = q[hit[0]].astype(float)
                if rq is not None:
                    qq = G.qmul(qq, rq * [-1, -1, -1, 1])
                np.testing.assert_allclose(G.euler_zyx(qq), v, atol=2e-4, err_msg=f'{b} {t}')
        # Only keyed or rest-turned bones play.
        played = {j['nodes'][c[0]]['name'] for c in ch if c[1] == 'rotation'}
        turned = {r[0] for r in rows if G._rest_quat(r) is not None and r[0] in ix}
        self.assertEqual(played, set(face) | turned)

    def test_reference_skeleton(self):
        self.check(None)

    def test_model_skeleton_with_rest_turns_and_a_placement(self):
        rows = [list(r) for r in G.REFERENCE_ROWS]
        rows.insert(0, ['root', None, [0, 0, 0]])
        rows[1][1] = 'root'
        for r in rows:
            if r[0] == 'chest': r.append({'rot': [4.5, -3.25, 12.0]})
            if r[0] == 'neck': r.append({'rot': [-7.0, 0, 0.5]})
        rows.append(['thigh.L', 'hips', [0.09, -0.016, 0.81]])
        place = {'scale': 0.37, 'centre': [0.1, -0.2, 0.05], 'yaw': 0.21}
        self.check({'rows': rows, 'place': place}, place)

    def test_euler_quaternion_pair(self):
        rng = np.random.default_rng(1)
        for v in rng.uniform(-80, 80, (50, 3)):
            np.testing.assert_allclose(G.euler_zyx(G.quat_zyx(v)), v, atol=1e-9)

    def test_dropped_bones_are_reported(self):
        info = G.write_glb(self.p('x.glb'), 1, None, {'head': [[0, [1, 2, 3]], [1, [0, 0, 0]]], 'tail': [[0, [1, 0, 0]]]})
        self.assertEqual(info['dropped'], ['tail'])
        self.assertEqual(info['bones'], ['head'])
        with self.assertRaises(ValueError):
            G.write_glb(self.p('y.glb'), 1, None, {'tail': [[0, [1, 0, 0]]]})

    def test_keys_are_held_to_both_ends(self):
        G.write_glb(self.p('h.glb'), 2, {'jawOpen': [[0.5, 0.2], [1.0, 0.6]]}, {'head': [[0.25, [0, 5, 0]]]})
        _, _, _, ch = read(self.p('h.glb'))
        for _, path, t, v in ch:
            self.assertAlmostEqual(float(t[0]), 0)
            self.assertAlmostEqual(float(t[-1]), 2)
            if path == 'weights':
                np.testing.assert_allclose(v[:, 0], [0.2, 0.2, 0.6, 0.6], atol=F32)


class Placement(Tmp):
    ROWS = [['root', None, [0, 0, 0]], ['hips', 'root', [0.004756, -0.023766, 0.856877]],
            ['a.L', 'hips', [1e-7, -0.0, 1.5], {'rot': [1e21, 1.25e-6, -3e-8]}], ['b', 'a.L', [123456789.5, 0.1, 2e-7], {'rot': [0, 0, 90], 'x': 'é'}]]
    # node -e 'JSON.stringify(<ROWS>)' and its sha256, 2026-11-08
    JS = ('[["root",null,[0,0,0]],["hips","root",[0.004756,-0.023766,0.856877]],["a.L","hips",[1e-7,0,1.5],{"rot":[1e+21,0.00000125,-3e-8]}],'
          '["b","a.L",[123456789.5,0.1,2e-7],{"rot":[0,0,90],"x":"é"}]]')
    KEY = '8e382ac93e11fae95511182b02cd9186942b2674e87925952bc7ce1ffb05b479'

    def test_skeleton_key_is_the_apps(self):
        self.assertEqual(G.js_stringify(self.ROWS), self.JS)
        self.assertEqual(G.skeleton_key(self.ROWS), self.KEY)

    def write(self, rig):
        with open(self.p('model.json'), 'w') as f:
            json.dump({'skeleton': self.ROWS}, f)
        if rig is not None:
            with open(self.p('rig.json'), 'w') as f:
                json.dump(rig, f)
        elif os.path.exists(self.p('rig.json')):
            os.remove(self.p('rig.json'))
        return G.skeleton_of(self.p('model.json'))

    def test_rig_place_only_as_add_clips_reads_it(self):
        place = {'scale': 2.0, 'centre': [0, 1, 0], 'yaw': 0.5}
        ok = {'format': 1, 'frames': {'hips': [0, 0, 0, 1]}, 'place': place, 'skeleton': self.KEY}
        self.assertEqual(self.write(ok)['place'], place)
        self.assertIsNone(self.write(None)['place'])
        self.assertIsNone(self.write({**ok, 'skeleton': 'other'})['place'])
        self.assertIsNone(self.write({**ok, 'format': 2})['place'])
        self.assertIsNone(self.write({**ok, 'frames': {'hips': [0, 0, 0, 0]}})['place'])
        self.assertIsNone(self.write({**ok, 'place': {'scale': 0, 'centre': [0, 0, 0], 'yaw': 0}})['place'])

    def test_root_is_the_placement_inverted(self):
        for place in (None, {'scale': 0.37, 'centre': [0.1, -0.2, 0.05], 'yaw': 0.21}, {'scale': 3, 'centre': [1, 2, 3], 'yaw': -2.5}):
            t, q, s = G.root_trs(place)
            m = np.eye(4)
            x, y, z, w = q
            m[:3, :3] = s * np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                                      [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                                      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])
            m[:3, 3] = t
            np.testing.assert_allclose(placement(place) @ m, np.eye(4), atol=1e-12)


class Split(Tmp):
    def long_clip(self, secs=150):
        """A dense clip: 40 shape keys keyed 20 times a second, phrases of 4.5 s with 0.5 s pauses."""
        t = np.round(np.arange(0, secs + 1e-9, 0.05), 3)
        morphs = {f'k{i:02d}': [[float(x), round(float(0.5 + 0.4 * math.sin(x * (1 + i / 7))), 4)] for x in t] for i in range(40)}
        bones = {'head': [[float(x), [round(float(3 * math.sin(x)), 3), 0, round(float(math.cos(x)), 3)]] for x in t]}
        pauses = [[s + 4.5, s + 5] for s in range(0, secs - 5, 5)]
        return secs, morphs, bones, pauses

    def test_short_clip_is_one_file(self):
        g = golden()
        out = G.write_clips(self.p('face'), g['duration'], g['morphs'], None, name='face')
        self.assertEqual([(o['path'], o['name'], o['start'], o['duration']) for o in out], [(self.p('face.glb'), 'face', 0, g['duration'])])

    def test_long_clip_cuts_at_pauses_and_fits(self):
        secs, morphs, bones, pauses = self.long_clip()
        self.assertGreater(G.move_bytes(morphs, bones), G.MOVES_CAP_BYTES)
        out = G.write_clips(self.p('long'), secs, morphs, bones, name='face', pauses=pauses)
        self.assertGreater(len(out), 2)
        mids = {round((a + b) / 2, 3) for a, b in pauses}
        for i, o in enumerate(out):
            self.assertEqual(o['name'], f'face_{i + 1}')
            self.assertTrue(o['path'].endswith(f'long-{i + 1}.glb'))
            self.assertLessEqual(o['moveBytes'], G.FILL * G.MOVES_CAP_BYTES)
            if i:
                self.assertIn(o['start'], mids)
                self.assertAlmostEqual(o['start'], out[i - 1]['start'] + out[i - 1]['duration'], places=6)
        self.assertAlmostEqual(out[-1]['start'] + out[-1]['duration'], secs, places=6)
        # Each piece plays the clip's own values from its start.
        for o in out[1:3]:
            _, _, ix, ch = read(o['path'])
            (_, _, tw, w), = [c for c in ch if c[1] == 'weights']
            w = w.reshape(len(tw), -1)
            for tq in (0.0, 0.333, o['duration'] / 2, o['duration']):
                np.testing.assert_allclose([np.interp(tq, tw, w[:, i]) for i in range(40)],
                                           [lerp(morphs[k], o['start'] + tq) for k in sorted(morphs)], atol=1e-4)

    def test_no_pause_cuts_where_it_must(self):
        secs, morphs, bones, _ = self.long_clip(60)
        ps = G.pieces(secs, morphs, bones, pauses=[])
        self.assertGreater(len(ps), 1)
        for a, b in ps:
            self.assertLessEqual(G.move_bytes(G._cut(morphs, a, b), G._cut(bones, a, b), 'talk'), G.FILL * G.MOVES_CAP_BYTES)

    def test_slice_is_exact_for_linear_keys(self):
        k = [[0, 0.0], [1, 1.0], [3, 0.0]]
        self.assertEqual(G.slice_keys(k, 0.5, 2), [[0, 0.5], [0.5, 1.0], [1.5, 0.5]])
