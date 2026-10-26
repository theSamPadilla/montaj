"""caption_ink: the ink a caption draws, set from the backdrop under it (the caption_ink step, generate_captions).

Over a full-screen light card white captions with a black outline barely read. A card is the graphics that cover the
caption's band: an `opaque: true` overlay, a 3D scene whose backdrop is not transparent, or any other full-canvas overlay
whose own pixels cover the band (frame_broll's paper matte round a window). Footage drawn above it, over the band, ends it. The project data says what to draw, so the editor preview, sample_frame and the export
all draw the same thing: `captions.segments[i].ink` is "dark" or "light", and `inkAuto` ({card, ink, backdrop}: the card
measured under the caption, the ink written for it and the band's luminance) records what this module wrote. An `ink` is this module's only when
`inkAuto` is there and names the same ink; any other combination is a person's choice: never changed.

- `find_card` / `card_under`: the card under a caption's band at a time (`card_under` from the project data alone).
- `band` / `luminance`: the caption's rows of the frame, and the mean relative luminance of a render over them.
- `plan`: what each caption should say, from a render of the backdrop (the frame without the captions). A caption whose
  words lie over different cards (or over a card and footage) is split into one caption per run of words, each inked on
  its own.
- `needs_pass`: whether the step has anything to do (an overlay that may be a card, or ink of ours to clear).
- `update`: plan + the guarded write of `captions` only.

A 3D item's backdrop is read from one frame of the project without the captions, and a JSX card from the overlay
rendered alone; what is read from each (per-row means, see `row_luminances` and `overlay_rows`) is kept in
`render/samples/caption-ink-cache.json`, keyed by everything on screen (`backdrop_key`, `overlay_key`): a re-run over
an unchanged backdrop renders nothing.
"""
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from lib import look_check as lc
from lib.caption_translation import mint_ids
from lib import project_revisions
from lib.proc import detached_kwargs, kill_tree
from lib.project_lock import update_project

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SAMPLE_FRAME_PY = os.path.join(MONTAJ_ROOT, "steps", "render", "sample_frame.py")
SAMPLE_OVERLAY_PY = os.path.join(MONTAJ_ROOT, "steps", "render", "sample_overlay.py")

# plate and subtitle draw on their own box: the step does nothing for them (and clears nothing).
INK_STYLES = ("accent", "clean", "highlight-box", "karaoke", "outline", "pop", "word-by-word")
# A backdrop is light when the mean relative luminance of the caption band is at least this. Paper #efece4 is about
# 0.83, so it draws dark; #a6a49e (about 0.37) and footage stay white.
LIGHT_L = 0.5
# An overlay covers the caption band when at least COVER_SHARE of the band's pixels have alpha >= COVER_ALPHA / 255.
COVER_ALPHA = 230
COVER_SHARE = 0.9
RENDER_WORKERS = 3
# A caption is split at a card's edge only when every piece shows for at least this long.
MIN_PIECE_S = 0.25
RENDER_TIMEOUT_S = 90
# The step's own wall clock for the frames: one not started by then counts as failed, so the caller's timeout (serve's
# 300 s) never has to kill it.
DEADLINE_S = 240
LOCK_TIMEOUT = 30.0
# The 3D backdrop cache: its file name (beside the frames, in <project>/render/samples), a version string that is part of
# every key (bump it when what a key covers changes), and the most entries kept (the oldest go first).
CACHE_FILE = "caption-ink-cache.json"
CACHE_VERSION = "caption-ink-rows-2"
CACHE_MAX_ENTRIES = 200
_LUM = (0.2126, 0.7152, 0.0722)   # Rec.709


class InkProjectChanged(Exception):
    """A caption the plan changes was edited on disk since it was read."""


def _is_translation(seg):
    return bool(seg.get("lang")) and isinstance(seg.get("translationOf"), list)


def _ink_style(project, seg):
    """The style the caption draws in: its own, else the track's, else the renderer's default."""
    caps = project.get("captions") if isinstance(project.get("captions"), dict) else {}
    style = seg.get("style") if seg.get("style") in lc.CAPTION_DEFAULT_SIZE else caps.get("style")
    return style if style in lc.CAPTION_DEFAULT_SIZE else lc.RENDER_DEFAULT_STYLE


def inkable(project, seg):
    """True for a caption the step manages: not a translation, in a style that draws on the backdrop."""
    return not _is_translation(seg) and _ink_style(project, seg) in INK_STYLES


def _mid(seg):
    return (lc._num(seg.get("start")) + lc._num(seg.get("end"))) / 2


def _key(seg, index):
    """("id", id) for a segment with an id, else ("i", index in the raw list): typed, so an id is never read as an
    index."""
    sid = seg.get("id")
    return ("id", sid) if sid and isinstance(sid, (str, int)) else ("i", index)


def ours(seg):
    """True for an ink this module wrote: `inkAuto` there and naming the ink the segment still has. Ink with no
    inkAuto, ink that differs from it (edited) and inkAuto with no ink (removed) are a person's choice."""
    auto = seg.get("inkAuto")
    return isinstance(auto, dict) and seg.get("ink") in ("dark", "light") and auto.get("ink") == seg.get("ink")


def _raw_segments(project):
    caps = project.get("captions")
    segs = caps.get("segments") if isinstance(caps, dict) else None
    return segs if isinstance(segs, list) else []


def needs_pass(project):
    """True when the step has something to do: a caption, and an overlay that may be a card or ink of ours to clear."""
    segs = lc.caption_segments(project)
    return bool(segs) and bool(cards(project) or any(ours(s) for s in segs))


