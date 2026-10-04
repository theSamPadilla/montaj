"""Keyframe sampler port (lib/keyframe_curves.py) and re-basing.

The parity test runs the REAL montaj_assets/timeline-core/src/curves.js under node.
"""
import json
import os
import random
import shutil
import subprocess

from lib.keyframe_curves import EASING_NAMES, rebase, sample_track

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CURVES_JS = os.path.join(ROOT, "montaj_assets", "timeline-core", "src", "curves.js")
TOL = 1e-9

ALL_EASINGS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "hold"]

TRACKS = [
    # every easing, one per segment; the last point's easing is never read
    {"prop": "scale", "points": [
        {"t": 0.0, "value": 1.0, "easing": "linear"},
        {"t": 0.5, "value": 2.0, "easing": "ease"},
        {"t": 1.2, "value": 0.5, "easing": "ease-in"},
        {"t": 2.0, "value": 3.0, "easing": "ease-out"},
        {"t": 2.7, "value": -1.0, "easing": "ease-in-out"},
        {"t": 3.5, "value": 4.0, "easing": "hold"},
        {"t": 4.0, "value": 0.0, "easing": "ease"},
    ]},
    # starts after 0, absent and unrecognized easing, single-segment tail
    {"prop": "opacity", "points": [
        {"t": 0.4, "value": 0.0},
        {"t": 1.0, "value": 1.0, "easing": "bogus"},
        {"t": 1.9, "value": 0.25, "easing": "ease-out"},
        {"t": 3.1, "value": 0.9},
    ]},
    # unusable points (null t / value), duplicate t, hold
    {"prop": "offsetX", "points": [
        {"t": None, "value": 5.0},
        {"t": 0.3, "value": 10.0, "easing": "hold"},
        {"t": 0.3, "value": 20.0, "easing": "ease"},
        {"t": 1.5, "value": None},
        {"t": 1.5, "value": 50.0, "easing": "ease-in-out"},
        {"t": 2.5, "value": -30.0, "easing": "hold"},
        {"t": 3.3, "value": 7.0},
    ]},
]
TIMES = [-1.0, 0.0, 0.1, 0.3, 0.4, 0.5, 0.9, 1.0, 1.5, 2.0, 2.6, 3.3, 3.5, 4.0, 9.0]


def test_all_easings_covered_by_parity_tracks():
    used = {p.get("easing") for tr in TRACKS for p in tr["points"]}
    assert set(ALL_EASINGS) <= used
    assert list(EASING_NAMES) == ALL_EASINGS


def test_parity_with_real_js():
    node = shutil.which("node")
    assert node, "node is required for the JS parity test"
    script = (
        "import(process.argv[1]).then(m => {"
        " const {tracks, times} = JSON.parse(process.argv[2]);"
        " console.log(JSON.stringify(tracks.map(tr => times.map(t => {"
        "  const v = m.sampleTrack(tr, t); return v === undefined ? null : v; }))));"
        "})"
    )
    out = subprocess.run(
        [node, "--input-type=module", "-e", script, "file://" + CURVES_JS,
         json.dumps({"tracks": TRACKS, "times": TIMES})],
        capture_output=True, text=True, check=True).stdout
    expected = json.loads(out)
    assert len(expected) == 3 and all(len(r) == len(TIMES) for r in expected)
    for tr, row in zip(TRACKS, expected):
        for t, want in zip(TIMES, row):
            got = sample_track(tr, t)
            assert want is not None
            assert abs(got - want) <= TOL, (tr["prop"], t, got, want)


def test_sentinel_and_edges():
    assert sample_track(None, 1.0) is None
    assert sample_track({"prop": "x", "points": []}, 1.0) is None
    assert sample_track({"prop": "x", "points": [{"t": None, "value": 1}]}, 1.0) is None
    pts = [{"t": 1.0, "value": 5.0}]
    assert sample_track(pts, -3) == 5.0 and sample_track(pts, 99) == 5.0
    assert sample_track(pts, float("nan")) == 5.0


def _rand_track(rng, easings, lo=0.0, hi=5.0):
    n = rng.randint(2, 7)
    ts = sorted(rng.sample([round(lo + i * 0.05, 2) for i in range(int((hi - lo) / 0.05))], n))
    return {"prop": "scale", "points": [
        {"t": t, "value": rng.uniform(-5, 5), "easing": rng.choice(easings)} for t in ts]}


