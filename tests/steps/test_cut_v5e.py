"""§577 cut, ucla clip B: whisper's TIMES fail over a stretch while its TEXT keeps its order (a sentence's words
collapsed to no length, the next sentence stretched over silence, a retake's words standing on the sentence before's
sound). cut finds the broken stretch on layer 1 and transcribes its voiced runs again, one at a time, with the same
whisper call (lib/speech_repair); then placement and the take rules run as ever. Synthetic tones, invented words;
whisper's second run is a stub that hears the script of whatever stretch it is given."""
import json

import pytest

from lib import speech_energy as se
from lib import speech_repair as sr
from lib.speech_lines import Word, load_words
from tests import cut_checks
from tests.steps import test_cut as tc
from tests.steps import test_cut_v5 as v5
import steps.edit.cut as cc

ROOM = -57.0


def said_on(t, toks, dur=0.26, gap=0.04, db=-15.0):
    """[(word, start, end, db)] said from t, and the end."""
    out = []
    for k, w in enumerate(toks):
        out.append((w, round(t, 3), round(t + dur, 3), db))
        t += dur + gap
    return out, t


S1 = "we start the demo now.".split()
S2 = "and then a small box passes those commands on.".split()
S3 = "it can follow you and walk around. the team described this as".split()
S4 = "the team described this as telepresence.".split()


def broken():
    """S1 on its sound; S2 said at 4.0, S3 at 9.0, S4 at 13.2 (each its own voiced run). Whisper: S2's 9 words collapsed
    to no length at 2.40, S3's first 7 stretched 2.40-3.90 over silence, S3's 'the team described this as' (the retake
    of S4) stretched 3.90-8.90 over S2's sound and the silence after it, S4 on its own sound."""
    a, _ = said_on(0.5, S1)
    b, _ = said_on(4.0, S2)
    c, _ = said_on(9.0, S3)
    d, end = said_on(13.2, S4)
    words = [(w, x, round(y + 0.04, 3)) for w, x, y, _ in a]
    words += [(w, 2.40, 2.40) for w in S2]
    words += [(w, round(2.40 + 0.2 * k, 3), round(2.60 + 0.2 * k, 3)) for k, w in enumerate(S3[:7])]
    words += [("the", 3.90, 5.60), ("team", 5.60, 7.20), ("described", 7.20, 8.00), ("this", 8.00, 8.50),
              ("as", 8.50, 8.90)]
    words += [(w, x, round(y + 0.04, 3)) for w, x, y, _ in d]
    script = a + b + c + d
    return script, words, round(end + 0.8, 2)


def whisper_hears(script):
    """A stub of cut's transcribe for the second run: the script's words whose sound lies in the trim spec's one keep,
    on the source's clock (transcribe maps a spec's times back itself), written as whisper writes them."""
    calls = []

    def fake(input_path, out=None, model=None, language="en", **kw):
        spec = json.loads(open(input_path).read())
        keeps = spec["keeps"]
        calls.append([tuple(k) for k in keeps])
        heard = [(w, x, y) for w, x, y, _ in script if any(x >= a - 1e-6 and y <= b + 1e-6 for a, b in keeps)]
        with open(out + ".json", "w") as f:
            json.dump(tc.gapless(heard), f)
        return {"words": out + ".json"}
    return fake, calls


def stubbed(monkeypatch, script):
    fake, calls = whisper_hears(script)
    monkeypatch.setattr(cc, "transcribe_file", fake)

    def checks_run(media, keeps):
        return [(w, x, y) for w, x, y, _ in script if any(x >= a - 1e-6 and y <= b + 1e-6 for a, b in keeps)]
    monkeypatch.setattr(cut_checks, "RETRANSCRIBE", checks_run)
    return calls


