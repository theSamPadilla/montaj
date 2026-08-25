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
    _build_tonemap_vf_to_sdr,
    _run_atomic_encode,
    _sweep_stale_temps,
    _tmp_for,
    is_normalized,
    normalize,
    probe_video,
)
from lib.look import lut_path

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


# ── Vivid LUT tonemap chain (SP6b decision 8) ──────────────────────────────────
#
# The production chain is verbatim per decision 8a: `zscale=matrixin=2020_ncl:
# rangein=limited:range=full,format=rgb48le,lut3d=file=<cube>:interp=tetrahedral`.
# The `format=rgb48le` pin BEFORE `lut3d` is load-bearing — without it ffmpeg
# feeds 8-bit into the LUT and quantizes. These tests assert the built filter
# string directly (no ffmpeg run needed) so they're fast and deterministic;
# see the `slow`-marked functional tests below for an end-to-end ffprobe check.

def test_tonemap_hlg_arm_pins_rgb48le_before_lut3d(monkeypatch):
    """Decision-8a regression: format=rgb48le must land before lut3d."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    vf, used_fallback = _build_tonemap_vf_to_sdr("hdr_hlg")
    assert used_fallback is False
    assert vf.index("format=rgb48le") < vf.index("lut3d=")


def test_tonemap_hlg_arm_uses_tetrahedral_interp(monkeypatch):
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    vf, _ = _build_tonemap_vf_to_sdr("hdr_hlg")
    assert "interp=tetrahedral" in vf


def test_tonemap_hlg_arm_uses_manifest_default_lut(monkeypatch):
    """The LUT file referenced is the manifest's default cube via lib/look.py."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    vf, _ = _build_tonemap_vf_to_sdr("hdr_hlg")
    assert f"lut3d=file={lut_path()}:interp=tetrahedral" in vf


