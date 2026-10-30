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
import json, math, os, sys, argparse, shutil, tempfile, hashlib, subprocess

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import ffmpeg_error_tail, fail, require_file, run, check_output, get_duration, ffmpeg_bin

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# Bump when the overlay strip's pixels or index shape change, so cached strips retire.
OVERLAY_STRIP_VERSION = 1


# How far back to retry when a seek lands past the last decodable frame.
_TAIL_RETRY_BACK = (0.1, 0.5, 2.0)


def extract_tile(src: str, t: float, dest: str, width: int, timeout: int):
    """Write one frame near t to dest.

    A seek to t drops every frame whose start is before t, so a t inside the
    LAST frame's span (the tail tick of a grid whose duration is not a whole
    number of ticks, e.g. 15.0 on a 15.015 s, 23.976 fps clip) decodes no
    frame at all: ffmpeg then reports a bogus mjpeg "Non full-range YUV" encoder
    error and exits non-zero, which failed the whole sheet. Retry a little
    earlier, so the last frame is taken instead.
    """
    def ok() -> bool:
        return os.path.isfile(dest) and os.path.getsize(dest) > 0

    def attempt(at: float):
        return run([ffmpeg_bin(), "-nostdin", "-loglevel", "error", "-ss", f"{at:.4f}",
                    "-i", src, "-frames:v", "1", "-vf", f"scale={width}:-2", dest, "-y"],
                   timeout=timeout, check=False)

    r = attempt(t)
    for back in _TAIL_RETRY_BACK:
        if r.returncode == 0 and ok():
            return
        if t - back < 0:
            break
        r = attempt(t - back)
    if r.returncode == 0 and ok():
        return
    fail("unexpected_error", f"Could not extract a frame at {t:.3f}s from {src}\n{ffmpeg_error_tail(r.stderr)}")


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


# ---------------------------------------------------------------------------
# Overlay (.jsx) input
# ---------------------------------------------------------------------------

def _file_sha(path: str) -> str:
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return "missing"


