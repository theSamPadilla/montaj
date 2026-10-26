#!/usr/bin/env python3
"""Render a fully composited frame from a project at a given timestamp to PNG.

Extracts the video frame, active image items, active overlay JSXs and the
captions (as the export draws them) at the requested timestamp, composites
them at project resolution, and writes a PNG.

With --scene, it renders one 3D alone instead, over the project's whole frame,
--at seconds into that 3D: a 3D no timeline item shows can be checked too.
"""
import os, re, sys, argparse, subprocess, json, tempfile

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from cli.deps import render_runtime_dir
from lib.common import node_child_env, fail, require_file, run_stopping
from lib.look import curve_ids
from lib.sheet import tile_sheet
from lib.types.colorspace import is_hdr, DEFAULT_COLOR_SPACE

# Resolve the render bundle at its runtime location, not the site-packages
# source copy. In prod `montaj install ui` runs `npm install` into the build
# cache (~/.cache/montaj/render); the site-packages copy has no node_modules,
# so pointing node at it crashes with "Cannot find package 'puppeteer'".
SAMPLE_FRAME_JS = os.path.join(render_runtime_dir(), "sample-frame.js")

# A 3D's id, the rule save_model and render/scene3d.js use.
SCENE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")

# Most times one call tiles into a sheet; more is contact_sheet's job.
MAX_SHEET_TIMES = 12
SHEET_COLS = 4
SHEET_TILE_WIDTH = 360


# PL89c: several times are a sheet, whose tiles are a few hundred px wide: their frames composite at the design canvas
# (short edge 1080, where the overlays render and the type floors are measured), not a 4K project's own size.
SHEET_SHORT_EDGE = 1080


def sample_frames(project, times, frames_dir, raw=False, scene=None, sdr_curve=None, prefer_proxy=False,
                  no_captions=False, timeout=None):
    """Render every time in ONE node process into frames_dir (f_0000.png...); return the paths in order. Several times
    (a sheet) composite at SHEET_SHORT_EDGE; one time keeps the project's size. The process gets `timeout` seconds,
    else 120 a time."""
    timeout = timeout if timeout is not None else 120 * len(times)
    cmd = ["node", SAMPLE_FRAME_JS, "--mode", "frame", "--project", project]
    for t in times:
        cmd += ["--at", str(t)]
    # One time takes the single-frame form (--out), which node insists on.
    cmd += ["--out", os.path.join(frames_dir, "f_0000.png")] if len(times) == 1 else ["--frames-dir", frames_dir]
    if prefer_proxy:
        cmd.append("--prefer-proxy")
    if raw:
        cmd.append("--raw")
    if no_captions:
        cmd.append("--no-captions")
    if scene is not None:
        cmd += ["--scene", scene]
    if sdr_curve is not None:
        cmd += ["--sdr-curve", sdr_curve]
    if len(times) > 1 and not raw:
        cmd += ["--max-short-edge", str(SHEET_SHORT_EDGE)]
    try:
        proc = run_stopping(cmd, timeout=timeout, env=node_child_env())
    except subprocess.TimeoutExpired:
        fail("sample_failed", f"sample_frame over {len(times)} times exceeded {timeout:g}s")
    err = proc.stderr.decode("utf-8", errors="replace").strip()[-400:]
    if proc.returncode != 0:
        fail("sample_failed", f"sample_frame failed: {err}")
    paths = proc.stdout.decode("utf-8", errors="replace").splitlines()
    if len(paths) != len(times):
        fail("sample_failed", f"sample_frame expected {len(times)} frame paths, got {len(paths)}: {err}")
    missing = [p for p in paths if not os.path.isfile(p)]
    if missing:
        fail("sample_failed", f"sample_frame reported frames that do not exist: {missing[0]}")
    return paths


