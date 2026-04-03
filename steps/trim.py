#!/usr/bin/env python3
"""Trim a video by start time and end time or duration."""
import os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run

def main():
    parser = argparse.ArgumentParser(description="Trim a video by start/end timestamps or duration")
    parser.add_argument("--input", required=True, help="Source video file")
    parser.add_argument("--start", default="0", help="Start time in seconds or HH:MM:SS")
    parser.add_argument("--end", help="End time in seconds or HH:MM:SS")
    parser.add_argument("--duration", help="Duration in seconds. Used only if --end is omitted.")
    parser.add_argument("--out", help="Output file path")
    args = parser.parse_args()

    require_file(args.input)
    ext = os.path.splitext(args.input)[1]
    out = args.out or f"{os.path.splitext(args.input)[0]}_trimmed{ext}"

    if args.end:
        flag = "-to" if ":" in args.end else "-t"
        run(["ffmpeg", "-y", "-ss", args.start, "-i", args.input, flag, args.end, "-c", "copy", out])
    elif args.duration:
        run(["ffmpeg", "-y", "-ss", args.start, "-i", args.input, "-t", args.duration, "-c", "copy", out])
    else:
        fail("invalid_argument", "Either --end or --duration is required")

    check_output(out)
    print(out)

if __name__ == "__main__":
    main()
