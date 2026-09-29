"""lib/color_provenance.py against the shared case table.

tests/fixtures/color_provenance_cases.json is also run by
montaj_assets/render/test/sdr-layer.test.mjs through sdr-layer.js, so the two
resolvers cannot drift apart without one of the two suites failing.
"""
import asyncio
import json
import math
import os
import shutil
import subprocess
import sys
import types
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


# ── ensure_color_provenance: heal projects made before PV42 (T4b) ────────────
#
# Real ffmpeg media, small and short: 160x284, 30 fps, 3 s. Built once per
# module, then copied into each test's project folder with explicit mtimes.

HAS_ZSCALE = HAS_FFMPEG and nm._has_zscale()
from tests.conftest import REQUIRE_CAPS as REQUIRE_HDR_FFMPEG, skip_or_fail as _conftest_skip_or_fail  # PV52: required by default
# Unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1, the media fixture fails instead of skipping (PV52).
needs_media = pytest.mark.skipif(not HAS_ZSCALE and not REQUIRE_HDR_FFMPEG,
                                 reason="ffmpeg with zscale not available")

PID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a"
_SIZE, _RATE, _DUR = "160x284", "30", "3"
_BSF_709 = "h264_metadata=transfer_characteristics=1:colour_primaries=1:matrix_coefficients=1"
_T0 = 1_700_000_000  # a fixed base mtime; tests order files relative to it


def _x265_hlg():
    return ["-c:v", "libx265", "-preset", "ultrafast", "-crf", "22",
            "-x265-params", "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:"
                            "repeat-headers=1:log-level=error",
            "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc",
            "-pix_fmt", "yuv420p10le", "-g", "30"]


def _legacy_convert(src, out, *, untagged=False, extra=()):
    """The pre-PV42 SDR-to-HLG stretch: npl 100 (no npl=203), no marker."""
    vf = "zscale=t=arib-std-b67:p=bt2020:m=bt2020nc,format=yuv420p10le"
    if untagged:
        vf = f"{nm.UNTAGGED_AS_BT709_VF},{vf}"
    _ffmpeg("-i", str(src), "-vf", vf, *_x265_hlg(), *extra, str(out))


def _sdr(out, source, *, tagged=True):
    _ffmpeg("-f", "lavfi", "-i", source, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
            *(["-bsf:v", _BSF_709] if tagged else []), str(out))


def _dark(out, x_expr):
    """Black with one small grey box moving across it."""
    _ffmpeg("-f", "lavfi", "-i", f"color=c=black:s={_SIZE}:r={_RATE}:d={_DUR}",
            "-f", "lavfi", "-i", f"color=c=0x808080:s=8x8:r={_RATE}:d={_DUR}",
            "-filter_complex", f"[0][1]overlay=x='{x_expr}':y=140:shortest=1,format=yuv420p",
            "-c:v", "libx264", "-g", "30", "-bsf:v", _BSF_709, str(out))


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    if not HAS_ZSCALE:
        _conftest_skip_or_fail("ffmpeg with zscale not available")
    d = Path(os.path.realpath(tmp_path_factory.mktemp("cpmedia")))
    testsrc = f"testsrc2=size={_SIZE}:rate={_RATE}:duration={_DUR}"
    _sdr(d / "testsrc.mp4", testsrc)
    _sdr(d / "testsrc_untagged.mp4", testsrc, tagged=False)
    _sdr(d / "other.mp4", f"smptehdbars=size={_SIZE}:rate={_RATE}:duration={_DUR}")
    _legacy_convert(d / "testsrc.mp4", d / "legacy.mp4")
    _legacy_convert(d / "testsrc_untagged.mp4", d / "legacy_untagged.mp4", untagged=True)
    # A screen recording is full range (yuvj420p), and so is its conversion.
    _ffmpeg("-f", "lavfi", "-i", testsrc, "-vf", "scale=out_range=pc,format=yuvj420p",
            "-c:v", "libx264", "-pix_fmt", "yuvj420p", "-g", "30", "-bsf:v", _BSF_709,
            str(d / "screen_full.mp4"))
    _legacy_convert(d / "screen_full.mp4", d / "legacy_full.mp4")
    _legacy_convert(d / "testsrc.mp4", d / "legacy_bitexact.mp4", extra=("-fflags", "+bitexact"))

    # T2's normalize: carries the marker naming screen.mp4.
    shutil.copy2(d / "testsrc.mp4", d / "screen.mp4")
    marked = nm.normalized_output_path(str(d / "screen.mp4"), "hdr_hlg", tonemapped=False, sdr_stretch=True)
    nm.normalize(str(d / "screen.mp4"), marked, "hdr_hlg")
    # A trimmed re-encode of it inherits the comment.
    _ffmpeg("-ss", "1", "-t", "1", "-i", marked, *_x265_hlg(), "-c:a", "copy", str(d / "screen_trim.mp4"))

    # Camera stand-in: HLG-tagged 10-bit, written by ffmpeg (Lavf), and its graded SDR sibling.
    _ffmpeg("-f", "lavfi", "-i", f"mandelbrot=size={_SIZE}:rate={_RATE}", "-t", _DUR,
            *_x265_hlg(), str(d / "cam.mp4"))
    nm.normalize(str(d / "cam.mp4"), str(d / "cam_master_sdr.mp4"), "sdr_bt709")

    _dark(d / "dark_a.mp4", "t*40")
    _dark(d / "dark_b.mp4", "150-t*40")
    _legacy_convert(d / "dark_a.mp4", d / "dark_a_hlg.mp4")
    return {p.name: p for p in d.iterdir()}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    ws = Path(os.path.realpath(tmp_path)) / "Montaj"
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    proj = ws / "proj"
    proj.mkdir()
    return proj


