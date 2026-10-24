"""A caller's colour as a value ffmpeg's filter graph can take (§563).

A colour goes into the graph unquoted (drawtext ``fontcolor=``, the lavfi ``color=c=`` source), where ``,`` ``:``
``;`` or ``[`` would start another option or filter, so free text never gets there. And captions in a project carry
whatever CSS an author or an AI wrote, so a CSS colour is converted, not refused:

- a form ffmpeg already reads (``#RRGGBB[AA]``, ``0xRRGGBB[AA]``, bare ``RRGGBB[AA]``, a colour name in ffmpeg's own
  table, any of those with ``@alpha``) passes UNCHANGED, so a render that worked keeps exactly its arguments;
- any other CSS colour (``#RGB``, ``#RGBA``, ``rgb()``/``rgba()`` and ``hsl()``/``hsla()`` in comma or space syntax,
  ``transparent``, a CSS name ffmpeg lacks) becomes ``0xRRGGBBAA``;
- anything else raises ValueError.
"""
import colorsys
import json
import math
import re

# The 148 CSS named colours (CSS Color Module Level 4), as RRGGBB.
CSS_NAMED = {
    "aliceblue": "f0f8ff", "antiquewhite": "faebd7", "aqua": "00ffff", "aquamarine": "7fffd4", "azure": "f0ffff",
    "beige": "f5f5dc", "bisque": "ffe4c4", "black": "000000", "blanchedalmond": "ffebcd", "blue": "0000ff",
    "blueviolet": "8a2be2", "brown": "a52a2a", "burlywood": "deb887", "cadetblue": "5f9ea0", "chartreuse": "7fff00",
    "chocolate": "d2691e", "coral": "ff7f50", "cornflowerblue": "6495ed", "cornsilk": "fff8dc", "crimson": "dc143c",
    "cyan": "00ffff", "darkblue": "00008b", "darkcyan": "008b8b", "darkgoldenrod": "b8860b", "darkgray": "a9a9a9",
    "darkgreen": "006400", "darkgrey": "a9a9a9", "darkkhaki": "bdb76b", "darkmagenta": "8b008b",
    "darkolivegreen": "556b2f", "darkorange": "ff8c00", "darkorchid": "9932cc", "darkred": "8b0000",
    "darksalmon": "e9967a", "darkseagreen": "8fbc8f", "darkslateblue": "483d8b", "darkslategray": "2f4f4f",
    "darkslategrey": "2f4f4f", "darkturquoise": "00ced1", "darkviolet": "9400d3", "deeppink": "ff1493",
    "deepskyblue": "00bfff", "dimgray": "696969", "dimgrey": "696969", "dodgerblue": "1e90ff",
    "firebrick": "b22222", "floralwhite": "fffaf0", "forestgreen": "228b22", "fuchsia": "ff00ff",
    "gainsboro": "dcdcdc", "ghostwhite": "f8f8ff", "gold": "ffd700", "goldenrod": "daa520", "gray": "808080",
    "green": "008000", "greenyellow": "adff2f", "grey": "808080", "honeydew": "f0fff0", "hotpink": "ff69b4",
    "indianred": "cd5c5c", "indigo": "4b0082", "ivory": "fffff0", "khaki": "f0e68c", "lavender": "e6e6fa",
    "lavenderblush": "fff0f5", "lawngreen": "7cfc00", "lemonchiffon": "fffacd", "lightblue": "add8e6",
    "lightcoral": "f08080", "lightcyan": "e0ffff", "lightgoldenrodyellow": "fafad2", "lightgray": "d3d3d3",
    "lightgreen": "90ee90", "lightgrey": "d3d3d3", "lightpink": "ffb6c1", "lightsalmon": "ffa07a",
    "lightseagreen": "20b2aa", "lightskyblue": "87cefa", "lightslategray": "778899", "lightslategrey": "778899",
    "lightsteelblue": "b0c4de", "lightyellow": "ffffe0", "lime": "00ff00", "limegreen": "32cd32", "linen": "faf0e6",
    "magenta": "ff00ff", "maroon": "800000", "mediumaquamarine": "66cdaa", "mediumblue": "0000cd",
    "mediumorchid": "ba55d3", "mediumpurple": "9370db", "mediumseagreen": "3cb371", "mediumslateblue": "7b68ee",
    "mediumspringgreen": "00fa9a", "mediumturquoise": "48d1cc", "mediumvioletred": "c71585",
    "midnightblue": "191970", "mintcream": "f5fffa", "mistyrose": "ffe4e1", "moccasin": "ffe4b5",
    "navajowhite": "ffdead", "navy": "000080", "oldlace": "fdf5e6", "olive": "808000", "olivedrab": "6b8e23",
    "orange": "ffa500", "orangered": "ff4500", "orchid": "da70d6", "palegoldenrod": "eee8aa", "palegreen": "98fb98",
    "paleturquoise": "afeeee", "palevioletred": "db7093", "papayawhip": "ffefd5", "peachpuff": "ffdab9",
    "peru": "cd853f", "pink": "ffc0cb", "plum": "dda0dd", "powderblue": "b0e0e6", "purple": "800080",
    "rebeccapurple": "663399", "red": "ff0000", "rosybrown": "bc8f8f", "royalblue": "4169e1",
    "saddlebrown": "8b4513", "salmon": "fa8072", "sandybrown": "f4a460", "seagreen": "2e8b57", "seashell": "fff5ee",
    "sienna": "a0522d", "silver": "c0c0c0", "skyblue": "87ceeb", "slateblue": "6a5acd", "slategray": "708090",
    "slategrey": "708090", "snow": "fffafa", "springgreen": "00ff7f", "steelblue": "4682b4", "tan": "d2b48c",
    "teal": "008080", "thistle": "d8bfd8", "tomato": "ff6347", "turquoise": "40e0d0", "violet": "ee82ee",
    "wheat": "f5deb3", "white": "ffffff", "whitesmoke": "f5f5f5", "yellow": "ffff00", "yellowgreen": "9acd32",
}

