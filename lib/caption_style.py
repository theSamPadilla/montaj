"""captions (§558): restyle a project's caption track in one call (the step is steps/transform/captions.py).

`restyle(captions, ..., frame=(w, h))` -> (new captions, report). Pure: the track as read, never written here.

- look: a caption style, or "highlight" (white text with the spoken word in colour: the `outline` style, its text
  white unless `color` says otherwise). With no look the style in force is kept; none, or one the renderer does not
  know, draws as `subtitle` (render/caption-spec.js), so that is what is styled.
- color: the text colour, on the key the style draws its text in (TEXT_KEY: `pop` shows only the spoken word, in
  activeColor). highlight: the spoken word's colour, on the key the style reads (SPOKEN_KEY); a style with no
  spoken-word highlight says so and names the ones that have one.
- accent: {words, color}: each word or phrase (said in order, case, punctuation and accents aside, across caption
  boundaries) gets its own colour (words[].color) wherever it is said; color "none" removes it. The answer counts each
  word's sayings, names the words not found with the transcript's near misses (the same stem: pause / pauses), and
  says so when the accent colour is the spoken word's. A phrase-only style says it needs a per-word look.
- position: top | middle | bottom, as each caption's offsetY from the style's own anchor (ANCHOR, measured), its
  translations' too (a translation drawn alone sits at the anchor). Written per caption: a caption added or made
  again later sits at the bottom.
- size: px, small | medium | large (of the style's default), N% or Nx, or bigger | smaller (of the size in force:
  the commonest caption size, else the track's, else the default), as the track's fontsize.
Like the editor's "Apply to all", a field set for the track clears the same field on every caption (`cleared`
counts those whose own value changed); bigger and smaller scale each caption's own size instead.
Self-check: the longest word at the size in force against 88% of the frame width.
"""
import copy
import json
import re
from collections import Counter

from lib.css_color import is_css_color
from lib.speech_lines import norm

STYLES = ("word-by-word", "pop", "karaoke", "subtitle", "highlight-box", "outline", "clean", "accent", "plate")
LOOKS = STYLES + ("highlight",)
LOOK_STYLE = {"highlight": "outline"}
RENDER_DEFAULT_STYLE = "subtitle"   # what render/caption-spec.js draws for no style or an unknown one
PHRASE_ONLY = ("clean", "subtitle")
# The key each style draws its text in (the caption templates' own props): pop shows only the spoken word.
TEXT_KEY = {"pop": "activeColor"}
# The key each style reads for the spoken word's colour. accent has none (its accentColor colours accent words) and
# pop has none (it shows only the spoken word, in its text colour).
SPOKEN_KEY = {"outline": "accentColor", "highlight-box": "accentColor", "plate": "accentColor", "karaoke": "highlightColor"}
HIGHLIGHT_WHITE = "#ffffff"
# Each style's default font size (the templates' defaults), for small / medium / large.
DEFAULT_SIZE = {"word-by-word": 72, "pop": 68, "karaoke": 52, "subtitle": 46, "highlight-box": 60, "outline": 70,
                "clean": 54, "accent": 168, "plate": 56}
SIZES = {"small": 0.8, "medium": 1.0, "large": 1.3}
STEPS = {"bigger": 1.25, "smaller": 0.8}
# Where each style draws its block: its bottom edge this % of the frame up from the bottom (MEASURED on sample_frame
# renders, lib/look_check.py CAPTION_BAND). accent draws its block CENTRED at ACCENT_CENTRE % from the top
# (accent.jsx, translateY(-50%)).
ANCHOR = {"word-by-word": 24, "pop": 24, "karaoke": 25, "subtitle": 25, "highlight-box": 25, "outline": 25,
          "clean": 26, "plate": 25}
ACCENT_CENTRE = 59.5
# The block's bottom edge, % from the top of the frame, for each position: one line then centres at about 22%,
# 53% and the default 74% (measured on the renders: top 31.7-32.7% read as upper-middle at 34).
POSITION_BOTTOM = {"top": 25.0, "middle": 56.0, "bottom": None}
# accent: the block's centre, % from the top.
ACCENT_POSITION = {"top": 25.0, "middle": 50.0, "bottom": None}
MAX_SIZE = 400
MIN_SIZE = 12
FIT_SHARE = 0.88        # the longest word fits inside this share of the frame width
CHAR_EM = 0.6           # about this many em per character at a caption's heavy weight
STEM_ENDINGS = ("ing", "es", "ed", "s", "")


