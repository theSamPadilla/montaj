#!/usr/bin/env python3
"""Tile a uniform time-grid of frames into filmstrip contact sheets.

Unlike shot_sheet (which samples frames per detected shot), filmstrip samples
frames on a fixed time grid across the whole video — the thumbnail strip a
timeline scrubber reads. Consumes no shot detection; the input is expected to
be an all-intra proxy so per-tile -ss stays cheap regardless of position.

Grid density is controlled by --max-tiles / --min-interval:
    interval = max(duration / max_tiles, min_interval)
so long videos get sparser sampling instead of unbounded tile counts, while
short videos never sample closer together than --min-interval.

Tiling itself ports steps/media/shot_sheet.py's tile_sheet() verbatim,
including its nb_frames guard: the ffmpeg tile filter defaults to expecting a
full cols*rows grid of input frames and stalls waiting for frames that will
never arrive if the last chunk is partial (fewer tiles than cols*rows), so
nb_frames is always set explicitly to the actual chunk size.
"""
import json, math, os, sys, argparse, shutil, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, run, check_output, get_duration, ffmpeg_bin


def extract_tile(src: str, t: float, dest: str, width: int, timeout: int):
    run([ffmpeg_bin(), "-nostdin", "-loglevel", "error", "-ss", f"{t:.4f}",
         "-i", src, "-frames:v", "1", "-vf", f"scale={width}:-2", dest, "-y"],
        timeout=timeout)


def tile_sheet(work: str, count: int, cols: int, dest: str, timeout: int):
    """Tile the count frames written to work/f_0001.jpg.. into a single image.

    nb_frames is set explicitly to count (rather than left at the tile
    filter's default of "fill the whole grid") so a partial final sheet —
    fewer frames than cols*rows — still flushes a valid image with the
    leftover cells padded, instead of the filter stalling waiting for input
    that will never arrive. Ported from shot_sheet.py unchanged.
    """
    rows = (count + cols - 1) // cols
    pattern = os.path.join(work, "f_%04d.jpg")
    run([ffmpeg_bin(), "-nostdin", "-loglevel", "error",
         "-start_number", "1", "-i", pattern,
         "-filter_complex", f"tile={cols}x{rows}:padding=4:color=white:nb_frames={count}",
         "-frames:v", "1", dest, "-y"], timeout=timeout)
    check_output(dest)


def tile_timestamps(duration: float, interval: float) -> list:
    """Timestamps on a uniform grid across [0, duration), spaced by interval."""
    n = max(1, math.ceil(duration / interval))
    last = max(0.0, duration - 1e-3)
    return [min(i * interval, last) for i in range(n)]


def build(src, duration, out_dir, max_tiles, min_interval, cols, tile_width, tiles_per_sheet, timeout):
    os.makedirs(out_dir, exist_ok=True)

    interval = max(duration / max_tiles, min_interval)
    timestamps = tile_timestamps(duration, interval)

    sheets = []
    for sheet_no, offset in enumerate(range(0, len(timestamps), tiles_per_sheet)):
        chunk = timestamps[offset:offset + tiles_per_sheet]
        work = tempfile.mkdtemp(prefix="filmstrip_")
        try:
            for i, t in enumerate(chunk):
                extract_tile(src, t, os.path.join(work, f"f_{i + 1:04d}.jpg"), tile_width, timeout)
            sheet_path = os.path.join(out_dir, f"sheet_{sheet_no + 1:02d}.jpg")
            tile_sheet(work, len(chunk), cols, sheet_path, timeout)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        sheets.append({
            "path": sheet_path,
            "cols": cols,
            "rows": (len(chunk) + cols - 1) // cols,
            "tiles": [
                {"t": round(t, 3), "row": i // cols, "col": i % cols}
                for i, t in enumerate(chunk)
            ],
        })

    return {"sheets": sheets, "interval": round(interval, 3), "tileWidth": tile_width}


def main():
    p = argparse.ArgumentParser(description="Tile a video into a uniform time-grid filmstrip with an index JSON")
    p.add_argument("--input", required=True, help="Source video file (all-intra proxy expected)")
    p.add_argument("--out-dir", required=True, help="Directory to write sheet images into")
    p.add_argument("--max-tiles", type=int, default=100,
                   help="Total tile budget across the whole filmstrip; bounds interval = max(duration/max-tiles, min-interval)")
    p.add_argument("--min-interval", type=float, default=1.0, help="Minimum seconds between tiles")
    p.add_argument("--cols", type=int, default=10, help="Tiles per row per sheet")
    p.add_argument("--tile-width", type=int, default=160, help="Tile width in pixels")
    p.add_argument("--tiles-per-sheet", type=int, default=100, help="Tiles per sheet before splitting into another sheet")
    p.add_argument("--timeout", type=int, default=600, help="Per-ffmpeg-call timeout in seconds")
    args = p.parse_args()

    src = os.path.abspath(args.input)
    require_file(src)
    if args.max_tiles < 1:
        fail("invalid_param", "--max-tiles must be at least 1")
    if args.min_interval <= 0:
        fail("invalid_param", "--min-interval must be greater than 0")
    if args.cols < 1:
        fail("invalid_param", "--cols must be at least 1")
    if args.tile_width < 1:
        fail("invalid_param", "--tile-width must be at least 1")
    if args.tiles_per_sheet < 1:
        fail("invalid_param", "--tiles-per-sheet must be at least 1")

    duration = get_duration(src)
    result = build(src, duration, os.path.abspath(args.out_dir), args.max_tiles, args.min_interval,
                    args.cols, args.tile_width, args.tiles_per_sheet, args.timeout)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