def _place(media, name, dest, mtime):
    """Copy a built clip to `dest` and give it mtime `_T0 + mtime`."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(media[name], dest)
    os.utime(dest, (_T0 + mtime, _T0 + mtime))
    return str(dest)


def _item(src, id="clip-0", **extra):
    return {"id": id, "type": "video", "src": str(src), "start": 0.0, "end": 3.0,
            "inPoint": 0.0, "outPoint": 3.0, **extra}


def _write_project(proj, items, *, cs="hdr_hlg", sources=None, **settings):
    project = {
        "id": PID, "version": "0.2", "status": "draft", "projectType": "video",
        "settings": {"colorSpace": cs, "resolution": [160, 284], "fps": 30, **settings},
        "tracks": [{"id": "main", "items": items}],
        "sources": sources if sources is not None else [],
    }
    (Path(proj) / "project.json").write_text(json.dumps(project, indent=2))
    return project


def _read(proj):
    return json.loads((Path(proj) / "project.json").read_text())


def _tracks0(project):
    return project["tracks"][0]["items"]


def _candidate(result, src):
    return next(c for c in result["candidates"] if c["src"] == str(src))


def _pool_row(entry, path):
    return next(r for r in entry["pool"] if r["path"] == str(path))


@needs_media
def test_probe_reads_the_encoder_tag(media):
    assert cp._ffprobe(str(media["legacy.mp4"])).encoder.startswith("Lavf")
    assert cp._ffprobe(str(media["legacy_bitexact.mp4"])).encoder == ""


@needs_media
def test_1_normalized_name_is_matched_to_its_stem(media, workspace):
    x = _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    # Same content, older: the oldest-mtime rule alone would pick it.
    _place(media, "testsrc.mp4", workspace / "Y.mp4", 0)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    entry = _candidate(result, conv)
    assert entry["original"] == x
    assert _pool_row(entry, x)["rejected"] is None
    assert max(_pool_row(entry, x)["meanAbs"]) <= cp.CONTENT_MAX_MEAN_ABS
    assert _tracks0(_read(workspace))[0]["src"] == x


@needs_media
def test_2_ad_hoc_name_prefers_the_original_in_sources(media, workspace, tmp_path):
    footage = Path(os.path.realpath(tmp_path)) / "footage"
    a = _place(media, "testsrc.mp4", footage / "a.mp4", 10)  # outside the folder, in sources
    _place(media, "testsrc.mp4", workspace / "b.mp4", 0)      # older, not in sources
    conv = _place(media, "legacy.mp4", workspace / "take_final.mp4", 100)
    _write_project(workspace, [_item(conv)], sources=[_item(conv), _item(a, id="src-a")])

    result = cp.ensure_color_provenance(workspace)

    assert _candidate(result, conv)["original"] == a
    project = _read(workspace)
    assert _tracks0(project)[0]["src"] == a
    assert project["sources"][0]["src"] == a


@needs_media
def test_3_compatible_name_prefers_the_shortest_prefix_stem(media, workspace):
    x = _place(media, "testsrc_untagged.mp4", workspace / "X.mp4", 10)
    _place(media, "testsrc.mp4", workspace / "X_tagged709.mp4", 0)  # older, also matches
    conv = _place(media, "legacy_untagged.mp4", workspace / "X_compatible_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    entry = _candidate(result, conv)
    assert _pool_row(entry, workspace / "X_tagged709.mp4")["rejected"] is None
    assert entry["original"] == x


@needs_media
def test_full_range_original_is_decoded_with_its_own_range(media, workspace):
    """Each side is read in its own range: a full-range screen recording and
    its full-range conversion match; the limited-range twin of the same picture
    matches too, so the two ranges are compared code for code."""
    assert cp._ffprobe(str(media["legacy_full.mp4"])).transfer == "arib-std-b67"
    rec = _place(media, "screen_full.mp4", workspace / "ScreenRecording.mp4", 10)
    limited = _place(media, "testsrc.mp4", workspace / "limited.mp4", 0)
    conv = _place(media, "legacy_full.mp4", workspace / "ScreenRecording_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    entry = _candidate(result, conv)
    assert entry["original"] == rec
    assert max(_pool_row(entry, rec)["meanAbs"]) <= cp.CONTENT_MAX_MEAN_ABS
    assert max(_pool_row(entry, limited)["meanAbs"]) <= cp.CONTENT_MAX_MEAN_ABS


@needs_media
def test_4_camera_clip_beside_its_graded_sibling_is_not_matched(media, workspace):
    graded = _place(media, "cam_master_sdr.mp4", workspace / "IMG_0689_master_sdr.mp4", 0)
    cam = _place(media, "cam.mp4", workspace / "IMG_0689.mp4", 100)
    _write_project(workspace, [_item(cam)])

    result = cp.ensure_color_provenance(workspace)

    entry = _candidate(result, cam)
    assert entry["encoder"].startswith("Lavf")
    assert entry["original"] is None
    row = _pool_row(entry, graded)
    assert row["rejected"] == "content"
    assert len(row["meanAbs"]) == 3 and max(row["meanAbs"]) > cp.CONTENT_MAX_MEAN_ABS
    assert len(entry["thumbStd"]) == 3
    assert _tracks0(_read(workspace))[0]["src"] == cam


@needs_media
def test_5_different_content_at_the_same_fingerprint_is_not_matched(media, workspace):
    other = _place(media, "other.mp4", workspace / "X.mp4", 0)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    entry = _candidate(result, conv)
    assert entry["original"] is None
    assert _pool_row(entry, other)["rejected"] == "content"
    assert _tracks0(_read(workspace))[0]["src"] == conv


@needs_media
def test_6_no_original_keeps_the_clip_logs_it_and_runs_once(media, workspace, capsys):
    conv = _place(media, "legacy.mp4", workspace / "gone_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    assert result["kept"] == ["gone_normalized_hdr_hlg.mp4"]
    line = "colour provenance: no SDR original matched 1 ffmpeg-written HDR clip(s): gone_normalized_hdr_hlg.mp4"
    assert line in result["log"]
    assert line in capsys.readouterr().err
    project = _read(workspace)
    assert _tracks0(project)[0]["src"] == conv
    assert project["settings"]["colorProvenance"] == 1
    assert "normalizeInBackground" not in project["settings"]


@needs_media
def test_7_marker_pass_heals_a_marked_conversion_after_the_legacy_pass_ran(media, workspace):
    screen = _place(media, "screen.mp4", workspace / "screen.mp4", 0)
    marked = _place(media, "screen_normalized_hdr_hlg_w203.mp4",
                    workspace / "screen_normalized_hdr_hlg_w203.mp4", 100)
    _write_project(workspace, [_item(marked)], colorProvenance=1)

    result = cp.ensure_color_provenance(workspace)

    assert result["legacyPass"] is False
    assert result["candidates"] == []
    assert [(s["from"], s["to"], s["pass"]) for s in result["switched"]] == [(marked, screen, "marker")]
    project = _read(workspace)
    assert _tracks0(project)[0]["src"] == screen
    assert project["settings"]["normalizeInBackground"] is True


@needs_media
def test_8_apply_switches_src_adopts_the_fresh_proxy_and_runs_the_legacy_pass_once(media, workspace):
    from lib.proxy import proxy_path_for

    x = _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    old_proxy = proxy_path_for(conv)
    Path(old_proxy).write_bytes(b"proxy of the converted file")
    fresh = proxy_path_for(os.path.realpath(x))
    Path(fresh).write_bytes(b"proxy of the original")
    os.utime(fresh, (_T0 + 200, _T0 + 200))
    item = _item(conv, inPoint=4.0, outPoint=6.0, proxySrc=old_proxy)
    _write_project(workspace, [item], sources=[dict(item)])

    result = cp.ensure_color_provenance(workspace)

    assert result["legacyPass"] is True
    assert result["written"] is True
    project = _read(workspace)
    for it in (_tracks0(project)[0], project["sources"][0]):
        assert it["src"] == x
        assert it["inPoint"] == 4.0 and it["outPoint"] == 6.0
        assert it["proxySrc"] == fresh
        assert "normalizedSrc" not in it and "normalizedInPoint" not in it
    assert project["settings"]["colorProvenance"] == 1
    assert project["settings"]["normalizeInBackground"] is True
    assert result["proxiesOwed"] == []

    before = (workspace / "project.json").read_bytes()
    again = cp.ensure_color_provenance(workspace)
    assert again["legacyPass"] is False
    assert again["candidates"] == [] and again["switched"] == [] and again["edits"] == []
    assert (workspace / "project.json").read_bytes() == before


@needs_media
def test_8b_a_stale_proxy_is_cleared_and_owed(media, workspace):
    from lib.proxy import proxy_path_for

    x = _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv, proxySrc=proxy_path_for(conv))])

    result = cp.ensure_color_provenance(workspace)

    item = _tracks0(_read(workspace))[0]
    assert item["src"] == x and "proxySrc" not in item
    real = os.path.realpath(x)
    assert result["proxiesOwed"] == [{"id": "clip-0", "src": x, "input": real, "out": proxy_path_for(real)}]


@needs_media
def test_9_sdr_project_is_a_no_op(media, workspace):
    _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)], cs="sdr_bt709")
    before = (workspace / "project.json").read_bytes()

    result = cp.ensure_color_provenance(workspace)

    assert result["skipped"] == "not an HDR project"
    assert result["edits"] == [] and result["settings"] == {}
    assert (workspace / "project.json").read_bytes() == before


@needs_media
def test_10_dark_footage_is_under_the_std_dev_floor(media, workspace):
    b = _place(media, "dark_b.mp4", workspace / "dark_b.mp4", 0)
    conv = _place(media, "dark_a_hlg.mp4", workspace / "dark_a_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    entry = _candidate(result, conv)
    row = _pool_row(entry, b)
    assert row["rejected"] == "std-dev floor"
    assert max(row["meanAbs"]) <= cp.CONTENT_MAX_MEAN_ABS
    assert sum(s >= cp.CONTENT_MIN_STD for s in entry["thumbStd"]) < 2
    assert entry["original"] is None
    assert _tracks0(_read(workspace))[0]["src"] == conv


@needs_media
def test_11_a_trimmed_copy_of_a_marked_file_is_not_healed(media, workspace):
    _place(media, "screen.mp4", workspace / "screen.mp4", 0)
    trim = _place(media, "screen_trim.mp4", workspace / "screen_trim.mp4", 100)
    assert cp._ffprobe(trim).comment == nm.SDR_ORIGIN_MARKER + "screen.mp4"
    _write_project(workspace, [_item(trim)])

    result = cp.ensure_color_provenance(workspace)

    assert result["switched"] == []
    assert _tracks0(_read(workspace))[0]["src"] == trim


@needs_media
def test_12_a_file_without_an_encoder_tag_is_not_a_candidate(media, workspace):
    _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    conv = _place(media, "legacy_bitexact.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    entry = _candidate(result, conv)
    assert entry["rejected"] == "encoder"
    assert entry["pool"] == [] and entry["original"] is None
    assert result["kept"] == []
    assert _tracks0(_read(workspace))[0]["src"] == conv


@needs_media
def test_13_a_pool_file_newer_than_the_candidate_is_not_matched(media, workspace):
    x = _place(media, "testsrc.mp4", workspace / "X.mp4", 200)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    entry = _candidate(result, conv)
    assert _pool_row(entry, x)["rejected"] == "mtime"
    assert entry["original"] is None
    assert _tracks0(_read(workspace))[0]["src"] == conv


@needs_media
def test_14_items_with_nobg_src_are_untouched(media, workspace):
    _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _place(media, "screen.mp4", workspace / "screen.mp4", 0)
    marked = _place(media, "screen_normalized_hdr_hlg_w203.mp4",
                    workspace / "screen_normalized_hdr_hlg_w203.mp4", 100)
    nobg = str(workspace / "cut_nobg.mov")
    items = [
        _item(conv, id="a", nobg_src=nobg, remove_bg=True),
        _item(marked, id="b", nobg_src=nobg, remove_bg=True,
              normalizedSrc=str(workspace / "missing.mp4"), normalizedInPoint=0),
    ]
    _write_project(workspace, items)

    result = cp.ensure_color_provenance(workspace)

    assert result["candidates"] == [] and result["switched"] == [] and result["dropped"] == []
    project = _read(workspace)
    assert _tracks0(project) == items
    assert project["settings"]["colorProvenance"] == 1


@needs_media
def test_15_a_missing_or_foreign_normalized_src_is_dropped(media, workspace):
    screen = _place(media, "screen.mp4", workspace / "screen.mp4", 0)
    other = _place(media, "testsrc.mp4", workspace / "other.mp4", 0)
    cache = _place(media, "screen_normalized_hdr_hlg_w203.mp4",
                   workspace / "screen_normalized_hdr_hlg_w203.mp4", 100)
    items = [
        _item(screen, id="kept", normalizedSrc=cache, normalizedInPoint=0),
        _item(other, id="foreign", normalizedSrc=cache, normalizedInPoint=0),
        _item(screen, id="missing", normalizedSrc=str(workspace / "gone.mp4"), normalizedInPoint=1.5),
    ]
    _write_project(workspace, items, colorProvenance=1)

    result = cp.ensure_color_provenance(workspace)

    assert sorted(d["id"] for d in result["dropped"]) == ["foreign", "missing"]
    by_id = {it["id"]: it for it in _tracks0(_read(workspace))}
    assert by_id["kept"]["normalizedSrc"] == cache and by_id["kept"]["normalizedInPoint"] == 0
    for gone in ("foreign", "missing"):
        assert "normalizedSrc" not in by_id[gone] and "normalizedInPoint" not in by_id[gone]
        assert by_id[gone]["src"] in (screen, other)


def test_ensure_never_raises(tmp_path, monkeypatch):
    (tmp_path / "project.json").write_text("{not json")
    assert cp.ensure_color_provenance(tmp_path)["skipped"] == "unreadable project.json"

    _write_project(tmp_path, [], cs="hdr_hlg")

    def boom(*a, **k):
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(cp, "_plan", boom)
    result = cp.ensure_color_provenance(tmp_path)
    assert "probe exploded" in result["error"]


# ── serve and render wiring ──────────────────────────────────────────────────


class _Bus:
    def __init__(self):
        self.frames = []

    def publish(self, project_id, frame):
        self.frames.append((project_id, json.loads(frame.split("data: ", 1)[1])))


@pytest.fixture
def serve_state(monkeypatch):
    """Empty background queue, and encodes that write a stub file instead of
    running ffmpeg (same harness as tests/test_background_normalize.py)."""
    import serve.routes.projects as pm
    import serve.routes.steps as steps_mod
    from serve.jobs import set_done

    pm._look_migration_queue.clear()
    pm._look_migration_current = None
    pm._look_migration_worker = None
    rec = {"proxy": [], "normalize": []}

    async def _fake_proxy(job_id, input_path, *, out, tonemap=None):
        rec["proxy"].append((input_path, out))
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"proxy")
        set_done(job_id, {"path": out, "skipped": False})

    async def _fake_normalize(job_id, input_path, color_space, *, out=None):
        rec["normalize"].append((input_path, out))
        Path(out).write_bytes(b"converted")
        set_done(job_id, {"path": out, "skipped": False})

    monkeypatch.setattr(steps_mod, "run_proxy_job", _fake_proxy)
    monkeypatch.setattr(steps_mod, "run_normalize_job", _fake_normalize)
    yield rec
    pm._look_migration_queue.clear()
    pm._look_migration_current = None
    pm._look_migration_worker = None


def _git(proj, *args):
    return subprocess.run(["git", *args], cwd=str(proj), capture_output=True, text=True, check=True).stdout


@needs_media
def test_serve_open_heals_after_look_migration_and_before_background_normalize(media, workspace, serve_state,
                                                                                 monkeypatch):
    from types import SimpleNamespace

    import serve.routes.projects as pm
    from lib.normalize import normalized_output_path
    from lib.proxy import proxy_path_for

    x = _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    conv_proxy = proxy_path_for(conv)
    Path(conv_proxy).write_bytes(b"proxy of the converted file")
    item = _item(conv, proxySrc=conv_proxy)
    _write_project(workspace, [item], sources=[dict(item)])
    _git(workspace, "init", "-q")

    order = []
    for name in ("migrate_project_look", "ensure_project_color_provenance", "_ensure_background_normalize"):
        real = getattr(pm, name)

        def _wrap(*a, _real=real, _name=name, **k):
            order.append(_name)
            return _real(*a, **k)

        monkeypatch.setattr(pm, name, _wrap)

    bus = _Bus()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(broadcaster=bus)))

    async def _run():
        body = await pm.get_project(PID, request=request, project_dir=workspace)
        while pm._look_migration_worker is not None:
            await pm._look_migration_worker
        return body

    body = asyncio.run(_run())

    assert order == ["migrate_project_look", "ensure_project_color_provenance", "_ensure_background_normalize"]
    assert _tracks0(body)[0]["src"] == x
    # The healed project went out over SSE.
    assert any(_tracks0(p)[0]["src"] == x and "proxySrc" not in _tracks0(p)[0] for _, p in bus.frames)
    # The snapshot holds the project as it was before the heal.
    assert _git(workspace, "log", "--format=%s").split("\n")[0] == "version: before colour provenance"
    before = json.loads(_git(workspace, "show", "HEAD:project.json"))
    assert _tracks0(before)[0]["src"] == conv
    # proxySrc was cleared, so the original's proxy was queued and landed.
    real = os.path.realpath(x)
    assert (real, proxy_path_for(real)) in serve_state["proxy"]
    # normalizeInBackground: the original is converted at 203 nits into normalizedSrc.
    w203 = normalized_output_path(x, "hdr_hlg", tonemapped=False, sdr_stretch=True)
    assert serve_state["normalize"] == [(x, w203)]
    healed = _tracks0(_read(workspace))[0]
    assert healed["src"] == x
    assert healed["proxySrc"] == proxy_path_for(real)
    assert healed["normalizedSrc"] == w203 and healed["normalizedInPoint"] == 0


def test_serve_heal_never_raises(tmp_path, monkeypatch):
    import lib.color_provenance as cpm
    import serve.routes.projects as pm

    project = _write_project(tmp_path, [], cs="hdr_hlg")

    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(cpm, "plan_color_provenance", boom)
    out = asyncio.run(pm.ensure_project_color_provenance(PID, tmp_path, project, None))
    assert out is project


class _RenderRequest:
    def __init__(self):
        self.query_params = {"async": "1"}

    async def json(self):
        raise ValueError("no body")


def test_render_project_heals_before_its_snapshot(tmp_path, monkeypatch):
    import serve.routes.projects as pm

    for name in ("_active_renders", "_render_procs", "_render_jobs", "_render_task_refs"):
        getattr(pm, name).clear()
    proj = tmp_path / "proj"
    proj.mkdir()
    _write_project(proj, [], cs="hdr_hlg")
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "render.js").write_text("// stub")
    monkeypatch.setattr(pm, "render_runtime_dir", lambda: str(runtime))
    monkeypatch.setattr(pm.shutil, "which", lambda b: "/usr/bin/node")

    calls = []

    async def _fake_detached(*a, **k):
        calls.append("spawn")

    async def _fake_heal(project_id, project_dir, project, broadcaster=None):
        calls.append(("heal", project_id, Path(project_dir)))
        return project

    monkeypatch.setattr(pm, "_run_render_detached", _fake_detached)
    monkeypatch.setattr(pm, "ensure_project_color_provenance", _fake_heal)
    monkeypatch.setattr(pm, "_git_commit_sync", lambda d, message: calls.append(("git", message)))

    try:
        asyncio.run(pm.render_project(PID, _RenderRequest(), project_dir=proj))
    finally:
        for name in ("_active_renders", "_render_procs", "_render_jobs", "_render_task_refs"):
            getattr(pm, name).clear()

    assert calls[0] == ("heal", PID, proj)
    assert calls[1][0] == "git" and calls[1][1].startswith("version: run")


def test_version_frame_heals_the_working_copy_before_rendering(tmp_path, monkeypatch):
    import serve.routes.projects as pm

    proj = tmp_path / "proj"
    proj.mkdir()
    _write_project(proj, [], cs="hdr_hlg")
    calls = []

    async def _fake_heal(project_id, project_dir, project, broadcaster=None):
        calls.append("heal")
        return project

    class _Proc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def _fake_exec(*args, **kwargs):
        calls.append("render")
        out = Path(args[list(args).index("--out") + 1])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"\x89PNG\r\n\x1a\n")
        return _Proc()

    monkeypatch.setattr(pm, "ensure_project_color_provenance", _fake_heal)
    monkeypatch.setattr(pm.asyncio, "create_subprocess_exec", _fake_exec)
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "sample-frame.js").write_text("// stub")
    monkeypatch.setattr(pm, "render_runtime_dir", lambda: str(runtime))
    monkeypatch.setattr(pm.shutil, "which", lambda b: "/usr/bin/node")

    asyncio.run(pm.version_frame(PID, "working", 1.0, request=None, project_dir=proj))

    assert calls == ["heal", "render"]


def test_cli_render_heals_before_spawning_render_js(tmp_path, monkeypatch):
    import lib.color_provenance as cpm
    import project.render as render_mod

    proj = tmp_path / "proj"
    proj.mkdir()
    _write_project(proj, [], cs="hdr_hlg")
    calls = []
    monkeypatch.setattr(cpm, "ensure_color_provenance", lambda d: calls.append(("heal", str(d))))

    def _fake_exec(file, cmd, env):
        calls.append(("exec", cmd[1]))

    monkeypatch.setattr(render_mod.os, "execvpe", _fake_exec)
    render_mod.main(project_path=str(proj / "project.json"))

    assert calls[0] == ("heal", str(proj))
    assert calls[1][0] == "exec" and calls[1][1].endswith("render.js")


def test_cli_render_does_not_heal_a_carousel(tmp_path, monkeypatch):
    import lib.color_provenance as cpm
    import project.carousel_normalize as cn
    import project.render as render_mod

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "project.json").write_text(json.dumps({"projectType": "carousel", "settings": {}}))
    calls = []
    monkeypatch.setattr(cpm, "ensure_color_provenance", lambda d: calls.append("heal"))
    monkeypatch.setattr(cn, "normalize_carousel_assets", lambda p: p)
    monkeypatch.setattr(render_mod.os, "execvpe", lambda *a: calls.append("exec"))
    render_mod.main(project_path=str(proj / "project.json"))

    assert calls == ["exec"]


# ── legacy matcher: two-stage thumbnail seek (PV42) ──────────────────────────

_GOP_FPS = 10


def _open_gop_clips(d):
    """A 10 fps testsrc2 SDR original and its legacy HLG conversion, encoded
    like lib/normalize.py (libx265, preset fast, -g fps): open GOP with
    B-frames, so a keyframe's dts precedes its pts."""
    orig, conv = Path(d) / "orig.mp4", Path(d) / "orig_normalized_hdr_hlg.mp4"
    _sdr(orig, f"testsrc2=size=128x72:rate={_GOP_FPS}:duration=3")
    spec = nm.SPECS["hdr_hlg"]
    _ffmpeg("-i", str(orig), "-vf", cp.legacy_stretch_vf("hdr_hlg", untagged=False),
            "-c:v", "libx265", "-preset", spec["encoder_params"]["preset"], "-crf", "22",
            "-x265-params", spec["encoder_params"]["x265-params"] + ":log-level=error",
            *spec["output_color_args"], "-pix_fmt", "yuv420p10le",
            "-g", str(_GOP_FPS), "-keyint_min", str(_GOP_FPS), str(conv))
    return orig, conv


