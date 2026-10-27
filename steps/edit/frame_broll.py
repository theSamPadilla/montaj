#!/usr/bin/env python3
"""frame_broll (PL89): a landscape clip on a vertical timeline (b-roll), framed in one call.

- `track`: the moving subject is found across the clip's range (lib/subject_track.py: background subtraction, numpy
  only, on frames ffmpeg decodes small) and the item gets a full-height crop of the canvas's shape whose left edge
  is keyframed to follow it (`sourceCrop` plus a `cropX` track, item seconds).
- `card`: the whole frame, scaled into the upper middle of the canvas (above the captions), under a footage-card
  overlay (montaj_assets/render/templates/presets/footage-card.jsx): paper round it, corner brackets on the
  tracked subject (or the footage's corners) and `Footage: <source>` under it.
- `auto` (the default, Sam 2026-10-26): `card` for landscape action across the frame (its whole width shows; the card
  zooms to the subject and leaves burned-in text out where it can), `track` only for a subject a 9:16 crop holds with
  room to move and the captions clear of it; the answer says why.
- A clip already as tall as the canvas needs nothing, and nothing is written.
- The write: tracks only, through lib/project_lock.update_project_or_fail, refused (`project_changed`) when the
  tracks changed since the step read them; a version of the project first, as place's update takes one.
- The answer: one short JSON, with `path`, a sheet of the item's range on the timeline as it now looks.
"""
import argparse, contextlib, copy, io, json, os, re, subprocess, sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import look_check as lc, project_revisions, subject_track, sync_clash  # noqa: E402
from lib.common import fail, ffmpeg_bin, ffprobe_value, ff_seconds, ff_input, get_duration  # noqa: E402
from lib.path_match import spaced_twin  # noqa: E402
from lib.project_lock import update_project_or_fail  # noqa: E402
from lib.project_tracks import normalize_tracks  # noqa: E402
from lib.footage_credit import (  # noqa: E402,F401  (frame_broll's own names, kept for its callers and tests)
    PLATFORMS, default_credit, is_footage_card, profile_wants_no_credits, provenance_of, source_of, titles_notes)
from lib.project_versions import commit_version, is_own_repo  # noqa: E402
import steps.edit.place as place  # noqa: E402

ANALYSIS_W = 192          # px wide the frames are read at
TRACK_FPS = 6             # frames a second read over the item's range
BG_FPS = 2                # and over the wider window the background comes from
BG_MARGIN_S = 6.0         # seconds of the source either side of the range in that window
CARD_SCALE = 0.88         # the card's footage width, a share of the canvas
CARD_CENTER_Y = 0.36      # its centre, a share of the canvas height (above the captions at 56-76%)
SHEET_TIMES = 4
KEY_TOLERANCE = 0.006     # a crop key is dropped when the line between its neighbours is this close to it
UNDER_CAPTIONS = 0.5      # the share of the frames with the subject that put it under the captions, for auto to card
DEFAULT_CAPTION_BAND = (0.56, 0.76)   # where montaj's captions draw on a tall frame, every style (look_check.CAPTION_BAND)
VERSION_MESSAGE = "version: before frame_broll"
STEP_LOCK_TIMEOUT = 30.0
CARD_ZOOM_MIN = 0.45      # a card zooms to at most this share of the frame (the subject at a readable size)
CARD_ZOOM_MAX = 0.85      # and only when it keeps under this share: a subject that roams the frame is not zoomed
CARD_ZOOM_MARGIN = 0.06   # room round everywhere the subject goes, a share of the frame
TRACK_ROOM = 0.8          # auto tracks only motion this share of the crop's width at most (room to move); wider is carded
TEXT_TRIM_ZOOMS = (0.9, 0.85)   # an unzoomed card zooms in this far to leave burned-in text out, when the subject allows
DEFAULT_MATTE = "#F5F3EB"   # a warm cream, when a profile asks for mattes but names no colour
MAX_ITEMS = 48          # items in one call: a sanity bound (they are read MAX_PARALLEL at a time, then one write)
MAX_PARALLEL = 4        # clips read and tracked at once
MAX_SHEET_TIMES = 12    # times on the sheet of a list
DONE = ". Done: this clip is framed; run frame_broll with another mode to change it, not an edit by hand."


def read_tracks(project_path):
    """The project as read, and its tracks' revision."""
    with open(project_path, encoding="utf-8") as f:
        doc = json.load(f)
    return doc, project_revisions.revision_of(doc.get("tracks"))


