#!/usr/bin/env python3
"""Render a fully composited frame from a project at a given timestamp to PNG.

Extracts the video frame, active image items, and active overlay JSXs at the
requested timestamp, composites them at project resolution, and writes a PNG.
"""
import os, sys, argparse, subprocess

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from cli.deps import render_runtime_dir
from lib.common import ffmpeg_bin, ffprobe_bin

# Resolve the render bundle at its runtime location, not the site-packages
# source copy. In prod `montaj install ui` runs `npm install` into the build
# cache (~/.cache/montaj/render); the site-packages copy has no node_modules,
# so pointing node at it crashes with "Cannot find package 'puppeteer'".
SAMPLE_FRAME_JS = os.path.join(render_runtime_dir(), "sample-frame.js")


def main():
    parser = argparse.ArgumentParser(
        description="Render a composited project frame at a given timestamp to PNG"
    )
    parser.add_argument("--project", required=True,
                        help="Absolute path to project.json")
    parser.add_argument("--at", type=float, required=True,
                        help="Timestamp in seconds to sample")
    parser.add_argument("--out", default=None,
                        help="Output PNG path (default: <project_dir>/render/samples/frame-<at>s.png)")
    args = parser.parse_args()

    # Build default output path if not specified.
    if args.out:
        out = args.out
    else:
        project_dir = os.path.dirname(os.path.abspath(args.project))
        samples_dir = os.path.join(project_dir, "render", "samples")
        os.makedirs(samples_dir, exist_ok=True)
        out = os.path.join(samples_dir, f"frame-{args.at}s.png")

    cmd = [
        "node", SAMPLE_FRAME_JS,
        "--mode", "frame",
        "--project", args.project,
        "--at", str(args.at),
        "--out", out,
    ]

    env = os.environ.copy()
    env["MONTAJ_FFMPEG"] = ffmpeg_bin()
    env["MONTAJ_FFPROBE"] = ffprobe_bin()

    result = subprocess.run(cmd, check=False, capture_output=True, env=env)
    sys.stdout.write(result.stdout.decode("utf-8", errors="replace"))
    sys.stdout.flush()
    sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
    sys.stderr.flush()
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
