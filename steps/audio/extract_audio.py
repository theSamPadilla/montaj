#!/usr/bin/env python3
"""Extract audio from a video file."""
import os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run

def main():
    parser = argparse.ArgumentParser(description="Extract audio track from a video file")
    parser.add_argument("--input", required=True, help="Source video file")
    parser.add_argument("--format", default="wav", choices=["wav", "mp3", "aac"],
                        help="Output audio format")
    parser.add_argument("--out", help="Output file path")
    args = parser.parse_args()

    require_file(args.input)
    out = args.out or f"{os.path.splitext(args.input)[0]}.{args.format}"

    codecs = {
        "wav": ["-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1"],
        "mp3": ["-vn", "-acodec", "libmp3lame", "-q:a", "2"],
        "aac": ["-vn", "-acodec", "aac", "-b:a", "192k"],
    }
    run(["ffmpeg", "-y", "-i", args.input, *codecs[args.format], out])

    check_output(out)
    print(out)

if __name__ == "__main__":
    main()
