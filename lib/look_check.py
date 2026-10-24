"""look_check (§558, the look step): one read-only check of a project, in words, instead of a sample_frame / sample_overlay loop.

The pure half (the step, steps/render/look.py, runs the renderers):
- `pick_times`: the times worth looking at when none are given: cut seams on the base track, each overlay and
  image item's in and out (inset past its fades), caption changes, and even samples, taken round-robin from those
  four so no kind crowds out the others; merged within MERGE_S, at most MAX_TIMES.
- `data_issues`: what the project data alone says: an item that starts before 0 or ends after the footage, one
  that ends before it starts, an overlay whose file is missing, stretches with no footage (black, or overlay only),
  and an item that a full-frame one stacked above it hides. Tracks switched off (`enabled: false`) draw nothing
  and are left out, as the render leaves them out (lib/project_tracks.enabled_track_items).
- `measured_issues`: what an overlay's measurements (sample_overlay --measure, in the overlay's own 1080-design
  canvas) say once placed on the frame by the item's geometry (timeline-core toCssBoxPct): text off the frame, text
  that spills out of or is cut by its own box, text inside the 5% title-safe margin, text across montaj's own
  captions while a caption is on screen (CAPTION_BAND, measured), and, on a tall phone frame (h/w >= 1.7), text over
  the apps' bottom controls or right-side buttons.
- `text_overlaps`: two overlays on screen at once whose text boxes cross.

Times are timeline seconds. Keyframed geometry is read at its base values (said in the detail).
"""
import os

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
            if it.get("type") == "overlay":
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
    style = caps.get("style") or "pop"
    shape = "portrait" if frame_h > frame_w * 1.2 else "landscape" if frame_w > frame_h * 1.2 else "square"
    band = CAPTION_BAND[shape].get(style)
    if band is None:
        return []
    default = CAPTION_DEFAULT_SIZE.get(style, 60)
    out = []
    for seg in caption_segments(project):
        if seg.get("lang") and isinstance(seg.get("translationOf"), list):
            continue   # drawn under its source caption, inside its block
        s, e = _num(seg.get("start")), _num(seg.get("end"))
        if not (s < end and start < e):
            continue
        size = _num(seg.get("fontSize"), 0) or _num(caps.get("fontsize", caps.get("fontSize")), 0) or default
        scale = size / default * _num(seg.get("scale", 1), 1)
        top, bottom = band[0] * frame_h, band[1] * frame_h
        top = bottom - (bottom - top) * scale
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


def measured_issues(item, measurement, frame_w, frame_h, t, label, bands=()):
    """[{t, id, text}] from one overlay's measurements: at most one issue of each kind per item. `bands`:
    caption_bands for the item's span."""
    out, seen = [], set()
    tall = frame_h >= frame_w * TALL
    mx, my = frame_w * SAFE_MARGIN, frame_h * SAFE_MARGIN

    def add(kind, text):
        if kind not in seen:
            seen.add(kind)
            out.append({"t": r2(t), "id": label, "text": text})

    for text, b, clipped, spills in text_boxes(measurement, item, frame_w, frame_h):
        quote = f' "{text}"' if text else ""
        x0, y0, x1, y1 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
        if x0 < -OVERFLOW_PX or y0 < -OVERFLOW_PX or x1 > frame_w + OVERFLOW_PX or y1 > frame_h + OVERFLOW_PX:
            add("off", f"text{quote} runs off the frame")
            continue   # off the frame says it all
        if spills:
            add("spill", f"text{quote} spills out of its box")
        elif clipped:
            add("clip", f"text{quote} is cut off by its box")
        if x0 < mx or y0 < my or x1 > frame_w - mx or y1 > frame_h - my:
            add("margin", f"text{quote} inside the 5% title-safe margin")
        for top, bottom, s, e in bands:
            if y0 < bottom and top < y1:
                add("captions", f"text{quote} crosses the captions ({r2(s)}-{r2(e)}s)")
                break
        if tall and y1 > frame_h - BOTTOM_UI_PX:
            add("bottom", f"text{quote} over the apps' bottom controls")
        if tall and x1 > frame_w - RIGHT_UI_PX and y0 < frame_h * RIGHT_UI_Y[1] and y1 > frame_h * RIGHT_UI_Y[0]:
            add("right", f"text{quote} under the apps' right-side buttons")
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


def answer(issues, *, extra=None, cap=300):
    """The short JSON answer: ok and the extra counts, or the issues in time order while it stays within `cap`."""
    import json
    base = {"ok": not issues, **(extra or {})}
    if not issues:
        return base
    lines = [f'{i["t"]}s {i["id"]}: {i["text"]}' for i in sorted(issues, key=lambda x: (x["t"], x["id"]))]
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
