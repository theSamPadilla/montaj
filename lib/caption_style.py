"""captions (§558): restyle a project's caption track in one call (the step is steps/transform/captions.py).

`restyle(captions, ...)` -> (new captions, report). Pure: the track as read, never written here.

- look: a caption style, or "highlight" (white with the spoken word in colour: the `outline` style).
- color: the base text colour (the track's `color`). highlight: the spoken word's colour, on the key the style reads
  (SPOKEN_KEY); a style with none says so.
- accent: {words, color}: each word or phrase (said in order, case and punctuation aside) gets its own colour
  (words[].color), on every saying; color "none" removes it. A phrase-only style says it needs a per-word look.
- position: top | middle | bottom, as each segment's offsetY from the style's own anchor (ANCHOR).
- size: px, small | medium | large (of the style's default size), or bigger | smaller (of the current one), as the
  track's fontsize.
Like the editor's "Apply to all", a field set on the track is removed from every segment's own overrides (color,
fontSize), and position writes every segment's offsetY. Translated rows keep no words and stack under their source,
so they take no accent and no offset.
"""
import copy
import re

from lib.css_color import is_css_color
from lib.speech_lines import norm

STYLES = ("word-by-word", "pop", "karaoke", "subtitle", "highlight-box", "outline", "clean", "accent", "plate")
LOOKS = STYLES + ("highlight",)
LOOK_STYLE = {"highlight": "outline"}
PHRASE_ONLY = ("clean", "subtitle")
# The track key each style reads for the spoken word's colour (the caption templates' own props).
SPOKEN_KEY = {"outline": "accentColor", "highlight-box": "accentColor", "plate": "accentColor", "accent": "accentColor",
              "karaoke": "highlightColor", "pop": "activeColor"}
# Each style's default font size (the templates' defaults), for small / medium / large.
DEFAULT_SIZE = {"word-by-word": 72, "pop": 68, "karaoke": 52, "subtitle": 46, "highlight-box": 60, "outline": 70,
                "clean": 54, "accent": 168, "plate": 56}
SIZES = {"small": 0.8, "medium": 1.0, "large": 1.3}
STEPS = {"bigger": 1.25, "smaller": 0.8}
# Where each style draws its block: its bottom edge this % of the frame up from the bottom (accent: its top, from
# the top). position moves it so the block sits in the upper third, the middle or the default bottom place.
ANCHOR = {"word-by-word": 24, "pop": 24, "karaoke": 25, "subtitle": 25, "highlight-box": 25, "outline": 25,
          "clean": 26, "plate": 25}
ACCENT_TOP = 59.5
# The block's bottom edge, % from the top of the frame, for each position (accent: its top edge).
POSITION_BOTTOM = {"top": 34.0, "middle": 56.0, "bottom": None}
ACCENT_POSITION_TOP = {"top": 22.0, "middle": 44.0, "bottom": None}
MAX_SIZE = 400
MIN_SIZE = 12


class StyleError(Exception):
    pass


def _is_translation(seg):
    return isinstance(seg, dict) and bool(seg.get("lang")) and isinstance(seg.get("translationOf"), list)


def _offset_for(style, position):
    if position == "bottom":
        return 0
    if style == "accent":
        return round(ACCENT_POSITION_TOP[position] - ACCENT_TOP, 1)
    return round(POSITION_BOTTOM[position] - (100 - ANCHOR.get(style, 25)), 1)


def _size(size, style, current):
    if size is None:
        return None
    s = str(size).strip().lower()
    base = DEFAULT_SIZE.get(style, 60)
    if s in SIZES:
        px = base * SIZES[s]
    elif s in STEPS:
        px = (current if isinstance(current, (int, float)) and current > 0 else base) * STEPS[s]
    else:
        try:
            px = float(s.rstrip("px"))
        except ValueError:
            raise StyleError("size is px, small, medium, large, bigger or smaller.")
    if not MIN_SIZE <= px <= MAX_SIZE:
        raise StyleError(f"size must be {MIN_SIZE} to {MAX_SIZE} px.")
    return int(round(px))


def _color(value, what):
    if value is None:
        return None
    if not is_css_color(value):
        raise StyleError(f"{what} must be a hex or a named CSS colour.")
    return value.strip()