# The colour names ffmpeg's own table knows (``ffmpeg -colors``). Two of them (mediumpurple, palevioletred) are one step
# off the CSS value in ffmpeg; they still pass unchanged, so a render that used one keeps its pixels.
FFMPEG_NAMES = frozenset({
    "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond",
    "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue",
    "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkkhaki",
    "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
    "darkslateblue", "darkslategray", "darkturquoise", "darkviolet", "deeppink", "deepskyblue", "dimgray",
    "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold",
    "goldenrod", "gray", "green", "greenyellow", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki",
    "lavender", "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
    "lightgoldenrodyellow", "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen", "lightskyblue",
    "lightslategray", "lightsteelblue", "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon",
    "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
    "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin",
    "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
    "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue",
    "purple", "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell",
    "sienna", "silver", "skyblue", "slateblue", "slategray", "snow", "springgreen", "steelblue", "tan", "teal",
    "thistle", "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
})

EXAMPLE = "#ffffff or white"

# ffmpeg's own hex: `#`, `0x` (lower case: it refuses `0X`) or no prefix at all, then 6 or 8 digits of either case.
_HEX_FFMPEG = re.compile(r"(?:#|0x)?(?i:[0-9a-f]{6}|[0-9a-f]{8})")
_HEX_SHORT = re.compile(r"#([0-9a-f]{3,4})", re.I)
_ALPHA_SUFFIX = re.compile(r"(?:0x(?i:[0-9a-f]{2})|[0-9]*\.?[0-9]+)")
_FUNC = re.compile(r"(rgba?|hsla?)\(\s*(.*?)\s*\)", re.I | re.S)
_NUM = r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?"
_ARG = re.compile(rf"({_NUM})(%|deg|grad|rad|turn)?", re.I)


def _hex(r: float, g: float, b: float, a: float) -> str:
    def byte(x):
        return f"{round(max(0.0, min(255.0, x))):02X}"
    return f"0x{byte(r)}{byte(g)}{byte(b)}{byte(a * 255)}"


def _args(body: str) -> list[tuple[float, str]] | None:
    """The arguments of rgb()/hsl(): comma syntax, or space syntax with an optional `/ alpha`."""
    if "," in body:
        parts = [p.strip() for p in body.split(",")]
    else:
        main, slash, alpha = body.partition("/")
        parts = main.split() + ([alpha.strip()] if slash else [])
    out = []
    for p in parts:
        m = _ARG.fullmatch(p)
        if not m:
            return None
        value = float(m.group(1))
        if not math.isfinite(value):
            return None
        out.append((value, (m.group(2) or "").lower()))
    return out


def _alpha(arg: tuple[float, str]) -> float | None:
    value, unit = arg
    if unit == "%":
        return max(0.0, min(1.0, value / 100))
    return max(0.0, min(1.0, value)) if unit == "" else None


def _function(name: str, body: str) -> str | None:
    args = _args(body)
    if args is None or len(args) not in (3, 4):
        return None
    alpha = _alpha(args[3]) if len(args) == 4 else 1.0
    if alpha is None:
        return None
    if name.startswith("rgb"):
        if any(unit not in ("", "%") for _, unit in args[:3]):
            return None
        r, g, b = (v * 2.55 if unit == "%" else v for v, unit in args[:3])
        return _hex(r, g, b, alpha)
    (h, hu), (s, su), (l, lu) = args[:3]
    turns = {"": 1 / 360, "deg": 1 / 360, "grad": 1 / 400, "rad": 1 / (2 * math.pi), "turn": 1.0}
    if hu not in turns or su not in ("", "%") or lu not in ("", "%"):
        return None
    r, g, b = colorsys.hls_to_rgb((h * turns[hu]) % 1.0, max(0.0, min(1.0, l / 100)), max(0.0, min(1.0, s / 100)))
    return _hex(r * 255, g * 255, b * 255, alpha)


def _convert(value: str) -> tuple[str, bool] | None:
    """(ffmpeg colour, passed unchanged), or None when `value` is not a colour."""
    lower = value.lower()
    if _HEX_FFMPEG.fullmatch(value) or lower in FFMPEG_NAMES:
        return value, True
    if lower == "transparent":
        return "0x00000000", False
    if lower in CSS_NAMED:
        return f"0x{CSS_NAMED[lower].upper()}FF", False
    m = _HEX_SHORT.fullmatch(value)
    if m:
        digits = [int(c * 2, 16) for c in m.group(1)]
        return _hex(*digits[:3], digits[3] / 255 if len(digits) == 4 else 1.0), False
    m = _FUNC.fullmatch(value)
    if m:
        converted = _function(m.group(1).lower(), m.group(2))
        return (converted, False) if converted else None
    return None


def ffmpeg_color(value) -> str:
    """`value` as a colour ffmpeg's filter graph reads safely (see the module docstring). Raises ValueError."""
    text = value.strip() if isinstance(value, str) else ""
    base, at, alpha = text.partition("@")
    got = _convert(base) if base else None
    if got is None or (at and not _ALPHA_SUFFIX.fullmatch(alpha)):
        shown = json.dumps(value) if isinstance(value, str) else repr(value)
        raise ValueError(f"{shown} is not a colour (e.g. {EXAMPLE})")
    converted, unchanged = got
    if not at:
        return converted
    # ffmpeg's `@alpha` sets the alpha, so a converted colour keeps only its RGB.
    return text if unchanged else f"{converted[:8]}@{alpha}"
