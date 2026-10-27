"""§577 (Sam, 2026-10-25): cut never prescribes the order. The plan's `## Cut` rows play in the order they are in,
so the agent picks the takes and then orders them from the prompt or script. Moving rows is a pure reorder: it
applies in plan order, and no backstop (plan_unsettled, the played-mismatch check, the take rules) refuses it."""
import json
import re

from tests.steps import test_cut as tc
from tests.steps.test_cut import stub_transcribe  # noqa: F401


def _plan_lines(d):
    return (d / "cut-plan.md").read_text().splitlines()


def _cut_rows(lines):
    """Indexes of the `## Cut` rows (each a line id, its words and a [time ...] tag)."""
    at = lines.index("## Cut")
    end = lines.index("## Unused") if "## Unused" in lines else len(lines)
    return [i for i in range(at + 1, end) if lines[i].strip() and not lines[i].startswith("<!--")]


def _reorder(d, order):
    """Write the plan back with its `## Cut` rows in `order` (a list of their positions) and nothing else changed."""
    lines = _plan_lines(d)
    idx = _cut_rows(lines)
    assert sorted(order) == list(range(len(idx))), (order, [lines[i] for i in idx])
    rows = [lines[i] for i in idx]
    for i, k in zip(idx, order):
        lines[i] = rows[k]
    (d / "cut-plan.md").write_text("\n".join(lines) + "\n")
    return [rows[k] for k in order]


def _words(text):
    return text.split()


def test_rows_of_one_clip_play_in_the_order_the_plan_puts_them(tmp_path, monkeypatch):
    said = ["One fine morning we left early.", "The road out of town was long.", "We reached the lake at noon."]
    d = tc.spoken_project(tmp_path, said)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    assert plan["labels"] == {}
    rows = _reorder(d, [2, 0, 1])
    assert [r.split(" ", 1)[1].split(" [")[0] for r in rows][0].startswith("We reached")
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert applied["mode"] == "applied"
    assert _words(tc.said_text(d)) == _words(" ".join([said[2], said[0], said[1]]))


def test_a_later_clips_rows_can_play_ahead_of_an_earlier_clips(tmp_path, monkeypatch):
    one = ["Hello there my good friends.", "This part was filmed first."]
    two = ["Now the second clip is talking.", "And this is where it ends."]
    d = tc.spoken_project(tmp_path, one, two)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    assert plan["labels"] == {}
    _reorder(d, [2, 3, 0, 1])
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert applied["mode"] == "applied"
    assert _words(tc.said_text(d)) == _words(" ".join(two + one))
    items = json.loads((d / "project.json").read_text())["tracks"][0]["items"]
    starts = sorted(items, key=lambda it: it["start"])
    assert starts[0]["src"].endswith("vo1.mov"), [it["src"] for it in starts]       # the later clip plays first


def test_a_labeled_row_moves_like_any_other(tmp_path, monkeypatch):
    """A take the plan labels (retake?: a row of `## Cut` with its tag) is a row like any other: moved last, it plays
    last, and nothing refuses the move."""
    d = tc.spoken_project(tmp_path, ["what if a robot could ride a bike?", "Here is how it learns."], ["It falls a lot."],
                          ["It gets up again."], ["It keeps trying all day.", "So what if a robot could ride a bike?"])
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    assert plan["labels"].get("retake?"), plan["labels"]
    lines = _plan_lines(d)
    rows = [lines[i] for i in _cut_rows(lines)]
    k = next(j for j, r in enumerate(rows) if re.search(r"\[[\d.]+ retake\? ", r))      # the labeled take
    assert rows[k].split(" ", 1)[1].startswith("what if"), rows[k]
    order = [j for j in range(len(rows)) if j != k] + [k]
    moved = _reorder(d, order)
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert applied["mode"] == "applied"
    want = [r.split(" ", 1)[1].split(" [")[0] for r in moved]
    assert _words(tc.said_text(d)) == _words(" ".join(want)), (tc.said_text(d), want)


def test_the_kept_rows_reversed_on_real_speech_apply_reversed(tmp_path, stub_transcribe, monkeypatch):
    """On recorded speech whose retakes the take rules label, every row reversed still applies, in that order."""
    stub_transcribe(tc.retake_transcript())
    d = tc.make_project(tmp_path)
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    assert plan["labels"]                                                    # the take rules labeled some
    n = len(_cut_rows(_plan_lines(d)))
    moved = _reorder(d, list(range(n - 1, -1, -1)))
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert applied["mode"] == "applied"
    norm = lambda t: [w.strip(".,!?").lower() for w in t.split()]
    want = [re.sub(r" ?\{[\d.]+\} ?", " ", r.split(" ", 1)[1].split(" [")[0]).strip() for r in moved]
    assert norm(tc.said_text(d)) == norm(" ".join(want)), (tc.said_text(d), want)
