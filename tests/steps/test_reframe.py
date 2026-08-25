"""Tests for steps/transform/reframe.py

Two layers:
  - Pure geometry (compute_reframe / parse_aspect) — no ffmpeg, no fixtures.
    This is where the regression that motivated the step is pinned.
  - End-to-end step runs against generated fixtures — skipped without ffmpeg.

The regression: probe_video reports CODED dimensions. A rotated iPhone clip
codes 1920x1080 with rotation=-90 but DISPLAYS 1080x1920. Gating a centered
9:16 crop on the coded aspect cropped already-vertical footage down to a
~228px sliver that the renderer then stretched across the frame.
"""
import importlib.util
import subprocess

import pytest

from tests.conftest import HAS_FFMPEG, REPO_ROOT, run_step, assert_json_output, assert_error

STEP_PY = str(REPO_ROOT / "steps" / "transform" / "reframe.py")


def _load_step_module():
    spec = importlib.util.spec_from_file_location("reframe_step", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod = _load_step_module()
compute_reframe = mod.compute_reframe
parse_aspect = mod.parse_aspect

NINE_SIXTEEN = 9 / 16          # 0.5625
SIXTEEN_NINE = 16 / 9
TOL = 1e-3                     # crop fractions are rounded to 4 decimals


# ── pure geometry ────────────────────────────────────────────────────────────

def test_landscape_16x9_to_9x16_centered_crop():
    r = compute_reframe(1920, 1080, NINE_SIXTEEN)
    crop = r["sourceCrop"]
    assert crop is not None
    assert abs(crop["w"] - 0.3164) < TOL
    assert abs(crop["x"] - 0.3418) < TOL
    assert crop["y"] == 0.0
    assert crop["h"] == 1.0
    # Centered: equal margins left and right.
    assert abs((1.0 - crop["w"]) / 2 - crop["x"]) < TOL
    assert r["sourceWidth"] == 1920
    assert r["sourceHeight"] == 1080


def test_rotated_iphone_display_dims_get_no_crop():
    """THE REGRESSION. The `Crux Astoria` case: coded 1920x1080 + rotation -90,
    display 1080x1920. Fed its DISPLAY dims, the step must return no crop.
    """
    r = compute_reframe(1080, 1920, NINE_SIXTEEN)
    assert r["sourceCrop"] is None
    assert r["sourceWidth"] == 1080
    assert r["sourceHeight"] == 1920


def test_coded_dims_would_have_cropped_the_rotated_clip():
    """Guard rail: prove the bug is a dims choice, not a math bug. Handing the
    same clip's CODED dims to the same function does produce the bad sliver —
    so the fix lives entirely in feeding it display dims.
    """
    bad = compute_reframe(1920, 1080, NINE_SIXTEEN)
    assert bad["sourceCrop"] is not None
    assert abs(bad["sourceCrop"]["w"] - 0.3164) < TOL


def test_true_portrait_source_gets_no_crop():
    r = compute_reframe(1080, 1920, NINE_SIXTEEN)
    assert r["sourceCrop"] is None


def test_square_to_9x16():
    r = compute_reframe(1080, 1080, NINE_SIXTEEN)
    crop = r["sourceCrop"]
    assert crop is not None
    assert abs(crop["w"] - 0.5625) < TOL
    assert abs(crop["x"] - 0.21875) < TOL
    assert crop["y"] == 0.0
    assert crop["h"] == 1.0


def test_source_exactly_target_aspect_gets_no_crop():
    """Epsilon behavior: a source already at the target must not pick up a
    w = 0.9999999 crop from float division."""
    r = compute_reframe(1080, 1920, NINE_SIXTEEN)
    assert r["sourceCrop"] is None
    # A non-power-of-two pair that hits the same ratio inexactly.
    assert compute_reframe(720, 1280, NINE_SIXTEEN)["sourceCrop"] is None
    assert compute_reframe(1179, 2096, 1179 / 2096)["sourceCrop"] is None


def test_source_taller_than_target_gets_no_crop():
    """9:19.5-ish footage on a 9:16 canvas: narrower than the target, so no
    crop. Vertical cropping is deliberately not implemented."""
    r = compute_reframe(1080, 2400, NINE_SIXTEEN)
    assert r["sourceCrop"] is None
    assert r["sourceWidth"] == 1080
    assert r["sourceHeight"] == 2400


def test_target_is_honored_not_hardcoded():
    """Nothing is pinned to 0.5625: the same sources behave differently against
    a 16:9 canvas."""
    # 9:16 source on a 16:9 canvas -> already far narrower than the target -> no crop.
    assert compute_reframe(1080, 1920, SIXTEEN_NINE)["sourceCrop"] is None
    # 1:1 source on a 16:9 canvas -> still narrower than the target -> no crop.
    # (Fitting a square to 16:9 would need a VERTICAL crop, which is out of scope.)
    assert compute_reframe(1080, 1080, SIXTEEN_NINE)["sourceCrop"] is None
    # ...but that same square DOES crop against the 9:16 canvas, per the test above.
    assert compute_reframe(1080, 1080, NINE_SIXTEEN)["sourceCrop"] is not None
    # A source wider than 16:9 crops against a 16:9 canvas.
    crop = compute_reframe(2560, 1080, SIXTEEN_NINE)["sourceCrop"]   # 2.37:1 ultrawide
    assert crop is not None
    assert abs(crop["w"] - SIXTEEN_NINE / (2560 / 1080)) < TOL
    assert abs(crop["x"] - (1 - crop["w"]) / 2) < TOL


def test_crop_maps_to_the_expected_pixel_window():
    """Sanity in pixel space: the fractions must describe a 9:16 window of the
    real source, i.e. 607.5px wide out of 1920 at 1080 tall."""
    crop = compute_reframe(1920, 1080, NINE_SIXTEEN)["sourceCrop"]
    px_w = crop["w"] * 1920
    px_h = crop["h"] * 1080
    assert abs(px_w - 607.5) < 1.0
    assert abs(px_w / px_h - NINE_SIXTEEN) < 1e-3


# ── parse_aspect + input validation ──────────────────────────────────────────

def test_parse_aspect_valid():
    assert abs(parse_aspect("9:16") - 0.5625) < 1e-9
    assert abs(parse_aspect("16:9") - 16 / 9) < 1e-9
    assert abs(parse_aspect("1:1") - 1.0) < 1e-9
    assert abs(parse_aspect("4:5") - 0.8) < 1e-9


@pytest.mark.parametrize("bad", ["", "9", "9:16:1", "wide", "9:0", "0:16", "-9:16", "9:-16", "9/16", "0.5625"])
def test_parse_aspect_rejects(bad):
    with pytest.raises(ValueError):
        parse_aspect(bad)


def test_compute_reframe_rejects_bad_mode():
    with pytest.raises(ValueError):
        compute_reframe(1920, 1080, NINE_SIXTEEN, mode="thirds")


@pytest.mark.parametrize("w,h", [(0, 1080), (1920, 0), (None, 1080), (1920, None), (-1920, 1080)])
def test_compute_reframe_rejects_bad_dims(w, h):
    with pytest.raises(ValueError):
        compute_reframe(w, h, NINE_SIXTEEN)


# ── end-to-end step ──────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def landscape_video(tmp_path_factory):
    """1-second 1920x1080 landscape clip, no rotation."""
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not available")
    d = tmp_path_factory.mktemp("reframe")
    out = d / "land.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30",
         "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)],
        check=True, capture_output=True,
    )
    return out


