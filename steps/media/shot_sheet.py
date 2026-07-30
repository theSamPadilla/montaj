#!/usr/bin/env python3
"""Sample N frames per detected shot and tile them into contact sheets.

Consumes a detect_shots JSON and produces sheets plus a tile index that maps
every tile back to (shot_index, frame_index). The index is what makes the
sheets machine-readable: whoever looks at a sheet can name which shot a tile
belongs to without guessing from position.

Multiple frames per shot is the point — one frame tells you the subject, three
tell you the action. A boot entering water, a camera pushing in, and an
on-screen element animating are all invisible in a single frame.
"""
import json, os, sys, argparse, shutil, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, run, check_output, ffmpeg_bin


def sample_offsets(start: float, end: float, n: int) -> list[float]:
    """Timestamps inside a shot, inset from both edges to avoid transition frames."""
    if n == 1:
        return [start + (end - start) * 0.5]
    lo, hi = 0.12, 0.88
    span = end - start
    return [start + span * (lo + (hi - lo) * i / (n - 1)) for i in range(n)]


def extract_frame(src: str, t: float, dest: str, width: int, timeout: int):
    run([ffmpeg_bin(), "-nostdin", "-loglevel", "error", "-ss", f"{t:.4f}",
         "-i", src, "-frames:v", "1", "-vf", f"scale={width}:-2", dest, "-y"],
        timeout=timeout)


def tile_sheet(work: str, count: int, cols: int, dest: str, timeout: int):
    """Tile the count frames written to work/f_0001.jpg.. into a single image.

    nb_frames is set explicitly to count (rather than left at the tile
    filter's default of "fill the whole grid") so a partial final sheet —
    fewer frames than cols*rows — still flushes a valid image with the
    leftover cells padded, instead of the filter stalling waiting for input
    that will never arrive.
    """
    rows = (count + cols - 1) // cols
    pattern = os.path.join(work, "f_%04d.jpg")
    run([ffmpeg_bin(), "-nostdin", "-loglevel", "error",
         "-start_number", "1", "-i", pattern,
         "-filter_complex", f"tile={cols}x{rows}:padding=4:color=white:nb_frames={count}",
         "-frames:v", "1", dest, "-y"], timeout=timeout)
    check_output(dest)


def build(src, shots, out_dir, frames_per_shot, cols, width, max_tiles, timeout):
    os.makedirs(out_dir, exist_ok=True)

    # Flat list of every tile we intend to render, in sheet order.
    plan = []
    for shot in shots:
        for j, t in enumerate(sample_offsets(shot["start"], shot["end"], frames_per_shot)):
            plan.append({"shot_index": shot["index"], "frame_index": j, "t": t})

    sheets = []
    for sheet_no, offset in enumerate(range(0, len(plan), max_tiles)):
        chunk = plan[offset:offset + max_tiles]
        work = tempfile.mkdtemp(prefix="shot_sheet_")
        try:
            for i, tile in enumerate(chunk):
                extract_frame(src, tile["t"], os.path.join(work, f"f_{i + 1:04d}.jpg"),
                              width, timeout)
            sheet_path = os.path.join(out_dir, f"sheet_{sheet_no + 1:02d}.jpg")
            tile_sheet(work, len(chunk), cols, sheet_path, timeout)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        sheets.append({
            "path": sheet_path,
            "cols": cols,
            "rows": (len(chunk) + cols - 1) // cols,
            "tiles": [
                {"shot_index": tile["shot_index"], "frame_index": tile["frame_index"],
                 "t": round(tile["t"], 3), "row": i // cols, "col": i % cols}
                for i, tile in enumerate(chunk)
            ],
        })

    return {"input": src, "frames_per_shot": frames_per_shot, "sheets": sheets}


def main():
    p = argparse.ArgumentParser(description="Tile N frames per detected shot into contact sheets")
    p.add_argument("--input", required=True, help="Source video file")
    p.add_argument("--shots", required=True, help="detect_shots JSON for this video")
    p.add_argument("--out-dir", required=True, help="Directory to write sheets into")
    p.add_argument("--frames-per-shot", type=int, default=3, help="Frames sampled per shot")
    p.add_argument("--cols", type=int, default=6, help="Tiles per row")
    p.add_argument("--width", type=int, default=200, help="Tile width in pixels")
    p.add_argument("--max-tiles", type=int, default=48, help="Tiles per sheet before splitting")
    p.add_argument("--timeout", type=int, default=600, help="Per-ffmpeg-call timeout in seconds")
    p.add_argument("--out", help="Write the index JSON here instead of stdout")
    args = p.parse_args()

    src = os.path.abspath(args.input)
    require_file(src)
    require_file(args.shots)

    with open(args.shots) as f:
        shots = json.load(f).get("shots", [])
    if not shots:
        fail("invalid_input", f"No shots in {args.shots}")
    if args.frames_per_shot < 1:
        fail("invalid_input", "--frames-per-shot must be at least 1")

    result = build(src, shots, os.path.abspath(args.out_dir), args.frames_per_shot,
                   args.cols, args.width, args.max_tiles, args.timeout)

    if args.out:
        with open(args.out, "w") as f:
            json.dump(result, f, indent=2)
        print(args.out)
    else:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