def _canvas_placed(item):
    """timeline-core isFullCanvasPlacement: scale 1, no offset, no rotation, no keyframes but opacity's."""
    for k in ("scale", "scaleX", "scaleY"):
        if abs(lc._num(item.get(k, 1), 1) - 1) > 0.001:
            return False
    if any(abs(lc._num(item.get(k))) > 0.001 for k in ("offsetX", "offsetY", "rotation")):
        return False
    return not any(isinstance(k, dict) and k.get("prop") != "opacity" for k in item.get("keyframes") or [])


def _candidate(item):
    """An overlay that can be a card: over the whole canvas at a static opacity of 1."""
    return (item.get("type") == "overlay" and lc._num(item.get("opacity", 1), 1) >= 0.999 and _canvas_placed(item)
            and lc._num(item.get("end")) > lc._num(item.get("start")))


def cards(project):
    """[(item, label)] of every overlay that may be a card: drawn over the whole canvas, on a drawn track."""
    out = []
    for ti, row in enumerate(lc.drawn_tracks(project)):
        out += [(it, lc._label(it, ti)) for it in row if _candidate(it)]
    return out


def _stack(project, t):
    """[(item, label)] on screen at `t`, top to bottom: the candidate overlays and the footage (video, image)."""
    rows = lc.drawn_tracks(project)
    pos = lc.layer_positions(rows)
    found = []
    for ti, row in enumerate(rows):
        for k, it in enumerate(row):
            if not (lc._num(it.get("start")) <= t < lc._num(it.get("end"))):
                continue
            if _candidate(it) or it.get("type") in lc.VISUAL:
                found.append(((pos[ti], k), it, lc._label(it, ti)))
    found.sort(key=lambda f: f[0], reverse=True)
    return [(it, label) for _, it, label in found]


def on_screen(project, t):
    """The labels of the overlays that may be cards, on screen at `t`."""
    return [label for it, label in _stack(project, t) if it.get("type") == "overlay"]


def _scene_backdrop(project_dir, item, warn):
    """The style of the backdrop a 3D item's scene draws ("studio", "color", ...; "" when it has none): its
    models/scenes/<id>/active.json (the project's own scene is models/active.json), else a scene.json beside it. None
    when the scene cannot be read (a warning is given)."""
    sid = (item.get("props") or {}).get("scene") if isinstance(item.get("props"), dict) else None
    base = os.path.join(project_dir, "models", "scenes", sid) if isinstance(sid, str) and sid else os.path.join(project_dir, "models")
    for name, nested in (("active.json", True), ("scene.json", False)):
        try:
            with open(os.path.join(base, name), encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError):
            continue
        scene = doc.get("scene") if nested and isinstance(doc, dict) else doc
        if isinstance(scene, dict):
            back = scene.get("backdrop")
            return str(back.get("style") or "") if isinstance(back, dict) else ""
    warn(f"3D scene of {item.get('id') or 'a 3D item'} not readable: its captions are not checked against it")
    return None


def _data_cover(item, project_dir, warn):
    """True/False when the project data says whether an overlay covers the frame: opaque, or a 3D scene (whose backdrop
    is not transparent). None for any other overlay: only its pixels can say."""
    if item.get("opaque") is True:
        return True
    if item.get("src") == "engine:scene3d":
        if not project_dir:
            return False
        style = _scene_backdrop(project_dir, item, warn)
        return style is not None and style != "transparent"
    return None


def _footage_hits(item, box, size):
    """True when a video or image's box on the frame (its scale and offset) meets `box`."""
    pb = lc.placed_box({"x": 0, "y": 0, "w": size[0], "h": size[1]}, item, size[0], size[1])
    return pb["x"] < box[2] and pb["x"] + pb["w"] > box[0] and pb["y"] < box[3] and pb["y"] + pb["h"] > box[1]


class Unmeasured(Exception):
    """An overlay that had to be rendered to say whether it covers the band could not be."""


def alpha_cover(png_path, box, frame=None):
    """Share (0..1) of `box` (as luminance takes it) whose pixels are at least 90% opaque."""
    from PIL import Image
    with Image.open(png_path) as im:
        im = im.convert("RGBA")
        sx = im.width / frame[0] if frame else 1.0
        sy = im.height / frame[1] if frame else 1.0
        x0, x1 = sorted((int(round(box[0] * sx)), int(round(box[2] * sx))))
        y0, y1 = sorted((int(round(box[1] * sy)), int(round(box[3] * sy))))
        x0, y0 = max(0, min(x0, im.width - 1)), max(0, min(y0, im.height - 1))
        x1, y1 = max(x0 + 1, min(x1, im.width)), max(y0 + 1, min(y1, im.height))
        hist = im.crop((x0, y0, x1, y1)).getchannel("A").histogram()
    return sum(hist[COVER_ALPHA:]) / ((x1 - x0) * (y1 - y0))


def _mid_frame(item, fps):
    """The frame an overlay is read at: the middle of its own span. An overlay whose coverage changes over its span (a
    fade, a wipe) is accepted as it is there, for every caption over it."""
    return int(round((lc._num(item.get("end")) - lc._num(item.get("start"))) / 2 * fps))


def find_card(project, t, box, size, project_dir=None, measured=None, need=None, warn=None):
    """The card under `box` (the caption's band) at `t`, or None. Walks the items on screen from the top: footage whose
    box meets the band ends it (the caption is over footage); the first overlay that covers the band is the card (a copy
    of the item with `id` = its label). An overlay the data cannot judge is judged by `measured`, {(label, frame): a PNG
    of the overlay alone at the middle of its span, or None when it could not be rendered}; with no `measured` it covers
    nothing. A missing entry
    is added to `need` ({(label, frame): item}) and covers nothing there, else raises Unmeasured, as does a failed one."""
    warn = warn or (lambda _msg: None)
    fps = lc._num((project.get("settings") or {}).get("fps"), 30) or 30
    for item, label in _stack(project, t):
        if item.get("type") != "overlay":
            if _footage_hits(item, box, size):
                return None
            continue
        covers = _data_cover(item, project_dir, warn)
        if covers is None and measured is not None and not str(item.get("src") or "").startswith("engine:"):
            key = (label, _mid_frame(item, fps))
            if key in measured:
                if measured[key] is None:
                    raise Unmeasured(label)
                covers = cover_share(measured[key], box, size) >= COVER_SHARE
            elif need is not None:
                need[key] = item
            else:
                raise Unmeasured(label)
        if covers:
            out = dict(item)
            out["id"] = label
            return out
    return None


