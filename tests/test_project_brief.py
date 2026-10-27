"""The project brief (PL89, Sam 2026-10-26): the first get_project on a pending project answers what the first
decisions need, in one read. Kung fu run 3 spent 18 turns and 37 calls finding it (774K tokens of cache reads).
Hand-made sources here: whisper sidecars with known words, a long b-roll whose shots are given, a short one."""
import json
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import project_brief as pb  # noqa: E402


def _sidecar(path, phrases):
    """A whisper sidecar: `phrases` = [(start s, text)], words 0.3 s apart."""
    rows = []
    for start, text in phrases:
        t = start
        for w in text.split():
            rows.append({"text": f" {w}", "offsets": {"from": int(t * 1000), "to": int((t + 0.25) * 1000)}})
            t += 0.3
    path.write_text(json.dumps({"transcription": rows}))


PROMPT = ("Edit this video to follow the script:\n<Hook>\nThis might be the funniest demo I've ever seen.\n"
          "<Setup>\nIn the demo, it dents cars and lifts a car.\nA line nobody ever recorded here.\n-----\nmake it look great")


@pytest.fixture
def proj(tmp_path):
    d = tmp_path / "Montaj" / "kungfu"
    d.mkdir(parents=True)
    _sidecar(d / "talk.json", [(0.0, "this may be the funniest demo i've ever seen."),
                               (4.0, "this may be the funniest demo i've ever seen."),
                               (8.0, "in the demo the robot dents a car and lifts a car.")])
    style = tmp_path / "style_profile.md"
    style.write_text("---\nstyle_summary: Thesis-led explainers.\n---\n## Titles & overlays\nCentered text, one line.\n"
                     "## Format\n9:16, under 80 s.\n## Changelog\nnot for the edit\n")
    p = {"id": str(uuid.uuid4()), "name": "Kung Fu", "status": "pending", "workflow": "overlays",
         "editingPrompt": PROMPT, "tracks": [{"id": "trk-0", "items": []}],
         "sources": [{"id": "clip-0", "type": "video", "src": str(d / "talk.mov"), "sourceDuration": 12.0,
                      "sourceWidth": 2160, "sourceHeight": 3840},
                     {"id": "clip-1", "type": "video", "src": str(d / "demo.mov"), "sourceDuration": 74.7,
                      "sourceWidth": 3456, "sourceHeight": 2234},
                     {"id": "clip-2", "type": "video", "src": str(d / "short.mov"), "sourceDuration": 5.0}],
         "profileSnapshot": {"name": "sam", "styleProfilePath": str(style),
                             "preferences": {"name": "Sam Padilla", "captionStyle": "outline", "fontFamily": "JetBrains Mono"}}}
    (d / "project.json").write_text(json.dumps(p))
    return p, d


class Fns:
    def __init__(self):
        self.silences, self.shots, self.sheets = [], [], []

    def kw(self):
        return {"probe_fn": lambda path: (30, "arib-std-b67" if path.endswith("talk.mov") else "bt709"),
                "silences_fn": lambda path: self.silences.append(path) or [],
                "shots_fn": lambda src, scan: self.shots.append(src) or [
                    {"n": 1, "start": 0.0, "end": 4.9}, {"n": 2, "start": 4.9, "end": 12.6, "label": "car dent"},
                    {"n": 3, "start": 12.6, "end": 74.7}],
                "sheet_fn": lambda src, shots, out, scan: (self.sheets.append(out), Path(out).write_bytes(b"png"), out)[2]}


def test_sources_have_their_role_length_fps_and_picture(proj):
    p, d = proj
    text = pb.build(p, str(d), str(ROOT), **Fns().kw())["text"]
    assert "| clip-0 | talk.mov | talking head A | 12.0 s | 30 | 2160x3840 HDR |" in text, text
    assert "| clip-1 | demo.mov | b-roll | 74.7 s | 30 | 3456x2234 |" in text, text
    assert "| clip-2 | short.mov | b-roll | 5.0 s |" in text, text


def test_every_take_line_is_listed_with_its_times_retakes_included(proj):
    p, d = proj
    text = pb.build(p, str(d), str(ROOT), **Fns().kw())["text"]
    assert "**A = talk.mov** (clip-0)" in text
    assert "- A1 0.0-2.6 this may be the funniest demo i've ever seen." in text, text
    assert "- A2 4.0-6.6 this may be the funniest demo i've ever seen." in text, text
    assert "- A3 8.0-11.6 in the demo the robot dents a car and lifts a car." in text, text
    # Whisper's spelling stands; the script's words for a matched line stand beside it, to caption and cut by
    assert "- A1 0.0-2.6 this may be the funniest demo i've ever seen. ⟶ script 1: \"This might be the funniest demo I've ever seen.\"" in text, text


