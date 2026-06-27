"""Tests for lib/normalize.py — project-color-space-aware contract.

Audio fast path was removed in the color-space-aware rewrite (audio sample rate
is no longer checked by is_normalized; conformant-video + bad-audio sources are
now is_normalized==True directly and skip normalize entirely; segment encoder
resamples per item at compose time).
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

import lib.normalize as nm

from lib.normalize import (
    _run_atomic_encode,
    _sweep_stale_temps,
    _tmp_for,
    is_normalized,
    normalize,
    probe_video,
)

HAS_FFMPEG = shutil.which("ffmpeg") is not None
pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


# ── helpers ───────────────────────────────────────────────────────────────────

def _ffprobe_stream(path, kind="v"):
    """Return the first stream of `kind` ('v' or 'a')."""
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_streams", "-select_streams", kind, str(path)],
        capture_output=True, text=True, timeout=30,
    )
    if r.returncode != 0:
        return None
    streams = json.loads(r.stdout).get("streams", [])
    return streams[0] if streams else None


def _make_conformant_video(path: Path, *, width=1920, height=1080,
                           sample_rate=48000, with_audio=True, duration=2):
    """Create a video file with conformant SDR codec/pix_fmt/keyframes; audio per args.

    Uses the h264_metadata bitstream filter to force bt709 transfer tags into
    the bitstream. Without this, lavfi-sourced clips end up with `color_transfer:
    unknown` even when -color_trc bt709 is passed (lavfi color sources don't
    propagate transfer metadata). Real iPhone SDR sources carry these tags.
    """
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=red:size={width}x{height}:rate=30:duration={duration}",
    ]
    if with_audio:
        cmd += ["-f", "lavfi", "-i",
                f"sine=frequency=440:sample_rate={sample_rate}:duration={duration}"]
    cmd += [
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        # Force bt709 transfer/primaries/matrix into the bitstream so ffprobe
        # reports them on read-back. h264_metadata=1 means bt709 in the spec.
        "-bsf:v", "h264_metadata=transfer_characteristics=1:colour_primaries=1:matrix_coefficients=1",
    ]
    if with_audio:
        cmd += ["-c:a", "aac", "-ar", str(sample_rate)]
    cmd += [str(path)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=60)


def _make_hdr_like_video(path: Path, *, transfer="smpte2084", duration=2):
    """Create a yuv420p10le clip tagged with HDR color metadata.

    Default produces a PQ (smpte2084) clip; pass transfer='arib-std-b67' for HLG.

    Note: -color_trc alone doesn't make the transfer metadata stick when the
    source is a synthetic lavfi color filter (filter strips color info). The
    libx265 encoder DOES respect x265-params transfer=, which writes the value
    into the bitstream and ffprobe reads it back. So we set both stream-level
    flags AND x265-params to be sure.
    """
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=red:size=640x360:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p10le",
        "-x265-params", f"transfer={transfer}:colorprim=bt2020:colormatrix=bt2020nc",
        "-color_trc", transfer,
        "-color_primaries", "bt2020",
        "-colorspace", "bt2020nc",
        "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-ar", "48000",
        str(path),
    ], check=True, capture_output=True, timeout=60)


# ── is_normalized() with project_color_space ──────────────────────────────────

def test_is_normalized_sdr_source_in_sdr_project(tmp_path):
    """SDR conformant clip in SDR project → is_normalized==True (no transcode)."""
    src = tmp_path / "sdr.mp4"
    _make_conformant_video(src)
    info = probe_video(str(src))
    assert info is not None
    assert is_normalized(str(src), info, "sdr_bt709") is True


def test_is_normalized_hlg_source_in_hlg_project(tmp_path):
    """iPhone HDR HLG clip in HLG project must pass — no transcode needed."""
    src = tmp_path / "hlg.mp4"
    _make_hdr_like_video(src, transfer="arib-std-b67")
    info = probe_video(str(src))
    assert info is not None
    # Source is yuv420p10le + arib-std-b67 → conformant for hdr_hlg.
    assert is_normalized(str(src), info, "hdr_hlg") is True


def test_is_normalized_hlg_source_in_sdr_project(tmp_path):
    """HLG clip in SDR project must fail — tonemap needed."""
    src = tmp_path / "hlg.mp4"
    _make_hdr_like_video(src, transfer="arib-std-b67")
    info = probe_video(str(src))
    assert info is not None
    assert is_normalized(str(src), info, "sdr_bt709") is False


def test_is_normalized_sdr_source_in_hlg_project(tmp_path):
    """SDR clip in HLG project must fail — inverse-stretch needed."""
    src = tmp_path / "sdr.mp4"
    _make_conformant_video(src)
    info = probe_video(str(src))
    assert info is not None
    assert is_normalized(str(src), info, "hdr_hlg") is False


def test_is_normalized_pq_source_in_hlg_project(tmp_path):
    """PQ clip in HLG project must fail — HDR cross-conversion needed."""
    src = tmp_path / "pq.mp4"
    _make_hdr_like_video(src, transfer="smpte2084")
    info = probe_video(str(src))
    assert info is not None
    # Same pix_fmt (yuv420p10le) but different transfer (smpte2084 vs arib-std-b67).
    assert is_normalized(str(src), info, "hdr_hlg") is False


def test_is_normalized_pq_source_in_pq_project(tmp_path):
    """PQ clip in PQ project must pass — no transcode."""
    src = tmp_path / "pq.mp4"
    _make_hdr_like_video(src, transfer="smpte2084")
    info = probe_video(str(src))
    assert info is not None
    assert is_normalized(str(src), info, "hdr_pq") is True


def test_is_normalized_audio_rate_no_longer_checked(tmp_path):
    """Conformant SDR video with 44.1kHz audio is_normalized==True under the
    new contract (audio resampled at compose time)."""
    src = tmp_path / "sdr_44k.mp4"
    _make_conformant_video(src, sample_rate=44100)
    info = probe_video(str(src))
    assert info is not None
    # Was False under the old contract (audio rate checked); now True.
    assert is_normalized(str(src), info, "sdr_bt709") is True


def test_is_normalized_ignores_resolution(tmp_path):
    """Resolution is preserved through the pipeline — not checked here."""
    src = tmp_path / "4k.mp4"
    _make_conformant_video(src, width=3840, height=2160)
    info = probe_video(str(src))
    assert info is not None
    assert is_normalized(str(src), info, "sdr_bt709") is True


# ── rotation / display dimensions ─────────────────────────────────────────────
# Note: ffmpeg 8.x doesn't write displaymatrix side_data when encoding fresh
# clips from lavfi sources (`-metadata:s:v:0 rotate=...` silently no-ops on the
# write path; `-display_rotation` is input-only). Real iPhone vertical clips
# carry the metadata because the iPhone writes it directly. To test the
# rotation-aware logic without depending on a real iPhone fixture, we
# monkeypatch _probe_rotation to return the value we want and assert the swap
# behavior in probe_video. This is more robust than fighting the ffmpeg muxer.


def test_probe_video_reports_rotation_zero_when_unrotated(tmp_path):
    """Plain SDR clip → rotation=0, display dims = stored dims."""
    src = tmp_path / "plain.mp4"
    _make_conformant_video(src, width=1920, height=1080)
    info = probe_video(str(src))
    assert info is not None
    assert info["rotation"] == 0
    assert info["width"] == 1920
    assert info["height"] == 1080
    assert info["display_width"] == 1920
    assert info["display_height"] == 1080


def test_probe_video_swaps_dims_for_rotation_minus_90(tmp_path, monkeypatch):
    """Stored 1920×1080 + rotation=-90 → display 1080×1920 (iPhone vertical case).

    Monkeypatches _probe_rotation since synthetic ffmpeg fixtures can't carry
    displaymatrix side_data through the write path; the swap logic itself is
    the load-bearing code under test, and probe_rotation is exercised separately
    against the real iPhone clips listed in test_init's smart-detect tests.
    """
    src = tmp_path / "vert.mp4"
    _make_conformant_video(src, width=1920, height=1080)
    import lib.normalize as nm
    monkeypatch.setattr(nm, "_probe_rotation", lambda _path: -90)
    info = probe_video(str(src))
    assert info is not None
    assert info["rotation"] == -90
    assert info["width"] == 1920
    assert info["height"] == 1080
    assert info["display_width"] == 1080
    assert info["display_height"] == 1920


def test_probe_video_swaps_dims_for_rotation_plus_270(tmp_path, monkeypatch):
    """+270 also swaps (mod 180 = 90)."""
    src = tmp_path / "rot270.mp4"
    _make_conformant_video(src, width=1920, height=1080)
    import lib.normalize as nm
    monkeypatch.setattr(nm, "_probe_rotation", lambda _path: 270)
    info = probe_video(str(src))
    assert info is not None
    assert info["display_width"] == 1080
    assert info["display_height"] == 1920


def test_probe_video_does_not_swap_for_rotation_180(tmp_path, monkeypatch):
    """180° rotation does NOT swap W/H — only ±90/±270 do."""
    src = tmp_path / "rot180.mp4"
    _make_conformant_video(src, width=1920, height=1080)
    import lib.normalize as nm
    monkeypatch.setattr(nm, "_probe_rotation", lambda _path: 180)
    info = probe_video(str(src))
    assert info is not None
    assert info["rotation"] == 180
    assert info["display_width"] == 1920
    assert info["display_height"] == 1080


# ── normalize() emits the project's working format ────────────────────────────

def test_normalize_skips_when_already_conformant(tmp_path):
    """SDR conformant clip in SDR project → normalize returns input path unchanged."""
    src = tmp_path / "sdr.mp4"
    out = tmp_path / "out.mp4"
    _make_conformant_video(src)
    result = normalize(str(src), str(out), "sdr_bt709")
    # Returns the input path; output file does not get created.
    assert result == str(src)
    assert not out.exists()


def test_normalize_hlg_to_sdr_uses_tonemap(tmp_path):
    """Normalize HLG → SDR runs the zscale tonemap chain; output is yuv420p bt709."""
    src = tmp_path / "hlg.mp4"
    out = tmp_path / "out.mp4"
    _make_hdr_like_video(src, transfer="arib-std-b67")
    normalize(str(src), str(out), "sdr_bt709")
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    assert v.get("pix_fmt") == "yuv420p"
    assert v.get("color_transfer") not in ("smpte2084", "arib-std-b67"), \
        f"output is still HDR-tagged: {v.get('color_transfer')!r}"


def test_normalize_sdr_to_sdr_pix_fmt_only(tmp_path):
    """Normalize SDR yuv422p → SDR project: pix_fmt conversion only, no color filter."""
    src = tmp_path / "sdr422.mp4"
    out = tmp_path / "out.mp4"
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=red:size=1280x720:rate=30:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv422p",
        "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-ar", "48000",
        str(src),
    ], check=True, capture_output=True, timeout=60)
    normalize(str(src), str(out), "sdr_bt709")
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    assert v.get("pix_fmt") == "yuv420p"


def test_normalize_emits_libx265_for_hdr_project(tmp_path):
    """When project_color_space is HDR HLG, normalize emits HEVC + yuv420p10le."""
    src = tmp_path / "sdr.mp4"
    out = tmp_path / "out.mp4"
    _make_conformant_video(src)
    normalize(str(src), str(out), "hdr_hlg")
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    assert v.get("codec_name") == "hevc"
    assert v.get("pix_fmt") == "yuv420p10le"
    # arib-std-b67 is HLG transfer
    assert v.get("color_transfer") == "arib-std-b67"


def test_normalize_preserves_source_resolution(tmp_path):
    """Source resolution must be preserved through normalize()."""
    src = tmp_path / "src4k.mp4"
    out = tmp_path / "out4k.mp4"
    # Use yuv422p to force a re-encode (yuv422p ≠ yuv420p)
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=red:size=3840x2160:rate=30:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv422p",
        "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-ar", "48000",
        str(src),
    ], check=True, capture_output=True, timeout=60)
    normalize(str(src), str(out), "sdr_bt709")
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    assert v.get("width") == 3840
    assert v.get("height") == 2160
    assert v.get("pix_fmt") == "yuv420p"


# ── atomic write: a failed/interrupted encode never poisons the cache path ─────
#
# Regression for the corrupt `*_normalized_<cs>.mp4` cache that crashed renders
# with "Invalid NAL unit size" / "missing picture in access unit": a killed or
# concurrent ffmpeg run used to write its bytes straight to the final cache path,
# leaving a half-written file that downstream consumers trusted. normalize() now
# writes to a per-pid temp and os.replace()s it onto the cache only on success.
# These exercise the helper directly (no ffmpeg needed) so they're fast and
# deterministic.

class _FakeCompleted:
    def __init__(self, returncode, stderr=""):
        self.returncode = returncode
        self.stderr = stderr


def test_run_atomic_encode_success_replaces(tmp_path, monkeypatch):
    out = tmp_path / "cache.mp4"
    tmp = _tmp_for(str(out))

    def fake_run(cmd, **kw):
        with open(tmp, "w") as f:
            f.write("good-bytes")
        return _FakeCompleted(0)

    monkeypatch.setattr(nm.subprocess, "run", fake_run)
    _run_atomic_encode(["ffmpeg"], tmp, str(out), label="x")
    assert out.read_text() == "good-bytes"
    assert not list(tmp_path.glob("*.tmp.*"))  # temp cleaned up


def test_run_atomic_encode_failure_leaves_no_cache(tmp_path, monkeypatch):
    """ffmpeg exits non-zero after writing a partial file → cache path stays absent."""
    out = tmp_path / "cache.mp4"
    tmp = _tmp_for(str(out))

    def fake_run(cmd, **kw):
        with open(tmp, "w") as f:
            f.write("half-written-garbage")  # the corruption we used to ship
        return _FakeCompleted(1, "ffmpeg boom")

    monkeypatch.setattr(nm.subprocess, "run", fake_run)
    with pytest.raises(SystemExit):
        _run_atomic_encode(["ffmpeg"], tmp, str(out), label="x")
    assert not out.exists()                   # the cache was never poisoned
    assert not list(tmp_path.glob("*.tmp.*")) # partial temp dropped


def test_run_atomic_encode_failure_preserves_prior_good_cache(tmp_path, monkeypatch):
    """A failed re-encode must not destroy an existing good cache."""
    out = tmp_path / "cache.mp4"
    out.write_text("previous-good")
    tmp = _tmp_for(str(out))

    def fake_run(cmd, **kw):
        with open(tmp, "w") as f:
            f.write("partial")
        return _FakeCompleted(1, "boom")

    monkeypatch.setattr(nm.subprocess, "run", fake_run)
    with pytest.raises(SystemExit):
        _run_atomic_encode(["ffmpeg"], tmp, str(out), label="x")
    assert out.read_text() == "previous-good"
    assert not list(tmp_path.glob("*.tmp.*"))


def test_run_atomic_encode_timeout_leaves_no_cache(tmp_path, monkeypatch):
    """A killed (timed-out) encode leaves only an orphan temp, never the cache file."""
    out = tmp_path / "cache.mp4"
    tmp = _tmp_for(str(out))

    def fake_run(cmd, **kw):
        with open(tmp, "w") as f:
            f.write("partial-on-kill")
        raise subprocess.TimeoutExpired(cmd, 600)

    monkeypatch.setattr(nm.subprocess, "run", fake_run)
    with pytest.raises(subprocess.TimeoutExpired):
        _run_atomic_encode(["ffmpeg"], tmp, str(out), label="x")
    assert not out.exists()
    assert not list(tmp_path.glob("*.tmp.*"))


def test_sweep_stale_temps_reaps_dead_keeps_live_and_own(tmp_path):
    """Sweep reaps temps from dead pids but never our own or a live sibling's."""
    out = tmp_path / "cache.mp4"

    # A definitely-dead pid: spawn `true`, reap it, then reuse its (now-free) pid.
    p = subprocess.Popen(["true"])
    p.wait()
    dead_pid = p.pid

    dead_temp = tmp_path / f"cache.mp4.tmp.{dead_pid}.mp4"
    own_temp = tmp_path / f"cache.mp4.tmp.{os.getpid()}.mp4"
    unparseable = tmp_path / "cache.mp4.tmp.notapid.mp4"
    for f in (dead_temp, own_temp, unparseable):
        f.write_text("x")

    _sweep_stale_temps(str(out))

    assert not dead_temp.exists()    # orphan from a dead encode → reaped
    assert own_temp.exists()         # our own in-progress temp → preserved
    assert unparseable.exists()      # non-pid suffix → left alone
