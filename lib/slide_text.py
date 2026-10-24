"""slides (§558): headlines, one-slide edits and a new order for a carousel's slides, in one call (the step is
steps/edit/slides.py).

`apply(slides, ...)` -> (new slides, report). Pure: the slides as read, never written here.

The headline is exactly what the editor's "+ Text" makes (montaj_assets/editor/src/carousel/AddElementMenu.tsx): an
`overlay` element whose template is the shipped static-text overlay by the path serve's /overlays/system gives the
editor (`template_path`), with that template's declared defaults as its props (static-text.json; every value a
string, as the editor's text panel writes them), an opaque uuid id, frame 0, a box in the project's resolution and
rotation 0. On top of the defaults a style preset sets the look and the carousel typography table sets the size
(skills/carousel, "Typography for carousels"; `fit` keeps it inside its box, never below the table's floor). One
extra prop, `montajRole: "headline"`, marks it so a later call replaces this headline and never a person's own text
(the contract allows extra props). It goes last in `elements`, so it draws on top.

headlines: one per slide in its current order (None skips one). edit: one slide (1-based number or id): headline,
color, size (px, bigger, smaller), align, position (top, middle, bottom), style. order: every slide once, by number
or id. Headlines and the edit name slides as they are before the call; the order applies last.
"""
import copy
import json
import os
import re
import uuid

from lib.css_color import is_css_color

ROLE_KEY = "montajRole"
ROLE = "headline"
STYLES = ("bold", "clean", "label")
POSITIONS = ("top", "middle", "bottom")
ALIGNS = ("left", "center", "right")
# The look of each preset, on the static-text contract's own props.
PRESETS = {
    "bold": {"color": "#ffffff", "fontWeight": "800", "effect": "shadow", "effectColor": "#000000",
             "effectStrength": "60", "bgColor": "transparent", "textAlign": "center"},
    "clean": {"color": "#111111", "fontWeight": "700", "effect": "none", "bgColor": "transparent", "textAlign": "center"},
    "label": {"color": "#111111", "fontWeight": "700", "effect": "none", "bgColor": "#ffffff", "textAlign": "left"},
}
# Hook headline sizes by length (skills/carousel's table, at a 1080-wide carousel): the start, and the floor fit
# never goes below. Longer copy than the last row needs splitting, not shrinking.
SIZE_BY_LENGTH = ((40, 72, 64), (80, 50, 44), (10_000, 38, 32))
# The box, as shares of the slide: x and width, then y and height for each position.
BOX_X, BOX_W = 0.08, 0.84
BOX_Y = {"top": (0.07, 0.30), "middle": (0.35, 0.30), "bottom": (0.63, 0.30)}
MAX_HEADLINE_CHARS = 280
MIN_PX, MAX_PX = 12, 400
STEPS = {"bigger": 1.25, "smaller": 0.8}


class SlideError(Exception):
    pass


def template_path(runtime_dir):
    """The static-text template exactly as serve's /overlays/system lists it (scan_overlays: overlays_dir / name /
    name.jsx, str of the Path), so the element is byte for byte the editor's."""
    from pathlib import Path
    return str(Path(runtime_dir) / "templates" / "overlays" / "static-text" / "static-text.jsx")


def template_defaults(runtime_dir):
    """The static-text template's declared prop defaults, as the editor's "+ Text" seeds them."""
    path = os.path.join(runtime_dir, "templates", "overlays", "static-text", "static-text.json")
    with open(path, encoding="utf-8") as f:
        schema = json.load(f)
    return {p["name"]: p["default"] for p in schema.get("props", []) if isinstance(p, dict) and "default" in p}


def _sizes(text):
    n = len(text)
    for limit, start, floor in SIZE_BY_LENGTH:
        if n <= limit:
            return start, floor
    return SIZE_BY_LENGTH[-1][1:]


