#!/usr/bin/env python3
"""Render the footage under one item as small blurred frames (frosted-glass plates).

An overlay is captured in its own transparent page and composited afterwards,
so CSS backdrop-filter inside it has nothing to blur. A glass shape shows a
plate frame instead: the project's video and image tracks for the item's range,
drawn by the export's own render path (montaj_assets/render/glass-plate.js),
scaled to a short edge, gaussian-blurred and written one JPEG per frame.

Plate frame n is screen frame round(start * fps) + n, the frame the overlay's
frame n is composited over, and there are round(end * fps) - round(start * fps)
of them: the overlay's own frame count (render.js collectPuppeteerSegments).
"""
import os, re, sys, argparse, subprocess, json

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from cli.deps import render_runtime_dir
from lib.common import node_child_env, fail, require_file
from lib.look import curve_ids
from lib.project_tracks import track_items

# The runtime copy of the render engine, as sample_frame.py resolves it: the
# site-packages copy has no node_modules.
GLASS_PLATE_JS = os.path.join(render_runtime_dir(), "glass-plate.js")

# A frame this step writes. Only these are cleared from the output folder.
FRAME_FILE = re.compile(r"^\d{4,}\.jpg$")


def _project_json(value):
    """A project folder resolves to the project.json inside it; anything else
    passes through. An id is resolved by serve before the step runs."""
    if os.path.isdir(value):
        return os.path.join(value, "project.json")
    return value


def _find_item(project, item_id):
    for track in track_items(project):
        for item in track or []:
            if isinstance(item, dict) and item.get("id") == item_id:
                return item
    return None


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def main():
    parser = argparse.ArgumentParser(
        description="Render the footage under an item as small blurred frames (frosted-glass plates)"
    )
    parser.add_argument("--project", required=True,
                        help="Absolute path to project.json, or the project folder")
    parser.add_argument("--item", required=True,
                        help="Id of the item the plate is for (normally the overlay item)")
    parser.add_argument("--short-edge", type=int, default=270,
                        help="Short edge of the plate in px; the long edge keeps the project's "
                             "aspect, both rounded to even (default 270)")
    parser.add_argument("--sigma", type=float, default=2.2,
                        help="Gaussian blur sigma in plate pixels (default 2.2; 0 = no blur)")
    parser.add_argument("--sdr-curve", default=None,
                        help="Look curve id for every HDR-to-SDR conversion (see lib/look.py::curve_ids()), "
                             "as render's --sdr-curve. Omit to use the default look.")
    parser.add_argument("--out", default=None,
                        help="Folder for the frames (default: <project_dir>/plates/<item>/)")
    args = parser.parse_args()

    project_path = os.path.abspath(_project_json(args.project))
    require_file(project_path)
    try:
        with open(project_path) as f:
            project = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        fail("invalid_project", f"Could not read project.json at {project_path}: {e}")

    item = _find_item(project, args.item)
    if item is None:
        fail("unknown_item",
             f"No item with the id \"{args.item}\" in {project_path}. "
             f"\"item\" takes the id of an item on one of the project's tracks, normally the overlay item.")
    if not (_is_number(item.get("start")) and _is_number(item.get("end"))) or item["end"] <= item["start"]:
        fail("invalid_item", f"Item \"{args.item}\" needs a numeric start and an end after it "
                             f"(start {item.get('start')!r}, end {item.get('end')!r}).")

    if args.short_edge < 2:
        fail("invalid_short_edge", f"--short-edge must be at least 2, got {args.short_edge}")
    if not (args.sigma >= 0 and _is_number(args.sigma)):
        fail("invalid_sigma", f"--sigma must be a number of at least 0, got {args.sigma}")
    if args.sdr_curve is not None and args.sdr_curve not in curve_ids():
        fail("invalid_sdr_curve",
             f"--sdr-curve '{args.sdr_curve}' is not a known look curve. Expected one of {curve_ids()}.")

    if args.out:
        out_dir = os.path.abspath(args.out)
    else:
        # The id becomes a folder name: one that is not a single plain segment
        # would land the frames somewhere else, so it needs an explicit --out.
        if args.item in ("", ".", "..") or "/" in args.item or "\\" in args.item:
            fail("invalid_item", f"Item id \"{args.item}\" cannot name a folder; pass --out.")
        out_dir = os.path.join(os.path.dirname(project_path), "plates", args.item)
    if os.path.exists(out_dir) and not os.path.isdir(out_dir):
        fail("invalid_out", f"--out {out_dir} exists and is not a folder")
    os.makedirs(out_dir, exist_ok=True)

    # A shorter range than last time must not leave the old tail behind, so the
    # count on disk is exact. Only frames this step names are removed.
    for name in os.listdir(out_dir):
        path = os.path.join(out_dir, name)
        if FRAME_FILE.match(name) and (os.path.islink(path) or os.path.isfile(path)):
            os.remove(path)  # a link goes as a link: ffmpeg must not write through it

    cmd = [
        "node", GLASS_PLATE_JS,
        "--project", project_path,
        "--item", args.item,
        "--short-edge", str(args.short_edge),
        "--sigma", str(args.sigma),
        "--out-dir", out_dir,
    ]
    if args.sdr_curve is not None:
        cmd += ["--sdr-curve", args.sdr_curve]

    result = subprocess.run(cmd, check=False, capture_output=True, env=node_child_env())
    sys.stdout.write(result.stdout.decode("utf-8", errors="replace"))
    sys.stdout.flush()
    sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
    sys.stderr.flush()
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
