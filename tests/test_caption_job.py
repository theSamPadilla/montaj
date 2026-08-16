"""Unit tests for serve.caption_job (extract_segments + build_cut_spec)."""
import json
from pathlib import Path

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


# ── T10: shared timeline corpus parity (SP2 "Shared Timeline Resolver") ───────
#
# The corpus lives in montaj_assets/timeline-core/{fixtures,expected}/ and is
# shared across all FOUR runtimes (editor preview, render, sample-frame.js, and
# this Python caption route) -- see that package's fixtures/README.md, which
# names this exact test as the reader of its sourceWindow/seekTime golden shape.
# These tests read the committed fixture/golden JSON straight off disk (never
# copied into this file) so a change to the corpus or the TS resolver's math is
# caught here too. caption_job.py itself is NOT modified by this task -- these
# tests pin its CURRENT behavior, documented divergences included.
#
# Comparand choice: extract_segments always feeds a materialize/encode pipeline
# (captions transcribe the composed mp4, never an interactive scrubber), so
# 'render' is the natural golden variant to compare against. For every fixture
# in the two COINCIDE lists below preview and render are asserted to be
# IDENTICAL anyway, so the choice is moot there -- it only matters for
# nobg-matrix.json, where the two variants genuinely disagree (see the
# divergence tests further down).

_REPO_ROOT = Path(__file__).resolve().parents[1]
_CORPUS_DIR = _REPO_ROOT / "montaj_assets" / "timeline-core"
_FIXTURES_DIR = _CORPUS_DIR / "fixtures"
_EXPECTED_DIR = _CORPUS_DIR / "expected"


def _load_fixture(name):
    return json.loads((_FIXTURES_DIR / f"{name}.json").read_text())


def _load_golden(name):
    return json.loads((_EXPECTED_DIR / f"{name}.json").read_text())


def _video_clips_by_start(project):
    """Mirror extract_segments' own ordering so golden lookups by itemId line
    up 1:1 with the segments extract_segments returns."""
    track0 = project["tracks"][0]
    return sorted((c for c in track0 if c.get("type") == "video"), key=lambda c: c.get("start", 0.0))


def _assert_variants_agree(gw, clip, name):
    """Both golden variants must describe the same source window.

    SP3 exception: a clip carrying ``proxySrc`` resolves preview to the 720p
    editing proxy while render keeps the master — a sanctioned, preview-only
    divergence (the proxy is never allowed to reach ffmpeg). Caption jobs are
    render-side and deliberately never learn about proxies (a 96k Opus proxy
    would degrade transcription input), so ``src`` may differ there. Every
    OTHER window field must still agree exactly: a proxy is full-source, so it
    must not shift in/outPoint or flip usedNormalizedCache.
    """
    if clip.get("proxySrc"):
        preview = {k: v for k, v in gw["preview"].items() if k != "src"}
        render = {k: v for k, v in gw["render"].items() if k != "src"}
        assert preview == render, (name, clip["id"])
    else:
        assert gw["preview"] == gw["render"], (name, clip["id"])


# Fixtures where EVERY tracks[0] video clip carries a normalizedSrc: Python's
# ALL-OR-NOTHING cache switch (extract_segments, serve/caption_job.py:47)
# coincides with the TS resolver's PER-ITEM choice (source-window.js's
# sourceWindow) because every item independently makes the same choice anyway.
# None of these carry any nobg_* field, so 'preview' and 'render' can't disagree.
_CACHE_COINCIDE_FIXTURES = [
    "windowed-cache-normalized-inpoint",  # Bug A: normalizedInPoint != inPoint origin
    "trim-after-cache",                   # legacy (no normalizedInPoint) + explicit origin, side by side
    "nan-case",                           # neither inPoint nor normalizedInPoint present
]

# Fixtures where NO tracks[0] video clip carries a normalizedSrc: Python's
# all-or-nothing rule coincides trivially with the TS per-item choice (both
# sides fall back to raw src for every clip) -- EXCEPT `source-crop`, which
# now carries a preview-only `proxySrc` (SP3): preview resolves to the proxy
# while render still resolves to raw src. That's why the equality assertion
# below goes through `_assert_variants_agree` rather than a bare `==` -- it
# excludes `src` from the comparison for any clip carrying `proxySrc`.
_NOCACHE_COINCIDE_FIXTURES = [
    "gaps",
    "audio-outlasts-video",
    "negative-start",
    "loop-item",
    "source-crop",
    "source-crop-missing-dims",
    "opaque-overlay",
    "adjacent-grid-boundaries",
]