class StyleError(Exception):
    pass


def _is_translation(seg):
    return isinstance(seg, dict) and isinstance(seg.get("lang"), str) and isinstance(seg.get("translationOf"), list)


def _tok(text):
    """A word as compared: curly apostrophes made straight, normalized, accents left in (norm keeps letters)."""
    return norm(str(text).replace("’", "'").replace("‘", "'"))


def _offset_for(style, position):
    if position == "bottom":
        return 0
    if style == "accent":
        return round(ACCENT_POSITION[position] - ACCENT_CENTRE, 1)
    return round(POSITION_BOTTOM[position] - (100 - ANCHOR.get(style, 25)), 1)


def _in_force_size(captions, style):
    """The size most captions draw at: each source caption's own fontSize, else the track's, else the default."""
    track = captions.get("fontsize", captions.get("fontSize"))
    base = track if isinstance(track, (int, float)) and track > 0 else DEFAULT_SIZE.get(style, 60)
    sizes = [s["fontSize"] if isinstance(s.get("fontSize"), (int, float)) else base
             for s in captions.get("segments", []) if isinstance(s, dict) and not _is_translation(s)]
    return Counter(sizes).most_common(1)[0][0] if sizes else base


def _size(size, style, in_force):
    """(px or None, factor or None): a factor scales every size (bigger, smaller, N%, Nx); px sets the track's."""
    s = str(size).strip().lower()
    base = DEFAULT_SIZE.get(style, 60)
    if s in SIZES:
        return int(round(base * SIZES[s])), None
    if s in STEPS:
        return None, STEPS[s]
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(%|x)", s)
    if m:
        f = float(m.group(1)) / (100 if m.group(2) == "%" else 1)
        if not 0.1 <= f <= 5:
            raise StyleError("a relative size is 10% to 500% (0.1x to 5x).")
        return None, f
    num = s.removesuffix("px").strip()
    if not re.fullmatch(r"\d+(?:\.\d+)?", num):
        raise StyleError("size is px (e.g. 80), small, medium, large, N% or Nx, bigger or smaller.")
    px = float(num)
    if not MIN_SIZE <= px <= MAX_SIZE:
        raise StyleError(f"size must be {MIN_SIZE} to {MAX_SIZE} px.")
    return int(round(px)), None


def _color(value, what):
    if value is None:
        return None
    if not is_css_color(value):
        raise StyleError(f"{what} must be a CSS colour: a hex, a name, or rgb()/hsl().")
    return value.strip()


def _rgb(color):
    """A colour as (r, g, b) for comparing two spellings of one colour, or None."""
    try:
        from PIL import ImageColor
        return ImageColor.getrgb(color)[:3]
    except (ValueError, ImportError, AttributeError):
        return None


def parse_accent(raw):
    """{words: [str], color} from the step's JSON (or a dict), or None."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
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
    if color is None or str(color).strip().lower() == "none":
        return {"words": words, "color": None}
    return {"words": words, "color": _color(color, "accent color")}


def _stream(segments):
    """Every source caption's words in time order: [(segment, word index, token)]."""
    out = []
    srcs = [s for s in segments if isinstance(s, dict) and not _is_translation(s) and isinstance(s.get("words"), list)]
    for seg in sorted(srcs, key=lambda s: (s.get("start") or 0)):
        for i, w in enumerate(seg["words"]):
            word = w.get("word") if isinstance(w, dict) else None
            out.append((seg, i, _tok(word) if isinstance(word, str) else ""))
    return out


def _mark(stream, phrase, color):
    """Colour every saying of `phrase` (consecutive tokens over the whole stream, across captions): how many."""
    want = [t for t in (_tok(w) for w in phrase.split()) if t]
    toks = [t for _, _, t in stream]
    hits = 0
    for i in range(len(toks) - len(want) + 1):
        if want and toks[i:i + len(want)] == want:
            hits += 1
            for seg, wi, _ in stream[i:i + len(want)]:
                w = dict(seg["words"][wi])
                if color is None:
                    w.pop("color", None)
                else:
                    w["color"] = color
                seg["words"][wi] = w
    return hits


