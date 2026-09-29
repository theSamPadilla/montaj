"""Tests for lib/ingest.py — post-init single-clip ingest.

ingest_source() reproduces init's per-clip pipeline (stage -> probe ->
normalize -> proxy) for one new source, returning a clip dict identical in
shape to what `montaj init` writes (plus source dimensions).

Heavy encodes are exercised only where the decision under test needs a real
result (the SDR passthrough classification). The tonemap-decision and
proxy-flag tests monkeypatch normalize()/make_proxy() to assert the DECISION
(what they're called with), never the pixels — keeping them fast and
deterministic.
"""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

import lib.color_provenance as cp
import lib.ingest as ing
from lib.ingest import ingest_source
from lib.normalize import normalized_output_path
from lib.proxy import proxy_path_for

from tests.conftest import HAS_FFMPEG  # the ffmpeg the code runs (PV52)


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_conformant_sdr(path: Path, *, width=640, height=360, duration=2):
    """A conformant SDR clip: yuv420p, bt709-tagged, dense keyframes (GOP 30).

    The h264_metadata bitstream filter forces bt709 transfer tags into the
    stream (lavfi color sources otherwise read back as color_transfer=unknown);
    -g/-keyint_min 30 keeps the keyframe interval under is_normalized()'s 2.0s
    ceiling. Mirrors tests/test_normalize.py's fixture.
    """
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=red:size={width}x{height}:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-bsf:v", "h264_metadata=transfer_characteristics=1:colour_primaries=1:matrix_coefficients=1",
        "-c:a", "aac", "-ar", "48000",
        str(path),
    ], check=True, capture_output=True, timeout=60)


def _hdr_info(transfer="arib-std-b67"):
    """Minimal probe_video()-shaped dict for an HDR source (not is_normalized
    for sdr_bt709: HDR transfer + 10-bit pix_fmt both mismatch)."""
    return {
        "codec": "hevc",
        "width": 3840,
        "height": 2160,
        "pix_fmt": "yuv420p10le",
        "color_transfer": transfer,
        "fps": 30,
        "r_frame_rate": "30/1",
        "has_audio": True,
        "audio_sample_rate": 48000,
        "max_keyframe_interval": 1.0,
        "rotation": 0,
        "display_width": 3840,
        "display_height": 2160,
    }


def _sdr_conformant_info():
    """Minimal probe dict that is_normalized() accepts for sdr_bt709."""
    return {
        "codec": "h264",
        "width": 1920,
        "height": 1080,
        "pix_fmt": "yuv420p",
        "color_transfer": "bt709",
        "fps": 30,
        "r_frame_rate": "30/1",
        "has_audio": True,
        "audio_sample_rate": 48000,
        "max_keyframe_interval": 1.0,
        "rotation": 0,
        "display_width": 1920,
        "display_height": 1080,
    }


def _provenance_probes(monkeypatch, *, default, by_path=None):
    """Make lib.color_provenance (the proxy's provenance resolver) probe the
    fake files these tests stage: `by_path` maps a path to its color_transfer,
    anything else probes as `default`. No marker, one fingerprint."""
    by_path = by_path or {}

    def probe(path):
        return cp.Probe(by_path.get(str(path), default), "", 1920, 1080, "30/1", 5.0)

    monkeypatch.setattr(cp, "probe_media", probe)


# ── validation ────────────────────────────────────────────────────────────────

def test_invalid_color_space_raises(tmp_path):
    """An unknown color space fails loudly, before any staging side effect."""
    src = tmp_path / "src.mp4"
    src.write_bytes(b"x")
    proj = tmp_path / "proj"
    proj.mkdir()
    with pytest.raises(ValueError):
        ingest_source(str(proj), str(src), "hdr_xyz")
    assert not list(proj.iterdir())  # nothing staged


# ── SDR passthrough (real ffmpeg) ─────────────────────────────────────────────

