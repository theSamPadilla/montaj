"""slides (§558): headlines, one-slide edits and a new order for a carousel's slides, in one call (the step is
steps/edit/slides.py).

`apply(slides, ...)` -> (new slides, report). Pure: the slides as read, never written here.

The headline is exactly what the editor's "+ Text" makes (montaj_assets/editor/src/carousel/AddElementMenu.tsx): an
`overlay` element whose template is the shipped static-text overlay by the path serve's /overlays/system gives the
editor (`template_path`), with that template's declared defaults as its props (static-text.json; every value a
string, as the editor's text panel writes them), an opaque uuid id, frame 0, a box in the project's resolution and
rotation 0. On top of the defaults a style preset sets the look and the carousel typography table sets the size
(skills/carousel, "Typography for carousels"; `fit` keeps it inside its box, never below the table's floor). Two
extra props (the contract allows them): `montajRole: "headline"` marks it, so a later call replaces this headline and
never a person's own text, and `montajText` is the text the step wrote, so a headline the person retyped since is
kept by `headlines` (only an `edit` naming that slide replaces it). It goes last in `elements`, so it draws on top.

The style: bold (white, heavy, a strong shadow) for a dark image under the box, clean (dark text) for a light one,
label (dark text on a white card) for a busy or mid-grey one; "auto" (the default) picks one of those per slide from
the luminance of the topmost image under the headline's box, through its crop (`tone`).

A carousel the app makes has no slides yet, only its images in `assets`: then one slide is made per image asset, in
asset order, each a full-bleed image element the way the editor fills a box (its coverCrop), before the headlines.

headlines: one per slide in its current order (None skips one). edit: one slide (1-based number or id): headline,
color, size (px, bigger, smaller), align, position (top, middle, bottom), style. order: every slide once, by number
or id. Headlines and the edit name slides as they are before the call; the order applies last.
"""
import copy
import json
import os
import re
import statistics
import uuid

from lib.css_color import is_css_color