def card_under(project, t, box=None, project_dir=None):
    """The card at `t` that the project data alone shows (an opaque overlay, or a 3D scene with a backdrop when
    `project_dir` can read it), or None. `box` is the band to cover; the whole frame without it."""
    size = lc.design_size(project)
    return find_card(project, t, box or (0, 0, size[0], size[1]), size, project_dir)


def band(project, seg, width, height):
    """(x0, y0, x1, y1) px of the rows the caption draws in, within the frame; None when it has no band."""
    s, e = lc._num(seg.get("start")), lc._num(seg.get("end"))
    rows = [r for r in lc.caption_bands(project, s, e, width, height) if abs(r[2] - s) < 1e-6 and abs(r[3] - e) < 1e-6]
    if not rows:
        return None
    top, bottom = max(0.0, rows[0][0]), min(float(height), rows[0][1])
    if bottom - top < 1:
        return None
    return 0, int(top), int(width), int(round(bottom))


def _linear_table():
    out = []
    for v in range(256):
        c = v / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


def luminance(png_path, box, frame=None):
    """Mean relative luminance (0..1) of `box` (x0, y0, x1, y1, in `frame` = (w, h) px when given, else the image's)."""
    from PIL import Image
    with Image.open(png_path) as im:
        im = im.convert("RGB")
        sx = im.width / frame[0] if frame else 1.0
        sy = im.height / frame[1] if frame else 1.0
        x0, x1 = sorted((int(round(box[0] * sx)), int(round(box[2] * sx))))
        y0, y1 = sorted((int(round(box[1] * sy)), int(round(box[3] * sy))))
        x0, y0 = max(0, min(x0, im.width - 1)), max(0, min(y0, im.height - 1))
        x1, y1 = max(x0 + 1, min(x1, im.width)), max(y0 + 1, min(y1, im.height))
        hist = im.crop((x0, y0, x1, y1)).histogram()
    table, total = _linear_table(), (x1 - x0) * (y1 - y0)
    return sum(w * sum(h * lin for h, lin in zip(hist[c * 256:(c + 1) * 256], table))
               for c, w in enumerate(_LUM)) / total


def overlay_luminance(png_path, box, frame, opaque=False):
    """Mean relative luminance of `box` of an overlay rendered alone: over the pixels it covers (alpha >= COVER_ALPHA),
    or, for an opaque overlay, over black (the picture below is hidden)."""
    from PIL import Image
    with Image.open(png_path) as im:
        im = im.convert("RGBA")
        sx, sy = im.width / frame[0], im.height / frame[1]
        x0, x1 = sorted((int(round(box[0] * sx)), int(round(box[2] * sx))))
        y0, y1 = sorted((int(round(box[1] * sy)), int(round(box[3] * sy))))
        x0, y0 = max(0, min(x0, im.width - 1)), max(0, min(y0, im.height - 1))
        x1, y1 = max(x0 + 1, min(x1, im.width)), max(y0 + 1, min(y1, im.height))
        crop = im.crop((x0, y0, x1, y1))
        if opaque:
            rgb, mask = Image.alpha_composite(Image.new("RGBA", crop.size, (0, 0, 0, 255)), crop).convert("RGB"), None
        else:
            rgb, mask = crop.convert("RGB"), crop.getchannel("A").point(lambda a: 255 if a >= COVER_ALPHA else 0)
        hist = rgb.histogram(mask)
    table = _linear_table()
    total = sum(hist[:256]) or 1
    return sum(w * sum(h * lin for h, lin in zip(hist[c * 256:(c + 1) * 256], table))
               for c, w in enumerate(_LUM)) / total


def _lum_sum(hist, table):
    """Sum over the pixels of a 3-channel histogram of their relative luminance."""
    return sum(w * sum(h * lin for h, lin in zip(hist[c * 256:(c + 1) * 256], table)) for c, w in enumerate(_LUM))


def overlay_rows(png_path):
    """What plan reads from an overlay rendered alone, kept per pixel row: {"w": width, "rows": [[pixels with alpha >=
    COVER_ALPHA, the sum of their relative luminance, the sum of the luminance of every pixel over black]]}, each rounded
    to 5 places. A band is full width, so any band's cover share and mean luminance (`OverlayRows`) come from its rows."""
    from PIL import Image
    table = _linear_table()
    with Image.open(png_path) as im:
        im = im.convert("RGBA")
        w, h = im.size
        mask = im.getchannel("A").point(lambda a: 255 if a >= COVER_ALPHA else 0)
        rgb = im.convert("RGB")
        black = Image.alpha_composite(Image.new("RGBA", im.size, (0, 0, 0, 255)), im).convert("RGB")
        rows = []
        for y in range(h):
            line = (0, y, w, y + 1)
            hist = rgb.crop(line).histogram(mask.crop(line))
            rows.append([sum(hist[:256]), round(_lum_sum(hist, table), 5),
                         round(_lum_sum(black.crop(line).histogram(), table), 5)])
    return {"w": w, "rows": rows}


def _row_span(n, box, frame):
    """The rows [y0, y1) of an image n rows tall that `box` (in `frame` = (w, h) px) covers, scaled and clamped as
    `luminance` does."""
    sy = n / frame[1]
    y0, y1 = sorted((int(round(box[1] * sy)), int(round(box[3] * sy))))
    y0 = max(0, min(y0, n - 1))
    return y0, max(y0 + 1, min(y1, n))


