"""Unit tests for engine/resolve_workflow.py and engine/validate_step.py."""
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

import resolve_workflow as rw
import validate_step as vs
import validate as v


# ---------------------------------------------------------------------------
# resolve_workflow — resolve_step()
# ---------------------------------------------------------------------------

def test_resolve_step_builtin(tmp_path):
    py, js = rw.resolve_step("montaj/trim", str(tmp_path))
    assert Path(py).exists()
    assert Path(js).exists()
    assert py.endswith("trim.py")
    assert js.endswith("trim.json")


def test_resolve_step_unknown_scope(tmp_path):
    with pytest.raises(SystemExit):
        rw.resolve_step("unknown/trim", str(tmp_path))


def test_resolve_step_missing_file(tmp_path):
    with pytest.raises(SystemExit):
        rw.resolve_step("montaj/does_not_exist", str(tmp_path))


def test_resolve_step_project_local(tmp_path):
    steps_dir = tmp_path / "steps"
    steps_dir.mkdir()
    (steps_dir / "my_step.py").write_text("# stub")
    (steps_dir / "my_step.json").write_text('{"name":"my_step"}')
    py, js = rw.resolve_step("./steps/my_step", str(tmp_path))
    assert py.endswith("my_step.py")
    assert js.endswith("my_step.json")


# ---------------------------------------------------------------------------
# resolve_workflow — merge_params()
# ---------------------------------------------------------------------------

def test_merge_params_applies_defaults():
    params = [{"name": "threshold", "default": -30}, {"name": "min_silence", "default": 0.3}]
    result = rw.merge_params(params, {})
    assert result == {"threshold": -30, "min_silence": 0.3}


def test_merge_params_workflow_wins():
    params = [{"name": "threshold", "default": -30}]
    result = rw.merge_params(params, {"threshold": -40})
    assert result["threshold"] == -40


def test_merge_params_no_default_skipped():
    params = [{"name": "end"}]
    result = rw.merge_params(params, {})
    assert "end" not in result


def test_merge_params_workflow_extra_keys():
    # Keys in overrides not in schema still pass through (agent-supplied values)
    result = rw.merge_params([], {"out": "/tmp/foo.mp4"})
    assert result["out"] == "/tmp/foo.mp4"


# ---------------------------------------------------------------------------
# validate_step — validate()
# ---------------------------------------------------------------------------

def _write_schema(tmp_path, name, data):
    path = tmp_path / f"{name}.json"
    path.write_text(json.dumps(data))
    return str(path)


VALID_SCHEMA = {
    "name": "my_step",
    "description": "A test step",
    "input":  {"type": "video"},
    "output": {"type": "video"},
    "params": [],
}


def test_validate_passes_for_valid_schema(tmp_path):
    path = _write_schema(tmp_path, "my_step", VALID_SCHEMA)
    schema = vs.validate(path)
    assert schema["name"] == "my_step"


def test_validate_fails_missing_name(tmp_path):
    data = {**VALID_SCHEMA}
    del data["name"]
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_name_mismatch(tmp_path):
    data = {**VALID_SCHEMA, "name": "wrong_name"}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_empty_description(tmp_path):
    data = {**VALID_SCHEMA, "description": "   "}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_invalid_input_type(tmp_path):
    data = {**VALID_SCHEMA, "input": {"type": "spreadsheet"}}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_invalid_output_type(tmp_path):
    data = {**VALID_SCHEMA, "output": {"type": "spreadsheet"}}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_enum_missing_options(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "style", "type": "enum", "description": "Style"}
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_passes_enum_with_options(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "style", "type": "enum", "description": "Style", "options": ["a", "b"]}
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    schema = vs.validate(path)
    assert schema["params"][0]["options"] == ["a", "b"]


def test_validate_fails_param_missing_field(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "x", "type": "float"}  # missing description
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_invalid_param_type(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "x", "type": "blob", "description": "test"}
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_required_not_bool(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "x", "type": "float", "description": "test", "required": "yes"}
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


# ---------------------------------------------------------------------------
# validate_step — resolve_step_path()
# ---------------------------------------------------------------------------

def test_resolve_step_path_finds_builtin():
    path = vs.resolve_step_path("trim")
    assert path.endswith("trim.json")
    assert Path(path).exists()


def test_resolve_step_path_missing():
    with pytest.raises(SystemExit):
        vs.resolve_step_path("does_not_exist_xyz")


def test_resolve_step_path_prefers_project_local(tmp_path):
    steps_dir = tmp_path / "steps"
    steps_dir.mkdir()
    local = steps_dir / "trim.json"
    local.write_text('{"name":"trim","local":true}')
    path = vs.resolve_step_path("trim", str(tmp_path))
    assert path == str(local)


