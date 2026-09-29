"""lib/color_provenance.py against the shared case table.

tests/fixtures/color_provenance_cases.json is also run by
montaj_assets/render/test/sdr-layer.test.mjs through sdr-layer.js, so the two
resolvers cannot drift apart without one of the two suites failing.
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

import lib.color_provenance as cp
import lib.normalize as nm

TABLE = json.loads((REPO_ROOT / "tests" / "fixtures" / "color_provenance_cases.json").read_text())
CASES = TABLE["cases"]


def _deps(case):
    def probe(path):
        d = case["probes"].get(path)
        return cp.FAILED_PROBE if d is None else cp.Probe(**d)

    def exists(path):
        return path in case["exists"]

    return {"probe": probe, "exists": exists}


def test_marker_equals_the_table_and_normalize():
    assert cp.SDR_ORIGIN_MARKER == TABLE["marker"] == nm.SDR_ORIGIN_MARKER


def test_table_is_not_empty():
    assert len(CASES) >= 20


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_case(case):
    src = case["item"]["src"]
    origin = cp.origin_of(src, **_deps(case))
    assert origin == cp.Origin(case["expect"]["origin"]["colorSpace"], case["expect"]["origin"]["original"])
    proxy = case["expect"]["proxy"]
    assert cp.proxy_source_for(src, **_deps(case)) == (proxy["input"], proxy["tonemap"])


def test_fps_value():
    assert cp.fps_value("30/1") == 30
    assert cp.fps_value("30000/1001") == 30000 / 1001
    for bad in ["0/0", "30/0", "0/1", "", None, "abc", "30"]:
        assert cp.fps_value(bad) == 0, bad


def test_same_fingerprint_needs_a_size_a_rate_and_both_durations():
    a = cp.Probe("bt709", "", 10, 10, "30/1", 1.0)
    assert cp.same_fingerprint(a, a)
    assert not cp.same_fingerprint(a._replace(width=None), a._replace(width=None))
    assert not cp.same_fingerprint(a._replace(height=None), a._replace(height=None))
    assert not cp.same_fingerprint(a, a._replace(duration=None))
    assert not cp.same_fingerprint(a._replace(duration=None), a)


# ── the probe cache ──────────────────────────────────────────────────────────


def test_probe_is_cached_by_realpath_and_mtime(tmp_path, monkeypatch):
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"x")
    link = tmp_path / "link.mp4"
    link.symlink_to(f)
    calls = []

    def fake(path):
        calls.append(path)
        return cp.Probe("arib-std-b67", "", 4, 4, "30/1", 1.0)

    monkeypatch.setattr(cp, "_ffprobe", fake)
    monkeypatch.setattr(cp, "_CACHE", {})

    first = cp.probe_media(str(f))
    assert cp.probe_media(str(f)) == first
    assert cp.probe_media(str(link)) == first  # same realpath: same entry
    assert len(calls) == 1

    st = os.stat(f)
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    cp.probe_media(str(f))
    assert len(calls) == 2


def test_failed_probe_is_not_cached(tmp_path, monkeypatch):
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"x")
    calls = []

    def fake(path):
        calls.append(path)
        return cp.FAILED_PROBE

    monkeypatch.setattr(cp, "_ffprobe", fake)
    monkeypatch.setattr(cp, "_CACHE", {})
    cp.probe_media(str(f))
    cp.probe_media(str(f))
    assert len(calls) == 2


def test_probe_of_a_missing_path_or_none_is_the_failure_shape():
    assert cp.probe_media("/nonexistent/montaj/clip.mp4") == cp.FAILED_PROBE
    assert cp.probe_media(None) == cp.FAILED_PROBE
    assert cp.origin_of("/nonexistent/montaj/clip.mp4") == cp.Origin("sdr_bt709", None)


# ── real ffmpeg ──────────────────────────────────────────────────────────────

HAS_FFMPEG = shutil.which(nm.ffmpeg_bin()) is not None or os.path.isfile(nm.ffmpeg_bin())


def _ffmpeg(*args):
    subprocess.run([nm.ffmpeg_bin(), "-y", "-v", "error", *args], check=True, capture_output=True, timeout=60)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_real_probe_reads_display_dims_rate_duration_and_comment(tmp_path):
    plain = tmp_path / "plain.mp4"
    rotated = tmp_path / "rotated.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc2=size=64x32:rate=30000/1001:duration=0.5",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-bsf:v", "h264_metadata=transfer_characteristics=18:colour_primaries=9:matrix_coefficients=9",
            "-metadata", f"comment={nm.SDR_ORIGIN_MARKER}src.mov", str(plain))
    _ffmpeg("-display_rotation", "90", "-i", str(plain), "-c", "copy", str(rotated))

    p = cp._ffprobe(str(plain))
    assert (p.transfer, p.comment, p.width, p.height, p.fps) == (
        "arib-std-b67", f"{nm.SDR_ORIGIN_MARKER}src.mov", 64, 32, "30000/1001")
    assert abs(p.duration - 0.5) < 0.05
    q = cp._ffprobe(str(rotated))
    assert (q.width, q.height) == (32, 64)


@pytest.mark.skipif(not HAS_FFMPEG or not nm._has_zscale(), reason="ffmpeg with zscale not available")
def test_real_normalize_output_resolves_to_its_original_and_a_trimmed_copy_does_not(tmp_path):
    src = tmp_path / "screen.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-bsf:v", "h264_metadata=transfer_characteristics=1:colour_primaries=1:matrix_coefficients=1",
            str(src))
    out = Path(nm.normalized_output_path(str(src), "hdr_hlg", tonemapped=False, sdr_stretch=True))
    assert nm.normalize(str(src), str(out), "hdr_hlg") == str(out)
    marked = cp._ffprobe(str(out))
    assert marked.transfer == "arib-std-b67"
    assert marked.comment == nm.SDR_ORIGIN_MARKER + "screen.mp4"

    assert cp.origin_of(str(out)) == cp.Origin("sdr_bt709", str(src))
    assert cp.proxy_source_for(str(out)) == (str(src), False)

    # A trimmed re-encode inherits the comment (montaj never passes
    # -map_metadata -1) but is not a conversion of screen.mp4.
    trimmed = tmp_path / "screen_trim.mp4"
    _ffmpeg("-ss", "0.5", "-t", "0.5", "-i", str(out), "-c:v", "libx265", "-pix_fmt", "yuv420p10le",
            "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc",
            "-x265-params", "log-level=error", "-c:a", "copy", str(trimmed))
    t = cp._ffprobe(str(trimmed))
    assert t.comment == nm.SDR_ORIGIN_MARKER + "screen.mp4"
    assert t.transfer == "arib-std-b67"
    assert cp.origin_of(str(trimmed)) == cp.Origin("hdr_hlg", None)
    assert cp.proxy_source_for(str(trimmed)) == (str(trimmed), True)
