"""Unit tests for serve.caption_job (extract_segments + build_cut_spec)."""
import pytest

from serve.caption_job import extract_segments, build_cut_spec


def _clip(src, start, end, in_pt, out_pt, ctype="video"):
    return {
        "type": ctype,
        "src": src,
        "start": start,
        "end": end,
        "inPoint": in_pt,
        "outPoint": out_pt,
    }


def _cached_clip(src, normalized_src, start, end, in_pt, out_pt, normalized_in_pt=None):
    """Like _clip but with normalizedSrc (and optionally normalizedInPoint)."""
    c = _clip(src, start, end, in_pt, out_pt)
    c["normalizedSrc"] = normalized_src
    if normalized_in_pt is not None:
        c["normalizedInPoint"] = normalized_in_pt
    return c


# ── extract_segments ─────────────────────────────────────────────────────────

def test_two_clip_single_source():
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 0.0, 3.424, 0.0, 3.424),
                _clip("IMG.mov", 3.424, 8.897, 5.84, 11.313),
            ]
        ]
    }
    assert extract_segments(project) == [
        {"src": "IMG.mov", "in": 0.0, "out": 3.424},
        {"src": "IMG.mov", "in": 5.84, "out": 11.313},
    ]


def test_orders_by_start():
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 3.424, 8.897, 5.84, 11.313),
                _clip("IMG.mov", 0.0, 3.424, 0.0, 3.424),
            ]
        ]
    }
    assert [s["in"] for s in extract_segments(project)] == [0.0, 5.84]


def test_multi_source_preserves_per_clip_src_and_order():
    project = {
        "tracks": [
            [
                _clip("B.mov", 3.0, 6.0, 0.5, 3.0),
                _clip("A.mov", 0.0, 3.0, 0.0, 3.0),
                _clip("C.mov", 6.0, 9.0, 1.0, 4.0),
            ]
        ]
    }
    # ordered by start: A, B, C — each keeps its own src + window
    assert extract_segments(project) == [
        {"src": "A.mov", "in": 0.0, "out": 3.0},
        {"src": "B.mov", "in": 0.5, "out": 3.0},
        {"src": "C.mov", "in": 1.0, "out": 4.0},
    ]


def test_skips_zero_length_clips():
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 0.0, 3.0, 0.0, 3.0),
                _clip("IMG.mov", 3.0, 3.0, 5.0, 5.0),  # zero-length keep
                _clip("IMG.mov", 3.0, 6.0, 8.0, 11.0),
            ]
        ]
    }
    assert [[s["in"], s["out"]] for s in extract_segments(project)] == [[0.0, 3.0], [8.0, 11.0]]


def test_ignores_non_video_clips():
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 0.0, 3.0, 0.0, 3.0),
                _clip("song.mp3", 0.0, 3.0, 0.0, 3.0, ctype="audio"),
            ]
        ]
    }
    assert extract_segments(project) == [{"src": "IMG.mov", "in": 0.0, "out": 3.0}]


def test_no_clips_raises():
    with pytest.raises(ValueError) as exc:
        extract_segments({"tracks": [[]]})
    assert str(exc.value).startswith("no_clips")


def test_no_clips_raises_empty_project():
    with pytest.raises(ValueError) as exc:
        extract_segments({})
    assert str(exc.value).startswith("no_clips")


def test_all_zero_length_raises_empty_keeps():
    project = {"tracks": [[_clip("IMG.mov", 0.0, 0.0, 5.0, 5.0)]]}
    with pytest.raises(ValueError) as exc:
        extract_segments(project)
    assert str(exc.value).startswith("empty_keeps")


# ── build_cut_spec ───────────────────────────────────────────────────────────

def test_build_cut_spec_single_source_is_legacy_shape():
    """Single source → the unchanged {"input","keeps"} trim-spec shape."""
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 0.0, 3.424, 0.0, 3.424),
                _clip("IMG.mov", 3.424, 8.897, 5.84, 11.313),
            ]
        ]
    }
    assert build_cut_spec(project) == {
        "input": "IMG.mov",
        "keeps": [[0.0, 3.424], [5.84, 11.313]],
    }


def test_build_cut_spec_multi_source_is_segments_shape():
    """>1 distinct src → the {"segments":[...]} multi-source shape."""
    project = {
        "tracks": [
            [
                _clip("A.mov", 0.0, 3.0, 0.0, 3.0),
                _clip("B.mov", 3.0, 6.0, 0.0, 3.0),
            ]
        ]
    }
    assert build_cut_spec(project) == {
        "segments": [
            {"src": "A.mov", "in": 0.0, "out": 3.0},
            {"src": "B.mov", "in": 0.0, "out": 3.0},
        ]
    }


def test_build_cut_spec_propagates_no_clips():
    with pytest.raises(ValueError) as exc:
        build_cut_spec({"tracks": [[]]})
    assert str(exc.value).startswith("no_clips")


# ── normalizedSrc / cache-rebase tests ────────────────────────────────────────