def _keyframe_window(path):
    """(pts, dts) of the first keyframe after 0 whose dts precedes its pts."""
    out = subprocess.run(
        [nm.ffprobe_bin(), "-v", "error", "-select_streams", "v", "-show_entries",
         "packet=pts_time,dts_time,flags", "-of", "csv", str(path)],
        capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        _, pts, dts, flags = line.split(",")[:4]
        if flags.startswith("K") and float(pts) > 0 and float(dts) < float(pts):
            return float(pts), float(dts)
    return None


@pytest.fixture(scope="module")
def open_gop(tmp_path_factory):
    if not HAS_ZSCALE:
        _conftest_skip_or_fail("ffmpeg with zscale not available")
    d = Path(os.path.realpath(tmp_path_factory.mktemp("opengop")))
    orig, conv = _open_gop_clips(d)
    return d, orig, conv


def test_thumbnail_seek_is_exact_inside_an_open_gop_window(open_gop):
    _, _, conv = open_gop
    window = _keyframe_window(conv)
    assert window is not None, "fixture is not open-GOP (no keyframe with dts < pts)"
    pts, dts = window
    t = round((pts + dts) / 2, 3)  # inside dts..pts: leading pictures are displayed here
    k = math.ceil(t * _GOP_FPS)
    assert k / _GOP_FPS < pts

    by_index = lambda n: cp._thumbnails(str(conv), [0], f"select=eq(n\\,{n})")[0]  # noqa: E731
    got = cp._thumbnails(str(conv), [t])[0]
    want = by_index(k)
    next_keyframe = by_index(round(pts * _GOP_FPS))
    print(f"t={t} exact={cp._mean_abs(got, want):.2f} vs-keyframe={cp._mean_abs(got, next_keyframe):.2f}")

    assert cp._mean_abs(got, want) < 1
    assert cp._mean_abs(got, next_keyframe) > cp.CONTENT_MAX_MEAN_ABS


def test_matcher_matches_a_conversion_sampled_inside_an_open_gop_window(open_gop):
    d, orig, conv = open_gop
    pts, dts = _keyframe_window(conv)
    dur = cp.probe_media(str(conv)).duration
    assert dts < dur * cp.THUMB_POINTS[0] < pts, "the 25 % point must sit in the window"
    os.utime(orig, (_T0, _T0))
    os.utime(conv, (_T0 + 100, _T0 + 100))

    entry = cp.match_legacy_conversion(str(conv), [str(orig)])

    print("meanAbs", entry["pool"][0]["meanAbs"])
    assert entry["original"] == str(orig)
    assert len(entry["pool"][0]["meanAbs"]) == 3
    assert max(entry["pool"][0]["meanAbs"]) <= cp.CONTENT_MAX_MEAN_ABS


# ── serve: heal scope and concurrency (PV42 review) ──────────────────────────


def test_version_frame_of_a_historical_commit_does_not_heal(tmp_path, monkeypatch):
    import serve.routes.projects as pm

    proj = tmp_path / "proj"
    proj.mkdir()
    _write_project(proj, [], cs="hdr_hlg")
    _git(proj, "init", "-q")
    _git(proj, "add", "project.json")
    _git(proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "v1")
    commit = _git(proj, "rev-parse", "HEAD").strip()
    calls = []
    real_exec = asyncio.create_subprocess_exec

    async def _fake_heal(project_id, project_dir, project, broadcaster=None):
        calls.append("heal")
        return project

    class _Proc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def _fake_exec(*args, **kwargs):
        if args[0] == "git":
            return await real_exec(*args, **kwargs)
        calls.append("render")
        out = Path(args[list(args).index("--out") + 1])
        out.write_bytes(b"\x89PNG\r\n\x1a\n")
        return _Proc()

    monkeypatch.setattr(pm, "ensure_project_color_provenance", _fake_heal)
    monkeypatch.setattr(pm.asyncio, "create_subprocess_exec", _fake_exec)
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "sample-frame.js").write_text("// stub")
    monkeypatch.setattr(pm, "render_runtime_dir", lambda: str(runtime))
    monkeypatch.setattr(pm.shutil, "which", lambda b: "/usr/bin/node")

    asyncio.run(pm.version_frame(PID, commit, 1.0, request=None, project_dir=proj))

    assert calls == ["render"]


