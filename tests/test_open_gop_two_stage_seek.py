"""PV48 T3: two-stage seek regression test.

Covers lib/normalize.py's normalize_window() and steps/transform/
materialize_cut.py's build_ffmpeg_args() (both exercised through their real
step-script CLIs, not mocked).

Mechanism (PV48 T1, measured): a single input-level `-ss t -i file` straight
into an open-GOP HEVC source (libx265 default GOP — montaj's own SDR-to-HDR
conversions, legacy `*_compatible_hlg.mp4`, and montaj HDR render outputs)
can land inside a keyframe's leading-picture window and start decoding AT
that keyframe, silently dropping the leading pictures. The re-encode then
rebases PTS from that point, so picture runs 1-3 frames early relative to
exactly-seeked audio for the whole window (PV48 T1.md).

This test builds a fresh open-GOP libx265 fixture, finds an at-risk seek
point from its own packet table (never hardcoded), confirms with a naive
single-stage seek that the bug actually reproduces on this fixture (a
positive control — without it, the assertions below could pass vacuously),
then asserts normalize_window() and materialize_cut() return the correct
source frames, in order, starting at that point.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.normalize import normalize_window, SEEK_PREROLL_S  # noqa: E402,F401 (path insert above;
# imported so lib/ lands on sys.path — see `common` below — and to prove the real function/
# constant are reachable)
import common  # noqa: E402 — lib/ lands on sys.path as a side effect of importing lib.normalize

from tests.conftest import run_step  # noqa: E402

FPS = 30
SIZE = "320x240"
SOURCE_DURATION_S = 4  # several full 1s GOPs
WINDOW_FRAMES = 8
WINDOW_S = WINDOW_FRAMES / FPS

from tests.conftest import REQUIRE_CAPS as REQUIRE_HDR_FFMPEG, skip_or_fail as _conftest_skip_or_fail  # PV52: required by default


def _skip_or_fail(reason: str) -> None:
    """Fail (default), or skip under MONTAJ_TEST_ALLOW_MISSING_CAPS=1 — same pattern
    as tests/test_normalize.py's _skip_or_fail and tests/test_color_provenance.py."""
    _conftest_skip_or_fail(reason)


# numpy is declared in pyproject.toml's `test` extra (PV48 review), but a
# clean env can still lack it (extras aren't force-installed) — under
# default (PV52) that must fail the run, not silently skip these
# pixel-comparison tests, same as every other HDR-ffmpeg-dependent guard in
# this file (_skip_or_fail above).
try:
    import numpy as np
except ImportError:
    if REQUIRE_HDR_FFMPEG:
        pytest.fail("numpy is required (pyproject test extra) but is not installed; install it, or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip")
    pytest.skip("numpy not installed", allow_module_level=True)


