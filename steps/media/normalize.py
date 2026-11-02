#!/usr/bin/env python3
"""Normalize audio loudness via ffmpeg loudnorm two-pass (LUFS targeting)."""
import json, math, mimetypes, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, ffmpeg_bin, ffprobe_bin, ff_seconds, ff_input

PRESETS = {
    "youtube":   -14,
    "podcast":   -16,
    "broadcast": -23,
}

# ffmpeg's loudnorm filter (print_format=json) always emits its pass-1
# measurements as JSON *strings*, and on fully silent input some of them come
# back as the bare tokens "-inf"/"inf" (confirmed empirically: input_i and
# input_tp go to -inf, target_offset goes to +inf on a digitally-silent
# clip). float() parses those fine, but json.dumps() would then write the
# literal token -Infinity/Infinity, which is not valid JSON -- nothing on the
# JS side (or any other strict JSON consumer) can parse it, and every
# downstream typed field silently becomes a string that crashes the first
# .toFixed() call. Clamp any non-finite reading to +/-LOUDNORM_BOUND, which
# mirrors ffmpeg's own -70 LUFS absolute silence-gate threshold (the exact
# value ffmpeg itself reports for input_thresh on silent input), so
# measure-only output is always strict, finite JSON.
LOUDNORM_BOUND = 70.0


def _loudnorm_number(raw):
    """Coerce one loudnorm pass-1 JSON string into a real, finite float."""
    value = float(raw)
    if math.isnan(value):
        return 0.0
    if not math.isfinite(value):
        return LOUDNORM_BOUND if value > 0 else -LOUDNORM_BOUND
    return value

# Output ceiling for the written file. loudnorm's own TP target does not hold after
# resampling and lossy encoding, so pass 2 ends in a limiter and the file is measured.
TP_CEILING = -1.0
STEP_RATES = (64, 96, 128, 160, 192, 256, 320, 384, 448, 512)  # standard lossy bitrates, kb/s
# Source codec -> encoder that keeps its family. Anything else gets the container's default.
LOSSY_ENCODERS = {"aac": "aac", "mp3": "libmp3lame", "opus": "libopus", "ac3": "ac3", "eac3": "eac3"}
LOSSLESS_ENCODERS = {"flac": "flac", "alac": "alac"}
MAX_KBPS = {"libmp3lame": 320, "ac3": 640, "eac3": 640}


def _probe_audio(path):
    """First audio stream's codec, rate, channels, bitrate (b/s) and the file's duration; Nones when unknown."""
    info = {"codec": None, "rate": None, "channels": None, "bitrate": None, "duration": None}
    r = run([ffprobe_bin(), "-v", "quiet", "-select_streams", "a:0", "-show_entries",
             "stream=codec_name,sample_rate,channels,bit_rate:format=duration", "-of", "json",
             ff_input(path)], check=False)
    try:
        data = json.loads(r.stdout)
    except (TypeError, ValueError):
        return info
    stream = (data.get("streams") or [{}])[0]
    for key, field in (("codec", "codec_name"), ("rate", "sample_rate"), ("channels", "channels"),
                       ("bitrate", "bit_rate")):
        raw = stream.get(field)
        if key == "codec":
            info[key] = raw
        else:
            try:
                info[key] = int(raw)
            except (TypeError, ValueError):
                pass
    try:
        info["duration"] = float((data.get("format") or {}).get("duration"))
    except (TypeError, ValueError):
        pass
    return info


