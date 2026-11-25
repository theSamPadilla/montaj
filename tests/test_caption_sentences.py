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
    # run 5: "mannequin." alone would show for 0.2 s, too short to read, so it ends its sentence's caption
    assert texts(group(words, max_words=8)) == ["in the right place.", "Obviously this is a staged demo with a mannequin."]
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


# -- phrase: a whole clause or sentence, up to about two lines -------------------------------------------------------

def _phrase(text, **kw):
    from caption_group import clause_min_for
    return texts(group(W(text, **kw), max_words_for("phrase"), clause_min_for("phrase")))


def test_phrase_holds_ten_words_and_only_phrase_changes_the_clause_rule():
    from caption_group import clause_min_for
    assert max_words_for("phrase") == 10
    assert max_words_for("phrase", 6) == 6, "the profile's captionWords wins"
    assert clause_min_for("phrase") == 5
    for style in ("word-by-word", "pop", "karaoke", "subtitle", "highlight-box", "outline", "clean", "accent", "plate", None):
        assert clause_min_for(style) is None, style
    assert _phrase("one two three four five six seven eight nine ten eleven twelve thirteen fourteen") == [
        "one two three four five six seven eight nine ten", "eleven twelve thirteen fourteen"]


def test_phrase_a_clause_end_before_five_words_does_not_split():
    assert _phrase("In the end, the machine kept running all night") == ["In the end, the machine kept running all night"]
    assert _phrase("Yes; it worked") == ["Yes; it worked"]


def test_phrase_a_clause_end_from_five_words_splits():
    assert _phrase("When the lights went out, the machine kept running") == [
        "When the lights went out,", "the machine kept running"]
    assert _phrase("They built it in a garage: nobody believed them") == ["They built it in a garage:", "nobody believed them"]


def test_phrase_never_leaves_one_or_two_words_of_a_sentence_for_the_next_caption():
    from caption_group import clause_min_for
    # 11 and 12 words: the last one or two would be an orphan at the 10-word cap, so they stay (up to 12).
    assert _phrase("It was the fourth largest investment bank in the United States.") == [
        "It was the fourth largest investment bank in the United States."]
    assert _phrase("one two three four five six seven eight nine ten eleven twelve.") == [
        "one two three four five six seven eight nine ten eleven twelve."]
    # Three or more words left: the cap holds.
    assert _phrase("one two three four five six seven eight nine ten eleven twelve thirteen.") == [
        "one two three four five six seven eight nine ten", "eleven twelve thirteen."]
    # A clause end finishes the run too.
    assert _phrase("one two three four five six seven eight nine ten eleven, then more words here") == [
        "one two three four five six seven eight nine ten eleven,", "then more words here"]
    # A pause before the leftover words: they start the next caption as before.
    ws = W("one two three four five six seven eight nine ten eleven.")
    for w in ws[10:]:
        w["start"] += 0.6; w["end"] += 0.6
    assert texts(group(ws, max_words_for("phrase"), clause_min_for("phrase"))) == [
        "one two three four five six seven eight nine ten", "eleven."]
    # Every other style keeps the plain cap.
    assert texts(group(W("one two three four eleven."), 4)) == ["one two three four", "eleven."]


def test_phrase_a_sentence_end_always_splits_and_a_pause_still_does():
    assert _phrase("It ran. Then it stopped.") == ["It ran.", "Then it stopped."]
    assert texts(group(W("one two") + W("three four", start=1.2), 10, 5)) == ["one two", "three four"]


def test_the_default_clause_rule_is_unchanged_for_every_other_style():
    words = W("Yeah, so when the lights went out, we kept going; it was fine.")
    for style in ("outline", "highlight-box", "karaoke", "plate", "clean", "subtitle", "accent", "word-by-word", "pop"):
        from caption_group import clause_min_for
        n = max_words_for(style)
        assert group(words, n, clause_min_for(style)) == group(words, n), style
        assert group(words, n, None) == group(words, max_words=n), style


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


def test_the_caption_step_groups_phrase_by_its_own_rule(tmp_path):
    # "If you're trapped under something," is five words: the comma ends it; the rest is one sentence of 13 words.
    assert _caption_py(tmp_path, "phrase") == ["If you're trapped under something,",
                                               "you absolutely want a robot around that is strong enough",
                                               "to get you out."]


def test_the_caption_step_takes_plate(tmp_path):
    assert _caption_py(tmp_path, "plate")[0] == "If you're trapped under"


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
