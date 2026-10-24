"""lib/frame_sampling.py: frame k is the source frame on screen at k / fps.

Synthetic clips made with montaj's ffmpeg: 30 frames at 30 fps whose luma
counts the frame (16 + 7 * n), losslessly coded, in an mp4 and in a 1 ms
timebase mkv. Each is sampled at 10, 15 and 30 fps through the shared filter
and the frames that come out are read back by their luma.

Measured on these clips with ffmpeg 8.1.2, for contrast: fps=10 (round=near)
gives 1, 4, 7, ...; fps=15:round=up on the mkv gives 0, 1, 4, 6, 7, ...;
fps=30:round=up on the mkv repeats 1, 4, 7, ... and drops 2, 5, 8, ....
"""
import os
import subprocess

import pytest

from lib import frame_sampling as fs
from tests.conftest import FFMPEG_BIN, HAS_FFMPEG, skip_or_fail

N = 30


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    if not HAS_FFMPEG:
        skip_or_fail("ffmpeg is required to make the clips")
    d = tmp_path_factory.mktemp("sampling")
    src = f"nullsrc=s=32x32:r=30,geq=lum='16+N*7':cb=128:cr=128"
    out = {}
    for name, codec in (("mp4", ["-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p"]),
                        ("mkv", ["-c:v", "ffv1"])):
        path = d / f"count.{name}"
        subprocess.run([FFMPEG_BIN, "-v", "error", "-y", "-f", "lavfi", "-i", src, "-frames:v", str(N),
                        *codec, str(path)], check=True)
        out[name] = str(path)
    return out


def _sampled(path, fps):
    args, tone_mapped = fs.input_args(path, fps, 30)
    assert not tone_mapped
    raw = subprocess.run([FFMPEG_BIN, "-v", "error", "-nostdin", *args, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, check=True).stdout
    # gray is full range: luma 16 + 7n reads back as 7n * 255 / 219.
    return [round(raw[i * 1024 + 528] / (7 * 255 / 219)) for i in range(len(raw) // 1024)]


@pytest.mark.parametrize("container", ["mp4", "mkv"])
@pytest.mark.parametrize("fps, step", [(10, 3), (15, 2), (30, 1)])
def test_frame_k_is_the_one_on_screen_at_k_over_fps(clips, container, fps, step):
    assert _sampled(clips[container], fps) == list(range(0, N, step))


def test_the_filter_reads_the_first_video_stream():
    args, _ = fs.input_args("/clips/in.mov", 10, 30)
    assert args[:5] == ["-i", "/clips/in.mov", "-map", "0:v:0", "-vf"]
    # §563: a relative path goes absolute, so it is never read as a protocol.
    assert fs.input_args("in.mov", 10, 30)[0][1] == os.path.abspath("in.mov")
    assert args[5] == "setpts=PTS-STARTPTS-0.25/(30*TB),fps=10:round=up"


def test_fractional_rates_keep_their_digits():
    assert fs.sample_filter(10, 30000 / 1001) == "setpts=PTS-STARTPTS-0.25/(29.97002997*TB),fps=10:round=up"


@pytest.mark.parametrize("transfer, key", [("arib-std-b67", "hdr_hlg"), ("smpte2084", "hdr_pq")])
def test_hdr_is_tone_mapped_after_sampling(transfer, key):
    from lib.normalize import _build_tonemap_vf_to_sdr
    chain, tone_mapped = fs.video_filter(10, 30, transfer, after="scale=64:-2")
    assert tone_mapped and fs.tone_maps(transfer)
    assert chain == ",".join([fs.sample_filter(10, 30), _build_tonemap_vf_to_sdr(key)[0], "scale=64:-2"])


@pytest.mark.parametrize("transfer", [None, "bt709", "unknown", "smpte170m"])
def test_sdr_is_left_alone(transfer):
    chain, tone_mapped = fs.video_filter(10, 30, transfer)
    assert chain == fs.sample_filter(10, 30) and not tone_mapped