def test_corpus_directory_found_and_nonempty():
    """Guard against a vacuous parity test: if the corpus path resolution is
    wrong, every test below would silently iterate zero fixtures and pass for
    the wrong reason. Also floors how many fixtures this file actually
    exercises, so a future refactor can't quietly drop coverage to zero."""
    assert _FIXTURES_DIR.is_dir(), f"corpus fixtures dir not found: {_FIXTURES_DIR}"
    assert _EXPECTED_DIR.is_dir(), f"corpus expected dir not found: {_EXPECTED_DIR}"
    fixture_names = sorted(p.stem for p in _FIXTURES_DIR.glob("*.json"))
    assert len(fixture_names) >= 13, fixture_names
    exercised = set(_CACHE_COINCIDE_FIXTURES) | set(_NOCACHE_COINCIDE_FIXTURES) | {"nobg-matrix"}
    assert exercised.issubset(set(fixture_names)), exercised - set(fixture_names)
    assert len(exercised) >= 10, "too few corpus fixtures exercised -- floor guard"


def test_cache_coincide_fixtures_match_corpus_golden():
    """All-clips-cached fixtures: Python's all-or-nothing cache selection
    coincides with the TS resolver's per-item choice, so Python's per-clip
    in/out must equal both corpus golden variants exactly."""
    assert _CACHE_COINCIDE_FIXTURES, "no fixtures exercised"
    for name in _CACHE_COINCIDE_FIXTURES:
        project = _load_fixture(name)
        golden = _load_golden(name)
        clips = _video_clips_by_start(project)
        segments = extract_segments(project)
        assert len(segments) == len(clips) > 0, name
        for clip, seg in zip(clips, segments):
            gw = golden["sourceWindow"][clip["id"]]
            _assert_variants_agree(gw, clip, name)
            expected = gw["render"]
            assert expected["usedNormalizedCache"] is True, (name, clip["id"])
            assert seg["src"] == expected["src"], (name, clip["id"])
            assert abs(seg["in"] - expected["inPoint"]) < 1e-4, (name, clip["id"])
            assert abs(seg["out"] - expected["outPoint"]) < 1e-4, (name, clip["id"])


def test_nocache_coincide_fixtures_match_corpus_golden():
    """No-clips-cached fixtures: Python's all-or-nothing rule coincides
    trivially (both sides fall back to raw src, except `source-crop`'s
    preview-only `proxySrc` -- see `_assert_variants_agree`), so Python's
    per-clip in/out must equal both corpus golden variants exactly."""
    assert _NOCACHE_COINCIDE_FIXTURES, "no fixtures exercised"
    for name in _NOCACHE_COINCIDE_FIXTURES:
        project = _load_fixture(name)
        golden = _load_golden(name)
        clips = _video_clips_by_start(project)
        segments = extract_segments(project)
        assert len(segments) == len(clips) > 0, name
        for clip, seg in zip(clips, segments):
            gw = golden["sourceWindow"][clip["id"]]
            _assert_variants_agree(gw, clip, name)
            expected = gw["render"]
            assert expected["usedNormalizedCache"] is False, (name, clip["id"])
            assert seg["src"] == expected["src"], (name, clip["id"])
            assert abs(seg["in"] - expected["inPoint"]) < 1e-4, (name, clip["id"])
            assert abs(seg["out"] - expected["outPoint"]) < 1e-4, (name, clip["id"])


def test_nobg_matrix_rows_without_nobg_effect_match_both_variants():
    """nobg-matrix.json rows nobg-000/010/100 never let a nobg_* field enter
    either TS variant's src-selection chain (chooseSrcRaw, source-window.js:
    000/010 have remove_bg=False so render's `nobg_src && remove_bg` guard is
    closed; 100 has no nobg_src/nobg_preview_src at all) -- for exactly these
    three of the fixture's eight rows preview and render both collapse to the
    plain normalizedSrc rebase Python always computes. The other five rows are
    asserted as documented divergences below, in
    test_nobg_matrix_diverging_rows_match_documented_python_behavior."""
    name = "nobg-matrix"
    project = _load_fixture(name)
    golden = _load_golden(name)
    ordered_clips = _video_clips_by_start(project)
    segments = dict(zip((c["id"] for c in ordered_clips), extract_segments(project)))
    for item_id in ("nobg-000", "nobg-010", "nobg-100"):
        gw = golden["sourceWindow"][item_id]
        assert gw["preview"] == gw["render"], item_id
        expected = gw["render"]
        seg = segments[item_id]
        assert seg["src"] == expected["src"], item_id
        assert abs(seg["in"] - expected["inPoint"]) < 1e-4, item_id
        assert abs(seg["out"] - expected["outPoint"]) < 1e-4, item_id


