"""PL89 A2: cut's plan only labels, and its apply hands back the seams (Sam, 2026-10-25: "steps are computation, the
agent is the reasoning").

- The plan removes only silences and fillers. Every saying is a row of ## Cut, in recording order; a row the cut
  would question is tagged retake?, repeat?, false-start? or noise? (a retake or false start names the other take's
  line and time; a repeat names the words said again). Nothing is pre-picked: the plan applied unedited plays every
  saying. No `*` rows.
- The apply never refuses over a tag (noise, inaudible) and the plan never fails as unsettled: each is a note. The
  stale-plan refusal stays.
- The apply's answer lists each seam where the cut skips words: its time on the timeline, the 3 words before and the
  3 after, and a flag when the seam falls inside a word.
Synthetic tones (test_cut.spoken_project) and test_cut_voice's click; invented words, no real media."""
import json
import re

from tests.steps import test_cut as tc
from tests.steps import test_cut_v5 as v5
from tests.steps import test_cut_voice as tv

cc = tc.cc


def rows(text):
    """The ## Cut rows as (line id, words without pause markers, tag or None)."""
    cut, _ = tc.sections(text)
    out = []
    for r in cut:
        m = cc._TAG.search(r)
        body = r[:m.start()] if m else r
        toks = [t for t in body.split() if not t.startswith("{")]
        if toks and re.match(r"^[A-Z]+\d+$", toks[0]):
            out.append((toks[0], " ".join(toks[1:]), m.group(0).strip()[1:-1] if m else None))
    return out


def plan_of(d, monkeypatch, *extra):
    plan, _ = tc.run(d, *extra, monkeypatch=monkeypatch)
    return plan, (d / "cut-plan.md").read_text()


def apply(d, monkeypatch, text=None):
    if text is not None:
        (d / "cut-plan.md").write_text(text)
    applied, _ = tc.run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    return applied


def without(text, line_id):
    """The plan with the ## Cut row of `line_id` deleted."""
    return "\n".join(ln for ln in text.splitlines() if not re.match(rf"^\*?{line_id}(\s|$)", ln)) + "\n"


RETAKE = ["so then we lean the frame over", "so then we lean the frame over and it tips."]


def test_a_clear_retake_stays_in_cut_labeled_naming_the_take_after_it(tmp_path, monkeypatch):
    d = tc.spoken_project(tmp_path, RETAKE)
    plan, text = plan_of(d, monkeypatch)
    got = rows(text)
    assert [(i, w) for i, w, _ in got] == [("A1", RETAKE[0]), ("A2", RETAKE[1])], text
    tag = got[0][2]
    assert re.match(r"^\d+\.\d (retake|false-start)\? A2 \d+\.\d$", tag), tag
    assert got[1][2] is not None and "?" not in got[1][2]
    assert "\n## Unused" not in text and not re.search(r"^\*", text, re.M), text
    assert plan["labels"] == {tag.split()[1]: 1}


def test_the_unedited_plan_plays_every_saying(tmp_path, monkeypatch):
    d = tc.spoken_project(tmp_path, RETAKE)
    _, text = plan_of(d, monkeypatch)
    applied = apply(d, monkeypatch)
    assert applied["mode"] == "applied" and tc.said_text(d) == " ".join(RETAKE)


def test_deleting_the_labeled_row_takes_the_retake(tmp_path, monkeypatch):
    d = tc.spoken_project(tmp_path, RETAKE)
    _, text = plan_of(d, monkeypatch)
    apply(d, monkeypatch, without(text, "A1"))
    assert tc.said_text(d) == RETAKE[1]


def test_a_phrase_said_again_inside_a_row_is_labeled_with_its_words_and_kept(tmp_path, monkeypatch):
    """A 0.35 s pause (a break, under max-pause): both sayings stay in one row. Before PL89 the first saying was
    removed; now the row keeps it and its tag names the words, which the agent deletes to take it."""
    line = "okay so then you tip the whole frame over | then you tip the whole frame over and it falls."
    d = tc.spoken_project(tmp_path, [line], pause=0.35)
    plan, text = plan_of(d, monkeypatch)
    (rid, words, tag), = rows(text)
    assert words == line.replace(" |", "")
    assert re.match(r'^\d+\.\d repeat\? "then you tip the whole frame over"$', tag), tag
    apply(d, monkeypatch)
    assert tc.said_text(d) == line.replace(" |", "")
    edited = re.sub(r"then you tip the whole frame over (\{[\d.]+\} )?(?=then you tip)", "", text, count=1)
    (tmp_path / "b").mkdir()
    d = tc.spoken_project(tmp_path / "b", [line], pause=0.35)
    plan_of(d, monkeypatch)
    apply(d, monkeypatch, edited)
    assert tc.said_text(d) == "okay so then you tip the whole frame over and it falls."


