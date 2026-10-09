"""Which canvas a project takes from its footage, and the overlay design canvas.

One rule for `project/init.py` (clips at create) and serve (footage added to a
project created without any), so the two cannot drift. design_canvas is the
overlays' own coordinate space, shared by the steps that report in it
(glass_plate, track_points)."""
import math
from collections import Counter

# settings.resolutionSource values. Absent on carousels and on projects made
# before the marker existed; those are never changed.
SOURCE_EXPLICIT = "explicit"
SOURCE_FOOTAGE = "footage"
SOURCE_DEFAULT = "default"
# settings.fpsSource takes the same three values.

# The overlay design canvas: 1080 on the short edge (render.js SHORT_EDGE_TARGET),
# portrait 1080x1920 when the project has no settings.resolution.
DESIGN_SHORT_EDGE = 1080
DESIGN_FALLBACK = (1080, 1920)


def _js_round(v):
    """Math.round: half up, as render.js rounds the design canvas."""
    return int(math.floor(v + 0.5))


def design_canvas(settings) -> list[int]:
    """[w, h] of the overlay design canvas, as render.js computes it: 1080 on the
    short edge with the aspect of settings.resolution, both rounded to even.
    The overlay's coordinates whatever the export resolution: [1920, 1080] for
    any 16:9 project."""
    res = settings.get("resolution") if isinstance(settings, dict) else None
    aw, ah = DESIGN_FALLBACK
    if isinstance(res, (list, tuple)) and len(res) >= 2:
        try:
            w, h = float(res[0]), float(res[1])
        except (TypeError, ValueError):
            w = h = 0.0
        if w > 0 and h > 0 and math.isfinite(w) and math.isfinite(h):
            aw, ah = w, h
    k = DESIGN_SHORT_EDGE / min(aw, ah)
    return [_js_round(aw * k / 2) * 2, _js_round(ah * k / 2) * 2]


def modal_dims(pairs) -> tuple[int, int] | None:
    """The most common (w, h) of `pairs`, in order; a tie goes to the pair that
    appears first. None when `pairs` is empty."""
    pairs = [(w, h) for w, h in pairs]
    if not pairs:
        return None
    counts = Counter(pairs)
    top = max(counts.values())
    return next(p for p in pairs if counts[p] == top)


def canvas_for_footage(canvas, footage) -> list[int]:
    """The canvas a project on `canvas` takes for footage of `footage` dims.

    Footage of the canvas's own aspect (w/h within 1%) gives the footage dims
    verbatim. Any other aspect keeps the canvas's aspect, scaled so its short
    side equals the footage's short side, the long side rounded to an even
    integer: 9:16 canvas + 3840x2160 footage is 2160x3840."""
    cw, ch = canvas
    fw, fh = footage
    if abs((fw / fh) / (cw / ch) - 1) <= 0.01:
        return [fw, fh]
    short = min(fw, fh)
    long_side = 2 * round(short * max(cw, ch) / min(cw, ch) / 2)
    return [short, long_side] if cw < ch else [long_side, short]


def fps_from_rate(rate) -> int | None:
    """Whole fps from an ffprobe `r_frame_rate` such as "30000/1001" (30), or
    None when it is not a positive fraction."""
    if not isinstance(rate, str) or "/" not in rate:
        return None
    try:
        num, den = rate.split("/")
        if int(den) > 0:
            return round(int(num) / int(den)) or None
    except ValueError:
        pass
    return None
