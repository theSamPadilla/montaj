"""lib/color_provenance.py against the shared case table.

tests/fixtures/color_provenance_cases.json is also run by
montaj_assets/render/test/sdr-layer.test.mjs through sdr-layer.js, so the two
resolvers cannot drift apart without one of the two suites failing.
"""
import asyncio
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


# ── ensure_color_provenance: heal projects made before PV42 (T4b) ────────────
#
# Real ffmpeg media, small and short: 160x284, 30 fps, 3 s. Built once per
# module, then copied into each test's project folder with explicit mtimes.

HAS_ZSCALE = HAS_FFMPEG and nm._has_zscale()
needs_media = pytest.mark.skipif(not HAS_ZSCALE, reason="ffmpeg with zscale not available")

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
        pytest.skip("ffmpeg with zscale not available")
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
    line = "colour provenance: kept 1 converted clip(s) with no original: gone_normalized_hdr_hlg.mp4"
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