def gray_frames(src, start, end, fps):
    """Frames (n, h, w) of `src` from `start` to `end` seconds, grey, ANALYSIS_W wide."""
    import numpy as np
    cmd = [ffmpeg_bin(), "-v", "error", "-ss", ff_seconds(start), "-t", ff_seconds(max(0.1, end - start)),
           "-i", ff_input(src), "-vf", f"fps={fps},scale={ANALYSIS_W}:-2,format=gray", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    probe = [ffmpeg_bin(), "-v", "error", "-ss", ff_seconds(start), "-i", ff_input(src), "-frames:v", "1",
             "-vf", f"scale={ANALYSIS_W}:-2,format=gray", "-f", "rawvideo", "-"]
    h = len(subprocess.run(probe, capture_output=True, check=True).stdout) // ANALYSIS_W
    n = len(raw) // (ANALYSIS_W * h)
    return np.frombuffer(raw[: n * ANALYSIS_W * h], dtype=np.uint8).reshape(n, h, ANALYSIS_W)


def profile_matte(project):
    """The person's matte for wide footage, from their profile's "Titles & overlays" notes (profileSnapshot's
    styleProfilePath): {"paper": its colour (the line's first #hex, else DEFAULT_MATTE), "brackets": False when the line
    says no borders} for the first line there about mattes; None when the notes say nothing about mattes (or there are
    no notes)."""
    section = titles_notes(project)
    line = next((l for l in section if re.search(r"\bmattes?\b", l, re.I)), None)
    if line is None:
        return None
    hexes = re.findall(r"#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b", line)
    return {"paper": hexes[0] if hexes else DEFAULT_MATTE,
            "brackets": not re.search(r"\bno (?:decorative )?(?:borders?|frames?|framing)\b|\bwithout (?:decorative )?borders?\b", line, re.I)}


ADD_FIRST = "add the clip to an upper track first, then pass its item id"
def caption_band(project, start, end, width, height):
    """(top, bottom) as shares of the height where the captions draw over [start, end): the project's own style, or
    every style's band on a tall frame when it has no captions yet (they are usually added later)."""
    bands = lc.caption_bands(project, start, end, width, height)
    if bands:
        return min(b[0] for b in bands) / height, max(b[1] for b in bands) / height
    return DEFAULT_CAPTION_BAND


def under_captions(boxes, band, share=0.3):
    """The share of the subject's boxes [x, y, w, h] with over `share` of their height in the caption band."""
    hit = [max(0.0, min(y + h, band[1]) - max(y, band[0])) > share * h for _, y, _, h in boxes]
    return sum(hit) / len(hit) if hit else 0.0


def simplify(points, tol=KEY_TOLERANCE):
    """Keys [(t, v)] without those the straight line between their neighbours already gives (within tol)."""
    if len(points) <= 2:
        return points
    keep = [points[0]]
    for i in range(1, len(points) - 1):
        (t0, v0), (t1, v1), (t2, v2) = keep[-1], points[i], points[i + 1]
        line = v0 + (v2 - v0) * (t1 - t0) / (t2 - t0) if t2 > t0 else v0
        if abs(line - v1) > tol:
            keep.append(points[i])
    keep.append(points[-1])
    return keep


def default_sampler(project_path, times, out):
    """One labelled sheet of the timeline at `times` (sample_frame's renderer, in one process)."""
    import tempfile
    from lib.sheet import tile_sheet
    from steps.render.sample_frame import sample_frames
    with tempfile.TemporaryDirectory() as work:
        paths = sample_frames(project_path, times, work)
        tile_sheet(paths, times, len(times), 270, out, label_px=26)
    return out


class ItemRefused(Exception):
    """One item's refusal: fail() for a single item, a line of its own in a list."""
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def _clip_file(src, project_dir):
    """The file an item's src names: a relative src is the project folder's (as the render reads it), and a name
    typed with a plain space for a U+202F, or in another Unicode form, finds its twin (lib/path_match.py, PL89i)."""
    if not isinstance(src, str) or not src:
        return None
    full = src if os.path.isabs(src) else os.path.join(project_dir, src)
    return full if os.path.exists(full) else (spaced_twin(full) or full)


def _subject_bounds(found):
    """(u0, v0, u1, v1): everywhere the subject goes, with CARD_ZOOM_MARGIN round it, clamped to the frame."""
    u0 = min(p["box"][0] for _, p in found) - CARD_ZOOM_MARGIN
    v0 = min(p["box"][1] for _, p in found) - CARD_ZOOM_MARGIN
    u1 = max(p["box"][0] + p["box"][2] for _, p in found) + CARD_ZOOM_MARGIN
    v1 = max(p["box"][1] + p["box"][3] for _, p in found) + CARD_ZOOM_MARGIN
    return max(u0, 0.0), max(v0, 0.0), min(u1, 1.0), min(v1, 1.0)


def _centred(bounds, z):
    u0, v0, u1, v1 = bounds
    return min(max((u0 + u1) / 2 - z / 2, 0.0), 1 - z), min(max((v0 + v1) / 2 - z / 2, 0.0), 1 - z)


def text_inside(grid, zx, zy, z):
    """How much of the still-text map's cells (subject_track.static_text) a zoom window [zx, zx+z] x [zy, zy+z] holds:
    the summed area of the overlap, in cells."""
    rows, cols = len(grid), len(grid[0]) if grid else 0
    total = 0.0
    for r in range(rows):
        for c in range(cols):
            if not grid[r][c]:
                continue
            ox = max(0.0, min(zx + z, (c + 1) / cols) - max(zx, c / cols)) * cols
            oy = max(0.0, min(zy + z, (r + 1) / rows) - max(zy, r / rows)) * rows
            total += ox * oy
    return round(total, 6)


def place_zoom(bounds, z, grid, step=0.01):
    """Where a z-sized zoom window sits: holding `bounds` (u0, v0, u1, v1) whole where it fits, with the least burned-in
    text inside, and nearest the subject's centre among those (centred on it when there is no text)."""
    u0, v0, u1, v1 = bounds
    cx, cy = _centred(bounds, z)
    if not grid or not any(any(r) for r in grid):
        return cx, cy

    def span(lo, hi):
        a, b = max(0.0, hi - z), min(lo, 1 - z)
        if a > b:
            return [min(max((lo + hi) / 2 - z / 2, 0.0), 1 - z)]
        k = max(1, int(round((b - a) / step)))
        return [a + (b - a) * i / k for i in range(k + 1)]
    best = None
    for x in span(u0, u1):
        for y in span(v0, v1):
            key = (text_inside(grid, x, y, z), abs(x - cx) + abs(y - cy))
            if best is None or key < best[0]:
                best = (key, x, y)
    return best[1], best[2]


SLOTS = {"top": (0.0, 0.0, 1.0, 0.5), "bottom": (0.0, 0.5, 1.0, 0.5)}
SLOT_FORMS = "@top, @bottom or @x,y,w,h"


def _fractions(text):
    """(x, y, w, h) from "x,y,w,h", each 0-1, w and h over 0 and the box inside the frame; else None."""
    try:
        v = tuple(float(t) for t in str(text).split(","))
    except ValueError:
        return None
    if len(v) != 4 or any(not 0 <= t <= 1 for t in v) or v[2] <= 0 or v[3] <= 0 or v[0] + v[2] > 1 + 1e-9 or v[1] + v[3] > 1 + 1e-9:
        return None
    return v


def parse_spec(own, default):
    """§597: an item's own spec, `mode`, `mode@slot` or `region@x,y,w,h[@slot]` -> (mode, slot, region), each slot and
    region (x, y, w, h); None when it is none of the forms. A slot is the canvas's (top, bottom, or fractions), a region
    the source's. card takes no slot (it insets the whole frame)."""
    parts = (own or default).split("@")
    mode, rest = parts[0], parts[1:]
    if mode == "region":
        if not rest or _fractions(rest[0]) is None or len(rest) > 2:
            return None
        slot = (SLOTS.get(rest[1]) or _fractions(rest[1])) if len(rest) == 2 else None
        return None if len(rest) == 2 and slot is None else ("region", slot, _fractions(rest[0]))
    if mode not in ("auto", "track", "card") or len(rest) > 1 or (rest and mode == "card"):
        return None
    slot = (SLOTS.get(rest[0]) or _fractions(rest[0])) if rest else None
    if rest and slot is None:
        return None
    return ("track" if slot and mode == "auto" else mode), slot, None


def region_crop(region, sw, sh, aspect):
    """A still sourceCrop of `aspect` (width over height, in pixels) holding `region` (source fractions), centred on it
    and kept inside the frame."""
    rx, ry, rw, rh = region
    pw, ph = rw * sw, rh * sh
    cw, ch = (pw, pw / aspect) if pw / ph > aspect else (ph * aspect, ph)
    if cw > sw:
        cw, ch = sw, sw / aspect
    if ch > sh:
        cw, ch = sh * aspect, sh
    x0 = min(max((rx + rw / 2) * sw - cw / 2, 0.0), sw - cw)
    y0 = min(max((ry + rh / 2) * sh - ch / 2, 0.0), sh - ch)
    return {"x": round(x0 / sw, 4), "y": round(y0 / sh, 4), "w": round(cw / sw, 4), "h": round(ch / sh, 4)}


def slot_place(slot, aspect, W, H):
    """scale, offsetX, offsetY (percent of the frame from its centre) that put a picture of `aspect` exactly in `slot`."""
    x, y, w, h = slot
    scale = w if aspect >= W / H else h
    return round(scale, 4), round((x + w / 2 - 0.5) * 100, 3), round((y + h / 2 - 0.5) * 100, 3)


def analyse(project, on_disk, project_path, item_id, mode, matte=None, slot=None, region=None):
    """What framing `item_id` takes, computed from the project as read (nothing is written): a plan for write_plans,
    or {"id", "mode": "none", "why"} for a clip that needs nothing. Raises ItemRefused. §597: `slot` (x, y, w, h of the
    canvas) frames it for that slot of a split; `region` (of the source) holds the AI's own region still."""
    hit = place.find_item(project, item_id)
    if hit is None:
        if any(isinstance(src, dict) and src.get("id") == item_id for src in project.get("sources") or []):
            raise ItemRefused("item_not_found", f"{item_id} is a source id, not a timeline item: {ADD_FIRST}.")
        raise ItemRefused("item_not_found", f"No item {item_id} on the timeline: {ADD_FIRST}.")
    ti, _, item = hit
    if item.get("type") != "video" or ti == 0:
        raise ItemRefused("not_broll", f"{item_id} is not a video clip on an upper track (b-roll); the first track is the main footage.")
    sw, sh = lc._num(item.get("sourceWidth")), lc._num(item.get("sourceHeight"))
    original = _clip_file(item.get("src"), os.path.dirname(project_path))
    proxy = _clip_file(item.get("proxySrc"), os.path.dirname(project_path))
    src = proxy if proxy and os.path.isfile(proxy) else original
    if not src or not os.path.isfile(src):
        raise ItemRefused("file_not_found", f"The clip's file is missing: {item.get('src')}")
    probed = None
    if not (sw > 0 and sh > 0):
        # the original's size (a proxy is smaller, with the same shape): a keyed video crop needs it on the item
        dims = ffprobe_value(original if original and os.path.isfile(original) else src, "stream=width,height", "v:0")
        try:
            sw, sh = (float(v) for v in dims.split(",")[:2])
        except ValueError:
            raise ItemRefused("probe_failed", f"Could not read the clip's size: {dims!r}")
        probed = (int(sw), int(sh))
    W, H = lc.design_size(project)
    canvas = (slot[2] * W) / (slot[3] * H) if slot else W / H        # §597: a slot's own shape
    where = "the slot" if slot else "the canvas"
    if region is not None:
        return {"id": item_id, "mode": "region", "probed": probed, "slot": slot, "aspect": canvas, "W": W, "H": H,
                "start": lc._num(item.get("start")), "end": lc._num(item.get("end")),
                "crop": region_crop(region, sw, sh, canvas),
                "why": f"region: held still on the region named, at {where}'s shape" + ("; it fills the slot" if slot else "")}
    if sw / sh <= canvas * 1.05:
        return {"id": item_id, "mode": "none", "why": f"the clip is already as tall as {where}; nothing to frame"}
    crop_w = round((sh * canvas) / sw, 4)

    start, end = lc._num(item.get("start")), lc._num(item.get("end"))
    t_in = lc._num(item.get("inPoint"))
    t_out = lc._num(item.get("outPoint")) if item.get("outPoint") is not None else t_in + (end - start)
    rate = (t_out - t_in) / (end - start) if end > start else 1.0
    duration = get_duration(src)
    frames = gray_frames(src, t_in, t_out, TRACK_FPS)
    bg = gray_frames(src, max(0.0, t_in - BG_MARGIN_S), min(duration, t_out + BG_MARGIN_S), BG_FPS)
    path = subject_track.track(frames, bg, crop_w)
    text = subject_track.static_text(bg)
    n = max(1, len(path["points"]))
    times = [min(t_in + k / TRACK_FPS, t_out) for k in range(len(path["points"]))]

    why = None
    band = caption_band(project, start, end, W, H)
    captions_now = bool(lc.caption_bands(project, start, end, W, H))
    # a full-height crop keeps the source's heights, so the subject's box is where it lands on screen
    boxes_found = [p["box"] for p in path["points"] if p["box"] is not None]
    # text off the subject (Sam): the captions crossing the followed subject in most of the clip makes auto card it
    crossed = under_captions(boxes_found, band, 0.05)
    seen = f"the subject is in {path['found']}/{n} frames"
    if slot is not None:
        if path["found"] == 0:
            raise ItemRefused("no_subject", "No moving subject in the clip to follow in the slot; name a region instead "
                                            "(id=region@x,y,w,h@slot).")
        mode, why = "track", f"track: in the slot, following the subject ({seen}); it fills the slot"
    elif mode == "auto":
        if matte:
            mode, why = "card", f"card: the profile asks for mattes for wide footage ({matte['paper']})"
        elif path["cluttered"] > 0.3 * n:
            mode, why = "card", "card: the camera moves, so there is no one subject to follow"
        elif path["found"] < 0.6 * n:
            mode, why = "card", "card: no moving subject was found in most of the clip"
        elif path["capture"] < 0.5:
            mode, why = "card", "card: what moves is wider than the crop"
        elif path.get("span") and path["span"][1] - path["span"][0] > TRACK_ROOM * crop_w:
            # run 5 (Sam): a 9:16 slice of 16:9 action hides the action; the card shows its full width
            mode, why = "card", (f"card: the action spans {round((path['span'][1] - path['span'][0]) * 100)}% of the frame's "
                                 f"width, more than a 9:16 crop ({round(crop_w * 100)}%) shows with room to move")
        elif crossed > UNDER_CAPTIONS:
            mode = "card"
            why = ("card: a crop that follows the subject puts the captions across it; the card keeps it above them"
                   if captions_now else
                   f"card: {seen}, and the captions still to come would cross it in {round(crossed * 100)}% of the clip;"
                   " the card keeps it above them")
        else:
            mode = "track"
            why = f"track: {seen} and the captions stay clear of it"
    elif mode == "track" and path["found"] == 0:
        raise ItemRefused("no_subject", "No moving subject in the clip to follow; use mode card.")
    else:
        why = f"{mode}: as asked"

    item_t = lambda st: round((st - t_in) / rate, 3) if rate > 0 else 0.0  # noqa: E731
    found = [(item_t(st), p) for st, p in zip(times, path["points"]) if p["box"] is not None]
    # PL89d: the card zooms toward the subject: a still crop of the source, the source's own shape (so the card's box
    # on screen is the same), round everywhere the subject goes; the brackets' boxes move into the zoomed frame.
    zoom = None
    if mode == "card" and found and path["found"] >= 0.6 * n:
        u0 = min(p["box"][0] for _, p in found) - CARD_ZOOM_MARGIN
        v0 = min(p["box"][1] for _, p in found) - CARD_ZOOM_MARGIN
        u1 = max(p["box"][0] + p["box"][2] for _, p in found) + CARD_ZOOM_MARGIN
        v1 = max(p["box"][1] + p["box"][3] for _, p in found) + CARD_ZOOM_MARGIN
        z = max(u1 - u0, v1 - v0, CARD_ZOOM_MIN)
        if z < CARD_ZOOM_MAX:
            zx, zy = place_zoom((u0, v0, u1, v1), z, text)
            zoom = {"x": round(float(zx), 4), "y": round(float(zy), 4), "w": round(float(z), 4), "h": round(float(z), 4)}
            why += f"; zoomed to the subject ({round(z * 100)}% of the frame)"
            if any(any(r) for r in text) and text_inside(text, zx, zy, z) < text_inside(text, *_centred((u0, v0, u1, v1), z), z):
                why += ", the burned-in text left out"
    if mode == "card" and zoom is None and any(any(r) for r in text):
        # run 5: a card shows the whole frame, so burned-in text at its edge shows too; zoom in a little when that leaves
        # it out and keeps everywhere the subject goes
        bounds = _subject_bounds(found) if found else (0.5, 0.5, 0.5, 0.5)
        for z in TEXT_TRIM_ZOOMS:
            if bounds[2] - bounds[0] > z or bounds[3] - bounds[1] > z:
                continue
            zx, zy = place_zoom(bounds, z, text)
            if text_inside(text, zx, zy, z) == 0:
                zoom = {"x": round(float(zx), 4), "y": round(float(zy), 4), "w": round(float(z), 4), "h": round(float(z), 4)}
                why += f"; zoomed to {round(z * 100)}% of the frame to leave the burned-in text out"
                break
    if zoom is not None:
        zx, zy, z = zoom["x"], zoom["y"], zoom["w"]
        found = [(t, {**p, "box": [(p["box"][0] - zx) / z, (p["box"][1] - zy) / z, p["box"][2] / z, p["box"][3] / z]})
                 for t, p in found]
    width_ratio = sw / sh
    card_h = CARD_SCALE * (W / H) / width_ratio            # the footage's height on screen, a share of the canvas
    box = [round((1 - CARD_SCALE) / 2, 4), round(CARD_CENTER_Y - card_h / 2, 4), CARD_SCALE, round(card_h, 4)]
    return {"id": item_id, "mode": mode, "why": why, "probed": probed, "crop_w": crop_w, "box": box, "start": start,
            "slot": slot, "aspect": canvas,
            "end": end, "W": W, "H": H, "track_keys": [(item_t(st), round(p["x"], 4)) for st, p in zip(times, path["points"])] if mode == "track" else None,
            "found_boxes": found, "found": path["found"], "n": n, "crossed": crossed, "zoom": zoom,
            "default_credit": default_credit(source_of(project, item), os.path.dirname(project_path))}


def run(project_path, item_id, *, mode="auto", source=None, detail=False, sampler=None):
    """Frame one b-roll item (`item_id` a string: the answer as it always was) or several (a list: {"items": [one
    answer each, in the order given], "path"} from one write and one sheet)."""
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    sampler = sampler or default_sampler
    if mode not in ("auto", "track", "card"):
        fail("invalid_params", "mode is auto, track or card.")
    specs = {}
    single = isinstance(item_id, str)
    # PL89 run 5: an item may carry its own mode, `id=track` or `id=card` (`mode` is the rest's), so several modes
    # frame in one call: kung fu run 4 spent five calls, one a mode.
    modes = {}
    ids = []
    for raw in ([item_id] if single else [str(i) for i in (item_id or []) if str(i).strip()]):
        iid, _, own = str(raw).partition("=")
        spec = parse_spec(own, mode)
        if spec is None:
            fail("invalid_params", f"{raw}: an item takes auto, track or card; for a split's slot, track with "
                                   f"{SLOT_FORMS} (track@top); for a region of your own, region@x,y,w,h (source "
                                   f"fractions), then {SLOT_FORMS} for its slot if it has one.")
        if iid not in modes:
            ids.append(iid)
        modes[iid], specs[iid] = spec[0], spec
    if not ids:
        doc, _ = read_tracks(project_path)
        doc = normalize_tracks(doc)
        broll = [it.get("id") for t in doc["tracks"][1:] for it in t.get("items", []) if it.get("type") == "video"]
        on = f" (on the timeline now: {', '.join(map(str, broll[:12]))})" if broll else ""
        fail("missing_item", f"Pass item: the b-roll clip's item id on an upper track{on}. Not on the timeline yet: {ADD_FIRST}.")
    if len(ids) > MAX_ITEMS:
        fail("invalid_params", f"At most {MAX_ITEMS} items in one call.")
    on_disk, read_rev = read_tracks(project_path)
    project = normalize_tracks(copy.deepcopy(on_disk))

    matte = profile_matte(on_disk)

    def one(i):
        try:
            _, slot, region = specs.get(i, (None, None, None))
            return analyse(project, on_disk, project_path, i, modes.get(i, mode), matte, slot, region)
        except ItemRefused as e:
            return {"id": i, "error": e.code, "message": e.message}
    if len(ids) == 1:
        plans = [one(ids[0])]
    else:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL, len(ids))) as pool:
            plans = list(pool.map(one, ids))
    if single and "error" in plans[0]:
        fail(plans[0]["error"], plans[0]["message"])
    todo = [pl for pl in plans if pl.get("mode") in ("track", "card", "region")]
    if single and not todo:
        return {k: plans[0][k] for k in ("id", "mode", "why")}

    credit = f"Footage: {source.strip()}" if source and source.strip() else ""
    # PL89e: third-party footage keeps its source line (default_credit) even when given an empty source, unless the
    # profile's notes ask for no credits; the answer says which.
    no_credits = profile_wants_no_credits(on_disk)
    made, preset_src = False, None
    if any(pl["mode"] == "card" for pl in todo):
        def sync_check(rel):
            try:
                sync_clash.check_step_write(on_disk.get("id"), (), [rel])
            except (sync_clash.SyncConflict, sync_clash.SyncBusy) as e:
                sync_clash.exit_refused(e.body)
        referenced = {it.get("src") for t in project["tracks"] for it in t.get("items", []) if isinstance(it.get("src"), str)}
        rel, made = place.preset_file(project_dir, "footage_card", referenced, sync_check)
        preset_src = "./" + rel

    written, version = {}, None

    def apply(fresh):
        nonlocal version
        if project_revisions.revision_of(fresh.get("tracks")) != read_rev:
            fail("project_changed", "The tracks changed since frame_broll read them (an edit in the editor or another "
                                    "step). Run frame_broll again.")
        doc = normalize_tracks(fresh)
        for pl in todo:
            drop_own_cards(doc, pl)
            it = place.find_item(doc, pl["id"])[2]
            keyframes = [k for k in (it.get("keyframes") or []) if not str(k.get("prop", "")).startswith("crop")]
            for k in ("sourceCrop", "scale", "offsetX", "offsetY"):
                it.pop(k, None)
            if pl["probed"]:
                it["sourceWidth"], it["sourceHeight"] = pl["probed"]
            if pl["mode"] in ("track", "region"):
                if pl["mode"] == "track":
                    keys = simplify(pl["track_keys"])
                    it["sourceCrop"] = {"x": keys[0][1], "y": 0, "w": pl["crop_w"], "h": 1}
                    keyframes.append({"prop": "cropX", "points": [{"t": t, "value": v} for t, v in keys]})
                    written[pl["id"]] = {"keys": len(keys)}
                else:
                    it["sourceCrop"] = dict(pl["crop"])
                    written[pl["id"]] = {}
                if pl.get("slot"):     # §597: the picture fills the slot
                    it["scale"], it["offsetX"], it["offsetY"] = slot_place(pl["slot"], pl["aspect"], pl["W"], pl["H"])
            else:
                if pl["zoom"]:
                    it["sourceCrop"] = dict(pl["zoom"])
                it["scale"] = CARD_SCALE
                it["offsetX"] = 0
                it["offsetY"] = round((CARD_CENTER_Y - 0.5) * 100, 3)
                subject = [[t, *[round(v, 4) for v in p["box"]]] for t, p in pl["found_boxes"]]
                start, end = pl["start"], pl["end"]
                card = {"id": place._new_id(doc), "type": "overlay", "src": preset_src, "start": start, "end": end,
                        "props": {"box": ",".join(str(v) for v in pl["box"]), "credit": credit or ("" if no_credits else pl.get("default_credit", "")),
                                  "subject": json.dumps(simplify_boxes(subject)) if subject else "",
                                  "canvasW": str(pl["W"]), "canvasH": str(pl["H"]), "for": pl["id"],
                                  **({"paper": matte["paper"]} if matte else {}),
                                  **({"brackets": "off"} if matte and not matte["brackets"] else {})}}
                dest, refusal = place.choose_track(doc, start, end)
                if refusal:
                    fail("track_busy", f"No overlay track is free for the card of {pl['id']}: {refusal}.")
                tracks = doc["tracks"]
                if dest is None:
                    from lib import project_tracks
                    tracks.append({"id": project_tracks._new_track_id({t.get("id") for t in tracks}), "items": []})
                    dest = len(tracks) - 1
                tracks[dest]["items"] = sorted(tracks[dest]["items"] + [card], key=lambda x: lc._num(x.get("start")))
                written[pl["id"]] = {"card": card["id"]}
            if keyframes:
                it["keyframes"] = keyframes
            else:
                it.pop("keyframes", None)
        version = commit_version(project_dir, VERSION_MESSAGE)
        fresh["tracks"] = doc["tracks"]
        return fresh

    if todo:
        try:
            update_project_or_fail(project_path, apply, fail, timeout=STEP_LOCK_TIMEOUT)
        except BaseException:
            if made:
                try:
                    os.unlink(os.path.join(project_dir, preset_src[2:]))
                except OSError:
                    pass
            raise

    # One sheet: SHEET_TIMES over one clip, else two times in each framed clip, spread over all of them when that is
    # more than MAX_SHEET_TIMES (so the last clips are on the sheet too).
    if single:
        span = todo[0]["end"] - todo[0]["start"]
        sheet_times = [round(todo[0]["start"] + span * (k + 0.5) / SHEET_TIMES, 2) for k in range(SHEET_TIMES)]
    else:
        every = sorted({round(pl["start"] + (pl["end"] - pl["start"]) * f, 2) for pl in todo for f in (0.3, 0.7)})
        n = len(every)
        sheet_times = every if n <= MAX_SHEET_TIMES else [every[round(k * (n - 1) / (MAX_SHEET_TIMES - 1))]
                                                          for k in range(MAX_SHEET_TIMES)]
    samples = os.path.join(project_dir, "render", "samples")
    sheet, sheet_error = None, None
    if sheet_times:
        os.makedirs(samples, exist_ok=True)
        name = ids[0] if single else f"{ids[0]}-and-{len(ids) - 1}"
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(name))[:40]
        # the project is written by now: a sheet that cannot be made is said, never a failure of the step
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err):
                sheet = sampler(project_path, sheet_times, os.path.join(samples, f"frame_broll-{safe}.png"))
        except (SystemExit, Exception) as e:  # noqa: BLE001  (fail() exits; a renderer can raise anything)
            said = err.getvalue().strip().splitlines()
            sheet_error = (said[-1] if said else str(e) or type(e).__name__)[-300:]

    def answer(pl):
        if "error" in pl or pl["mode"] == "none":
            return {k: pl[k] for k in ("id", "error", "message", "mode", "why") if k in pl}
        out = {"id": pl["id"], "mode": pl["mode"], "why": pl["why"] + DONE}
        if pl["mode"] == "region":                       # §597: the crop, still, at the slot's or canvas's shape
            out["sourceCrop"] = pl["crop"]
        elif pl["mode"] == "track":
            out["keys"] = written[pl["id"]]["keys"]
            out["found"] = f"{pl['found']}/{pl['n']} frames"
            if pl["crossed"] > UNDER_CAPTIONS:
                out["issues"] = [f"the captions cross the subject in {round(pl['crossed'] * 100)}% of the clip: card keeps it clear of them"]
        else:
            out["card"] = written[pl["id"]]["card"]
            if pl["zoom"]:
                out["zoom"] = pl["zoom"]
            if not credit and pl.get("default_credit") and not no_credits:
                out["credit"] = (f"kept {pl['default_credit']}: third-party footage keeps its source line"
                                 if source is not None else f"{pl['default_credit']} (from the clip's source)")
            elif not credit and not pl.get("default_credit"):
                out["note"] = "no credit: pass source for a 'Footage: <source>' line"
        if detail and pl["mode"] != "region":
            out["crop_w"], out["box"] = pl["crop_w"], pl["box"]
        return out
    if single:
        out = answer(todo[0])
    else:
        out = {"items": [answer(pl) for pl in plans]}
    if todo and not version and not is_own_repo(project_dir):
        out["version"] = False
    if sheet:
        out["sheet"] = out["path"] = sheet
    elif sheet_times:
        out["sheet_error"] = sheet_error
    return out