def parse_accent(raw):
    """{words: [str], color} from the step's JSON (or a dict), or None."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        import json
        try:
            raw = json.loads(raw)
        except ValueError:
            raise StyleError('accent is {"words": ["..."], "color": "cyan"}.')
    if not isinstance(raw, dict) or not isinstance(raw.get("words"), list) or not raw["words"]:
        raise StyleError('accent is {"words": ["..."], "color": "cyan"}.')
    words = [w for w in raw["words"] if isinstance(w, str) and w.strip()]
    if not words:
        raise StyleError("accent needs at least one word.")
    color = raw.get("color", "cyan")
    if color in (None, "none"):
        return {"words": words, "color": None}
    return {"words": words, "color": _color(color, "accent color")}


def _mark(segments, phrase, color):
    """Colour every saying of `phrase` (consecutive words, by norm) in the segments' words: how many."""
    want = [t for t in (norm(w) for w in phrase.split()) if t]
    if not want:
        return 0
    hits = 0
    for seg in segments:
        words = seg.get("words") if isinstance(seg, dict) else None
        if _is_translation(seg) or not isinstance(words, list):
            continue
        toks = [norm(w.get("word", "")) if isinstance(w, dict) else "" for w in words]
        for i in range(len(toks) - len(want) + 1):
            if toks[i:i + len(want)] == want:
                hits += 1
                for k in range(i, i + len(want)):
                    w = dict(words[k])
                    if color is None:
                        w.pop("color", None)
                    else:
                        w["color"] = color
                    words[k] = w
    return hits


def restyle(captions, *, look=None, color=None, highlight=None, accent=None, position=None, size=None):
    """(new captions, report) for the asked changes. Raises StyleError for a bad input or nothing to style."""
    if not isinstance(captions, dict) or not isinstance(captions.get("segments"), list) or not captions["segments"]:
        raise StyleError("The project has no captions. Run generate_captions first.")
    if look is not None and look not in LOOKS:
        raise StyleError(f"look is one of {', '.join(LOOKS)}.")
    if position is not None and position not in POSITION_BOTTOM:
        raise StyleError("position is top, middle or bottom.")
    color = _color(color, "color")
    highlight = _color(highlight, "highlight")
    accent = parse_accent(accent)
    if all(v is None for v in (look, color, highlight, accent, position, size)):
        raise StyleError("Nothing to change: pass look, color, highlight, accent, position or size.")

    out = copy.deepcopy(captions)
    segs = out["segments"]
    report = {"issues": []}
    style = LOOK_STYLE.get(look, look) if look else out.get("style") or "pop"
    if look:
        out["style"] = style
    report["style"] = style

    def clear_segment(field):
        n = 0
        for seg in segs:
            if isinstance(seg, dict) and field in seg:
                del seg[field]
                n += 1
        return n

    if color is not None:
        out["color"] = color
        clear_segment("color")
    if highlight is not None:
        key = SPOKEN_KEY.get(style)
        if key:
            out[key] = highlight
        else:
            report["issues"].append(f"{style} has no spoken-word highlight: use look highlight, karaoke or pop")
    if accent is not None:
        found, missed = [], []
        for phrase in accent["words"]:
            (found if _mark(segs, phrase, accent["color"]) else missed).append(phrase)
        report["accent"] = {"found": found, "missed": missed}
        if style in PHRASE_ONLY and accent["color"] is not None:
            report["issues"].append(f"accent needs a per-word look: {style} draws phrases")
    if position is not None:
        off = _offset_for(style, position)
        for seg in segs:
            if isinstance(seg, dict) and not _is_translation(seg):
                if off:
                    seg["offsetY"] = off
                else:
                    seg.pop("offsetY", None)
        report["position"] = position
    if size is not None:
        current = out.get("fontsize", out.get("fontSize"))
        px = _size(size, style, current)
        out["fontsize"] = px
        out.pop("fontSize", None)
        clear_segment("fontSize")
        report["size"] = px
    report["segments"] = sum(1 for s in segs if isinstance(s, dict) and not _is_translation(s))
    return out, report