def test_each_script_line_points_at_the_takes_that_say_it(proj):
    p, d = proj
    text = pb.build(p, str(d), str(ROOT), **Fns().kw())["text"]
    assert "**<Hook>**" in text and "**<Setup>**" in text
    assert "1. This might be the funniest demo I've ever seen. → A1, A2" in text, text
    assert "2. In the demo, it dents cars and lifts a car. → A3" in text, text
    assert "3. A line nobody ever recorded here. → not recorded as written" in text, text
    assert "make it look great" not in text.split("## Script")[1], "the notes after ----- are not script"


def test_a_long_b_roll_gets_its_shots_and_one_sheet_a_short_one_does_not(proj):
    p, d = proj
    f = Fns()
    got = pb.build(p, str(d), str(ROOT), **f.kw())
    assert f.shots == [str(d / "demo.mov")], "only the long b-roll is scanned"
    assert got["sheets"] == [str(d / "render" / "brief" / "shots-clip-1.png")]
    text = got["text"]
    assert "**clip-1 demo.mov**, 74.7 s, 3 shots" in text and "- 2: 4.9-12.6 car dent" in text, text
    assert "2 of its shots have no label yet" in text, text
    # how to use them without looking again: add b-roll by shot; snapshot is the one closer look
    assert 'edit_timeline {op: "add", item: {source: "clip-1", shot: n, start}}' in text, text
    assert "snapshot" in text.split("## B-roll")[1].split("##")[0]
    assert "**clip-2 short.mov**, 5.0 s: one shot." in text


def test_the_steps_in_order_and_the_skills_they_use(proj):
    p, d = proj
    got = pb.build(p, str(d), str(ROOT), **Fns().kw())
    steps = got["text"].split("## Steps, in order")[1]
    assert steps.index("**cut_plan** (cut)") < steps.index("**select-takes** (select-takes)") < steps.index("**overlays** (overlay)")
    assert "select-takes" in got["skills"] and "overlay" in got["skills"] and got["skills"][0] == "probe"
    # looking at the footage is what this brief already did (run 3 spent six snapshots on it): folded, so cut is first
    assert "probe and snapshot: this brief covers them" in steps, steps
    assert "1. **cut_plan** (cut)" in steps and "**probe**" not in steps and "**snapshot**" not in steps, steps
    # a step with no note of its own points at its guide in the recipe, never an empty line
    assert "**overlays** (overlay) with {\"style\": \"auto\"}: its guide is the overlay skill in the Recipe" in steps, steps


def test_the_profile_style_and_its_edit_notes(proj):
    p, d = proj
    text = pb.build(p, str(d), str(ROOT), **Fns().kw())["text"]
    prof = text.split("## Profile")[1]
    assert "Sam Padilla: captions `outline`, font JetBrains Mono." in prof
    assert "Style: Thesis-led explainers." in prof
    assert "Centered text, one line." in prof and "9:16, under 80 s." in prof and "not for the edit" not in prof


def test_the_status_line_says_what_the_timeline_holds(proj):
    p, d = proj
    assert "The timeline is empty" in pb.build(p, str(d), str(ROOT), **Fns().kw())["text"]
    p["tracks"] = [{"id": "trk-0", "items": [{"id": f"take-{i}", "type": "video"} for i in range(66)]}]
    assert "The timeline holds 66 items laid by Montaj before you, not an edit" in pb.build(p, str(d), str(ROOT), **Fns().kw())["text"]


def test_a_second_read_is_cached_and_a_change_reads_again(proj):
    p, d = proj
    f = Fns()
    first = pb.brief(p, str(d), str(ROOT), **f.kw())
    again = pb.brief(p, str(d), str(ROOT), **f.kw())
    assert again == first and len(f.silences) == 1 and len(f.shots) == 1, "the second read measured nothing"
    p["editingPrompt"] = PROMPT.replace("lifts a car", "lifts a truck")
    changed = pb.brief(p, str(d), str(ROOT), **f.kw())
    assert changed["stamp"] != first["stamp"] and len(f.silences) == 2


def test_the_route_answers_the_brief(proj, monkeypatch):
    from starlette.testclient import TestClient
    from serve.server import app
    p, d = proj
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(d.parent))
    f = Fns()
    monkeypatch.setattr(pb, "_probe", f.kw()["probe_fn"])
    monkeypatch.setattr(pb, "_silences", f.kw()["silences_fn"])
    monkeypatch.setattr(pb.shots_lib, "shots_for", lambda src, scan_path=None: {"shots": [{"n": 1, "start": 0, "end": 74.7}]})
    monkeypatch.setattr(pb.shots_lib, "sheet", lambda src, shots, out, scan_path=None: (Path(out).write_bytes(b"png"), out)[1])
    r = TestClient(app).get(f"/api/projects/{p['id']}/brief")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"].startswith("# Kung Fu") and body["sheets"] == [str(d / "render" / "brief" / "shots-clip-1.png")]
    assert "select-takes" in body["skills"]