@needs_media
def test_concurrent_heals_run_the_first_open_pass_once(media, workspace, serve_state, monkeypatch):
    import lib.color_provenance as cpm
    import serve.routes.projects as pm

    _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])
    _git(workspace, "init", "-q")
    _git(workspace, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
    monkeypatch.setenv("GIT_AUTHOR_NAME", "t")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "t@t")
    monkeypatch.setenv("GIT_COMMITTER_NAME", "t")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "t@t")

    real_plan = cpm.plan_color_provenance
    with_edits = []

    def _counting_plan(project_dir):
        plan = real_plan(project_dir)
        if plan["edits"]:
            with_edits.append(1)
        return plan

    monkeypatch.setattr(cpm, "plan_color_provenance", _counting_plan)
    project = _read(workspace)

    async def _run():
        while pm._look_migration_worker is not None:
            await pm._look_migration_worker
        await asyncio.gather(*[pm.ensure_project_color_provenance(PID, workspace, project, None)
                               for _ in range(3)])
        while pm._look_migration_worker is not None:
            await pm._look_migration_worker

    asyncio.run(_run())

    subjects = _git(workspace, "log", "--format=%s").splitlines()
    assert subjects.count("version: before colour provenance") == 1
    assert len(with_edits) == 1


# ── PV57: a probe that fails never finishes the heal on a guess ──────────────
#
# The real heal over real media. Only lib.color_provenance's `subprocess.run`
# is swapped, and only for the commands `fails` picks: ffprobe times out (on
# every try), ffmpeg exits non-zero. Everything else runs for real.