def main():
    parser = argparse.ArgumentParser(
        description="Render a composited project frame at a given timestamp to PNG"
    )
    parser.add_argument("--project", required=True,
                        help="Absolute path to project.json")
    parser.add_argument("--at", type=float, required=True, action="append",
                        help="Timestamp in seconds to sample: timeline seconds, or with --scene, "
                             "seconds into that 3D. Repeat for several (up to 12): one sheet of "
                             "labelled tiles.")
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
    parser.add_argument("--raw", action="store_true",
                        help="Sample the untouched SOURCE frame under --at: the clip the timeline shows "
                             "there, decoded straight from its file, with no crop, zoom, fit, grade, "
                             "image items, overlays or captions. For reading the footage itself.")
    parser.add_argument("--no-captions", action="store_true",
                        help="Sample the frame without the captions overlay, so the picture under a caption can be read. "
                             "With --raw or --scene it changes nothing.")
    parser.add_argument("--out", default=None,
                        help="Output PNG path (default: <project_dir>/render/samples/frame-<at>s.png; "
                             "with several --at, the sheet: sheet-<first>-<last>s.png)")
    args = parser.parse_args()
    times = args.at
    if len(times) > MAX_SHEET_TIMES:
        fail("invalid_args", f"{len(times)} times > {MAX_SHEET_TIMES}; use contact_sheet for more.")

    if args.raw and args.scene is not None:
        fail("invalid_args", "--raw samples the timeline's source; it cannot combine with --scene.")

    if args.scene is not None:
        if args.scene != "" and not SCENE_ID.fullmatch(args.scene):
            fail("invalid_scene",
                 f"--scene must be a 3D id of lowercase letters, digits and -, or '' for the "
                 f"project's own (got {args.scene!r}).")
        for t in times:
            if t < 0:
                fail("invalid_at", f"--at must be 0 or more seconds into the 3D (got {t}).")

    # The project must exist BEFORE any makedirs: the default-output branch below creates
    # <project_dir>/render/samples, so a bogus --project would otherwise plant folders next to an
    # arbitrary path (low 14). require_file exits invalid_file for a missing/non-file project.
    require_file(args.project)

    # Build default output path if not specified.
    if args.out:
        out = args.out
    else:
        project_dir = os.path.dirname(os.path.abspath(args.project))
        samples_dir = os.path.join(project_dir, "render", "samples")
        os.makedirs(samples_dir, exist_ok=True)
        if len(times) > 1:
            span = f"{times[0]}-{times[-1]}s"
            if args.scene is None:
                name = f"sheet-{span}-raw.png" if args.raw else f"sheet-{span}.png"
            else:
                name = f"3d-{args.scene}-sheet-{span}.png" if args.scene else f"3d-sheet-{span}.png"
        elif args.scene is None:
            name = f"frame-{times[0]}s-raw.png" if args.raw else f"frame-{times[0]}s.png"
        else:
            name = f"3d-{args.scene}-{times[0]}s.png" if args.scene else f"3d-{times[0]}s.png"
        out = os.path.join(samples_dir, name)

    sdr_forward = None

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
            sdr_forward = args.sdr_curve
        else:
            # SDR projects have nothing to grade — the curve only feeds the
            # HDR->SDR LUT chain (see sample-frame.js's `hdrProject` gate). Not
            # forwarding it also keeps the JS cache key from splitting SDR
            # samples across curve values that never affected their pixels.
            sys.stderr.write(json.dumps({
                "warn": f"--sdr-curve '{args.sdr_curve}' ignored: project color space "
                        f"is '{color_space}' (SDR)",
            }) + "\n")

    if len(times) > 1:
        with tempfile.TemporaryDirectory() as work:
            paths = sample_frames(args.project, times, work, raw=args.raw, scene=args.scene,
                                  sdr_curve=sdr_forward, prefer_proxy=args.prefer_proxy,
                                  no_captions=args.no_captions)
            os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
            tile_sheet(paths, times, min(len(times), SHEET_COLS), SHEET_TILE_WIDTH, out)
        print(os.path.abspath(out))
        return

    cmd = ["node", SAMPLE_FRAME_JS, "--mode", "frame", "--project", args.project,
           "--at", str(times[0]), "--out", out]
    if args.prefer_proxy:
        cmd.append("--prefer-proxy")
    if args.raw:
        cmd.append("--raw")
    if args.no_captions:
        cmd.append("--no-captions")
    if args.scene is not None:
        cmd += ["--scene", args.scene]
    if sdr_forward is not None:
        cmd += ["--sdr-curve", sdr_forward]

    env = node_child_env()

    result = subprocess.run(cmd, check=False, capture_output=True, env=env)
    sys.stdout.write(result.stdout.decode("utf-8", errors="replace"))
    sys.stdout.flush()
    sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
    sys.stderr.flush()
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