def test_a_noise_word_goes_with_the_silence_and_put_back_is_noted_never_refused(tmp_path, monkeypatch):
    """test_cut_voice's click with whisper's "it" on it. Its only sound is no voice, which is silence to the cut (layer
    1 and tidy), so it goes with the silence, listed under ## Unused tagged noise. Put back into ## Cut, the apply
    applies (before PL89 it refused: noise_kept) and notes the word."""
    parts = tv.SENT + [(1.70, 1.76, -37.0, "click")] + tv.BACK
    words = tv.SENT_W + [("it", 1.65, 1.80)] + tv.BACK_W
    d = tv.project(tmp_path, monkeypatch, parts, 4.0, words)
    plan, text = plan_of(d, monkeypatch)
    _, unused = tc.sections(text)
    row = next(r for r in unused if r.startswith("A1 it ["))
    assert row.endswith(" noise]") and plan["removed"]["inaudible"] >= 1, text
    head = text.split("\n## Unused", 1)[0]
    back = re.sub(r"^(A1 we went [^\n]*\n)", lambda m: m.group(1) + cc._TAG.sub("", row) + "\n", head, flags=re.M)
    assert back != head
    applied = apply(d, monkeypatch, back)
    assert applied["mode"] == "applied"
    assert any('"it"' in n and "no voice" in n for n in applied.get("notes", [])), applied


def test_the_plan_never_fails_unsettled_it_notes_it(tmp_path, monkeypatch):
    d = tc.spoken_project(tmp_path, RETAKE)
    monkeypatch.setattr(cc, "_played_mismatch", lambda *a, **k: "plays [x] it does not keep")
    monkeypatch.setattr(cc, "_settle", lambda *a, **k: True)
    plan, text = plan_of(d, monkeypatch)
    assert plan["mode"] == "plan" and (d / "cut-plan.md").is_file()
    assert any("plays [x]" in n for n in plan.get("notes", [])) and any("settle" in n for n in plan["notes"]), plan


def test_the_plan_answer_carries_the_plan_text(tmp_path, monkeypatch):
    d = tc.spoken_project(tmp_path, RETAKE)
    plan, text = plan_of(d, monkeypatch)
    assert plan["text"] == text and "cut" not in plan


def test_the_apply_lists_the_seam_where_words_were_skipped(tmp_path, monkeypatch):
    lines = ["hello there my friends.", "it can follow a person.", "it can follow a person now.", "thanks all."]
    d = tc.spoken_project(tmp_path, lines)
    _, text = plan_of(d, monkeypatch)
    applied = apply(d, monkeypatch, without(text, "A2"))
    assert tc.said_text(d) == " ".join(lines[:1] + lines[2:])
    seams = applied["seams"]
    assert len(seams) == 1, seams          # the silences joined between kept sayings are not seams
    m = re.match(r"^(\d+\.\d\d) (.*) \| (.*)$", seams[0])
    assert m and m.group(2) == "there my friends." and m.group(3) == "it can follow", seams
    played = tc.played_words(d)
    at = next(s for w, s, _ in played[3:] if w == "it")
    assert abs(float(m.group(1)) - at) < 0.3, (m.group(1), played)


def test_a_seam_inside_a_word_is_flagged():
    words = {"/a.mov": [("one", 0.0, 0.4), ("two", 0.5, 0.9), ("three", 1.0, 1.4), ("four", 1.5, 1.9),
                        ("five", 2.0, 2.4), ("six", 2.5, 2.9), ("seven", 3.0, 3.4)]}
    items = [{"id": "a", "src": "/a.mov", "start": 0.0, "end": 1.2, "inPoint": 0.0, "outPoint": 1.2},
             {"id": "b", "src": "/a.mov", "start": 1.2, "end": 2.2, "inPoint": 2.5, "outPoint": 3.5}]
    seams = cc._seams(items, words)
    assert seams == ["1.20 one two three | six seven (cuts a word)"], seams
    items[0]["outPoint"] = items[0]["end"] = 1.45
    items[1]["start"], items[1]["end"] = 1.45, 2.45
    assert cc._seams(items, words) == ["1.45 one two three | six seven"]