class OverlayRows:
    """An overlay's `overlay_rows`, read like its PNG: `cover` is what alpha_cover gives, `lum` what overlay_luminance
    gives, over a full-width band."""

    def __init__(self, data):
        self.w, self.rows = data["w"], data["rows"]

    def cover(self, box, frame):
        y0, y1 = _row_span(len(self.rows), box, frame)
        return sum(r[0] for r in self.rows[y0:y1]) / ((y1 - y0) * self.w)

    def lum(self, box, frame, opaque=False):
        y0, y1 = _row_span(len(self.rows), box, frame)
        if opaque:
            return sum(r[2] for r in self.rows[y0:y1]) / ((y1 - y0) * self.w)
        return sum(r[1] for r in self.rows[y0:y1]) / (sum(r[0] for r in self.rows[y0:y1]) or 1)


def cover_share(measured, box, frame):
    """alpha_cover of a measured overlay: a PNG path, or its OverlayRows."""
    return measured.cover(box, frame) if isinstance(measured, OverlayRows) else alpha_cover(measured, box, frame)


def overlay_read(measured, box, frame, opaque=False):
    """overlay_luminance of a measured overlay: a PNG path, or its OverlayRows."""
    return measured.lum(box, frame, opaque) if isinstance(measured, OverlayRows) \
        else overlay_luminance(measured, box, frame, opaque)


def row_luminances(png_path):
    """[mean relative luminance of each pixel row of the image] (as `luminance` takes it), rounded to 6 places. The
    band of a caption is full width, so its mean over any rows is the mean of those rows' means: one pass over the
    frame serves every band."""
    from PIL import Image
    table = _linear_table()
    with Image.open(png_path) as im:
        im = im.convert("RGB")
        w, h = im.size
        rows = []
        for y in range(h):
            hist = im.crop((0, y, w, y + 1)).histogram()
            rows.append(round(sum(k * sum(n * lin for n, lin in zip(hist[c * 256:(c + 1) * 256], table))
                                  for c, k in enumerate(_LUM)) / w, 6))
    return rows


def band_luminance(rows, box, frame):
    """The mean relative luminance of `box` (x0, y0, x1, y1, in `frame` = (w, h) px) from the per-row means of a frame of
    any size: the rows are scaled and clamped as `luminance` does. The band is full width, so x is not read."""
    sy = len(rows) / frame[1]
    y0, y1 = sorted((int(round(box[1] * sy)), int(round(box[3] * sy))))
    y0 = max(0, min(y0, len(rows) - 1))
    y1 = max(y0 + 1, min(y1, len(rows)))
    return sum(rows[y0:y1]) / (y1 - y0)


def _file_digest(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return "missing"
    return h.hexdigest()


def _tree_digest(root, memo):
    """sha256 over every file under `root` (relative path and content), "none" when it is not a folder. Once per `memo`."""
    if root not in memo:
        h = hashlib.sha256()
        if os.path.isdir(root):
            for base, dirs, files in os.walk(root):
                dirs.sort()
                for name in sorted(files):
                    full = os.path.join(base, name)
                    h.update(os.path.relpath(full, root).encode())
                    h.update(_file_digest(full).encode())
            memo[root] = h.hexdigest()
        else:
            memo[root] = "none"
    return memo[root]


def _file_stat(path):
    try:
        st = os.stat(path)
    except OSError:
        return [path, None, None]
    return [path, st.st_size, st.st_mtime_ns]


def backdrop_key(project, project_dir, t, memo=None):
    """The cache key of the frame without captions at `t`: a sha256 of everything that could change a pixel under any
    caption band there. That is: CACHE_VERSION; `t` (3 decimals); the
    project's resolution, fps and colorSpace; and every item on screen at `t` on any drawn track, in track order (so the
    z-order), as the whole item (type, start, end, inPoint, speed, scale/offset/rotation/opacity, crop, keyframes, props,
    src, googleFonts: anything it holds, so a field added later is covered too), plus the content of what it draws: a
    JSX overlay's file and the project's whole `overlays/` folder (what it may import: correct, a little less precise
    than following the imports), a 3D scene's whole `models/` tree (its scene and every model it may reference), and a
    video's or image's file (src, proxySrc, normalizedSrc: path, size and mtime). Captions are not in it: they are drawn
    over the frame, never in it, so a change to their text, ink or style is a hit."""
    memo = {} if memo is None else memo
    settings = project.get("settings") or {}
    parts = {"v": CACHE_VERSION, "t": round(float(t), 3), "resolution": settings.get("resolution"),
             "fps": settings.get("fps"), "colorSpace": settings.get("colorSpace"), "items": []}
    for ti, row in enumerate(lc.drawn_tracks(project)):
        for it in row:
            if not (lc._num(it.get("start")) <= t < lc._num(it.get("end"))):
                continue
            entry = {"track": ti, "item": it, "files": []}
            src = it.get("src")
            if it.get("type") == "overlay":
                if src == "engine:scene3d":
                    entry["files"].append(_tree_digest(os.path.join(project_dir, "models"), memo))
                elif not str(src or "").startswith("engine:"):
                    path = lc.overlay_path(it, project_dir)
                    entry["files"] += [_file_digest(path) if path else "none",
                                       _tree_digest(os.path.join(project_dir, "overlays"), memo)]
            elif it.get("type") in lc.VISUAL:
                entry["files"] = [_file_stat(it[f]) for f in ("src", "proxySrc", "normalizedSrc")
                                  if isinstance(it.get(f), str)]
            parts["items"].append(entry)
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def overlay_key(project, project_dir, item, frame, memo=None):
    """The cache key of an overlay rendered alone at `frame`: a sha256 of CACHE_VERSION; the whole item (src, props,
    googleFonts, start, end: its length is the render's duration; geometry too, though a card has none); `frame`; the
    design size and fps it renders at; its file and the project's whole `overlays/` folder (what it may import: correct,
    a little less precise than following the imports). Captions are not in it, so a caption-only change is a hit."""
    memo = {} if memo is None else memo
    path = lc.overlay_path(item, project_dir)
    parts = {"v": CACHE_VERSION, "kind": "overlay", "item": item, "frame": frame, "size": list(lc.design_size(project)),
             "fps": (project.get("settings") or {}).get("fps"), "file": _file_digest(path) if path else "none",
             "overlays": _tree_digest(os.path.join(project_dir, "overlays"), memo)}
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def load_cache(path):
    """{key: {"rows": [...], "at": epoch seconds}} from the cache file; empty when it is missing, unreadable or not what
    this module wrote."""
    try:
        with open(path, encoding="utf-8") as f:
            entries = json.load(f)["entries"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    if not isinstance(entries, dict):
        return {}
    return {k: v for k, v in entries.items()
            if isinstance(v, dict) and isinstance(v.get("rows"), list) and v["rows"] and _timed(v.get("at"))}


def store_cache(path, new):
    """Merge `new` ({key: {"rows": [...], ...}}) into the cache file, keep the CACHE_MAX_ENTRIES newest, write it atomically (a rename,
    so a reader never sees half a file). A file that cannot be written is no error: the next run just renders again."""
    entries = load_cache(path)
    now = time.time()
    for k, entry in new.items():
        entries[k] = {**entry, "at": now}
    keep = sorted(entries.items(), key=lambda kv: kv[1]["at"])[-CACHE_MAX_ENTRIES:]
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".caption-ink-cache-", dir=os.path.dirname(path))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"entries": dict(keep)}, f)
        os.replace(tmp, path)
    except OSError:
        pass


