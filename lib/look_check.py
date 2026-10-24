"""look_check (§558, the look step): one read-only check of a project, in words, instead of a sample_frame / sample_overlay loop.

The pure half (the step, steps/render/look.py, runs the renderers):
- `pick_times`: the times worth looking at when none are given: cut seams on the base track, each overlay and
  image item's in and out (just inside them), caption changes, then even samples; merged within MERGE_S, at most
  MAX_TIMES, in that priority.
- `data_issues`: what the project data alone says: an item that starts before 0 or ends after the timeline, one
  that ends before it starts, an overlay whose file is missing, stretches where nothing visual plays (black), and an
  item a full-frame one above it hides.
- `measured_issues`: what an overlay's measurements (sample_overlay --measure, in the overlay's own 1080-design
  canvas) say once placed on the frame by the item's geometry (timeline-core toCssBoxPct): text off the frame,
  text its own box clips, and, in a portrait frame, text in the bottom BOTTOM_UI_PX (captions, the apps' controls)
  or the right RIGHT_UI_PX (the apps' buttons), from the overlay skill's placement rules.
- `text_overlaps`: two overlays on screen at once whose text boxes cross.

Times are timeline seconds. Keyframed geometry is read at its base values (said in the detail).
"""
import os

MAX_TIMES = 12
MAX_MEASURES = 12
MERGE_S = 0.25
EDGE_S = 0.1            # an in or out point is looked at this far inside the item
GAP_MIN_S = 0.2         # a stretch with nothing visual shorter than this is not reported
BOTTOM_UI_PX = 350      # portrait: captions and the apps' progress bars and controls
RIGHT_UI_PX = 200       # portrait: the apps' like, comment and share buttons
OVERFLOW_PX = 1.0       # a box past the frame by more than this is off it
EVEN_SAMPLES = 4
VISUAL = ("video", "image")


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f else default   # NaN reads as the default


def r2(x):
    return round(float(x), 2)


def design_size(project):
    """(width, height) of the 1080-on-the-short-edge design canvas, from settings.resolution."""
    res = (project.get("settings") or {}).get("resolution") or [1080, 1920]
    try:
        w, h = float(res[0]), float(res[1])
    except (TypeError, ValueError, IndexError):
        w, h = 1080.0, 1920.0
    if w <= 0 or h <= 0:
        w, h = 1080.0, 1920.0
    k = 1080.0 / min(w, h)
    return round(w * k), round(h * k)


def tracks_of(project):
    return [t for t in (project.get("tracks") or []) if isinstance(t, dict)]


def items_of(track):
    return [it for it in (track.get("items") or []) if isinstance(it, dict)]


def caption_segments(project):
    caps = project.get("captions") or {}
    segs = caps.get("segments") if isinstance(caps, dict) else None
    return [s for s in (segs or []) if isinstance(s, dict)]


def timeline_end(project):
    ends = [_num(it.get("end")) for t in tracks_of(project) for it in items_of(t)]
    ends += [_num(s.get("end")) for s in caption_segments(project)]
    return max(ends, default=0.0)


def base_end(project):
    tracks = tracks_of(project)
    return max((_num(it.get("end")) for it in items_of(tracks[0])), default=0.0) if tracks else 0.0


def _label(item, ti):
    return str(item.get("id") or f"track {ti} item")


