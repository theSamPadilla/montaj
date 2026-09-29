"""Seed a caption track's styling from a profile's saved theme.

`sanitize_theme` and `seed_prev` only ever fill fields the prior caption
track lacks. The regenerated track's own values still win over whatever
this module seeds, via `_merge_caption_theme` in serve/routes/projects.py.
"""

_COLOR_KEYS = (
    "color",
    "accentColor",
    "highlightColor",
    "activeColor",
    "backgroundColor",
    "bgColor",
)

_PLAIN_STRING_KEYS = ("textTransform", "letterSpacing", "textAlign")

_MAX_COLOR_LEN = 64
_MAX_FONT_FAMILY_LEN = 200
_MAX_GOOGLE_FONT_LEN = 200
_MAX_GOOGLE_FONTS = 8


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_nonempty_str(value, max_len: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= max_len


def sanitize_theme(raw) -> dict:
    """Return only the allowed, validly-typed styling fields from `raw`.

    Everything else is dropped, including `style` and `segments` (and any
    other track key, such as `position`, that isn't a styling field this
    function knows about). Non-dict input returns {}.
    """
    if not isinstance(raw, dict):
        return {}

    out: dict = {}

    for key in _COLOR_KEYS:
        if key in raw and _is_nonempty_str(raw[key], _MAX_COLOR_LEN):
            out[key] = raw[key]

    for key in _PLAIN_STRING_KEYS:
        if key in raw and _is_nonempty_str(raw[key], max_len=10_000):
            out[key] = raw[key]

    if "fontsize" in raw and _is_number(raw["fontsize"]):
        out["fontsize"] = raw["fontsize"]

    if "fontWeight" in raw:
        value = raw["fontWeight"]
        if _is_number(value) or _is_nonempty_str(value, max_len=10_000):
            out["fontWeight"] = value

    if "lineHeight" in raw:
        value = raw["lineHeight"]
        if _is_number(value) or _is_nonempty_str(value, max_len=10_000):
            out["lineHeight"] = value

    font_family = raw.get("fontFamily")
    has_valid_font_family = _is_nonempty_str(font_family, _MAX_FONT_FAMILY_LEN)

    google_fonts = raw.get("googleFonts")
    has_valid_google_fonts = (
        isinstance(google_fonts, list)
        and 1 <= len(google_fonts) <= _MAX_GOOGLE_FONTS
        and all(_is_nonempty_str(f, _MAX_GOOGLE_FONT_LEN) for f in google_fonts)
    )

    # fontFamily and googleFonts travel together: either both land, or
    # neither does.
    if has_valid_font_family and has_valid_google_fonts:
        out["fontFamily"] = font_family
        out["googleFonts"] = list(google_fonts)

    return out


def seed_prev(prev: dict, theme: dict) -> dict:
    """Return a new dict: `theme` overlaid by `prev` (prev's values win).

    Never mutates `prev` or `theme`. `fontFamily` and `googleFonts` travel
    together: if `prev` carries its own `fontFamily` or `googleFonts`,
    theme's copies of both are dropped rather than mixed with prev's.
    """
    prev = prev if isinstance(prev, dict) else {}
    theme = theme if isinstance(theme, dict) else {}

    result = dict(theme)
    if "fontFamily" in prev or "googleFonts" in prev:
        result.pop("fontFamily", None)
        result.pop("googleFonts", None)
    result.update(prev)
    return result