def _has_libx265() -> bool:
    try:
        r = subprocess.run([common.ffmpeg_bin(), "-hide_banner", "-encoders"],
                            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return "libx265" in (r.stdout or "")


def _make_open_gop_source(path: Path, duration: int = SOURCE_DURATION_S) -> None:
    """30 fps libx265 clip, open GOP with B-frames (libx265 default — no
    x265-params disabling it, matching lib/normalize.py's own HDR encode
    args per PV48 T1/T3), 1s keyint, a visible per-frame counter (testsrc2)
    and a tone audio track."""
    subprocess.run([
        common.ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"testsrc2=size={SIZE}:rate={FPS}:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-c:v", "libx265", "-preset", "fast", "-crf", "22",
        "-pix_fmt", "yuv420p", "-g", str(FPS), "-keyint_min", str(FPS),
        "-c:a", "aac", "-ar", "48000",
        str(path),
    ], check=True, capture_output=True, timeout=120)


def _at_risk_times(path: Path, count: int = 1) -> list:
    """The first `count` keyframes K after t=0 whose packet dts precedes its
    own pts, in order — proof of leading pictures decoded after each K but
    displayed before it (an open-GOP boundary; same detection as
    tests/test_color_provenance.py's _keyframe_window). Each entry is
    t = pts(K) - 2/fps (PV48 T3's harness formula)."""
    out = subprocess.run(
        [common.ffprobe_bin(), "-v", "error", "-select_streams", "v",
         "-show_entries", "packet=pts_time,dts_time,flags", "-of", "csv", str(path)],
        capture_output=True, text=True, check=True, timeout=30).stdout
    found = []
    for line in out.splitlines():
        parts = line.split(",")
        if len(parts) < 4:
            continue
        _, pts_s, dts_s, flags = parts[:4]
        try:
            pts, dts = float(pts_s), float(dts_s)
        except ValueError:
            continue
        if flags.startswith("K") and pts > 0 and dts < pts:
            t = pts - 2 / FPS
            assert dts < t <= pts, (
                f"t={t} formula result falls outside keyframe {path.name}'s own "
                f"reorder window (dts={dts}, pts={pts})"
            )
            found.append(t)
            if len(found) == count:
                return found
    pytest.fail(
        f"{path}: found only {len(found)} open-GOP keyframe(s) (no packet has dts < pts), "
        f"need {count} — fixture is not open-GOP enough for this case"
    )


def _at_risk_t(path: Path) -> float:
    """First at-risk keyframe's t — see _at_risk_times."""
    return _at_risk_times(path, 1)[0]


def _audio_duration_s(path: Path) -> float:
    """ffprobe's audio-stream duration in seconds, or 0.0 if there is none."""
    out = subprocess.run(
        [common.ffprobe_bin(), "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True, timeout=30).stdout.strip()
    return float(out) if out else 0.0


def _gray_frames(path: Path, pre=(), post=(), w=64, h=36):
    """Every frame of `path`, downscaled to w x h grayscale (colour-grade
    independent), as an (N, h, w) float32 array. Same method as PV48's
    harness/detect.py."""
    cmd = [common.ffmpeg_bin(), "-v", "error", "-nostdin", *pre, "-i", str(path), *post,
           "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True, timeout=30).stdout
    n = len(raw) // (w * h)
    return np.frombuffer(raw[:n * w * h], np.uint8).reshape(n, h, w).astype(np.float32)


def _matched_indices(out_frames, src_frames):
    """For each output frame, the source frame index with min mean-abs-diff."""
    matched = []
    for i in range(len(out_frames)):
        d = np.abs(src_frames - out_frames[i]).mean(axis=(1, 2))
        matched.append(int(d.argmin()))
    return matched


@pytest.fixture(scope="module")
def open_gop_source(tmp_path_factory):
    if not _has_libx265():
        _skip_or_fail("ffmpeg build lacks libx265")
    d = Path(tmp_path_factory.mktemp("pv48_t3"))
    src = d / "src_open_gop.mp4"
    _make_open_gop_source(src)
    t = _at_risk_t(src)
    # Exact decode of the source: from 0, no seek at all.
    src_frames = _gray_frames(src)
    return src, t, src_frames


def test_naive_single_stage_seek_reproduces_the_bug(open_gop_source):
    """Positive control: a naive `-ss t -i` (no preroll, the pre-fix form)
    must NOT return the exact source frames at t, t+1/fps, ... — otherwise
    the fixture doesn't actually exercise the bug and the fix assertions
    below would pass vacuously."""
    src, t, src_frames = open_gop_source
    expected_start = round(t * FPS)
    naive = _gray_frames(src, pre=["-ss", f"{t:.4f}"], post=["-frames:v", str(WINDOW_FRAMES)])
    matched = _matched_indices(naive, src_frames)
    expected = [expected_start + i for i in range(len(naive))]
    assert matched != expected, (
        f"fixture did not reproduce the open-GOP drop at t={t:.4f}: naive seek already "
        f"returned the exact frames {matched}. Adjust the fixture so the bug is exercised."
    )


def test_normalize_window_returns_correct_frames_at_risk(open_gop_source, tmp_path):
    """The real normalize_window(), run via its step-script CLI, must return
    the correct source frames starting exactly at the at-risk `t`."""
    src, t, src_frames = open_gop_source
    expected_start = round(t * FPS)
    out = tmp_path / "normalized_window.mp4"

    proc = run_step(
        "normalize_window.py",
        "--input", str(src),
        "--inpoint", f"{t:.4f}",
        "--outpoint", f"{t + WINDOW_S:.4f}",
        "--color-space", "sdr_bt709",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    assert out.exists()

    out_frames = _gray_frames(out)[:WINDOW_FRAMES]
    matched = _matched_indices(out_frames, src_frames)
    expected = [expected_start + i for i in range(len(out_frames))]
    assert matched == expected, (
        f"normalize_window returned source frames {matched}, expected {expected} "
        f"(source frames at t={t:.4f}, t+1/{FPS}, ...)"
    )


def test_materialize_cut_returns_correct_frames_at_risk(open_gop_source, tmp_path):
    """The real materialize_cut (video mode), run via its step-script CLI,
    must return the correct source frames starting exactly at the at-risk `t`."""
    src, t, src_frames = open_gop_source
    expected_start = round(t * FPS)
    out = tmp_path / "materialized.mp4"

    proc = run_step(
        "materialize_cut.py",
        "--input", str(src),
        "--inpoint", f"{t:.4f}",
        "--outpoint", f"{t + WINDOW_S:.4f}",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    assert out.exists()

    out_frames = _gray_frames(out)[:WINDOW_FRAMES]
    matched = _matched_indices(out_frames, src_frames)
    expected = [expected_start + i for i in range(len(out_frames))]
    assert matched == expected, (
        f"materialize_cut returned source frames {matched}, expected {expected} "
        f"(source frames at t={t:.4f}, t+1/{FPS}, ...)"
    )


# ── near-itself-at-risk (PV48 review) ────────────────────────────────────────
#
# The three tests above pick `t` as the FIRST at-risk keyframe in a 4s
# fixture, where near = max(0, t - SEEK_PREROLL_S) is always 0 (t < 2s) — so
# the early-seek-plus-trim path never actually decodes through a second
# open-GOP boundary, and the tests slice `out_frames` down to WINDOW_FRAMES,
# which hides a window that runs long. Neither gap exercises the bug PV48
# review found: the window's END was computed from the input `-t`, counted
# from wherever decode actually started (`near`), not from `t` — on a source
# where `near` itself lands inside an EARLIER keyframe's leading-picture
# window, the window ran past its requested end (materialize_cut: 3.2s
# instead of 3.0s on a 3-keep case; normalize_window: 1.2s of video against
# 1.0s of exact audio). This section builds a longer fixture, picks
# `t = (second at-risk time) + SEEK_PREROLL_S` so `near` lands exactly on
# that second at-risk time, and asserts the FULL frame list (not sliced) plus
# the audio length.

NESTED_SOURCE_DURATION_S = 9  # far enough past the 2nd at-risk keyframe (~2s) for the window to fit
AUDIO_TOLERANCE_S = 0.05  # AAC frames the exact atrim/trim cut to ~21ms multiples


@pytest.fixture(scope="module")
def open_gop_source_nested(tmp_path_factory):
    if not _has_libx265():
        _skip_or_fail("ffmpeg build lacks libx265")
    d = Path(tmp_path_factory.mktemp("pv48_review_nested"))
    src = d / "src_open_gop_nested.mp4"
    _make_open_gop_source(src, duration=NESTED_SOURCE_DURATION_S)
    risky = _at_risk_times(src, count=2)
    t = risky[1] + SEEK_PREROLL_S
    near = max(0.0, t - SEEK_PREROLL_S)
    assert abs(near - risky[1]) < 1e-6, (
        f"test setup: near ({near}) must land exactly on the 2nd at-risk time ({risky[1]})"
    )
    src_frames = _gray_frames(src)  # exact decode: from 0, no seek at all
    return src, t, src_frames


def test_normalize_window_full_window_correct_when_near_itself_at_risk(open_gop_source_nested, tmp_path):
    """normalize_window(): when `near` itself lands in an earlier keyframe's
    leading-picture window, the output must be the exact requested WINDOW_S
    of video (not longer) and its audio must be the same length."""
    src, t, src_frames = open_gop_source_nested
    expected_start = round(t * FPS)
    out = tmp_path / "normalized_window_nested.mp4"

    proc = run_step(
        "normalize_window.py",
        "--input", str(src),
        # Full precision (.9f, not .4f like the two tests above): unlike
        # those, this test does NOT slice its output, so a 4-decimal-rounded
        # inpoint/outpoint pair here would itself widen the requested window
        # by up to ~1e-4s — enough, at this fixture's frame boundaries, to
        # admit a legitimately-extra frame and mask the very overshoot this
        # test exists to catch.
        "--inpoint", f"{t:.9f}",
        "--outpoint", f"{t + WINDOW_S:.9f}",
        "--color-space", "sdr_bt709",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    assert out.exists()

    out_frames = _gray_frames(out)  # NOT sliced — proves the window doesn't run long
    assert len(out_frames) == WINDOW_FRAMES, (
        f"normalize_window produced {len(out_frames)} video frames "
        f"({len(out_frames) / FPS:.4f}s), expected exactly {WINDOW_FRAMES} ({WINDOW_S:.4f}s)"
    )
    matched = _matched_indices(out_frames, src_frames)
    expected = [expected_start + i for i in range(len(out_frames))]
    assert matched == expected, (
        f"normalize_window returned source frames {matched}, expected {expected} "
        f"(source frames at t={t:.4f}, t+1/{FPS}, ...)"
    )

    audio_s = _audio_duration_s(out)
    assert abs(audio_s - WINDOW_S) <= AUDIO_TOLERANCE_S, (
        f"normalize_window audio is {audio_s:.4f}s, expected ~{WINDOW_S:.4f}s "
        f"(video was {len(out_frames) / FPS:.4f}s)"
    )


def test_materialize_cut_full_window_correct_when_near_itself_at_risk(open_gop_source_nested, tmp_path):
    """materialize_cut (single keep): same nested-at-risk case as above."""
    src, t, src_frames = open_gop_source_nested
    expected_start = round(t * FPS)
    out = tmp_path / "materialized_nested.mp4"

    proc = run_step(
        "materialize_cut.py",
        "--input", str(src),
        # Full precision — see the matching comment in the normalize_window
        # nested test above.
        "--inpoint", f"{t:.9f}",
        "--outpoint", f"{t + WINDOW_S:.9f}",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    assert out.exists()

    out_frames = _gray_frames(out)  # NOT sliced — proves the window doesn't run long
    assert len(out_frames) == WINDOW_FRAMES, (
        f"materialize_cut produced {len(out_frames)} video frames "
        f"({len(out_frames) / FPS:.4f}s), expected exactly {WINDOW_FRAMES} ({WINDOW_S:.4f}s)"
    )
    matched = _matched_indices(out_frames, src_frames)
    expected = [expected_start + i for i in range(len(out_frames))]
    assert matched == expected, (
        f"materialize_cut returned source frames {matched}, expected {expected} "
        f"(source frames at t={t:.4f}, t+1/{FPS}, ...)"
    )

    audio_s = _audio_duration_s(out)
    assert abs(audio_s - WINDOW_S) <= AUDIO_TOLERANCE_S, (
        f"materialize_cut audio is {audio_s:.4f}s, expected ~{WINDOW_S:.4f}s "
        f"(video was {len(out_frames) / FPS:.4f}s)"
    )


def test_materialize_cut_multi_keep_correct_when_near_itself_at_risk(open_gop_source_nested, tmp_path):
    """materialize_cut (multi-keep / concat path): a safe leading keep
    [0.0, 0.2] followed by the at-risk keep — proves build_ffmpeg_args's
    per-segment fines[]/durs[] indexing (idx > 0) under concat, not just the
    n == 1 path the two tests above exercise."""
    src, t, src_frames = open_gop_source_nested
    lead_s, lead_e = 0.0, 0.2
    lead_frames = round((lead_e - lead_s) * FPS)
    expected_start = round(t * FPS)
    out = tmp_path / "materialized_nested_multi.mp4"

    spec = {"input": str(src), "keeps": [[lead_s, lead_e], [t, t + WINDOW_S]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(__import__("json").dumps(spec))

    proc = run_step("materialize_cut.py", "--input", str(spec_path), "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    assert out.exists()

    out_frames = _gray_frames(out)  # NOT sliced — proves the 2nd segment doesn't run long
    expected_total = lead_frames + WINDOW_FRAMES
    assert len(out_frames) == expected_total, (
        f"materialize_cut (multi-keep) produced {len(out_frames)} video frames, "
        f"expected exactly {expected_total} ({lead_frames} lead + {WINDOW_FRAMES} at-risk)"
    )

    lead_matched = _matched_indices(out_frames[:lead_frames], src_frames)
    assert lead_matched == list(range(lead_frames)), (
        f"materialize_cut (multi-keep) lead segment returned {lead_matched}, "
        f"expected {list(range(lead_frames))}"
    )

    at_risk_matched = _matched_indices(out_frames[lead_frames:], src_frames)
    expected = [expected_start + i for i in range(WINDOW_FRAMES)]
    assert at_risk_matched == expected, (
        f"materialize_cut (multi-keep) at-risk segment returned {at_risk_matched}, expected {expected} "
        f"(source frames at t={t:.4f}, t+1/{FPS}, ...)"
    )

    expected_audio_s = (lead_e - lead_s) + WINDOW_S
    audio_s = _audio_duration_s(out)
    assert abs(audio_s - expected_audio_s) <= AUDIO_TOLERANCE_S, (
        f"materialize_cut (multi-keep) audio is {audio_s:.4f}s, expected ~{expected_audio_s:.4f}s"
    )
