#!/usr/bin/env python3
"""Normalize a windowed segment of a video clip to project working color space + codec.

Uses input-level fast seek (-ss/-t before -i) so only the requested window is decoded.
Output starts at time 0 and is dense-keyframe conformant (same GOP contract as normalize).
"""
import os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file
from normalize import normalize_window


def main():
    parser = argparse.ArgumentParser(
        description="Normalize a windowed segment [inpoint, outpoint) of a video clip to the project color space"
    )
    parser.add_argument("--input",       required=True,                   help="Source video file")
    parser.add_argument("--inpoint",     required=True, type=float,       help="Start of window (seconds)")
    parser.add_argument("--outpoint",    required=True, type=float,       help="End of window (seconds)")
    parser.add_argument("--color-space", default="sdr_bt709",             help="Project color space key (default: sdr_bt709)")
    parser.add_argument("--out",         required=True,                   help="Output path for the normalized segment")
    args = parser.parse_args()

    require_file(args.input)

    out_path = normalize_window(
        args.input,
        args.out,
        args.color_space,
        args.inpoint,
        args.outpoint,
    )
    print(out_path)


if __name__ == "__main__":
    main()
