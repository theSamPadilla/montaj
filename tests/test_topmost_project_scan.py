"""§688: the project scan finds exactly the topmost project.json files rglob + the nested filter found,
without walking into projects' own folders."""
import os
from pathlib import Path

from serve.common import is_nested_project_json, topmost_project_jsons


def _old(ws: Path):
    return sorted(p for p in ws.rglob("project.json") if not is_nested_project_json(p, ws))


def _tree(ws: Path):
    def pj(rel):
        p = ws / rel / "project.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{}")
    for rel in ["a", "b", "teamZ/c", "teamZ/deep/d", ".hidden/e"]:
        pj(rel)
    pj("a/render/versions/abc123")          # a Compare-versions snapshot: nested, not a project
    pj("teamZ/c/models/scenes/x")           # nested deeper
    for i in range(50):                     # a project's own files
        f = ws / "a" / "render" / "chunks" / f"{i:05d}.png"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"")
    (ws / "loose" / "media").mkdir(parents=True)
    (ws / "loose" / "media" / "clip.mov").write_bytes(b"")


def test_same_set_as_rglob_minus_nested(tmp_path):
    ws = tmp_path / "Montaj"
    _tree(ws)
    assert sorted(topmost_project_jsons(ws)) == _old(ws)
    assert {p.parent.relative_to(ws).as_posix() for p in topmost_project_jsons(ws)} == {"a", "b", "teamZ/c", "teamZ/deep/d", ".hidden/e"}


def test_a_project_json_at_the_workspace_root_does_not_hide_the_projects_below(tmp_path):
    ws = tmp_path / "Montaj"
    _tree(ws)
    (ws / "project.json").write_text("{}")
    assert sorted(topmost_project_jsons(ws)) == _old(ws)


def test_it_never_walks_into_a_project(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    _tree(ws)
    seen = []
    real = os.walk

    def spy(top, *a, **kw):
        for entry in real(top, *a, **kw):
            seen.append(Path(entry[0]).relative_to(ws).as_posix())
            yield entry

    monkeypatch.setattr(os, "walk", spy)
    topmost_project_jsons(ws)
    assert not any(s.startswith("a/") or s.startswith("teamZ/c/") for s in seen), seen


def test_symlinked_folders_are_not_followed_as_rglob_does_not(tmp_path):
    ws = tmp_path / "Montaj"
    _tree(ws)
    outside = tmp_path / "outside" / "p"
    outside.mkdir(parents=True)
    (outside / "project.json").write_text("{}")
    (ws / "link").symlink_to(tmp_path / "outside", target_is_directory=True)
    assert sorted(topmost_project_jsons(ws)) == _old(ws)


def test_a_missing_workspace_is_an_empty_list(tmp_path):
    assert topmost_project_jsons(tmp_path / "nope") == []


def test_a_broken_link_or_a_folder_named_project_json_neither_counts_nor_stops_the_walk(tmp_path):
    ws = tmp_path / "Montaj"
    _tree(ws)
    (ws / "odd").mkdir()
    (ws / "odd" / "project.json").symlink_to(tmp_path / "missing.json")
    (ws / "odd" / "inner").mkdir()
    (ws / "odd" / "inner" / "project.json").write_text("{}")
    (ws / "dirlike" / "project.json").mkdir(parents=True)
    (ws / "dirlike" / "project.json" / "project.json").write_text("{}")
    new = sorted(topmost_project_jsons(ws))
    old = [p for p in _old(ws) if p.is_file()]  # the old callers skipped what they could not read
    assert new == old
    assert ws / "odd" / "inner" / "project.json" in new