@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_sdr_source_into_sdr_project_passthrough(tmp_path):
    """Conformant SDR source into an SDR project: classified skip, no transcode.

    src is the staged copy (unchanged, no *_normalized_* file produced);
    sourceDuration / sourceWidth / sourceHeight are populated; no id key
    (clip_id defaulted to None). proxy=False keeps the test off the av1 encoder.
    """
    srcdir = tmp_path / "incoming"
    srcdir.mkdir()
    src = srcdir / "shot.mp4"
    _make_conformant_sdr(src)

    proj = tmp_path / "proj"
    proj.mkdir()

    clip = ingest_source(str(proj), str(src), "sdr_bt709", proxy=False)

    staged = proj / "shot.mp4"
    assert clip["src"] == str(staged)
    assert staged.exists()
    # No transcode happened: no normalized master alongside the staged copy.
    assert not list(proj.glob("*_normalized_*"))
    assert "id" not in clip
    assert clip["type"] == "video"
    assert clip["start"] == 0.0 and clip["end"] == 0.0
    assert clip["sourceDuration"] > 0
    assert clip["sourceWidth"] == 640
    assert clip["sourceHeight"] == 360
    assert "proxySrc" not in clip  # proxy=False


# ── tonemap DECISION (monkeypatched — assert the call, not the pixels) ─────────

def test_eager_hdr_into_sdr_transcodes_with_tonemapped_master(tmp_path, monkeypatch):
    """HDR source into an sdr_bt709 project (eager): normalize() runs on the
    tonemapped normalized-master path, and the proxy is then built from that
    SDR master (tonemap=False)."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    src = tmp_path / "hdr.mov"
    src.write_bytes(b"fake")
    proj = tmp_path / "proj"
    proj.mkdir()

    info = _hdr_info("arib-std-b67")
    monkeypatch.setattr(ing, "probe_video", lambda _p: info)
    monkeypatch.setattr(ing, "get_duration", lambda _p: 5.0)
    # The master normalize writes is SDR (it was tonemapped), so its proxy is
    # not graded. The stub bytes cannot be probed (PV57: that now raises).
    _provenance_probes(monkeypatch, default="bt709")

    normalize_calls = []

    def fake_normalize(inp, out, cs, info=None):
        normalize_calls.append({"in": inp, "out": out, "cs": cs, "info": info})
        Path(out).write_bytes(b"master")
        return out

    proxy_calls = []

    def fake_make_proxy(src_, out, *, tonemap, info):
        proxy_calls.append({"src": src_, "out": out, "tonemap": tonemap})
        return out

    monkeypatch.setattr(ing, "normalize", fake_normalize)
    monkeypatch.setattr(ing, "make_proxy", fake_make_proxy)

    clip = ingest_source(str(proj), str(src), "sdr_bt709")

    staged = str(proj / "hdr.mov")
    expected_out = normalized_output_path(staged, "sdr_bt709", tonemapped=True)
    assert len(normalize_calls) == 1
    call = normalize_calls[0]
    assert call["in"] == staged
    assert call["out"] == expected_out
    assert call["cs"] == "sdr_bt709"
    assert call["info"] is info
    # The tonemap decision lives in the master path suffix, not on the proxy:
    # the proxy reads the already-SDR master.
    assert expected_out != normalized_output_path(staged, "sdr_bt709", tonemapped=False)
    assert clip["src"] == expected_out
    assert "normalizedSrc" not in clip  # only an SDR-into-HDR conversion is a cache
    assert len(proxy_calls) == 1
    assert proxy_calls[0]["tonemap"] is False
    assert proxy_calls[0]["src"] == expected_out
    assert clip["proxySrc"] == proxy_calls[0]["out"]


def _sdr_into_hdr(tmp_path, monkeypatch, *, fail=False, proxy=False):
    """Eager-ingest an SDR source into an hdr_hlg project with normalize()
    stubbed. Returns (clip, staged, normalize calls, get_duration paths)."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    src = tmp_path / "screen.mp4"
    src.write_bytes(b"fake")
    proj = tmp_path / "proj"
    proj.mkdir()

    monkeypatch.setattr(ing, "probe_video", lambda _p: _sdr_conformant_info())
    durations = []
    monkeypatch.setattr(ing, "get_duration", lambda p: durations.append(p) or 5.0)

    normalize_calls = []

    def fake_normalize(inp, out, cs, info=None):
        normalize_calls.append((inp, out, cs))
        if fail:
            raise SystemExit(1)
        Path(out).write_bytes(b"master")
        return out

    monkeypatch.setattr(ing, "normalize", fake_normalize)
    clip = ingest_source(str(proj), str(src), "hdr_hlg", proxy=proxy)
    return clip, str(proj / "screen.mp4"), normalize_calls, durations


