#!/usr/bin/env python3
"""Generate a grid snapshot (contact sheet) from a video.

Modes
-----
Grid (default, --frames N or --cols/--rows):
    Extracts N evenly-spaced frames from the window and tiles them into a
    single JPEG contact sheet.  Outputs one file, prints its path.

All-frames (--frames all):
    Extracts every frame from the window as individual JPEGs to a directory.
    Outputs one path per frame, one per line.

Point-in-time (--at <seconds>):
    Extracts a single full-resolution frame at the specified timestamp.
    Outputs one file, prints its path. Use cases: boundary-frame extraction
    for chained scene continuity (pass frame N's last frame as frame N+1's
    first_frame to Kling) and draft-phase regeneration (preserve stitching
    with neighboring clips).

Times (--at repeated, 2 to 36):
    One sheet of the source at those times, each tile labelled with its time,
    in the order given; --cols sets the columns (default up to 6). For finding
    the moments of a source video (b-roll) in one call.
"""
import math, os, sys, argparse, glob, tempfile
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, get_duration, ffmpeg_bin, ff_seconds, ff_input
from sheet import look_sheet, tile_sheet  # noqa: F401

# PL89: the most times one sheet takes, and how many ffmpeg seeks run at once.
MAX_SHEET_TIMES = 36
SEEKS_AT_ONCE = 4
SHEET_TILE_WIDTH = 320
# The sheet comes back as a 768 px preview, so the label is drawn big enough to read there.
SHEET_LABEL_PX = 30


def times_sheet(src, times, cols, out, explicit_cols=False):
    """One labelled sheet of `src` at `times`: each frame by a fast seek, then tiled (lib/sheet.tile_sheet)."""
    with tempfile.TemporaryDirectory() as work:
        paths = [os.path.join(work, f"f_{i:04d}.png") for i in range(len(times))]

        def grab(i):
            run([ffmpeg_bin(), "-y", "-ss", ff_seconds(times[i]), "-i", ff_input(src),
                 "-frames:v", "1", "-vf", f"scale={SHEET_TILE_WIDTH * 2}:-2", paths[i]])
            check_output(paths[i])

        with ThreadPoolExecutor(SEEKS_AT_ONCE) as pool:
            list(pool.map(grab, range(len(times))))
        look_sheet(paths, times, out, cols=cols if explicit_cols else None)


MAX_CLIPS = 12
CLIP_COLS = 6


def clips_sheet(inputs, names, cols, out):
    """ONE sheet of several clips: a row per clip, `cols` frames spread over each, every tile labelled with the clip's
    name and the time, fitted into the same square box (takes and screen recordings of any shape)."""
    times, srcs, labels = [], [], []
    for src, name in zip(inputs, names):
        d = get_duration(src)
        for k in range(cols):
            t = round(d * (k + 0.5) / cols, 2)
            times.append(t)
            srcs.append(src)
            labels.append(f"{name} {t:.1f}s")
    with tempfile.TemporaryDirectory() as work:
        paths = [os.path.join(work, f"f_{i:04d}.png") for i in range(len(times))]

        def grab(i):
            run([ffmpeg_bin(), "-y", "-ss", ff_seconds(times[i]), "-i", ff_input(srcs[i]),
                 "-frames:v", "1", "-vf", f"scale={SHEET_TILE_WIDTH * 2}:-2", paths[i]])
            check_output(paths[i])

        with ThreadPoolExecutor(SEEKS_AT_ONCE) as pool:
            list(pool.map(grab, range(len(times))))
        look_sheet(paths, labels, out, cols=cols, box=True)