def _failing_runs(monkeypatch, fails):
    real_run = subprocess.run

    def run(cmd, **kw):
        if fails(cmd):
            if os.path.basename(cmd[0]).startswith("ffprobe"):
                raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
            return subprocess.CompletedProcess(cmd, 1, b"", b"boom")
        return real_run(cmd, **kw)

    shim = types.ModuleType("subprocess")
    shim.__dict__.update({k: v for k, v in vars(subprocess).items() if not k.startswith("__")})
    shim.run = run
    monkeypatch.setattr(cp, "subprocess", shim)


def _ffprobe_of(path):
    return lambda cmd: os.path.basename(cmd[0]).startswith("ffprobe") and os.path.realpath(cmd[-1]) == path


def _ffmpeg_reading(path):
    return lambda cmd: os.path.basename(cmd[0]).startswith("ffmpeg") and path in cmd


def _failed(result):
    return [(f["pass"], f["id"], f["path"], f["reason"]) for f in result["probeFailed"]]


@needs_media
@pytest.mark.parametrize("unreadable", ["candidate probe", "pool probe", "pool thumbnail"])
def test_pv57_legacy_pass_is_not_done_after_a_failed_read_and_heals_on_the_next_call(
        media, workspace, monkeypatch, unreadable):
    """A transient failure in the one-time legacy pass must not record it as
    done, or that clip is never looked at again and the user has no way to ask."""
    x = _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])
    fails = {"candidate probe": _ffprobe_of(conv), "pool probe": _ffprobe_of(x),
             "pool thumbnail": _ffmpeg_reading(x)}[unreadable]
    failing = {"on": True}
    _failing_runs(monkeypatch, lambda cmd: failing["on"] and fails(cmd))

    first = cp.ensure_color_provenance(workspace)

    project = _read(workspace)
    assert "colorProvenance" not in project["settings"], "a read that failed must not finish the pass"
    assert _tracks0(project)[0]["src"] == conv
    assert first["legacyPass"] is True and first["error"] is None
    assert first["kept"] == [], "not matched is not the same as no match"
    failed_path = conv if unreadable == "candidate probe" else x
    assert any(f["pass"] == "legacy" and f["path"] == failed_path for f in first["probeFailed"]), first["probeFailed"]

    failing["on"] = False
    second = cp.ensure_color_provenance(workspace)

    assert second["legacyPass"] is True, "the pass runs again"
    assert [(s["from"], s["to"], s["pass"]) for s in second["switched"]] == [(conv, x, "legacy")]
    assert second["probeFailed"] == []
    project = _read(workspace)
    assert _tracks0(project)[0]["src"] == x
    assert project["settings"]["colorProvenance"] == 1


