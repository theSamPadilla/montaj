"""PL89i (kung fu): the plan listed words the take split had left off the timeline as `B1 This [earlier]`, with no time,
so the agent grepped five whisper JSONs (6 calls, 18 KB read) to find where each belonged before moving it into ## Cut.
An [earlier] row now carries the timeline time it would play at: just before the next word of its file that plays (or
just after the last one before it)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
import steps.edit.cut as cut  # noqa: E402


def test_an_earlier_row_takes_the_time_of_the_next_word_of_its_file_that_plays():
    spans = [(1.352, 1.45), (1.45, 1.76), (5.0, 5.4)]           # source seconds of B's played words
    at = lambda src, s: 30.95 + (s - 1.352) if 1.352 - 1e-6 <= s <= 5.4 + 1e-6 else None
    assert cut._earlier_at(at, "/w/B.mov", spans, 1.350, 1.352) == 30.95          # "This", said just before "is"
    assert cut._earlier_at(at, "/w/B.mov", spans, 6.0, 6.3) == round(30.95 + 5.4 - 1.352, 3)   # after the last one
    assert cut._earlier_at(at, "/w/B.mov", [], 1.0, 1.2) is None
    # the last played word ends on its item's out point, which maps to no time: placed from its start and length
    edge = lambda src, s: 90.0 + (s - 10.0) if 10.0 - 1e-6 <= s < 12.0 else None
    assert cut._earlier_at(edge, "/w/F.mov", [(10.0, 11.4), (11.4, 12.0)], 12.1, 12.6) == 92.0


def test_earlier_rows_are_not_counted_as_left_in_unused():
    text = "## Cut\n\nB1 is really [32.3]\n\n## Unused\n\nB1 This [30.9 earlier]\nA2 seen. [4.2 inaudible]\n"
    plain, why_left = cut._untagged(text)
    assert why_left == {"inaudible": 1}
    assert "B1 This\n" in plain


# PL89i (2b): once the slow phrases were heard again, the kung fu plan showed "E1 But in In" before "E1 but in all
# seriousness" and "E6 And if you And" before "E6 you move or get scared": restarts right before the full line, with no
# label (the take rules want 3 words or more). A row that opens like the very next row of its clip is a retake of it;
# a row that ends by starting itself over names the words before the restart. Only next to each other.
class _Wd:
    def __init__(self, text):
        self.text, self.norm = text, cut.norm(text)


class _Row:
    def __init__(self, line, text):
        self.line, self.words = line, [_Wd(t) for t in text.split()]


def test_a_row_that_opens_like_the_next_row_of_its_clip_is_its_restart():
    assert cut._restart(_Row("E1", "But in In"), _Row("E1", "but in all seriousness, this is actually")) == ("row", None)
    assert cut._restart(_Row("E6", "And if you And"), _Row("E6", "you move or get scared,")) == ("words", 3)
    # not next to each other, another clip, one word, or the same opening of a different sentence's own full line
    assert cut._restart(_Row("E1", "But in In"), None) is None
    assert cut._restart(_Row("E1", "But in In"), _Row("F1", "but in all")) is None
    assert cut._restart(_Row("E1", "But"), _Row("E1", "but in all")) is None
    assert cut._restart(_Row("D5", "Yeah, I don't think that kid would have been"), _Row("D6", "car was also going like really slow.")) is None