def pick_times(project, at=None):
    """[seconds] to look at: `at` (clipped to the timeline, merged), else the automatic ones."""
    end = timeline_end(project)
    if end <= 0:
        return []
    if at:
        return _merge(sorted(min(max(0.0, _num(t)), end) for t in at), MAX_TIMES)
    tracks = tracks_of(project)
    seams, edges, caps = [], [], []
    if tracks:
        base = sorted(items_of(tracks[0]), key=lambda it: _num(it.get("start")))
        for it in base[1:]:
            s = _num(it.get("start"))
            if 0 < s < end:
                seams.append(min(end, s + EDGE_S))
    for ti, t in enumerate(tracks[1:], start=1):
        for it in items_of(t):
            s, e = _num(it.get("start")), _num(it.get("end"))
            if e <= s:
                continue
            inset = min(EDGE_S, (e - s) / 2)
            edges += [s + inset, e - inset]
    prev = None
    for seg in sorted(caption_segments(project), key=lambda x: _num(x.get("start"))):
        s, e = _num(seg.get("start")), _num(seg.get("end"))
        if e > s and (prev is None or abs(s - prev) > MERGE_S):
            caps.append(s + min(EDGE_S, (e - s) / 2))
        prev = e
    even = [end * (k + 0.5) / EVEN_SAMPLES for k in range(EVEN_SAMPLES)]
    chosen = []
    for group in (seams, edges, caps, even):
        for t in sorted(group):
            if len(chosen) >= MAX_TIMES:
                break
            if 0 <= t <= end and all(abs(t - c) > MERGE_S for c in chosen):
                chosen.append(t)
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
    tracks = tracks_of(project)
    for ti, t in enumerate(tracks):
        for it in items_of(t):
            s, e, lab = _num(it.get("start")), _num(it.get("end")), _label(it, ti)
            if e <= s:
                out.append({"t": r2(s), "id": lab, "text": "ends before it starts"})
                continue
            if s < 0:
                out.append({"t": r2(s), "id": lab, "text": "starts before 0"})
            if ti > 0 and e > base_end(project) + 0.05 and base_end(project) > 0:
                out.append({"t": r2(e), "id": lab, "text": f"runs past the footage ({r2(base_end(project))}s)"})
            if it.get("type") == "overlay":
                p = overlay_path(it, project_dir)
                if not p or not os.path.isfile(p):
                    out.append({"t": r2(s), "id": lab, "text": "overlay file missing"})
    for seg in caption_segments(project):
        s, e = _num(seg.get("start")), _num(seg.get("end"))
        if e <= s or s < 0 or (end > 0 and e > end + 0.05):
            out.append({"t": r2(s), "id": str(seg.get("id") or "caption"), "text": "caption outside the timeline"})
    out += _black(project, end)
    out += _hidden(tracks)
    return out


def _black(project, end):
    spans = []
    for t in tracks_of(project):
        for it in items_of(t):
            if it.get("type") in VISUAL or (it.get("type") == "overlay" and it.get("opaque") is True):
                s, e = max(0.0, _num(it.get("start"))), min(end, _num(it.get("end")))
                if e > s:
                    spans.append((s, e))
    if not any(it.get("type") in VISUAL for t in tracks_of(project) for it in items_of(t)):
        return []   # an animation-only project: no footage to miss
    spans.sort()
    out, cur = [], 0.0
    for s, e in spans + [(end, end)]:
        if s - cur >= GAP_MIN_S:
            out.append({"t": r2(cur), "id": "frame", "text": f"black {r2(cur)}-{r2(s)}s"})
        cur = max(cur, e)
    return out


def _hidden(tracks):
    """A full-frame item on a higher track hides what plays under it on a lower one (overlay tracks only)."""
    out = []
    layered = [(ti, it) for ti, t in enumerate(tracks) if ti > 0 for it in items_of(t)]
    for ti, low in layered:
        for tj, high in layered:
            if tj <= ti or not _full_frame(high):
                continue
            s = max(_num(low.get("start")), _num(high.get("start")))
            e = min(_num(low.get("end")), _num(high.get("end")))
            if e - s > MERGE_S:
                out.append({"t": r2(s), "id": _label(low, ti), "text": f"hidden by {_label(high, tj)} {r2(s)}-{r2(e)}s"})
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
    """[(text, box on the frame, clipped by its own box)] of the measured texts."""
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
        out.append((str(t.get("text") or "")[:24], b, clipped))
    return out


def measured_issues(item, measurement, frame_w, frame_h, t, label):
    """[{t, id, text}] from one overlay's measurements: at most one issue of each kind per item."""
    out, seen = [], set()
    portrait = frame_h > frame_w

    def add(kind, text):
        if kind not in seen:
            seen.add(kind)
            out.append({"t": r2(t), "id": label, "text": text})

    for text, b, clipped in text_boxes(measurement, item, frame_w, frame_h):
        quote = f' "{text}"' if text else ""
        if b["x"] < -OVERFLOW_PX or b["y"] < -OVERFLOW_PX or b["x"] + b["w"] > frame_w + OVERFLOW_PX or b["y"] + b["h"] > frame_h + OVERFLOW_PX:
            add("off", f"text{quote} runs off the frame")
            continue   # off the frame says it all: not also "in the app zones"
        if clipped:
            add("clip", f"text{quote} is cut off by its box")
        if portrait and b["y"] + b["h"] > frame_h - BOTTOM_UI_PX and b["y"] < frame_h:
            add("bottom", f"text{quote} in the bottom {BOTTOM_UI_PX}px (captions, app controls)")
        if portrait and b["x"] + b["w"] > frame_w - RIGHT_UI_PX and b["x"] < frame_w:
            add("right", f"text{quote} under the right-side app buttons")
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


def answer(issues, looked, measured, *, extra=None, cap=300):
    """The short JSON answer: ok and counts, or the issues in time order while it stays within `cap` characters."""
    import json
    base = {"ok": not issues, "looked": looked, "measured": measured, **(extra or {})}
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
