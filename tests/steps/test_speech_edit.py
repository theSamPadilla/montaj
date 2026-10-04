"""speech_edit step: apply an edited speech text (the file speech_text wrote) to a project."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from serve.server import app
from tests.conftest import STEPS_DIR, run_step

FIX = Path(__file__).parent.parent / "fixtures" / "speech_text"
SCHEMA = json.loads((Path(STEPS_DIR) / "speech" / "speech_edit.json").read_text())
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]


def git(d, *args):
    return subprocess.run([*GIT, *args], cwd=d, capture_output=True, text=True, check=True).stdout


def fixture_copy(tmp_path):
    d = tmp_path / "fx"
    shutil.copytree(FIX, d)
    (d / "project.json").write_text((d / "project.json").read_text().replace("/FIXTURE", str(d)))
    git(d, "init", "-q")
    git(d, "add", "project.json")
    git(d, "commit", "-q", "-m", "init")
    return d


def read_text(d):
    proc = run_step("speech_text.py", "--project", str(d / "project.json"))
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)["text"]


def delete_line(d, prefix="A4"):
    lines = read_text(d).split("\n")
    kept = [ln for ln in lines if not ln.startswith(prefix + " ")]
    assert len(kept) == len(lines) - 1
    (d / "speech-text.md").write_text("\n".join(kept), encoding="utf-8")


def edit(d, *extra):
    return run_step("speech_edit.py", "--project", str(d / "project.json"),
                    "--text", str(d / "speech-text.md"), *extra)


def test_deleting_a_line_applies(tmp_path):
    d = fixture_copy(tmp_path)
    before = (d / "project.json").read_bytes()
    delete_line(d)
    proc = edit(d)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["applied"] is True
    assert "A4" in json.dumps(out["cut"])
    assert (d / "project.json").read_bytes() != before


def test_preview_changes_nothing(tmp_path):
    d = fixture_copy(tmp_path)
    delete_line(d)
    before = (d / "project.json").read_bytes()
    n = git(d, "rev-list", "--count", "HEAD")
    proc = edit(d, "--preview")
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["applied"] is False and out["preview"] is True
    assert "A4" in json.dumps(out["cut"])
    assert (d / "project.json").read_bytes() == before
    assert git(d, "rev-list", "--count", "HEAD") == n


def test_max_pause_reaches_apply(tmp_path):
    d = fixture_copy(tmp_path)
    delete_line(d)
    proc = edit(d, "--preview", "--max-pause", "0.3")
    assert proc.returncode == 0, proc.stderr


def test_no_change_is_a_noop(tmp_path):
    d = fixture_copy(tmp_path)
    (d / "speech-text.md").write_text(read_text(d), encoding="utf-8")
    proc = edit(d)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["applied"] is False and out["noop"] is True
    assert out["clamped"] == [] and out["hardCuts"] == 0 and out["warnings"] == []


def test_changed_word_fails_and_leaves_project_alone(tmp_path):
    d = fixture_copy(tmp_path)
    lines = read_text(d).split("\n")
    i = next(i for i, ln in enumerate(lines) if ln.startswith("A1 "))
    toks = lines[i].split(" ")
    toks[1] = "zzzxqv"
    lines[i] = " ".join(toks)
    (d / "speech-text.md").write_text("\n".join(lines), encoding="utf-8")
    before = (d / "project.json").read_bytes()
    proc = edit(d)
    assert proc.returncode == 1
    assert json.loads(proc.stderr)["error"] == "changed_words"
    assert (d / "project.json").read_bytes() == before


def test_missing_text_file_fails(tmp_path):
    d = fixture_copy(tmp_path)
    proc = run_step("speech_edit.py", "--project", str(d / "project.json"), "--text", str(d / "nope.md"))
    assert proc.returncode == 1
    assert json.loads(proc.stderr)["error"] == "not_found"


def test_no_model_param():
    from tests.steps.test_speech_text import SCHEMA as TEXT_SCHEMA
    for s in (SCHEMA, TEXT_SCHEMA):
        assert "model" not in [p["name"] for p in s["params"]]


def test_serve_resolves_a_project_id(tmp_path, monkeypatch):
    import serve.server
    ws = tmp_path / "Montaj"
    ws.mkdir()
    d = fixture_copy(ws)
    proj = json.loads((d / "project.json").read_text())
    delete_line(d)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    monkeypatch.setattr(serve.server, "HEADLESS", True)
    with TestClient(app, raise_server_exceptions=False) as client:
        resp = client.post("/api/steps/speech_edit",
                           json={"project": proj["id"], "text": str(d / "speech-text.md"), "preview": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["preview"] is True and "A4" in json.dumps(body["cut"])