@needs_media
def test_pv57_marker_pass_leaves_an_item_it_cannot_read_lists_it_and_switches_it_next_call(
        media, workspace, monkeypatch):
    sa = _place(media, "screen.mp4", workspace / "a" / "screen.mp4", 0)
    ma = _place(media, "screen_normalized_hdr_hlg_w203.mp4", workspace / "a" / "screen_normalized_hdr_hlg_w203.mp4", 100)
    sb = _place(media, "screen.mp4", workspace / "b" / "screen.mp4", 0)
    mb = _place(media, "screen_normalized_hdr_hlg_w203.mp4", workspace / "b" / "screen_normalized_hdr_hlg_w203.mp4", 100)
    _write_project(workspace, [_item(ma, id="a"), _item(mb, id="b")], colorProvenance=1)
    failing = {"on": True}
    _failing_runs(monkeypatch, lambda cmd: failing["on"] and _ffprobe_of(sa)(cmd))

    first = cp.ensure_color_provenance(workspace)

    by_id = {it["id"]: it for it in _tracks0(_read(workspace))}
    assert by_id["b"]["src"] == sb, "the rest of the project still heals"
    assert by_id["a"]["src"] == ma, "an item whose original cannot be read is left as it is"
    assert [(s["id"], s["to"]) for s in first["switched"]] == [("b", sb)]
    assert _failed(first) == [("marker", "a", sa, "timeout")]
    assert any("screen.mp4 (timeout)" in line for line in first["log"]), first["log"]

    failing["on"] = False
    second = cp.ensure_color_provenance(workspace)

    assert [(s["id"], s["from"], s["to"]) for s in second["switched"]] == [("a", ma, sa)]
    assert second["probeFailed"] == []
    assert _tracks0(_read(workspace))[0]["src"] == sa


