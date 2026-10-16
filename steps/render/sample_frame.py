#!/usr/bin/env python3
"""Render a fully composited frame from a project at a given timestamp to PNG.

Extracts the video frame, active image items, active overlay JSXs and the
captions (as the export draws them) at the requested timestamp, composites
them at project resolution, and writes a PNG.

With --scene, it renders one 3D alone instead, over the project's whole frame,
--at seconds into that 3D: a 3D no timeline item shows can be checked too.
"""
import os, re, sys, argparse, subprocess, json

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from cli.deps import render_runtime_dir
from lib.common import node_child_env, fail, require_file
from lib.look import curve_ids
from lib.types.colorspace import is_hdr, DEFAULT_COLOR_SPACE

# Resolve the render bundle at its runtime location, not the site-packages
# source copy. In prod `montaj install ui` runs `npm install` into the build
# cache (~/.cache/montaj/render); the site-packages copy has no node_modules,
# so pointing node at it crashes with "Cannot find package 'puppeteer'".
SAMPLE_FRAME_JS = os.path.join(render_runtime_dir(), "sample-frame.js")

# A 3D's id, the rule save_model and render/scene3d.js use.
SCENE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")


def main():
    parser = argparse.ArgumentParser(
        description="Render a composited project frame at a given timestamp to PNG"
    )
    parser.add_argument("--project", required=True,
                        help="Absolute path to project.json")
    parser.add_argument("--at", type=float, required=True,
                        help="Timestamp in seconds to sample: timeline seconds, or with --scene, "
                             "seconds into that 3D")
    parser.add_argument("--scene", default=None,
                        help="Sample one 3D alone over the project's whole frame instead of the "
                             "timeline: the id of a 3D saved under models/scenes/<id>/, or '' for the "
                             "project's own (models/active.json). --at is then seconds into it.")
    parser.add_argument("--sdr-curve", default=None,
                        help="Look curve id for the HDR-to-SDR grade (see lib/look.py::curve_ids()). "
                             "Meaningless on SDR projects: ignored with a stderr warning, not an "
                             "error. Omit to use the default look (natural1, what the editor "
                             "preview shows).")
    parser.add_argument("--prefer-proxy", action="store_true",
                        help="Decode each clip from its SDR proxy (proxySrc) instead of the master "
                             "when a proxy exists — a fast path for quick previews. The proxy is "
                             "already SDR, so no HDR tone-map is applied; do not combine with "
                             "--sdr-curve. Falls back to the master per clip when no proxy exists.")
    parser.add_argument("--out", default=None,
                        help="Output PNG path (default: <project_dir>/render/samples/frame-<at>s.png)")
    args = parser.parse_args()

    if args.scene is not None:
        if args.scene != "" and not SCENE_ID.match(args.scene):
            fail("invalid_scene",
                 f"--scene must be a 3D id of lowercase letters, digits and -, or '' for the "
                 f"project's own (got {args.scene!r}).")
        if args.at < 0:
            fail("invalid_at", f"--at must be 0 or more seconds into the 3D (got {args.at}).")

    # Build default output path if not specified.
    if args.out:
        out = args.out
    else:
        project_dir = os.path.dirname(os.path.abspath(args.project))
        samples_dir = os.path.join(project_dir, "render", "samples")
        os.makedirs(samples_dir, exist_ok=True)
        if args.scene is None:
            name = f"frame-{args.at}s.png"
        else:
            name = f"3d-{args.scene}-{args.at}s.png" if args.scene else f"3d-{args.at}s.png"
        out = os.path.join(samples_dir, name)

    cmd = [
        "node", SAMPLE_FRAME_JS,
        "--mode", "frame",
        "--project", args.project,
        "--at", str(args.at),
        "--out", out,
    ]

    if args.prefer_proxy:
        cmd.append("--prefer-proxy")

    if args.scene is not None:
        cmd += ["--scene", args.scene]

    if args.sdr_curve is not None:
        # Fail loudly here rather than let sample-frame.js's own manifest check
        # catch it — a typo'd curve id should be a clean step error, not a
        # subprocess exit code with a JSON blob buried in stderr.
        if args.sdr_curve not in curve_ids():
            fail("invalid_sdr_curve",
                 f"--sdr-curve '{args.sdr_curve}' is not a known look curve. "
                 f"Expected one of {curve_ids()}.")

        require_file(args.project)
        try:
            with open(args.project) as f:
                project = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            fail("invalid_project", f"Could not read project.json at {args.project}: {e}")
        color_space = (project.get("settings") or {}).get("colorSpace") or DEFAULT_COLOR_SPACE

        if is_hdr(color_space):
            cmd += ["--sdr-curve", args.sdr_curve]
        else:
            # SDR projects have nothing to grade — the curve only feeds the
            # HDR->SDR LUT chain (see sample-frame.js's `hdrProject` gate). Not
            # forwarding it also keeps the JS cache key from splitting SDR
            # samples across curve values that never affected their pixels.
            sys.stderr.write(json.dumps({
                "warn": f"--sdr-curve '{args.sdr_curve}' ignored: project color space "
                        f"is '{color_space}' (SDR)",
            }) + "\n")

    env = node_child_env()

    result = subprocess.run(cmd, check=False, capture_output=True, env=env)
    sys.stdout.write(result.stdout.decode("utf-8", errors="replace"))
    sys.stdout.flush()
    sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
    sys.stderr.flush()
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
