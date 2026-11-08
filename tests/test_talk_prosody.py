"""Tests for lib/talk/prosody.py: synthetic tone bursts, then real English (CMU ARCTIC) and Portuguese (LibriVox) speech."""
import json, os, unittest
import numpy as np

from lib.talk import prosody
from lib.talk.align import read_wav, SR

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'talk')
EN = os.path.join(FIX, 'arctic_a0023.wav')
PT = os.path.join(FIX, 'pt_excerpt.wav')


def burst(f0, f1, dur, amp):
    n = int(dur * SR); t = np.arange(n) / SR
    ph = 2 * np.pi * np.cumsum(np.linspace(f0, f1, n)) / SR
    y = sum(np.sin(k * ph) / k for k in range(1, 7))
    r = int(.03 * SR); env = np.ones(n)
    env[:r] = .5 - .5 * np.cos(np.pi * np.arange(r) / r); env[-r:] = env[:r][::-1]
    return amp * .4 * y * env


def make(glide=(150, 150)):
    """Bursts 120 ms every 200 ms; a .4 s silence after the fourth; burst 2 louder and higher; a final glide of 400 ms."""
    rng = np.random.default_rng(1); parts = []; centres = []; t = 0.
    def add(sig, gap):
        nonlocal t
        centres.append(t + len(sig) / SR / 2); parts.append(sig); parts.append(np.zeros(int(gap * SR))); t += len(sig) / SR + gap
    parts.append(np.zeros(int(.2 * SR))); t = .2
    for k, (f, a, gap) in enumerate([(150, .3, .08), (200, .9, .08), (150, .3, .08), (150, .3, .4), (150, .3, .08), (150, .3, .08)]):
        add(burst(f, f, .12, a), gap)
    add(burst(glide[0], glide[1], .4, .3), .3)
    x = np.concatenate(parts); x += rng.normal(0, 1e-4, len(x))
    return x, centres


class Synthetic(unittest.TestCase):
    def test_peaks_and_scores(self):
        x, c = make(); R = prosody.analyse(x)
        P = R['peaks']; self.assertGreaterEqual(len(P), len(c))
        for t in c[:-1]:
            self.assertLess(min(abs(p['t'] - t) for p in P), .02)
        self.assertTrue(any(c[-1] - .2 <= p['t'] <= c[-1] + .2 for p in P))
        for p in P: self.assertTrue(any(abs(p['t'] - t) < .02 for t in c[:-1]) or p['t'] > c[-1] - .2)
        best = max(P, key=lambda p: p['score'])
        self.assertLess(abs(best['t'] - c[1]), .02)

    def test_silence_splits_phrases(self):
        x, c = make(); R = prosody.analyse(x)
        self.assertEqual(len(R['phrases']), 2)
        a, b = R['phrases'][0][1], R['phrases'][1][0]
        self.assertGreaterEqual(b - a, .35)
        self.assertTrue(c[3] < b)

    def test_glides(self):
        up = prosody.analyse(make((150, 260))[0])['contour'][-1]
        dn = prosody.analyse(make((260, 150))[0])['contour'][-1]
        lv = prosody.analyse(make((150, 150))[0])['contour'][-1]
        self.assertEqual(up['kind'], 'rise'); self.assertGreater(up['slope'], 4)
        self.assertEqual(dn['kind'], 'fall'); self.assertLess(dn['slope'], -4)
        self.assertEqual(lv['kind'], 'level')

    def test_deterministic(self):
        x, _ = make((150, 260))
        self.assertEqual(json.dumps(prosody.analyse(x)), json.dumps(prosody.analyse(x)))

    def test_liveliness_range(self):
        R = prosody.analyse(make()[0])
        self.assertEqual(len(R['liveliness']), len(R['phrases']))
        self.assertTrue(all(.6 <= u <= 1.4 for u in R['liveliness']))


class Real(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.x = read_wav(EN); cls.en = prosody.analyse(cls.x); cls.pt = prosody.analyse(read_wav(PT))

    def rate(self, R):
        d = sum(b - a for a, b in R['phrases']); return len(R['peaks']) / d

    def test_english_rate(self): self.assertTrue(2.5 <= self.rate(self.en) <= 8, self.rate(self.en))
    def test_portuguese_rate(self): self.assertTrue(2.5 <= self.rate(self.pt) <= 8, self.rate(self.pt))

    def test_pitch_equals_f0_track(self):
        from lib.talk import face
        from lib.talk.align import features
        n = len(features(self.x)['e'])
        self.assertTrue(np.array_equal(prosody.pitch(self.x, n), face.f0_track(self.x, n)))

    def test_outputs_sane(self):
        for R in (self.en, self.pt):
            self.assertEqual(len(R['contour']), len(R['phrases']))
            self.assertTrue(all(0 < q['p'] <= 2 for q in R['prominent']))
            ts = [q['t'] for q in R['prominent']]
            self.assertTrue(all(b - a >= .55 for a, b in zip(ts, ts[1:])))