def test_nobg_matrix_diverging_rows_match_documented_python_behavior():
    """DOCUMENTED DIVERGENCE -- registry: KNOWN-DIVERGENCES.md id
    'nobg-precedence' (montaj_assets/timeline-core/KNOWN-DIVERGENCES.md #6).
    That entry documents preview-vs-render disagreeing WITHIN the TS resolver.
    Python's own divergence is broader than what the registry entry describes:
    caption_job.py's module header says it plainly -- extract_segments never
    reads remove_bg / nobg_src / nobg_preview_src AT ALL, so it computes the
    exact same plain normalizedSrc rebase (src=*_norm.mp4, in=2.0, out=8.0,
    from normalizedInPoint=1/inPoint=3/outPoint=9) for every one of the eight
    rows, regardless of remove_bg or which nobg artifact is present. That
    agrees with neither TS variant for these five rows:

      nobg-001, nobg-011, nobg-101: preview picks nobg_preview_src (a
        full-source, un-rebased artifact) because it exists; Python still uses
        the rebased cache.
      nobg-110 (the registry's headline row): render picks nobg_src (also
        full-source, un-rebased) because remove_bg is True; Python still uses
        the rebased cache. (Its preview happens to coincide with Python here --
        asserted explicitly below -- since preview also falls through to
        normalizedSrc when nobg_preview_src is absent; the row is still
        "diverging" because render does not.)
      nobg-111: BOTH preview and render pick a nobg artifact over the cache;
        Python uses the rebased cache regardless of either.
    """
    name = "nobg-matrix"
    project = _load_fixture(name)
    golden = _load_golden(name)
    ordered_clips = _video_clips_by_start(project)
    segments = dict(zip((c["id"] for c in ordered_clips), extract_segments(project)))

    # Python's actual (documented) output: identical for every row -- proves
    # remove_bg/nobg_src/nobg_preview_src are simply never consulted.
    for item_id in ("nobg-001", "nobg-011", "nobg-101", "nobg-110", "nobg-111"):
        seg = segments[item_id]
        assert seg["src"] == f"/corpus/{item_id}_norm.mp4", item_id
        assert seg["in"] == 2.0, item_id
        assert seg["out"] == 8.0, item_id

    # Rows where PREVIEW disagrees with Python (preview prefers nobg_preview_src).
    for item_id in ("nobg-001", "nobg-011", "nobg-101", "nobg-111"):
        preview = golden["sourceWindow"][item_id]["preview"]
        assert preview["src"] != segments[item_id]["src"], item_id
        assert preview["usedNormalizedCache"] is False, item_id

    # Rows where RENDER disagrees with Python (render prefers nobg_src once
    # remove_bg is true).
    for item_id in ("nobg-110", "nobg-111"):
        render = golden["sourceWindow"][item_id]["render"]
        assert render["src"] != segments[item_id]["src"], item_id
        assert render["usedNormalizedCache"] is False, item_id

    # nobg-110's PREVIEW happens to coincide with Python (remove_bg is True but
    # there's no nobg_preview_src, so preview also falls through to
    # normalizedSrc) -- pinned explicitly since the row as a whole is filed
    # above as diverging (because render does not coincide).
    preview_110 = golden["sourceWindow"]["nobg-110"]["preview"]
    assert preview_110["src"] == segments["nobg-110"]["src"]
    assert abs(preview_110["inPoint"] - segments["nobg-110"]["in"]) < 1e-4


def test_all_or_nothing_cache_selection_diverges_from_ts_per_item():
    """DOCUMENTED DIVERGENCE -- NO KNOWN-DIVERGENCES.md registry entry exists
    for this (it is Python-only; TS-vs-TS is what that file tracks). Reported
    as a registry gap in the T10 report.

    extract_segments' cache switch (serve/caption_job.py:47,
    `use_cache = bool(clips) and all(c.get("normalizedSrc") for c in clips)`)
    is ALL-OR-NOTHING across tracks[0]: one clip missing normalizedSrc drops
    the cache for every clip, including ones that have it. The TS resolver's
    sourceWindow (source-window.js) decides PER ITEM -- each clip's cache
    choice is independent of its neighbors. No corpus fixture has a MIXED
    tracks[0] (some clips cached, some not) to pin this against a golden --
    another gap, so this project is constructed inline.

    If clip A were resolved by sourceWindow on its own, it would rebase into
    cache time (normalizedInPoint=4.0 -> in=6.0-4.0=2.0, out=9.0-4.0=5.0) same
    as Python's OWN cache branch computes in isolation (see
    test_all_clips_cached_uses_normalized_src_rebased above). Because clip B
    lacks a normalizedSrc, Python's all-or-nothing rule instead falls BOTH
    clips back to raw src -- A's cache is never used even though it has one.
    """
    project = {
        "tracks": [
            [
                _cached_clip("A.MOV", "A_norm.mp4", 0.0, 3.0, 6.0, 9.0, normalized_in_pt=4.0),
                _clip("B.MOV", 3.0, 8.0, 12.0, 17.0),  # no normalizedSrc at all
            ]
        ]
    }
    segs = extract_segments(project)
    assert [s["src"] for s in segs] == ["A.MOV", "B.MOV"]
    # raw (non-rebased) in/out for BOTH clips -- A's cache is unused
    assert (segs[0]["in"], segs[0]["out"]) == (6.0, 9.0)
    assert (segs[1]["in"], segs[1]["out"]) == (12.0, 17.0)


