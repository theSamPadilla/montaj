"""Tests for lib/talk/recipes.py."""
import unittest

from lib.talk import recipes

D = {
    "reference_reach_mm": {"browInnerUp": 6.0, "mouthSmileLeft": 10.0, "mouthSmileRight": 10.0},
    "floor": {"prefixes": ["brow", "eye", "cheek"], "min": 0.3},
    "recipes": {
        "a": {"w": {"browInnerUp": 1.0, "mouthSmileLeft": 1.0, "jawOpen": 0.4}, "in": 0.2, "out": 0.4, "speech": "drop"},
        "b": {"w": {"mouthSmileLeft": 0.8, "eyeSquintLeft": 0.5}, "in": 0.1, "out": 0.3, "side": "L"},
    },
    "moods": {"calm": {"recipe": None, "strength": 0, "motion": 1.0}, "glad": {"recipe": "a", "strength": 0.4, "motion": 1.1}},
}


class T(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(recipes.parse_name("smile"), ("smile", 1.0, False))
        self.assertEqual(recipes.parse_name("smile@0.6"), ("smile", 0.6, False))
        self.assertEqual(recipes.parse_name("smirk.R"), ("smirk", 1.0, True))
        self.assertEqual(recipes.parse_name("smirk@0.5.R"), ("smirk", 0.5, True))
        self.assertEqual(recipes.parse_name("smirk.R@0.5"), ("smirk", 0.5, True))
        self.assertEqual(recipes.parse_name("x@9")[1], 1.5)
        self.assertEqual(recipes.parse_name("x@-2")[1], 0.0)

    def test_floor(self):
        w = recipes.weights("a@0.5", D)
        self.assertAlmostEqual(w["browInnerUp"], 0.65)
        self.assertAlmostEqual(w["mouthSmileLeft"], 0.5)
        self.assertAlmostEqual(w["jawOpen"], 0.2)

    def test_zero(self):
        self.assertEqual(recipes.weights("a@0", D), {})

    def test_full_and_new_dict(self):
        w = recipes.weights("a", D)
        self.assertEqual(w, {"browInnerUp": 1.0, "mouthSmileLeft": 1.0, "jawOpen": 0.4})
        w["jawOpen"] = 9
        self.assertEqual(recipes.weights("a", D)["jawOpen"], 0.4)
        self.assertEqual(D["recipes"]["a"]["w"]["jawOpen"], 0.4)

    def test_over_strength_clips_to_one(self):
        self.assertEqual(recipes.weights("a@1.5", D)["mouthSmileLeft"], 1.0)

    def test_drops_tiny(self):
        self.assertNotIn("jawOpen", recipes.weights("a@0.002", D))

    def test_mirror(self):
        w = recipes.weights("b.R", D)
        self.assertEqual(set(w), {"mouthSmileRight", "eyeSquintRight"})
        self.assertAlmostEqual(w["mouthSmileRight"], 0.8)

    def test_head_scaling(self):
        w = recipes.weights("b@0.5", D, {"mouthSmileLeft": 20.0, "eyeSquintLeft": 3.0})
        self.assertAlmostEqual(w["mouthSmileLeft"], 0.4 * 10 / 20)  # reach twice the reference: half the weight
        self.assertAlmostEqual(w["eyeSquintLeft"], 0.5 * 0.65)  # no reference: unscaled
        w = recipes.weights("a", D, {"browInnerUp": 3.0, "mouthSmileLeft": 0})
        self.assertEqual(w["browInnerUp"], 1.0)  # capped
        self.assertEqual(w["mouthSmileLeft"], 1.0)  # zero reach: unscaled
        w = recipes.weights("a@0.5", D, {"browInnerUp": 3.0})
        self.assertEqual(w["browInnerUp"], 1.0)  # 0.65 * 2 capped
        w = recipes.weights("a@0.5", D, {"browInnerUp": 12.0})
        self.assertAlmostEqual(w["browInnerUp"], 0.325)

    def test_mirror_with_reach(self):
        w = recipes.weights("b.R", D, {"mouthSmileRight": 20.0})
        self.assertAlmostEqual(w["mouthSmileRight"], 0.4)

    def test_unknown(self):
        with self.assertRaises(KeyError) as c:
            recipes.weights("nope", D)
        self.assertIn("a", str(c.exception))
        with self.assertRaises(KeyError) as c:
            recipes.mood("nope", D)
        self.assertIn("glad", str(c.exception))
        with self.assertRaises(KeyError):
            recipes.meta("nope", D)

    def test_mood_meta(self):
        self.assertEqual(recipes.mood("calm", D), (None, 0, 1.0))
        self.assertEqual(recipes.mood("glad", D), ("a", 0.4, 1.1))
        self.assertEqual(recipes.meta("a@0.5", D), {"in": 0.2, "out": 0.4, "speech": "drop"})
        self.assertEqual(recipes.meta("b", D)["speech"], "keep")


class Real(unittest.TestCase):
    def test_real_file(self):
        d = recipes.load()
        for r in d["recipes"]:
            self.assertTrue(recipes.weights(r, d), r)
            self.assertTrue(recipes.weights(r + ".R", d), r)
            recipes.meta(r, d)
        for m in d["moods"]:
            rec, s, mo = recipes.mood(m, d)
            if rec:
                self.assertTrue(recipes.weights(f"{rec}@{s}", d), m)
            else:
                self.assertEqual(s, 0)