def _near(stream, phrase):
    """The transcript's words with the same stem as a one-word `phrase` that was not found (pause / pauses)."""
    t = _tok(phrase)
    if not t or " " in phrase.strip():
        return []
    stem = next((t[: -len(e)] for e in STEM_ENDINGS if e and t.endswith(e) and len(t) - len(e) >= 3), t)
    seen = []
    for _, _, tok in stream:
        if tok and tok != t and tok not in seen and any(tok == stem + e for e in STEM_ENDINGS):
            seen.append(tok)
    return seen[:3]


def restyle(captions, *, look=None, color=None, highlight=None, accent=None, position=None, size=None, frame=(1080, 1920)):
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
    report = {"issues": [], "cleared": {}}
    cur = out.get("style")
    style = LOOK_STYLE.get(look, look) if look else (cur if cur in STYLES else RENDER_DEFAULT_STYLE)
    if look:
        out["style"] = style
    report["style"] = style
    if look == "highlight" and color is None:
        color = HIGHLIGHT_WHITE

    def clear_segment(field, keep=None):
        n = 0
        for seg in segs:
            if isinstance(seg, dict) and field in seg:
                if seg[field] != keep:
                    n += 1
                del seg[field]
        if n:
            report["cleared"][field] = report["cleared"].get(field, 0) + n

    if color is not None:
        key = TEXT_KEY.get(style, "color")
        out[key] = color
        clear_segment("color", color)
        if key != "color":
            clear_segment(key, color)
        report["color"] = color
    if highlight is not None:
        key = SPOKEN_KEY.get(style)
        if key:
            out[key] = highlight
            clear_segment(key, highlight)
            report["highlight"] = highlight
        else:
            looks = ", ".join(["highlight"] + sorted(SPOKEN_KEY))
            report["issues"].append(f"{style} has no spoken-word highlight: use look {looks}")
    if accent is not None:
        stream = _stream(segs)
        found, missed = {}, {}
        for phrase in accent["words"]:
            n = _mark(stream, phrase, accent["color"])
            if n:
                found[phrase] = n
            else:
                missed[phrase] = _near(stream, phrase)
        report["accent"] = {"found": found, "missed": missed}
        if style in PHRASE_ONLY and accent["color"] is not None:
            report["issues"].append(f"accent needs a per-word look: {style} draws phrases")
        spoken = out.get(SPOKEN_KEY.get(style, ""), None)
        if accent["color"] is not None and spoken and _rgb(spoken) is not None and _rgb(spoken) == _rgb(accent["color"]):
            report["issues"].append("accent matches the spoken-word colour: the accent words look spoken")
    if position is not None:
        off = _offset_for(style, position)
        for seg in segs:
            if not isinstance(seg, dict) or (_is_translation(seg) and style == "accent"):
                continue
            if isinstance(seg.get("offsetY"), (int, float)) and seg["offsetY"] != off:
                report["cleared"]["offsetY"] = report["cleared"].get("offsetY", 0) + 1
            if off:
                seg["offsetY"] = off
            else:
                seg.pop("offsetY", None)
        report["position"] = position
    in_force = _in_force_size(out, style)
    if size is not None:
        px, factor = _size(size, style, in_force)
        if factor is not None:
            track = out.get("fontsize", out.get("fontSize"))
            base = track if isinstance(track, (int, float)) and track > 0 else DEFAULT_SIZE.get(style, 60)
            px = int(round(base * factor))
            for seg in segs:
                if isinstance(seg, dict) and isinstance(seg.get("fontSize"), (int, float)):
                    seg["fontSize"] = int(round(seg["fontSize"] * factor))
        else:
            clear_segment("fontSize", px)
        if not MIN_SIZE <= px <= MAX_SIZE:
            raise StyleError(f"size must stay {MIN_SIZE} to {MAX_SIZE} px.")
        out["fontsize"] = px
        out.pop("fontSize", None)
        in_force = _in_force_size(out, style)
        report["size"] = in_force
    # self-check: the longest word at the size in force, against the frame
    longest = max((len(str(w.get("word", ""))) for s in segs if isinstance(s, dict) and not _is_translation(s)
                   for w in (s.get("words") or []) if isinstance(w, dict)), default=0)
    if longest and longest * CHAR_EM * in_force > FIT_SHARE * frame[0]:
        report["issues"].append(f"the longest word may not fit the frame at {in_force}px")
    report["segments"] = sum(1 for s in segs if isinstance(s, dict) and not _is_translation(s))
    if not report["cleared"]:
        del report["cleared"]
    return out, report