@pytest.fixture(scope="module")
def rotated_video(landscape_video, tmp_path_factory):
    """The same landscape clip remuxed with a -90 display matrix — coded
    1920x1080, displays 1080x1920, exactly like an iPhone vertical recording.

    `-display_rotation` needs ffmpeg 6+. If the tag doesn't actually land, skip
    rather than pass: a test that goes green because the fixture silently isn't
    rotated is worse than no test.
    """
    d = tmp_path_factory.mktemp("reframe_rot")
    out = d / "rot.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-display_rotation", "-90", "-i", str(landscape_video),
         "-c", "copy", str(out)],
        check=True, capture_output=True,
    )
    info = mod.probe_video(str(out))
    if info is None or abs(info.get("rotation") or 0) % 180 != 90:
        pytest.skip("ffmpeg did not apply -display_rotation; cannot build a rotated fixture")
    return out


def test_step_rotated_source_reports_no_crop(rotated_video):
    """End-to-end proof of the Crux Astoria case, through probe and all."""
    proc = run_step("reframe.py", "--input", str(rotated_video), "--target", "9:16")
    result = assert_json_output(proc)
    assert result["sourceCrop"] is None
    assert result["sourceWidth"] == 1080
    assert result["sourceHeight"] == 1920
    assert result["source"]["codedWidth"] == 1920
    assert result["source"]["codedHeight"] == 1080
    assert result["source"]["rotation"] == -90
    assert result["source"]["mode"] == "zoom"


def test_step_landscape_source_reports_centered_crop(landscape_video):
    proc = run_step("reframe.py", "--input", str(landscape_video), "--target", "9:16")
    result = assert_json_output(proc)
    crop = result["sourceCrop"]
    assert crop is not None
    assert abs(crop["w"] - 0.3164) < TOL
    assert abs(crop["x"] - 0.3418) < TOL
    assert crop["y"] == 0.0
    assert crop["h"] == 1.0
    assert result["sourceWidth"] == 1920
    assert result["sourceHeight"] == 1080
    assert result["source"]["rotation"] == 0


def test_step_defaults_to_9x16(landscape_video):
    proc = run_step("reframe.py", "--input", str(landscape_video))
    result = assert_json_output(proc)
    assert abs(result["source"]["targetAspect"] - 0.5625) < TOL
    assert abs(result["sourceCrop"]["w"] - 0.3164) < TOL


def test_step_stdout_is_json_only(landscape_video):
    """stdout carries the result and nothing else."""
    proc = run_step("reframe.py", "--input", str(landscape_video))
    assert_json_output(proc)
    assert proc.stdout.count("\n") == 1


def test_step_missing_input():
    proc = run_step("reframe.py", "--input", "/no/such/clip.mp4")
    assert_error(proc, "file_not_found")


def test_step_unparseable_target(landscape_video):
    proc = run_step("reframe.py", "--input", str(landscape_video), "--target", "wide")
    assert_error(proc, "invalid_params")


def test_step_zero_target(landscape_video):
    proc = run_step("reframe.py", "--input", str(landscape_video), "--target", "9:0")
    assert_error(proc, "invalid_params")
