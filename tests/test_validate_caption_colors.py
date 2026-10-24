"""§558: a caption word's own `color` (words[].color) is checked only when present: a hex or a named CSS colour.

No caption validator existed before, and validate runs on saves, so the rule must accept every caption shape a
project has today: the caption fixtures in the repo, a project with every caption style, words with no colour,
segments with no words, translated rows, per-word accents, per-segment overrides.
"""
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))
sys.path.insert(0, str(REPO_ROOT))

import validate as v  # noqa: E402
from lib.css_color import is_css_color  # noqa: E402

STYLES = ["word-by-word", "pop", "karaoke", "subtitle", "highlight-box", "outline", "clean", "accent", "plate"]
BASE = {"version": "0.2", "id": "abc", "status": "draft", "workflow": "default", "editingPrompt": "t",
        "settings": {"resolution": [1080, 1920], "fps": 30}, "tracks": [[]], "assets": [], "audio": {}}


def _words(*colors):
    out = []
    for i, c in enumerate(colors):
        w = {"word": f"w{i}", "start": i * 0.5, "end": i * 0.5 + 0.4}
        if c is not None:
            w["color"] = c
        out.append(w)
    return out


def _project(tmp_path, captions):
    p = tmp_path / "project.json"
    p.write_text(json.dumps({**BASE, "captions": captions}))
    return str(p)


def _error(capsys):
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


@pytest.mark.parametrize("style", STYLES)
def test_every_style_with_todays_caption_shapes_is_valid(tmp_path, style):
    caps = {"style": style, "color": "#ffffff", "accentColor": "#00ffff", "fontsize": 64, "segments": [
        {"id": "cap-1", "text": "w0 w1", "start": 0, "end": 1, "words": _words(None, None)},
        {"id": "cap-2", "text": "no words", "start": 1, "end": 2},
        {"id": "cap-3", "text": "accented", "start": 2, "end": 3, "words": [{"word": "accented", "start": 2, "end": 2.9, "accent": "serif"}],
         "offsetY": -20, "scale": 1.2, "color": "#ff0000", "fontSize": 80},
        {"id": "cap-4", "text": "traducido", "start": 0, "end": 1, "lang": "es", "translationOf": ["cap-1"], "lane": 1},
        {"id": "cap-5", "text": "w0 w1", "start": 3, "end": 4, "words": _words("#0ff", "cyan")},
    ]}
    assert v.validate_project(_project(tmp_path, caps))["valid"] is True


def test_a_null_word_colour_reads_as_none(tmp_path):
    words = _words(None, None)
    words[1]["color"] = None
    caps = {"style": "pop", "segments": [{"text": "a b", "start": 0, "end": 1, "words": words}]}
    assert v.validate_project(_project(tmp_path, caps))["valid"] is True


@pytest.mark.parametrize("fixture", ["tests/fixtures/speech_text/project.json", "montaj_assets/render/test/fixtures/nle/captions.json"])
def test_the_repos_caption_fixtures_stay_valid(tmp_path, fixture, capsys):
    data = json.loads((REPO_ROOT / fixture).read_text())
    project = data if "captions" in data and "settings" in data else {**BASE, "captions": data.get("captions", data)}
    v._validate_caption_word_colors(project)   # the new rule alone: it says nothing about these
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize("color", ["#fff", "#ffff", "#00ffff", "#00FFFF80", "cyan", "White", "rebeccapurple", "transparent"])
def test_a_hex_or_named_colour_is_accepted(color):
    assert is_css_color(color)


@pytest.mark.parametrize("color", ["", "ff0000", "#ggg", "#12345", "rgb(0,0,0)", "cyanish", 12, None, ["#fff"]])
def test_anything_else_is_not_a_colour(color):
    assert not is_css_color(color)


@pytest.mark.parametrize("bad", ["ff0000", "rgb(0,0,0)", 7, "", ["#fff"]])
def test_a_word_colour_that_is_not_a_colour_is_refused_naming_it(tmp_path, capsys, bad):
    caps = {"style": "pop", "segments": [{"text": "a b", "start": 0, "end": 1, "words": _words(None, bad)}]}
    with pytest.raises(SystemExit):
        v.validate_project(_project(tmp_path, caps))
    err = _error(capsys)
    assert err["error"] == "invalid_field" and "captions.segments[0].words[1].color" in err["message"]


@pytest.mark.parametrize("caps", [None, {}, {"style": "pop"}, {"segments": "x"}, {"segments": [None, {"words": "x"}, {"words": [None, 3]}]}])
def test_malformed_caption_shapes_are_not_this_rules_business(caps, capsys):
    v._validate_caption_word_colors({"captions": caps})
    assert capsys.readouterr().err == ""
