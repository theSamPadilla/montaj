"""look_check (§558, the look step): one read-only check of a project, in words, instead of a sample_frame / sample_overlay loop.

The pure half (the step, steps/render/look.py, runs the renderers):
- `pick_times`: the times worth looking at when none are given: cut seams on the base track, each overlay and
  image item's in and out (inset past its fades), caption changes, and even samples, taken round-robin from those
  four so no kind crowds out the others; merged within MERGE_S, at most MAX_TIMES.
- `data_issues`: what the project data alone says: an item that starts before 0 or ends after the footage, one
  that ends before it starts, an overlay whose file is missing, stretches with no footage (black, or overlay only),
  and an item that a full-frame one stacked above it hides. Tracks switched off (`enabled: false`) draw nothing
  and are left out, as the render leaves them out (lib/project_tracks.enabled_track_items).
- `caption_ink_issues`: captions whose ink (lib/caption_ink.py) was not checked for the card under them, or was set
  for a card that is gone; data only, a person's ink is never flagged.
- `measured_issues`: what an overlay's measurements (sample_overlay --measure, in the overlay's own 1080-design
  canvas) say once placed on the frame by the item's geometry (timeline-core toCssBoxPct): text off the frame, text
  that spills out of or is cut by its own box, text inside the 5% title-safe margin, text across montaj's own
  captions while a caption is on screen (CAPTION_BAND, measured), and, on a tall phone frame (h/w >= 1.7), text over
  the apps' bottom controls or right-side buttons.
- `text_overlaps`: two overlays on screen at once whose text boxes cross.

Times are timeline seconds. Keyframed geometry is read at its base values (said in the detail).
"""
import json
import os
import re

from lib.project_tracks import enabled_track_items

MAX_TIMES = 12
MAX_MEASURES = 12
MERGE_S = 0.25
EDGE_MAX_S = 0.5        # an in or out point is looked at min(this, a quarter of the item) inside it: past the fades
GAP_MIN_S = 0.2         # a stretch with nothing visual shorter than this is not reported
TALL = 1.7              # h/w at or above: a phone feed, where the apps draw their controls over the video
BOTTOM_UI_PX = 350      # tall frames: the apps' progress bars and controls
RIGHT_UI_PX = 200       # tall frames: the apps' like, comment and share buttons...
RIGHT_UI_Y = (0.45, 0.85)   # ...which stack down the right edge between these shares of the height
SAFE_MARGIN = 0.05      # title-safe: text this share of the frame from any edge, every aspect
OVERFLOW_PX = 1.0       # a box past the frame by more than this is off it
EVEN_SAMPLES = 4
VISUAL = ("video", "image")

# Where montaj's own captions draw: (top, bottom) as shares of the frame height, at the style's default size, with
# no offset. MEASURED 2026-10-24 on real sample_frame renders (a 7-word caption, "Keep the best part of every take",
# its first, middle and last word, over a flat frame) at 1080x1920, 1080x1080 and 1920x1080; the band is the
# extent over those three frames. A taller or shorter caption (its size) grows or shrinks the band from its bottom;
# a segment's offsetY moves it.
CAPTION_BAND = {
    "portrait": {"word-by-word": (0.725, 0.760), "pop": (0.726, 0.760), "karaoke": (0.724, 0.750),
                 "subtitle": (0.708, 0.749), "highlight-box": (0.656, 0.751), "outline": (0.673, 0.746),
                 "clean": (0.710, 0.740), "accent": (0.559, 0.644), "plate": (0.663, 0.749)},
    "square": {"word-by-word": (0.698, 0.759), "pop": (0.700, 0.759), "karaoke": (0.704, 0.750),
               "subtitle": (0.676, 0.748), "highlight-box": (0.583, 0.752), "outline": (0.611, 0.743),
               "clean": (0.687, 0.737), "accent": (0.531, 0.681), "plate": (0.594, 0.748)},
    "landscape": {"word-by-word": (0.698, 0.759), "pop": (0.700, 0.759), "karaoke": (0.704, 0.750),
                  "subtitle": (0.676, 0.748), "highlight-box": (0.670, 0.752), "outline": (0.687, 0.743),
                  "clean": (0.687, 0.737), "accent": (0.531, 0.681), "plate": (0.659, 0.748)},
}
# Each caption style's default font size (the templates' own defaults), which the band was measured at.
CAPTION_DEFAULT_SIZE = {"word-by-word": 72, "pop": 68, "karaoke": 52, "subtitle": 46, "highlight-box": 60,
                        "outline": 70, "clean": 54, "accent": 168, "plate": 56}
# The style the renderer draws for no style or an unknown one (render.js; caption_style.RENDER_DEFAULT_STYLE).
RENDER_DEFAULT_STYLE = "subtitle"
# A longer caption wraps to more rows, and each translation shown stacks a row under it, in the block that grows up
# from its bottom. Rows are ESTIMATED at the style's default size (a character about 0.55 of the font size wide, lines
# up to 90% of the frame; a bigger size already grows the band by itself), relative to the measured caption's own
# estimate; a translation row counts 0.8 of a caption row (a line size).
# accent draws its words in windows of a few, so its band never grows with the text.
BAND_SAMPLE = "Keep the best part of every take"
CHAR_W, LINE_W, TRANSLATION_ROW = 0.55, 0.90, 0.8
WINDOWED = ("accent",)


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f and f not in (float("inf"), float("-inf")) else default


