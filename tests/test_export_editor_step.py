"""steps/render/export_editor: schema, argument handling and relaying.

The step is a thin proxy over render/export-editor.js. A real export needs
Puppeteer and ffmpeg and is covered by the Node test
(montaj_assets/render/test/export-editor.integration.test.mjs); here `node` is
shadowed on PATH by a fake that records its argv, so we assert exactly what the
step puts on the command line and how it relays progress, results and errors.
"""
import json
import os
import textwrap
from pathlib import Path

import pytest

from serve.routes.steps import STEP_TIMEOUT_S, _step_timeout, resolve_project_param
from tests.conftest import STEPS_DIR, assert_error, run_step_env

STEP = "export_editor.py"
SCHEMA_PATH = Path(STEPS_DIR) / "render" / "export_editor.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text())


def _fake_node(tmp_path, body: str) -> dict:
    d = tmp_path / "fakenode"
    d.mkdir(exist_ok=True)
    node = d / "node"
    node.write_text("#!/usr/bin/env python3\nimport sys, json\n" + textwrap.dedent(body))
    node.chmod(0o755)
    return {"PATH": f"{d}:{os.environ.get('PATH', '')}"}


ECHO = """\
    sys.stderr.write(json.dumps({"progress": {"done": 1, "total": 2, "label": "ramp"}}) + "\\n")
    sys.stderr.write(json.dumps({"progress": {"done": 2, "total": 2, "label": "captions"}}) + "\\n")
    print(json.dumps({"argv": sys.argv[1:], "root": __import__("os").environ.get("MONTAJ_ROOT")}))
"""


def _project(tmp_path, **fields) -> Path:
    path = tmp_path / "project.json"
    path.write_text(json.dumps({"id": "p-1", "tracks": [], **fields}))
    return path


def test_schema_has_the_fields_serve_and_the_tool_layer_read():
    # engine/validate_step rejects the `path` param type and `none` input that
    # every project step (sample_frame, contact_sheet, generate_captions) uses,
    # so the structure is checked here against what serve actually reads.
    schema = SCHEMA
    assert schema["name"] == SCHEMA_PATH.stem == "export_editor"
    assert schema["description"].strip()
    assert schema["output"]["type"] == "json"
    assert all({"name", "type", "description"} <= set(p) for p in schema["params"])
    params = {p["name"]: p for p in schema["params"]}
    assert set(params) == {"project", "editor", "name", "out"}
    assert params["editor"]["type"] == "enum" and params["editor"]["options"] == ["premiere", "resolve", "ae"]
    assert params["project"]["type"] == "path" and params["project"]["required"] is True
    assert params["name"]["required"] is False and params["out"]["required"] is False
    assert schema["output"]["type"] == "json"


def test_a_project_id_resolves_to_its_project_json(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-02-demo"
    pdir.mkdir(parents=True)
    (pdir / "project.json").write_text(json.dumps({"id": "abc-123", "tracks": []}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    body = {"project": "abc-123"}
    resolve_project_param(SCHEMA, body)
    assert body["project"] == str(pdir / "project.json")


def test_the_step_has_a_longer_ceiling_than_the_flat_one():
    assert _step_timeout(SCHEMA, {}) == max(STEP_TIMEOUT_S, SCHEMA["timeout_s"])
    assert _step_timeout({"params": []}, {}) == STEP_TIMEOUT_S


def test_name_defaults_to_the_projects_name(tmp_path):
    env = _fake_node(tmp_path, ECHO)
    proc = run_step_env(STEP, env, "--project", str(_project(tmp_path, name="My Reel")))
    assert proc.returncode == 0, proc.stderr
    argv = json.loads(proc.stdout)["argv"]
    assert argv[1:5] == ["--project", str(tmp_path / "project.json"), "--name", "My Reel"]
    assert argv[0].endswith("export-editor.js")
    assert "--out" not in argv


def test_name_falls_back_to_the_project_id(tmp_path):
    env = _fake_node(tmp_path, ECHO)
    proc = run_step_env(STEP, env, "--project", str(_project(tmp_path)))
    assert json.loads(proc.stdout)["argv"][4] == "p-1"


def test_explicit_name_and_out_are_passed_through(tmp_path):
    env = _fake_node(tmp_path, ECHO)
    proc = run_step_env(STEP, env, "--project", str(_project(tmp_path, name="Ignored")),
                        "--name", " Final ", "--out", "/x/y")
    argv = json.loads(proc.stdout)["argv"]
    assert argv[3:] == ["--name", "Final", "--out", "/x/y"]


def test_montaj_root_is_set_for_the_child(tmp_path):
    env = _fake_node(tmp_path, ECHO)
    proc = run_step_env(STEP, env, "--project", str(_project(tmp_path)))
    root = json.loads(proc.stdout)["root"]
    assert (Path(root) / "steps" / "render" / "export_editor.py").is_file()


def test_progress_lines_are_relayed_to_stderr_and_stdout_is_the_result(tmp_path):
    env = _fake_node(tmp_path, ECHO)
    proc = run_step_env(STEP, env, "--project", str(_project(tmp_path)))
    lines = [json.loads(l) for l in proc.stderr.strip().splitlines()]
    assert [l["progress"]["done"] for l in lines] == [1, 2]
    assert len(proc.stdout.strip().splitlines()) == 1


def test_the_cli_error_is_relayed_and_the_exit_code_kept(tmp_path):
    env = _fake_node(tmp_path, """\
        sys.stderr.write(json.dumps({"error": "invalid_project", "message": "bad json"}) + "\\n")
        sys.exit(1)
    """)
    proc = run_step_env(STEP, env, "--project", str(_project(tmp_path)))
    assert_error(proc, "invalid_project")
    assert proc.stdout == ""


def test_a_crash_without_an_error_line_still_fails_structured(tmp_path):
    env = _fake_node(tmp_path, "    sys.exit(3)\n")
    proc = run_step_env(STEP, env, "--project", str(_project(tmp_path)))
    assert_error(proc, "export_failed")


def test_a_missing_project_file_is_a_structured_error(tmp_path):
    proc = run_step_env(STEP, {}, "--project", str(tmp_path / "nope.json"))
    assert_error(proc, "file_not_found")
