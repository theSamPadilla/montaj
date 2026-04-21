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
"""
import math, os, sys, argparse, glob

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run, get_duration


def main():
    parser = argparse.ArgumentParser(description="Generate a frame grid contact sheet or single-frame extraction from a video")
    parser.add_argument("--input",   required=True, help="Source video file")
    parser.add_argument("--cols",    type=int, default=3, help="Grid columns (default: 3)")
    parser.add_argument("--rows",    type=int, default=3, help="Grid rows (default: 3)")
    parser.add_argument("--start",   type=float, default=0.0, help="Window start in seconds (default: 0)")
    parser.add_argument("--end",     type=float, default=None, help="Window end in seconds (default: full video)")
    parser.add_argument("--frames",  default=None,
                        help="Number of frames to sample, or 'all' to extract every frame in the window")
    parser.add_argument("--at",      type=float, default=None,
                        help="Extract a single full-resolution frame at this timestamp (seconds). "
                             "Mutually exclusive with --frames, --cols, --rows, --start, --end.")
    parser.add_argument("--out",     help="Output file path (grid and --at modes) or directory (all-frames mode)")
    args = parser.parse_args()

    require_file(args.input)
    duration = get_duration(args.input)

    # ------------------------------------------------------------------ #
    # Point-in-time mode — mutually exclusive with grid / all-frames.     #
    # ------------------------------------------------------------------ #
    if args.at is not None:
        # Reject combinations that don't make sense together.
        conflicts = []
        if args.frames is not None: conflicts.append("--frames")
        if "--cols" in sys.argv:    conflicts.append("--cols")
        if "--rows" in sys.argv:    conflicts.append("--rows")
        if "--start" in sys.argv:   conflicts.append("--start")
        if "--end" in sys.argv:     conflicts.append("--end")
        if conflicts:
            fail("invalid_args",
                 f"--at is mutually exclusive with {', '.join(conflicts)}")

        if args.at < 0 or args.at > duration:
            fail("invalid_at",
                 f"--at {args.at} is outside the video duration [0, {duration}]")

        out = args.out or f"{os.path.splitext(args.input)[0]}_at_{args.at:.2f}.jpg"
        # Full-resolution single-frame extraction. Using -ss BEFORE -i for
        # fast seek; accuracy is sufficient for our boundary-frame use case.
        run(["ffmpeg", "-y",
             "-ss", str(args.at),
             "-i", args.input,
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

        run(["ffmpeg", "-y",
             "-ss", str(window_start), "-to", str(window_end),
             "-i", args.input,
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
    interval = window_duration / (total + 1)
    interval = max(0.033, interval)   # cap at ~30 fps

    run(["ffmpeg", "-y",
         "-ss", str(window_start), "-to", str(window_end),
         "-i", args.input,
         "-vf", f"fps=1/{interval},scale=320:-1,tile={cols}x{rows}",
         "-frames:v", "1", out])

    check_output(out)
    print(out)


if __name__ == "__main__":
    main()
