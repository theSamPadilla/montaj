"""Tests for lib/normalize.py — audio fast path, is_normalized contract,
and source-resolution preservation."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.normalize import (
    _can_use_audio_fast_path,
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
    """Create a video file with conformant codec/pix_fmt/keyframes; audio per args.

    Default produces a fully conformant clip; pass sample_rate=44100 or
    with_audio=False to make ONLY the audio non-conformant.
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
    ]
    if with_audio:
        cmd += ["-c:a", "aac", "-ar", str(sample_rate)]
    cmd += [str(path)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=60)


def _make_hdr_like_video(path: Path, duration=2):
    """Create a yuv422p10 SDR clip with smpte2084 (HDR) color_transfer tag.

    We can't easily generate true HDR via lavfi color sources — we tag with
    -color_trc smpte2084 + use yuv422p10le pix_fmt to trip needs_tonemap and
    get is_normalized()/can_use_audio_fast_path() to treat it as HDR.
    """
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=red:size=640x360:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv422p10le",
        "-color_trc", "smpte2084",
        "-color_primaries", "bt2020",
        "-colorspace", "bt2020nc",
        "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-ar", "48000",
        str(path),
    ], check=True, capture_output=True, timeout=60)


# ── _can_use_audio_fast_path ──────────────────────────────────────────────────

def test_can_use_audio_fast_path_for_44k_audio(tmp_path):
    src = tmp_path / "src.mp4"
    _make_conformant_video(src, sample_rate=44100)
    info = probe_video(str(src))
    assert info is not None
    assert _can_use_audio_fast_path(info) is True


def test_can_use_audio_fast_path_for_silent_video(tmp_path):
    src = tmp_path / "silent.mp4"
    _make_conformant_video(src, with_audio=False)
    info = probe_video(str(src))
    assert info is not None
    assert _can_use_audio_fast_path(info) is True


def test_can_use_audio_fast_path_false_when_already_conformant(tmp_path):
    src = tmp_path / "ok.mp4"
    _make_conformant_video(src, sample_rate=48000)
    info = probe_video(str(src))
    assert info is not None
    # Audio is fine — no fast path needed
    assert _can_use_audio_fast_path(info) is False


def test_can_use_audio_fast_path_false_for_hdr(tmp_path):
    src = tmp_path / "hdr.mp4"
    _make_hdr_like_video(src)
    info = probe_video(str(src))
    assert info is not None
    # HDR must NOT take the fast path — needs full re-encode for tonemap.
    assert _can_use_audio_fast_path(info) is False


# ── audio fast path end-to-end (via normalize()) ──────────────────────────────

def test_audio_fast_path_silent_video(tmp_path):
    """Silent video with conformant codec/keyframes should hit fast path and
    produce 48kHz stereo silent audio."""
    src = tmp_path / "silent.mp4"
    out = tmp_path / "silent_out.mp4"
    _make_conformant_video(src, with_audio=False)
    normalize(str(src), str(out), 1920, 1080)
    assert out.exists()
    a = _ffprobe_stream(out, "a")
    assert a is not None, "fast path must produce an audio stream"
    assert a.get("codec_name") == "aac"
    assert int(a.get("sample_rate", 0)) == 48000


def test_audio_fast_path_44k_audio(tmp_path):
    """Conformant video with 44.1kHz audio should hit fast path: video copied,
    audio re-encoded at 48kHz."""
    src = tmp_path / "src44k.mp4"
    out = tmp_path / "out44k.mp4"
    _make_conformant_video(src, sample_rate=44100)
    normalize(str(src), str(out), 1920, 1080)
    assert out.exists()
    a = _ffprobe_stream(out, "a")
    v = _ffprobe_stream(out, "v")
    assert int(a.get("sample_rate", 0)) == 48000
    assert v.get("codec_name") == "h264"


def test_audio_fast_path_not_taken_for_hdr(tmp_path):
    """HDR source must go through full re-encode, NOT the fast path."""
    src = tmp_path / "hdr.mp4"
    out = tmp_path / "hdr_out.mp4"
    _make_hdr_like_video(src)
    normalize(str(src), str(out), 1920, 1080)
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    # Full re-encode tonemaps to bt709/yuv420p — the fast path would have left
    # smpte2084 / yuv422p10le untouched (-c:v copy). pix_fmt is the load-bearing
    # signal: HDR sources are 10-bit (yuv422p10le / yuv420p10le); a yuv420p
    # output proves the full re-encode ran.
    assert v.get("pix_fmt") == "yuv420p"
    assert v.get("color_transfer") not in ("smpte2084", "arib-std-b67"), \
        f"output is still HDR-tagged: {v.get('color_transfer')!r}"


