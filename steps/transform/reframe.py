#!/usr/bin/env python3
"""Compute the rotation-aware reframe crop for placing a source in a target aspect.

Given a source video and a target aspect (the project canvas, e.g. 9:16), emits
the exact {sourceCrop, sourceWidth, sourceHeight} triple to write verbatim onto
a project clip item — or a null sourceCrop when the source already fits.

The point is that callers stop doing pixel math. probe_video reports CODED
dimensions: an iPhone portrait clip codes as 1920x1080 with a -90 rotation flag
but DISPLAYS 1080x1920. Gating a centered crop on the coded aspect ratio
therefore crops footage that was already vertical, squeezing it into a sliver
that the renderer faithfully stretches to fill the frame. This step gates and
computes off DISPLAY dimensions only — that substitution is the whole fix.

Sample aspect ratio (SAR) is deliberately not considered: probe_video,
lib/ingest.py and the renderer all reason in raw display dimensions, and
agreeing with them matters more here than anamorphic correctness.
"""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, require_cmd, ffprobe_bin
from normalize import probe_video

MODES = ("zoom",)   # 'thirds' / 'mix' framing are future work
EPS = 1e-6          # so a source exactly at the target aspect yields no crop, not w=0.9999999
CROP_DECIMALS = 4   # 9:16 out of 16:9 -> w 0.3164, x 0.3418 (sub-pixel even at 4K)


def parse_aspect(text):
    """Parse a 'W:H' aspect string (e.g. '9:16') into a float ratio.

    Raises ValueError on anything unparseable, zero, or negative.
    """
    parts = str(text).split(":")
    if len(parts) != 2:
        raise ValueError(f"expected W:H (e.g. 9:16), got {text!r}")
    try:
        w, h = float(parts[0]), float(parts[1])
    except ValueError:
        raise ValueError(f"expected numeric W:H (e.g. 9:16), got {text!r}")
    if w <= 0 or h <= 0:
        raise ValueError(f"aspect components must be positive, got {text!r}")
    return w / h


def compute_reframe(display_width, display_height, target_ar, mode="zoom"):
    """Return {sourceCrop, sourceWidth, sourceHeight} for display dims + target aspect.

    display_width/display_height are POST-rotation (probe_video's display_width /
    display_height), never the coded dims. sourceCrop is None when the source's
    display aspect is already at or narrower than the target — vertical footage
    on a vertical canvas needs no crop, and a source taller than the target is
    covered by the renderer as-is. Only horizontal cropping happens.
    """
    if mode not in MODES:
        raise ValueError(f"unsupported mode {mode!r}; supported: {list(MODES)}")
    if not display_width or not display_height or display_width <= 0 or display_height <= 0:
        raise ValueError(f"display dimensions must be positive, got {display_width}x{display_height}")
    if target_ar <= 0:
        raise ValueError(f"target aspect must be positive, got {target_ar}")

    display_ar = display_width / display_height

    if display_ar <= target_ar + EPS:
        crop = None
    else:
        w = target_ar / display_ar
        crop = {
            "x": round((1.0 - w) / 2.0, CROP_DECIMALS),
            "y": 0.0,
            "w": round(w, CROP_DECIMALS),
            "h": 1.0,
        }

    return {
        "sourceCrop": crop,
        "sourceWidth": display_width,
        "sourceHeight": display_height,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Compute the rotation-aware {sourceCrop, sourceWidth, sourceHeight} for reframing a source to a target aspect"
    )
    parser.add_argument("--input",  required=True,      help="Source video file")
    parser.add_argument("--target", default="9:16",     help="Target aspect as W:H — the project canvas, e.g. 9:16 or 16:9 (default: 9:16)")
    parser.add_argument("--mode",   default="zoom", choices=list(MODES),
                        help="Framing mode: 'zoom' = centered crop (default, and the only mode today)")
    args = parser.parse_args()

    require_cmd(ffprobe_bin())
    require_file(args.input)

    try:
        target_ar = parse_aspect(args.target)
    except ValueError as e:
        fail("invalid_params", f"Invalid --target: {e}")

    info = probe_video(args.input)
    if info is None:
        fail("probe_error", f"Cannot probe {args.input}")
    if not info.get("display_width") or not info.get("display_height"):
        fail("probe_error", f"No usable video dimensions in {args.input}")

    try:
        result = compute_reframe(info["display_width"], info["display_height"], target_ar, args.mode)
    except ValueError as e:
        fail("invalid_params", str(e))

    # Diagnostics for a human or agent reading the output — the three fields
    # above stay flat at the top so "write the returned spec verbatim" is
    # unambiguous.
    result["source"] = {
        "codedWidth":    info["width"],
        "codedHeight":   info["height"],
        "rotation":      info["rotation"],
        "displayAspect": round(info["display_width"] / info["display_height"], CROP_DECIMALS),
        "targetAspect":  round(target_ar, CROP_DECIMALS),
        "mode":          args.mode,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