def test_eager_sdr_into_hdr_keeps_src_and_caches_the_conversion(tmp_path, monkeypatch):
    """An SDR source into an HDR project (PV42): `src` stays the staged
    original, and the full-source conversion is its `normalizedSrc` cache."""
    clip, staged, calls, durations = _sdr_into_hdr(tmp_path, monkeypatch)

    expected_out = normalized_output_path(staged, "hdr_hlg", tonemapped=False, sdr_stretch=True)
    assert calls == [(staged, expected_out, "hdr_hlg")]
    assert clip["src"] == staged
    assert clip["normalizedSrc"] == expected_out
    assert clip["normalizedInPoint"] == 0
    assert durations == [staged]


def test_eager_sdr_into_hdr_failed_conversion_records_no_cache(tmp_path, monkeypatch):
    clip, staged, calls, _ = _sdr_into_hdr(tmp_path, monkeypatch, fail=True)

    assert len(calls) == 1
    assert clip["src"] == staged
    assert "normalizedSrc" not in clip
    assert "normalizedInPoint" not in clip


def test_eager_sdr_into_hdr_proxy_comes_from_the_original_ungraded(tmp_path, monkeypatch):
    """PV42: the SDR clip keeps its original as `src`, so the proxy is encoded
    from that original with no grade. The project being HDR is no reason to
    grade it: the grade is for HDR-origin footage only."""
    _provenance_probes(monkeypatch, default="bt709")
    proxy_calls = []

    def fake_make_proxy(src_, out, *, tonemap, info):
        proxy_calls.append((src_, out, tonemap))
        return out

    monkeypatch.setattr(ing, "make_proxy", fake_make_proxy)
    clip, staged, calls, _ = _sdr_into_hdr(tmp_path, monkeypatch, proxy=True)

    assert len(calls) == 1 and clip["src"] == staged and clip["normalizedSrc"]
    assert proxy_calls == [(staged, proxy_path_for(staged), False)]
    assert clip["proxySrc"] == proxy_path_for(staged)


def test_eager_hdr_cross_conversion_proxy_reads_the_masters_own_probe(tmp_path, monkeypatch):
    """An HLG source into an hdr_pq project: the proxy is encoded from the PQ
    master, so the `info` it is built from is the master's probe (the grade's
    PQ pre-step depends on it), not the HLG original's."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    src = tmp_path / "cam.mov"
    src.write_bytes(b"fake")
    proj = tmp_path / "proj"
    proj.mkdir()
    staged = str(proj / "cam.mov")
    master = normalized_output_path(staged, "hdr_pq", tonemapped=False)
    infos = {staged: _hdr_info("arib-std-b67"), master: _hdr_info("smpte2084")}
    monkeypatch.setattr(ing, "probe_video", lambda p: infos[p])
    monkeypatch.setattr(ing, "get_duration", lambda _p: 5.0)
    _provenance_probes(monkeypatch, default="smpte2084", by_path={staged: "arib-std-b67"})

    def fake_normalize(inp, out, cs, info=None):
        Path(out).write_bytes(b"master")
        return out

    proxy_calls = []

    def fake_make_proxy(src_, out, *, tonemap, info):
        proxy_calls.append((src_, tonemap, info["color_transfer"]))
        return out

    monkeypatch.setattr(ing, "normalize", fake_normalize)
    monkeypatch.setattr(ing, "make_proxy", fake_make_proxy)
    clip = ingest_source(str(proj), str(src), "hdr_pq")

    assert clip["src"] == master
    assert proxy_calls == [(master, True, "smpte2084")]


def test_lazy_hdr_into_sdr_proxy_tonemaps_no_transcode(tmp_path, monkeypatch):
    """HDR source into an sdr_bt709 project (lazy): no transcode; the proxy is
    built from the untouched HDR original with tonemap=True."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    src = tmp_path / "hdr.mov"
    src.write_bytes(b"fake")
    proj = tmp_path / "proj"
    proj.mkdir()

    info = _hdr_info("smpte2084")
    monkeypatch.setattr(ing, "probe_video", lambda _p: info)
    monkeypatch.setattr(ing, "get_duration", lambda _p: 5.0)
    _provenance_probes(monkeypatch, default="smpte2084")

    def fail_normalize(*a, **k):
        raise AssertionError("lazy mode must not transcode")

    proxy_calls = []

    def fake_make_proxy(src_, out, *, tonemap, info):
        proxy_calls.append({"src": src_, "out": out, "tonemap": tonemap})
        return out

    monkeypatch.setattr(ing, "normalize", fail_normalize)
    monkeypatch.setattr(ing, "make_proxy", fake_make_proxy)

    clip = ingest_source(str(proj), str(src), "sdr_bt709", "lazy")

    staged = str(proj / "hdr.mov")
    assert clip["src"] == staged  # unchanged — no transcode
    assert len(proxy_calls) == 1
    assert proxy_calls[0]["tonemap"] is True
    assert clip["proxySrc"] == proxy_calls[0]["out"]


