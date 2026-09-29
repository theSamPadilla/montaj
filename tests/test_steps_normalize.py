"""`_normalize_sync` (behind POST /api/normalize) names and marks SDR-to-HDR outputs.

SDR white moved from 100 to 203 nits (PV42), so an SDR clip normalized into an
HDR project is named `_w203` and carries SDR_ORIGIN_MARKER; every other name is
unchanged. Real ffmpeg, tiny clips.
"""
import json
import shutil
import subprocess

import pytest

import lib.normalize as nm
from serve.routes.steps import _normalize_sync

from tests.conftest import HAS_FFMPEG  # the ffmpeg the code runs (PV52)

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


def _sdr_clip(path):
    subprocess.run([
        nm.ffmpeg_bin(), "-y", "-v", "error", "-f", "lavfi", "-i",
        "testsrc2=size=160x90:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-g", "30", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-bsf:v", "h264_metadata=transfer_characteristics=1:colour_primaries=1:matrix_coefficients=1",
        str(path),
    ], check=True, capture_output=True, timeout=60)


def _comment(path):
    r = subprocess.run([nm.ffprobe_bin(), "-v", "quiet", "-show_entries", "format_tags=comment",
                        "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(r.stdout).get("format", {}).get("tags", {}).get("comment")


def test_sdr_clip_into_hdr_hlg_is_named_w203_and_marked(tmp_path):
    src = tmp_path / "clip.mp4"
    _sdr_clip(src)
    res = _normalize_sync(str(src), "hdr_hlg", None)
    assert res["skipped"] is False
    assert res["path"] == str(tmp_path / "clip_normalized_hdr_hlg_w203.mp4")
    assert _comment(res["path"]) == nm.SDR_ORIGIN_MARKER + "clip.mp4"


def test_sdr_clip_into_sdr_keeps_its_name(tmp_path):
    src = tmp_path / "clip.mp4"
    _sdr_clip(src)
    subprocess.run([nm.ffmpeg_bin(), "-y", "-v", "error", "-i", str(src), "-c:v", "libx264",
                    "-pix_fmt", "yuv422p", "-g", "30", "-c:a", "aac",
                    "-color_trc", "bt709", str(tmp_path / "c2.mp4")], check=True, capture_output=True)
    res = _normalize_sync(str(tmp_path / "c2.mp4"), "sdr_bt709", None)
    assert res["skipped"] is False
    assert res["path"] == str(tmp_path / "c2_normalized_sdr_bt709.mp4")
