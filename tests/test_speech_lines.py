import json
import os

from lib.speech_lines import (LINE_BREAK_PAUSE_S, LINE_MAX_WORDS, SHOW_PAUSE_S, Word, load_words, norm,
                              refine, sidecar_for, split_lines, uncertain_gaps)
from lib.speech_pauses import silences

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "speech_text")


def W(i, text, a, b):
    return Word(i, text, norm(text), a, b)


def test_norm():
    assert norm("Don't,") == "don't"
    assert norm('"Hello."') == "hello"
    assert norm("...") == ""


def test_load_words_offsets_only(tmp_path):
    p = tmp_path / "a.json"
    p.write_text(json.dumps({"transcription": [
        {"timestamps": {"from": "99:99:99,999", "to": "99:99:99,999"}, "offsets": {"from": 0, "to": 0}, "text": ""},
        {"timestamps": {"from": "x", "to": "y"}, "offsets": {"from": 150, "to": 610}, "text": " Hello,"},
    ]}))
    ws = load_words(str(p))
    assert len(ws) == 1
    assert (ws[0].idx, ws[0].text, ws[0].norm, ws[0].start, ws[0].end) == (0, "Hello,", "hello", 0.15, 0.61)


def test_refine_pause_at_word_edges():
    ws = [W(0, "a", 0.0, 1.0), W(1, "b", 1.0, 2.0)]
    out, st = refine(ws, [(0.0, 0.4), (1.7, 2.0)])
    assert (out[0].start, out[0].end) == (0.4, 1.0)
    assert (out[1].start, out[1].end) == (1.0, 1.7)
    assert st["inside"] == 0 and st["inside_words"] == []


def test_refine_boundary_before_pause_beyond_old_tolerance():
    # whisper's boundary sits 0.05 s before a 0.3 s pause: the pause start is 0.05 inside the word
    ws = [W(0, "a", 0.0, 1.0), W(1, "b", 1.0, 2.0)]
    out, _ = refine(ws, [(0.95, 1.25)])
    assert out[0].end == 0.95 and out[1].start == 1.25


def test_refine_short_interior_silence_is_a_closure():
    ws = [W(0, "a", 0.0, 1.0)]
    out, st = refine(ws, [(0.4, 0.5)])
    assert out == ws and st["attached"] == 0 and st["orphan"] == 0


def test_refine_long_interior_pause_keeps_longest_segment_and_attaches_leftover():
    # pause 0.3-0.5 inside word b: main = 0.5-1.0 (longer); leftover 0.0-0.3 is contiguous with a's end
    ws = [W(0, "a", -1.0, 0.0), W(1, "b", 0.0, 1.0)]
    out, st = refine(ws, [(0.3, 0.5)])
    assert (out[1].start, out[1].end) == (0.5, 1.0)
    assert out[0].end == 0.3
    assert st["attached"] == 1 and st["orphan"] == 0


def test_refine_leftover_with_no_contiguous_neighbour_is_orphan():
    ws = [W(0, "a", -1.0, -0.5), W(1, "b", 0.0, 1.0)]
    out, st = refine(ws, [(0.3, 0.5)])
    assert (out[1].start, out[1].end) == (0.5, 1.0)
    assert out[0] == ws[0]
    assert st["orphan"] == 1


def test_refine_word_inside_pause_keeps_span_and_is_flagged():
    ws = [W(0, "a", 0.0, 1.0), W(1, "b", 1.0, 1.2), W(2, "c", 1.2, 2.0)]
    out, st = refine(ws, [(0.9, 1.5)])
    assert (out[1].start, out[1].end) == (1.0, 1.2)
    assert st["inside_words"] == [1] and st["inside"] == 1
    assert uncertain_gaps(st) == {(0, 1), (1, 2)}


def test_refine_never_inverts_or_overlaps():
    ws = [W(0, "a", 0.0, 1.0), W(1, "b", 1.0, 2.0), W(2, "c", 2.0, 3.0)]
    out, _ = refine(ws, [(0.5, 1.5), (1.8, 2.2), (2.9, 3.0)])
    assert all(w.start < w.end for w in out)
    assert all(x.end <= y.start + 1e-9 for x, y in zip(out, out[1:]))


def test_split_punctuation_breaks():
    ws = [W(0, "Hi.", 0, 1), W(1, "there", 1, 2), W(2, "now?", 2, 3), W(3, "ok", 3, 4)]
    lines = split_lines("A", ws)
    assert [[w.text for w in l.words] for l in lines] == [["Hi."], ["there", "now?"], ["ok"]]
    assert [l.id for l in lines] == ["A1", "A2", "A3"]


def test_split_long_pause_breaks():
    ws = [W(0, "a", 0, 1), W(1, "b", 1 + LINE_BREAK_PAUSE_S, 2.6), W(2, "c", 2.7, 3)]
    lines = split_lines("B", ws)
    assert [len(l.words) for l in lines] == [1, 2]


