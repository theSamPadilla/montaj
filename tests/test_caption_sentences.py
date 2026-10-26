"""Captions break at sentence ends and clause commas and stay short (kung fu bench run: after the cut removed the pauses,
almost every caption was 8 words and ran across sentences: "PLACE OBVIOUSLY THIS IS A STAGED DEMO WITH")."""
import importlib.util
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib"))
sys.path.insert(0, str(ROOT))

from caption_group import group, max_words_for  # noqa: E402


def W(text, step=0.3, start=0.0):
    out, t = [], start
    for w in text.split():
        out.append({"word": w, "start": round(t, 3), "end": round(t + step, 3)})
        t += step
    return out


def texts(segs):
    return [s["text"] for s in segs]


def test_a_sentence_end_always_breaks_and_a_caption_never_runs_across_one():
    words = W("in the right place. Obviously this is a staged demo with a mannequin.")
    assert texts(group(words, max_words=8)) == ["in the right place.", "Obviously this is a staged demo with a",
                                                 "mannequin."]
    assert texts(group(W("Really? Yes! It works."), max_words=8)) == ["Really?", "Yes!", "It works."]


def test_a_clause_comma_breaks_once_the_caption_has_two_words():
    assert texts(group(W("If you're trapped under something, you absolutely want a robot"), max_words=8)) == [
        "If you're trapped under something,", "you absolutely want a robot"]
    # one word before the comma is too short to stand alone
    assert texts(group(W("Yeah, I don't think that kid's fine."), max_words=8)) == ["Yeah, I don't think that kid's fine."]


def test_the_cap_still_holds_inside_a_sentence():
    assert texts(group(W("one two three four five six seven"), max_words=3)) == ["one two three", "four five six", "seven"]


def test_a_quote_or_bracket_after_the_stop_is_still_a_sentence_end_and_an_initialism_is_not():
    assert texts(group(W('he said "stop." Then it fell.'), max_words=8)) == ['he said "stop."', "Then it fell."]
    assert texts(group(W("made in the U.S. by a team"), max_words=8)) == ["made in the U.S. by a team"]


def test_the_pause_rule_stays():
    words = W("one two") + W("three four", start=1.2)
    assert texts(group(words, max_words=8)) == ["one two", "three four"]


def test_no_punctuation_and_the_old_cap_groups_as_before():
    assert texts(group(W("a b c d e f g h i j"))) == ["a b c d e f g h", "i j"]


def test_line_styles_default_to_short_captions_and_word_styles_keep_eight():
    for style in ("outline", "highlight-box", "karaoke", "plate", "clean", "subtitle", "accent"):
        assert max_words_for(style) == 4, style
    for style in ("word-by-word", "pop"):
        assert max_words_for(style) == 8, style
    assert max_words_for("outline", 2) == 2, "the profile's captionWords wins"
    assert max_words_for("outline", 0) == 4 and max_words_for("outline", 40) == 4 and max_words_for("outline", "3") == 4


# -- the caption step and generate_captions -------------------------------------------------------------------------

def _caption_py(tmp_path, style, extra=()):
    import subprocess
    words = W("If you're trapped under something, you absolutely want a robot around that is strong enough to get you out.")
    src = tmp_path / "w.json"
    src.write_text(json.dumps({"transcription": [
        {"text": " " + w["word"], "offsets": {"from": int(w["start"] * 1000), "to": int(w["end"] * 1000)}} for w in words]}))
    out = tmp_path / "t.json"
    subprocess.run([sys.executable, str(ROOT / "steps" / "lyrics" / "caption.py"), "--input", str(src), "--style", style,
                    "--out", str(out), *extra], check=True, capture_output=True)
    return texts(json.loads(out.read_text())["segments"])


def test_the_caption_step_uses_the_styles_cap_and_takes_max_words(tmp_path):
    assert _caption_py(tmp_path, "outline") == ["If you're trapped under", "something,", "you absolutely want a",
                                                "robot around that is", "strong enough to get", "you out."]
    assert _caption_py(tmp_path, "outline", ["--max-words", "8"])[0] == "If you're trapped under something,"


def test_generate_captions_passes_the_profiles_caption_words(tmp_path, monkeypatch, capsys):
    spec = importlib.util.spec_from_file_location("gc_words", ROOT / "steps" / "transform" / "generate_captions.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    home = tmp_path / "home"
    prof = home / ".montaj" / "profiles" / "p1"
    prof.mkdir(parents=True)
    (prof / "preferences.json").write_text(json.dumps({"captionStyle": "outline", "captionWords": 3}))
    monkeypatch.setenv("HOME", str(home))
    pdir = tmp_path / "proj"
    pdir.mkdir()
    (pdir / "project.json").write_text(json.dumps({"id": "p1", "name": "t", "profile": "p1", "settings": {},
        "tracks": [{"id": "trk-0", "items": [{"id": "c1", "type": "video", "src": str(pdir / "a.mp4"),
                                              "start": 0.0, "end": 4.0, "inPoint": 0.0, "outPoint": 4.0}]}]}))
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: pdir)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda p: 1)
    monkeypatch.setattr(mod, "ink_pass", lambda p: [])
    seen = {}

    def fake_run(cmd, **kw):
        if "transcribe.py" in " ".join(cmd):
            (pdir / "_caption_words.json").write_text(json.dumps({"transcription": []}))
        if "caption.py" in " ".join(cmd):
            seen["cmd"] = cmd
            (pdir / "_caption_track.json").write_text(json.dumps({"style": "outline", "segments": [
                {"text": "a", "start": 0, "end": 1, "words": [{"word": "a", "start": 0, "end": 1}]}]}))
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1", "--script", ""])
    mod.main()
    cmd = seen["cmd"]
    assert cmd[cmd.index("--max-words") + 1] == "3"


def test_an_inflection_kept_as_heard_takes_the_scripts_full_stop():
    from caption_script import align
    heard = [{"word": w, "start": i, "end": i + 1} for i, w in enumerate("to protect in the demo".split())]
    out, n = align(heard, "to be protecting. In the demo, the robot")
    assert [w["word"] for w in out] == ["to", "protect.", "In", "the", "demo,"] and n == 0
    assert [s["text"] for s in group(out, max_words=4)] == ["to protect.", "In the demo,"]