def test_all_clips_cached_uses_normalized_src_rebased():
    """All clips have normalizedSrc + normalizedInPoint == inPoint → segments
    use _norm.mp4 paths and in/out are rebased to (0, window_length)."""
    # clip 1: inPoint=2.0, outPoint=5.0, normalizedInPoint=2.0
    # → rebased in=0.0, out=3.0
    # clip 2: inPoint=10.0, outPoint=14.0, normalizedInPoint=10.0
    # → rebased in=0.0, out=4.0
    project = {
        "tracks": [
            [
                _cached_clip("A.MOV", "A_norm.mp4", 0.0, 3.0, 2.0, 5.0, normalized_in_pt=2.0),
                _cached_clip("B.MOV", "B_norm.mp4", 3.0, 7.0, 10.0, 14.0, normalized_in_pt=10.0),
            ]
        ]
    }
    segs = extract_segments(project)
    assert [s["src"] for s in segs] == ["A_norm.mp4", "B_norm.mp4"]
    assert abs(segs[0]["in"] - 0.0) < 1e-4
    assert abs(segs[0]["out"] - 3.0) < 1e-4
    assert abs(segs[1]["in"] - 0.0) < 1e-4
    assert abs(segs[1]["out"] - 4.0) < 1e-4


def test_cache_rebase_when_normalizedInPoint_differs_from_inPoint():
    """normalizedInPoint != inPoint → in/out rebased by normalizedInPoint origin."""
    # clip: inPoint=5.0, outPoint=9.0, normalizedInPoint=4.0
    # → origin=4.0, in=5.0-4.0=1.0, out=9.0-4.0=5.0
    project = {
        "tracks": [
            [
                _cached_clip("A.MOV", "A_norm.mp4", 0.0, 4.0, 5.0, 9.0, normalized_in_pt=4.0),
                _cached_clip("B.MOV", "B_norm.mp4", 4.0, 8.0, 1.0, 4.0, normalized_in_pt=1.0),
            ]
        ]
    }
    segs = extract_segments(project)
    # clip A (ordered first by start=0.0)
    assert segs[0]["src"] == "A_norm.mp4"
    assert abs(segs[0]["in"] - 1.0) < 1e-4
    assert abs(segs[0]["out"] - 5.0) < 1e-4
    # clip B (start=4.0): inPoint=1.0, outPoint=4.0, normalizedInPoint=1.0
    # → in=0.0, out=3.0
    assert segs[1]["src"] == "B_norm.mp4"
    assert abs(segs[1]["in"] - 0.0) < 1e-4
    assert abs(segs[1]["out"] - 3.0) < 1e-4


def test_partial_cache_falls_back_to_src():
    """Only one of two clips has normalizedSrc → ALL clips fall back to src
    with original (non-rebased) in/out."""
    project = {
        "tracks": [
            [
                _cached_clip("A.MOV", "A_norm.mp4", 0.0, 3.0, 2.0, 5.0, normalized_in_pt=2.0),
                _clip("B.MOV", 3.0, 7.0, 10.0, 14.0),  # no normalizedSrc
            ]
        ]
    }
    segs = extract_segments(project)
    assert [s["src"] for s in segs] == ["A.MOV", "B.MOV"]
    assert abs(segs[0]["in"] - 2.0) < 1e-4
    assert abs(segs[0]["out"] - 5.0) < 1e-4
    assert abs(segs[1]["in"] - 10.0) < 1e-4
    assert abs(segs[1]["out"] - 14.0) < 1e-4


def test_build_cut_spec_multi_source_includes_scale():
    """Multi-source project with settings.resolution=[2160,3840] → spec has
    segments AND scale == [360, 640]."""
    project = {
        "settings": {"resolution": [2160, 3840]},
        "tracks": [
            [
                _clip("A.mov", 0.0, 3.0, 0.0, 3.0),
                _clip("B.mov", 3.0, 6.0, 0.0, 3.0),
            ]
        ],
    }
    spec = build_cut_spec(project)
    assert "segments" in spec
    assert spec["scale"] == [360, 640]


def test_build_cut_spec_omits_scale_without_resolution():
    """Multi-source project with no settings → spec has segments and NO scale key."""
    project = {
        "tracks": [
            [
                _clip("A.mov", 0.0, 3.0, 0.0, 3.0),
                _clip("B.mov", 3.0, 6.0, 0.0, 3.0),
            ]
        ]
    }
    spec = build_cut_spec(project)
    assert "segments" in spec
    assert "scale" not in spec


def test_build_cut_spec_single_normalized_source_collapses_to_keeps():
    """All clips share ONE normalizedSrc → build_cut_spec returns the legacy
    {"input","keeps"} shape with rebased keeps, no "scale" key."""
    # Both clips normalizedSrc point to the same cache file.
    # clip 1: inPoint=1.0, outPoint=4.0, normalizedInPoint=1.0 → keep [0.0, 3.0]
    # clip 2: inPoint=6.0, outPoint=9.0, normalizedInPoint=6.0 → keep [0.0, 3.0]
    project = {
        "tracks": [
            [
                _cached_clip("A.MOV", "shared_norm.mp4", 0.0, 3.0, 1.0, 4.0, normalized_in_pt=1.0),
                _cached_clip("B.MOV", "shared_norm.mp4", 3.0, 6.0, 6.0, 9.0, normalized_in_pt=6.0),
            ]
        ]
    }
    spec = build_cut_spec(project)
    assert spec["input"] == "shared_norm.mp4"
    assert "segments" not in spec
    assert "scale" not in spec
    keeps = spec["keeps"]
    assert len(keeps) == 2
    assert abs(keeps[0][0] - 0.0) < 1e-4
    assert abs(keeps[0][1] - 3.0) < 1e-4
    assert abs(keeps[1][0] - 0.0) < 1e-4
    assert abs(keeps[1][1] - 3.0) < 1e-4
