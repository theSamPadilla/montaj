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
