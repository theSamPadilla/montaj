#!/usr/bin/env python3
"""montaj sample: render a preview PNG without a full render, or compare
sampled frames without rendering at all.

Three subcommands:
  montaj sample overlay <overlay.jsx> [options]  -- one frame, overlay only
  montaj sample frame   <project.json> --at <s>  -- fully composited frame
  montaj sample diff    <a.png> <b.png> [...]    -- compare consecutive frames for pops/jumps
"""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser(
        "sample",
        help="Render a preview PNG from an overlay or a composited project frame",
    )

    sub = p.add_subparsers(dest="subcommand", required=True,
                           metavar="{overlay,frame,diff}")

    # --- montaj sample overlay <overlay.jsx> [options] ---
    p_ov = sub.add_parser("overlay",
                          help="Render one frame of an overlay JSX to PNG via Puppeteer (~3s)")
    p_ov.add_argument("overlay", help="Absolute path to the overlay JSX file")
    p_ov.add_argument("--frame",        type=int, default=0,
                      help="Frame number to render (default: 0)")
    p_ov.add_argument("--duration",     type=int, default=None,
                      help="Overlay length in frames for the `duration` global. "
                           "Omit to preview steady state (end-of-life fades won't fire).")
    p_ov.add_argument("--fps",          type=int, default=30,
                      help="Frame rate for the `fps` global (default: 30). Pass the "
                           "project's settings.fps -- spring() is tuned in wall-clock "
                           "time, so sampling a 60fps project at the 30 default shows "
                           "springs settling twice as fast as they actually will.")
    p_ov.add_argument("--width",        type=int, default=1080,
                      help="Canvas width in pixels (default: 1080)")
    p_ov.add_argument("--height",       type=int, default=1920,
                      help="Canvas height in pixels (default: 1920)")
    p_ov.add_argument("--props",        default="{}",
                      help="Props JSON string (default: '{}')")
    p_ov.add_argument("--google-fonts", default="",
                      help="Comma-separated Google Fonts spec (e.g. 'Syne:wght@800')")
    p_ov.add_argument("--measure",      action="store_true",
                      help="Return per-element bounding-box / overflow data as JSON")
    add_global_flags(p_ov)
    p_ov.set_defaults(func=_handle_overlay)

    # --- montaj sample frame <project.json> --at <seconds> ---
    p_fr = sub.add_parser("frame",
                          help="Render a fully composited project frame at a timestamp to PNG (~10-30s)")
    p_fr.add_argument("project", help="Path to project.json")
    p_fr.add_argument("--at", type=float, required=True,
                      help="Timestamp in seconds to sample")
    add_global_flags(p_fr)
    p_fr.set_defaults(func=_handle_frame)

    # --- montaj sample diff <a.png> <b.png> [...] ---
    p_diff = sub.add_parser("diff",
                            help="Compare consecutive sampled frame PNGs for single-frame pops and jump cuts")
    p_diff.add_argument("frames", nargs="+",
                        help="Sampled frame PNGs in time order (>= 2). With exactly two, "
                             "reports that pair's diff only (the loop-seam check).")
    p_diff.add_argument("--spike-ratio", type=float, default=3.0,
                        help="How many times a pair's diff must exceed the comparison "
                             "diff before it is flagged as a pop or jump (default: 3.0)")
    p_diff.add_argument("--floor",       type=float, default=2.0,
                        help="Minimum luma diff (0-255 scale) a pair must clear before "
                             "it can be flagged as a pop or jump (default: 2.0)")
    add_global_flags(p_diff)
    p_diff.set_defaults(func=_handle_diff)


def _handle_overlay(args):
    if not os.path.isfile(args.overlay):
        emit_error("not_found", f"Overlay file not found: {args.overlay}")

    # --out is provided by add_global_flags; require it for overlay
    if not args.out:
        emit_error("missing_argument", "--out is required for 'sample overlay'")

    step_py = os.path.join(MONTAJ_ROOT, "steps", "render", "sample_overlay.py")
    cmd = [
        sys.executable, step_py,
        "--overlay", args.overlay,
        "--frame", str(args.frame),
        "--fps", str(args.fps),
        "--width", str(args.width),
        "--height", str(args.height),
        "--props", args.props,
        "--out", args.out,
    ]
    if args.duration is not None:
        cmd += ["--duration", str(args.duration)]
    if args.google_fonts:
        cmd += ["--google-fonts", args.google_fonts]
    if args.measure:
        cmd.append("--measure")

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)


def _handle_frame(args):
    project_path = args.project or (
        "project.json" if os.path.exists("project.json") else None
    )
    if not project_path or not os.path.isfile(project_path):
        emit_error("not_found", f"project.json not found: {args.project!r}")

    step_py = os.path.join(MONTAJ_ROOT, "steps", "render", "sample_frame.py")
    cmd = [
        sys.executable, step_py,
        "--project", project_path,
        "--at", str(args.at),
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)


def _handle_diff(args):
    if len(args.frames) < 2:
        emit_error("invalid_args", "sample diff requires at least 2 frame paths")

    step_py = os.path.join(MONTAJ_ROOT, "steps", "render", "sample_diff.py")
    cmd = [
        sys.executable, step_py,
        "--frames", *args.frames,
        "--spike-ratio", str(args.spike_ratio),
        "--floor", str(args.floor),
    ]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
