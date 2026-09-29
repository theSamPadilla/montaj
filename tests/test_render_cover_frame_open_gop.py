"""PV48 T3: _extract_cover_frame (serve/routes/projects.py) two-stage seek
regression test.

`cover` is a caller-supplied, arbitrary render-timeline timestamp (not
rounded), and the file it reads is the finished render itself — our own
open-GOP HEVC output when the project is HDR (libx265 default GOP). A single
input-level `-ss cover -i` into a keyframe's leading-picture window starts
decoding AT that keyframe, dropping the leading pictures, and returns the
keyframe's frame instead of the one at `cover` (1-3 frames late, PV48 T3
audit). This builds a fresh open-GOP libx265 fixture, finds an at-risk
`cover` from its own packet table (never hardcoded), confirms a naive
single-stage seek actually reproduces the bug on this fixture (positive
control), then asserts the real `_extract_cover_frame` returns the correct
source frame.

Same fixture/derivation method as tests/test_open_gop_two_stage_seek.py
(PV48 T3's normalize_window/materialize_cut proof) and
tests/test_color_provenance.py's `_keyframe_window` — helpers duplicated
locally rather than imported, matching this repo's own per-file convention.
"""
import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from serve.routes.projects import _RenderJob, _extract_cover_frame  # noqa: E402
import common  # noqa: E402 — lib/ lands on sys.path as a side effect of the import above
# (serve.routes.projects imports lib.normalize, whose own sys.path.insert adds lib/ — see
# lib/normalize.py's module docstring; same pattern as tests/test_open_gop_two_stage_seek.py)

FPS = 30
SIZE = "320x240"
SOURCE_DURATION_S = 4  # several full 1s GOPs

REQUIRE_HDR_FFMPEG = os.environ.get("MONTAJ_REQUIRE_HDR_FFMPEG") == "1"


def _skip_or_fail(reason: str) -> None:
    """Skip, or fail loudly under MONTAJ_REQUIRE_HDR_FFMPEG=1 — same pattern as
    tests/test_normalize.py, tests/test_color_provenance.py, tests/test_open_gop_two_stage_seek.py."""
    if REQUIRE_HDR_FFMPEG:
        pytest.fail(reason)
    pytest.skip(reason)


# numpy is declared in pyproject.toml's `test` extra (PV48 review), but a
# clean env can still lack it — under MONTAJ_REQUIRE_HDR_FFMPEG=1 that must
# fail the run, not silently skip this pixel-comparison test.
try:
    import numpy as np
except ImportError:
    if REQUIRE_HDR_FFMPEG:
        pytest.fail("numpy is required under MONTAJ_REQUIRE_HDR_FFMPEG=1 but is not installed")
    pytest.skip("numpy not installed", allow_module_level=True)


def _has_libx265() -> bool:
    try:
        r = subprocess.run([common.ffmpeg_bin(), "-hide_banner", "-encoders"],
                            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return "libx265" in (r.stdout or "")


def _make_open_gop_source(path: Path) -> None:
    """30 fps libx265 clip, open GOP with B-frames (libx265 default — no
    x265-params disabling it), 1s keyint, a per-frame-distinct pattern
    (testsrc2). No audio: _extract_cover_frame reads video only."""
    subprocess.run([
        common.ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"testsrc2=size={SIZE}:rate={FPS}:duration={SOURCE_DURATION_S}",
        "-c:v", "libx265", "-preset", "fast", "-crf", "22",
        "-pix_fmt", "yuv420p", "-g", str(FPS), "-keyint_min", str(FPS),
        str(path),
    ], check=True, capture_output=True, timeout=120)


def _at_risk_t(path: Path) -> float:
    """First keyframe K after t=0 whose packet dts precedes its own pts —
    evidence of reordering (leading pictures) around it. Returns
    t = pts(K) - 2/fps, the same formula as PV48 T3's harness and
    tests/test_open_gop_two_stage_seek.py."""
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
    """Every frame of `path`, downscaled to w x h grayscale, as an (N, h, w)
    float32 array. Same method as PV48's harness/detect.py."""
    cmd = [common.ffmpeg_bin(), "-v", "error", "-nostdin", *pre, "-i", str(path), *post,
           "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True, timeout=30).stdout
    n = len(raw) // (w * h)
    return np.frombuffer(raw[:n * w * h], np.uint8).reshape(n, h, w).astype(np.float32)


def _best_match(frame, src_frames) -> int:
    """The source frame index with min mean-abs-diff against `frame`."""
    d = np.abs(src_frames - frame).mean(axis=(1, 2))
    return int(d.argmin())


@pytest.fixture(scope="module")
def open_gop_source(tmp_path_factory):
    if not _has_libx265():
        _skip_or_fail("ffmpeg build lacks libx265")
    d = Path(tmp_path_factory.mktemp("pv48_t3_cover"))
    src = d / "render_output.mp4"
    _make_open_gop_source(src)
    t = _at_risk_t(src)
    src_frames = _gray_frames(src)  # exact decode: from 0, no seek at all
    return src, t, src_frames


def test_naive_single_stage_seek_reproduces_the_bug(open_gop_source):
    """Positive control: a naive `-ss t -i` (the pre-fix form) must NOT
    return the exact source frame at t — otherwise the fixture doesn't
    exercise the bug and the fix assertion below would pass vacuously."""
    src, t, src_frames = open_gop_source
    expected = round(t * FPS)
    naive = _gray_frames(src, pre=["-ss", f"{t:.4f}"], post=["-frames:v", "1"])
    matched = _best_match(naive[0], src_frames)
    assert matched != expected, (
        f"fixture did not reproduce the open-GOP drop at t={t:.4f}: naive seek already "
        f"returned the exact frame {matched}. Adjust the fixture so the bug is exercised."
    )


def test_extract_cover_frame_returns_correct_frame_at_risk(open_gop_source, tmp_path):
    """The real _extract_cover_frame, run for real (no mocked ffmpeg), must
    write a cover JPEG matching the true source frame at the at-risk `cover`
    time — not the keyframe a naive single-stage seek would have returned."""
    src, t, src_frames = open_gop_source
    expected = round(t * FPS)

    job = _RenderJob()
    asyncio.run(_extract_cover_frame(src, t, job))
    assert job.lines == [], f"cover extraction logged a failure: {job.lines}"

    cover_path = src.with_suffix(".jpg")
    assert cover_path.exists(), "cover JPEG was not written"

    cover_frame = _gray_frames(cover_path)[0]
    matched = _best_match(cover_frame, src_frames)
    assert matched == expected, (
        f"_extract_cover_frame returned source frame {matched}, expected {expected} "
        f"(source frame at cover={t:.4f})"
    )