def r2(x):
    return round(float(x), 2)


def design_size(project):
    """(width, height) of the 1080-on-the-short-edge design canvas, from settings.resolution."""
    res = (project.get("settings") or {}).get("resolution") or [1080, 1920]
    try:
        w, h = float(res[0]), float(res[1])
    except (TypeError, ValueError, IndexError):
        w, h = 1080.0, 1920.0
    if not (w > 0 and h > 0):
        w, h = 1080.0, 1920.0
    k = 1080.0 / min(w, h)
    return round(w * k), round(h * k)


def tracks_of(project):
    return [t for t in (project.get("tracks") or []) if isinstance(t, dict)]


def items_of(track):
    return [it for it in (track.get("items") or []) if isinstance(it, dict)]


def drawn_tracks(project):
    """[items] per track, in track order, a switched-off track's slot empty (it draws nothing)."""
    try:
        rows = enabled_track_items(project)
    except Exception:  # noqa: BLE001 — an odd shape reads as every track on
        rows = [items_of(t) for t in tracks_of(project)]
    return [[it for it in (row or []) if isinstance(it, dict)] for row in rows]


def layer_positions(rows):
    """timeline-core trackLayerPositions: every track holding a video item stacks below every other, each group in
    track order (a higher position draws on top)."""
    holds = [any(it.get("type") == "video" for it in row) for row in rows]
    pos, nxt = [0] * len(rows), 0
    for want in (True, False):
        for i, h in enumerate(holds):
            if h == want:
                pos[i] = nxt
                nxt += 1
    return pos


def caption_segments(project):
    caps = project.get("captions") or {}
    segs = caps.get("segments") if isinstance(caps, dict) else None
    return [s for s in (segs or []) if isinstance(s, dict)]


def timeline_end(project):
    ends = [_num(it.get("end")) for row in drawn_tracks(project) for it in row]
    ends += [_num(s.get("end")) for s in caption_segments(project)]
    return max(ends, default=0.0)


def base_end(project):
    rows = drawn_tracks(project)
    return max((_num(it.get("end")) for it in rows[0]), default=0.0) if rows else 0.0


def _label(item, ti):
    return str(item.get("id") or f"track {ti} item")


def _inset(s, e):
    return min(EDGE_MAX_S, (e - s) / 4)


def _spread(times):
    """`times` in an order that covers the span early: first, last, middle, then the halves' middles..."""
    ts = sorted(times)
    if len(ts) <= 2:
        return ts
    out, queue = [ts[0], ts[-1]], [(1, len(ts) - 2)]
    while queue:
        lo, hi = queue.pop(0)
        if lo > hi:
            continue
        mid = (lo + hi) // 2
        out.append(ts[mid])
        queue += [(lo, mid - 1), (mid + 1, hi)]
    return out


def pick_times(project, at=None, cap=MAX_TIMES):
    """[seconds] to look at: `at` (clipped to the timeline, merged), else the automatic ones, round-robin over the
    four kinds (seams, overlay edges, caption changes, even samples), each kind spread over its span."""
    end = timeline_end(project)
    if end <= 0:
        return []
    if at:
        return _merge(sorted(min(max(0.0, _num(t)), end) for t in at), cap)
    rows = drawn_tracks(project)
    seams, edges, caps = [], [], []
    if rows:
        base = sorted(rows[0], key=lambda it: _num(it.get("start")))
        for it in base[1:]:
            s = _num(it.get("start"))
            if 0 < s < end:
                seams.append(min(end, s + _inset(s, _num(it.get("end"), s + 0.4))))
    for row in rows[1:]:
        for it in row:
            s, e = _num(it.get("start")), _num(it.get("end"))
            if e > s:
                edges += [s + _inset(s, e), e - _inset(s, e)]
    prev = None
    for seg in sorted(caption_segments(project), key=lambda x: _num(x.get("start"))):
        s, e = _num(seg.get("start")), _num(seg.get("end"))
        if e > s and (prev is None or abs(s - prev) > MERGE_S):
            caps.append(s + _inset(s, e))
        prev = e
    even = [end * (k + 0.5) / EVEN_SAMPLES for k in range(EVEN_SAMPLES)]
    kinds = [_spread(g) for g in (seams, edges, caps, even)]
    chosen = []
    while len(chosen) < cap and any(kinds):
        for g in kinds:
            while g:
                t = g.pop(0)
                if 0 <= t <= end and all(abs(t - c) > MERGE_S for c in chosen):
                    chosen.append(t)
                    break
            if len(chosen) >= cap:
                break
    return [r2(t) for t in sorted(chosen)]


