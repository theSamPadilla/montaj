"""Tests for steps/waveform_trim.py"""
import json
import os
import subprocess
import sys

from tests.conftest import REPO_ROOT, run_step, assert_json_output, assert_error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from trim_spec import is_trim_spec, load as load_spec


def test_waveform_trim_outputs_trim_spec(test_video):
    proc = run_step("waveform_trim.py", "--input", str(test_video),
                    "--threshold", "-30", "--min-silence", "0.3")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    spec = json.loads(proc.stdout)
    assert "input" in spec
    assert "keeps" in spec
    assert isinstance(spec["keeps"], list)
    assert len(spec["keeps"]) > 0
    assert all(len(k) == 2 and k[1] > k[0] for k in spec["keeps"])


def test_waveform_trim_input_is_original_path(test_video):
    proc = run_step("waveform_trim.py", "--input", str(test_video))
    spec = json.loads(proc.stdout)
    assert spec["input"] == str(test_video)


def test_waveform_trim_missing_input():
    proc = run_step("waveform_trim.py", "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")


def test_waveform_trim_batch_outputs_array(test_video):
    proc = run_step("waveform_trim.py", "--inputs", str(test_video), str(test_video))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert isinstance(result, list)
    assert len(result) == 2
    for spec in result:
        assert "input" in spec and "keeps" in spec


# --- --out (FQ1.1 T8) -------------------------------------------------------

def test_waveform_trim_out_writes_file_and_prints_path(test_video, tmp_path):
    out = tmp_path / "spec.json"
    proc = run_step("waveform_trim.py", "--input", str(test_video), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"

    printed = json.loads(proc.stdout)
    assert printed == {"path": str(out)}

    assert out.exists()
    on_disk = json.loads(out.read_text())
    assert on_disk["input"] == str(test_video)
    assert isinstance(on_disk["keeps"], list) and on_disk["keeps"]


def test_waveform_trim_out_resolves_to_absolute_path(test_video, tmp_path):
    """A relative --out is resolved against cwd and reported as an absolute path."""
    step = REPO_ROOT / "steps" / "audio" / "waveform_trim.py"
    proc = subprocess.run(
        [sys.executable, str(step), "--input", str(test_video), "--out", "rel_spec.json"],
        capture_output=True, text=True, cwd=str(tmp_path),
    )
    assert proc.returncode == 0, f"stderr: {proc.stderr}"

    printed = json.loads(proc.stdout)
    expected = str(tmp_path / "rel_spec.json")
    assert printed == {"path": expected}
    assert os.path.isabs(printed["path"])
    assert os.path.isfile(expected)


def test_waveform_trim_out_file_accepted_by_rm_nonspeech_loader(test_video, tmp_path):
    """The file --out writes must be exactly what rm_nonspeech's trim-spec
    loader (lib/trim_spec.py) accepts — it is the first thing rm_nonspeech
    calls on --input before doing any work."""
    out = tmp_path / "spec.json"
    proc = run_step("waveform_trim.py", "--input", str(test_video), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    path = json.loads(proc.stdout)["path"]

    assert is_trim_spec(path)
    spec = load_spec(path)
    assert spec["input"] == str(test_video)
    assert isinstance(spec["keeps"], list) and spec["keeps"]


def test_waveform_trim_no_out_is_unchanged(test_video):
    """Without --out, stdout is still the bare trim spec — no 'path' wrapping."""
    proc = run_step("waveform_trim.py", "--input", str(test_video))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    spec = json.loads(proc.stdout)
    assert "path" not in spec
    assert "input" in spec and "keeps" in spec


def test_waveform_trim_out_with_inputs_writes_the_batch_array(test_video, tmp_path):
    """§577: serve adds --out to a project's call, so a batch call writes its array there (the same JSON it prints
    without --out) and prints {"path"}."""
    out = tmp_path / "sub" / "batch.json"
    proc = run_step("waveform_trim.py", "--inputs", str(test_video), str(test_video), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert json.loads(proc.stdout) == {"path": str(out)}
    printed = run_step("waveform_trim.py", "--inputs", str(test_video), str(test_video))
    assert json.loads(out.read_text()) == json.loads(printed.stdout)
    assert [s["input"] for s in json.loads(out.read_text())] == [str(test_video)] * 2


def test_waveform_trim_batch_through_serve_with_a_project(test_video, tmp_path, monkeypatch):
    """A project-scoped batch call through serve (which adds --out in the project's assets) runs, and its file holds
    the array."""
    import shutil
    import uuid
    from starlette.testclient import TestClient
    import serve.routes.steps as steps_mod
    from serve.server import app
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-25-batch"
    pdir.mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "tracks": []}))
    clips = [pdir / "a.mp4", pdir / "b.mp4"]
    for c in clips:
        shutil.copy(test_video, c)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    steps_mod._RESERVED_OUTS.clear()
    r = TestClient(app).post("/api/steps/waveform_trim", json={"inputs": [str(c) for c in clips], "_project": pid})
    assert r.status_code == 200, r.text
    path = r.json()["path"]
    assert path.startswith(str(pdir / "assets")) and path.endswith(".json"), path
    assert [s["input"] for s in json.loads(open(path).read())] == [str(c) for c in clips]


# --- threshold is a number (§563) --------------------------------------------

def test_waveform_trim_refuses_a_filter_graph_injection(test_video, tmp_path):
    """A threshold that would splice a file-writing filter into the -af graph fails in argparse,
    before ffmpeg runs, and the file it names is never created."""
    target = tmp_path / "written-by-ffmpeg.txt"
    proc = run_step("waveform_trim.py", "--input", str(test_video),
                    "--threshold", f"1,ametadata=mode=print:file={target},silencedetect=noise=1")
    assert proc.returncode == 2
    assert "invalid float value" in proc.stderr
    assert not target.exists()


def test_waveform_trim_takes_serve_argv_for_a_negative_threshold(test_video):
    """What serve builds for a negative threshold (one `--threshold=<n>` token) parses and runs."""
    from serve.routes.steps import build_cli_args
    schema = json.loads((REPO_ROOT / "steps" / "audio" / "waveform_trim.json").read_text())
    for value in (-30, "-3e1"):
        proc = run_step("waveform_trim.py", *build_cli_args(schema, {"input": str(test_video), "threshold": value}))
        assert proc.returncode == 0, f"{value!r}: {proc.stderr}"
        assert json.loads(proc.stdout)["keeps"]


def test_cli_waveform_trim_threshold_is_a_number():
    """`montaj waveform-trim` (and the MCP tool built from its parser) types --threshold as a number too."""
    import argparse
    import pytest
    from cli.commands import waveform_trim as cmd
    parser = argparse.ArgumentParser()
    cmd.register(parser.add_subparsers())
    assert parser.parse_args(["waveform-trim", "a.mp4", "--threshold", "-30"]).threshold == -30.0
    with pytest.raises(SystemExit):
        parser.parse_args(["waveform-trim", "a.mp4", "--threshold", "1,ametadata=mode=print:file=/x"])