def drop_own_cards(doc, plan):
    """Remove the cards an earlier run made for this item, so running again (another mode) changes it rather than
    stacking a second card: those that name it (props.for), or, from before props.for, cover exactly its range."""
    for t in doc["tracks"]:
        t["items"] = [it for it in t.get("items", []) if not (
            is_footage_card(it) and ((it.get("props") or {}).get("for") == plan["id"] or (
                "for" not in (it.get("props") or {}) and abs(lc._num(it.get("start")) - plan["start"]) < 0.01
                and abs(lc._num(it.get("end")) - plan["end"]) < 0.01)))]


def simplify_boxes(subject, tol=0.01):
    """The subject's keys [t, x, y, w, h] without those its neighbours already give (each value within tol)."""
    if len(subject) <= 2:
        return subject
    keep = [subject[0]]
    for i in range(1, len(subject) - 1):
        a, b, c = keep[-1], subject[i], subject[i + 1]
        f = (b[0] - a[0]) / (c[0] - a[0]) if c[0] > a[0] else 0
        if any(abs(a[j] + (c[j] - a[j]) * f - b[j]) > tol for j in range(1, 5)):
            keep.append(b)
    keep.append(subject[-1])
    return keep


def build_parser():
    parser = argparse.ArgumentParser(description="Frame a landscape clip on a vertical timeline: follow its subject, or inset it as a card")
    parser.add_argument("--project", required=True, help="The project id, its folder, or its project.json")
    parser.add_argument("--item", action="append", help="The b-roll clip's item id; repeat it for several")
    parser.add_argument("--mode", default="auto", choices=["auto", "track", "card"], help="auto (default), track or card")
    parser.add_argument("--source", default=None, help="Where the footage is from, for the card's credit line")
    parser.add_argument("--detail", action="store_true", help="Also answer the crop width and the card's box")
    return parser


def main():
    args = build_parser().parse_args()
    project_path = args.project
    if os.path.isdir(project_path):
        project_path = os.path.join(project_path, "project.json")
    if not os.path.isfile(project_path):
        fail("file_not_found", f"No project.json at {args.project}")
    items = None if not args.item else args.item[0] if len(args.item) == 1 else args.item
    print(json.dumps(run(project_path, items, mode=args.mode, source=args.source, detail=args.detail)))


if __name__ == "__main__":
    main()