def _merge(times, cap):
    out = []
    for t in times:
        if not out or t - out[-1] > MERGE_S:
            out.append(r2(t))
    return out[:cap]


def overlay_path(item, project_dir):
    src = item.get("src")
    if not isinstance(src, str) or not src:
        return None
    return src if os.path.isabs(src) else os.path.normpath(os.path.join(project_dir, src))


def _full_frame(item):
    """An item drawn over the whole frame: an opaque overlay, or a clip at scale 1 with no offset."""
    sx = _num(item.get("scaleX", item.get("scale", 1)), 1)
    sy = _num(item.get("scaleY", item.get("scale", 1)), 1)
    if abs(_num(item.get("offsetX"))) > 0.5 or abs(_num(item.get("offsetY"))) > 0.5 or sx < 0.999 or sy < 0.999:
        return False
    if _num(item.get("opacity", 1), 1) < 0.999:
        return False
    if item.get("type") == "overlay":
        return item.get("opaque") is True
    return item.get("type") in VISUAL and item.get("fit", "cover") != "contain"


def data_issues(project, project_dir):
    """[{t, id, text}] from the project data alone."""
    out = []
    end = timeline_end(project)
    footage = base_end(project)
    rows = drawn_tracks(project)
    for ti, row in enumerate(rows):
        for it in row:
            s, e, lab = _num(it.get("start")), _num(it.get("end")), _label(it, ti)
            if e <= s:
                out.append({"t": r2(s), "id": lab, "text": "ends before it starts"})
                continue
            if s < 0:
                out.append({"t": r2(s), "id": lab, "text": "starts before 0"})
            if ti > 0 and footage > 0 and e > footage + 0.05:
                out.append({"t": r2(e), "id": lab, "text": f"runs past the footage ({r2(footage)}s)"})
            # An engine-drawn item (a 3D scene, src "engine:scene3d") has no file of its own.
            if it.get("type") == "overlay" and not str(it.get("src") or "").startswith("engine:"):
                p = overlay_path(it, project_dir)
                if not p or not os.path.isfile(p):
                    out.append({"t": r2(s), "id": lab, "text": "overlay file missing"})
    limit = footage if footage > 0 else end
    for seg in caption_segments(project):
        s, e = _num(seg.get("start")), _num(seg.get("end"))
        if e <= s or s < 0 or (limit > 0 and e > limit + 0.05):
            where = "past the footage" if footage > 0 and e > footage + 0.05 else "outside the timeline"
            out.append({"t": r2(s), "id": str(seg.get("id") or "caption"), "text": f"caption {where}"})
    out += _black(rows, end)
    out += _hidden(rows)
    return out


def caption_ink_issues(project, project_dir=None):
    """[{t, id, text}] for captions whose ink (lib/caption_ink.py) is out of date: over a card the step has not
    measured, or set for a card that is no longer on screen. Only ink the step wrote (inkAuto naming the same ink) is
    judged; a person's ink is never flagged. No render here: a card is found by the project data (an opaque overlay, a
    3D scene with a backdrop, read from `project_dir`), so a card that only measuring can find (a paper matte round a
    window) is not flagged before the step has run."""
    from lib import caption_ink
    out = []
    width, height = design_size(project)
    for seg in caption_segments(project):
        ours = caption_ink.ours(seg)
        if not caption_ink.inkable(project, seg) or (not ours and (seg.get("ink") or "inkAuto" in seg)):
            continue
        mid = (_num(seg.get("start")) + _num(seg.get("end"))) / 2
        box = caption_ink.band(project, seg, width, height)
        card = caption_ink.card_under(project, mid, box, project_dir) if box else None
        if card is not None and (not ours or seg["inkAuto"].get("card") != card["id"]):
            out.append({"t": r2(mid), "id": "captions",
                        "text": f"caption over {card['id']} has not had its ink checked: run caption_ink"})
        elif card is None and ours and seg["inkAuto"].get("card") not in caption_ink.on_screen(project, mid):
            out.append({"t": r2(mid), "id": "captions",
                        "text": f"caption ink was set for {seg['inkAuto'].get('card')}, now over footage: run caption_ink"})
    return out


def _spans(rows, end, keep):
    out = []
    for row in rows:
        for it in row:
            if keep(it):
                s, e = max(0.0, _num(it.get("start"))), min(end, _num(it.get("end")))
                if e > s:
                    out.append((s, e))
    return sorted(out)


def _gaps(spans, end):
    out, cur = [], 0.0
    for s, e in spans + [(end, end)]:
        if s - cur >= GAP_MIN_S:
            out.append((cur, s))
        cur = max(cur, e)
    return out


def _covered(spans, a, b):
    return any(s <= a + 1e-6 and e >= b - 1e-6 for s, e in spans)