def test_rebase_exact_for_linear_and_hold_tracks():
    rng = random.Random(7)
    for _ in range(300):
        tr = _rand_track(rng, ["linear", "hold"])
        o = rng.uniform(-0.5, 5.0)
        d = rng.uniform(0.05, 4.0)
        (rb,) = rebase([tr], o, d)
        for k in range(26):
            t = d * k / 25
            assert abs(sample_track(rb, t) - sample_track(tr, t + o)) <= TOL, (tr, o, d, t)


def test_rebase_exact_when_cut_lands_on_points_any_easing():
    """Times are multiples of 1/16 so every shift and grid step is exact in float64:
    a `hold` jump is discontinuous, and 1 ulp of rounding would move it across a sample."""
    rng = random.Random(11)
    for _ in range(300):
        n = rng.randint(2, 7)
        ts = sorted(rng.sample(range(0, 80), n))
        tr = {"prop": "scale", "points": [
            {"t": t / 16, "value": rng.uniform(-5, 5), "easing": rng.choice(ALL_EASINGS)}
            for t in ts]}
        pts = tr["points"]
        i, j = sorted(rng.sample(range(len(pts)), 2))
        o, end = pts[i]["t"], pts[j]["t"]
        d = end - o
        (rb,) = rebase([tr], o, d)
        for k in range(17):
            t = d * k / 16
            assert abs(sample_track(rb, t) - sample_track(tr, t + o)) <= TOL, (tr, o, d, t)


def test_rebase_eased_split_is_exact_at_ends_and_linear_between():
    """An eased segment cannot be split exactly: a sub-span of a cubic-bezier preset is
    not itself a named easing. So only the two end values are promised (exact); between
    them the cut piece is linear. Nothing here claims it matches the original curve."""
    for easing in ["ease", "ease-in", "ease-out", "ease-in-out"]:
        tr = {"prop": "scale", "points": [
            {"t": 0.0, "value": 0.0, "easing": easing}, {"t": 4.0, "value": 8.0}]}
        o, d = 1.0, 2.0
        (rb,) = rebase([tr], o, d)
        assert abs(sample_track(rb, 0.0) - sample_track(tr, o)) <= TOL
        assert abs(sample_track(rb, d) - sample_track(tr, o + d)) <= TOL
        a, b = sample_track(rb, 0.0), sample_track(rb, d)
        for k in range(1, 20):
            t = d * k / 20
            assert abs(sample_track(rb, t) - (a + (b - a) * t / d)) <= TOL
        assert rb["points"][0].get("easing", "linear") == "linear"


def test_rebase_keeps_points_strictly_inside_and_their_easing():
    tr = {"prop": "scale", "points": [
        {"t": 0.0, "value": 0.0, "easing": "ease"},
        {"t": 2.0, "value": 4.0, "easing": "ease-in"},
        {"t": 3.0, "value": 1.0, "easing": "hold"},
        {"t": 6.0, "value": 9.0}]}
    (rb,) = rebase([tr], 1.0, 3.0)
    assert [(p["t"], p.get("easing")) for p in rb["points"][1:-1]] == [
        (1.0, "ease-in"), (2.0, "hold")]
    assert rb["points"][0]["t"] == 0.0 and rb["points"][-1]["t"] == 3.0
    assert tr["points"][1]["t"] == 2.0  # input not mutated


def test_rebase_track_with_no_points_in_window_gets_two_boundary_points():
    tr = {"prop": "opacity", "points": [{"t": 0.0, "value": 0.0}, {"t": 10.0, "value": 1.0}]}
    (rb,) = rebase([tr], 2.0, 1.0)
    assert [p["t"] for p in rb["points"]] == [0.0, 1.0]
    assert abs(rb["points"][0]["value"] - 0.2) <= TOL and abs(rb["points"][1]["value"] - 0.3) <= TOL
    assert rb["prop"] == "opacity"


def test_rebase_normalisation():
    rng = random.Random(3)
    for _ in range(200):
        tr = _rand_track(rng, ALL_EASINGS)
        o, d = rng.uniform(-1, 5), rng.uniform(0.05, 3)
        junk = {"prop": "x", "points": [{"t": None, "value": 1.0}]}
        out = rebase([tr, junk], o, d)
        assert len(out) == 1  # unusable track dropped, never empty
        ts = [p["t"] for p in out[0]["points"]]
        assert ts == sorted(ts) and len(set(ts)) == len(ts)
        assert all(0.0 <= t <= d for t in ts) and ts[0] == 0.0 and ts[-1] == d