def test_tonemap_hlg_arm_has_no_pq_prestep(monkeypatch):
    """HLG is the LUT's native input — no PQ→HLG pre-step should be added."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    vf, _ = _build_tonemap_vf_to_sdr("hdr_hlg")
    assert "smpte2084" not in vf
    assert not vf.startswith("zscale=tin=")


def test_tonemap_pq_arm_prepends_pq_to_hlg_prestep(monkeypatch):
    """PQ sources need a PQ→HLG pre-step (at the LUT's design white of 1000 nit)
    before the shared LUT chain — the LUT itself is graded for HLG input."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    vf, used_fallback = _build_tonemap_vf_to_sdr("hdr_pq")
    assert used_fallback is False
    assert vf.startswith("zscale=tin=smpte2084:t=arib-std-b67:npl=1000,")
    assert vf.index("tin=smpte2084") < vf.index("lut3d=")


def test_tonemap_yuv709_tag_appended_after_lut(monkeypatch):
    """After the LUT the pixels are full-range RGB; the trailing zscale tags
    them back to limited-range Rec.709 YUV for the encoder.

    t=/m=/p= must all be explicit here (not just r=/rin=): zscale only
    overrides an axis it's given, and an omitted axis passes the frame's
    existing tag through — which then wins over the blanket
    -color_trc/-color_primaries/-colorspace output flags. Regression for a
    real bug caught by the ffprobe functional tests below: without t=/p=
    here, HDR→SDR outputs kept reporting the source's HDR transfer/primaries."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    vf, _ = _build_tonemap_vf_to_sdr("hdr_hlg")
    assert vf.endswith(
        "zscale=tin=bt709:t=bt709:pin=bt709:p=bt709:m=bt709:rin=full:r=tv"
    )
    assert vf.index("lut3d=") < vf.rindex("zscale=tin=bt709")


def test_tonemap_trailing_zscale_pins_its_input_as_bt709(monkeypatch):
    """The trailing zscale must RETAG, never re-convert.

    zscale converts to the axes it is given, starting from whatever the frame
    is tagged. Post-LUT frames still carry the source's HDR tags, so a bare
    `t=bt709:p=bt709` re-ran HLG→709 and BT.2020→709 over already-tone-mapped
    pixels: highlights clipped per channel and hue shifted (warm wall → pure
    yellow, window → cyan). Every vivid1 proxy and every derived SDR export
    shipped that way until it was caught by eye in the editor.

    `tin=`/`pin=` declare the post-LUT truth, collapsing both conversions to
    no-ops. This is a string-level guard; the pixel-level one lives in
    tests/test_vivid_acceptance.py."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    for src in ("hdr_hlg", "hdr_pq"):
        vf, _ = _build_tonemap_vf_to_sdr(src)
        tail = vf[vf.rindex("zscale="):]
        assert "tin=bt709" in tail, f"{src}: trailing zscale must pin tin=bt709"
        assert "pin=bt709" in tail, f"{src}: trailing zscale must pin pin=bt709"


def test_tonemap_fallback_when_zscale_missing(monkeypatch):
    """No zscale → today's bare Hable tonemap fallback, loudly warned by callers."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: False)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    vf, used_fallback = _build_tonemap_vf_to_sdr("hdr_hlg")
    assert used_fallback is True
    assert vf == "format=p010le,tonemap=hable:desat=0"


def test_tonemap_fallback_when_lut3d_missing(monkeypatch):
    """zscale present but no lut3d → same fallback (can't run the LUT chain)."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: False)
    vf, used_fallback = _build_tonemap_vf_to_sdr("hdr_hlg")
    assert used_fallback is True
    assert vf == "format=p010le,tonemap=hable:desat=0"


def test_tonemap_fallback_pq_arm_same_as_hlg(monkeypatch):
    """Fallback path doesn't distinguish HLG/PQ — both degrade the same way."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: False)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: False)
    vf, used_fallback = _build_tonemap_vf_to_sdr("hdr_pq")
    assert used_fallback is True
    assert vf == "format=p010le,tonemap=hable:desat=0"


def test_has_zscale_is_memoized(monkeypatch):
    """_has_zscale must not re-spawn ffmpeg on every call."""
    calls = []
    real_run = subprocess.run

    def counting_run(cmd, **kw):
        calls.append(cmd)
        return real_run(cmd, **kw)

    monkeypatch.setattr(nm.subprocess, "run", counting_run)
    nm._has_zscale.cache_clear()
    nm._has_zscale()
    nm._has_zscale()
    nm._has_zscale()
    assert len(calls) == 1
    nm._has_zscale.cache_clear()


def test_has_lut3d_is_memoized(monkeypatch):
    """_has_lut3d must not re-spawn ffmpeg on every call."""
    calls = []
    real_run = subprocess.run

    def counting_run(cmd, **kw):
        calls.append(cmd)
        return real_run(cmd, **kw)

    monkeypatch.setattr(nm.subprocess, "run", counting_run)
    nm._has_lut3d.cache_clear()
    nm._has_lut3d()
    nm._has_lut3d()
    assert len(calls) == 1
    nm._has_lut3d.cache_clear()


# ── Denoise pairing with the master tonemap arm (SP6b decision 8b) ────────────
#
# The Vivid curve brightens midtones, which measurably amplifies iPhone shadow
# noise. Master creation (HDR→SDR normalize) pairs the curve with a light
# source-domain denoise (hqdn3d=1.5:1.5:3:3), prepended ahead of the conversion
# chain so it runs before the curve amplifies. It must NOT appear in: the hable
# fallback arm (degraded-capability path, no curve to amplify), proxy encodes
# (proxies inherit the master's pixels or tone-map separately at proxy quality),
# or SDR-source conformance runs (no curve → no amplification → no denoise).

def _minimal_info(color_transfer, *, codec="hevc", pix_fmt="yuv420p10le", has_audio=True):
    """Bare info dict shape _build_ffmpeg_cmd needs — no real probe required
    for these filter-string-assembly tests."""
    return {
        "codec": codec,
        "pix_fmt": pix_fmt,
        "color_transfer": color_transfer,
        "fps": 30,
        "has_audio": has_audio,
    }


def _vf_from_cmd(cmd):
    return cmd[cmd.index("-vf") + 1]


def test_denoise_prepended_in_master_hdr_to_sdr_tonemap_arm(monkeypatch):
    """Real LUT chain (not the fallback): hqdn3d lands source-domain, BEFORE
    the tonemap/LUT chain in the -vf assembly."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    info = _minimal_info("arib-std-b67")
    cmd, used_fallback = nm._build_ffmpeg_cmd("in.mp4", "out.mp4", "sdr_bt709", info)
    assert used_fallback is False
    vf = _vf_from_cmd(cmd)
    assert nm.HDR_TO_SDR_DENOISE_VF in vf
    assert vf.index(nm.HDR_TO_SDR_DENOISE_VF) < vf.index("zscale=")


def test_denoise_prepended_for_pq_source_too(monkeypatch):
    """PQ→SDR also goes through the master tonemap arm — same denoise pairing."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    info = _minimal_info("smpte2084")
    cmd, used_fallback = nm._build_ffmpeg_cmd("in.mp4", "out.mp4", "sdr_bt709", info)
    assert used_fallback is False
    vf = _vf_from_cmd(cmd)
    assert nm.HDR_TO_SDR_DENOISE_VF in vf
    assert vf.index(nm.HDR_TO_SDR_DENOISE_VF) < vf.index("zscale=")


def test_denoise_absent_from_fallback_hable_arm(monkeypatch):
    """No zscale/lut3d → hable fallback. Decision 8b: the fallback has no
    curve of its own to amplify — it stays exactly as today, no denoise."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: False)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: False)
    info = _minimal_info("arib-std-b67")
    cmd, used_fallback = nm._build_ffmpeg_cmd("in.mp4", "out.mp4", "sdr_bt709", info)
    assert used_fallback is True
    vf = _vf_from_cmd(cmd)
    assert "hqdn3d" not in vf


def test_denoise_absent_from_sdr_source_conformance_run(monkeypatch):
    """SDR source into an SDR project needing only a pix_fmt fix: no color
    conversion filter at all, so no curve and no denoise."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    info = _minimal_info("bt709", codec="h264", pix_fmt="yuv422p")
    cmd, used_fallback = nm._build_ffmpeg_cmd("in.mp4", "out.mp4", "sdr_bt709", info)
    assert used_fallback is False
    vf = _vf_from_cmd(cmd)
    assert "hqdn3d" not in vf


def test_denoise_absent_from_sdr_to_hdr_stretch(monkeypatch):
    """SDR → HDR stretch (no creative curve involved) must not get the denoise."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    info = _minimal_info("bt709", codec="h264", pix_fmt="yuv420p")
    cmd, used_fallback = nm._build_ffmpeg_cmd("in.mp4", "out.mp4", "hdr_hlg", info)
    assert used_fallback is False
    vf = _vf_from_cmd(cmd)
    assert "hqdn3d" not in vf


def test_denoise_absent_from_hdr_cross_conversion(monkeypatch):
    """HLG <-> PQ cross-conversion (no curve involved) must not get the denoise."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    info = _minimal_info("smpte2084")
    cmd, used_fallback = nm._build_ffmpeg_cmd("in.mp4", "out.mp4", "hdr_hlg", info)
    assert used_fallback is False
    vf = _vf_from_cmd(cmd)
    assert "hqdn3d" not in vf


def test_denoise_absent_from_proxy_cmd(monkeypatch):
    """Proxy encodes must never inherit the master's denoise — they inherit
    the master's already-denoised pixels (eager) or tone-map separately at
    proxy quality (lazy), neither of which pairs with hqdn3d. Imports and
    calls lib.proxy._build_proxy_cmd directly; proxy source/tests untouched."""
    import lib.proxy as proxy

    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    info = _minimal_info("arib-std-b67")
    cmd, used_fallback = proxy._build_proxy_cmd("in.mp4", "out.mp4", tonemap=True, info=info)
    assert used_fallback is False
    vf = _vf_from_cmd(cmd)
    assert "hqdn3d" not in vf


# ── Functional: real ffmpeg encode reports color_transfer=bt709 ───────────────
#
# Slow (spawns real ffmpeg HDR encodes + the LUT pass) and gated on the managed
# ffmpeg actually shipping zscale + lut3d, per doctor's REQUIRED_FFMPEG_FILTERS.
# Skipped by default; run explicitly with `pytest tests/test_normalize.py -m slow`.

def _ffmpeg_has_filters(*names) -> bool:
    """Checks the SAME ffmpeg binary normalize() will actually invoke
    (nm.ffmpeg_bin() — managed static build when present, else bare PATH)."""
    r = subprocess.run([nm.ffmpeg_bin(), "-filters"], capture_output=True, text=True, timeout=5)
    out = r.stdout or ""
    return all(name in out for name in names)


@pytest.mark.slow
def test_normalize_hlg_lut_chain_reports_bt709_transfer(tmp_path):
    """Synthetic HLG source through normalize() → ffprobe reports color_transfer
    bt709 on the output (the LUT chain's trailing zscale RGB→YUV709 tag)."""
    if not _ffmpeg_has_filters("zscale", "lut3d"):
        pytest.skip("managed ffmpeg missing zscale/lut3d")
    src = tmp_path / "hlg.mp4"
    out = tmp_path / "out.mp4"
    _make_hdr_like_video(src, transfer="arib-std-b67")
    normalize(str(src), str(out), "sdr_bt709")
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    print(f"HLG→SDR output color_transfer: {v.get('color_transfer')!r}")
    assert v.get("color_transfer") == "bt709"


@pytest.mark.slow
def test_normalize_pq_lut_chain_reports_bt709_transfer(tmp_path):
    """Synthetic PQ source through normalize() → PQ→HLG pre-step + shared LUT
    chain → ffprobe reports color_transfer bt709 on the output."""
    if not _ffmpeg_has_filters("zscale", "lut3d"):
        pytest.skip("managed ffmpeg missing zscale/lut3d")
    src = tmp_path / "pq.mp4"
    out = tmp_path / "out.mp4"
    _make_hdr_like_video(src, transfer="smpte2084")
    normalize(str(src), str(out), "sdr_bt709")
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    print(f"PQ→SDR output color_transfer: {v.get('color_transfer')!r}")
    assert v.get("color_transfer") == "bt709"


@pytest.mark.slow
def test_normalize_hdr_to_sdr_denoise_reduces_flat_patch_variance(tmp_path):
    """Decision 8b functional check: hqdn3d measurably reduces noise carried
    into the master tonemap arm. Fixture is a flat gray HLG source with
    synthetic per-frame grain (ffmpeg `noise` filter, temporal) — a center
    patch should read uniform gray but for the injected noise, so per-pixel
    variance across frames in that patch is a direct proxy for noise level.

    Normalizes the fixture twice: once through the real code path (denoise
    applied), once with HDR_TO_SDR_DENOISE_VF monkeypatched to "" — the
    least-invasive bypass that drops just the denoise filter from the -vf
    chain while exercising the exact same LUT/encode path otherwise (see
    _build_ffmpeg_cmd's truthiness guard, added for this purpose). Asserts
    the denoised output's variance is at least 20% below the un-denoised
    output's, and prints both numbers.
    """
    if not _ffmpeg_has_filters("zscale", "lut3d"):
        pytest.skip("managed ffmpeg missing zscale/lut3d")
    import numpy as np

    src = tmp_path / "hlg_noisy.mp4"
    subprocess.run([
        nm.ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", "color=gray:size=640x360:rate=30:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        # Light per-frame (temporal) grain over a flat field — stands in for
        # iPhone shadow noise without depending on a real HDR camera fixture.
        "-vf", "noise=alls=4:allf=t",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p10le",
        "-x265-params", "transfer=arib-std-b67:colorprim=bt2020:colormatrix=bt2020nc",
        "-color_trc", "arib-std-b67", "-color_primaries", "bt2020", "-colorspace", "bt2020nc",
        "-g", "30", "-keyint_min", "30", "-c:a", "aac", "-ar", "48000",
        str(src),
    ], check=True, capture_output=True, timeout=60)

    out_denoised = tmp_path / "out_denoised.mp4"
    out_raw = tmp_path / "out_raw.mp4"

    normalize(str(src), str(out_denoised), "sdr_bt709")

    orig_denoise_vf = nm.HDR_TO_SDR_DENOISE_VF
    nm.HDR_TO_SDR_DENOISE_VF = ""
    try:
        normalize(str(src), str(out_raw), "sdr_bt709")
    finally:
        nm.HDR_TO_SDR_DENOISE_VF = orig_denoise_vf

    def flat_patch_variance(path, *, w=640, h=360, patch=100):
        """Mean per-pixel variance across frames, over a centered patch."""
        x0, y0 = (w - patch) // 2, (h - patch) // 2
        cmd = [
            nm.ffmpeg_bin(), "-y", "-i", str(path),
            "-vf", f"crop={patch}:{patch}:{x0}:{y0},format=gray",
            "-f", "rawvideo", "-",
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=30)
        data = np.frombuffer(r.stdout, dtype=np.uint8).astype(np.float64)
        nframes = len(data) // (patch * patch)
        data = data[: nframes * patch * patch].reshape(nframes, patch * patch)
        return float(np.mean(np.var(data, axis=0)))

    var_denoised = flat_patch_variance(out_denoised)
    var_raw = flat_patch_variance(out_raw)
    reduction_pct = (1 - var_denoised / var_raw) * 100
    print(f"flat-patch variance: raw={var_raw:.4f} denoised={var_denoised:.4f} reduction={reduction_pct:.1f}%")
    assert var_denoised < var_raw * 0.8, (
        f"expected >=20% variance reduction from hqdn3d; got {reduction_pct:.1f}% "
        f"(raw={var_raw:.4f}, denoised={var_denoised:.4f})"
    )


# ── silent-source anullsrc placement (pre-existing bug, fixed post-SP6b) ─────

def test_silent_source_anullsrc_is_an_input_not_an_output_option(monkeypatch):
    """has_audio=False: the anullsrc INPUT must sit with the inputs (right
    after the primary -i), never after output-side options like -vf — ffmpeg
    binds options positionally and rejects `-vf` applied to a lavfi input
    ("Option vf ... cannot be applied to input url anullsrc")."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    info = _minimal_info("arib-std-b67", has_audio=False)
    cmd, _ = nm._build_ffmpeg_cmd("in.mp4", "out.mp4", "sdr_bt709", info)

    i_primary = cmd.index("-i")
    assert cmd[i_primary + 1] == "in.mp4"
    i_lavfi = cmd.index("anullsrc=cl=stereo:r=48000")
    assert cmd[i_lavfi - 1] == "-i" and cmd[i_lavfi - 2] == "lavfi"
    # The lavfi input is declared BEFORE any output option.
    assert i_lavfi < cmd.index("-vf")
    # Output side keeps -shortest (caps the infinite anullsrc) + audio encode.
    assert "-shortest" in cmd and cmd.index("-shortest") > cmd.index("-vf")
    assert "-c:a" in cmd and cmd[cmd.index("-c:a") + 1] == "aac"


@pytest.mark.slow
def test_normalize_silent_hdr_source_succeeds_with_silent_audio_track(tmp_path):
    """A video-only (no audio stream) HLG source normalizes successfully and
    the output carries the contract's conformant AAC track (from anullsrc).
    This exact input made normalize() fail outright before the fix."""
    if not _ffmpeg_has_filters("zscale", "lut3d"):
        pytest.skip("managed ffmpeg missing zscale/lut3d")
    src = tmp_path / "silent_hlg.mp4"
    out = tmp_path / "out.mp4"
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=red:size=640x360:rate=30:duration=2",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p10le",
        "-x265-params", "transfer=arib-std-b67:colorprim=bt2020:colormatrix=bt2020nc",
        "-color_trc", "arib-std-b67",
        "-color_primaries", "bt2020",
        "-colorspace", "bt2020nc",
        "-an",
        str(src),
    ], check=True, capture_output=True, timeout=60)
    assert _ffprobe_stream(src, "a") is None  # genuinely silent fixture

    normalize(str(src), str(out), "sdr_bt709")
    assert out.exists()
    v = _ffprobe_stream(out, "v")
    assert v.get("color_transfer") == "bt709"
    a = _ffprobe_stream(out, "a")
    assert a is not None and a.get("codec_name") == "aac"