@needs_media
def test_pv57_a_normalized_src_that_cannot_be_read_is_kept_listed_and_checked_next_call(
        media, workspace, monkeypatch):
    other = _place(media, "testsrc.mp4", workspace / "other.mp4", 0)
    cache = _place(media, "screen_normalized_hdr_hlg_w203.mp4",
                   workspace / "screen_normalized_hdr_hlg_w203.mp4", 100)
    _write_project(workspace, [_item(other, id="foreign", normalizedSrc=cache, normalizedInPoint=0)],
                   colorProvenance=1)
    failing = {"on": True}
    _failing_runs(monkeypatch, lambda cmd: failing["on"] and _ffprobe_of(cache)(cmd))

    first = cp.ensure_color_provenance(workspace)

    assert first["dropped"] == []
    assert _tracks0(_read(workspace))[0]["normalizedSrc"] == cache
    assert _failed(first) == [("normalizedSrc", "foreign", cache, "timeout")]

    failing["on"] = False
    second = cp.ensure_color_provenance(workspace)

    assert [(d["id"], d["reason"]) for d in second["dropped"]] == [("foreign", "made from screen.mp4")]
    assert "normalizedSrc" not in _tracks0(_read(workspace))[0]


def test_pv57_no_ffprobe_at_all_writes_nothing_and_says_why(workspace, monkeypatch):
    monkeypatch.setattr(cp, "ffprobe_bin", lambda: "/nonexistent/montaj/ffprobe")
    clip = workspace / "clip.mp4"
    clip.write_bytes(b"not read")
    _write_project(workspace, [_item(str(clip))])
    before = (workspace / "project.json").read_bytes()

    result = cp.ensure_color_provenance(workspace)

    assert (workspace / "project.json").read_bytes() == before, "nothing is decided without a probe"
    assert result["error"] is None
    assert result["probeFailed"] and all(f["reason"] == "spawn" and "ENOENT" in f["detail"]
                                         for f in result["probeFailed"])


# ── PV57: an unreadable pool file defers the legacy match only when it could
#    change the answer: it passes the mtime guard and outranks the match ──────
#
# Content is testsrc for X, Y and Z; the candidate is its legacy conversion,
# named X_normalized_hdr_hlg.mp4, so X outranks Y (rank rule 1). Z is newer
# than the candidate (mtime guard). Only the named files fail to read.


def _unreadable(files, how):
    """`how`: 'probe' (ffprobe times out) or 'thumbnail' (ffmpeg exits 1)."""
    pick = _ffprobe_of if how == "probe" else _ffmpeg_reading
    checks = [pick(f) for f in files]
    return lambda cmd: any(c(cmd) for c in checks)


def _legacy_failed(result):
    return sorted((f["path"], f["reason"], f["blocking"]) for f in result["probeFailed"] if f["pass"] == "legacy")


@needs_media
@pytest.mark.parametrize("how", ["probe", "thumbnail"])
def test_pv57_an_unreadable_pool_file_that_outranks_the_match_defers_it_and_the_next_call_heals(
        media, workspace, monkeypatch, how):
    x = _place(media, "testsrc.mp4", workspace / "X.mp4", 10)   # the better-ranked original
    y = _place(media, "testsrc.mp4", workspace / "Y.mp4", 0)    # the match found
    z = _place(media, "testsrc.mp4", workspace / "Z.mp4", 200)  # newer than the candidate: never a match
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])
    x_fails = {"on": True}
    x_check, z_check = _unreadable([x], how), _ffprobe_of(z)
    _failing_runs(monkeypatch, lambda cmd: (x_fails["on"] and x_check(cmd)) or z_check(cmd))

    first = cp.ensure_color_provenance(workspace)

    project = _read(workspace)
    assert _tracks0(project)[0]["src"] == conv, "not switched to Y while X, which outranks it, is unread"
    assert first["switched"] == []
    assert "colorProvenance" not in project["settings"]
    entry = _candidate(first, conv)
    assert entry["original"] is None and entry["deferred"] == y
    assert first["kept"] == []
    x_reason = "timeout" if how == "probe" else "thumbnail"
    assert _legacy_failed(first) == [(x, x_reason, True), (z, "timeout", False)]
    assert all(f["src"] == conv for f in first["probeFailed"] if f["path"] in (x, z))

    x_fails["on"] = False
    second = cp.ensure_color_provenance(workspace)

    assert [(s["from"], s["to"], s["pass"]) for s in second["switched"]] == [(conv, x, "legacy")]
    project = _read(workspace)
    assert _tracks0(project)[0]["src"] == x
    assert project["settings"]["colorProvenance"] == 1, "Z is still unreadable, and cannot matter"
    assert _legacy_failed(second) == [(z, "timeout", False)]


@needs_media
@pytest.mark.parametrize("case", ["newer than the candidate", "ranks below the match, probe",
                                  "ranks below the match, thumbnail"])
def test_pv57_an_unreadable_pool_file_that_cannot_change_the_answer_does_not_block_the_switch(
        media, workspace, monkeypatch, case):
    """The other side of the rule. Deferring here would block the heal for as
    long as the file stays unreadable, which for a damaged file is forever."""
    x = _place(media, "testsrc.mp4", workspace / "X.mp4", 10)
    if case == "newer than the candidate":
        bad = _place(media, "testsrc.mp4", workspace / "W.mp4", 200)
        fails, reason = _unreadable([bad], "probe"), "timeout"
    else:
        bad = _place(media, "testsrc.mp4", workspace / "Y.mp4", 0)  # older, but X outranks it
        how = case.rsplit(", ", 1)[1]
        fails, reason = _unreadable([bad], how), ("timeout" if how == "probe" else "thumbnail")
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])
    _failing_runs(monkeypatch, fails)

    result = cp.ensure_color_provenance(workspace)

    project = _read(workspace)
    assert project["settings"].get("colorProvenance") == 1, "the answer is the one a full read gives"
    assert [(s["from"], s["to"], s["pass"]) for s in result["switched"]] == [(conv, x, "legacy")]
    assert _tracks0(project)[0]["src"] == x
    assert _candidate(result, conv)["deferred"] is None
    assert _legacy_failed(result) == [(bad, reason, False)]


@needs_media
def test_pv57_no_match_is_final_when_the_only_unreadable_pool_file_is_newer_than_the_candidate(
        media, workspace, monkeypatch):
    """A file newer than the candidate can never match, so it does not keep the pass unfinished."""
    _place(media, "other.mp4", workspace / "other.mp4", 0)  # same fingerprint, different content
    w = _place(media, "testsrc.mp4", workspace / "W.mp4", 200)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])
    _failing_runs(monkeypatch, _ffprobe_of(w))

    result = cp.ensure_color_provenance(workspace)

    project = _read(workspace)
    assert project["settings"].get("colorProvenance") == 1
    assert result["kept"] == ["X_normalized_hdr_hlg.mp4"]
    assert _tracks0(project)[0]["src"] == conv
    assert _legacy_failed(result) == [(w, "timeout", False)]


# ── PV57 review: PERMANENT reasons (no-stream, exit, parse) never block ──────
#
# A music bed can never be a video's original, and a corrupt file will never
# read differently — retrying either forever would stall the legacy pass for
# good. Real media throughout: a real audio-only file (ffprobe -select_streams
# v:0 truly returns no streams) and real garbage bytes (ffprobe truly exits
# non-zero), not a stubbed ProbeError.


