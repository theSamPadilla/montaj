#!/usr/bin/env python3
"""Resize/pad video to standard aspect ratios (9:16, 1:1, 16:9)."""
import os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run

FILTERS = {
    "9:16": "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
    "1:1":  "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black",
    "16:9": "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
}

def main():
    parser = argparse.ArgumentParser(description="Reframe a video to a standard aspect ratio with letterboxing")
    parser.add_argument("--input", required=True, help="Source video file")
    parser.add_argument("--ratio", required=True, choices=["9:16", "1:1", "16:9"],
                        help="Target aspect ratio")
    parser.add_argument("--out", help="Output file path")
    args = parser.parse_args()

    require_file(args.input)
    ext = os.path.splitext(args.input)[1]
    out = args.out or f"{os.path.splitext(args.input)[0]}_{args.ratio.replace(':', 'x')}{ext}"

    run(["ffmpeg", "-y", "-i", args.input, "-vf", FILTERS[args.ratio], "-c:a", "copy", out])

    check_output(out)
    print(out)

if __name__ == "__main__":
    main()
