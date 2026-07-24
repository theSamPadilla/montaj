import json
from pathlib import Path

from serve import common as sc


def _mk_project(root: Path, name: str, pid: str) -> Path:
    d = root / name
    d.mkdir(parents=True)
    (d / "project.json").write_text(json.dumps({"id": pid, "status": "draft"}))
    return d


def test_cache_hit_skips_rescan(tmp_path, monkeypatch):
    sc._project_dir_cache.clear()
    d = _mk_project(tmp_path, "p1", "abc")
    assert sc.find_project_dir(tmp_path, "abc") == d
    def boom(self, *a, **k):
        raise AssertionError("rglob called on cache hit")
    monkeypatch.setattr(Path, "rglob", boom)
    assert sc.find_project_dir(tmp_path, "abc") == d


def test_stale_cache_rescans_after_move(tmp_path):
    sc._project_dir_cache.clear()
    d = _mk_project(tmp_path, "p1", "abc")
    assert sc.find_project_dir(tmp_path, "abc") == d
    moved = tmp_path / "elsewhere"
    d.rename(moved)
    assert sc.find_project_dir(tmp_path, "abc") == moved


def test_cache_scoped_to_workspace(tmp_path):
    sc._project_dir_cache.clear()
    ws1, ws2 = tmp_path / "ws1", tmp_path / "ws2"
    d1 = _mk_project(ws1, "p", "abc")
    d2 = _mk_project(ws2, "p", "abc")
    assert sc.find_project_dir(ws1, "abc") == d1
    assert sc.find_project_dir(ws2, "abc") == d2


def test_missing_project_returns_none(tmp_path):
    sc._project_dir_cache.clear()
    assert sc.find_project_dir(tmp_path, "nope") is None


def test_non_dict_project_json_is_skipped(tmp_path):
    # A project.json that is valid JSON but not an object (e.g. an array) must
    # not break the whole scan — one bad file used to raise AttributeError on
    # .get() and fail every lookup.
    sc._project_dir_cache.clear()
    bad = tmp_path / "bad"
    bad.mkdir(parents=True)
    (bad / "project.json").write_text("[1, 2, 3]")
    good = _mk_project(tmp_path, "good", "abc")
    assert sc.find_project_dir(tmp_path, "abc") == good