def _box(position, width, height):
    y, h = BOX_Y[position]
    return {"x": round(width * BOX_X), "y": round(height * y), "w": round(width * BOX_W), "h": round(height * h)}


def _is_headline(el):
    return isinstance(el, dict) and el.get("type") == "overlay" and isinstance(el.get("overlay"), dict) \
        and isinstance(el["overlay"].get("props"), dict) and el["overlay"]["props"].get(ROLE_KEY) == ROLE


def _text(value, what):
    if not isinstance(value, str) or not value.strip():
        raise SlideError(f"{what} must be non-empty text.")
    if len(value) > MAX_HEADLINE_CHARS:
        raise SlideError(f"{what} is longer than {MAX_HEADLINE_CHARS} characters: split it over slides.")
    return value.strip()


def _parse(raw, what):
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            raise SlideError(f"{what} is JSON.")
    return raw


def _slide_index(slides, ref, what):
    """A slide named by 1-based number (or its numeric string) or by id: its index."""
    if isinstance(ref, bool):
        raise SlideError(f"{what}: a slide number or id.")
    if isinstance(ref, (int, float)) and float(ref).is_integer():
        k = int(ref)
        if 1 <= k <= len(slides):
            return k - 1
        raise SlideError(f"{what}: there is no slide {k} (the carousel has {len(slides)}).")
    if isinstance(ref, str):
        if re.fullmatch(r"\d+", ref.strip()):
            return _slide_index(slides, int(ref), what)
        for i, s in enumerate(slides):
            if s.get("id") == ref:
                return i
        raise SlideError(f"{what}: no slide {ref}.")
    raise SlideError(f"{what}: a slide number or id.")


def headline_element(text, *, style, position, width, height, runtime_dir, color=None, align=None, size=None):
    props = dict(template_defaults(runtime_dir))
    props.update(PRESETS[style])
    start, floor = _sizes(text)
    px = size or start
    props.update({"text": text, "fontSize": str(px), "fit": "true", "minFontSize": str(min(floor, px)), ROLE_KEY: ROLE})
    if color:
        props["color"] = color
    if align:
        props["textAlign"] = align
    return {"id": str(uuid.uuid4()), "type": "overlay", "overlay": {"template": template_path(runtime_dir), "props": props},
            "frame": 0, **_box(position, width, height), "rotation": 0}


def _set_headline(slide, text, *, style, width, height, runtime_dir):
    """Replace the slide's headline (its montajRole element), keeping its box and own edits, or add one on top."""
    els = slide.setdefault("elements", [])
    for i, el in enumerate(els):
        if _is_headline(el):
            el = copy.deepcopy(el)
            props = el["overlay"]["props"]
            start, floor = _sizes(text)
            props.update({"text": text, "fontSize": str(start), "minFontSize": str(floor)})
            if style:
                props.update(PRESETS[style])
            els[i] = el
            return "replaced"
    els.append(headline_element(text, style=style or "bold", position="top", width=width, height=height,
                                runtime_dir=runtime_dir))
    return "added"


def _edit(slide, edit, *, width, height, runtime_dir):
    els = slide.setdefault("elements", [])
    idx = next((i for i, el in enumerate(els) if _is_headline(el)), None)
    text = edit.get("headline")
    if idx is None:
        if text is None:
            raise SlideError("that slide has no headline yet: pass headline to add one.")
        _set_headline(slide, _text(text, "headline"), style=edit.get("style"), width=width, height=height, runtime_dir=runtime_dir)
        idx = next(i for i, el in enumerate(els) if _is_headline(el))
        text = None
    el = copy.deepcopy(els[idx])
    props = el["overlay"]["props"]
    if text is not None:
        t = _text(text, "headline")
        start, floor = _sizes(t)
        props.update({"text": t, "fontSize": str(start), "minFontSize": str(floor)})
    if edit.get("style") is not None:
        props.update(PRESETS[edit["style"]])
    if edit.get("color") is not None:
        props["color"] = edit["color"]
    if edit.get("align") is not None:
        props["textAlign"] = edit["align"]
    if edit.get("size") is not None:
        s = str(edit["size"]).strip().lower()
        cur = float(props.get("fontSize") or 72)
        px = cur * STEPS[s] if s in STEPS else (float(s.removesuffix("px")) if re.fullmatch(r"\d+(\.\d+)?(px)?", s) else None)
        if px is None or not MIN_PX <= px <= MAX_PX:
            raise SlideError(f"size is px ({MIN_PX} to {MAX_PX}), bigger or smaller.")
        props["fontSize"] = str(int(round(px)))
        props["minFontSize"] = str(min(int(props.get("minFontSize") or px), int(round(px))))
    if edit.get("position") is not None:
        el.update(_box(edit["position"], width, height))
    els[idx] = el


