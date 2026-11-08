"""Tests for lib/talk/face.py.

The golden clips in fixtures/talk/golden_*.json were made by running the spike this was ported from (non-legacy) on the fixtures'
audio, so test_equals_golden pins the port to it: every morph and bone key, time and value, and the report. The audio is CMU ARCTIC
(a0023, English) and a LibriVox reading (Portuguese); both allow redistribution. The rest checks the behaviour the spike's tests did.
"""
import copy, json, os, unittest
from unittest import mock

import numpy as np
import pytest

from lib.talk import face, prosody, recipes
from tests.test_talk_reach import make_glb

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'talk')
EN = ('arctic_a0023', 'en')
PT = ('pt_excerpt', 'pt')
NEUTRAL = [{'from': 0, 'to': 30, 'mood': 'neutral'}]
GESTURE_KEYS = ('brow', 'eyeSquint', 'cheekSquint', 'eyeWide')


def load(name):
    with open(os.path.join(FIX, name)) as f: return json.load(f)


MOODS = load('moods.json')


def run(clip=EN, moods=None, **kw):
    n, lang = clip
    if moods is None: moods = MOODS[lang]
    return face.build(os.path.join(FIX, n + '.wav'), os.path.join(FIX, n + '.words.json'), lang, moods, **kw)


def val(clip, key, tq):
    """A morph key's value at tq, from its thinned keys; 0 where the clip leaves the key out."""
    k = clip['morphs'].get(key)
    if not k: return np.zeros_like(np.asarray(tq, dtype=float))
    a = np.array(k); return np.interp(tq, a[:, 0], a[:, 1])


class Golden(unittest.TestCase):
    GOLD = load('golden_clips.json'); REPS = load('golden_reports.json')
    CASES = {'en-x0': (EN, 0), 'en-x1': (EN, 1), 'en-x2': (EN, 2), 'pt-x1': (PT, 1)}

    def test_equals_golden(self):
        for key, (clip, ex) in self.CASES.items():
            out, rep = run(clip, expressive=ex)
            g = self.GOLD[key]
            self.assertEqual(out['duration'], g['duration'], key)
            self.assertEqual(sorted(out['morphs']), sorted(g['morphs']), key)
            self.assertEqual(sorted(out['bones']), sorted(g['bones']), key)
            for k in g['morphs']: self.assertEqual(out['morphs'][k], g['morphs'][k], (key, k))
            for k in g['bones']: self.assertEqual(out['bones'][k], g['bones'][k], (key, k))
            self.assertEqual(json.dumps(out), json.dumps(g), key)
            self.assertEqual(json.loads(json.dumps(rep)), self.REPS[key], key)

    def test_mouth_blinks_and_tongue_do_not_move_with_expressive(self):
        # the mouth, tongue and blink keys come from the audio, not the gesture layer
        keep = lambda m: {k: v for k, v in m.items() if k.startswith(('viseme_', 'mouthPucker', 'mouthFunnel', 'jawOpen'))}
        a, b = self.GOLD['en-x0']['morphs'], self.GOLD['en-x2']['morphs']
        self.assertGreater(len([k for k in a if k.startswith('viseme_')]), 10)
        self.assertEqual(keep(a), keep(b))
        self.assertEqual(self.REPS['en-x0']['blinks'], self.REPS['en-x2']['blinks'])