def test_cache_rebase_negative_in_point_clamped_to_zero():
    """DOCUMENTED DIVERGENCE -- NO KNOWN-DIVERGENCES.md registry entry exists
    for this (Python-only). Reported as a registry gap in the T10 report.

    extract_segments clamps a negative rebased in-point to 0.0
    (serve/caption_job.py:59, `in_pt = max(0.0, in_pt)`). The TS resolver's
    sourceWindow never clamps -- `inPoint: inPointRaw - origin` is returned
    as-is, negative or not (source-window.js has no max()/clamp anywhere).

    The extract_segments docstring frames this as protection against "tiny
    negative values (float rounding when inPoint == normalizedInPoint)", but
    the code clamps UNCONDITIONALLY on any negative value, not just FP noise --
    this test deliberately picks a clearly-negative (non-tiny) case to pin the
    actual, broader code behavior against that narrower docstring description.

    No corpus fixture produces a negative rebased in-point (checked every clip
    in windowed-cache-normalized-inpoint.json / trim-after-cache.json /
    nobg-matrix.json -- none has inPoint < normalizedInPoint), so this project
    is constructed inline -- a third gap, reported in the T10 report.

    Also pins that the clamp is ISOLATED to the returned `in`: the `out` value
    (9.0 explicit outPoint - 5.0 origin = 4.0) is computed independently and is
    NOT affected by the clamp on `in` -- see
    test_outpoint_fallback_uses_unclamped_in_point_internally below for the
    fallback-formula case, where this matters more subtly.
    """
    project = {
        "tracks": [
            [
                _cached_clip("A.MOV", "A_norm.mp4", 0.0, 5.0, 3.0, 9.0, normalized_in_pt=5.0),
            ]
        ]
    }
    # origin=5.0 (normalizedInPoint), raw inPoint=3.0 -> unclamped in = 3.0-5.0 = -2.0
    # TS's sourceWindow would return inPoint=-2.0 verbatim; Python clamps to 0.0.
    segs = extract_segments(project)
    assert segs[0]["src"] == "A_norm.mp4"
    assert segs[0]["in"] == 0.0    # clamped -- TS would report -2.0
    assert segs[0]["out"] == 4.0   # outPoint(9.0) - origin(5.0), unaffected by the clamp


def test_outpoint_fallback_uses_unclamped_in_point_internally():
    """Corpus gap: every clip in every corpus fixture sets `outPoint`
    explicitly, so no fixture exercises extract_segments' outPoint FALLBACK
    branch (serve/caption_job.py:58/63, used only when the `outPoint` key is
    absent) -- constructed inline here.

    Structurally, Python's cache-branch fallback --
    `(end - start + rawInPoint) - origin` -- and the TS resolver's
    synthesizedOutPoint (source-window.js: `w.inPoint + (end - start)`, where
    `w.inPoint = rawInPoint - origin`) are the SAME formula, just associated in
    a different order: both reduce to `(end - start) + (rawInPoint - origin)`.
    Confirmed here with an origin that also drives the max(0.0) clamp, which
    is the one case where they could plausibly disagree: the fallback's
    internal `(rawInPoint - origin)` term is the UNCLAMPED value in both
    formulas (TS never clamps at all; Python's `out_pt` fallback expression
    computes its own `- origin` straight from raw inPoint, one line before
    `in_pt` gets clamped, and the clamped `in_pt` is never substituted back
    into it) -- so the two formulas keep agreeing even where the returned `in`
    itself diverges (see test_cache_rebase_negative_in_point_clamped_to_zero).
    """
    project = {
        "tracks": [
            [
                {
                    "type": "video",
                    "src": "A.MOV",
                    "normalizedSrc": "A_norm.mp4",
                    "start": 0.0,
                    "end": 5.0,
                    "inPoint": 3.0,
                    "normalizedInPoint": 5.0,
                    # deliberately no "outPoint" key -- forces the fallback formula
                }
            ]
        ]
    }
    # origin=5.0, raw inPoint=3.0 -> unclamped in = -2.0 (returned `in` clamps to 0.0)
    # fallback out = (end - start + rawInPoint) - origin = (5-0+3.0) - 5.0 = 3.0
    #              = (end - start) + unclamped_in = 5.0 + (-2.0) = 3.0  -- same either way
    segs = extract_segments(project)
    assert segs[0]["in"] == 0.0    # clamped
    assert segs[0]["out"] == 3.0   # the TS synthesizedOutPoint formula agrees
