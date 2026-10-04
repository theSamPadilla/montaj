"""speech_text step: a project's speech as numbered lines, written to speech-text.md."""
import json
import os
import shutil
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app
from tests.conftest import STEPS_DIR, run_step

FIX = Path(__file__).parent.parent / "fixtures" / "speech_text"
GOLDEN = FIX / "speech-text.golden.md"
SCHEMA = json.loads((Path(STEPS_DIR) / "speech" / "speech_text.json").read_text())


def fixture_copy(tmp_path):
    d = tmp_path / "fx"
    shutil.copytree(FIX, d)
    (d / "project.json").write_text((d / "project.json").read_text().replace("/FIXTURE", str(d)))
    return d


def run(d, *extra):
    proc = run_step("speech_text.py", "--project", str(d / "project.json"), *extra)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_writes_the_file_and_returns_the_golden_text(tmp_path):
    d = fixture_copy(tmp_path)
    out = run(d)
    assert out["path"] == str(d / "speech-text.md")
    assert out["text"] == GOLDEN.read_text(encoding="utf-8")
    assert (d / "speech-text.md").read_text(encoding="utf-8") == out["text"]


def test_summary_fields(tmp_path):
    d = fixture_copy(tmp_path)
    out = run(d)
    assert out["track"] == "trk-0"
    assert out["stamp"] in out["text"].splitlines()[0]
    assert out["sources"] == {"A": str(d / "speech.mp4")}
    assert out["lines"] == sum(1 for ln in out["text"].split("## Cut")[1].split("## Unused")[0].splitlines()
                               if ln[:1].isalpha() and ln.split()[0][1:].isdigit())
    assert out["lines"] > 0
    assert out["duration"] == pytest.approx(28.8, abs=0.5)
    assert out["warnings"] == []


def test_unused_none_omits_the_section(tmp_path):
    d = fixture_copy(tmp_path)
    out = run(d, "--unused", "none")
    assert "## Unused" not in out["text"]
    assert "## Unused" not in (d / "speech-text.md").read_text(encoding="utf-8")


def test_unknown_track_fails(tmp_path):
    d = fixture_copy(tmp_path)
    proc = run_step("speech_text.py", "--project", str(d / "project.json"), "--track", "nope")
    assert proc.returncode == 1
    assert json.loads(proc.stderr)["error"] == "track_not_found"


def test_no_model_param():
    assert "model" not in [p["name"] for p in SCHEMA["params"]]


def test_title_uses_project_name(tmp_path):
    d = fixture_copy(tmp_path)
    proj = json.loads((d / "project.json").read_text())
    proj["name"] = "My Talk"
    (d / "project.json").write_text(json.dumps(proj))
    out = run(d)
    lines = [ln for ln in out["text"].splitlines() if ln.strip()]
    assert lines[1] == "# My Talk"


def test_serve_resolves_a_project_id(tmp_path, monkeypatch):
    import serve.server
    ws = tmp_path / "Montaj"
    ws.mkdir()
    d = fixture_copy(ws)
    proj = json.loads((d / "project.json").read_text())
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    monkeypatch.setattr(serve.server, "HEADLESS", True)
    with TestClient(app, raise_server_exceptions=False) as client:
        resp = client.post("/api/steps/speech_text", json={"project": proj["id"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["path"] == str(d / "speech-text.md")
    assert body["text"] == GOLDEN.read_text(encoding="utf-8")
