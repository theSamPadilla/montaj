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
