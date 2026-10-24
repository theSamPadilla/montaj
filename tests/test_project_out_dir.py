"""§558 U3: a step run with a project saves its check image under render/samples, not assets/."""
import json
import re
from pathlib import Path

import pytest
from fastapi import HTTPException

import serve.routes.steps as steps_mod

STEPS = Path(__file__).resolve().parent.parent / "steps" / "render"


def _project(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-13-demo"
    pdir.mkdir(parents=True)
    (pdir / "project.json").write_text(json.dumps({"id": "p-1", "tracks": []}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    monkeypatch.setattr(steps_mod, "_RESERVED_OUTS", set())
    return pdir


@pytest.mark.parametrize("step", ["sample_overlay", "contact_sheet"])
def test_check_images_default_to_render_samples(step, tmp_path, monkeypatch):
    pdir = _project(tmp_path, monkeypatch)
    schema = json.loads((STEPS / f"{step}.json").read_text())
    body = {"_project": str(pdir)}
    out = steps_mod.resolve_project_out(step, schema, body)
    assert re.fullmatch(re.escape(str(pdir.resolve() / "render" / "samples")) + rf"/{step}-\d{{8}}-\d{{6}}\.png", out)
    assert not (pdir / "assets").exists()

    body = {"_project": str(pdir), "out": "check"}
    assert steps_mod.resolve_project_out(step, schema, body) == str(pdir.resolve() / "render" / "samples" / "check.png")


def test_a_symlinked_samples_folder_is_refused(tmp_path, monkeypatch):
    pdir = _project(tmp_path, monkeypatch)
    (pdir / "render").mkdir()
    (pdir / "render" / "samples").symlink_to(tmp_path)
    schema = json.loads((STEPS / "contact_sheet.json").read_text())
    with pytest.raises(HTTPException) as e:
        steps_mod.resolve_project_out("contact_sheet", schema, {"_project": str(pdir)})
    assert e.value.status_code == 422


def test_other_steps_still_use_assets(tmp_path, monkeypatch):
    pdir = _project(tmp_path, monkeypatch)
    schema = {"output": {"type": "image"}, "params": [{"name": "out", "type": "path"}]}
    out = steps_mod.resolve_project_out("thing", schema, {"_project": str(pdir)})
    assert out.startswith(str(pdir.resolve() / "assets") + "/")


def _schema_with(sub):
    return {"output": {"type": "image"}, "params": [{"name": "out", "type": "path", "projectDir": sub}]}


@pytest.mark.parametrize("sub", ["../elsewhere", "render/../../x", "/etc", ""])
def test_a_bad_project_dir_is_a_422(sub, tmp_path, monkeypatch):
    pdir = _project(tmp_path, monkeypatch)
    schema = _schema_with(sub)
    if sub == "":
        schema["params"][0]["projectDir"] = "."
    with pytest.raises(HTTPException) as e:
        steps_mod.resolve_project_out("thing", schema, {"_project": str(pdir)})
    assert e.value.status_code == 422


def test_a_symlinked_render_parent_is_a_422(tmp_path, monkeypatch):
    pdir = _project(tmp_path, monkeypatch)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (pdir / "render").symlink_to(elsewhere)
    with pytest.raises(HTTPException) as e:
        steps_mod.resolve_project_out("thing", _schema_with("render/samples"), {"_project": str(pdir)})
    assert e.value.status_code == 422
    assert not (elsewhere / "samples").exists()


def test_a_plain_file_where_the_folder_goes_is_a_422_not_a_500(tmp_path, monkeypatch):
    pdir = _project(tmp_path, monkeypatch)
    (pdir / "render").write_text("x")
    with pytest.raises(HTTPException) as e:
        steps_mod.resolve_project_out("thing", _schema_with("render/samples"), {"_project": str(pdir)})
    assert e.value.status_code == 422


def test_the_sync_check_folder_is_the_declared_one():
    assert steps_mod._project_out_dir(_schema_with("render/samples")) == "render/samples"
    assert steps_mod._project_out_dir({"params": [{"name": "out"}]}) == "assets"
    assert steps_mod._project_out_dir({"params": []}) == "assets"
