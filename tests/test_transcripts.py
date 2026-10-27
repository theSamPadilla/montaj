"""One transcript read (PL89 run 5, Sam 2026-10-26): `transcripts` replaces the four ways an agent read transcripts
(read_file's summary, read_file raw, speech-text.md, words_at_time). Run 4 hunted a line's words with Glob, Grep and
Read on an .srt (calls 13-15). Lines carry the ids cut's plan and the brief use (A1, D7...), refined on silences; scope
is a source (or several), all of them, or what plays on the timeline now in timeline seconds; text, or words."""
import importlib.util
import json
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import transcripts as tr  # noqa: E402

STEP_PY = ROOT / "steps" / "speech" / "transcripts.py"


def _sidecar(path, phrases):
    """A whisper sidecar: `phrases` = [(start s, text)], words 0.3 s apart."""
    rows = []
    for start, text in phrases:
        t = start
        for w in text.split():
            rows.append({"text": f" {w}", "offsets": {"from": int(t * 1000), "to": int((t + 0.25) * 1000)}})
            t += 0.3
    path.write_text(json.dumps({"transcription": rows}))


@pytest.fixture
def proj(tmp_path):
    d = tmp_path / "Montaj" / "kungfu"
    d.mkdir(parents=True)
    _sidecar(d / "talk.json", [(0.0, "this may be the funniest demo i've ever seen."),
                               (4.0, "this may be the funniest demo i've ever seen.")])
    _sidecar(d / "close.json", [(1.0, "they need to learn how much force to use.")])
    p = {"id": str(uuid.uuid4()), "name": "Kung Fu", "status": "draft",
         "sources": [{"id": "clip-0", "type": "video", "src": str(d / "talk.mov"), "sourceDuration": 8.0},
                     {"id": "clip-1", "type": "video", "src": str(d / "demo.mov"), "sourceDuration": 74.7},
                     {"id": "clip-2", "type": "video", "src": str(d / "close.mov"), "sourceDuration": 5.0}],
         "tracks": [{"id": "trk-0", "items": [
             {"id": "take-a", "type": "video", "src": str(d / "talk.mov"), "start": 10.0, "end": 12.7, "inPoint": 4.0, "outPoint": 6.7},
             {"id": "take-b", "type": "video", "src": str(d / "close.mov"), "start": 12.7, "end": 15.5, "inPoint": 1.0, "outPoint": 3.8}]},
                    {"id": "trk-1", "items": [
             {"id": "broll", "type": "video", "src": str(d / "talk.mov"), "start": 0.0, "end": 2.0, "inPoint": 0.0, "outPoint": 2.0, "muted": True}]}]}
    (d / "project.json").write_text(json.dumps(p))
    return p, d


def _quiet(calls):
    return lambda path: calls.append(path) or []


def test_talking_heads_are_lettered_with_lines_refined_and_b_roll_left_out(proj):
    p, d = proj
    heads = tr.talking_heads(p, str(d), silences_fn=_quiet([]))
    assert [(s["id"], letter) for s, letter, _ in heads] == [("clip-0", "A"), ("clip-2", "B")]
    lines = heads[0][2]
    assert [ln.id for ln in lines] == ["A1", "A2"]
    assert (round(lines[1].words[0].start, 2), lines[1].words[-1].text) == (4.0, "seen.")


def test_a_second_read_is_cached_and_a_changed_transcript_is_read_again(proj):
    p, d = proj
    calls = []
    tr.talking_heads(p, str(d), silences_fn=_quiet(calls))
    tr.talking_heads(p, str(d), silences_fn=_quiet(calls))
    assert len(calls) == 2, "measured once per source"
    _sidecar(d / "close.json", [(1.0, "they need to learn how much force to use, and when.")])
    heads = tr.talking_heads(p, str(d), silences_fn=_quiet(calls))
    assert len(calls) == 3 and heads[1][2][0].words[-1].text == "when."


def test_on_the_timeline_each_item_plays_its_lines_in_timeline_seconds(proj):
    p, d = proj
    heads = tr.talking_heads(p, str(d), silences_fn=_quiet([]))
    got = tr.on_timeline(p, str(d), heads)
    assert [(x["item"], x["track"], x["lines"]) for x in got] == [("take-a", "trk-0", ["A2"]), ("take-b", "trk-0", ["B1"])]
    a = got[0]
    assert (round(a["start"], 2), round(a["end"], 2)) == (10.0, 12.7)
    assert a["words"][0] == ["this", 10.0, 10.25] and a["words"][-1][0] == "seen."
    # a muted item plays no words: the b-roll on trk-1 is left out


def _step(monkeypatch, capsys, d, *argv):
    spec = importlib.util.spec_from_file_location("transcripts_step", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(tr, "_silences", lambda path: [])
    monkeypatch.setattr(sys, "argv", ["transcripts.py", "--project", str(d), *argv])
    mod.main()
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_the_step_answers_every_source_as_text_by_default(proj, monkeypatch, capsys):
    p, d = proj
    out = _step(monkeypatch, capsys, d)
    text = out["text"]
    assert "**A = talk.mov** (clip-0)" in text and "**B = close.mov** (clip-2)" in text
    assert "- A1 0.0-2.6 this may be the funniest demo i've ever seen." in text, text
    assert "- A2 4.0-6.6 this may be the funniest demo i've ever seen." in text
    assert "demo.mov" in text and "no speech" in text.lower(), "the b-roll is named, so its absence is not a gap"


def test_the_step_takes_a_source_by_id_or_letter(proj, monkeypatch, capsys):
    p, d = proj
    by_id = _step(monkeypatch, capsys, d, "--scope", "clip-2")["text"]
    assert "**B = close.mov**" in by_id and "talk.mov" not in by_id
    by_letter = _step(monkeypatch, capsys, d, "--scope", "A")["text"]
    assert "**A = talk.mov**" in by_letter and "close.mov" not in by_letter
    both = _step(monkeypatch, capsys, d, "--scope", "A,clip-2")["text"]
    assert "talk.mov" in both and "close.mov" in both


def test_an_unknown_source_names_the_ones_there_are(proj, monkeypatch, capsys):
    p, d = proj
    with pytest.raises(SystemExit):
        _step(monkeypatch, capsys, d, "--scope", "clip-7")
    err = capsys.readouterr()
    assert "clip-7" in (err.err + err.out) and "A = clip-0" in (err.err + err.out)


def test_the_step_answers_the_timeline_in_timeline_seconds(proj, monkeypatch, capsys):
    p, d = proj
    text = _step(monkeypatch, capsys, d, "--scope", "timeline")["text"]
    assert "- 10.0-12.7 take-a (A2, trk-0): this may be the funniest demo i've ever seen." in text, text
    assert "take-b (B1, trk-0)" in text and "broll" not in text


def test_words_gives_each_word_with_its_times(proj, monkeypatch, capsys):
    p, d = proj
    out = _step(monkeypatch, capsys, d, "--scope", "A", "--words")
    assert out["lines"]["A1"][0] == ["this", 0.0, 0.25]
    tl = _step(monkeypatch, capsys, d, "--scope", "timeline", "--words")
    assert tl["items"][0]["item"] == "take-a" and tl["items"][0]["words"][0] == ["this", 10.0, 10.25]
