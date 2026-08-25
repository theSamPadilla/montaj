"""Unit tests for lib.normalize.normalized_output_path (SP6b Task T3).

Pure string-building — no ffmpeg, no filesystem I/O — so unlike most of
tests/test_normalize.py this file has no HAS_FFMPEG gate and always runs.
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.look import MASTER_LOOK
from lib.normalize import normalized_output_path


def test_untagged_when_not_tonemapped():
    """A conformance-only re-encode (no color chain, or an HDR<->HDR / SDR->HDR
    conversion) carries no look tag — SP6b decision 7."""
    out = normalized_output_path("/videos/clip.mp4", "sdr_bt709", tonemapped=False)
    assert out == "/videos/clip_normalized_sdr_bt709.mp4"


def test_tagged_when_tonemapped():
    """An HDR source tone-mapped down to SDR through the Montaj Vivid LUT
    carries the current master look."""
    out = normalized_output_path("/videos/clip.mp4", "sdr_bt709", tonemapped=True)
    assert out == f"/videos/clip_normalized_sdr_bt709_{MASTER_LOOK}.mp4"


def test_hdr_target_gets_tagged_when_told_tonemapped():
    """The helper trusts the caller's `tonemapped` flag verbatim — it does no
    re-derivation of "was this really a tonemap" from `color_space` alone.
    (Real call sites never pass tonemapped=True for an HDR target — that
    combination can't arise from is_hdr(source) and color_space=='sdr_bt709'
    — this just pins that the helper itself is a dumb string builder.)"""
    out = normalized_output_path("/videos/clip.mp4", "hdr_hlg", tonemapped=True)
    assert out == f"/videos/clip_normalized_hdr_hlg_{MASTER_LOOK}.mp4"


def test_strips_only_the_final_extension():
    """rsplit('.', 1) on the whole path — a dotted directory or multi-dot
    filename only loses its trailing extension, not earlier dots."""
    out = normalized_output_path("/a/b.c/my.clip.mov", "sdr_bt709", tonemapped=True)
    assert out == f"/a/b.c/my.clip_normalized_sdr_bt709_{MASTER_LOOK}.mp4"


def test_relative_input_path_is_preserved_relative():
    out = normalized_output_path("clip.mp4", "sdr_bt709", tonemapped=False)
    assert out == "clip_normalized_sdr_bt709.mp4"