def _audio_encode_args(info):
    """Encoder args that keep the source's quality: its codec family, and for lossy audio a bitrate
    at least the source's (standard step, floor 128k mono / 192k stereo). Lossless stays lossless."""
    codec = info["codec"] or ""
    if codec.startswith("pcm_"):
        return ["-c:a", codec]
    if codec in LOSSLESS_ENCODERS:
        return ["-c:a", LOSSLESS_ENCODERS[codec]]
    encoder = LOSSY_ENCODERS.get(codec)
    floor = 128 if (info["channels"] or 1) <= 1 else 192
    want = max(floor, -(-(info["bitrate"] or 0) // 1000))
    kbps = next((k for k in STEP_RATES if k >= want), STEP_RATES[-1])
    if encoder:
        kbps = min(kbps, MAX_KBPS.get(encoder, 512))
    return (["-c:a", encoder] if encoder else []) + ["-b:a", f"{kbps}k"]


def _measure_output(path):
    """Integrated loudness and true peak of a written file (loudnorm's pass-1 measurement)."""
    r = run([ffmpeg_bin(), "-i", ff_input(path), "-af", "loudnorm=print_format=json", "-f", "null", "-"],
            check=False)
    try:
        j = json.loads(r.stderr[r.stderr.rfind("{"):r.stderr.rfind("}") + 1])
        return _loudnorm_number(j["input_i"]), _loudnorm_number(j["input_tp"])
    except (ValueError, KeyError, TypeError):
        return None, None


def main():
    parser = argparse.ArgumentParser(description="Normalize audio loudness to a target LUFS level")
    parser.add_argument("--input", required=True, help="Video or audio file to normalize")
    parser.add_argument("--target", default="youtube",
                        choices=["youtube", "podcast", "broadcast", "custom"],
                        help="Platform preset. youtube=-14 LUFS, podcast=-16 LUFS, broadcast=-23 LUFS.")
    parser.add_argument("--lufs", type=float, default=-14,
                        help="Target LUFS. Used only when --target is 'custom'.")
    parser.add_argument("--out", help="Output file path")
    parser.add_argument("--measure-only", action="store_true",
                        help="Print pass-1 loudness stats as JSON and exit; skip pass 2 entirely "
                             "(no file written, --out not needed).")
    parser.add_argument("--window-in", type=float,
                        help="Measure only this window of --input (source seconds), applied as ffmpeg "
                             "seek flags on the measurement pass itself — native sample rate and channel "
                             "count are preserved. Must be paired with --window-out, and requires "
                             "--measure-only (windowed encoding is not supported).")
    parser.add_argument("--window-out", type=float,
                        help="End of the measurement window in source seconds. Must be paired with --window-in.")
    args = parser.parse_args()

    if (args.window_in is None) != (args.window_out is None):
        fail("invalid_args", "--window-in and --window-out must be used together")
    windowed = args.window_in is not None
    if windowed and not args.measure_only:
        fail("invalid_args",
             "--window-in/--window-out requires --measure-only; windowed encoding is not supported")

    require_file(args.input)
    target_lufs = args.lufs if args.target == "custom" else PRESETS[args.target]

    seek_flags = ["-ss", ff_seconds(args.window_in), "-t", ff_seconds(args.window_out - args.window_in)] if windowed else []

    # First pass: measure loudness
    r = run([ffmpeg_bin(), *seek_flags, "-i", ff_input(args.input),
             "-af", f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11:print_format=json",
             "-f", "null", "-"], check=False)

    stderr = r.stderr
    json_start = stderr.rfind("{")
    json_end = stderr.rfind("}") + 1
    if json_start == -1 or json_end == 0:
        fail("loudnorm_error", "Could not parse loudnorm measurement output")

    try:
        stats = json.loads(stderr[json_start:json_end])
    except json.JSONDecodeError as e:
        fail("loudnorm_error", f"Could not parse loudnorm JSON: {e}")

    if args.measure_only:
        print(json.dumps({
            "input_i": _loudnorm_number(stats["input_i"]),
            "input_tp": _loudnorm_number(stats["input_tp"]),
            "input_lra": _loudnorm_number(stats["input_lra"]),
            "input_thresh": _loudnorm_number(stats["input_thresh"]),
            "target_offset": _loudnorm_number(stats["target_offset"]),
            "target_i": target_lufs,
        }))
        return

    ext = os.path.splitext(args.input)[1]
    out = args.out or f"{os.path.splitext(args.input)[0]}_normalized{ext}"

    # Detect audio-only input to skip -c:v copy
    mime = mimetypes.guess_type(args.input)[0] or ""
    is_audio_only = mime.startswith("audio/")

    # Silent input (ffmpeg measures digital silence as input_i -inf, or anything
    # at or under loudnorm's -70 LUFS absolute gate): there is nothing to
    # normalize, and pass 2 would hand `measured_I=-inf` back to loudnorm, which
    # rejects it ("Result too large"). Pass the media through unchanged.
    try:
        measured_i = float(stats["input_i"])
    except (TypeError, ValueError):
        measured_i = None
    if measured_i is not None and not measured_i > -LOUDNORM_BOUND:
        run([ffmpeg_bin(), "-y", "-i", ff_input(args.input), "-c", "copy", out])
        check_output(out)
        print(out)
        return

    # Second pass: apply with measured values for accurate linear normalization. Each one goes into the
    # filter graph, so it must be a number: text read back from stderr could add a filter (§563).
    try:
        measured = {k: float(stats[k]) for k in
                    ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
    except (KeyError, TypeError, ValueError):
        fail("loudnorm_error", "loudnorm measurement is not a number")
    info = _probe_audio(args.input)
    rate = info["rate"] or 48000
    video_flag = [] if is_audio_only else ["-c:v", "copy"]
    # loudnorm runs at 192 kHz inside, so without a resample the encoder picks the nearest rate it
    # supports (96 kHz) and a default bitrate. Quiet speech needs more gain than its true peak
    # allows, so loudnorm gives up on linear mode, and resampling plus lossy encoding add overs.
    # Chain: loudnorm (gain), resample to the input's rate, limiter at 4x the rate (true-peak safe,
    # sample-peak limiting alone misses inter-sample peaks), back to the rate. The written file is then
    # measured, and pass 2 re-run once with 1 dB more headroom (0.3 dB first) if its true peak is over the ceiling.
    # No soxr in this ffmpeg, so aresample gets a longer filter.
    resample = f"aresample={rate}:filter_size=64:phase_shift=15"
    duration_flag = ["-t", f"{info['duration']:.6f}"] if info["duration"] else []

    def pass_two(headroom):
        loudnorm_filter = (
            f"loudnorm=I={float(target_lufs)}:TP={TP_CEILING - 0.5 - headroom}:LRA=11"
            f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
            f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
            f":offset={measured['target_offset']}:linear=true:print_format=summary"
        )
        limit = 10 ** ((TP_CEILING - headroom) / 20)
        chain = (f"{loudnorm_filter},{resample},aresample={rate * 4},"
                 f"alimiter=limit={limit:.5f}:attack=3:release=40:level=0,{resample}")
        run([ffmpeg_bin(), "-y", "-i", ff_input(args.input), "-af", chain, *video_flag,
             *_audio_encode_args(info), *duration_flag, out])

    pass_two(0.3)
    _, tp = _measure_output(out)
    if tp is not None and tp > TP_CEILING:
        pass_two(1.3)

    check_output(out)
    print(out)

if __name__ == "__main__":
    main()