def _run_group(cmd, timeout):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **detached_kwargs())
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out, err
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        proc.communicate()
        return None


def frame_renderer(project_path, out_dir, deadline=None):
    """render_fn(t) -> the path of the project's frame at `t` without the captions (sample_frame --no-captions), written
    into `out_dir`. A frame is given RENDER_TIMEOUT_S, or what is left until `deadline` (time.monotonic) when sooner."""
    def render(t):
        timeout = RENDER_TIMEOUT_S
        if deadline is not None:
            timeout = min(timeout, deadline - time.monotonic())
            if timeout <= 0:
                raise RuntimeError("out of time")
        out = os.path.join(out_dir, f"ink-{t:.3f}s.png")
        r = _run_group([sys.executable, SAMPLE_FRAME_PY, "--project", project_path, "--at", f"{t:.3f}",
                        "--no-captions", "--out", out], timeout)
        if r is None:
            raise RuntimeError("timed out")
        if r[0] != 0 or not os.path.isfile(out):
            raise RuntimeError("sample_frame failed")
        return out
    return render


def overlay_renderer(project, project_dir, out_dir, deadline=None):
    """overlay_fn(item, frame) -> the path of a transparent PNG of the overlay rendered alone at `frame` (steps/render/
    sample_overlay.py, as look measures it but without --measure), at the project's design size and fps, over the
    item's own length. Same time limits as frame_renderer."""
    width, height = lc.design_size(project)
    fps = int(round(lc._num((project.get("settings") or {}).get("fps"), 30))) or 30

    def render(item, frame):
        path = lc.overlay_path(item, project_dir)
        if not path or not os.path.isfile(path):
            raise RuntimeError("overlay file missing")
        timeout = RENDER_TIMEOUT_S
        if deadline is not None:
            timeout = min(timeout, deadline - time.monotonic())
            if timeout <= 0:
                raise RuntimeError("out of time")
        out = os.path.join(out_dir, f"ink-overlay-{abs(hash((item.get('id'), frame)))}-{frame}.png")
        span = max(1, int(round((lc._num(item.get("end")) - lc._num(item.get("start"))) * fps)))
        cmd = [sys.executable, SAMPLE_OVERLAY_PY, "--overlay", path, "--frame", str(frame), "--duration", str(span),
               "--fps", str(fps), "--width", str(width), "--height", str(height),
               "--props", json.dumps(item.get("props") or {}), "--out", out]
        for font in item.get("googleFonts") or []:
            if isinstance(font, str) and font:
                cmd += ["--google-fonts", font]
        r = _run_group(cmd, timeout)
        if r is None:
            raise RuntimeError("timed out")
        if r[0] != 0 or not os.path.isfile(out):
            raise RuntimeError("sample_overlay failed")
        return out
    return render


def _pooled(fn, jobs, deadline):
    """{job key: result or None} for jobs [(key, args)], RENDER_WORKERS at a time, and {key: why} for the failed ones.
    A job not started by `deadline` (time.monotonic) fails."""
    def one(job):
        key, args = job
        if deadline is not None and time.monotonic() >= deadline:
            return key, None, "out of time"
        try:
            return key, fn(*args), None
        except Exception as e:  # noqa: BLE001 — a failed render leaves its captions as they are
            return key, None, str(e)[:80]
    done, failed = {}, {}
    with ThreadPoolExecutor(max_workers=RENDER_WORKERS) as pool:
        for key, out, why in pool.map(one, jobs):
            if out:
                done[key] = out
            else:
                done[key] = None
                failed[key] = why
    return done, failed