def main():
    parser = argparse.ArgumentParser(description="Generate a frame grid contact sheet or single-frame extraction from a video")
    parser.add_argument("--input",   default=None, help="Source video file")
    parser.add_argument("--inputs",  action="append", default=None,
                        help="Several clips (repeat it): a sheet of up to 12, a row per clip (--cols frames each, default 6); more than 12 make several sheets, one path per line")
    parser.add_argument("--names",   action="append", default=None, help="A label per --inputs clip (its clip id)")
    parser.add_argument("--cols",    type=int, default=3, help="Grid columns (default: 3)")
    parser.add_argument("--rows",    type=int, default=3, help="Grid rows (default: 3)")
    parser.add_argument("--start",   type=float, default=0.0, help="Window start in seconds (default: 0)")
    parser.add_argument("--end",     type=float, default=None, help="Window end in seconds (default: full video)")
    parser.add_argument("--frames",  default=None,
                        help="Number of frames to sample, or 'all' to extract every frame in the window")
    parser.add_argument("--at",      type=float, default=None, action="append",
                        help="Extract a single full-resolution frame at this timestamp (seconds). "
                             "Repeat it (2 to 36) for one labelled sheet of those times. "
                             "Mutually exclusive with --frames, --rows, --start, --end (and --cols for one time).")
    parser.add_argument("--out",     help="Output file path (grid and --at modes) or directory (all-frames mode)")
    args = parser.parse_args()

    if args.inputs:
        for p in args.inputs:
            require_file(p)
        names = list(args.names or [])
        names += [os.path.splitext(os.path.basename(p))[0] for p in args.inputs[len(names):]]
        cols = args.cols if "--cols" in sys.argv else CLIP_COLS
        out = args.out or f"{os.path.splitext(args.inputs[0])[0]}_clips.jpg"
        # More than MAX_CLIPS is several sheets of MAX_CLIPS (the 2nd as <out>-2.jpg ...), one path per line;
        # up to MAX_CLIPS the answer is the one path, as before.
        stem, ext = os.path.splitext(out)
        for k, i in enumerate(range(0, len(args.inputs), MAX_CLIPS)):
            dest = out if k == 0 else f"{stem}-{k + 1}{ext}"
            clips_sheet(args.inputs[i:i + MAX_CLIPS], names[i:i + MAX_CLIPS], max(1, min(cols, 10)), dest)
            check_output(dest)
            print(dest)
        return
    if not args.input:
        fail("invalid_args", "Pass input (a video), or inputs (several clips, one sheet).")
    require_file(args.input)
    duration = get_duration(args.input)

    # ------------------------------------------------------------------ #
    # Point-in-time mode — mutually exclusive with grid / all-frames.     #
    # ------------------------------------------------------------------ #
    if args.at is not None:
        times = args.at
        several = len(times) > 1
        # Reject combinations that don't make sense together.
        conflicts = []
        if args.frames is not None: conflicts.append("--frames")
        if "--cols" in sys.argv and not several: conflicts.append("--cols")
        if "--rows" in sys.argv:    conflicts.append("--rows")
        if "--start" in sys.argv:   conflicts.append("--start")
        if "--end" in sys.argv:     conflicts.append("--end")
        if conflicts:
            fail("invalid_args",
                 f"--at is mutually exclusive with {', '.join(conflicts)}")
        if len(times) > MAX_SHEET_TIMES:
            fail("invalid_args", f"{len(times)} times > {MAX_SHEET_TIMES}; split them over two calls.")

        for t in times:
            if t < 0 or t > duration:
                fail("invalid_at",
                     f"--at {t} is outside the video duration [0, {duration}]")

        if several:
            out = args.out or f"{os.path.splitext(args.input)[0]}_at_{times[0]:.2f}-{times[-1]:.2f}.jpg"
            cols = args.cols if "--cols" in sys.argv else min(6, len(times))
            times_sheet(args.input, times, cols, out, explicit_cols="--cols" in sys.argv)
            check_output(out)
            print(out)
            return

        at = times[0]
        out = args.out or f"{os.path.splitext(args.input)[0]}_at_{at:.2f}.jpg"
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        # Full-resolution single-frame extraction. Using -ss BEFORE -i for
        # fast seek; accuracy is sufficient for our boundary-frame use case.
        run([ffmpeg_bin(), "-y",
             "-ss", ff_seconds(at),
             "-i", ff_input(args.input),
             "-frames:v", "1",
             "-q:v", "2",  # high-quality JPEG (scale: 1=best..31=worst)
             out])
        check_output(out)
        print(out)
        return

    window_start = max(0.0, args.start)
    window_end   = min(duration, args.end) if args.end is not None else duration
    if window_end <= window_start:
        fail("invalid_window", f"--end ({window_end}) must be greater than --start ({window_start})")
    window_duration = window_end - window_start

    # ------------------------------------------------------------------ #
    # All-frames mode                                                      #
    # ------------------------------------------------------------------ #
    if args.frames == "all":
        out_dir = args.out or f"{os.path.splitext(args.input)[0]}_frames"
        os.makedirs(out_dir, exist_ok=True)

        run([ffmpeg_bin(), "-y",
             "-ss", ff_seconds(window_start), "-to", ff_seconds(window_end),
             "-i", ff_input(args.input),
             "-vf", "scale=320:-1",
             os.path.join(out_dir, "frame_%04d.jpg")])

        paths = sorted(glob.glob(os.path.join(out_dir, "frame_*.jpg")))
        if not paths:
            fail("no_output", f"No frames written to {out_dir}")
        print("\n".join(paths))
        return

    # ------------------------------------------------------------------ #
    # Grid mode                                                            #
    # ------------------------------------------------------------------ #
    if args.frames is not None:
        try:
            total = int(args.frames)
        except ValueError:
            fail("invalid_frames", f"--frames must be a positive integer or 'all', got: {args.frames!r}")
        # Auto-compute a square-ish grid when --frames is given without
        # explicit --cols / --rows (detect by checking defaults).
        cols_given = "--cols" in sys.argv
        rows_given = "--rows" in sys.argv
        if cols_given or rows_given:
            cols, rows = args.cols, args.rows
            total = cols * rows
        else:
            cols = max(1, math.ceil(math.sqrt(total)))
            rows = max(1, math.ceil(total / cols))
    else:
        cols, rows = args.cols, args.rows
        total = cols * rows

    out = args.out or f"{os.path.splitext(args.input)[0]}_snapshot.jpg"
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    interval = window_duration / (total + 1)
    interval = max(0.033, interval)   # cap at ~30 fps

    run([ffmpeg_bin(), "-y",
         "-ss", ff_seconds(window_start), "-to", ff_seconds(window_end),
         "-i", ff_input(args.input),
         "-vf", f"fps=1/{interval},scale=320:-1,tile={cols}x{rows}",
         "-frames:v", "1", out])

    check_output(out)
    print(out)


if __name__ == "__main__":
    main()