def _black(rows, end):
    """Stretches with no footage: black, or drawn by overlays alone (not opaque, so the frame shows through)."""
    if not any(it.get("type") in VISUAL for row in rows for it in row):
        return []   # an animation-only project: no footage to miss
    pictures = _spans(rows, end, lambda it: it.get("type") in VISUAL or (it.get("type") == "overlay" and it.get("opaque") is True))
    overlays = _spans(rows, end, lambda it: it.get("type") == "overlay")
    out = []
    for a, b in _gaps(pictures, end):
        if any(s < b and a < e for s, e in overlays):
            out.append({"t": r2(a), "id": "frame", "text": f"no footage {r2(a)}-{r2(b)}s (overlay only)"})
        else:
            out.append({"t": r2(a), "id": "frame", "text": f"black {r2(a)}-{r2(b)}s"})
    return out


def _hidden(rows):
    """An item that a full-frame one stacked above it hides (the render's stacking: video tracks below the rest)."""
    pos = layer_positions(rows)
    out = []
    layered = [(ti, it) for ti, row in enumerate(rows) if ti > 0 for it in row]
    for ti, low in layered:
        for tj, high in layered:
            if tj == ti or pos[tj] <= pos[ti] or not _full_frame(high):
                continue
            s = max(_num(low.get("start")), _num(high.get("start")))
            e = min(_num(low.get("end")), _num(high.get("end")))
            if e - s > MERGE_S:
                out.append({"t": r2(s), "id": _label(low, ti), "text": f"hidden by {_label(high, tj)} {r2(s)}-{r2(e)}s"})
    return out