def _no_stream_audio(dest):
    """A real audio-only .mp4 — a music bed. ffprobe -select_streams v:0
    genuinely answers with no streams: a real ProbeError(reason='no-stream'),
    not a synthetic stub (measured: `streams: []`, exit 0)."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    _ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", str(dest))
    return str(dest)


def _garbage_file(dest):
    """Bytes that are not a container at all. ffprobe genuinely exits 1
    ("Invalid data found when processing input"): a real ProbeError(reason=
    'exit'), not a synthetic stub (measured against real ffprobe)."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(b"\x00\x01garbage, not a real media container\xff\xfe" * 4)
    return str(dest)


@needs_media
def test_pv57_a_real_no_stream_pool_file_that_outranks_the_match_does_not_block_the_switch(media, workspace):
    """The reviewer's nostream_pool.py/nostream_match.py, as real repros: a
    real music bed named to rank ahead of the true match by naming alone
    (same setup as test_pv57_..._outranks_the_match_..._defers_it, which uses
    a TRANSIENT failure to prove the opposite — that one DOES defer) must not
    stall the legacy pass. 'no-stream' is PERMANENT and never blocks."""
    music = _no_stream_audio(workspace / "X.mp4")  # ranks ahead by name; can never be read
    os.utime(music, (_T0 + 10, _T0 + 10))
    y = _place(media, "testsrc.mp4", workspace / "Y.mp4", 0)  # the real match
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    project = _read(workspace)
    assert [(s["from"], s["to"], s["pass"]) for s in result["switched"]] == [(conv, y, "legacy")]
    assert _tracks0(project)[0]["src"] == y
    assert project["settings"]["colorProvenance"] == 1, "a music bed must not stall the pass forever"
    assert _candidate(result, conv)["deferred"] is None
    assert _legacy_failed(result) == [(music, "no-stream", False)]


@needs_media
def test_pv57_a_real_garbage_pool_file_older_than_the_match_does_not_block_the_switch(media, workspace):
    """A real truncated/garbage file on disk, older than the candidate and
    ranked ahead of the true match by naming, must not block the switch:
    'exit' is PERMANENT too (PV57 review, controller decision)."""
    garbage = _garbage_file(workspace / "X.mp4")  # ranks ahead by name; can never be read
    os.utime(garbage, (_T0 + 10, _T0 + 10))
    y = _place(media, "testsrc.mp4", workspace / "Y.mp4", 0)
    conv = _place(media, "legacy.mp4", workspace / "X_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(conv)])

    result = cp.ensure_color_provenance(workspace)

    project = _read(workspace)
    assert [(s["from"], s["to"], s["pass"]) for s in result["switched"]] == [(conv, y, "legacy")]
    assert _tracks0(project)[0]["src"] == y
    assert project["settings"]["colorProvenance"] == 1
    assert _legacy_failed(result) == [(garbage, "exit", False)]


@needs_media
def test_pv57_a_candidate_failing_exit_is_final_for_it_not_unfinished(media, workspace):
    """The legacy-candidate item's OWN file (not a pool file) fails to probe
    with a PERMANENT reason: not a candidate, logged with blocking=False, and
    the pass still completes — rather than staying unfinished forever over a
    file that will always fail the same way (PV57 review, controller
    decision: 'an item's own file failing exit/parse makes the heal final for
    it, not unfinished')."""
    corrupt = _garbage_file(workspace / "X_normalized_hdr_hlg.mp4")
    os.utime(corrupt, (_T0 + 100, _T0 + 100))
    _write_project(workspace, [_item(corrupt)])

    result = cp.ensure_color_provenance(workspace)

    project = _read(workspace)
    assert project["settings"].get("colorProvenance") == 1, \
        "a candidate that will never read must not stay unfinished forever"
    assert result["switched"] == []
    assert _legacy_failed(result) == [(corrupt, "exit", False)]


@needs_media
def test_pv57_each_unreadable_file_is_probed_at_most_twice_per_heal(media, workspace, monkeypatch):
    """PV57 review (RISK): _prefetch used to run before _HealProbe existed,
    and legacy_pool's own warm went through probe_media rather than the
    heal's own probe — so an item's own unreadable src, and an unreadable
    pool file, were each probed 4 times in one heal (2 for the warm's own
    transient retry, 2 more paid again by the real call), not 2."""
    bad_item = _place(media, "testsrc.mp4", workspace / "bad_item.mp4", 10)
    bad_pool = _place(media, "testsrc.mp4", workspace / "bad_pool.mp4", 0)
    conv = _place(media, "legacy.mp4", workspace / "cand_normalized_hdr_hlg.mp4", 100)
    _write_project(workspace, [_item(bad_item, id="a"), _item(conv, id="b")])

    bad_realpaths = {os.path.realpath(bad_item), os.path.realpath(bad_pool)}
    calls = {"n": 0}
    real_run = subprocess.run

    def run(cmd, **kw):
        if os.path.basename(cmd[0]).startswith("ffprobe") and os.path.realpath(cmd[-1]) in bad_realpaths:
            calls["n"] += 1
            raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
        return real_run(cmd, **kw)

    shim = types.ModuleType("subprocess")
    shim.__dict__.update({k: v for k, v in vars(subprocess).items() if not k.startswith("__")})
    shim.run = run
    monkeypatch.setattr(cp, "subprocess", shim)

    cp.ensure_color_provenance(workspace)

    assert calls["n"] == 4, ("bad_item.mp4 and bad_pool.mp4, one retry (2 tries) each = 4 ffprobe "
                             f"invocations for the whole heal, not 8; got {calls['n']}")


def test_pv57_probe_failed_entries_carry_message_and_retryable_matching_is_probe_retryable(workspace, monkeypatch):
    """PV57 review nit: the heal's probeFailed entries used to lack `message`
    and `retryable`, unlike serve.routes.steps.probe_failed_body's shape for
    the 'proxies' entries broadcast under the same `event: probe-failed` —
    align them, and ENOENT (ProbeError.errno) must still carry through to a
    non-retryable message here too."""
    monkeypatch.setattr(cp, "ffprobe_bin", lambda: "/nonexistent/montaj/ffprobe")
    clip = workspace / "clip.mp4"
    clip.write_bytes(b"not read")
    _write_project(workspace, [_item(str(clip))])

    result = cp.ensure_color_provenance(workspace)

    assert result["probeFailed"]
    for f in result["probeFailed"]:
        assert f["reason"] == "spawn" and "ENOENT" in f["detail"]
        assert str(clip) in f["message"] and "(spawn)" in f["message"]
        assert f["retryable"] is False, "ENOENT (no ffprobe at all) is never retryable"
