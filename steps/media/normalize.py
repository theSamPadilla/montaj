#!/usr/bin/env python3
"""Normalize audio loudness via ffmpeg loudnorm two-pass (LUFS targeting)."""
import json, math, mimetypes, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, ffmpeg_bin

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

    seek_flags = ["-ss", str(args.window_in), "-t", str(args.window_out - args.window_in)] if windowed else []

    # First pass: measure loudness
    r = run([ffmpeg_bin(), *seek_flags, "-i", args.input,
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

    # Second pass: apply with measured values for accurate linear normalization
    loudnorm_filter = (
        f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11"
        f":measured_I={stats['input_i']}:measured_TP={stats['input_tp']}"
        f":measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}"
        f":offset={stats['target_offset']}:linear=true:print_format=summary"
    )
    video_flag = [] if is_audio_only else ["-c:v", "copy"]
    run([ffmpeg_bin(), "-y", "-i", args.input, "-af", loudnorm_filter, *video_flag, out])

    check_output(out)
    print(out)

if __name__ == "__main__":
    main()