# ---------------------------------------------------------------------------
# validate_project
# ---------------------------------------------------------------------------

VALID_PROJECT = {
    "version": "0.1",
    "id": "abc",
    "status": "pending",
    "workflow": "default",
    "editingPrompt": "test",
    "settings": {"resolution": [1080, 1920], "fps": 30},
    "tracks": [{"id": "main", "type": "video", "clips": []}],
    "overlay_tracks": [],
    "assets": [],
    "audio": {},
}


def _write_project(tmp_path, name, data):
    path = tmp_path / name
    path.write_text(json.dumps(data))
    return str(path)


def test_validate_project_passes_for_valid(tmp_path):
    path = _write_project(tmp_path, "project.json", VALID_PROJECT)
    result = v.validate_project(path)
    assert result["valid"] is True


def test_validate_project_fails_missing_version(tmp_path):
    data = {**VALID_PROJECT}; del data["version"]
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_fails_invalid_track_type(tmp_path):
    data = {**VALID_PROJECT, "tracks": [{"id": "x", "type": "overlay", "items": []}]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_overlay_tracks_must_be_list_of_lists(tmp_path):
    data = {**VALID_PROJECT, "overlay_tracks": [{"id": "x"}]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_overlay_item_missing_required_field(tmp_path):
    item = {"id": "ov-0", "type": "custom", "src": "./x.jsx", "start": 0.0}  # missing end
    data = {**VALID_PROJECT, "overlay_tracks": [[item]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_opaque_must_be_bool(tmp_path):
    item = {"id": "ov-0", "type": "custom", "src": "./x.jsx", "start": 0.0, "end": 3.0, "opaque": "yes"}
    data = {**VALID_PROJECT, "overlay_tracks": [[item]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_no_overlap_in_track(tmp_path):
    items = [
        {"id": "ov-0", "type": "custom", "src": "./a.jsx", "start": 0.0, "end": 5.0},
        {"id": "ov-1", "type": "custom", "src": "./b.jsx", "start": 3.0, "end": 7.0},
    ]
    data = {**VALID_PROJECT, "overlay_tracks": [items]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_no_overlap_passes_for_sequential(tmp_path):
    items = [
        {"id": "ov-0", "type": "custom", "src": "./a.jsx", "start": 0.0, "end": 3.0},
        {"id": "ov-1", "type": "custom", "src": "./b.jsx", "start": 3.0, "end": 7.0},
    ]
    data = {**VALID_PROJECT, "overlay_tracks": [items]}
    path = _write_project(tmp_path, "project.json", data)
    result = v.validate_project(path)
    assert result["valid"] is True


# ---------------------------------------------------------------------------
# validate_workflow
# ---------------------------------------------------------------------------

VALID_WORKFLOW = {
    "name": "my_workflow",
    "description": "A test workflow",
    "steps": [
        {"id": "probe",  "uses": "montaj/probe"},
        {"id": "resize", "uses": "montaj/resize", "needs": ["probe"]},
    ]
}


def _write_workflow(tmp_path, name, data):
    path = tmp_path / f"{name}.json"
    path.write_text(json.dumps(data))
    return str(path)


def test_validate_workflow_passes_valid(tmp_path):
    path = _write_workflow(tmp_path, "my_workflow", VALID_WORKFLOW)
    result = v.validate_workflow(path)
    assert result["valid"] is True


def test_validate_workflow_fails_missing_name(tmp_path):
    data = {**VALID_WORKFLOW}; del data["name"]
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_fails_name_mismatch(tmp_path):
    data = {**VALID_WORKFLOW, "name": "wrong"}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_fails_needs_unknown_step(tmp_path):
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "resize", "uses": "montaj/resize", "needs": ["does_not_exist"]}
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_detects_cycle(tmp_path):
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "a", "uses": "montaj/probe",  "needs": ["b"]},
        {"id": "b", "uses": "montaj/resize", "needs": ["a"]},
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_requires_clips_must_be_bool(tmp_path):
    data = {**VALID_WORKFLOW, "requires_clips": "yes"}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_requires_clips_optional_true(tmp_path):
    data = {**VALID_WORKFLOW, "requires_clips": True}
    path = _write_workflow(tmp_path, "my_workflow", data)
    result = v.validate_workflow(path)
    assert result["valid"] is True


def test_validate_workflow_foreach_must_be_clips(tmp_path):
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "x", "uses": "montaj/probe", "foreach": "tracks"}
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)
