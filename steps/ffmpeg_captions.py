#!/usr/bin/env python3
"""Burn static text captions into a video using ffmpeg drawtext."""
import os, sys, argparse, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run

POSITIONS = {
    "center": ("(w-text_w)/2", "(h-text_h)/2"),
    "top":    ("(w-text_w)/2", "50"),
    "bottom": ("(w-text_w)/2", "h-text_h-50"),
}

def main():
    parser = argparse.ArgumentParser(description="Burn static text captions into a video using ffmpeg drawtext")
    parser.add_argument("--input", required=True, help="Source video file")
    parser.add_argument("--text", required=True, help="Text to overlay")
    parser.add_argument("--fontsize", default="48", help="Font size in pixels")
    parser.add_argument("--position", default="center", choices=["center", "top", "bottom"],
                        help="Text position")
    parser.add_argument("--out", help="Output file path")
    args = parser.parse_args()

    require_file(args.input)
    ext = os.path.splitext(args.input)[1]
    out = args.out or f"{os.path.splitext(args.input)[0]}_ffmpeg_captions{ext}"
    x, y = POSITIONS[args.position]

    # Write text to temp file to avoid shell escaping issues
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
    tmp.write(args.text)
    tmp.close()

    try:
        run(["ffmpeg", "-y", "-i", args.input,
             "-vf", f"drawtext=textfile='{tmp.name}':fontsize={args.fontsize}:fontcolor=white:borderw=2:bordercolor=black:x={x}:y={y}",
             "-c:a", "copy", out])
    finally:
        os.unlink(tmp.name)

    check_output(out)
    print(out)

if __name__ == "__main__":
    main()