ROLE_KEY = "montajRole"
ROLE = "headline"
TEXT_KEY = "montajText"
STYLES = ("auto", "bold", "clean", "label")
POSITIONS = ("top", "middle", "bottom")
ALIGNS = ("left", "center", "right")
# The look of each preset, on the static-text contract's own props.
PRESETS = {
    "bold": {"color": "#ffffff", "fontWeight": "800", "effect": "shadow", "effectColor": "#000000",
             "effectStrength": "90", "bgColor": "transparent", "textAlign": "center"},
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
# auto's choice by the image under the box: relative luminance (0 black, 1 white) and the spread of its grey levels
LIGHT_Y, DARK_Y, BUSY_SPREAD = 0.45, 0.15, 55
AUTO = {"light": "clean", "dark": "bold", "busy": "label", "mid": "label", None: "bold"}
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif", ".avif", ".bmp", ".tif", ".tiff")
SAME_ASPECT = 0.005   # the editor's coverCrop: aspects this close need no crop


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


def _headlines(slide):
    return [i for i, el in enumerate(slide.get("elements") or []) if _is_headline(el)]


def _px(value, fallback):
    """A size prop as whole px: "64", "64px" (the editor's size picker) or "30.5"; `fallback` when it is none."""
    m = re.match(r"\s*(\d+(?:\.\d+)?)", str(value)) if value is not None else None
    return int(round(float(m.group(1)))) if m else int(fallback)


def _src_path(src, project_dir):
    if not isinstance(src, str) or not src or "://" in src or project_dir is None:
        return None
    return src if os.path.isabs(src) else os.path.join(project_dir, src)


def _open_image(path):
    """A PIL image in RGB, turned as it displays, or None."""
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as im:
            return ImageOps.exif_transpose(im).convert("RGB")
    except Exception:
        return None


def _linear(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = (_linear(float(v)) for v in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(y1, y2):
    """WCAG contrast ratio of two relative luminances."""
    a, b = max(y1, y2), min(y1, y2)
    return (a + 0.05) / (b + 0.05)


def color_rgb(value):
    try:
        from PIL import ImageColor
        return ImageColor.getrgb(str(value))
    except Exception:
        return None


def under_box(slide, box, project_dir):
    """(mean relative luminance, spread of grey levels) of what is under `box` on the slide: the topmost image element
    overlapping it, through its crop, else the slide's base colour. None when the image does not open."""
    for el in reversed(slide.get("elements") or []):
        if not isinstance(el, dict) or el.get("type") != "image":
            continue
        try:
            ex, ey, ew, eh = (float(el[k]) for k in ("x", "y", "w", "h"))
        except (KeyError, TypeError, ValueError):
            continue
        x0, y0 = max(box["x"], ex), max(box["y"], ey)
        x1, y1 = min(box["x"] + box["w"], ex + ew), min(box["y"] + box["h"], ey + eh)
        if ew <= 0 or eh <= 0 or x1 <= x0 or y1 <= y0:
            continue
        path = _src_path(el.get("src"), project_dir)
        im = _open_image(path) if path else None
        if im is None:
            return None
        crop = el.get("crop") if isinstance(el.get("crop"), dict) else {"x": 0, "y": 0, "w": 1, "h": 1}
        W, H = im.size
        try:
            fx = lambda v: (float(crop["x"]) + (v - ex) / ew * float(crop["w"])) * W
            fy = lambda v: (float(crop["y"]) + (v - ey) / eh * float(crop["h"])) * H
            region = im.crop((int(fx(x0)), int(fy(y0)), max(int(fx(x0)) + 1, int(round(fx(x1)))),
                              max(int(fy(y0)) + 1, int(round(fy(y1))))))
        except (KeyError, TypeError, ValueError):
            return None
        region.thumbnail((64, 64))
        raw = region.tobytes()
        px = [raw[k:k + 3] for k in range(0, len(raw), 3)]
        ys = [luminance(p) for p in px]
        greys = [0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] for p in px]
        return sum(ys) / len(ys), (statistics.pstdev(greys) if len(greys) > 1 else 0.0)
    rgb = color_rgb(slide.get("base_color") or "#ffffff")
    return (luminance(rgb), 0.0) if rgb else None


def tone(slide, box, project_dir):
    """light, dark, busy or mid for what is under `box`; None when it cannot be read."""
    seen = under_box(slide, box, project_dir)
    if seen is None:
        return None
    y, spread = seen
    if spread > BUSY_SPREAD:
        return "busy"
    return "light" if y > LIGHT_Y else "dark" if y < DARK_Y else "mid"


def _style_for(style, slide, box, project_dir):
    if style in (None, "auto"):
        return AUTO[tone(slide, box, project_dir)]
    return style


def cover_crop(box_w, box_h, img_w, img_h):
    """The editor's coverCrop (montaj_assets/editor/src/carousel/imageGeometry.ts): the centred part of the image with
    the box's aspect, in 0..1 fractions; None when the aspects match or a size is unusable."""
    if not all(isinstance(n, (int, float)) and n > 0 for n in (box_w, box_h, img_w, img_h)):
        return None
    box, img = box_w / box_h, img_w / img_h
    if abs(img - box) / box <= SAME_ASPECT:
        return None
    if img > box:
        w = box / img
        return {"x": (1 - w) / 2, "y": 0, "w": w, "h": 1}
    h = img / box
    return {"x": 0, "y": (1 - h) / 2, "w": 1, "h": h}


def _is_image_asset(a):
    if not isinstance(a, dict) or not isinstance(a.get("src"), str) or not a["src"]:
        return False
    if a.get("type"):
        return a["type"] == "image"
    return a["src"].lower().endswith(IMAGE_EXTS)


def slides_from_assets(assets, width, height, project_dir):
    """One full-bleed image slide per image asset, in asset order, as the editor fills a box."""
    out = []
    for a in assets or []:
        if not _is_image_asset(a):
            continue
        el = {"id": str(uuid.uuid4()), "type": "image", "src": a["src"], "x": 0, "y": 0, "w": width, "h": height,
              "rotation": 0}
        path = _src_path(a["src"], project_dir)
        im = _open_image(path) if path else None
        crop = cover_crop(width, height, *im.size) if im else None
        if crop:
            el["crop"] = crop
        out.append({"id": str(uuid.uuid4()), "base_color": "#000000", "elements": [el]})
    return out


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


NULLS = ("None", "null", "")


def parse_list(raw, what, numbers=False):
    """A list param as the CLI gets it (argparse action="append": serve repeats the flag per item, and a null item
    arrives as "None"), or as JSON text, or as a Python list: the list. One value that is a JSON list or object is that
    value; otherwise each value is one item, a null one None, and with `numbers` a digit string an int."""
    if raw is None or raw == "" or raw == []:
        return None
    if isinstance(raw, str):
        raw = [raw]
    if isinstance(raw, list) and len(raw) == 1 and isinstance(raw[0], str) and raw[0].lstrip()[:1] in ("[", "{"):
        return _parse(raw[0], what)
    if not isinstance(raw, list):
        return raw
    out = []
    for v in raw:
        if v is None or (isinstance(v, str) and v.strip() in NULLS):
            out.append(None)
        elif numbers and isinstance(v, str) and re.fullmatch(r"\s*\d+\s*", v):
            out.append(int(v))
        else:
            out.append(v)
    return out


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
    props.update({"text": text, "fontSize": str(px), "fit": "true", "minFontSize": str(min(floor, px)), ROLE_KEY: ROLE,
                  TEXT_KEY: text})
    if color:
        props["color"] = color
    if align:
        props["textAlign"] = align
    return {"id": str(uuid.uuid4()), "type": "overlay", "overlay": {"template": template_path(runtime_dir), "props": props},
            "frame": 0, **_box(position, width, height), "rotation": 0}


def _box_of(el):
    return {k: float(el.get(k) or 0) for k in ("x", "y", "w", "h")}


def _set_headline(slide, text, *, style, width, height, runtime_dir, project_dir=None):
    """Replace the slide's headline (its montajRole element), keeping its box and own edits, or add one on top.
    "added" or "replaced"; None when nothing changes (the same text and no style); "edited" when the person retyped
    it since the step wrote it, and "twice" when two elements carry the mark (a duplicate): both left as they are."""
    els = slide.setdefault("elements", [])
    marked = _headlines(slide)
    if len(marked) > 1:
        return "twice"
    if marked:
        i = marked[0]
        el = copy.deepcopy(els[i])
        props = el["overlay"]["props"]
        if TEXT_KEY in props and props.get("text") != props[TEXT_KEY]:
            return "edited"
        if props.get("text") == text and not style:
            return None
        if props.get("text") != text:
            start, floor = _sizes(text)
            props.update({"text": text, TEXT_KEY: text, "fontSize": str(start), "minFontSize": str(floor)})
        if style:
            props.update(PRESETS[_style_for(style, slide, _box_of(el), project_dir)])
        if el == els[i]:
            return None
        els[i] = el
        return "replaced"
    box = _box("top", width, height)
    els.append(headline_element(text, style=_style_for(style, slide, box, project_dir), position="top", width=width,
                                height=height, runtime_dir=runtime_dir))
    return "added"


def _edit(slide, edit, *, width, height, runtime_dir, project_dir=None, n=None):
    els = slide.setdefault("elements", [])
    marked = _headlines(slide)
    if len(marked) > 1:
        raise SlideError(f"slide {n} has {len(marked)} headlines marked as the step's (a duplicate): delete one first.")
    idx = marked[0] if marked else None
    text = edit.get("headline")
    if idx is None:
        if text is None:
            raise SlideError("that slide has no headline yet: pass headline to add one.")
        _set_headline(slide, _text(text, "headline"), style=edit.get("style"), width=width, height=height,
                      runtime_dir=runtime_dir, project_dir=project_dir)
        idx = _headlines(slide)[0]
        text = None
    el = copy.deepcopy(els[idx])
    props = el["overlay"]["props"]
    if text is not None:
        t = _text(text, "headline")
        if t != props.get("text"):
            start, floor = _sizes(t)
            props.update({"text": t, TEXT_KEY: t, "fontSize": str(start), "minFontSize": str(floor)})
    if edit.get("style") is not None:
        props.update(PRESETS[_style_for(edit["style"], slide, _box_of(el), project_dir)])
    if edit.get("color") is not None:
        props["color"] = edit["color"]
    if edit.get("align") is not None:
        props["textAlign"] = edit["align"]
    if edit.get("size") is not None:
        s = str(edit["size"]).strip().lower()
        start, floor = _sizes(str(props.get("text") or ""))
        cur = _px(props.get("fontSize"), start)
        px = cur * STEPS[s] if s in STEPS else (float(s.removesuffix("px")) if re.fullmatch(r"\d+(\.\d+)?(px)?", s) else None)
        if px is None or not MIN_PX <= px <= MAX_PX:
            raise SlideError(f"size is px ({MIN_PX} to {MAX_PX}), bigger or smaller.")
        props["fontSize"] = str(int(round(px)))
        props["minFontSize"] = str(min(_px(props.get("minFontSize"), floor), int(round(px))))
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


def apply(slides, *, headlines=None, edit=None, order=None, style=None, width=1080, height=1350, runtime_dir,
          assets=None, project_dir=None):
    """(new slides, report): {changed: [slide ids], headlines: {added, replaced}, order: bool, made: n, kept: [issue]}."""
    if style is not None and style not in STYLES:
        raise SlideError(f"style is one of {', '.join(STYLES)}.")
    heads = parse_list(headlines, "headlines")
    edit = parse_edit(edit)
    new_order = parse_list(order, "order", numbers=True)
    if heads is None and edit is None and new_order is None:
        raise SlideError("Nothing to do: pass headlines, edit or order.")
    made = 0
    if isinstance(slides, list) and not slides:
        slides = slides_from_assets(assets, width, height, project_dir)
        made = len(slides)
    if not isinstance(slides, list) or not slides:
        raise SlideError("The project has no slides and no images. Add images to the carousel in Montaj first.")
    out = copy.deepcopy(slides)
    changed, counts, kept = [s.get("id") for s in out] if made else [], {"added": 0, "replaced": 0}, []
    if heads is not None:
        if not isinstance(heads, list) or len(heads) > len(out):
            raise SlideError(f"headlines is a list of at most {len(out)} (one per slide; null skips one).")
        texts = [None if h is None else _text(h, f"headline {i + 1}") for i, h in enumerate(heads)]
        for i, t in enumerate(texts):
            if t is None:
                continue
            what = _set_headline(out[i], t, style=style, width=width, height=height, runtime_dir=runtime_dir,
                                 project_dir=project_dir)
            if what == "edited":
                kept.append(f"slide {i + 1}: kept your edited headline (use edit to change it)")
            elif what == "twice":
                kept.append(f"slide {i + 1}: two headlines are marked as the step's (a duplicate): kept both")
            elif what:
                counts[what] += 1
                if out[i].get("id") not in changed:
                    changed.append(out[i].get("id"))
    if edit is not None:
        i = _slide_index(out, edit["slide"], "edit")
        before = copy.deepcopy(out[i])
        _edit(out[i], edit, width=width, height=height, runtime_dir=runtime_dir, project_dir=project_dir, n=i + 1)
        if out[i] != before and out[i].get("id") not in changed:
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
    report = {"changed": changed, "headlines": counts, "order": moved, "made": made, "kept": kept}
    return out, report
