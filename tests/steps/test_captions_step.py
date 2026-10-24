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
    assert out == {"style": "outline", "segments": 3}, "nothing unversioned yet: no version needed"


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
    assert out["accent"] == {"found": ["pauses", "best", "export"], "missed": []}
    assert v.validate_project(str(d / "project.json"))["valid"] is True


def test_n2_move_them_up_to_the_middle_and_bigger(tmp_path):
    d = make_project(tmp_path)
    run(d, look="highlight", color="white", highlight="cyan")
    out = run(d, position="middle", size="bigger")
    c = caps(d)
    assert [s.get("offsetY") for s in c["segments"]] == [-19.0, -19.0, -19.0, None], "every caption, not the translation"
    assert c["fontsize"] == round(caption_style.DEFAULT_SIZE["outline"] * 1.25) and "fontSize" not in c["segments"][1]
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
    assert out["accent"] == {"found": ["best part", "export"], "missed": ["magic"]}


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
    assert out["issues"] == ["word-by-word has no spoken-word highlight: use look highlight, karaoke or pop"]


def test_the_translated_row_takes_no_accent_and_no_offset(tmp_path):
    d = make_project(tmp_path)
    run(d, accent='{"words": ["luego"]}', position="top")
    tr = caps(d)["segments"][3]
    assert "offsetY" not in tr and "words" not in tr


# ── refusals and the guarded write ────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("kw,err", [
    ({}, "invalid_params"),
    ({"color": "rgb(0,0,0)"}, "invalid_params"),
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
