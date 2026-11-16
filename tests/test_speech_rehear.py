"""PL89i (52's kung fu fix 3): "but in all, but in all seriousness" and "but then there is, but then there is this part"
survived the cut. Whisper wrote each phrase once and held a short word over the second saying ("all" 0.81 s; "then"
0.57 s and "there" 0.70 s), so the plan's text had no repeat to tag. cut now hears a slow phrase's own audio again
and, when that hearing has more words and still holds the phrase's words in order, puts them in the transcript, so
repeat? and retake? fire as for any other repeat. The hearings below are whisper's, measured on the kung fu clips."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import speech_rehear as rh  # noqa: E402


def _entries(words):
    return [{"text": f" {t}", "offsets": {"from": round(a * 1000), "to": round(b * 1000)}, "run": 0} for t, a, b in words]


E1 = [("But", 0.82, 0.96), ("in", 0.96, 1.19), ("all", 1.19, 2.00), ("seriousness,", 2.25, 2.95), ("this", 3.0, 3.2)]
D8 = [("But", 26.36, 26.58), ("then", 26.58, 27.15), ("there", 27.15, 27.85), ("is", 27.85, 28.38), ("this", 28.38, 29.04),
      ("part.", 29.04, 29.73), ("Yeah,", 31.78, 31.86)]
# whisper over each window (source seconds), as heard on IMG_1155 and IMG_1154
HEARD = {
    (0.72, 2.10): [("but", 0.82, 1.10), ("in", 1.10, 1.18), ("all", 1.18, 1.44), ("but", 1.44, 1.79), ("in", 1.79, 2.03), ("all", 2.03, 2.10)],
    (26.26, 29.83): [("But", 26.36, 26.39), ("then", 26.39, 27.03), ("there", 27.03, 27.25), ("is", 27.25, 27.46), ("this", 27.46, 28.73), ("part...", 28.73, 29.83)],
    (27.1, 29.83): [("-", 27.1, 27.2), ("There", 27.2, 27.75), ("is,", 27.75, 28.09), ("but", 28.09, 28.38), ("then", 28.38, 28.63),
                    ("there", 28.63, 29.01), ("is", 29.01, 29.16), ("this", 29.16, 29.48), ("part.", 29.48, 29.83)],
}


def window(start, end):
    key = min(HEARD, key=lambda k: abs(k[0] - start) + abs(k[1] - end))
    assert abs(key[0] - start) < 0.06 and abs(key[1] - end) < 0.06, (start, end)
    return HEARD[key]


def test_a_phrase_with_a_short_word_held_long_is_slow_and_ordinary_speech_is_not():
    assert rh.slow_phrases(_entries(E1)) == [(0, 2)]
    assert rh.slow_phrases(_entries(D8)) == [(0, 5)]
    plain = [("the", 1.0, 1.15), ("robot", 1.15, 1.6), ("dents", 1.6, 2.0), ("a", 2.0, 2.05), ("car.", 2.05, 2.6)]
    assert rh.slow_phrases(_entries(plain)) == []
    paused = [("It's", 0.0, 0.2), ("so", 0.2, 0.4), ("funny,", 0.4, 1.8), ("dude.", 1.85, 2.4)]    # held before its comma
    assert rh.slow_phrases(_entries(paused)) == []


def test_a_cut_hears_the_longest_held_phrases_first(tmp_path):
    side = tmp_path / "IMG_1155.json"
    side.write_text(json.dumps({"transcription": _entries(E1), "montaj": {"by": "runs"}}))
    assert rh.candidates(str(side)) == [(0.81, 0, 2, 1.38)]
    side.write_text(json.dumps({"transcription": _entries(E1)}))
    assert rh.candidates(str(side)) == [], "never a transcript montaj did not make by runs"


def test_the_second_hearing_of_the_phrase_brings_the_repeat_back():
    got = rh.rehear_phrase(window, E1[0:3])
    assert [t for t, _, _ in got] == ["but", "in", "all", "but", "in", "all"]


def test_when_the_whole_phrase_is_heard_once_again_its_held_word_on_is_heard_alone():
    got = rh.rehear_phrase(window, D8[0:6])
    assert [t for t, _, _ in got] == ["But", "then", "There", "is,", "but", "then", "there", "is", "this", "part."]


def test_a_hearing_that_loses_or_changes_the_words_is_never_taken():
    lost = lambda s, e: [("And", s, s + 0.2), ("I'll...", s + 0.2, e)]
    assert rh.rehear_phrase(lost, E1[0:3]) is None
    # a second saying only repeats the phrase's own words: a word whisper made up ("X") is never put in
    made_up = lambda s, e: [("X", s, s + 0.1), ("But", s + 0.1, s + 0.3), ("in", s + 0.3, s + 0.5), ("all", s + 0.5, e)]
    assert rh.rehear_phrase(made_up, E1[0:3]) is None


def test_the_transcript_takes_the_new_words_and_keeps_a_copy(tmp_path):
    src = tmp_path / "IMG_1155.MOV"
    src.write_bytes(b"")
    sidecar = tmp_path / "IMG_1155.json"
    doc = {"transcription": _entries(E1), "montaj": {"input": "file", "offsets": "source", "by": "runs", "runs": [[0.8, 3.2]]}}
    sidecar.write_text(json.dumps(doc))
    out = rh.rehear_file(str(sidecar), str(src), window, budget=rh.Budget())
    assert out == [{"clip": "IMG_1155.MOV", "at": 0.82, "was": "But in all", "heard": "but in all but in all"}]
    words = [e["text"].strip() for e in json.loads(sidecar.read_text())["transcription"]]
    assert words == ["but", "in", "all", "but", "in", "all", "seriousness,", "this"]
    assert (tmp_path / "IMG_1155.full.json").exists(), "the transcript as it was is kept"
    assert rh.rehear_file(str(sidecar), str(src), window, budget=rh.Budget()) == [], "heard once: nothing slow is left"


def test_a_transcript_montaj_did_not_make_by_runs_is_never_rewritten(tmp_path):
    src = tmp_path / "a.mov"
    src.write_bytes(b"")
    sidecar = tmp_path / "a.json"
    sidecar.write_text(json.dumps({"transcription": _entries(E1)}))
    before = sidecar.read_text()
    assert rh.rehear_file(str(sidecar), str(src), window, budget=rh.Budget()) == []
    assert sidecar.read_text() == before


def test_the_budget_bounds_the_hearings():
    b = rh.Budget(phrases=1, seconds=30.0)
    assert b.take(1.3) and not b.take(1.3)
    b = rh.Budget(phrases=6, seconds=2.0)
    assert b.take(1.5) and not b.take(1.0)


# CV (52's root cause, run pl89p): "Here's how it works. Here's how it works." in 2026-10-22 16-46-14.mov was written
# once ("how" 0.81 s). Heard again on the phrase's own window (17.86-20.72), large-v3-turbo still heard it once, as it
# did 0.1 s earlier; base.en heard it twice. The window ends inside "app reads", so base.en's last words differ
# ("The average..."): the hearing is judged on the words that end clear of that edge, the phrase's tail kept.
# Captured with montaj's transcribe on that clip, 2026-10-26 (09).
CV = [("Here's", 17.96, 18.62), ("how", 18.62, 19.43), ("it", 19.43, 19.5), ("works,", 19.5, 20.31), ("the", 20.31, 20.4),
      ("app", 20.4, 20.62)]
CV_TURBO = [("", 17.86, 17.96), ("Here's", 17.96, 18.939), ("how", 18.939, 19.5), ("it", 19.5, 19.8), ("works.", 19.8, 20.72)]
CV_TURBO_EARLY = [("", 17.76, 17.96), ("Here's", 17.96, 18.93), ("how", 18.93, 19.5), ("it", 19.5, 19.78), ("works:", 19.78, 20.71),
                  ("the", 20.71, 20.71), ("average", 20.71, 20.72)]
CV_BASE_EN = [("", 17.86, 17.96), ("Here's", 17.96, 18.63), ("how", 18.63, 18.97), ("it", 18.97, 19.5), ("works.", 19.5, 19.93),
              ("Here's", 19.93, 20.05), ("how", 20.05, 20.14), ("it", 20.14, 20.169), ("works.", 20.169, 20.36),
              ("The", 20.36, 20.46), ("average...", 20.46, 20.72)]


def test_a_fused_repeat_one_hearing_misses_is_heard_by_the_earlier_window_or_the_second_model():
    tried = []

    def turbo(start, end):
        tried.append(("turbo", round(start, 2)))
        return CV_TURBO_EARLY if start < 17.8 else CV_TURBO

    def base_en(start, end):
        tried.append(("base.en", round(start, 2)))
        return CV_BASE_EN
    got = rh.rehear_phrase(turbo, CV, alt=base_en)
    text = " ".join(t for t, _, _ in got)
    assert text.count("Here's how it works") == 2, text
    assert text.lower().endswith("the app"), "the phrase's own tail, past the window's edge, is kept"
    assert tried == [("turbo", 17.86), ("turbo", 18.57), ("turbo", 17.76), ("base.en", 17.86)]   # whole, held word on, earlier, base.en
    assert all(b >= a for (_, a, _), (_, b, _) in zip(got, got[1:])), "in time order"


def test_a_stretch_said_at_under_half_the_clips_rate_is_heard_again_with_no_held_word():
    # 12 words at 3.6 a second, then 4 at 1.8 a second, no word held 0.5 s
    fast = [(f"w{i}", round(i / 3.6, 3), round(i / 3.6 + 0.25, 3)) for i in range(12)]
    slow = [(t, round(4 + k * 0.6, 3), round(4 + k * 0.6 + 0.45, 3)) for k, t in enumerate(["here's", "how", "it", "works"])]
    phrases = rh.slow_phrases(_entries(fast + slow))
    assert (12, 15) in phrases, phrases
    assert (0, 11) not in phrases


# 1.5.0 (pl89r: the app ships large-v3-turbo only, so no base.en; turbo collapsed the repeat on the phrase's window and
# 0.1 s earlier). Ended at the next whole words after the phrase (through "laptop's", 21.38 + 0.1), turbo hears it twice
# from 17.80, 17.86 and 17.90 alike. Captured on 2026-10-22 16-46-14.mov, 2026-10-26 (09).
CV_TURBO_TO_PAUSE = [("", 17.86, 17.96), ("Here's", 17.96, 18.34), ("how", 18.34, 18.57), ("it", 18.57, 18.8), ("works.", 18.8, 19.419),
                     ("Here's", 19.419, 19.669), ("how", 19.669, 19.8), ("it", 19.8, 19.88), ("works.", 19.88, 20.259),
                     ("The", 20.259, 20.439), ("app", 20.439, 20.619), ("reads", 20.619, 20.91), ("my", 20.91, 21.02),
                     ("laptops", 21.02, 21.48), ("away.", 21.48, 21.48)]


def test_the_first_retry_ends_at_the_next_whole_words_and_one_model_hears_the_repeat():
    tried = []

    def turbo(start, end):
        tried.append((round(start, 2), round(end, 2)))
        return CV_TURBO_TO_PAUSE if end > 21 else CV_TURBO
    got = rh.rehear_phrase(turbo, CV, until=21.38)
    text = " ".join(t for t, _, _ in got)
    assert text.count("Here's how it works") == 2, text
    assert text.lower().endswith("the app") and "reads" not in text, "judged up to the phrase's own end"
    assert tried[-1] == (17.86, 21.48), tried


def test_until_is_the_end_of_the_words_within_a_second_after_the_phrase():
    words = CV + [("reads", 20.62, 20.84), ("my", 20.84, 20.95), ("laptop's", 20.95, 21.38), ("webcam", 21.38, 21.76)]
    assert rh.until_after(words, len(CV) - 1) == 21.38
    assert rh.until_after(words, len(words) - 1) is None


# §596 (Sam, 2026-10-27): the second listen is tiny.en q5_1 (32 MB; on the known collapsed repeats it hears what base.en
# does). Only in English, and only when its weight is installed: a missing model would fall back to turbo, the very
# hearing that collapsed the repeat, at the cost of another pass.
def test_the_second_listen_is_the_small_english_model_when_installed(monkeypatch):
    import steps.edit.cut as cc
    have = {"tiny.en-q5_1"}
    monkeypatch.setattr(cc, "whisper_weight_path", lambda name: f"/m/ggml-{name}.bin" if name in have else None)
    assert cc.REHEAR_ALT_MODEL == "tiny.en-q5_1"
    assert cc._second_listen("en", "large-v3-turbo-q5_0") == "tiny.en-q5_1"
    assert cc._second_listen("en-US", "large-v3-turbo-q5_0") == "tiny.en-q5_1"
    assert cc._second_listen("es", "large-v3-turbo-q5_0") is None
    assert cc._second_listen("en", "tiny.en-q5_1") is None, "never the same model twice"
    have.clear()
    assert cc._second_listen("en", "large-v3-turbo-q5_0") is None, "not installed: no second pass at all"


# §739 (the Camera video, 2026-11-15): on a generated voice cut's re-hearing wrote "that that", "salt, salt" and
# "buckets into buckets into" with overlapping times, and the captions read the same transcript. A generated voice
# reads on with no pauses, so a run is one long gapless phrase and the hearing takes the words around its held word
# only; its window, padded into the words beside it, heard them too, and a word heard there whose text is one of the
# phrase's own passed as a second saying. Only the phrase's entries were replaced, so the word beside it stayed:
# doubled, on one sound. The voice below is generated-voice-like (gapless, one word every 0.22 s, one word holding a
# breath) and `hear` is a FAITHFUL hearing: it writes every word whose sound the window reaches, a cut piece of one
# included, timed inside the window. A faithful hearing of a phrase said once must never add a word.
def _voice(text, start=20.0, step=0.22, held=(), hold=0.62):
    out, t = [], start
    for k, w in enumerate(text.split()):
        d = hold if k in held else step
        out.append((w, round(t, 3), round(t + d, 3)))
        t += d
    return out


def _hear(truth):
    return lambda s, e: [(w, max(a, s), min(b, e)) for w, a, b in truth if b > s + 0.02 and a < e - 0.02]


def _rewrite(tmp_path, words, hear):
    src, sidecar = tmp_path / "vo.wav", tmp_path / "vo.json"
    src.write_bytes(b"")
    sidecar.write_text(json.dumps({"transcription": _entries(words), "montaj": {"by": "runs"}}))
    out = rh.rehear_file(str(sidecar), str(src), hear, budget=rh.Budget())
    got = [(e["text"].strip(), e["offsets"]["from"] / 1000, e["offsets"]["to"] / 1000)
           for e in json.loads(sidecar.read_text())["transcription"]]
    return out, got


def _no_overlap(words):
    return all(b[1] >= a[2] - 1e-6 for a, b in zip(words, words[1:]))


# "lands" holds a breath; the phrase heard is "light ... and", and the word before it is "that", one of its own
VO_BEFORE = "so the lens bends it and that light from that lamp lands on that film and we see it upside down now"


def test_a_word_beside_the_phrase_is_never_heard_as_its_second_saying(tmp_path):
    words = _voice(VO_BEFORE, held={11})
    assert rh.slow_phrases(_entries(words)) == [(7, 15)]
    out, got = _rewrite(tmp_path, words, _hear(words))
    assert out == [], out
    assert [w for w, _, _ in got] == VO_BEFORE.split(), "no word doubled"
    assert _no_overlap(got)


# one run of its own (a pause each side): only the held try's window, which starts HELD_PAD_S before the held word,
# reaches a word that is not the phrase's held one, the word before it, "salt"
def test_the_held_words_try_never_takes_the_word_before_it_again():
    words = _voice("then you pour the salt into a bowl", held={5})
    assert rh.slow_phrases(_entries(words)) == [(0, 7)]
    assert rh.rehear_phrase(_hear(words), words) is None


# the four words after the phrase ("water from the buckets", 0.88 s, then a pause) are all its own, and the run-on try
# reaches them
VO_AFTER = "so we pour the water from the buckets into the tank and the water from the buckets goes down"


def test_the_words_after_the_phrase_are_never_taken_as_its_second_saying():
    words = _voice(VO_AFTER, held={8})
    words = words[:17] + [(w, round(a + 0.3, 3), round(b + 0.3, 3)) for w, a, b in words[17:]]
    i, j = rh.slow_phrases(_entries(words))[0]
    assert (i, j) == (4, 12)
    phrase, until = words[i:j + 1], rh.until_after(words, j)
    assert until == words[16][2], "it runs on through 'buckets'"
    run_on = rh._clean(_hear(words)(phrase[0][1], until + rh.PAD_S))
    assert rh._better(phrase, run_on), "judged whole, the run-on hearing would pass"
    assert rh.rehear_phrase(_hear(words), phrase, until=until, before=words[i - 1][2], after=words[j + 1][1]) is None


def test_a_hearing_whose_added_words_overlap_in_time_is_not_a_second_saying():
    words = _voice("we add the salt then stir it in", held={3})
    phrase = words[:8]
    a, b = phrase[3][1], phrase[3][2]
    # whisper invents a repeat on one sound: "salt, salt" at overlapping times
    invented = phrase[:3] + [("salt,", a, b), ("salt", a + 0.1, b)] + phrase[4:]
    assert rh.rehear_phrase(lambda s, e: invented, phrase) is None


def test_a_second_saying_a_generated_voice_really_said_is_still_heard(tmp_path):
    # the transcript holds "into" over a real second saying of "buckets into"; the voice said it twice
    said = _voice("pour the water from the buckets into buckets into the tank now")
    words = said[:6] + [("into", said[6][1], said[8][2])] + said[9:]
    out, got = _rewrite(tmp_path, words, _hear(said))
    assert [w for w, _, _ in got] == [w for w, _, _ in said], got
    assert _no_overlap(got)