def caption_bands(project, start, end, frame_w, frame_h):
    """[(top px, bottom px, segment start, segment end)] where montaj's captions draw while [start, end) plays."""
    caps = project.get("captions") if isinstance(project.get("captions"), dict) else {}
    style = caps.get("style")
    if style not in CAPTION_DEFAULT_SIZE:
        style = RENDER_DEFAULT_STYLE
    shape = "portrait" if frame_h > frame_w * 1.2 else "landscape" if frame_w > frame_h * 1.2 else "square"
    band = CAPTION_BAND[shape][style]
    default = CAPTION_DEFAULT_SIZE[style]
    shown = caps.get("showLangs") if isinstance(caps.get("showLangs"), list) else None
    segs = caption_segments(project)
    under = {}
    for seg in segs:
        if seg.get("lang") and isinstance(seg.get("translationOf"), list) and (shown is None or seg["lang"] in shown):
            for sid in seg["translationOf"]:
                under[sid] = under.get(sid, 0) + 1

    def rows(text, size):
        return max(1, -(-len(text) * CHAR_W * size // (LINE_W * frame_w)))
    out = []
    for seg in segs:
        if seg.get("lang") and isinstance(seg.get("translationOf"), list):
            continue   # drawn under its source caption, inside its block
        s, e = _num(seg.get("start")), _num(seg.get("end"))
        if not (s < end and start < e):
            continue
        size = _num(seg.get("fontSize"), 0) or _num(caps.get("fontsize", caps.get("fontSize")), 0) or default
        scale = size / default * _num(seg.get("scale", 1), 1)
        grow = 1.0
        if style not in WINDOWED:
            text = str(seg.get("text") or " ".join(str(w.get("word", w.get("text", ""))) for w in seg.get("words") or []
                                                   if isinstance(w, dict)))
            sample = rows(BAND_SAMPLE, default)
            grow = (max(rows(text, default), sample) + TRANSLATION_ROW * under.get(seg.get("id"), 0)) / sample
        top, bottom = band[0] * frame_h, band[1] * frame_h
        top = bottom - (bottom - top) * scale * grow
        shift = _num(seg.get("offsetY")) / 100 * frame_h
        out.append((top + shift, bottom + shift, s, e))
    return out


def placed_box(bbox, item, frame_w, frame_h):
    """A box in the overlay's design canvas, on the frame (timeline-core toCssBoxPct)."""
    sx = _num(item.get("scaleX", item.get("scale", 1)), 1)
    sy = _num(item.get("scaleY", item.get("scale", 1)), 1)
    left = ((1 - sx) / 2) * frame_w + _num(item.get("offsetX")) / 100 * frame_w
    top = ((1 - sy) / 2) * frame_h + _num(item.get("offsetY")) / 100 * frame_h
    return {"x": left + _num(bbox.get("x")) * sx, "y": top + _num(bbox.get("y")) * sy,
            "w": _num(bbox.get("w")) * sx, "h": _num(bbox.get("h")) * sy}


def text_boxes(measurement, item, frame_w, frame_h):
    """[(text, box on the frame, cut by its box's clipping ancestor, spills out of its own box)]."""
    texts = (measurement or {}).get("texts") or []
    out = []
    for t in texts:
        if not isinstance(t, dict) or not isinstance(t.get("bbox"), dict):
            continue
        b = placed_box(t["bbox"], item, frame_w, frame_h)
        if b["w"] <= 0 or b["h"] <= 0:
            continue
        clipped = False
        anc = t.get("clippingAncestor")
        if isinstance(anc, dict) and isinstance(anc.get("bbox"), dict):
            a = anc["bbox"]
            bb = t["bbox"]
            clipped = (_num(bb.get("x")) < _num(a.get("x")) - OVERFLOW_PX or _num(bb.get("y")) < _num(a.get("y")) - OVERFLOW_PX
                       or _num(bb.get("x")) + _num(bb.get("w")) > _num(a.get("x")) + _num(a.get("w")) + OVERFLOW_PX
                       or _num(bb.get("y")) + _num(bb.get("h")) > _num(a.get("y")) + _num(a.get("h")) + OVERFLOW_PX)
        out.append((str(t.get("text") or "")[:24], b, clipped, t.get("spills") is True))
    return out


def move_to_fit(box, x_lo, x_hi, y_lo, y_hi, sx=1.0, sy=1.0):
    """PL89c: how far to move a text box (on the frame) so it lies inside [x_lo, x_hi] x [y_lo, y_hi] (None leaves
    that side open), in the overlay's own px (the item's scale `sx`, `sy` undone, rounded up): "move it right 34 px
    and up 12 px", or "make it at most 972 px wide" when it can't fit that way. The agent fixes in one rewrite, not
    by guessing."""
    import math
    x0, y0, x1, y1 = box["x"], box["y"], box["x"] + box["w"], box["y"] + box["h"]
    px = lambda d, s: math.ceil(round(d / (s or 1), 6))  # noqa: E731
    parts = []
    for lo, hi, a, b, s, near, far, size in ((x_lo, x_hi, x0, x1, sx, "right", "left", "wide"),
                                             (y_lo, y_hi, y0, y1, sy, "down", "up", "tall")):
        if lo is not None and hi is not None and b - a > hi - lo:
            parts.append(f"make it at most {math.floor(round((hi - lo) / (s or 1), 6))} px {size}")
        elif lo is not None and a < lo:
            parts.append(f"move it {near} {px(lo - a, s)} px")
        elif hi is not None and b > hi:
            parts.append(f"move it {far} {px(b - hi, s)} px")
    if len(parts) == 2 and all(p.startswith("move it ") for p in parts):
        parts[1] = parts[1][len("move it "):]
    return " and ".join(parts)


def measured_issues(item, measurement, frame_w, frame_h, t, label, bands=()):
    """[{t, id, text}] from one overlay's measurements: at most one issue of each kind per item. `bands`:
    caption_bands for the item's span. Each safe-area issue (off the frame, the title-safe margin, the apps' bottom
    controls or right-side buttons) ends with how far to move the text (move_to_fit)."""
    out, seen = [], set()
    tall = frame_h >= frame_w * TALL
    mx, my = frame_w * SAFE_MARGIN, frame_h * SAFE_MARGIN
    sx = _num(item.get("scaleX", item.get("scale", 1)), 1)
    sy = _num(item.get("scaleY", item.get("scale", 1)), 1)

    def fix(b, *bounds):
        how = move_to_fit(b, *bounds, sx=sx, sy=sy)
        return f": {how}" if how else ""

    def add(kind, text):
        if kind not in seen:
            seen.add(kind)
            out.append({"t": r2(t), "id": label, "text": text})

    # PL89e: a face that did not load in a stack with no generic family draws in the default serif
    for node in (measurement or {}).get("texts") or []:
        if isinstance(node, dict) and node.get("fellBack") is True:
            face = str(node.get("fontFamily") or "").split(",")[0].strip().strip("'\"")
            quote = f' "{str(node.get("text") or "")[:40]}"' if node.get("text") else ""
            add("font", f'text{quote} draws in serif: "{face}" did not load; name it in googleFonts, and end the stack in a '
                        f'generic family ("{face}, sans-serif")')
    for text, b, clipped, spills in text_boxes(measurement, item, frame_w, frame_h):
        quote = f' "{text}"' if text else ""
        x0, y0, x1, y1 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
        if x0 < -OVERFLOW_PX or y0 < -OVERFLOW_PX or x1 > frame_w + OVERFLOW_PX or y1 > frame_h + OVERFLOW_PX:
            add("off", f"text{quote} runs off the frame{fix(b, mx, frame_w - mx, my, frame_h - my)}")
            continue   # off the frame says it all
        if spills:
            add("spill", f"text{quote} spills out of its box")
        elif clipped:
            add("clip", f"text{quote} is cut off by its box")
        if x0 < mx or y0 < my or x1 > frame_w - mx or y1 > frame_h - my:
            add("margin", f"text{quote} inside the 5% title-safe margin{fix(b, mx, frame_w - mx, my, frame_h - my)}")
        for top, bottom, s, e in bands:
            if y0 < bottom and top < y1:
                add("captions", f"text{quote} crosses the captions ({r2(s)}-{r2(e)}s)")
                break
        if tall and y1 > frame_h - BOTTOM_UI_PX:
            add("bottom", f"text{quote} over the apps' bottom controls{fix(b, None, None, None, frame_h - BOTTOM_UI_PX)}")
        if tall and x1 > frame_w - RIGHT_UI_PX and y0 < frame_h * RIGHT_UI_Y[1] and y1 > frame_h * RIGHT_UI_Y[0]:
            add("right", f"text{quote} under the apps' right-side buttons{fix(b, None, frame_w - RIGHT_UI_PX, None, None)}")
    return out


def _cross(a, b):
    return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]


def text_overlaps(placed):
    """[{t, id, text}] for overlays on screen at once whose text boxes cross. `placed`: [(label, start, end, boxes)]."""
    out = []
    for i, (la, sa, ea, ba) in enumerate(placed):
        for lb, sb, eb, bb in placed[i + 1:]:
            s, e = max(sa, sb), min(ea, eb)
            if e - s <= MERGE_S:
                continue
            if any(_cross(x, y) for x in ba for y in bb):
                out.append({"t": r2(s), "id": la, "text": f"text overlaps {lb}"})
    return out


# PL89e (52's round-6 notes): "sensors" sat on the phone's edge. An overlay that imports a direct_scene mark file has its
# labels checked against the marked parts at the scene's moment under it.
MARK_IMPORT = re.compile(r"""from\s+['"]\./_marks/([a-z0-9-]{1,64})\.json['"]""")
COVER_SHARE = 0.3   # of the label's box over a part's box: on it


def _box_cover(b, part):
    x0, y0, x1, y1 = part
    w = max(0.0, min(b["x"] + b["w"], x1) - max(b["x"], x0))
    h = max(0.0, min(b["y"] + b["h"], y1) - max(b["y"], y0))
    return w * h / max(1.0, b["w"] * b["h"])


def mark_cover_issues(project, project_dir, item, measurement, frame_w, frame_h, t, label):
    """[{t, id, text}]: a label over a part the overlay's mark file marks, at the scene second under it (the engine:scene3d
    item of that scene playing at `t`, else the mark's own moment). At most one, the first found."""
    path = overlay_path(item, project_dir)
    if not path:
        return []
    names = list(dict.fromkeys(n for txt in overlay_texts(project_dir, path) for n in MARK_IMPORT.findall(txt)))
    scenes = [it for row in drawn_tracks(project) for it in row if it.get("src") == "engine:scene3d"]
    for name in names:
        try:
            with open(os.path.join(project_dir, "overlays", "_marks", f"{name}.json"), encoding="utf-8") as f:
                mark = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(mark, dict):
            continue
        rows = mark.get("track") if isinstance(mark.get("track"), list) and mark["track"] else [{"t": mark.get("at", 0), "parts": mark.get("parts") or []}]
        scene = re.sub(r"-\d+$", "", name)
        under = next((it for it in scenes if (it.get("props") or {}).get("scene") in (name, scene)
                      and _num(it.get("start")) <= t <= _num(it.get("end"))), None)
        st = t - _num(under.get("start")) + _num((under.get("props") or {}).get("inPoint")) if under else _num(mark.get("at"))
        row = next((r for r in reversed(rows) if isinstance(r, dict) and _num(r.get("t")) <= st + 1e-6), rows[0])
        size = mark.get("size") if isinstance(mark.get("size"), dict) else {}
        short = min(_num(size.get("width"), frame_w), _num(size.get("height"), frame_h)) or min(frame_w, frame_h)
        k = min(frame_w, frame_h) / short
        for text, b, _, _ in text_boxes(measurement, item, frame_w, frame_h):
            for p in row.get("parts") or []:
                box = p.get("box") if isinstance(p, dict) else None
                if isinstance(box, list) and len(box) == 4 and _box_cover(b, [v * k for v in box]) > COVER_SHARE:
                    quote = f' "{text}"' if text else ""
                    return [{"t": r2(t), "id": label, "text": f"label{quote} sits on the part {p.get('part')}: put it at "
                                                               "the part's leader.to, beside the model"}]
    return []


# PL89d (52's round-5 notes): six keyword chips at top 120 and a diagram strip at y 150, one after another, read as a
# page heading over every shot. An overlay whose text starts in the top TOP_SLOT_SHARE of the frame sits in the top
# slot; TOP_SLOT_MAX of them across the video is a choice, more is the website look.
TOP_SLOT_SHARE = 0.15
TOP_SLOT_MAX = 2


def top_slot_issues(placed, frame_w, frame_h):
    """[{t, id: "top-slot", text}] when more than TOP_SLOT_MAX overlays put their text in the top slot, at the start of the
    first one past it. `placed`: [(label, start, end, boxes)], as text_overlaps takes."""
    top = frame_h * TOP_SLOT_SHARE
    hits = sorted(((s, label) for label, s, e, boxes in placed if boxes and min(b["y"] for b in boxes) < top),
                  key=lambda x: x[0])
    if len(hits) <= TOP_SLOT_MAX:
        return []
    names = ", ".join(label for _, label in hits[:5]) + (f" and {len(hits) - 5} more" if len(hits) > 5 else "")
    return [{"t": r2(hits[TOP_SLOT_MAX][0]), "id": "top-slot",
             "text": f"{names} all put text in one top slot (above {round(top)} px), a page heading over every shot: "
                     "keywords go mid-frame (over the subject or just above the captions), a diagram beside what it explains"}]


def answer(issues, *, extra=None, cap=300, line=None):
    """The short JSON answer: ok and the extra counts, or the issues in time order while it stays within `cap`."""
    import json
    base = {"ok": not issues, **(extra or {})}
    if not issues:
        return base
    line = line or (lambda i: f'{i["t"]}s {i["id"]}: {i["text"]}')
    lines = [line(i) for i in sorted(issues, key=lambda x: (x["t"], x["id"]))]
    kept = []
    for k, line in enumerate(lines):
        trial = {**base, "issues": kept + [line]}
        rest = len(lines) - k - 1
        if rest:
            trial["more"] = rest
        if len(json.dumps(trial)) > cap and kept:
            break
        kept.append(line)
    out = {**base, "issues": kept}
    if len(lines) > len(kept):
        out["more"] = len(lines) - len(kept)
    return out


# ── PL89 (montaj-app-52): still holds ─────────────────────────────────────────────────────────────────────────────
# A stretch over STILL_HOLD_S with no beat (an item starting or ending) and nothing moving. PL89b held still 3D for
# 6 s twice; Claude alone cut or moved about every 3 s.

STILL_HOLD_S = 4.0
MOTION_PROPS = ("scale", "scaleX", "scaleY", "offsetX", "offsetY", "rotation", "cropX", "cropY", "cropW", "cropH")
HOLD_MOVES = ("stand", "idle", "rest", "hold")   # a cast move by one of these names keeps the body still


def _keys_move(item):
    for tr in item.get("keyframes") or []:
        pts = tr.get("points") or []
        if tr.get("prop") in MOTION_PROPS and len({json.dumps(p.get("value")) for p in pts}) > 1:
            return True
    return False


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _scene_motion(item, project_dir):
    """[(start, end)] in timeline seconds where a 3D item's camera or cast moves: the whole item when its camera keys
    differ or it is cut into shots; else each cast move that is not a hold, while it plays (its model's moves.json)."""
    s, e = _num(item.get("start")), _num(item.get("end"))
    props = item.get("props") or {}
    sid, inpoint = props.get("scene"), _num(props.get("inPoint"))
    models = os.path.join(project_dir, "models")
    scene = _read_json(os.path.join(models, "scenes", sid, "scene.json") if sid else os.path.join(models, "scene.json"))
    if not isinstance(scene, dict):
        return [(s, e)]    # unread: not reported as still
    cam = scene.get("camera") or {}
    if cam.get("shots") or any(len({json.dumps(k[1]) for k in (cam.get(p) or []) if isinstance(k, list) and len(k) > 1}) > 1
                               for p in ("location", "target")):
        return [(s, e)]
    spans = []
    for member in scene.get("cast") or []:
        moves = member.get("moves") or []
        lib = (_read_json(os.path.join(models, str(member.get("model")), "moves.json")) or {}).get("moves") or {}
        for m in moves:
            name = str(m.get("move", ""))
            if any(h in name.lower() for h in HOLD_MOVES):
                continue
            dur = _num((lib.get(name) or {}).get("duration"), 0)
            a = s + _num(m.get("start")) - inpoint
            b = a + dur if dur > 0 else e
            if b > s and a < e:
                spans.append((max(a, s), min(b, e)))
    return spans


def _moving_spans(project, project_dir):
    """[(start, end)] where something on screen moves (see still_holds)."""
    spans = []
    for ti, row in enumerate(drawn_tracks(project)):
        for it in row:
            s, e = _num(it.get("start")), _num(it.get("end"))
            kind = it.get("type")
            if _keys_move(it):
                spans.append((s, e))
            elif kind == "video" and ti > 0:
                spans.append((s, e))          # footage on an upper track: a cutaway with its own motion
            elif kind == "overlay" and it.get("src") == "engine:scene3d":
                spans += _scene_motion(it, project_dir)
            elif kind == "overlay":
                path = overlay_path(it, project_dir)
                # the runtime's Motion helpers keep it alive while held, in its own file or one it imports (3c)
                if isinstance(path, str) and uses_motion("\n".join(overlay_texts(project_dir, path))):
                    spans.append((s, e))
    return spans


def still_holds(project, project_dir):
    """[{t, id, text}] for each stretch over STILL_HOLD_S between beats with nothing moving."""
    rows = drawn_tracks(project)
    beats = sorted({_num(it.get(k)) for row in rows for it in row for k in ("start", "end")})
    if len(beats) < 2:
        return []
    moving = sorted(_moving_spans(project, project_dir))
    out = []
    for a, b in zip(beats, beats[1:]):
        t, still = a, []
        for ms, me in moving:
            if me <= t or ms >= b:
                continue
            if ms > t:
                still.append((t, ms))
            t = max(t, me)
        if t < b:
            still.append((t, b))
        for x, y in still:
            if y - x > STILL_HOLD_S + 1e-6:
                out.append({"t": r2(x), "id": "still", "text": f"still for {y - x:.1f} s ({r2(x)}-{r2(y)}s): "
                            "cut, push it (push_in) or add a beat"})
    return out


# ── PL89b: motion and type a phone can read (3c) ──────────────────────────────────────────────────────────────────

LABEL_FLOOR_PX = 36     # the smallest text that reads on a phone, on the 1080 design canvas
TITLE_FLOOR_PX = 72     # an overlay's biggest text, when it has a title above its labels
TITLE_RATIO = 1.5       # an overlay has a title when its biggest text is this much bigger than its smallest

_IMPORT = re.compile(r"""(?:import|from)\s*(?:[^'"`;]*?\sfrom\s*)?['"](\.{1,2}/[^'"]+)['"]""")
_COMMENTS = re.compile(r"/\*.*?\*/|//[^\n]*", re.S)
_EASED = re.compile(r"\b(?:spring|springStep|springSum)\s*\(|\bMath\.(?:pow|sin|cos|exp|sqrt)\b|\*\*|\bease\w*\s*\(|\bcubic|\bbezier", re.I)


def overlay_texts(project_dir, path, limit=12):
    """The overlay file and the project files it imports by a relative path (./ or ../), transitively, as texts: what
    its look and its fonts are written in. Never outside the project folder."""
    from lib import write_places
    root, seen, out, todo = write_places.real(project_dir), set(), [], [path]
    while todo and len(out) < limit:
        p = todo.pop(0)
        real = os.path.realpath(p)
        if real in seen or not os.path.isfile(real) or not write_places.within(real, root):
            continue
        seen.add(real)
        try:
            with open(real, encoding="utf-8", errors="replace") as f:
                text = f.read(400_000)
        except OSError:
            continue
        out.append(text)
        for rel in _IMPORT.findall(text):
            q = os.path.normpath(os.path.join(os.path.dirname(real), rel))
            todo += [q] if os.path.splitext(q)[1] else [q + ext for ext in (".js", ".jsx", ".mjs")]
    return out


def uses_motion(text):
    """Whether overlay code uses the runtime's Motion helpers (an eased enter, a hold that lives, an exit)."""
    return bool(re.search(r"\bMotion\.\w", _COMMENTS.sub("", text or "")))


def motion_issues(item, project_dir, label):
    """[{t, id, text}] from an overlay's code and the files it imports, read as text (no render): no frame-driven
    motion at all; motion that never reads `duration` (so it cannot leave before its end, and vanishes with the cut);
    motion with no easing (only linear interpolate). Code that uses Motion has all three."""
    src = item.get("src")
    if not isinstance(src, str) or not src.startswith("./") or not src.endswith((".jsx", ".js", ".tsx")):
        return []
    code = _COMMENTS.sub("", "\n".join(overlay_texts(project_dir, os.path.join(project_dir, src[2:]))))
    if not code or uses_motion(code):
        return []
    t = r2(_num(item.get("start")))
    say = lambda text: {"t": t, "id": label, "text": text}
    hint = "Motion.motion(frame, fps, duration) gives it an eased enter, a hold that lives and an exit"
    if not re.search(r"\bframe\b", code):
        return [say(f"no motion: it cuts on and off; {hint}")]
    out = []
    if not re.search(r"\bduration\b", code):
        out.append(say(f"never leaves: it vanishes with the cut; fade it out before its end ({hint})"))
    if not _EASED.search(code):
        out.append(say("its motion is linear: ease it (Motion.motion, Motion.progress or spring)"))
    return out


def _px(v):
    m = re.match(r"\s*([\d.]+)\s*px", str(v or ""))
    return float(m.group(1)) if m else None


def type_floor_issues(item, measurement, frame_w, frame_h, t, label):
    """[{t, id, text}] for text too small for a phone, on screen (its CSS size times the item's own scale), on the
    1080 design canvas: any text under LABEL_FLOOR_PX, and, when the overlay has a title (its biggest text
    TITLE_RATIO times its smallest), a title under TITLE_FLOOR_PX. One issue of each kind per item."""
    scale = min(_num(item.get("scaleX", item.get("scale", 1)), 1), _num(item.get("scaleY", item.get("scale", 1)), 1))
    sized = [(str(x.get("text") or "")[:24], _px(x.get("fontSize")) * scale) for x in (measurement or {}).get("texts") or []
             if isinstance(x, dict) and str(x.get("text") or "").strip() and _px(x.get("fontSize"))]
    if not sized:
        return []
    out = []
    small = min(sized, key=lambda s: s[1])
    if small[1] < LABEL_FLOOR_PX - 0.5:
        out.append({"t": r2(t), "id": label, "text": f'text "{small[0]}" is {round(small[1])} px: under the {LABEL_FLOOR_PX} px a phone reads (labels {LABEL_FLOOR_PX}+, titles {TITLE_FLOOR_PX}+, on the 1080 canvas)'})
    big = max(sized, key=lambda s: s[1])
    if big[1] >= small[1] * TITLE_RATIO and big[1] < TITLE_FLOOR_PX - 0.5:
        out.append({"t": r2(t), "id": label, "text": f'title "{big[0]}" is {round(big[1])} px: a title is at least {TITLE_FLOOR_PX} px'})
    return out