# ── proxy flag ────────────────────────────────────────────────────────────────

def test_proxy_false_omits_proxysrc(tmp_path, monkeypatch):
    """proxy=False: make_proxy is never called and no proxySrc key is set."""
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    proj = tmp_path / "proj"
    proj.mkdir()

    monkeypatch.setattr(ing, "probe_video", lambda _p: _sdr_conformant_info())
    monkeypatch.setattr(ing, "get_duration", lambda _p: 3.0)

    def fail_make_proxy(*a, **k):
        raise AssertionError("make_proxy must not run when proxy=False")

    monkeypatch.setattr(ing, "make_proxy", fail_make_proxy)

    clip = ingest_source(str(proj), str(src), "sdr_bt709", proxy=False)

    assert "proxySrc" not in clip
    assert clip["src"] == str(proj / "src.mp4")  # SDR-conformant → no transcode
    assert clip["sourceWidth"] == 1920
    assert clip["sourceHeight"] == 1080
    assert clip["sourceDuration"] == 3.0


# ── staging collision suffix ──────────────────────────────────────────────────

def test_staging_collision_suffix(tmp_path, monkeypatch):
    """Two ingested sources sharing a basename: the second is staged as
    <base>_clip2<ext>, matching init's collision convention."""
    proj = tmp_path / "proj"
    proj.mkdir()

    a = tmp_path / "a" / "clip.mp4"
    b = tmp_path / "b" / "clip.mp4"
    a.parent.mkdir()
    b.parent.mkdir()
    a.write_bytes(b"aaa")
    b.write_bytes(b"bbb")

    # probe failure keeps this ffmpeg-free: no transcode, no proxy, no dims.
    monkeypatch.setattr(ing, "probe_video", lambda _p: None)
    monkeypatch.setattr(ing, "get_duration", lambda _p: 1.0)

    clip_a = ingest_source(str(proj), str(a), "sdr_bt709")
    clip_b = ingest_source(str(proj), str(b), "sdr_bt709")

    assert clip_a["src"] == str(proj / "clip.mp4")
    assert clip_b["src"] == str(proj / "clip_clip2.mp4")
    assert (proj / "clip.mp4").exists()
    assert (proj / "clip_clip2.mp4").exists()
    # probe failure → no dimensions, no proxy
    assert "sourceWidth" not in clip_a
    assert "proxySrc" not in clip_a


def test_src_already_in_project_dir_uses_file_in_place(tmp_path, monkeypatch):
    """A source already staged inside project_dir (e.g. by an existing
    browser-upload route, before ingest runs) is NOT copied again — the file
    is used in place. Nested in a subdirectory on purpose: without the
    realpath-based guard, `_stage_into_project` would compute a
    project_dir-root destination different from `src` and copy a duplicate
    there (a `_clip2`-style landmine)."""
    proj = tmp_path / "proj"
    proj.mkdir()
    uploads = proj / "uploads"
    uploads.mkdir()
    src = uploads / "shot.mp4"
    src.write_bytes(b"fake")

    monkeypatch.setattr(ing, "probe_video", lambda _p: None)
    monkeypatch.setattr(ing, "get_duration", lambda _p: 1.0)

    clip = ingest_source(str(proj), str(src), "sdr_bt709", proxy=False)

    assert clip["src"] == str(src)
    # No duplicate copy landed anywhere under the project dir.
    all_files = sorted(p for p in proj.rglob("*") if p.is_file())
    assert all_files == [src]


def test_clip_id_passthrough(tmp_path, monkeypatch):
    """When clip_id is given it appears as the dict's id; default omits it."""
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    proj = tmp_path / "proj"
    proj.mkdir()
    monkeypatch.setattr(ing, "probe_video", lambda _p: None)
    monkeypatch.setattr(ing, "get_duration", lambda _p: 1.0)

    clip = ingest_source(str(proj), str(src), "sdr_bt709", proxy=False, clip_id="clip-7")
    assert clip["id"] == "clip-7"
    # id is first key, matching init's clip dict ordering.
    assert list(clip.keys())[0] == "id"