def test_audio_fast_path_falls_through_on_failure(tmp_path, monkeypatch):
    """If the fast-path subprocess fails, normalize falls through to full
    re-encode and still produces a conformant output."""
    src = tmp_path / "src.mp4"
    out = tmp_path / "out.mp4"
    _make_conformant_video(src, sample_rate=44100)

    import lib.normalize as nm
    real_run = subprocess.run
    # Count ffmpeg invocations specifically — probe_video() calls ffprobe before
    # any ffmpeg invocation, so a generic "first call" counter would never gate
    # the right call. We need to trip ONLY the first ffmpeg call (the fast path)
    # and let probe ffprobe calls + the subsequent full-re-encode ffmpeg run.
    ffmpeg_calls = {"n": 0}

    def fake_run(cmd, *a, **kw):
        if cmd and cmd[0] == "ffmpeg":
            ffmpeg_calls["n"] += 1
            if ffmpeg_calls["n"] == 1:
                # Fail the first ffmpeg call (the audio fast path). Build a real
                # CompletedProcess via a no-op shell call so the structure is
                # right, then mutate returncode + stderr.
                r = real_run(["ffmpeg", "-version"], capture_output=True, text=True)
                r.returncode = 1
                r.stderr = "fake fast path failure"
                return r
        return real_run(cmd, *a, **kw)

    monkeypatch.setattr(nm.subprocess, "run", fake_run)
    nm.normalize(str(src), str(out), 1920, 1080)
    assert out.exists()
    # Confirm the test actually exercised fall-through: at least 2 ffmpeg calls
    # (failed fast path + successful full re-encode). If only 1, the fast path
    # succeeded — meaning the failure injection didn't gate the right call.
    assert ffmpeg_calls["n"] >= 2, \
        f"expected fall-through (≥2 ffmpeg calls), got {ffmpeg_calls['n']}"
    # Full re-encode: audio must be 48kHz
    a = _ffprobe_stream(out, "a")
    assert int(a.get("sample_rate", 0)) == 48000


# ── is_normalized() resolution-agnostic contract ──────────────────────────────

def test_is_normalized_ignores_resolution_mismatch(tmp_path):
    """A 4K conformant clip should be is_normalized==True even when target is
    1080p — resolution is no longer checked."""
    src = tmp_path / "4k.mp4"
    _make_conformant_video(src, width=3840, height=2160, sample_rate=48000)
    info = probe_video(str(src))
    assert info is not None
    assert is_normalized(str(src), info, target_w=1920, target_h=1080,
                         force_probe=True) is True


def test_is_normalized_force_probe_bypasses_suffix_shortcut(tmp_path):
    """force_probe=True must inspect actual stream, not trust filename."""
    # Non-conformant content but with the magic suffix.
    src = tmp_path / "fake_normalized.mp4"
    _make_conformant_video(src, sample_rate=44100)  # 44.1kHz → non-conformant audio
    info = probe_video(str(src))
    assert info is not None
    # Without force_probe: trusts suffix → True
    assert is_normalized(str(src), info) is True
    # With force_probe: actually checks → False (audio sample rate is wrong)
    assert is_normalized(str(src), info, force_probe=True) is False


def test_normalize_preserves_4k_source_resolution(tmp_path):
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
    normalize(str(src), str(out), 1920, 1080)  # target ignored
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    assert v.get("width") == 3840
    assert v.get("height") == 2160
    assert v.get("pix_fmt") == "yuv420p"


def test_audio_fast_path_works_at_any_resolution(tmp_path):
    """Confirms the fast path is resolution-agnostic — a 4K source with 44.1kHz
    audio should hit the fast path and stay 4K. (Task 3: resolution preservation.)"""
    src = tmp_path / "src4k_44k.mp4"
    out = tmp_path / "out4k_44k.mp4"
    _make_conformant_video(src, width=3840, height=2160, sample_rate=44100)
    normalize(str(src), str(out), 1920, 1080)  # target ignored
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    a = _ffprobe_stream(out, "a")
    assert v.get("width") == 3840
    assert v.get("height") == 2160
    assert int(a.get("sample_rate", 0)) == 48000
