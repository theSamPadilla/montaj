"""A profile's caption look: the caption-track fields a style profile seeds into a new caption track.

The same mapping the app's editor applies when a person regenerates captions (the app's captionProfileLook.ts and
captionProfileDefaults.ts), so a caption run over MCP (the generate_captions step, the caption route with no `theme`)
draws in the profile's font and emphasis colour exactly as one started from the editor:
- fontFamily + googleFonts, both or neither: the profile's `fontFamily` matched by label (case aside) against the
  editor's font list (FONT_OPTIONS, a mirror of montaj_assets/editor/src/text/FontPicker.tsx without 'System'; a
  test checks the two agree). Every style but subtitle (the system face) and clean (its own face).
- the style's emphasis colour (EMPHASIS): the profile's accent, else its primary colour, whichever is readable
  (relative luminance above 0.18), else the style's fallback.
No base text colour: the style's own default stays.
"""
import re

# (label, CSS value, Google Fonts spec): montaj_assets/editor/src/text/FontPicker.tsx's FONT_OPTIONS, minus 'System'.
FONT_OPTIONS = (
    ("Inter", '"Inter", system-ui, sans-serif', "Inter:wght@400;700"),
    ("Roboto", '"Roboto", system-ui, sans-serif', "Roboto:wght@400;700"),
    ("Open Sans", '"Open Sans", system-ui, sans-serif', "Open+Sans:wght@400;700"),
    ("Lato", '"Lato", system-ui, sans-serif', "Lato:wght@400;700"),
    ("Montserrat", '"Montserrat", system-ui, sans-serif', "Montserrat:wght@400;700"),
    ("Poppins", '"Poppins", system-ui, sans-serif', "Poppins:wght@400;700"),
    ("Raleway", '"Raleway", system-ui, sans-serif', "Raleway:wght@400;700"),
    ("Nunito", '"Nunito", system-ui, sans-serif', "Nunito:wght@400;700"),
    ("Work Sans", '"Work Sans", system-ui, sans-serif', "Work+Sans:wght@400;700"),
    ("DM Sans", '"DM Sans", system-ui, sans-serif', "DM+Sans:wght@400;700"),
    ("Rubik", '"Rubik", system-ui, sans-serif', "Rubik:wght@400;700"),
    ("Oswald", '"Oswald", system-ui, sans-serif', "Oswald:wght@400;700"),
    ("Bebas Neue", '"Bebas Neue", system-ui, sans-serif', "Bebas+Neue:wght@400;700"),
    ("Playfair Display", '"Playfair Display", Georgia, serif', "Playfair+Display:wght@400;700"),
    ("Merriweather", '"Merriweather", Georgia, serif', "Merriweather:wght@400;700"),
    ("Source Serif 4", '"Source Serif 4", Georgia, serif', "Source+Serif+4:wght@400;700"),
    ("JetBrains Mono", '"JetBrains Mono", ui-monospace, monospace', "JetBrains+Mono:wght@400;700"),
    ("Baloo 2", '"Baloo 2", system-ui, sans-serif', "Baloo+2:wght@400;500;600;700;800"),
    ("Fredoka", '"Fredoka", system-ui, sans-serif', "Fredoka:wght@300;400;500;600;700"),
    ("Sniglet", '"Sniglet", system-ui, sans-serif', "Sniglet:wght@400;800"),
)

# The track field each style draws its emphasis in, and the colour when the profile has no readable one.
EMPHASIS = {
    "karaoke": ("highlightColor", "#00B4D8"),
    "highlight-box": ("accentColor", "#00B4D8"),
    "pop": ("activeColor", "#FF8C00"),
    "accent": ("accentColor", "#F00000"),
}
NO_PROFILE_FONT = ("subtitle", "clean")


def _luminance(color) -> float | None:
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", color.strip()) if isinstance(color, str) else None
    if not m:
        return None
    n = int(m.group(1), 16)

    def lin(c):
        v = c / 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)


def _readable(colors):
    """The first colour set that is not too dark to read (or that cannot be measured), else None."""
    for c in colors:
        if not c:
            continue
        lum = _luminance(c)
        if lum is None or lum > 0.18:
            return c
    return None


def font_option(stored):
    """The FONT_OPTIONS entry a profile's stored fontFamily names (by label, case aside), else None."""
    if not isinstance(stored, str) or not stored.strip():
        return None
    needle = stored.strip().lower()
    return next((o for o in FONT_OPTIONS if o[0].lower() == needle), None)


def caption_look(style: str, prefs: dict, emphasis: bool = True) -> dict:
    """The caption-track fields `prefs` (a profile's preferences) seeds for `style`; {} when it seeds none. With
    `emphasis` False, the font only (the editor seeds the emphasis colour only for a profile that picked a style)."""
    look: dict = {}
    if style not in NO_PROFILE_FONT:
        option = font_option(prefs.get("fontFamily"))
        if option:
            look["fontFamily"] = option[1]
            look["googleFonts"] = [option[2]]
    if emphasis and style in EMPHASIS:
        field, fallback = EMPHASIS[style]
        look[field] = _readable([prefs.get("accentColor"), prefs.get("primaryColor")]) or fallback
    return look


def resolve_style_and_look(explicit, project: dict) -> tuple[str, dict]:
    """The style a caption run draws in, and the look the profile seeds into its new track.

    Style: `explicit`, else the track's own style, else the profile's captionStyle, else 'pop'. Look: only for a
    track with no style yet (a re-run keeps the person's track as it is; the editor asks the profile only then too),
    computed for the style the run draws in; the emphasis colour only when the profile picked a caption style. The
    look fills fields the track lacks, never replaces one (serve/caption_theme.seed_prev).
    """
    from lib.profile_assets import profile_preferences
    from lib.caption_style import STYLES
    prior = (project.get("captions") or {}).get("style")
    prefs = profile_preferences(project)
    picked = prefs.get("captionStyle") if prefs.get("captionStyle") in STYLES else None
    style = explicit or prior or picked or "pop"
    look = {} if prior else caption_look(style, prefs, emphasis=picked is not None)
    return style, look


def caption_words_args(project) -> list:
    """`--max-words N` for the caption step when the project's profile sets captionWords (a whole number from 1 to 12),
    else nothing: the style's own cap applies (lib/caption_group.max_words_for)."""
    from lib.profile_assets import profile_preferences
    n = profile_preferences(project).get("captionWords")
    return ["--max-words", str(n)] if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= 12 else []
