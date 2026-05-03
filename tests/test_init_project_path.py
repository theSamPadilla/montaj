"""Tests for project/init.py's --project-path flag (Task A of 2026-05-02-workspace-paths).

Exercises path validation, directory placement, and orthogonality with --name.
Subprocess-driven to match the existing test_init.py style.
"""
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
INIT_PY   = str(REPO_ROOT / "project" / "init.py")


def run_init(*args, env_override=None):
    e = {**os.environ, **(env_override or {})}
    return subprocess.run(
        [sys.executable, INIT_PY, *args],
        capture_output=True, text=True, env=e,
    )


def _project_path_from_stdout(stdout: str) -> Path:
    lines = [ln for ln in stdout.strip().split("\n") if ln.strip()]
    return Path(lines[-1])


# ---------------------------------------------------------------------------
# Happy-path placements
# ---------------------------------------------------------------------------

def test_flat_project_path_creates_dir(tmp_path):
    """--project-path=my-proj creates <tmp>/my-proj/."""
    result = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", "my-proj",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    project_json = _project_path_from_stdout(result.stdout)
    assert project_json == tmp_path / "my-proj" / "project.json"
    assert (tmp_path / "my-proj").is_dir()
    assert project_json.is_file()


def test_nested_project_path_creates_intermediate_dir(tmp_path):
    """--project-path=teamA/sub creates <tmp>/teamA/sub/ and parent on demand."""
    result = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", "teamA/sub",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    project_json = _project_path_from_stdout(result.stdout)
    assert project_json == tmp_path / "teamA" / "sub" / "project.json"
    assert (tmp_path / "teamA").is_dir()
    assert (tmp_path / "teamA" / "sub").is_dir()


def test_parent_exists_leaf_doesnt_succeeds(tmp_path):
    """Pre-create teamA/, then --project-path=teamA/sub-proj must succeed
    without erroring on the existing teamA/. This is Hub's expected pattern
    for adding a second project under the same Org subdir."""
    (tmp_path / "teamA").mkdir()

    result = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", "teamA/sub-proj",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "teamA" / "sub-proj" / "project.json").is_file()


def test_two_projects_under_same_parent_succeed(tmp_path):
    """teamA/proj-1 and teamA/proj-2 both create successfully — parent
    auto-creation must not blow up on second call."""
    r1 = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", "teamA/proj-1",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert r1.returncode == 0, r1.stderr
    r2 = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", "teamA/proj-2",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert r2.returncode == 0, r2.stderr
    assert (tmp_path / "teamA" / "proj-1" / "project.json").is_file()
    assert (tmp_path / "teamA" / "proj-2" / "project.json").is_file()


# ---------------------------------------------------------------------------
# Error: target leaf already exists
# ---------------------------------------------------------------------------

def test_existing_target_dir_raises_project_path_exists(tmp_path):
    """If the exact target leaf already exists, init must fail with
    project_path_exists — never silently land elsewhere."""
    (tmp_path / "already-here").mkdir()
    result = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", "already-here",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode != 0
    err = json.loads(result.stderr)
    assert err["error"] == "project_path_exists"


def test_double_create_same_path_second_fails(tmp_path):
    """Re-running with the same --project-path errors on the second call."""
    r1 = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", "abc",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert r1.returncode == 0, r1.stderr

    r2 = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", "abc",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert r2.returncode != 0
    err = json.loads(r2.stderr)
    assert err["error"] == "project_path_exists"


# ---------------------------------------------------------------------------
# Validator rejection cases
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad_path,reason", [
    ("",                 "empty string"),
    ("/abs/path",        "leading slash"),
    ("foo/../bar",       "dotdot segment"),
    ("..",               "single-dot-dot path"),
    ("team A/proj",      "space in segment"),
    ("foo!",             "special char"),
    ("foo//bar",         "empty segment between slashes"),
    ("foo/",             "trailing slash → empty segment"),
])
def test_invalid_project_path_rejected(tmp_path, bad_path, reason):
    """Validator rejects unsafe relative paths with invalid_project_path."""
    result = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", bad_path,
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode != 0, f"{reason}: expected failure but got success"
    # stderr should be a structured JSON error with the validator's code
    err = json.loads(result.stderr)
    assert err["error"] == "invalid_project_path", f"{reason}: got {err['error']}"


def test_single_dot_segment_rejected(tmp_path):
    """A single '.' is not in [A-Za-z0-9_-], so SAFE_NAME rejects it."""
    result = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--project-path", ".",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode != 0
    err = json.loads(result.stderr)
    assert err["error"] == "invalid_project_path"


# ---------------------------------------------------------------------------
# Absent flag preserves existing behavior
# ---------------------------------------------------------------------------

def test_absent_flag_preserves_date_slug_naming(tmp_path):
    """--name without --project-path → <date>-<slug> directory."""
    result = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--name", "My Cool Project",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    project_json = _project_path_from_stdout(result.stdout)
    today = datetime.now().strftime("%Y-%m-%d")
    assert project_json.parent.name == f"{today}-my-cool-project"
    assert project_json.parent.parent == tmp_path


def test_absent_flag_no_name_uses_date_hhmmss(tmp_path):
    """No flags → <date>-<HHMMSS> directory."""
    result = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    project_json = _project_path_from_stdout(result.stdout)
    today = datetime.now().strftime("%Y-%m-%d")
    # Directory name format: <YYYY-MM-DD>-<HHMMSS> → 17 chars.
    name = project_json.parent.name
    assert name.startswith(today + "-")
    suffix = name[len(today) + 1:]
    assert len(suffix) == 6 and suffix.isdigit(), f"expected HHMMSS suffix, got {suffix!r}"


# ---------------------------------------------------------------------------
# --name and --project-path are orthogonal
# ---------------------------------------------------------------------------

def test_name_and_project_path_are_orthogonal(tmp_path):
    """--name controls project.json['name'], --project-path controls dir."""
    result = run_init(
        "--canvas", "--prompt", "test", "--workflow", "clean_cut",
        "--name", "Display Name",
        "--project-path", "abc-uuid",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    project_json = _project_path_from_stdout(result.stdout)
    assert project_json == tmp_path / "abc-uuid" / "project.json"
    project = json.loads(project_json.read_text())
    assert project["name"] == "Display Name"