@pytest.fixture(autouse=True)
def _fresh_cache(tmp_path, monkeypatch):
    """Each test its own temp folder, so the second run's cache never carries across tests."""
    monkeypatch.setenv("TMPDIR", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    import tempfile
    monkeypatch.setattr(tempfile, "tempdir", None)


def test_a_broken_stretch_is_found_on_layer_1():
    env = [-60.0] * 1500
    for a, b in ((50, 230), (400, 680), (900, 1200)):
        for k in range(a, b):
            env[k] = -15.0
    lay = se.layer1(__file__, env, 0.45)
    ws = [Word(0, "we", "we", 0.5, 0.8)] + [Word(1 + k, "x", "x", 2.4, 2.4) for k in range(4)] + \
        [Word(5, "the", "the", 3.9, 5.6), Word(6, "team.", "team", 9.0, 9.4)]
    found = sr.stretches(ws, lay)
    assert found == [(1, 6, 0.8, 9.0)], found


def test_a_clean_transcript_is_never_transcribed_again(tmp_path, monkeypatch):
    a, end = said_on(0.5, S1 + S2)
    calls = stubbed(monkeypatch, a)
    d = v5.project(tmp_path, monkeypatch, [("vo", [(x, y, db) for _, x, y, db in a], round(end + 0.8, 2),
                                            [(w, x, round(y + 0.04, 3)) for w, x, y, _ in a])], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert calls == [] and said == S1 + S2, (calls, said)


def test_shifted_times_and_collapsed_words_come_back_with_no_word_lost(tmp_path, monkeypatch):
    """ucla B's shape: after the second run every sentence stands on its own sound, so the sure retake removes only
    S3's 'the team described this as' (on its own sound at the end of S3), and S2 plays whole."""
    script, words, end = broken()
    calls = stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", [(x, y, db) for _, x, y, db in script], end, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == S1 + S2 + S3[:7] + S4, (said, text)
    # one whisper run for the window: its two voiced runs and its neighbours' sound (three good words each side)
    assert len(calls) == 1 and calls[0][1:3] == [(3.9, 6.76), (8.9, 12.66)], calls
    tones = {k: (x, y) for k, (_, x, y, _) in enumerate(script)}
    s2 = range(len(S1), len(S1) + len(S2))
    s3_retake = range(len(S1) + len(S2) + 7, len(S1) + len(S2) + len(S3))
    assert all(v5.cover(d, *tones[k]) > 0.99 for k in s2), tc.kept_iv(d)
    assert all(v5.cover(d, tones[k][0] + 0.01, tones[k][1] - 0.01) < 0.02 for k in s3_retake), tc.kept_iv(d)
    assert plan["removed"]["lines"] == {"restart": 1}, (plan["removed"], text)    # S3's tail: a take of S4
    v5.checked(d, plan, applied, before, [("vo", x, y) for _, x, y, _ in script[:len(S1) + len(S2) + 7]]
               + [("vo", x, y) for _, x, y, _ in script[-len(S4):]])


def test_without_the_second_run_the_retake_takes_the_sentence_before(tmp_path, monkeypatch):
    """The red case, kept as the reason: with whisper's second run failing (no model), the stretch stays as written,
    and the retake row stands on S2's sound."""
    script, words, end = broken()
    d = v5.project(tmp_path, monkeypatch, [("vo", [(x, y, db) for _, x, y, db in script], end, words)], room=ROOM)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    s2 = script[len(S1):len(S1) + len(S2)]
    assert not all(v5.cover(d, x, y) > 0.99 for _, x, y, _ in s2), tc.kept_iv(d)


def test_the_apply_reads_the_words_the_plan_read(tmp_path, monkeypatch):
    """The second run's words are cached under the temp folder: the apply, a new process in real use, reads the same
    words without running whisper again, and its plan stamp matches."""
    script, words, end = broken()
    calls = stubbed(monkeypatch, script)
    d = v5.project(tmp_path, monkeypatch, [("vo", [(x, y, db) for _, x, y, db in script], end, words)], room=ROOM)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    n = len(calls)
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert applied["mode"] == "applied" and len(calls) == n, calls
    assert not (d / "vo.json.orig").exists() and sorted(p.name for p in d.iterdir() if p.suffix == ".json") == \
        ["project.json", "vo.json"]


def test_a_made_up_tail_over_the_room_is_never_transcribed_again(tmp_path, monkeypatch):
    """Three words stamped with no length after the last sound, in the room: the window holds no voiced audio, so it
    is left to the tail rule."""
    a, end = said_on(0.5, S1)
    calls = stubbed(monkeypatch, a)
    words = [(w, x, round(y + 0.04, 3)) for w, x, y, _ in a] + [("thank", 3.0, 3.0), ("you", 3.0, 3.0),
                                                                 ("all.", 3.0, 3.0)]
    d = v5.project(tmp_path, monkeypatch, [("vo", [(x, y, db) for _, x, y, db in a], 3.6, words)], room=ROOM)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert calls == [] and said == S1, (calls, said)


def _lay(spans, total=15.0):
    env = [-60.0] * int(total * 100)
    for a, b in spans:
        for k in range(int(a * 100), int(b * 100)):
            env[k] = -15.0
    return se.layer1(__file__, env, 0.45)


def test_the_merge_never_loses_a_word_whisper_wrote():
    """The benchmark run of ucla B: the second run hears another sentence than the stretch's words (whisper's first
    run left that sentence out). Matched words take the new times, new words are added, and every word the first run
    wrote is kept, after the new words of its block, in order."""
    lay = _lay([(0.5, 0.8), (4.0, 6.0), (9.0, 9.4)])
    old = [Word(0, "we", "we", 0.5, 0.8)] + [Word(1 + k, t, t, 2.0, 2.0) for k, t in enumerate(["get", "back", "up"])] + \
        [Word(4, "go.", "go", 9.0, 9.4)]

    def again(media, keeps):
        return [("and", 4.0, 4.4), ("then", 4.5, 4.9), ("back", 5.0, 5.4)]
    out, rep = sr.repair(old, lay, "x.mov", again)
    assert [w.text for w in out] == ["we", "and", "then", "get", "back", "up", "go."], out
    assert [w.idx for w in out] == list(range(7)) and all(x.start <= y.start for x, y in zip(out, out[1:])), out
    assert rep and rep[0]["matched"] == 1 and rep[0]["added"] == 2 and rep[0]["kept"] == 2, rep
    back = next(w for w in out if w.text == "back")
    assert (back.start, back.end) == (5.0, 5.4), back


def test_the_second_run_reads_the_source_clock(tmp_path, monkeypatch):
    """transcribe maps a trim spec's times back to the source itself: the stretch's words come back where they are
    (6f7af80c-era code added the stretch's start again, and dropped every word)."""
    seen = []

    def fake(input_path, out=None, model=None, language="en", **kw):
        spec = json.loads(open(input_path).read())
        seen.append((spec["input"], spec["keeps"], model, language))
        with open(out + ".json", "w") as f:
            json.dump(tc.gapless([("and", 4.0, 4.4), ("then", 4.5, 4.9)]), f)
        return {"words": out + ".json"}
    monkeypatch.setattr(cc, "transcribe_file", fake)
    run = cc._retranscriber("tiny", "en")
    assert run("/m.mov", [(3.9, 5.0)]) == [("and", 4.0, 4.4), ("then", 4.5, 4.9)]
    assert seen == [("/m.mov", [[3.9, 5.0]], "tiny", "en")]


def test_a_second_run_that_fails_is_named_and_changes_nothing(tmp_path, monkeypatch):
    script, words, end = broken()
    d = v5.project(tmp_path, monkeypatch, [("vo", [(x, y, db) for _, x, y, db in script], end, words)], room=ROOM)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    assert any("transcribing it again failed" in w for w in plan.get("warnings", [])), plan.get("warnings")
