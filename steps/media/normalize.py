#!/usr/bin/env python3
"""Normalize audio loudness via ffmpeg loudnorm two-pass (LUFS targeting)."""
import json, mimetypes, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run

PRESETS = {
    "youtube":   -14,
    "podcast":   -16,
    "broadcast": -23,
}

def main():
    parser = argparse.ArgumentParser(description="Normalize audio loudness to a target LUFS level")
    parser.add_argument("--input", required=True, help="Video or audio file to normalize")
    parser.add_argument("--target", default="youtube",
                        choices=["youtube", "podcast", "broadcast", "custom"],
                        help="Platform preset. youtube=-14 LUFS, podcast=-16 LUFS, broadcast=-23 LUFS.")
    parser.add_argument("--lufs", type=float, default=-14,
                        help="Target LUFS. Used only when --target is 'custom'.")
    parser.add_argument("--out", help="Output file path")
    args = parser.parse_args()

    require_file(args.input)
    ext = os.path.splitext(args.input)[1]
    out = args.out or f"{os.path.splitext(args.input)[0]}_normalized{ext}"
    target_lufs = args.lufs if args.target == "custom" else PRESETS[args.target]

    # Detect audio-only input to skip -c:v copy
    mime = mimetypes.guess_type(args.input)[0] or ""
    is_audio_only = mime.startswith("audio/")

    # First pass: measure loudness
    r = run(["ffmpeg", "-i", args.input,
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

    # Second pass: apply with measured values for accurate linear normalization
    loudnorm_filter = (
        f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11"
        f":measured_I={stats['input_i']}:measured_TP={stats['input_tp']}"
        f":measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}"
        f":offset={stats['target_offset']}:linear=true:print_format=summary"
    )
    video_flag = [] if is_audio_only else ["-c:v", "copy"]
    run(["ffmpeg", "-y", "-i", args.input, "-af", loudnorm_filter, *video_flag, out])

    check_output(out)
    print(out)

if __name__ == "__main__":
    main()
