"""One rule for sampling a video at a fixed rate, for the steps that track
through frames (track_pose, track_camera): frame k is the source frame on
screen at k / fps s, counted from the first frame.

ffmpeg's fps filter keeps, for each output slot, the last source frame whose
time rounds into it. With round=up, a source frame exactly on a slot's time
belongs to that slot, so slot k gets the frame shown at k / fps. Two details
make that hold on real files:
  - The default rounding (near) gives slot k the frame half a source frame
    later: 1, 4, 7 at 10 fps from 30, not 0, 3, 6.
  - Container timebases round frame times (an mkv's is 1 ms: 66.7 ms becomes
    67, which round=up at 15 fps pushes a slot late). Moving every frame a
    quarter of a source frame earlier, after starting the clock at the first
    frame, keeps each one clear of the slot edge it sits on.
Measured exact at 10, 15 and 30 fps from 30 fps sources, in a 1 ms-timebase
mkv and an mp4.

HDR sources (HLG or PQ, as phones record by default) are tone-mapped to SDR
Rec.709 with the default look's chain from lib/normalize, after sampling, so
only the frames kept are mapped.
"""
from lib.normalize import _build_tonemap_vf_to_sdr
from lib.types.colorspace import detect_from_transfer, is_hdr

# The video stream every sampler reads: the first one, never an attached
# picture or a second angle.
MAP_ARGS = ["-map", "0:v:0"]


def _num(x):
    return f"{float(x):.10g}"


def sample_filter(fps, rate):
    """The ffmpeg filter that keeps the frame on screen at each k / fps; rate is
    the source's frame rate."""
    return f"setpts=PTS-STARTPTS-0.25/({_num(rate)}*TB),fps={_num(fps)}:round=up"


def tone_maps(color_transfer):
    """Whether a source with this ffprobe color_transfer is tone-mapped (HLG or PQ)."""
    return is_hdr(detect_from_transfer(color_transfer))


def video_filter(fps, rate, color_transfer=None, after=None):
    """(filter chain, tone_mapped): sampling, then the HDR to SDR tone map when
    color_transfer (ffprobe's) is HLG or PQ, then `after` (e.g. a scale)."""
    chain = [sample_filter(fps, rate)]
    tone_mapped = tone_maps(color_transfer)
    if tone_mapped:
        chain.append(_build_tonemap_vf_to_sdr(detect_from_transfer(color_transfer))[0])
    if after:
        chain.append(after)
    return ",".join(chain), tone_mapped


def input_args(path, fps, rate, color_transfer=None, after=None):
    """ffmpeg arguments from -i to the filter chain, and whether it tone-maps."""
    chain, tone_mapped = video_filter(fps, rate, color_transfer, after)
    return ["-i", path, *MAP_ARGS, "-vf", chain], tone_mapped
