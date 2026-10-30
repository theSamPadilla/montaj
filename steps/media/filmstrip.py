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
import json, math, os, re, sys, argparse, shutil, tempfile, hashlib, subprocess, time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import ffmpeg_error_tail, fail, require_file, run, check_output, get_duration, ffmpeg_bin

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# Bump when the overlay strip's pixels or index shape change, so cached strips retire.
# 2: sheets are PNG with alpha (no navy ground), and the index carries coverage and visual.
OVERLAY_STRIP_VERSION = 2
# A pixel counts as covered above this alpha; an overlay covering less of its frame on average than
# VISUAL_COVERAGE (tiny text, a caption, a mask whose hole is the whole frame) is not drawn as a strip.
COVERAGE_ALPHA = 0.1
VISUAL_COVERAGE = 0.15
# A 3D item's reserved src, the host stage it renders through and the scene id rule (render/scene3d.js).
SCENE3D_SRC = "engine:scene3d"
SCENE3D_STAGE_ENV = "MONTAJ_SCENE3D_STAGE"
SCENE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
# What a stage derives from a 3D item's props; read afresh from the saved 3D, never keyed or passed.
SCENE3D_DERIVED_PROPS = ("sceneFile", "sceneJson")


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


def _montaj_version() -> str:
    """The installed montaj version (a new release may change the renderer), or "dev" from a checkout."""
    try:
        from importlib.metadata import version as pkg_version
        return pkg_version("montaj")
    except Exception:
        return "dev"


def overlay_base_key(jsx, props, fonts, duration, fps, timestamps, tile_width, width, height, cols, tiles_per_sheet,
                     jsx_sha=None, extra=None) -> str:
    """Hash of everything but the overlay's imports: the JSX content, props (canonical), fonts, length, fps,
    the time grid, tile size, the montaj version and the strip version. Names the folder that holds the import list.
    `jsx_sha` is the content hash when the caller already took it (so it can later check the file did not move).
    `extra` is more key, when given (a 3D item's saved scene)."""
    fields = {
        "jsx": jsx_sha if jsx_sha is not None else _file_sha(jsx), "mv": _montaj_version(), "props": props, "fonts": fonts, "duration": duration, "fps": fps,
        "times": [round(t, 3) for t in timestamps], "tile": tile_width, "canvas": [width, height],
        "cols": cols, "perSheet": tiles_per_sheet, "v": OVERLAY_STRIP_VERSION,
    }
    if extra is not None:
        fields["extra"] = extra
    raw = json.dumps(fields, sort_keys=True, separators=(",", ":"))
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
        return obj
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        held = _read_json(path) if os.path.isfile(path) else None
        if held is None or not (valid is None or valid(held)):
            raise
        return held  # another process holds the file and it is valid: that is the hit


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
    _touch(os.path.join(out_dir, overlay_key(base_key, imports)))  # in use: pruning keeps the newest
    return index


def _touch(path: str):
    try:
        os.utime(path, None)
    except OSError:
        pass


# Strip folders kept per out-dir; older ones are pruned after each new strip.
# Overlays that share a jsx share its out-dir (one strip per item's props), so a count cap must sit far above any
# real track (the promo project has 15 cards on one jsx); age is what really retires old strips.
KEEP_STRIPS = 200
KEEP_STRIP_AGE_S = 14 * 24 * 3600
_KEY_DIR = re.compile(r"^[0-9a-f]{64}$")


