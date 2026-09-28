#!/usr/bin/env python3
"""Contact sheet of a composited project: sample the project at a list of
times (sample_frame.py, no video encode) and tile the frames with a time
label under each. Small tile widths give the phone view; an explicit --at
list of consecutive frame times gives a frame strip."""
import argparse, json, os, subprocess, sys, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file  # noqa: E402

GUTTER = 4
LABEL_H = 18
SAMPLE_FRAME = os.path.join(os.path.dirname(__file__), "sample_frame.py")


def project_duration(project_path):
    with open(project_path) as f:
        proj = json.load(f)
    ends = [float(it.get("end", 0)) for tr in proj.get("tracks", []) for it in tr.get("items", [])]
    return max(ends) if ends else 0.0


def grid_times(duration, every):
    n = int(duration / every + 1e-9)
    times = [round(i * every, 4) for i in range(n)]
    return times or [0.0]


def _sample_frame(project, t, out):
    proc = subprocess.run([sys.executable, SAMPLE_FRAME, "--project", project, "--at", str(t), "--out", out],
                          capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.isfile(out):
        fail("sample_failed", f"sample_frame at {t}s failed: {proc.stderr.strip()[-400:]}")


def build(project, times, cols, tile_width, out, sampler=_sample_frame):
    from PIL import Image, ImageDraw
    with tempfile.TemporaryDirectory() as work:
        tiles = []
        for i, t in enumerate(times):
            p = os.path.join(work, f"f_{i:04d}.png")
            sampler(project, t, p)
            im = Image.open(p).convert("RGB")
            h = int(im.size[1] * tile_width / im.size[0] + 0.5)  # round half up
            tiles.append(im.resize((tile_width, h)))
        tile_h = tiles[0].size[1]
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * tile_width + (cols + 1) * GUTTER,
                                  rows * (tile_h + LABEL_H) + (rows + 1) * GUTTER), (255, 255, 255))
        draw = ImageDraw.Draw(sheet)
        for i, (t, tile) in enumerate(zip(times, tiles)):
            r, c = divmod(i, cols)
            x = GUTTER + c * (tile_width + GUTTER)
            y = GUTTER + r * (tile_h + LABEL_H + GUTTER)
            sheet.paste(tile, (x, y))
            draw.text((x + 2, y + tile_h + 3), f"{t:.2f}s", fill=(0, 0, 0))
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        sheet.save(out)
    return {"path": os.path.abspath(out), "times": list(times), "cols": cols, "tile_width": tile_width}


def main():
    ap = argparse.ArgumentParser(description="Contact sheet of a composited project from sampled frames")
    ap.add_argument("--project", required=True)
    ap.add_argument("--at", type=float, action="append", help="Sample time in seconds (repeatable)")
    ap.add_argument("--every", type=float, help="Sample every N seconds across the whole project")
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--tile-width", type=int, default=320)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    require_file(args.project)
    if not args.at and not args.every:
        fail("invalid_args", "pass --at (repeatable) or --every")
    if args.cols < 1 or args.tile_width < 16:
        fail("invalid_args", "--cols must be >= 1 and --tile-width >= 16")
    times = args.at or grid_times(project_duration(args.project), args.every)
    print(json.dumps(build(args.project, times, args.cols, args.tile_width, args.out)))


if __name__ == "__main__":
    main()
