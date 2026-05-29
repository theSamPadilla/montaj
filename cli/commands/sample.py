#!/usr/bin/env python3
"""montaj sample — render a preview PNG without a full render.

Two subcommands:
  montaj sample overlay <overlay.jsx> [options]  -- one frame, overlay only
  montaj sample frame   <project.json> --at <s>  -- fully composited frame
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
                           metavar="{overlay,frame}")

    # --- montaj sample overlay <overlay.jsx> [options] ---
    p_ov = sub.add_parser("overlay",
                          help="Render one frame of an overlay JSX to PNG via Puppeteer (~3s)")
    p_ov.add_argument("overlay", help="Absolute path to the overlay JSX file")
    p_ov.add_argument("--frame",        type=int, default=0,
                      help="Frame number to render (default: 0)")
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
        "--width", str(args.width),
        "--height", str(args.height),
        "--props", args.props,
        "--out", args.out,
    ]
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
