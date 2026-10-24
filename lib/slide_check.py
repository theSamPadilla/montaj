"""The checks a carousel's text elements share (§558): `slides` runs them on the headlines it changed, `look` on
every text element of the slides it is asked about. The measure is look's sample_overlay --measure at the element's
own box size; the rules are look_check.text_boxes' (clipped, spills)."""
from lib import look_check as lc, slide_text

OFF_PX = 1.0
MIN_CONTRAST = 3.0
CHAR_EM = 0.6           # about this many em per character at a headline's heavy weight


def hard_to_read(slide, el, project_dir):
    """The headline's text colour against what is under its box (its own card when it has one) is below 3:1."""
    props = el["overlay"]["props"]
    text = slide_text.color_rgb(props.get("color") or "#ffffff")
    if text is None:
        return False
    bg = slide_text.color_rgb(props.get("bgColor")) if props.get("bgColor") not in (None, "", "transparent") else None
    if bg is not None and (len(bg) < 4 or bg[3] > 200):
        under = slide_text.luminance(bg)
    else:
        seen = slide_text.under_box(slide, slide_text._box_of(el), project_dir)
        if seen is None:
            return False
        under = seen[0]
    return slide_text.contrast(slide_text.luminance(text), under) < MIN_CONTRAST


def word_too_long(el):
    """A headline's longest word cannot fit its box even at its smallest size."""
    props = el["overlay"]["props"]
    longest = max((len(w) for w in str(props.get("text") or "").split()), default=0)
    floor = slide_text._px(props.get("minFontSize"), slide_text._px(props.get("fontSize"), 32))
    return longest * CHAR_EM * floor > float(el.get("w") or 0)


def box_ints(el):
    """(frame, w, h) as whole numbers, or None when the element's numbers are missing, NaN, infinite or not numbers."""
    try:
        return int(el.get("frame") or 0), int(el["w"]), int(el["h"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def sample_name(n, el, k):
    """The file name of slide n's element k in a samples folder: its id (cut to 8, path characters replaced), else k."""
    ident = el.get("id") if isinstance(el, dict) else None
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(ident or k))[:8]
    return f"slide-{n}-{safe}.png"


def measure_element(measure_fn, el, out):
    """(measurements of the element at its own box size, why not)."""
    frame, w, h = box_ints(el) or (0, 1, 1)
    item = {"id": str(el.get("id") or "text"), "props": el["overlay"]["props"]}
    return measure_fn(item, el["overlay"]["template"], frame, 1, 30, w, h, out)


def text_in_box(m, w, h):
    """[(text, box in the element's own pixels, outside: past the box or spilling, clipped)] per text measured."""
    out = []
    for text, b, clipped, spills in lc.text_boxes(m, {}, w, h):
        outside = (b["x"] < -OFF_PX or b["y"] < -OFF_PX or b["x"] + b["w"] > w + OFF_PX or b["y"] + b["h"] > h + OFF_PX
                   or spills)
        out.append((text, b, outside, clipped))
    return out


def slide_size(project):
    """(width, height) a carousel's slides are laid out in."""
    res = (project.get("settings") or {}).get("resolution") or [1080, 1350]
    try:
        return int(res[0]), int(res[1])
    except (TypeError, ValueError, IndexError, OverflowError):
        return 1080, 1350
