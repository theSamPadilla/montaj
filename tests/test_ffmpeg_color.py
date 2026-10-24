"""lib/ffmpeg_color.py: a caller's colour reaches ffmpeg's filter graph as an ffmpeg colour, never as text (§563)."""
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from ffmpeg_color import CSS_NAMED, FFMPEG_NAMES, ffmpeg_color  # noqa: E402

from tests.conftest import FFMPEG_BIN, HAS_FFMPEG  # noqa: E402

UNCHANGED = ["white", "White", "BLACK", "navy", "mediumpurple", "#12ab9f", "#12AB9F80", "0x12ab9f", "0x12AB9F80",
             "white@0.5", "0x12ab9f@0x80"]

CONVERTED = {
    "#abc": "0xAABBCCFF",
    "#abcd": "0xAABBCCDD",
    "rgb(255, 0, 0)": "0xFF0000FF",
    "rgba(255,0,0,0.5)": "0xFF000080",
    "RGB(255 0 0 / 50%)": "0xFF000080",
    "rgb(100%, 0%, 0%)": "0xFF0000FF",
    "rgba(0 128 255 / .25)": "0x0080FF40",
    "rgb(300, -5, 12.6)": "0xFF000DFF",
    "hsl(120, 100%, 25%)": "0x008000FF",
    "hsla(0, 100%, 50%, 0.5)": "0xFF000080",
    "hsl(0.5turn 100% 50%)": "0x00FFFFFF",
    "hsl(240deg 100% 50% / 25%)": "0x0000FF40",
    "transparent": "0x00000000",
    "rebeccapurple": "0x663399FF",
    "grey": "0x808080FF",
    "LightGray": "0xD3D3D3FF",
    "#abc@0.5": "0xAABBCC@0.5",
}

NOT_COLOURS = ["foo", "", "  ", "white,null", "white:x=1", "white;null", "[a]", "white'", "white dim", "rgb(1,2)",
               "rgb(1,2,3,4,5)", "rgb(1deg,2,3)", "rgb(1, 2, 3 / 4)", "#12345", "12ab9", "white@x", "white@0.5@1",
               "rgb(1e999, 0, 0)", "hsl(1e999, 50%, 50%)", None, 5]


@pytest.mark.parametrize("value", UNCHANGED)
def test_a_colour_ffmpeg_reads_passes_unchanged(value):
    assert ffmpeg_color(value) == value


@pytest.mark.parametrize("value, expected", CONVERTED.items())
def test_a_css_colour_converts_to_ffmpeg_hex(value, expected):
    assert ffmpeg_color(value) == expected


def test_every_css_named_colour_passes_or_converts():
    assert len(CSS_NAMED) == 148
    for name, rgb in CSS_NAMED.items():
        assert ffmpeg_color(name) == (name if name in FFMPEG_NAMES else f"0x{rgb.upper()}FF")


@pytest.mark.parametrize("value", NOT_COLOURS)
def test_what_is_not_a_colour_is_refused_with_an_example(value):
    with pytest.raises(ValueError, match=r"is not a colour \(e\.g\. #ffffff or white\)"):
        ffmpeg_color(value)


def _pixel(colour):
    r = subprocess.run([FFMPEG_BIN, "-v", "error", "-f", "lavfi", "-i", f"color=c={colour}:s=1x1:d=0.04,format=rgba",
                        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True)
    assert r.returncode == 0, r.stderr.decode(errors="replace")
    return tuple(r.stdout[:4])


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_ffmpeg_reads_each_converted_value_as_that_colour():
    for value, expected in CONVERTED.items():
        if "@" in expected:
            continue
        assert _pixel(ffmpeg_color(value)) == tuple(bytes.fromhex(expected[2:])), value
    assert _pixel(ffmpeg_color("#abc@0.5"))[:3] == (0xAA, 0xBB, 0xCC)


# --- the hex forms exactly as ffmpeg reads them (§563 review) ----------------

@pytest.mark.parametrize("value", ["ffffff", "FF0000", "ff0000aa", "#ABCDEF", "0xABCDEF", "0xabcdef80", "white@0x80"])
def test_hex_ffmpeg_reads_passes_unchanged_bare_too(value):
    assert ffmpeg_color(value) == value


@pytest.mark.parametrize("value", ["0Xff0000", "0XFF0000AA", "fff", "ffff", "white@0X80"])
def test_hex_ffmpeg_refuses_is_refused(value):
    with pytest.raises(ValueError):
        ffmpeg_color(value)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_ffmpeg_reads_bare_hex_as_that_colour():
    assert _pixel(ffmpeg_color("ff0000aa")) == (0xFF, 0x00, 0x00, 0xAA)
    assert _pixel(ffmpeg_color("abcdef")) == (0xAB, 0xCD, 0xEF, 0xFF)
