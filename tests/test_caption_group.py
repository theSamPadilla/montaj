"""lib/caption_group.group() pinned against the segments the inline code in
steps/lyrics/caption.py produced before the lift (captured by running that
code at the parent commit on this exact word list)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from caption_group import group

# Hand-made words (seconds): a sub-floor word, a run of more than 8 words, a
# gap over 0.4 s, and sub-floor words in the tail.
WORDS = [
    ("Hello", 0, 300), ("world", 300, 320), ("this", 320, 700), ("is", 700, 900),
    ("a", 900, 1000), ("test", 1000, 1400), ("of", 1400, 1500), ("the", 1500, 1600),
    ("grouping", 1600, 2000), ("rule", 2000, 2400), ("after", 3000, 3030),
    ("pause", 3030, 3500), ("x", 3560, 3570), ("end", 3570, 3580),
]


def _w(word, a, b):
    return {"word": word, "start": a / 1000.0, "end": b / 1000.0}


def _seg(text, start, end, words):
    return {"text": text, "start": start, "end": end,
            "words": [{"word": w, "start": s, "end": e} for w, s, e in words]}


EXPECTED = [
    _seg("Hello world this is a test of the", 0.0, 1.6, [
        ("Hello", 0.0, 0.3), ("world", 0.3, 0.35), ("this", 0.35, 0.7), ("is", 0.7, 0.9),
        ("a", 0.9, 1.0), ("test", 1.0, 1.4), ("of", 1.4, 1.5), ("the", 1.5, 1.6)]),
    _seg("grouping rule", 1.6, 2.4, [("grouping", 1.6, 2.0), ("rule", 2.0, 2.4)]),
    _seg("after pause x end", 3.0, 3.62, [
        ("after", 3.0, 3.05), ("pause", 3.05, 3.5), ("x", 3.56, 3.57), ("end", 3.57, 3.62)]),
]


def test_group_matches_pre_lift_segments():
    assert group([_w(*t) for t in WORDS]) == EXPECTED


def test_group_does_not_mutate_input():
    words = [_w(*t) for t in WORDS]
    before = [dict(w) for w in words]
    group(words)
    assert words == before


# Run 5 (52, kung fu run 4): "But then there's this" filled the line and "part." showed alone for 0.05 s, one frame.
def test_a_caption_too_short_to_read_joins_its_sentence():
    words = [_w("But", 21990, 22300), _w("then", 22300, 22500), _w("there's", 22500, 22800), _w("this", 22800, 23170),
             _w("part.", 23170, 23220), _w("Yeah,", 23220, 23400), _w("I", 23400, 23500), _w("don't", 23500, 23700)]
    got = [s["text"] for s in group(words, max_words=4)]
    assert got == ["But then there's this part.", "Yeah, I don't"], got


def test_a_short_caption_opening_a_sentence_joins_the_next():
    words = [_w("Done.", 0, 600), _w("So", 700, 750), _w("we", 750, 1100), _w("built", 1100, 1400),
             _w("it", 1400, 1600), _w("today", 1600, 2000)]
    got = [s["text"] for s in group(words, max_words=1)]
    assert all((s["end"] - s["start"]) >= 0.3 or len(s["words"]) > 1 for s in group(words, max_words=1)), got
    assert got[0] == "Done." and got[1].startswith("So we"), got


def test_a_short_caption_after_a_long_pause_stays_alone():
    words = [_w("Hi", 0, 600), _w("there", 600, 900), _w("ok.", 2000, 2100)]
    assert [s["text"] for s in group(words, max_words=4)] == ["Hi there", "ok."]
