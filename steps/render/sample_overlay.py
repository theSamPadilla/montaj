#!/usr/bin/env python3
"""Render a single overlay JSX to PNG via Puppeteer (one frame, no composition).

Pass --measure to also return per-element bounding-box and overflow data as
inline JSON on stdout instead of a bare PNG path.
"""
import os, sys, argparse, subprocess

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SAMPLE_FRAME_JS = os.path.join(MONTAJ_ROOT, "montaj_assets", "render", "sample-frame.js")


def main():
    parser = argparse.ArgumentParser(
        description="Render one frame of an overlay JSX to PNG via Puppeteer"
    )
    parser.add_argument("--overlay",      required=True,  help="Absolute path to the JSX overlay file")
    parser.add_argument("--frame",        type=int, default=0,    help="Frame number to render (default: 0)")
    parser.add_argument("--width",        type=int, default=1080, help="Canvas width in pixels (default: 1080)")
    parser.add_argument("--height",       type=int, default=1920, help="Canvas height in pixels (default: 1920)")
    parser.add_argument("--props",        default="{}", help="Props JSON string (default: '{}')")
    parser.add_argument("--google-fonts", default="",   help="Comma-separated Google Fonts spec (e.g. 'Syne:wght@800')")
    parser.add_argument("--measure",      action="store_true",
                        help="Return bounding-box / overflow measurements as JSON instead of a bare PNG path")
    parser.add_argument("--out",          required=True,  help="Output PNG path")
    args = parser.parse_args()

    cmd = [
        "node", SAMPLE_FRAME_JS,
        "--mode", "overlay",
        "--component", args.overlay,
        "--frame", str(args.frame),
        "--fps", "30",
        "--width", str(args.width),
        "--height", str(args.height),
        "--props", args.props,
        "--out", args.out,
    ]
    if args.google_fonts:
        cmd += ["--google-fonts", args.google_fonts]
    if args.measure:
        cmd.append("--measure")

    result = subprocess.run(cmd, check=False, capture_output=True)
    sys.stdout.write(result.stdout.decode("utf-8", errors="replace"))
    sys.stdout.flush()
    sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
    sys.stderr.flush()
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