def _timed(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _word_text(w):
    return w.get("word", w.get("text"))


def _timed_words(seg):
    """The words of a caption that can be split: at least two, each a string with a start and an end. Else None."""
    words = seg.get("words")
    if not isinstance(words, list) or len(words) < 2:
        return None
    for w in words:
        if not (isinstance(w, dict) and isinstance(_word_text(w), str) and _timed(w.get("start")) and _timed(w.get("end"))):
            return None
    return words


def split_pieces(seg, labels):
    """The pieces `seg` is split into, one per run of consecutive words with the same label in `labels` (one per word),
    or None when there is one run or a piece would be shorter than MIN_PIECE_S. A piece keeps every field of `seg` but
    its ink, takes its run's words and text, starts at its first word (the first piece at the caption's start) and ends
    at its last word (the last piece at the caption's end). The first piece keeps the id; the others have none."""
    words = seg["words"]
    runs = []   # [first word, one past the last]
    for i, label in enumerate(labels):
        if runs and labels[runs[-1][0]] == label:
            runs[-1][1] = i + 1
        else:
            runs.append([i, i + 1])
    if len(runs) < 2:
        return None
    pieces = []
    for n, (first, past) in enumerate(runs):
        part = copy.deepcopy(seg)
        for f in ("ink", "inkAuto"):
            part.pop(f, None)
        part["words"] = copy.deepcopy(words[first:past])
        part["start"] = seg["start"] if n == 0 else words[first]["start"]
        part["end"] = seg["end"] if n == len(runs) - 1 else words[past - 1]["end"]
        part["text"] = " ".join(_word_text(w) for w in part["words"])
        if n:
            part.pop("id", None)
        if part["end"] - part["start"] < MIN_PIECE_S - 1e-9:
            return None
        pieces.append(part)
    return pieces


def _with_pieces(project, index, pieces):
    """The project with the caption at raw index `index` replaced by `pieces`."""
    caps = dict(project["captions"])
    segs = list(caps["segments"])
    segs[index:index + 1] = pieces
    return {**project, "captions": {**caps, "segments": segs}}


def plan(project, render_fn, width, height, deadline=None, overlay_fn=None, project_dir=None, cache_path=None):
    """(changes, counts, warnings). changes: {segment key: {"ink", "inkAuto": {"card", "ink", "backdrop"}}, None to clear,
    or {"split": [the segments that replace it]}}, keyed by `_key` over the raw segment list. A caption whose words lie
    over different cards is split into one segment per run (see split_pieces; the new ids are minted against the
    captions), each inked by its own middle. Where a backdrop is read: from the overlay-alone PNG for a JSX card
    (overlay_fn(item, frame) -> a PNG path of one overlay rendered alone, once per overlay at the middle of its span;
    also what says whether an overlay whose pixels decide covers a caption's band, see find_card), else from one frame
    without the captions per card item (render_fn(t) -> a PNG path, three at a time), at the middle of the span of the
    captions over it. Without overlay_fn only the data decides and every card is read from a frame.
    `project_dir` is where 3D scene files are read. With `cache_path` (and `project_dir`) a 3D frame is read once per
    `backdrop_key`: its per-row means are kept in that file and a later plan over the same backdrop renders nothing.
    A frame not started by `deadline` (time.monotonic) counts as
    failed; a caption whose card or backdrop could not be had is left as it is."""
    counts = {"dark": 0, "light": 0, "cleared": 0, "kept": 0, "split": 0}
    changes, warnings = {}, []
    size = (width, height)
    warns = {}   # a message once, in the order it came
    warn = lambda msg: warns.setdefault(msg, None)  # noqa: E731
    raw = _raw_segments(project)
    named = {sid for s in raw if isinstance(s, dict) and _is_translation(s) for sid in s["translationOf"]}
    mine = []   # (key, seg, mid, box, raw index): captions to look under
    for i, seg in enumerate(raw):
        if not isinstance(seg, dict) or not inkable(project, seg):
            continue
        if not ours(seg) and (seg.get("ink") or "inkAuto" in seg):
            counts["kept"] += 1
            continue
        mid = _mid(seg)
        box = band(project, seg, width, height)
        if box is None and any(it.get("type") == "overlay" for it, _ in _stack(project, mid)):
            warnings.append(f"no caption band at {lc.r2(mid)}s")
            continue
        mine.append((_key(seg, i), seg, mid, box, i))

    use_cache = bool(cache_path and project_dir)
    cached = load_cache(cache_path) if use_cache else {}
    fresh, memo, lock = {}, {}, threading.Lock()   # fresh: what this plan read, to keep
    if overlay_fn is not None and use_cache:
        render_overlay = overlay_fn

        def overlay_fn(item, frame):   # noqa: F811 — the same call, read from the cache when its key is there
            key = overlay_key(project, project_dir, item, frame, memo)
            hit = cached.get(key)
            if hit and isinstance(hit.get("w"), int):
                return OverlayRows(hit)
            data = overlay_rows(render_overlay(item, frame))
            with lock:
                fresh[key] = data
            return OverlayRows(data)

    def classify(need):
        """[{key, seg, pieces (or None), slots}]: each slot {seg, mid, card (an id or None)} is a caption, or a piece,
        to ink. A caption whose card could not be judged is left out."""
        def card_at(t, box):
            return find_card(project, t, box, size, project_dir, measured, need if measured is not None else None, warn)
        out = []
        for key, seg, mid, box, i in mine:
            try:
                pieces = None
                words = _timed_words(seg) if box is not None and seg.get("id") and seg["id"] not in named else None
                if words:
                    labels = []
                    for w in words:
                        c = card_at((w["start"] + w["end"]) / 2, box)
                        labels.append(c["id"] if c else None)
                    pieces = split_pieces(seg, labels)
                if pieces:
                    sub = _with_pieces(project, i, pieces)
                    slots = []
                    for part in pieces:
                        pm, pb = _mid(part), band(sub, part, width, height)
                        if pb is None and any(it.get("type") == "overlay" for it, _ in _stack(project, pm)):
                            slots = None
                            break
                        c = card_at(pm, pb) if pb is not None else None
                        slots.append({"seg": part, "mid": pm, "box": pb, "card": c["id"] if c else None, "item": c})
                    if slots is None:
                        pieces = None
                if not pieces:
                    c = card_at(mid, box) if box is not None else None
                    slots = [{"seg": seg, "mid": mid, "box": box, "card": c["id"] if c else None, "item": c}]
            except Unmeasured:
                continue
            out.append({"key": key, "seg": seg, "pieces": pieces, "slots": slots})
        return out

    measured = None
    if overlay_fn is None:
        entries = classify(None)
    else:
        measured = {}
        for _ in range(4):   # a piece's middle may meet an overlay no word's did: measure it and look again
            need = {}
            entries = classify(need)
            if not need:
                break
            samples, failed = _pooled(overlay_fn, [(k, (it, k[1])) for k, it in need.items()], deadline)
            measured.update(samples)
            for k, why in failed.items():
                warn(f"overlay {k[0]} at frame {k[1]} not rendered ({why or 'no image'}): its captions are unchanged")
        else:
            entries = classify(None)
    slots = [sl for e in entries for sl in e["slots"] if sl["card"]]
    fps = int(round(lc._num((project.get("settings") or {}).get("fps"), 30))) or 30
    # A JSX card (a matte, an opaque overlay) is read from its own render: where it covers the band (alpha >= 0.9, which
    # is what makes it a card) the composite IS the overlay's pixels, so its mean over those pixels is the backdrop's,
    # with no frame composited. An opaque one hides everything below, so its transparent pixels are black.
    jsx = [sl for sl in slots if overlay_fn is not None and not str(sl["item"].get("src") or "").startswith("engine:")]
    if jsx:
        again = {}
        for sl in jsx:
            k = (sl["card"], _mid_frame(sl["item"], fps))
            if k not in measured:
                again[k] = sl["item"]
        samples, bad = _pooled(overlay_fn, [(k, (it, k[1])) for k, it in again.items()], deadline)
        measured.update(samples)
        for k, why in bad.items():
            warn(f"overlay {k[0]} at frame {k[1]} not rendered ({why or 'no image'}): its captions are unchanged")
    warnings += list(warns)
    for sl in jsx:
        png = measured.get((sl["card"], _mid_frame(sl["item"], fps)))
        if png is None:
            continue
        try:
            sl["lum"] = overlay_read(png, sl["box"], (width, height), sl["item"].get("opaque") is True)
        except Exception as e:  # noqa: BLE001
            warnings.append(f"overlay {sl['card']} unreadable ({str(e)[:60]})")
    # Any other card (a 3D item) is read from one frame without the captions per ITEM, at the middle of the span of the
    # captions over it, and each caption uses its own band of it. A camera move within one item is read once. Each
    # frame gets its own worker: 3D frames are the heavy ones.
    groups = {}
    for sl in slots:
        if sl not in jsx:
            groups.setdefault(sl["card"], []).append(sl)
    for g in groups.values():
        item = g[0]["item"]
        t = (min(lc._num(sl["seg"].get("start")) for sl in g) + max(lc._num(sl["seg"].get("end")) for sl in g)) / 2
        t = min(max(t, lc._num(item.get("start"))), lc._num(item.get("end")) - 0.001)
        for sl in g:
            sl["at"] = round(t, 3)
    times = sorted({sl["at"] for g in groups.values() for sl in g})
    keys = {}
    if use_cache and times:
        keys = {t: backdrop_key(project, project_dir, t, memo) for t in times}
    rows = {t: cached[k]["rows"] for t, k in keys.items() if k in cached}
    todo = [t for t in times if t not in rows]
    pngs, failed = _pooled(render_fn, [(t, (t,)) for t in todo], deadline) if todo else ({}, {})
    pngs = {t: p for t, p in pngs.items() if p}
    for t in todo:
        if t in failed:
            warnings.append(f"frame at {t}s not rendered ({failed[t] or 'no image'}): its captions are unchanged")
    for t, png in pngs.items():
        try:
            rows[t] = row_luminances(png)
        except Exception as e:  # noqa: BLE001
            warnings.append(f"frame at {t}s unreadable ({str(e)[:60]})")
            continue
        if t in keys:
            fresh[keys[t]] = {"rows": rows[t]}
    if fresh:   # only with a cache_path
        store_cache(cache_path, fresh)
    for g in groups.values():
        for sl in g:
            if sl["at"] in rows:
                sl["lum"] = band_luminance(rows[sl["at"]], sl["box"], (width, height))
    for sl in slots:
        if "lum" in sl:
            ink = "dark" if sl["lum"] >= LIGHT_L else "light"
            sl["change"] = {"ink": ink, "inkAuto": {"card": sl["card"], "ink": ink, "backdrop": round(sl["lum"], 3)}}
    for e in entries:
        if e["pieces"] is None:
            sl = e["slots"][0]
            if sl["card"] is None:
                if ours(e["seg"]):
                    changes[e["key"]] = None
                    counts["cleared"] += 1
            elif "change" in sl:
                changes[e["key"]] = sl["change"]
                counts[sl["change"]["ink"]] += 1
        elif all("change" in sl for sl in e["slots"] if sl["card"]):
            for sl in e["slots"]:
                if sl["card"]:
                    sl["seg"].update(sl["change"])
                    counts[sl["change"]["ink"]] += 1
                elif ours(e["seg"]):
                    counts["cleared"] += 1
            changes[e["key"]] = {"split": [sl["seg"] for sl in e["slots"]]}
            counts["split"] += 1
    minted = [p for ch in changes.values() if ch and "split" in ch for p in ch["split"] if "id" not in p]
    taken = {s["id"] for s in raw if isinstance(s, dict) and isinstance(s.get("id"), str)}
    for p, new in zip(minted, mint_ids(minted, taken)):
        p["id"] = new["id"]
    return changes, counts, warnings


def _captions_of(project):
    caps = project.get("captions")
    if not isinstance(caps, dict) or not isinstance(caps.get("segments"), list):
        raise InkProjectChanged("captions")
    return caps


def _check_split(fresh, segments, seg, pieces, project_dir):
    """Refuse (InkProjectChanged) a split the fresh project no longer allows: an id the pieces mint is taken now, or a
    piece's card is not the one under it now (for a piece with no ink: a card the data shows)."""
    ids = [p.get("id") for p in pieces]
    others = {s.get("id") for s in segments if isinstance(s, dict) and s is not seg}
    if ids[0] != seg.get("id") or len(set(ids)) != len(ids) or not all(ids) or others & set(ids[1:]):
        raise InkProjectChanged(seg.get("id"))
    sub = _with_pieces(fresh, next(i for i, s in enumerate(segments) if s is seg), pieces)
    size = lc.design_size(fresh)
    for part in pieces:
        mid = _mid(part)
        if isinstance(part.get("inkAuto"), dict):
            if part["inkAuto"]["card"] not in on_screen(fresh, mid):
                raise InkProjectChanged(part["id"])
        elif find_card(fresh, mid, band(sub, part, *size) or (0, 0, *size), size, project_dir) is not None:
            raise InkProjectChanged(part["id"])


def apply_changes(fresh, changes, read, project_dir=None):
    """Write `changes` onto the fresh project's captions. `read` is {key: the whole segment as the plan read it}: a
    changed segment that is gone, is not the only one with its key, or differs from what was read in any field raises
    InkProjectChanged, and nothing is written; so does one whose card is no longer on screen at the caption's middle, or
    that is to be cleared and lies under a card the data shows now (opaque, or a 3D scene: a card found by its pixels
    is not rendered again under the lock). A split replaces the segment with its pieces, in place, and is refused the
    same way for each piece, and when an id it mints is in use now. Returns True when anything changed."""
    segments = _captions_of(fresh)["segments"]
    found = {}
    for key, change in changes.items():
        hits = [s for i, s in enumerate(segments) if isinstance(s, dict) and _key(s, i) == key]
        if len(hits) != 1 or hits[0] != read[key]:
            raise InkProjectChanged(key)
        mid = _mid(hits[0])
        if change is not None and "split" in change:
            _check_split(fresh, segments, hits[0], change["split"], project_dir)
        elif change is not None:
            if change["inkAuto"]["card"] not in on_screen(fresh, mid):
                raise InkProjectChanged(key)
        else:
            size = lc.design_size(fresh)
            box = band(fresh, hits[0], *size) or (0, 0, *size)
            if find_card(fresh, mid, box, size, project_dir) is not None:
                raise InkProjectChanged(key)
        found[key] = hits[0]
    changed = False
    for key, change in changes.items():
        seg = found[key]
        if change is None:
            for f in ("ink", "inkAuto"):
                changed |= seg.pop(f, None) is not None
        elif "split" in change:
            at = next(i for i, s in enumerate(segments) if s is seg)
            segments[at:at + 1] = copy.deepcopy(change["split"])
            changed = True
        else:
            changed |= any(seg.get(f) != v for f, v in change.items())
            seg.update(change)
    return changed


def update(project_path, render_fn=None, timeout=LOCK_TIMEOUT, overlay_fn=None):
    """Read the project, plan, and write `captions` only (under the project lock, onto the fresh captions).
    Returns the answer ({dark, light, cleared, kept, split, changed, warnings?}; `changed` is whether anything was written) or
    None when there is nothing to do (see needs_pass). Raises InkProjectChanged; lock errors (ProjectLockTimeout,
    ProjectReadOnly, SyncConflict) pass through."""
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    with open(project_path, encoding="utf-8") as f:
        project = json.load(f)
    if not needs_pass(project):
        return None
    width, height = lc.design_size(project)
    caps = project["captions"]
    read_rev = project_revisions.revisions_of(project, ["captions"]) if project_revisions.engine_guard_enabled() else None
    read_rest = copy.deepcopy({k: v for k, v in caps.items() if k != "segments"})
    read = {_key(s, i): copy.deepcopy(s) for i, s in enumerate(caps["segments"]) if isinstance(s, dict)}
    samples = None
    deadline = None
    cache_path = None
    if render_fn is None:
        cache_path = os.path.join(project_dir, "render", "samples", CACHE_FILE)
        deadline = time.monotonic() + DEADLINE_S
        base = os.path.join(project_dir, "render", "samples")
        os.makedirs(base, exist_ok=True)
        samples = tempfile.mkdtemp(prefix="caption-ink-", dir=base)   # this run's frames; another pass shares none
        render_fn = frame_renderer(project_path, samples, deadline)
        overlay_fn = overlay_renderer(project, project_dir, samples, deadline)
    try:
        changes, counts, warnings = plan(project, render_fn, width, height, deadline, overlay_fn, project_dir,
                                         cache_path)
    finally:
        if samples:
            shutil.rmtree(samples, ignore_errors=True)
    out = dict(counts)
    if warnings:
        out["warnings"] = warnings
    out["changed"] = False
    if not changes:
        return out

    def apply(fresh):
        fresh_caps = _captions_of(fresh)
        if read_rev is not None:   # §477: the captions field as read against now
            if project_revisions.stale_fields(fresh, ["captions"], read_rev)["stale"]:
                raise InkProjectChanged("captions")
        elif {k: v for k, v in fresh_caps.items() if k != "segments"} != read_rest:   # style, showLangs, ...
            raise InkProjectChanged("captions")
        if apply_changes(fresh, changes, read, project_dir):
            out["changed"] = True
            return fresh
        return None
    update_project(project_path, apply, timeout=timeout)
    return out
