"""Minted timeline ids carry a random part (§482, lib/item_ids.py).

Two copies of one project, edited apart and merged by id, must never mint one id for two
different things. Each mint here runs twice on the same base, as two machines would, and the two
runs must not share an id. An existing id is never rewritten.
"""
import json
import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import steps.edit.jump_cut as jump_cut  # noqa: E402
from lib.item_ids import id_suffix  # noqa: E402
from lib.project_tracks import normalize_tracks, replace_track_items  # noqa: E402

HEX = r"[0-9a-f]{6}"


def _clip(cid, start, dur=4.0):
    return {"id": cid, "type": "video", "src": f"./{cid}.mp4", "start": start,
            "end": start + dur, "inPoint": 0.0, "outPoint": dur}


def _base():
    return {"id": "p1", "name": "orig",
            "tracks": [{"id": "trk-0", "items": [_clip("a", 0.0), _clip("b", 4.0)]}]}


def _run(monkeypatch, tmp_path, module, argv):
    """One run of a step on a fresh copy of the base; the track-0 ids it leaves."""
    path = tmp_path / "project.json"
    path.write_text(json.dumps(_base()))
    monkeypatch.setattr(module, "find_project", lambda pid: (path, json.loads(path.read_text())))
    monkeypatch.setattr(sys, "argv", argv)
    module.main()
    return [it["id"] for it in json.loads(path.read_text())["tracks"][0]["items"]]


JUMP = ["jump_cut.py", "--project-id", "p1", "--clip-id", "a", "--cuts", json.dumps([[1.0, 2.0]])]


def test_id_suffix_is_six_lower_case_hex():
    for _ in range(50):
        assert re.fullmatch(HEX, id_suffix())


@pytest.mark.parametrize("module,argv,stem", [
    (jump_cut, JUMP, r"a-seg-\d+"),
])
def test_a_cut_keeps_its_readable_stem_and_one_random_part_per_run(module, argv, stem, tmp_path, monkeypatch):
    ids = [i for i in _run(monkeypatch, tmp_path, module, argv) if i != "b"]   # jump_cut leaves b alone
    assert len(ids) >= 2
    assert all(re.fullmatch(rf"{stem}-{HEX}", i) for i in ids), ids
    assert len({i.rsplit("-", 1)[1] for i in ids}) == 1, "one random part per run"
    assert len(set(ids)) == len(ids)


@pytest.mark.parametrize("module,argv", [(jump_cut, JUMP)])
def test_two_runs_of_a_cut_on_one_base_mint_different_ids(module, argv, tmp_path, monkeypatch):
    first = _run(monkeypatch, tmp_path, module, argv)
    second = _run(monkeypatch, tmp_path, module, argv)
    minted_first = set(first) - {"a", "b"}
    minted_second = set(second) - {"a", "b"}
    assert minted_first and minted_second
    assert not minted_first & minted_second


def test_a_jump_cut_leaves_an_uncut_clip_and_the_track_id_as_they_were(tmp_path, monkeypatch):
    ids = _run(monkeypatch, tmp_path, jump_cut, JUMP)
    assert ids[-1] == "b"
    doc = json.loads((tmp_path / "project.json").read_text())
    assert doc["tracks"][0]["id"] == "trk-0"


# tracks

def test_a_new_track_past_the_first_is_trk_and_a_random_part():
    out = replace_track_items({"tracks": [{"id": "trk-0", "items": []}]}, 2, [_clip("x", 0.0)])
    assert [t["id"] for t in out][0] == "trk-0"
    assert all(re.fullmatch(rf"trk-{HEX}", t["id"]) for t in out[1:]), out
    assert out[2]["items"][0]["id"] == "x"


def test_two_copies_adding_a_track_mint_different_ids():
    base = {"tracks": [{"id": "trk-0", "items": []}]}
    a = replace_track_items(base, 1, [])[1]["id"]
    b = replace_track_items(base, 1, [])[1]["id"]
    assert a != b


def test_the_primary_track_of_a_trackless_project_is_still_trk_0():
    assert [t["id"] for t in replace_track_items({"tracks": []}, 0, [])] == ["trk-0"]


def test_normalizing_a_legacy_project_stays_deterministic():
    """Every machine, and render and the editor, must name a legacy track the same way."""
    legacy = {"tracks": [[_clip("a", 0.0)], [], {"items": []}]}
    first, second = normalize_tracks(legacy), normalize_tracks(legacy)
    assert [t["id"] for t in first["tracks"]] == ["trk-0", "trk-1", "trk-2"]
    assert first == second


def test_existing_track_ids_are_never_rewritten():
    tracks = [{"id": "trk-0", "items": []}, {"id": "trk-3fa9c1", "items": []}, {"id": "mine", "items": []}]
    out = replace_track_items({"tracks": tracks}, 1, [_clip("y", 0.0)])
    assert [t["id"] for t in out] == ["trk-0", "trk-3fa9c1", "mine"]
