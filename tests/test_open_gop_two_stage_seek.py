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

from lib.normalize import normalize_window  # noqa: E402,F401 (path insert above; imported so
# lib/ lands on sys.path — see `common` below — and to prove the real function is reachable)
import common  # noqa: E402 — lib/ lands on sys.path as a side effect of importing lib.normalize

from tests.conftest import run_step  # noqa: E402

np = pytest.importorskip("numpy")

FPS = 30
SIZE = "320x240"
SOURCE_DURATION_S = 4  # several full 1s GOPs
WINDOW_FRAMES = 8
WINDOW_S = WINDOW_FRAMES / FPS

REQUIRE_HDR_FFMPEG = os.environ.get("MONTAJ_REQUIRE_HDR_FFMPEG") == "1"


def _skip_or_fail(reason: str) -> None:
    """Skip, or fail loudly under MONTAJ_REQUIRE_HDR_FFMPEG=1 — same pattern
    as tests/test_normalize.py's _skip_or_fail and tests/test_color_provenance.py."""
    if REQUIRE_HDR_FFMPEG:
        pytest.fail(reason)
    pytest.skip(reason)


def _has_libx265() -> bool:
    try:
        r = subprocess.run([common.ffmpeg_bin(), "-hide_banner", "-encoders"],
                            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return "libx265" in (r.stdout or "")


def _make_open_gop_source(path: Path) -> None:
    """30 fps libx265 clip, open GOP with B-frames (libx265 default — no
    x265-params disabling it, matching lib/normalize.py's own HDR encode
    args per PV48 T1/T3), 1s keyint, a visible per-frame counter (testsrc2)
    and a tone audio track."""
    subprocess.run([
        common.ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"testsrc2=size={SIZE}:rate={FPS}:duration={SOURCE_DURATION_S}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={SOURCE_DURATION_S}",
        "-c:v", "libx265", "-preset", "fast", "-crf", "22",
        "-pix_fmt", "yuv420p", "-g", str(FPS), "-keyint_min", str(FPS),
        "-c:a", "aac", "-ar", "48000",
        str(path),
    ], check=True, capture_output=True, timeout=120)


def _at_risk_t(path: Path) -> float:
    """First keyframe K after t=0 whose packet dts precedes its own pts —
    proof of leading pictures decoded after K but displayed before it (an
    open-GOP boundary; same detection as tests/test_color_provenance.py's
    _keyframe_window). Returns t = pts(K) - 2/fps (PV48 T3's harness formula)."""
    out = subprocess.run(
        [common.ffprobe_bin(), "-v", "error", "-select_streams", "v",
         "-show_entries", "packet=pts_time,dts_time,flags", "-of", "csv", str(path)],
        capture_output=True, text=True, check=True, timeout=30).stdout
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
            return t
    pytest.fail(f"{path}: no open-GOP keyframe found (no packet has dts < pts) — fixture is not open-GOP")


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