def parse_edit(raw):
    edit = _parse(raw, "edit")
    if edit is None:
        return None
    if not isinstance(edit, dict) or "slide" not in edit:
        raise SlideError('edit is {"slide": 3, "headline": "...", "color": "red", ...}.')
    unknown = set(edit) - {"slide", "headline", "color", "size", "align", "position", "style"}
    if unknown:
        raise SlideError(f"edit takes slide, headline, color, size, align, position, style; not {', '.join(sorted(unknown))}.")
    if edit.get("color") is not None and not is_css_color(edit["color"]):
        raise SlideError("edit color must be a CSS colour.")
    if edit.get("align") is not None and edit["align"] not in ALIGNS:
        raise SlideError("edit align is left, center or right.")
    if edit.get("position") is not None and edit["position"] not in POSITIONS:
        raise SlideError("edit position is top, middle or bottom.")
    if edit.get("style") is not None and edit["style"] not in STYLES:
        raise SlideError(f"edit style is one of {', '.join(STYLES)}.")
    if len(set(edit) - {"slide"}) == 0:
        raise SlideError("edit needs something to change.")
    return edit


def apply(slides, *, headlines=None, edit=None, order=None, style=None, width=1080, height=1350, runtime_dir):
    """(new slides, report): {changed: [slide ids], headlines: {added, replaced}, order: bool}."""
    if not isinstance(slides, list) or not slides:
        raise SlideError("The project has no slides. Make the carousel in Montaj first.")
    if style is not None and style not in STYLES:
        raise SlideError(f"style is one of {', '.join(STYLES)}.")
    heads = _parse(headlines, "headlines")
    edit = parse_edit(edit)
    new_order = _parse(order, "order")
    if heads is None and edit is None and new_order is None:
        raise SlideError("Nothing to do: pass headlines, edit or order.")
    out = copy.deepcopy(slides)
    changed, counts = [], {"added": 0, "replaced": 0}
    if heads is not None:
        if not isinstance(heads, list) or len(heads) > len(out):
            raise SlideError(f"headlines is a list of at most {len(out)} (one per slide; null skips one).")
        for i, h in enumerate(heads):
            if h is None:
                continue
            counts[_set_headline(out[i], _text(h, f"headline {i + 1}"), style=style, width=width, height=height,
                                 runtime_dir=runtime_dir)] += 1
            changed.append(out[i].get("id"))
    if edit is not None:
        i = _slide_index(out, edit["slide"], "edit")
        _edit(out[i], edit, width=width, height=height, runtime_dir=runtime_dir)
        if out[i].get("id") not in changed:
            changed.append(out[i].get("id"))
    moved = False
    if new_order is not None:
        if not isinstance(new_order, list) or len(new_order) != len(out):
            raise SlideError(f"order lists every slide once: {len(out)} of them.")
        idx = [_slide_index(slides, r, "order") for r in new_order]
        if sorted(idx) != list(range(len(out))):
            raise SlideError("order lists every slide exactly once.")
        moved = idx != list(range(len(out)))
        out = [out[k] for k in idx]
    report = {"changed": changed, "headlines": counts, "order": moved}
    return out, report