def prune_strips(out_dir: str, keep: int = KEEP_STRIPS, max_age_s: float = KEEP_STRIP_AGE_S):
    """Best effort, never raises: remove finished strip folders (they hold an index.json; a cache hit touches its
    folder) and stale_* folders unused for `max_age_s`, and any past the `keep` newest, then the import lists whose
    strip is gone.
    A folder with no index.json yet may be a render in progress, and dot folders are work folders: both are left."""
    try:
        done = []
        for name in os.listdir(out_dir):
            path = os.path.join(out_dir, name)
            if not os.path.isdir(path):
                continue
            if name.startswith("stale_") or (_KEY_DIR.match(name) and os.path.isfile(os.path.join(path, "index.json"))):
                done.append((os.path.getmtime(path), path))
        done.sort(reverse=True)
        cutoff = time.time() - max_age_s
        for i, (mtime, path) in enumerate(done):
            if i >= keep or mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True)
        for name in os.listdir(out_dir):
            imports = _read_json(os.path.join(out_dir, name, "imports.json")) if _KEY_DIR.match(name) else None
            if isinstance(imports, list) and not os.path.isdir(os.path.join(out_dir, overlay_key(name, imports))):
                shutil.rmtree(os.path.join(out_dir, name), ignore_errors=True)
    except OSError:
        pass


# The node sampler's own deadline sits this far inside the step's, so it closes its Chromium and exits first
# (the only clean stop on Windows, where there is no SIGTERM for puppeteer to catch).
NODE_DEADLINE_MARGIN_S = 15


def node_deadline_ms(timeout: float) -> int:
    return int(max(5.0, timeout - NODE_DEADLINE_MARGIN_S) * 1000)


def run_overlay_strip_node(cmd: list, timeout: int):
    """Run the node strip sampler; returns its parsed stdout JSON. A seam for tests. Past `timeout` the sampler gets
    SIGTERM (its whole group), so the Chromium it started closes too (run_stopping)."""
    from common import node_child_env, run_stopping
    try:
        r = run_stopping(cmd, timeout=timeout, env=node_child_env())
    except subprocess.TimeoutExpired:
        fail("timeout", "Overlay strip timed out")
    if r.returncode != 0:
        tail = (r.stderr or b"").decode("utf-8", errors="replace").strip().splitlines()[-1:] or ["no output"]
        fail("unexpected_error", f"Overlay strip failed: {tail[0]}")
    try:
        return json.loads(r.stdout.decode("utf-8", errors="replace").strip().splitlines()[-1])
    except (ValueError, IndexError):
        fail("unexpected_error", "Overlay strip printed no result")


def tile_coverage(png: str) -> float:
    """The share of a tile's pixels with alpha above COVERAGE_ALPHA: about 1 for a full-frame overlay, near 0
    for tiny text on transparent or a frame that is all hole."""
    from PIL import Image
    with Image.open(png) as im:
        hist = im.convert("RGBA").getchannel("A").histogram()
    total = sum(hist)
    cut = int(COVERAGE_ALPHA * 255) + 1  # alpha > 0.1, as 8-bit
    return sum(hist[cut:]) / total if total else 0.0