@pytest.mark.slow  # about 30 s: a dozen builds
class Face(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = run()

    def test_same_bytes_twice(self):
        again = run()
        self.assertEqual(json.dumps(again[0]), json.dumps(self.base[0]))
        self.assertEqual(json.dumps(again[1]), json.dumps(self.base[1]))

    def test_expressive_zero(self):
        # neutral: nothing writes a brow, lid or cheek key, so none may appear
        clip, rep = run(moods=NEUTRAL, expressive=0)
        self.assertEqual([k for k in clip['morphs'] if k.startswith(GESTURE_KEYS)], [])
        self.assertEqual(rep['gestures'], [])
        self.assertTrue(any(k.startswith(GESTURE_KEYS) for k in run(moods=NEUTRAL)[0]['morphs']))
        # with the clip's own moods, those keys hold no more than the moods' recipes write
        R = recipes.load(); top = {}
        for m in MOODS['en']:
            if 'mood' not in m: continue
            rec, s, _ = recipes.mood(m['mood'], R)
            for k, v in (recipes.weights('%s@%r' % (rec, s), R, R['reference_reach_mm']) if rec else {}).items(): top[k] = max(top.get(k, 0), v)
        # the wince beat adds its own keys on top of the mood's
        for k, v in recipes.weights('wince@0.8', R, R['reference_reach_mm']).items(): top[k] = top.get(k, 0) + v
        clip, _ = run(expressive=0)
        for k, keys in clip['morphs'].items():
            if not k.startswith(GESTURE_KEYS): continue
            self.assertIn(k, top, k)
            self.assertLessEqual(max(v for _, v in keys), top[k] + .005, k)

    def test_expressive_zero_turns_gesture_layer_off(self):
        # EX=0 with the real prosody and with none at all (no peaks, flat liveliness) must agree on brows, lids, cheeks and the head
        a, _ = run(expressive=0)
        real = prosody.analyse
        def bare(x):
            P = real(x); P['prominent'] = []; P['liveliness'] = [1.] * len(P['phrases'])
            return P
        with mock.patch.object(face.prosody, 'analyse', bare): b, _ = run(expressive=0)
        keys = lambda c: {k for k in c['morphs'] if k.startswith(('brow', 'eyeSquint', 'cheekSquint', 'eyeWide'))}
        self.assertEqual(keys(a), keys(b))
        for k in keys(a): self.assertEqual(a['morphs'][k], b['morphs'][k], k)
        for bn in ('head', 'neck'): self.assertEqual(a['bones'][bn], b['bones'][bn], bn)

    def test_lips_shut_on_bilabials_under_a_grin(self):
        at, hold = .3, 4.4
        clip, rep = run(moods=NEUTRAL + [{'at': at, 'beat': 'grin', 'hold': hold}])
        cs = [(g['s'] + g['e']) / 2 for g in rep['segs'] if g['p'] in ('m', 'b', 'p') and at + .3 <= (g['s'] + g['e']) / 2 <= at + hold - .3]
        self.assertTrue(cs, 'no bilabial in the window')
        for k in ('mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthLowerDownLeft', 'mouthLowerDownRight'):
            for c in cs: self.assertLess(float(val(clip, k, c - face.LEAD)), .03, (k, c))

    def test_missing_keys_reported(self):
        self.assertEqual(self.base[1]['missingKeys'], [])

    def test_head_reach_scales_weights(self):
        # A head whose browInnerUp moves twice as far needs half the weight for the same millimetres.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for mm in (.02, .04):  # metres per vertex: 20 mm and 40 mm of reach
                p = os.path.join(d, 'h%d.glb' % round(mm * 1000)); paths.append(p)
                make_glb(p, [{'jaw': [[0, .01, 0]] * 4, 'brow': ([0, 1, 2, 3], [[mm, 0, 0]] * 4)}])
            a, rep = run(moods=NEUTRAL, head=paths[0]); b, _ = run(moods=NEUTRAL, head=paths[1])
        self.assertEqual(rep['head'], paths[0])
        self.assertIn('browOuterUpLeft', rep['missingKeys'])  # the synthetic head has two keys only
        g = np.arange(0, a['duration'], .01)
        x, y = val(a, 'browInnerUp', g), val(b, 'browInnerUp', g)
        self.assertGreater(x.max(), .05)
        self.assertAlmostEqual(y.max(), x.max() / 2, delta=.03 * x.max())
        self.assertAlmostEqual(y.sum(), x.sum() / 2, delta=.05 * x.sum())

    def test_head_model_json_matches_glb(self):
        # The app's own model.json, imported from that GLB: the same weights within the int16 quantisation of its shape keys.
        fx = os.path.join(os.path.dirname(__file__), 'fixtures', 'talk')
        glb, mj = os.path.join(fx, 'tiny-head.glb'), os.path.join(fx, 'tiny-head', 'model.json')
        a, ra = run(moods=NEUTRAL, head=glb); b, rb = run(moods=NEUTRAL, head=mj)
        self.assertEqual(rb['head'], mj)
        self.assertEqual(ra['missingKeys'], rb['missingKeys'])
        g = np.arange(0, a['duration'], .01)
        x, y = val(a, 'browInnerUp', g), val(b, 'browInnerUp', g)
        self.assertGreater(x.max(), .05)
        self.assertLess(np.abs(x - y).max(), 1e-3)

    def test_beat_envelope(self):
        R = recipes.load(); m = recipes.meta('disgust', R); w = recipes.weights('disgust', R)['noseSneerLeft']
        at, hold = 3.0, .5
        clip, rep = run(moods=NEUTRAL + [{'at': at, 'beat': 'disgust', 'hold': hold}])
        self.assertEqual(rep['beats'][0]['beat'], 'disgust')
        v = lambda tq: float(val(clip, 'noseSneerLeft', tq))
        self.assertLess(v(at - m['in'] - .03), .01)
        self.assertAlmostEqual(v(at - m['in'] / 2), w / 2, delta=.02)
        for tq in (at, at + hold / 2, at + hold): self.assertAlmostEqual(v(tq), w, delta=.01)
        self.assertLess(v(at + hold + m['out'] + .03), .01)
        self.assertLess(v(at + hold + m['out'] / 2), w)

    def test_drop_yields_more_than_keep(self):
        R = recipes.load(); self.assertEqual(recipes.meta('laugh', R)['speech'], 'drop')
        K = copy.deepcopy(R); K['recipes']['laugh']['speech'] = 'keep'
        beat = NEUTRAL + [{'at': 1.0, 'beat': 'laugh', 'hold': 2.5}]  # inside the speech
        drop, _ = run(moods=beat); keep, _ = run(moods=beat, recipe_data=K)
        g = np.arange(1.0, 3.5, .01)
        for k in ('mouthUpperUpLeft', 'mouthSmileLeft'):
            a, b = val(drop, k, g), val(keep, k, g)
            self.assertTrue((a <= b + .005).all(), k)
            self.assertLess(a.mean(), b.mean(), k)
            self.assertGreater((b - a).max(), .1, k)

    def test_unknown_mood_raises(self):
        with self.assertRaises(KeyError) as e: run(moods=[{'from': 0, 'to': 5, 'mood': 'grumpy'}])
        self.assertIn('warm', str(e.exception))
        with self.assertRaises(KeyError): run(moods=NEUTRAL + [{'at': 1, 'beat': 'frown'}])

    def test_brow_pair_never_both_up(self):
        _, r0 = run(moods=NEUTRAL)
        c = next(x['t'] for x in r0['gestures'] if x['kind'] == 'flash')
        clip, rep = run(moods=NEUTRAL + [{'at': c - .05, 'beat': 'anger', 'hold': .6}])  # over the first flash
        self.assertIn('flash', [x['kind'] for x in rep['gestures'] if c - .3 < x['t'] < c + .3])
        # at the clip's own 48 Hz key grid: between two keys a straight line can cross the step the rule makes where the larger brow takes over
        g = np.arange(0, clip['duration'], 1 / face.KEY_RATE); bi = val(clip, 'browInnerUp', g)
        for k in ('browDownLeft', 'browDownRight'):
            bd = val(clip, k, g)
            self.assertGreater(bd.max(), .5)
            self.assertFalse(((bi > .16) & (bd > .16)).any(), k)

    def test_low_loud_peak_draws_brows_down(self):
        real = prosody.analyse
        def low(x):
            P = real(x)
            for p in P['peaks']: p['pitch'], p['loud'] = -3., 1.
            return P
        with mock.patch.object(face.prosody, 'analyse', low): clip, rep = run(moods=NEUTRAL)
        kinds = [x['kind'] for x in rep['gestures']]
        self.assertIn('down', kinds); self.assertNotIn('flash', kinds)
        self.assertGreater(max(v for _, v in clip['morphs']['browDownLeft']), .3)
        self.assertNotIn('browInnerUp', clip['morphs'])  # no flash and no held lift on this voice


class Dictionary(unittest.TestCase):
    def test_bundled_dictionary_loads(self):
        from lib.talk.align import CMUDICT, load_cmudict
        self.assertTrue(CMUDICT.endswith('cmudict.dict.gz') and os.path.exists(CMUDICT))
        d = load_cmudict()
        self.assertGreater(len(d), 100000)
        self.assertEqual(d['combination'], ['k', 'aa', 'm', 'b', 'ah', 'n', 'ey', 'sh', 'ah', 'n'])
        self.assertEqual(d, load_cmudict(CMUDICT))

    def test_plain_file_path_still_works(self):
        import gzip, tempfile
        from lib.talk.align import CMUDICT, load_cmudict
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, 'd.dict')
            with open(p, 'wb') as f: f.write(gzip.open(CMUDICT).read())
            self.assertEqual(load_cmudict(p), load_cmudict())