def test_a_silence_join_is_not_a_seam_and_a_clip_change_is():
    words = {"/a.mov": [("one", 0.0, 0.4), ("two", 0.5, 0.9)], "/b.mov": [("three", 0.0, 0.4)]}
    items = [{"id": "a", "src": "/a.mov", "start": 0.0, "end": 0.45, "inPoint": 0.0, "outPoint": 0.45},
             {"id": "b", "src": "/a.mov", "start": 0.45, "end": 0.9, "inPoint": 0.48, "outPoint": 0.93},
             {"id": "c", "src": "/b.mov", "start": 0.9, "end": 1.35, "inPoint": 0.0, "outPoint": 0.45}]
    assert cc._seams(items, words) == ["0.90 one two | three"]


def test_a_stale_plan_is_still_refused(tmp_path, monkeypatch, capsys):
    d = tc.spoken_project(tmp_path, RETAKE)
    plan_of(d, monkeypatch)
    side = d / "vo0.json"
    t = json.loads(side.read_text())
    t["transcription"][0]["text"] = " changed"
    side.write_text(json.dumps(t))
    assert tc.refused(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch, capsys=capsys) == "stale_plan"


def test_next_says_how_to_pick(tmp_path, monkeypatch):
    d = tc.spoken_project(tmp_path, RETAKE)
    plan, _ = plan_of(d, monkeypatch)
    assert "delete" in plan["next"].lower() and "Unused" not in plan["next"], plan["next"]


def test_v5_checks_still_pass_on_a_labeled_plan(tmp_path, monkeypatch):
    d = tc.spoken_project(tmp_path, RETAKE + ["thanks all."])
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    v5.checked(d, plan, applied, before)



def test_a_bad_seam_after_the_apply_is_fixed_with_speech_edit_keeping_the_persons_edits(tmp_path, monkeypatch):
    """After an apply the project is cut: an edited plan applied on top is refused as stale, and no tool restores a
    version (that is the person's, in Versions). So a bad seam is fixed on the cut project, the way select-takes' step 6
    says: speech_text, move the line back from ## Unused, speech_edit. An edit the person made since the apply stays."""
    from tests.conftest import run_step
    lines = ["hello there my friends.", "it can follow a person.", "it can follow a person now.", "thanks all."]
    d = tc.spoken_project(tmp_path, lines)
    _, text = plan_of(d, monkeypatch)
    apply(d, monkeypatch, without(without(text, "A2"), "A4"))        # A4 deleted by mistake
    assert tc.said_text(d) == " ".join(lines[:1] + lines[2:3])
    p = json.loads((d / "project.json").read_text())
    p["name"] = "Renamed by the person"
    (d / "project.json").write_text(json.dumps(p, indent=2))
    proc = run_step("speech_text.py", "--project", str(d / "project.json"))
    assert proc.returncode == 0, proc.stderr
    st = json.loads(proc.stdout)["text"]
    head, unused = st.split("\n## Unused\n", 1)
    back = next(r for r in unused.splitlines() if r.lstrip("*").startswith("A4 "))
    (d / "speech-text.md").write_text(head.rstrip("\n") + "\n" + back.lstrip("*") + "\n")
    proc = run_step("speech_edit.py", "--project", str(d / "project.json"), "--text", str(d / "speech-text.md"))
    assert proc.returncode == 0, proc.stderr
    assert tc.said_text(d) == " ".join(lines[:1] + lines[2:])
    assert json.loads((d / "project.json").read_text())["name"] == "Renamed by the person"


def test_select_takes_never_tells_the_agent_to_restore_a_version():
    """Review blocker 2: no tool restores a project version, so the skill's plan section never asks the agent to."""
    skill = (tc.REPO_ROOT / "skills" / "select-takes" / "SKILL.md").read_text()
    section = skill.split("## Between a cut plan and its apply", 1)[1].split("\n## ", 1)[0]
    step6 = section.split("\n6. ", 1)[1]
    assert "undo" not in step6 and step6.count("restore") == step6.count("ask the person to restore"), step6
    assert "`speech_edit`" in step6 and "in Versions" in step6
