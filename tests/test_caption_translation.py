"""lib/caption_translation.py: translated caption rows (phrase-aligned), and
keeping them through caption regeneration."""
import copy
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from caption_translation import (  # noqa: E402
    TranslationError,
    apply_translation,
    finish_regenerated_track,
    merge_caption_theme,
    mint_ids,
)


def W(word, start, end):
    return {"word": word, "start": start, "end": end}


def seg(words, **extra):
    return {"text": " ".join(w["word"] for w in words), "start": words[0]["start"], "end": words[-1]["end"], "words": words, **extra}


# The grouper's real shape: 8-word segments that break mid-sentence.
WORDS_A = [W("So", 0.0, 0.1), W("just", 0.1, 0.4), W("to", 0.4, 0.5), W("give", 0.5, 0.7), W("you", 0.7, 0.9),
           W("an", 0.9, 1.0), W("example,", 1.0, 1.5), W("you", 1.5, 1.6)]
WORDS_B = [W("can't", 1.6, 1.8), W("develop", 1.8, 2.9), W("wheels.", 2.9, 4.0)]


def captions():
    return {"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B)]}


PHRASES = [
    {"source": "So just to give you an example,", "text": "Por ejemplo,"},
    {"source": "you can't develop wheels.", "text": "no se pueden desarrollar ruedas."},
]


def row(caps, lane):
    return [s for s in caps["segments"] if (s.get("lane") or 0) == lane]


def test_mint_ids_follows_the_editor_backfill_scheme():
    out = mint_ids([{"id": "cap-1"}, {}, {}, {"id": "x"}])
    assert [s["id"] for s in out] == ["cap-1", "cap-0", "cap-2", "x"]
    assert [s["id"] for s in mint_ids([{}], taken={"cap-0"})] == ["cap-1"]


def test_phrase_aligned_recut_keeps_real_word_timings_and_pairs_each_line():
    before = captions()
    snapshot = copy.deepcopy(before)
    out = apply_translation(before, "es", PHRASES)
    assert before == snapshot, "never mutates its input"

    src, es = row(out, 0), row(out, 1)
    assert [s["text"] for s in src] == ["So just to give you an example,", "you can't develop wheels."]
    assert [(s["start"], s["end"]) for s in src] == [(0.0, 1.5), (1.5, 4.0)]
    assert src[1]["words"][0] == W("you", 1.5, 1.6), "the word keeps its own timing"
    assert [s["text"] for s in es] == ["Por ejemplo,", "no se pueden desarrollar ruedas."]
    for s, t in zip(src, es):
        assert (t["start"], t["end"]) == (s["start"], s["end"])
        assert t["translationOf"] == [s["id"]] and t["lang"] == "es" and t["lane"] == 1
        assert "words" not in t
    ids = [s["id"] for s in out["segments"]]
    assert len(ids) == len(set(ids)) == 4


def test_a_new_phrase_id_never_reuses_an_old_caption_id():
    caps = captions()
    caps["segments"][0]["id"] = "cap-0"
    caps["segments"][1]["id"] = "cap-1"
    # Phrase 2 starts inside cap-0 (its last word "you"), which phrase 1 keeps;
    # cap-1 is freed by the re-cut but must not be handed to phrase 2.
    out = apply_translation(caps, "es", PHRASES)
    assert [s["id"] for s in row(out, 0)] == ["cap-0", "cap-2"]


def test_matching_ignores_case_and_punctuation():
    phrases = [{"source": "so JUST to give you an example", "text": "a"}, {"source": "you cant develop wheels", "text": "b"}]
    assert len(row(apply_translation(captions(), "es", phrases), 1)) == 2


@pytest.mark.parametrize("phrases,code", [
    ([{"source": "So just to give you a sample,", "text": "x"}], "phrase_mismatch"),
    ([{"source": "So just to give you an example,", "text": "x"}], "incomplete"),
    ([{"source": "So", "text": "x" * 91}], "text_too_long"),
    ([{"source": "So", "text": "  "}], "bad_phrases"),
    ([{"text": "x"}], "bad_phrases"),
])
def test_refusals_name_the_problem(phrases, code):
    with pytest.raises(TranslationError) as e:
        apply_translation(captions(), "es", phrases)
    assert e.value.code == code


def test_a_phrase_over_14_words_is_refused():
    words = [W(f"w{i}", i, i + 0.5) for i in range(15)]
    with pytest.raises(TranslationError) as e:
        apply_translation({"style": "pop", "segments": [seg(words[:8]), seg(words[8:])]}, "es",
                          [{"source": " ".join(w["word"] for w in words), "text": "x"}])
    assert e.value.code == "phrase_too_long"


def test_mismatch_message_names_the_phrase_and_what_the_captions_say():
    with pytest.raises(TranslationError) as e:
        apply_translation(captions(), "es", [PHRASES[0], {"source": "you cannot develop wheels.", "text": "x"}])
    assert "Phrase 2" in e.value.message and "can't" in e.value.message


@pytest.mark.parametrize("lang", ["", "spanish", "e", "es_ES", 5])
def test_bad_lang(lang):
    with pytest.raises(TranslationError) as e:
        apply_translation(captions(), lang, PHRASES)
    assert e.value.code == "bad_lang"


def test_no_captions_and_no_word_timings():
    for caps in (None, {"style": "pop", "segments": []}):
        with pytest.raises(TranslationError) as e:
            apply_translation(caps, "es", PHRASES)
        assert e.value.code == "no_captions"
    caps = captions()
    del caps["segments"][1]["words"]
    with pytest.raises(TranslationError) as e:
        apply_translation(caps, "es", PHRASES)
    assert e.value.code == "no_word_timings"


def test_same_language_replaces_and_no_phrases_removes():
    once = apply_translation(captions(), "es", PHRASES)
    again = apply_translation(once, "es", [dict(p, text=p["text"].upper()) for p in PHRASES])
    assert [s["text"] for s in row(again, 1)] == ["POR EJEMPLO,", "NO SE PUEDEN DESARROLLAR RUEDAS."]
    assert row(again, 2) == []
    removed = apply_translation(again, "es", [])
    assert row(removed, 1) == [] and len(row(removed, 0)) == 2


def test_a_second_language_uses_the_same_lines_and_stacks_next():
    es = apply_translation(captions(), "es", PHRASES)
    fr = apply_translation(es, "fr", [{"source": p["source"], "text": "fr " + p["text"]} for p in PHRASES])
    assert [s["lang"] for s in row(fr, 1)] == ["es", "es"] and [s["lang"] for s in row(fr, 2)] == ["fr", "fr"]
    assert [t["translationOf"] for t in row(fr, 2)] == [t["translationOf"] for t in row(fr, 1)]
    with pytest.raises(TranslationError) as e:
        apply_translation(es, "fr", [{"source": "So just to give you", "text": "a"},
                                     {"source": "an example, you can't develop wheels.", "text": "b"}])
    assert e.value.code == "phrases_differ"
    # Removing the first language frees the second's lane.
    assert {s["lang"] for s in row(apply_translation(fr, "es", []), 1)} == {"fr"}


def test_source_styling_is_carried_and_other_hand_rows_are_kept():
    caps = captions()
    caps["segments"][0].update(id="cap-7", color="#ff0000", offsetY=-5)
    caps["segments"].append({"id": "note", "text": "hand row", "start": 0.0, "end": 1.0, "lane": 1})
    out = apply_translation(caps, "es", PHRASES)
    first = row(out, 0)[0]
    assert first["id"] == "cap-7" and first["color"] == "#ff0000" and first["offsetY"] == -5
    assert [s["id"] for s in row(out, 1)] == ["note"], "a hand-made row keeps its lane"
    assert {s["lang"] for s in row(out, 2)} == {"es"}


def test_merge_caption_theme_carries_every_key_but_style_and_segments():
    prev = {"style": "pop", "segments": [1], "fontFamily": "Inter", "googleFonts": ["Inter"], "fontWeight": 700,
            "highlightColor": "#fff", "position": "top", "color": "#000"}
    track = merge_caption_theme(prev, {"style": "clean", "segments": [], "color": "#111"})
    assert track == {"style": "clean", "segments": [], "color": "#111", "fontFamily": "Inter",
                     "googleFonts": ["Inter"], "fontWeight": 700, "highlightColor": "#fff", "position": "top"}


def test_regeneration_without_translations_mints_ids_and_drops_hand_rows():
    prev = {"style": "pop", "segments": [{"text": "hand", "start": 0, "end": 1, "lane": 1}]}
    track = finish_regenerated_track(prev, {"style": "pop", "segments": [seg(WORDS_A), seg(WORDS_B)]})
    assert [s["id"] for s in track["segments"]] == ["cap-0", "cap-1"]
    assert all("lane" not in s for s in track["segments"])


def test_regeneration_keeps_translations_recut_and_relinked():
    prev = apply_translation(captions(), "es", PHRASES)
    # A fresh transcript: same words, the grouper's mid-sentence cut again,
    # word times nudged a little.
    fresh = {"style": "subtitle", "segments": [
        seg([dict(w, start=w["start"] + 0.02, end=w["end"] + 0.02) for w in WORDS_A]),
        seg([dict(w, start=w["start"] + 0.02, end=w["end"] + 0.02) for w in WORDS_B]),
    ]}
    track = finish_regenerated_track(prev, fresh)
    src, es = row(track, 0), row(track, 1)
    assert [s["text"] for s in src] == ["So just to give you an example,", "you can't develop wheels."]
    assert [s["text"] for s in es] == ["Por ejemplo,", "no se pueden desarrollar ruedas."]
    for s, t in zip(src, es):
        assert (t["start"], t["end"]) == (s["start"], s["end"]) and t["translationOf"] == [s["id"]]
    ids = [s["id"] for s in track["segments"]]
    assert len(ids) == len(set(ids))


def _shift(words, dt):
    return [dict(w, start=round(w["start"] + dt, 3), end=round(w["end"] + dt, 3)) for w in words]


def test_regeneration_after_footage_is_added_keeps_new_words_in_normal_captions():
    prev = apply_translation(captions(), "es", PHRASES)
    extra = [W(f"more{i}", 5 + i * 0.3, 5.2 + i * 0.3) for i in range(20)]
    fresh = {"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B), seg(extra[:8]), seg(extra[8:16]), seg(extra[16:])]}
    track = finish_regenerated_track(prev, fresh)
    src = row(track, 0)
    assert [s["text"] for s in src[:2]] == ["So just to give you an example,", "you can't develop wheels."]
    assert [len(s["words"]) for s in src[2:]] == [8, 8, 4], "the added words keep the fresh grouping"
    assert len(row(track, 1)) == 2


def test_regeneration_relinks_by_words_when_the_audio_moved():
    prev = apply_translation(captions(), "es", PHRASES)
    intro = [W("Hey", 0.0, 0.4), W("everyone.", 0.4, 1.0)]
    fresh = {"style": "subtitle", "segments": [seg(intro), seg(_shift(WORDS_A, 3)), seg(_shift(WORDS_B, 3))]}
    track = finish_regenerated_track(prev, fresh)
    src = {s["id"]: s for s in row(track, 0)}
    es = row(track, 1)
    assert [src[t["translationOf"][0]]["text"] for t in es] == ["So just to give you an example,", "you can't develop wheels."]
    assert [(t["start"], t["end"]) for t in es] == [(3.0, 4.5), (4.5, 7.0)]
    assert row(track, 0)[0]["text"] == "Hey everyone."


def test_regeneration_drops_the_translation_of_a_phrase_no_longer_said():
    prev = apply_translation(captions(), "es", PHRASES)
    other = [W("Something", 0.0, 0.5), W("else", 0.5, 0.9), W("entirely", 0.9, 1.4)]
    fresh = {"style": "subtitle", "segments": [seg(other), seg(WORDS_B)]}
    track = finish_regenerated_track(prev, fresh)
    assert [t["text"] for t in row(track, 1)] == ["no se pueden desarrollar ruedas."]


def test_replacing_a_language_keeps_its_place_in_the_stack():
    es = apply_translation(captions(), "es", PHRASES)
    de = apply_translation(es, "de", [{"source": p["source"], "text": "de"} for p in PHRASES])
    again = apply_translation(de, "es", [{"source": p["source"], "text": "otra vez"} for p in PHRASES])
    assert {s["lang"] for s in row(again, 1)} == {"es"} and {s["lang"] for s in row(again, 2)} == {"de"}


def test_a_translation_id_never_reuses_an_absorbed_source_id():
    caps = captions()
    caps["segments"][0]["id"], caps["segments"][1]["id"] = "cap-0", "cap-1"
    whole = [{"source": "So just to give you an example, you can't develop wheels.", "text": "todo"}]
    out = apply_translation(caps, "es", whole)
    assert row(out, 0)[0]["id"] == "cap-0"
    assert row(out, 1)[0]["id"] not in {"cap-0", "cap-1"}


def test_a_trailing_dash_stays_with_its_phrase():
    words = [W("Wait", 0.0, 0.3), W("\u2014", 0.3, 0.35), W("what?", 0.4, 0.8)]
    out = apply_translation({"style": "pop", "segments": [seg(words)]}, "es",
                            [{"source": "Wait", "text": "Espera"}, {"source": "what?", "text": "¿qué?"}])
    assert [s["text"] for s in row(out, 0)] == ["Wait \u2014", "what?"]


def test_matching_normalizes_unicode():
    words = [W("caf\u00e9", 0.0, 0.5)]
    out = apply_translation({"style": "pop", "segments": [seg(words)]}, "es", [{"source": "cafe\u0301", "text": "café"}])
    assert len(row(out, 1)) == 1

