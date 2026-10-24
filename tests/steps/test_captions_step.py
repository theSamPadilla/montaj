"""captions (§558): restyle a project's captions in one call, through the guarded write.

N2 of the notes-loop benchmark, note by note: "white with the spoken word highlighted", then "make 'pauses', 'best'
and 'export' cyan", then "move them up to the middle and bigger". Plus the refusals, a person's caption edit made
meanwhile, and what is kept.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

from lib import caption_style  # noqa: E402
import steps.transform.captions as cs  # noqa: E402
import validate as v  # noqa: E402

GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]


def git(d, *args):
    return subprocess.run([*GIT, *args], cwd=d, capture_output=True, text=True, check=True).stdout


def _words(text, start):
    return [{"word": w, "start": start + i * 0.4, "end": start + i * 0.4 + 0.35} for i, w in enumerate(text.split())]


def make_project(tmp_path, captions="default", repo=True):
    d = tmp_path / "proj"
    d.mkdir()
    if captions == "default":
        captions = {"style": "pop", "segments": [
            {"id": "cap-1", "text": "Cut the pauses", "start": 0, "end": 1.2, "words": _words("Cut the pauses", 0)},
            {"id": "cap-2", "text": "keep the best part", "start": 1.2, "end": 2.8, "words": _words("keep the best part", 1.2), "color": "#ff0000", "fontSize": 90},
            {"id": "cap-3", "text": "then export.", "start": 2.8, "end": 3.6, "words": _words("then export.", 2.8)},
            {"id": "cap-4", "text": "luego exporta.", "start": 2.8, "end": 3.6, "lang": "es", "translationOf": ["cap-3"], "lane": 1},
        ]}
    project = {"version": "0.2", "id": "cap-fixture", "name": "Captions", "status": "draft", "workflow": "default",
               "editingPrompt": "t", "settings": {"resolution": [1080, 1920], "fps": 30}, "tracks": [[]], "assets": [],
               "audio": {}}
    if captions is not None:
        project["captions"] = captions
    (d / "project.json").write_text(json.dumps(project, indent=2))
    if repo:
        git(d, "init", "-q")
        git(d, "add", "project.json")
        git(d, "commit", "-q", "-m", "init")
    return d


def caps(d):
    return json.loads((d / "project.json").read_text())["captions"]


def run(d, **kw):
    return cs.run(str(d / "project.json"), **kw)


def refused(capsys, fn, *a, **k):
    with pytest.raises(SystemExit):
        fn(*a, **k)
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


def word_colors(c):
    return {w["word"]: w.get("color") for s in c["segments"] for w in s.get("words", [])}


# ── N2, note by note ──────────────────────────────────────────────────────────────────────────────────────────────

def test_n2_white_with_the_spoken_word_highlighted(tmp_path):
    d = make_project(tmp_path)
    out = run(d, look="highlight", color="white", highlight="cyan")
    c = caps(d)
    assert (c["style"], c["color"], c["accentColor"]) == ("outline", "white", "cyan")
    assert "color" not in c["segments"][1], "the track colour applies to every caption, as Apply to all does"
    assert out == {"style": "outline", "segments": 3, "color": "white", "highlight": "cyan", "cleared": {"color": 1}}, \
        "nothing unversioned yet: no version needed; cap-2's own red is named as cleared"


def test_a_restyle_takes_a_version_holding_the_persons_unversioned_edit(tmp_path):
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    p["captions"]["segments"][0]["text"] = "Cut the long pauses"     # the person's edit, in no version yet
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, look="highlight")
    assert out["version"] is True and git(d, "log", "-1", "--format=%s").strip() == cs.VERSION_MESSAGE
    kept = json.loads(git(d, "show", "HEAD:project.json"))["captions"]
    assert kept["segments"][0]["text"] == "Cut the long pauses" and kept["style"] == "pop"


def test_n2_make_pauses_best_and_export_cyan(tmp_path):
    d = make_project(tmp_path)
    run(d, look="highlight", color="white", highlight="cyan")
    out = run(d, accent=json.dumps({"words": ["pauses", "best", "export"], "color": "cyan"}))
    colors = word_colors(caps(d))
    assert colors["pauses"] == colors["best"] == colors["export."] == "cyan"
    assert colors["Cut"] is None and colors["keep"] is None
    assert out["accent"] == {"found": {"pauses": 1, "best": 1, "export": 1}, "missed": {}}
    assert v.validate_project(str(d / "project.json"))["valid"] is True


def test_n2_move_them_up_to_the_middle_and_bigger(tmp_path):
    d = make_project(tmp_path)
    run(d, look="highlight", color="white", highlight="cyan")
    out = run(d, position="middle", size="bigger")
    c = caps(d)
    assert [s.get("offsetY") for s in c["segments"]] == [-19.0, -19.0, -19.0, -19.0], "every caption and its translation"
    assert c["fontsize"] == round(caption_style.DEFAULT_SIZE["outline"] * 1.25)
    assert c["segments"][1]["fontSize"] == round(90 * 1.25), "bigger scales a caption's own size, never drops it"
    assert out["position"] == "middle" and out["size"] == c["fontsize"]
    # the first restyle was not in any version: the second takes one holding it
    assert git(d, "log", "--format=%s").strip().split("\n") == [cs.VERSION_MESSAGE, "init"]
    held = json.loads(git(d, "show", "HEAD:project.json"))["captions"]
    assert held["style"] == "outline" and "offsetY" not in held["segments"][0]


# ── accent words ──────────────────────────────────────────────────────────────────────────────────────────────────

def test_accent_names_the_words_it_did_not_find_and_takes_phrases(tmp_path):
    d = make_project(tmp_path)
    out = run(d, accent='{"words": ["best part", "export", "magic"], "color": "#00ffff"}')
    colors = word_colors(caps(d))
    assert colors["best"] == colors["part"] == colors["export."] == "#00ffff"
    assert out["accent"] == {"found": {"best part": 1, "export": 1}, "missed": {"magic": []}}


def test_accent_none_removes_a_words_colour(tmp_path):
    d = make_project(tmp_path)
    run(d, accent='{"words": ["pauses", "best"], "color": "cyan"}')
    run(d, accent='{"words": ["best"], "color": "none"}')
    colors = word_colors(caps(d))
    assert colors["pauses"] == "cyan" and colors["best"] is None and "color" not in caps(d)["segments"][1]["words"][2]


def test_accent_on_a_phrase_only_look_says_it_needs_a_per_word_look(tmp_path):
    d = make_project(tmp_path)
    out = run(d, look="clean", accent='{"words": ["pauses"]}')
    assert out["issues"] == ["accent needs a per-word look: clean draws phrases"]


def test_a_highlight_on_a_style_without_one_says_so(tmp_path):
    d = make_project(tmp_path)
    out = run(d, look="word-by-word", highlight="cyan")
    assert out["issues"] == ["word-by-word has no spoken-word highlight: use look highlight, highlight-box, karaoke, outline, plate"]


def test_the_translated_row_takes_no_accent_but_moves_with_its_caption(tmp_path):
    d = make_project(tmp_path)
    out = run(d, accent='{"words": ["luego"]}', position="top")
    tr = caps(d)["segments"][3]
    assert "words" not in tr and out["accent"]["missed"] == {"luego": []}
    assert tr["offsetY"] == caps(d)["segments"][0]["offsetY"], "a translation drawn alone sits where its caption does"


# ── refusals and the guarded write ────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("kw,err", [
    ({}, "invalid_params"),
    ({"color": "rgb(0,0,0); x"}, "invalid_params"),
    ({"size": "+20"}, "invalid_params"),
    ({"size": "huge"}, "invalid_params"),
    ({"size": "4000"}, "invalid_params"),
    ({"accent": "pauses"}, "invalid_params"),
])
def test_bad_inputs_are_refused_and_nothing_is_written(tmp_path, capsys, kw, err):
    d = make_project(tmp_path)
    before = (d / "project.json").read_bytes()
    assert refused(capsys, run, d, **kw)["error"] == err
    assert (d / "project.json").read_bytes() == before


def test_a_project_with_no_captions_is_told_to_generate_them(tmp_path, capsys):
    d = make_project(tmp_path, captions=None)
    err = refused(capsys, run, d, look="pop")
    assert err["error"] == "no_captions" and "generate_captions" in err["message"]


def test_a_person_editing_the_captions_meanwhile_is_refused_and_kept(tmp_path, monkeypatch, capsys):
    d = make_project(tmp_path)
    real = caption_style.restyle

    def restyle_then_the_person_edits(*a, **k):
        out = real(*a, **k)
        p = json.loads((d / "project.json").read_text())
        p["captions"]["segments"][0]["text"] = "Cut every pause"     # typed in the editor meanwhile
        (d / "project.json").write_text(json.dumps(p))
        return out
    monkeypatch.setattr(cs.caption_style, "restyle", restyle_then_the_person_edits)
    err = refused(capsys, run, d, look="highlight")
    assert err["error"] == "project_changed"
    c = caps(d)
    assert c["segments"][0]["text"] == "Cut every pause" and c["style"] == "pop"


def test_a_change_outside_the_captions_is_kept(tmp_path, monkeypatch):
    d = make_project(tmp_path)
    real = caption_style.restyle

    def restyle_then_rename(*a, **k):
        out = real(*a, **k)
        p = json.loads((d / "project.json").read_text())
        p["name"] = "Renamed meanwhile"
        (d / "project.json").write_text(json.dumps(p))
        return out
    monkeypatch.setattr(cs.caption_style, "restyle", restyle_then_rename)
    run(d, look="karaoke")
    p = json.loads((d / "project.json").read_text())
    assert p["name"] == "Renamed meanwhile" and p["captions"]["style"] == "karaoke"


def test_a_restyle_that_changes_nothing_writes_nothing(tmp_path):
    d = make_project(tmp_path)
    before = (d / "project.json").read_bytes()
    out = run(d, look="pop")
    assert out["unchanged"] is True and (d / "project.json").read_bytes() == before
    assert git(d, "log", "--format=%s").strip().split("\n") == ["init"], "no version for nothing"


def test_outside_a_git_folder_it_says_no_version(tmp_path):
    d = make_project(tmp_path, repo=False)
    out = run(d, look="karaoke")
    assert "version" not in out and any("no version saved" in i for i in out["issues"])


def test_the_answer_stays_within_300_characters(tmp_path):
    many = [f"word{i}" for i in range(60)]
    d = make_project(tmp_path)
    out = run(d, accent=json.dumps({"words": many + ["pauses"], "color": "cyan"}))
    assert len(json.dumps(out)) <= 300 and out["accent"]["found"] == ["pauses"] or "more" in out["accent"]


# ── the gate reviews ──────────────────────────────────────────────────────────────────────────────────────────────

def test_cleared_counts_only_captions_whose_own_value_changed(tmp_path):
    d = make_project(tmp_path)
    out = run(d, color="#ff0000", size="80", position="middle")
    assert out["cleared"] == {"fontSize": 1}, "cap-2's own red equals the new colour: not counted; its 90 px is"
    c = caps(d)
    assert "color" not in c["segments"][1] and "fontSize" not in c["segments"][1] and c["fontsize"] == 80


def test_highlight_clears_a_captions_own_spoken_colour(tmp_path):
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    p["captions"]["style"] = "outline"
    p["captions"]["segments"][0]["accentColor"] = "pink"
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, highlight="yellow")
    assert "accentColor" not in caps(d)["segments"][0] and out["cleared"] == {"accentColor": 1}


def test_no_style_is_styled_as_the_renderer_draws_it_subtitle(tmp_path):
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    del p["captions"]["style"]
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, highlight="cyan", size="large")
    assert out["style"] == "subtitle" and out["size"] == round(caption_style.DEFAULT_SIZE["subtitle"] * 1.3)
    assert any("has no spoken-word highlight" in i for i in out["issues"])


def test_pop_takes_its_text_colour_on_activecolor_and_has_no_spoken_highlight(tmp_path):
    d = make_project(tmp_path)
    out = run(d, color="white", highlight="cyan")
    c = caps(d)
    assert c["activeColor"] == "white" and "highlight" not in out
    assert out["issues"][0].startswith("pop has no spoken-word highlight")


def test_the_accent_look_has_no_spoken_word_highlight_and_moves_by_its_centre(tmp_path):
    d = make_project(tmp_path)
    out = run(d, look="accent", highlight="cyan", position="middle")
    assert "accentColor" not in caps(d) and out["issues"][0].startswith("accent has no spoken-word highlight")
    assert caps(d)["segments"][0]["offsetY"] == round(50.0 - 59.5, 1)
    assert "offsetY" not in caps(d)["segments"][3], "accent stacks translations inside its block"


def test_the_highlight_look_makes_text_white_unless_told(tmp_path):
    d = make_project(tmp_path)
    run(d, look="highlight")
    assert caps(d)["color"] == "#ffffff" and "color" not in caps(d)["segments"][1]
    d2 = make_project(tmp_path / "x") if (tmp_path / "x").mkdir() is None else None
    run(d2, look="highlight", color="yellow")
    assert caps(d2)["color"] == "yellow"


def test_bigger_never_makes_captions_smaller(tmp_path):
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    p["captions"]["style"] = "outline"
    for seg in p["captions"]["segments"]:
        seg["fontSize"] = 120
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, size="bigger")
    assert all(s["fontSize"] == 150 for s in caps(d)["segments"]) and out["size"] == 150


@pytest.mark.parametrize("size,want", [("150%", 105), ("1.5x", 105), ("80px", 80), (" 64 ", 64)])
def test_size_takes_relative_and_px_forms(tmp_path, size, want):
    d = make_project(tmp_path)
    run(d, look="outline")
    run(d, size=size)
    assert caps(d)["fontsize"] == want


def test_a_phrase_across_two_captions_is_found_and_coloured(tmp_path):
    d = make_project(tmp_path)
    out = run(d, accent='{"words": ["pauses keep"]}')
    c = caps(d)
    assert out["accent"]["found"] == {"pauses keep": 1}
    assert c["segments"][0]["words"][2]["color"] == "cyan" and c["segments"][1]["words"][0]["color"] == "cyan"


def test_a_near_miss_is_named_and_not_coloured(tmp_path):
    d = make_project(tmp_path)
    out = run(d, accent='{"words": ["pause", "exporting"]}')
    assert out["accent"]["missed"] == {"pause": ["pauses"], "exporting": ["export"]}
    assert all("color" not in w for s in caps(d)["segments"] for w in s.get("words", []))


def test_an_accent_the_colour_of_the_spoken_word_is_flagged(tmp_path):
    d = make_project(tmp_path)
    run(d, look="highlight", highlight="cyan")
    out = run(d, accent='{"words": ["best"], "color": "#00FFFF"}')
    assert "accent matches the spoken-word colour: the accent words look spoken" in out["issues"]


def test_odd_word_entries_and_spellings_do_not_break_it(tmp_path):
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    p["captions"]["segments"][0]["words"][0]["word"] = None
    p["captions"]["segments"][2]["words"][0]["word"] = "it\u2019s"
    p["captions"]["segments"][3]["lang"] = ""     # a translation all the same: lang is a string
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, accent='{"words": ["it\'s", "pauses"], "color": "NONE"}')
    assert out["accent"]["found"] == {"it's": 1, "pauses": 1}


def test_the_longest_word_is_checked_against_the_frame(tmp_path):
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    p["captions"]["segments"][0]["words"][2]["word"] = "supercalifragilistic"
    (d / "project.json").write_text(json.dumps(p))
    out = run(d, look="outline", size="120")
    assert any("the longest word may not fit the frame at 120px" in i for i in out["issues"])


def test_the_answer_stays_within_300_characters_with_many_misses(tmp_path):
    d = make_project(tmp_path)
    out = run(d, accent=json.dumps({"words": [f"missing{i}" for i in range(40)], "color": "cyan"}))
    assert len(json.dumps(out)) <= 300 and out["accent"]["more"] > 0