def overlay_base_key(jsx, props, fonts, duration, fps, timestamps, tile_width, width, height, cols, tiles_per_sheet) -> str:
    """Hash of everything but the overlay's imports: the JSX content, props (canonical), fonts, length, fps,
    the time grid, tile size and the version. Names the folder that holds the import list."""
    raw = json.dumps({
        "jsx": _file_sha(jsx), "props": props, "fonts": fonts, "duration": duration, "fps": fps,
        "times": [round(t, 3) for t in timestamps], "tile": tile_width, "canvas": [width, height],
        "cols": cols, "perSheet": tiles_per_sheet, "v": OVERLAY_STRIP_VERSION,
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def _norm(p: str) -> str:
    """A path as the cache sees it: forward slashes, so the key reads the same on every OS."""
    return p.replace("\\", "/")


def overlay_key(base_key: str, imports: list) -> str:
    """The cache key: the base key plus the content of every file the overlay imports, so an edit to one retires it."""
    h = hashlib.sha256(base_key.encode())
    for p in sorted({_norm(i): i for i in imports}.items()):
        h.update(b"\0" + p[0].encode() + b"\0" + _file_sha(p[1]).encode())
    return h.hexdigest()


def _write_json_atomic(path: str, obj, valid=None):
    """Write via a temp file in the same folder, then rename. On Windows a rename over an existing file can fail
    (EPERM/EEXIST): if the target already exists and `valid(target)` holds, that is a cache hit, not an error."""
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    try:
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        if not (os.path.isfile(path) and (valid is None or valid(_read_json(path)))):
            raise


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def cached_overlay_strip(out_dir: str, base_key: str):
    """The cached index for this base key, or None. A hit needs the import list, an index under the full key
    and every sheet it names."""
    imports = _read_json(os.path.join(out_dir, base_key, "imports.json"))
    if not isinstance(imports, list):
        return None
    index = _read_json(os.path.join(out_dir, overlay_key(base_key, imports), "index.json"))
    if not isinstance(index, dict) or not index.get("sheets"):
        return None
    if not all(os.path.isfile(s.get("path", "")) for s in index["sheets"]):
        return None
    return index


def run_overlay_strip_node(cmd: list, timeout: int):
    """Run the node strip sampler; returns its parsed stdout JSON. A seam for tests."""
    from common import node_child_env
    r = subprocess.run(cmd, capture_output=True, env=node_child_env(), timeout=timeout)
    if r.returncode != 0:
        tail = (r.stderr or b"").decode("utf-8", errors="replace").strip().splitlines()[-1:] or ["no output"]
        fail("unexpected_error", f"Overlay strip failed: {tail[0]}")
    try:
        return json.loads(r.stdout.decode("utf-8", errors="replace").strip().splitlines()[-1])
    except (ValueError, IndexError):
        fail("unexpected_error", "Overlay strip printed no result")


def flatten_tile(png: str, dest: str, w: int, h: int, timeout: int):
    """A transparent overlay frame over the strip's dark ground, as the JPEG tile_sheet reads."""
    run([ffmpeg_bin(), "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c=0x101B2C:s={w}x{h}",
         "-i", png, "-filter_complex", f"[1:v]scale={w}:{h}[o];[0:v][o]overlay=shortest=1,format=yuvj420p",
         "-frames:v", "1", dest, "-y"], timeout=timeout)
    check_output(dest)


def build_overlay(jsx, duration, out_dir, max_tiles, min_interval, cols, tile_width, tiles_per_sheet, timeout,
                  props="{}", google_fonts=None, fps=30, width=1080, height=1920):
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    try:
        props_obj = json.loads(props or "{}")
    except ValueError:
        fail("invalid_param", "--props is not valid JSON")
    if not isinstance(props_obj, dict):
        fail("invalid_param", "--props must be a JSON object")

    interval = max(duration / max_tiles, min_interval)
    timestamps = tile_timestamps(duration, interval)
    base = overlay_base_key(jsx, props_obj, google_fonts or "", duration, fps, timestamps, tile_width, width, height, cols, tiles_per_sheet)

    hit = cached_overlay_strip(out_dir, base)
    if hit:
        return hit

    tile_height = max(2, round(height * tile_width / width / 2) * 2)
    work = tempfile.mkdtemp(prefix=".strip_", dir=out_dir)
    try:
        cmd = ["node", os.path.join(_render_dir(), "sample-frame.js"), "--mode", "overlay-strip",
               "--component", jsx, "--times", json.dumps([round(t, 4) for t in timestamps]),
               "--fps", str(fps), "--duration", str(max(1, round(duration * fps))),
               "--width", str(width), "--height", str(height), "--props", json.dumps(props_obj, sort_keys=True),
               "--tile-width", str(tile_width), "--out-dir", work]
        if google_fonts:
            cmd += ["--google-fonts", google_fonts]
        got = run_overlay_strip_node(cmd, timeout)
        imports = sorted({p for p, _ in got.get("inputs", [])} | {jsx})
        os.makedirs(os.path.join(out_dir, base), exist_ok=True)
        _write_json_atomic(os.path.join(out_dir, base, "imports.json"), imports, valid=lambda d: isinstance(d, list))
        key_dir = os.path.join(out_dir, overlay_key(base, imports))
        os.makedirs(key_dir, exist_ok=True)

        sheets = []
        for sheet_no, offset in enumerate(range(0, len(timestamps), tiles_per_sheet)):
            chunk = timestamps[offset:offset + tiles_per_sheet]
            tiles_dir = os.path.join(work, f"sheet_{sheet_no}")
            os.makedirs(tiles_dir)
            for i in range(len(chunk)):
                flatten_tile(got["pngs"][offset + i], os.path.join(tiles_dir, f"f_{i + 1:04d}.jpg"), tile_width, tile_height, timeout)
            sheet_path = os.path.join(key_dir, f"sheet_{sheet_no + 1:02d}.jpg")
            tile_sheet(tiles_dir, len(chunk), cols, sheet_path, timeout)
            sheets.append({
                "path": sheet_path, "cols": cols, "rows": (len(chunk) + cols - 1) // cols,
                "tiles": [{"t": round(t, 3), "row": i // cols, "col": i % cols} for i, t in enumerate(chunk)],
            })
        index = {"sheets": sheets, "interval": round(interval, 3), "tileWidth": tile_width, "tileHeight": tile_height}
        # last, so a hit never sees half a strip
        _write_json_atomic(os.path.join(key_dir, "index.json"), index, valid=lambda d: isinstance(d, dict) and bool(d.get("sheets")))
        return index
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _render_dir() -> str:
    if MONTAJ_ROOT not in sys.path:
        sys.path.insert(0, MONTAJ_ROOT)
    from cli.deps import render_runtime_dir
    return render_runtime_dir()


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
    p.add_argument("--props", default="{}", help="Overlay only: props JSON object")
    p.add_argument("--google-fonts", default=None, help="Overlay only: Google Fonts, a comma list or JSON array")
    p.add_argument("--fps", type=int, default=30, help="Overlay only: frame rate of the fps global")
    p.add_argument("--duration", type=float, default=None, help="Overlay only (required): length in seconds")
    p.add_argument("--width", type=int, default=1080, help="Overlay only: canvas width")
    p.add_argument("--height", type=int, default=1920, help="Overlay only: canvas height")
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

    if src.lower().endswith(".jsx"):
        if args.duration is None or args.duration <= 0:
            fail("invalid_param", "--duration (seconds) is required for an overlay .jsx")
        if args.fps < 1 or args.width < 1 or args.height < 1:
            fail("invalid_param", "--fps, --width and --height must be at least 1")
        result = build_overlay(src, args.duration, args.out_dir, args.max_tiles, args.min_interval,
                               args.cols, args.tile_width, args.tiles_per_sheet, args.timeout,
                               props=args.props, google_fonts=args.google_fonts, fps=args.fps,
                               width=args.width, height=args.height)
        print(json.dumps(result))
        return

    duration = get_duration(src)
    result = build(src, duration, os.path.abspath(args.out_dir), args.max_tiles, args.min_interval,
                    args.cols, args.tile_width, args.tiles_per_sheet, args.timeout)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
