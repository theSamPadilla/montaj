#!/usr/bin/env python3
"""Contact sheet of a composited project: sample the project at a list of
times (sample_frame.py, no video encode) and tile the frames with a time
label under each. Small tile widths give the phone view; an explicit --at
list of consecutive frame times gives a frame strip."""
import argparse, json, math, os, subprocess, sys, tempfile
from contextlib import nullcontext

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, run_stopping  # noqa: E402
from sheet import tile_sheet  # noqa: E402
sys.path.insert(0, os.path.dirname(__file__))
from sample_frame import sample_frames  # noqa: E402

MAX_TILES = 120
# PL89j (cost): past this many frames a sheet is several, in at most SPLIT_COLS columns, so each tile stays readable in
# the 768 px preview (6 columns of 30 frames made 128 px tiles, and the agent read them full size)
SHEET_FRAMES = 12
SPLIT_COLS = 4
SAMPLE_FRAME = os.path.join(os.path.dirname(__file__), "sample_frame.py")


def project_duration(project_path):
    with open(project_path) as f:
        proj = json.load(f)
    ends = [
        float(it.get("end", 0))
        for tr in proj.get("tracks", [])
        if tr.get("enabled") is not False
        for it in tr.get("items", [])
        if it.get("enabled") is not False
    ]
    return max(ends) if ends else 0.0


def grid_times(duration, every):
    n = int(duration / every + 1e-9)
    times = [round(i * every, 4) for i in range(n)]
    return times or [0.0]


def default_every(duration):
    """No --at or --every: about half of MAX_TILES frames across the project, never closer than 1 s."""
    return float(max(1, math.ceil(duration / (MAX_TILES / 2))))


def coarsen_every(duration):
    """The smallest 0.1 s step that keeps the grid within MAX_TILES."""
    return math.ceil(duration / MAX_TILES * 10 + 1e-9) / 10


def thin(times, limit):
    """`limit` of `times`, evenly spread, first and last kept."""
    n = len(times)
    return [times[round(i * (n - 1) / (limit - 1))] for i in range(limit)]


def _sample_frame(project, t, out, raw=False):
    cmd = [sys.executable, SAMPLE_FRAME, "--project", project, "--at", str(t), "--out", out]
    if raw:
        cmd.append("--raw")
    try:
        proc = run_stopping(cmd, timeout=120, text=True)
    except subprocess.TimeoutExpired:
        fail("sample_failed", f"sample_frame at {t}s exceeded 120s")
    if proc.returncode != 0 or not os.path.isfile(out):
        fail("sample_failed", f"sample_frame at {t}s failed: {proc.stderr.strip()[-400:]}")


def build(project, times, cols, tile_width, out, sampler=_sample_frame, frames_dir=None, raw=False, look_fn=None):
    if frames_dir:
        os.makedirs(frames_dir, exist_ok=True)
    with (nullcontext(frames_dir) if frames_dir else tempfile.TemporaryDirectory()) as work:
        if sampler is _sample_frame:
            # Default path: every time in ONE node process.
            frames = [os.path.abspath(p) for p in sample_frames(project, times, work, raw=raw)]
        else:
            frames = []
            for i, t in enumerate(times):
                p = os.path.join(work, f"f_{i:04d}.png")
                sampler(project, t, p, raw=True) if raw else sampler(project, t, p)
                frames.append(os.path.abspath(p))
        sheets, sheet_times = [], []
        if len(times) > SHEET_FRAMES and not frames_dir:
            n = -(-len(times) // SHEET_FRAMES)
            size = -(-len(times) // n)
            stem, ext = os.path.splitext(out)
            for k, i in enumerate(range(0, len(times), size)):
                dest = out if k == 0 else f"{stem}-{k + 1}{ext}"
                tile_sheet(frames[i:i + size], times[i:i + size], min(cols, SPLIT_COLS), tile_width, dest)
                sheets.append(os.path.abspath(dest))
                sheet_times.append(list(times[i:i + size]))
        else:
            tile_sheet(frames, times, cols, tile_width, out)
    result = {"path": os.path.abspath(out), "times": list(times), "cols": cols, "tile_width": tile_width}
    if sheets:
        result.update(sheets=sheets, sheet_times=sheet_times, cols=min(cols, SPLIT_COLS))
    if frames_dir:
        result["frames"] = frames
    # Round 9: the closing sheet answers look's issues too (look never ran in the run that ended on this step); a look
    # that fails leaves the sheet as it is
    if look_fn is not None:
        try:
            result["look"] = look_fn(project)
        except (SystemExit, Exception):  # noqa: BLE001
            pass
    return result


def _look(project):
    import look   # steps/render/look.py, beside this step
    return look.run(project)


def main():
    ap = argparse.ArgumentParser(description="Contact sheet of a composited project from sampled frames")
    ap.add_argument("--project", required=True)
    ap.add_argument("--at", type=float, action="append", help="Sample time in seconds (repeatable)")
    ap.add_argument("--every", type=float, help="Sample every N seconds across the whole project")
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--tile-width", type=int, default=320)
    ap.add_argument("--raw", action="store_true",
                    help="Tile the untouched SOURCE frames under each time: no crop, zoom, overlays or captions")
    ap.add_argument("--frames-dir", help="Keep the sampled frame PNGs here (f_0000.png...) and report their paths")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    require_file(args.project)
    if args.at and args.every:
        fail("invalid_args", "pass --at or --every, not both")
    if args.every is not None and args.every <= 0:
        fail("invalid_args", "--every must be > 0")
    if args.cols < 1 or args.tile_width < 16:
        fail("invalid_args", "--cols must be >= 1 and --tile-width >= 16")
    duration = project_duration(args.project)
    note = None
    if args.at:
        times = args.at
        if len(times) > MAX_TILES:
            times = thin(times, MAX_TILES)
            note = f"{len(args.at)} times > {MAX_TILES}: sampled {MAX_TILES} of them, evenly."
    else:
        every = args.every
        if not every:
            every = default_every(duration)
            note = f"no --at or --every: sampled every {every:g} s."
        elif duration / every > MAX_TILES:
            every = coarsen_every(duration)
            note = f"--every {args.every:g} would make more than {MAX_TILES} samples: sampled every {every:g} s."
        times = grid_times(duration, every)
    # a frame strip or a raw sheet is a look at footage, not the closing check
    look_fn = None if args.raw or args.frames_dir else _look
    result = build(args.project, times, args.cols, args.tile_width, args.out, frames_dir=args.frames_dir, raw=args.raw, look_fn=look_fn)
    if note:
        result["note"] = note
    print(json.dumps(result))


if __name__ == "__main__":
    main()