def test_split_cap_at_largest_gap_earliest_on_ties():
    ws, t = [], 0.0
    n = LINE_MAX_WORDS + 5
    for i in range(n):
        t += 0.3 if i in (7, 12) else 0.01   # two equal largest gaps: earliest wins
        ws.append(W(i, f"w{i}", t, t + 0.1))
        t += 0.1
    lines = split_lines("C", ws)
    assert [len(l.words) for l in lines] == [7, n - 7]
    assert all(len(l.words) <= LINE_MAX_WORDS for l in lines)


def test_ids_deterministic():
    ws = [W(i, f"w{i}.", i, i + 1) for i in range(5)]
    assert split_lines("D", ws) == split_lines("D", ws)


def test_sidecar_for_ignores_trim_spec(tmp_path):
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"")
    (tmp_path / "clip.json").write_text(json.dumps({"keeps": [[0, 1]]}))
    assert sidecar_for({"src": str(src)}) is None
    (tmp_path / "clip.json").write_text(json.dumps({"transcription": []}))
    assert sidecar_for({"src": str(src)}) == str(tmp_path / "clip.json")


def test_sidecar_for_normalized(tmp_path):
    src = tmp_path / "clip.mp4"
    (tmp_path / "clip_n.json").write_text(json.dumps({"transcription": []}))
    item = {"src": str(src), "normalizedSrc": str(tmp_path / "clip_n.mp4"), "normalizedInPoint": 0}
    assert sidecar_for(item) == str(tmp_path / "clip_n.json")
    assert sidecar_for({**item, "normalizedInPoint": 1.5}) is None
    assert sidecar_for({"src": str(src)}) is None


def test_sidecar_for_normalized_requires_explicit_inpoint_zero(tmp_path):
    """normalizedSrc sidecar is used only when normalizedInPoint is explicitly 0 (full-source conversion).

    When normalizedInPoint is absent (window-based conversion), do not use the normalizedSrc sidecar
    even if it exists and has a valid transcription.
    """
    src = tmp_path / "clip.mp4"
    nsrc = tmp_path / "clip_n.mp4"
    # src has no sidecar
    # normalizedSrc has a valid sidecar
    (tmp_path / "clip_n.json").write_text(json.dumps({"transcription": []}))

    # Case 1: normalizedInPoint is absent -> should return None
    item_without_inpoint = {"src": str(src), "normalizedSrc": str(nsrc)}
    assert sidecar_for(item_without_inpoint) is None, "normalizedSrc sidecar should not be used when normalizedInPoint is absent"

    # Case 2: normalizedInPoint is explicitly 0 -> should return the normalizedSrc sidecar
    item_with_inpoint_zero = {"src": str(src), "normalizedSrc": str(nsrc), "normalizedInPoint": 0}
    assert sidecar_for(item_with_inpoint_zero) == str(tmp_path / "clip_n.json"), "normalizedSrc sidecar should be used when normalizedInPoint is 0"


def _fixture():
    words = load_words(os.path.join(FIX, "speech.json"))
    sils = silences(os.path.join(FIX, "speech.mp4"))
    refined, stats = refine(words, sils)
    return words, sils, refined, stats


def _gap_failures(refined, sils):
    first, last = refined[0].start, refined[-1].end
    vis = [(a, b) for a, b in sils if b - a >= SHOW_PAUSE_S and a > first and b < last]
    bad = [(a, b) for a, b in vis
           if not any(x.end <= a + 0.05 and y.start >= b - 0.05 for x, y in zip(refined, refined[1:]))]
    return vis, bad


def test_fixture_refined_words_never_invert_or_overlap():
    _, _, refined, _ = _fixture()
    assert all(w.start < w.end for w in refined)
    assert all(x.end <= y.start + 1e-9 for x, y in zip(refined, refined[1:]))


def test_fixture_every_visible_pause_is_a_gap_or_holds_an_inside_word():
    words, sils, refined, stats = _fixture()
    vis, bad = _gap_failures(refined, sils)
    assert len(vis) > 5
    inside = [words[i] for i in stats["inside_words"]]
    holds = [(a, b, [w.text for w in inside if w.start < b and w.end > a]) for a, b in bad]
    assert all(h[2] for h in holds), f"pauses that are neither a word gap nor hold an inside word: {holds}"
    in_pause = [w for w in inside if any(a < w.end and b > w.start for a, b in vis)]
    assert len(bad) == len(in_pause) and len(bad) <= 2, (holds, [w.text for w in in_pause])
    assert stats["inside"] == len(stats["inside_words"])


def test_fixture_uncertain_gaps_surround_inside_words():
    _, _, _, stats = _fixture()
    gaps = uncertain_gaps(stats)
    for i in stats["inside_words"]:
        assert all(g in gaps for g in ((i - 1, i), (i, i + 1)) if g[0] >= 0)


def test_sentence_end_after_closing_quote():
    ws = [W(0, 'wonder?"', 0.0, 0.5), W(1, '"You,', 0.5, 0.9), W(2, "Tom!)", 0.9, 1.2), W(3, "next", 1.2, 1.5),
          W(4, "it's.'", 1.5, 1.8), W(5, "last", 1.8, 2.0)]
    assert [[w.text for w in ln.words] for ln in split_lines("E", ws)] == [
        ['wonder?"'], ['"You,', "Tom!)"], ["next", "it's.'"], ["last"]]