def png_sheet(pngs: list, cols: int, w: int, h: int, dest: str):
    """The tiles in a cols-wide grid of w x h cells, no padding, as a PNG that keeps their alpha (the editor
    composes it over the footage under the overlay). A short last row leaves its cells transparent."""
    from PIL import Image
    rows = (len(pngs) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * w, rows * h), (0, 0, 0, 0))
    for i, png in enumerate(pngs):
        with Image.open(png) as im:
            tile = im.convert("RGBA")
            if tile.size != (w, h):
                tile = tile.resize((w, h), Image.LANCZOS)
            sheet.paste(tile, ((i % cols) * w, (i // cols) * h))
    sheet.save(dest, "PNG")
    check_output(dest)


def _inputs_changed(jsx: str, jsx_sha: str, inputs: list, also=()) -> bool:
    """True when the overlay or anything it imported changed since the render read it: a strip rendered from
    one version must not be cached under the key of another. `also` is more (path, sha) pairs to hold still."""
    if _file_sha(jsx) != jsx_sha:
        return True
    if any(_file_sha(path) != sha for path, sha in also):
        return True
    for entry in inputs:
        try:
            path, mtime_ms = entry[0], float(entry[1])
            if abs(os.stat(path).st_mtime * 1000 - mtime_ms) > 1:
                return True
        except (OSError, ValueError, IndexError, TypeError):
            return True
    return False


def _move_into(src: str, dest: str):
    """Rename a finished file into place. On Windows a rename over an existing file can fail; the file there
    is the same key's, so it stands."""
    try:
        os.replace(src, dest)
    except OSError:
        if not os.path.isfile(dest):
            raise


def _props_object(props) -> dict:
    try:
        props_obj = json.loads(props or "{}")
    except ValueError:
        fail("invalid_param", "--props is not valid JSON")
    if not isinstance(props_obj, dict):
        fail("invalid_param", "--props must be a JSON object")
    return props_obj


def build_overlay(jsx, duration, out_dir, max_tiles, min_interval, cols, tile_width, tiles_per_sheet, timeout,
                  props="{}", google_fonts=None, fps=30, width=1080, height=1920,
                  component=None, key_extra=None, extra_cmd=(), hold=()):
    """An overlay's strip. `component` is what the node sampler is handed (the jsx by default; a 3D item passes
    engine:scene3d and the jsx is then the host stage, which keys the strip); `key_extra`, `extra_cmd` and `hold`
    (path, sha pairs that must not change during the render) are build_scene3d's."""
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    props_obj = props if isinstance(props, dict) else _props_object(props)

    interval = max(duration / max_tiles, min_interval)
    timestamps = tile_timestamps(duration, interval)
    jsx_sha = _file_sha(jsx)
    base = overlay_base_key(jsx, props_obj, google_fonts or "", duration, fps, timestamps, tile_width, width, height, cols, tiles_per_sheet,
                            jsx_sha=jsx_sha, extra=key_extra)

    hit = cached_overlay_strip(out_dir, base)
    if hit:
        return hit

    tile_height = max(2, round(height * tile_width / width / 2) * 2)
    work = tempfile.mkdtemp(prefix=".strip_", dir=out_dir)
    try:
        cmd = ["node", os.path.join(_render_dir(), "sample-frame.js"), "--mode", "overlay-strip",
               "--component", component or jsx, "--times", json.dumps([round(t, 4) for t in timestamps]),
               "--fps", str(fps), "--duration", str(max(1, round(duration * fps))),
               "--width", str(width), "--height", str(height), "--props", json.dumps(props_obj, sort_keys=True),
               "--tile-width", str(tile_width), "--out-dir", work, "--deadline-ms", str(node_deadline_ms(timeout))]
        if google_fonts:
            cmd += ["--google-fonts", google_fonts]
        cmd += list(extra_cmd)
        got = run_overlay_strip_node(cmd, timeout)
        inputs = got.get("inputs", [])
        imports = sorted({p for p, _ in inputs} | {jsx})
        # An edit landed while the strip rendered: it is a fine picture of the old file, but no entry for the new
        # key. Checked before anything moves into a key folder; its sheets go to a stale_ folder instead.
        changed = _inputs_changed(jsx, jsx_sha, inputs, hold)
        key_dir = tempfile.mkdtemp(prefix="stale_", dir=out_dir) if changed else os.path.join(out_dir, overlay_key(base, imports))
        os.makedirs(key_dir, exist_ok=True)

        coverage = [tile_coverage(png) for png in got["pngs"][:len(timestamps)]]
        sheets = []
        for sheet_no, offset in enumerate(range(0, len(timestamps), tiles_per_sheet)):
            chunk = timestamps[offset:offset + tiles_per_sheet]
            name = f"sheet_{sheet_no + 1:02d}.png"
            built = os.path.join(work, name)
            png_sheet(got["pngs"][offset:offset + len(chunk)], cols, tile_width, tile_height, built)
            sheet_path = os.path.join(key_dir, name)
            _move_into(built, sheet_path)
            sheets.append({
                "path": sheet_path, "cols": cols, "rows": (len(chunk) + cols - 1) // cols,
                "tiles": [{"t": round(t, 3), "row": i // cols, "col": i % cols} for i, t in enumerate(chunk)],
            })
        mean = sum(coverage) / len(coverage) if coverage else 0.0
        index = {"sheets": sheets, "interval": round(interval, 3), "tileWidth": tile_width, "tileHeight": tile_height,
                 "coverage": round(mean, 4), "visual": mean >= VISUAL_COVERAGE}
        if changed:
            prune_strips(out_dir)
            return index
        os.makedirs(os.path.join(out_dir, base), exist_ok=True)
        _write_json_atomic(os.path.join(out_dir, base, "imports.json"), imports, valid=lambda d: isinstance(d, list))
        # last, so a hit never sees half a strip
        written = _write_json_atomic(os.path.join(key_dir, "index.json"), index, valid=lambda d: isinstance(d, dict) and bool(d.get("sheets")))
        prune_strips(out_dir)
        return written
    finally:
        shutil.rmtree(work, ignore_errors=True)


def scene3d_scene_file(project_dir: str, scene) -> str:
    """The saved 3D a scene id names, as render/scene3d.js finds it: models/scenes/<id>/active.json, or the
    project's own models/active.json when the id is absent."""
    if scene is None:
        return os.path.join(project_dir, "models", "active.json")
    return os.path.join(project_dir, "models", "scenes", scene, "active.json")


def build_scene3d(project, duration, out_dir, max_tiles, min_interval, cols, tile_width, tiles_per_sheet, timeout,
                  props="{}", fps=30, width=1080, height=1920):
    """A 3D item's strip (src engine:scene3d, props {scene, inPoint}). The node sampler materializes the item as an
    export does (the host stage from MONTAJ_SCENE3D_STAGE, the scene read from the project) and renders it in the same
    one-Chromium overlay strip session. Keyed like an overlay, on the stage's content, plus the saved scene's content;
    the stage or scene being absent is the sampler's to report."""
    if not project:
        fail("invalid_param", "--project (the project's folder or its project.json) is required for a 3D item")
    project_dir = os.path.abspath(project)
    if os.path.isfile(project_dir):
        project_dir = os.path.dirname(project_dir)
    props_obj = {k: v for k, v in _props_object(props).items() if k not in SCENE3D_DERIVED_PROPS}
    scene = props_obj.get("scene")
    if scene is not None and (not isinstance(scene, str) or not SCENE_NAME.match(scene)):
        fail("invalid_param", "a 3D's id is lowercase letters, digits and -")
    stage = os.environ.get(SCENE3D_STAGE_ENV) or ""
    scene_file = scene3d_scene_file(project_dir, scene)
    scene_sha = _file_sha(scene_file)
    return build_overlay(stage, duration, out_dir, max_tiles, min_interval, cols, tile_width, tiles_per_sheet, timeout,
                         props=props_obj, fps=fps, width=width, height=height,
                         component=SCENE3D_SRC, key_extra={"scene3d": scene_sha},
                         extra_cmd=("--project-dir", project_dir), hold=((scene_file, scene_sha),))


def _render_dir() -> str:
    if MONTAJ_ROOT not in sys.path:
        sys.path.insert(0, MONTAJ_ROOT)
    from cli.deps import render_runtime_dir
    return render_runtime_dir()


def main():
    p = argparse.ArgumentParser(description="Tile a video into a uniform time-grid filmstrip with an index JSON")
    p.add_argument("--input", required=True, help="Source video file (all-intra proxy expected), an overlay .jsx, or engine:scene3d")
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
    p.add_argument("--project", default=None, help="3D only: the project's folder or project.json")
    args = p.parse_args()

    scene3d = args.input == SCENE3D_SRC
    src = args.input if scene3d else os.path.abspath(args.input)
    if not scene3d:
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

    if scene3d or src.lower().endswith(".jsx"):
        if args.duration is None or args.duration <= 0:
            fail("invalid_param", "--duration (seconds) is required for an overlay .jsx")
        if args.fps < 1 or args.width < 1 or args.height < 1:
            fail("invalid_param", "--fps, --width and --height must be at least 1")
    if scene3d:
        result = build_scene3d(args.project, args.duration, args.out_dir, args.max_tiles, args.min_interval,
                               args.cols, args.tile_width, args.tiles_per_sheet, args.timeout,
                               props=args.props, fps=args.fps, width=args.width, height=args.height)
        print(json.dumps(result))
        return

    if src.lower().endswith(".jsx"):
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
