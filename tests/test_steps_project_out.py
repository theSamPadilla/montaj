"""`_project` on a step that writes a file: `out` left off or a plain name is
saved in the project's assets folder (generate_image and the other generate
steps). The step subprocess is stubbed; no vendor is called."""
import json
import re
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.steps as steps_mod
from serve.server import app
from tests.conftest import STEPS_DIR

client = TestClient(app)
SCHEMA = json.loads((Path(STEPS_DIR) / "generate/generate_image.json").read_text())


@pytest.fixture()
def env(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-06-demo"
    pdir.mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "tracks": []}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    steps_mod._RESERVED_OUTS.clear()
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"generate_image": (SCHEMA, Path("x.py"))})
    calls = []

    async def fake_run(cmd, **kw):
        calls.append(cmd)
        out = cmd[cmd.index("--out") + 1]
        return out + "\n", "", 0

    monkeypatch.setattr(steps_mod, "run_subprocess", fake_run)
    return pid, pdir, calls


def _post(**body):
    return client.post("/api/steps/generate_image", json={"prompt": "a cat", **body})


def test_no_out_goes_to_assets_with_timestamp(env):
    pid, pdir, calls = env
    r = _post(_project=pid)
    assert r.status_code == 200, r.text
    out = calls[0][calls[0].index("--out") + 1]
    assert re.fullmatch(re.escape(str(pdir / "assets")) + r"/generate_image-\d{8}-\d{6}\.png", out)
    assert r.json()["out"] == out and r.json()["path"] == out


def test_three_calls_never_collide(env):
    pid, pdir, calls = env
    outs = set()
    for _ in range(3):
        assert _post(_project=pid).status_code == 200
        outs.add(calls[-1][calls[-1].index("--out") + 1])
    assert len(outs) == 3


def test_bare_name_gets_ext_and_kept_ext(env):
    pid, pdir, calls = env
    _post(_project=pid, out="hero")
    assert calls[-1][calls[-1].index("--out") + 1] == str(pdir / "assets" / "hero.png")
    _post(_project=pid, out="hero.jpg")
    assert calls[-1][calls[-1].index("--out") + 1] == str(pdir / "assets" / "hero.jpg")


def test_existing_file_gets_suffix(env):
    pid, pdir, calls = env
    (pdir / "assets").mkdir()
    (pdir / "assets" / "hero.png").write_bytes(b"x")
    _post(_project=pid, out="hero")
    assert calls[-1][calls[-1].index("--out") + 1] == str(pdir / "assets" / "hero-2.png")


@pytest.mark.parametrize("odd", ["../x.png", "sub/x.png", "..", ".", "a\\b", "/abs/x.png"])
def test_non_plain_out_passes_through_unchanged(env, odd):
    pid, pdir, calls = env
    r = _post(_project=pid, out=odd)
    assert r.status_code == 200, r.text
    assert calls[-1][calls[-1].index("--out") + 1] == odd
    assert not (pdir / "assets").exists()


def test_folder_outside_workspace_refused(env, tmp_path):
    outside = tmp_path / "other"
    outside.mkdir()
    (outside / "project.json").write_text("{}")
    r = _post(_project=str(outside))
    assert r.status_code == 422 and "project" in json.dumps(r.json()).lower()
    assert not (outside / "assets").exists()


def test_symlinked_project_folder_refused(env, tmp_path):
    pid, pdir, calls = env
    outside = tmp_path / "other"
    outside.mkdir()
    (outside / "project.json").write_text("{}")
    link = pdir.parent / "link"
    link.symlink_to(outside)
    r = _post(_project=str(link))
    assert r.status_code == 422
    assert not (outside / "assets").exists()


def test_symlinked_assets_refused(env, tmp_path):
    pid, pdir, calls = env
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (pdir / "assets").symlink_to(outside)
    r = _post(_project=pid, out="hero")
    assert r.status_code == 422 and not calls
    assert list(outside.iterdir()) == []


def test_unknown_project_422_names_project(env):
    r = _post(_project="nope")
    assert r.status_code == 422
    assert "project" in json.dumps(r.json()).lower()


def test_absolute_out_unchanged(env, tmp_path):
    pid, pdir, calls = env
    target = str(tmp_path / "elsewhere.png")
    r = _post(_project=pid, out=target)
    assert r.status_code == 200
    assert calls[-1][calls[-1].index("--out") + 1] == target
    assert not (pdir / "assets").exists()


def test_without_project_missing_out_still_422(env):
    r = _post()
    assert r.status_code == 422


def test_project_folder_path_works(env):
    _, pdir, calls = env
    r = _post(_project=str(pdir), out="a")
    assert r.status_code == 200
    assert calls[-1][calls[-1].index("--out") + 1] == str(pdir / "assets" / "a.png")


def test_empty_out_not_resolved_into_assets(env):
    pid, pdir, _ = env
    _post(_project=pid, out="")
    assert not (pdir / "assets").exists()


def test_final_parent_assertion_catches_a_name_that_slipped_the_plain_check(env, monkeypatch):
    pid, pdir, calls = env
    monkeypatch.setattr(steps_mod, "_is_plain_name", lambda out: True)
    r = _post(_project=pid, out="../escape.png")
    assert r.status_code == 422 and not calls
