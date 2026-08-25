"""Tests for `montaj status` — the human-readable summary.

The clip count used to reach for `track.get("clips")` / `track.get("type")`,
fields of an obsolete pre-v0.2 track shape. Against a real project a track is
a list of items, so `.get` raised AttributeError and `montaj status` crashed on
any project that had clips at all.

It now counts the items on the PRIMARY track (`tracks[0]`) only. `tracks[1+]`
holds overlays, images, and other non-footage items — "clips" means footage,
so those must never be counted, no matter how many overlay tracks a project
carries. A canvas project (no footage, `tracks[0]` empty, everything else
overlays) correctly reports 0.
"""
import json
from argparse import Namespace

import pytest

import cli.commands.status as status_cmd


def _ns(path, json_out=False):
    return Namespace(project=str(path), json=json_out, out=None, quiet=False)


def _project(tracks):
    return {"id": "p1", "name": "demo", "status": "draft",
            "workflow": "default", "editingPrompt": "test", "tracks": tracks}


def _clip(cid):
    return {"id": cid, "type": "video", "src": f"./{cid}.mp4", "start": 0.0, "end": 1.0}


def _overlay(oid):
    return {"id": oid, "type": "overlay", "src": f"./{oid}.jsx", "start": 0.0, "end": 1.0}


def _run(tmp_path, capsys, project):
    path = tmp_path / "project.json"
    path.write_text(json.dumps(project))
    status_cmd.handle(_ns(path))
    return capsys.readouterr().out


def test_status_counts_only_the_primary_track__object_shape(tmp_path, capsys):
    out = _run(tmp_path, capsys, _project([
        {"id": "trk-0", "items": [_clip("a"), _clip("b")]},
        {"id": "trk-1", "items": [_clip("c")]},
    ]))
    assert "clips:    2" in out


def test_status_counts_only_the_primary_track__legacy_shape(tmp_path, capsys):
    out = _run(tmp_path, capsys, _project([[_clip("a"), _clip("b")], [_clip("c")]]))
    assert "clips:    2" in out


def test_status_does_not_count_overlays_on_higher_tracks(tmp_path, capsys):
    """Regression guard: `tracks[1+]` items are overlays here, not clips —
    they must never inflate the `clips:` count, however many overlay tracks
    the project carries."""
    out = _run(tmp_path, capsys, _project([
        {"id": "trk-0", "items": [_clip("a"), _clip("b")]},
        {"id": "trk-1", "items": [_overlay("hook"), _overlay("logo")]},
        {"id": "trk-2", "items": [_overlay("caption")]},
    ]))
    assert "clips:    2" in out


def test_status_reports_zero_for_an_empty_project(tmp_path, capsys):
    out = _run(tmp_path, capsys, _project([{"id": "trk-0", "items": []}]))
    assert "clips:    0" in out


def test_status_reports_zero_for_a_canvas_project(tmp_path, capsys):
    """A canvas project has no footage — `tracks[0]` is empty and everything
    else is overlays. `clips: 0` is correct here, not a bug."""
    out = _run(tmp_path, capsys, _project([
        {"id": "trk-0", "items": []},
        {"id": "trk-1", "items": [_overlay("title-card"), _overlay("stat-card")]},
    ]))
    assert "clips:    0" in out


def test_status_survives_a_project_with_no_tracks(tmp_path, capsys):
    project = _project([])
    del project["tracks"]
    out = _run(tmp_path, capsys, project)
    assert "clips:    0" in out


def test_status_json_dumps_the_project_verbatim(tmp_path, capsys):
    project = _project([{"id": "trk-0", "items": [_clip("a")]}])
    path = tmp_path / "project.json"
    path.write_text(json.dumps(project))
    status_cmd.handle(_ns(path, json_out=True))
    assert json.loads(capsys.readouterr().out) == project
