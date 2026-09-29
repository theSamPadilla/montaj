"""Unit tests for serve.caption_theme."""
from serve.caption_theme import sanitize_theme, seed_prev


# ── sanitize_theme ───────────────────────────────────────────────────────────

def test_sanitize_theme_keeps_allowed_keys():
    raw = {
        "color": "#ffffff",
        "accentColor": "#ff0000",
        "highlightColor": "#00ff00",
        "activeColor": "#0000ff",
        "backgroundColor": "#000000",
        "bgColor": "#111111",
        "fontsize": 24,
        "fontWeight": 700,
        "textTransform": "uppercase",
        "letterSpacing": "0.5px",
        "lineHeight": 1.2,
        "textAlign": "center",
        "fontFamily": "Inter",
        "googleFonts": ["Inter:wght@400;700"],
    }
    assert sanitize_theme(raw) == raw


def test_sanitize_theme_drops_unknown_and_style_and_segments():
    raw = {
        "color": "#fff",
        "style": "karaoke",
        "segments": [{"text": "hi"}],
        "position": "bottom",
        "nonsense": "whatever",
    }
    out = sanitize_theme(raw)
    assert out == {"color": "#fff"}
    assert "style" not in out
    assert "segments" not in out
    assert "position" not in out
    assert "nonsense" not in out


def test_sanitize_theme_drops_bad_types():
    raw = {
        "color": "",                 # empty string
        "accentColor": 123,          # not a string
        "backgroundColor": "x" * 65,  # too long
        "fontsize": "24",            # string, not a number
        "fontWeight": None,
        "textAlign": 5,
        "lineHeight": [],
    }
    assert sanitize_theme(raw) == {}


def test_sanitize_theme_non_dict_input_returns_empty():
    assert sanitize_theme(None) == {}
    assert sanitize_theme("theme") == {}
    assert sanitize_theme(["not", "a", "dict"]) == {}
    assert sanitize_theme(42) == {}


def test_sanitize_theme_font_family_alone_is_dropped():
    out = sanitize_theme({"fontFamily": "Inter", "color": "#fff"})
    assert "fontFamily" not in out
    assert "googleFonts" not in out
    assert out == {"color": "#fff"}


def test_sanitize_theme_google_fonts_alone_is_dropped():
    out = sanitize_theme({"googleFonts": ["Inter"], "color": "#fff"})
    assert "fontFamily" not in out
    assert "googleFonts" not in out
    assert out == {"color": "#fff"}


def test_sanitize_theme_font_family_and_google_fonts_together_are_kept():
    out = sanitize_theme({"fontFamily": "Inter", "googleFonts": ["Inter:wght@400"]})
    assert out == {"fontFamily": "Inter", "googleFonts": ["Inter:wght@400"]}


def test_sanitize_theme_google_fonts_bad_list_drops_pair():
    # empty list
    out = sanitize_theme({"fontFamily": "Inter", "googleFonts": []})
    assert out == {}
    # too many entries
    out = sanitize_theme({"fontFamily": "Inter", "googleFonts": ["F"] * 9})
    assert out == {}
    # non-string entry
    out = sanitize_theme({"fontFamily": "Inter", "googleFonts": ["Inter", 5]})
    assert out == {}


def test_sanitize_theme_does_not_mutate_input():
    raw = {"fontFamily": "Inter", "googleFonts": ["Inter"], "style": "pop"}
    raw_copy = dict(raw)
    sanitize_theme(raw)
    assert raw == raw_copy


# ── seed_prev ────────────────────────────────────────────────────────────────

def test_seed_prev_keeps_prevs_values():
    prev = {"color": "#111111"}
    theme = {"color": "#ffffff", "fontsize": 24}
    out = seed_prev(prev, theme)
    assert out["color"] == "#111111"
    assert out["fontsize"] == 24


def test_seed_prev_adds_theme_values_where_prev_lacks_them():
    prev = {"color": "#111111"}
    theme = {"bgColor": "#000000", "fontsize": 30}
    out = seed_prev(prev, theme)
    assert out == {"color": "#111111", "bgColor": "#000000", "fontsize": 30}


def test_seed_prev_font_family_in_prev_blocks_themes_google_fonts():
    prev = {"fontFamily": "Roboto"}
    theme = {"fontFamily": "Inter", "googleFonts": ["Inter:wght@400"]}
    out = seed_prev(prev, theme)
    assert out["fontFamily"] == "Roboto"
    assert "googleFonts" not in out


def test_seed_prev_google_fonts_in_prev_blocks_themes_font_family():
    prev = {"googleFonts": ["Roboto:wght@400"]}
    theme = {"fontFamily": "Inter", "googleFonts": ["Inter:wght@400"]}
    out = seed_prev(prev, theme)
    assert out["googleFonts"] == ["Roboto:wght@400"]
    assert "fontFamily" not in out


def test_seed_prev_does_not_mutate_inputs():
    prev = {"color": "#111111"}
    theme = {"bgColor": "#000000"}
    prev_copy, theme_copy = dict(prev), dict(theme)
    seed_prev(prev, theme)
    assert prev == prev_copy
    assert theme == theme_copy


def test_seed_prev_non_dict_theme_gives_prev_unchanged():
    prev = {"color": "#111111", "fontsize": 24}
    out = seed_prev(prev, None)
    assert out == prev
    out = seed_prev(prev, "not-a-dict")
    assert out == prev
