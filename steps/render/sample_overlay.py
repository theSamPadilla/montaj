#!/usr/bin/env python3
"""Render a single overlay JSX to PNG via Puppeteer (one frame, no composition).

Pass --measure to also return per-element bounding-box and overflow data as
inline JSON on stdout instead of a bare PNG path.
"""
import os, sys, argparse, subprocess

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from cli.deps import render_runtime_dir
from lib.common import node_child_env

# Resolve the render bundle at its runtime location, not the site-packages
# source copy. In prod `montaj install ui` runs `npm install` into the build
# cache (~/.cache/montaj/render); the site-packages copy has no node_modules,
# so pointing node at it crashes with "Cannot find package 'puppeteer'".
SAMPLE_FRAME_JS = os.path.join(render_runtime_dir(), "sample-frame.js")


def main():
    parser = argparse.ArgumentParser(
        description="Render one frame of an overlay JSX to PNG via Puppeteer"
    )
    parser.add_argument("--overlay",      default=None,   help="Absolute path to the JSX overlay file")
    parser.add_argument("--frame",        type=int, default=0,    help="Frame number to render (default: 0)")
    parser.add_argument("--duration",     type=int, default=None,
                        help="Overlay length in frames for the `duration` global. "
                             "Omit to preview steady state (end-of-life fades won't fire).")
    parser.add_argument("--fps",          type=int, default=30,
                        help="Frame rate for the `fps` global (default: 30). Pass the project's "
                             "settings.fps — spring() is tuned in wall-clock time, so sampling a "
                             "60fps project at 30 shows springs settling twice as fast as they will.")
    parser.add_argument("--width",        type=int, default=1080, help="Canvas width in pixels (default: 1080)")
    parser.add_argument("--height",       type=int, default=1920, help="Canvas height in pixels (default: 1920)")
    parser.add_argument("--props",        default="{}", help="Props JSON string (default: '{}')")
    parser.add_argument("--google-fonts", action="append", default=[],
                        help="Google Fonts to load: a family or spec (e.g. 'Syne:wght@800'), a comma list, or a JSON array. Repeat the flag for more. A family that does not load is a warning; the sample still renders.")
    parser.add_argument("--measure",      action="store_true",
                        help="Return bounding-box / overflow measurements as JSON instead of a bare PNG path")
    parser.add_argument("--out",          default=None,   help="Output PNG path")
    parser.add_argument("--jobs",         default=None,
                        help="PL89g: measure several overlays in one call instead: a JSON file of [{component, props, frame, "
                             "fps, width, height, googleFonts, duration, out}]. Prints {results, browsers}.")
    parser.add_argument("--lanes",        type=int, default=3, help="With --jobs: browsers side by side (default 3)")
    parser.add_argument("--no-measure",   action="store_true",
                        help="With --jobs: render each job's PNG only (no measurements), a page per overlay kept open "
                             "across its frames. Prints {results: [{pngPath} | {error, message}], browsers}.")
    parser.add_argument("--serve",        action="store_true",
                        help="Keep running: read a JSON list of jobs (as --jobs holds) per stdin line and answer each "
                             "with a line of {results, browsers}, rendering PNGs only, the browsers and each overlay's "
                             "page kept open between lines. Ends when stdin closes.")
    args = parser.parse_args()
    if args.serve:
        # stdin and stdout are the protocol: node reads and answers them directly
        sys.exit(subprocess.run(["node", SAMPLE_FRAME_JS, "--mode", "overlays", "--serve", "--lanes", str(args.lanes)],
                                check=False, env=node_child_env()).returncode)
    if args.jobs:
        _run_node(["node", SAMPLE_FRAME_JS, "--mode", "overlays" if args.no_measure else "measure", "--jobs", args.jobs,
                   "--lanes", str(args.lanes)])
    if not args.overlay or not args.out:
        parser.error("--overlay and --out are required (or --jobs)")

    cmd = [
        "node", SAMPLE_FRAME_JS,
        "--mode", "overlay",
        "--component", args.overlay,
        "--frame", str(args.frame),
        "--fps", str(args.fps),
        "--width", str(args.width),
        "--height", str(args.height),
        "--props", args.props,
        "--out", args.out,
    ]
    if args.duration is not None:
        cmd += ["--duration", str(args.duration)]
    # Every value as its own flag, untouched: sample-frame.js reads each one (§140).
    for fonts in args.google_fonts:
        cmd += ["--google-fonts", fonts]
    if args.measure:
        cmd.append("--measure")

    _run_node(cmd)


def _run_node(cmd):
    """Run the node sampler, pass its output through, and exit with its code."""
    result = subprocess.run(cmd, check=False, capture_output=True, env=node_child_env())
    sys.stdout.write(result.stdout.decode("utf-8", errors="replace"))
    sys.stdout.flush()
    sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
    sys.stderr.flush()
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
