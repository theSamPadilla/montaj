"""Tests for steps/render/sample_frame.py's --sdr-curve param (SP6b T10).

sample_frame.py is a thin proxy: it forwards --project/--at/--out to
montaj_assets/render/sample-frame.js via `node` and relays that subprocess's
stdout/stderr/exit code verbatim. Puppeteer + a real render bundle are out of
scope for a step test, so these tests shadow `node` on PATH with a fake
script that echoes the argv it received as JSON — the same "fake binary on
PATH" approach tests/conftest.py's `fake_whisper_env` uses for whisper-cpp.
That lets us assert exactly what sample_frame.py threads onto the node
command line without touching Puppeteer or ffmpeg.
"""
import json
import os
import textwrap
from pathlib import Path

import pytest

from tests.conftest import assert_error, run_step_env

STEP = "sample_frame.py"


@pytest.fixture(scope="module")
def fake_node_env(tmp_path_factory) -> dict:
    """A fake `node` on PATH that echoes its argv as a JSON array on stdout
    and exits 0. Lets tests assert exactly what sample_frame.py put on the
    node command line without invoking the real sample-frame.js/Puppeteer.
    """
    d = tmp_path_factory.mktemp("fakenode")
    fake_script = textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys, json
        print(json.dumps(sys.argv[1:]))
    """)
    node = d / "node"
    node.write_text(fake_script)
    node.chmod(0o755)

    original_path = os.environ.get("PATH", "")
    return {"PATH": f"{d}:{original_path}"}


def _write_project(tmp_path: Path, color_space: str | None) -> Path:
    """Minimal project.json — sample_frame.py's Python side only reads
    settings.colorSpace; the rest is forwarded to node untouched."""
    project = {"settings": {}} if color_space is None else {"settings": {"colorSpace": color_space}}
    path = tmp_path / "project.json"
    path.write_text(json.dumps(project))
    return path


# ── argv threading (HDR project) ────────────────────────────────────────────

def test_sdr_curve_threaded_to_node_argv_on_hdr_project(fake_node_env, tmp_path):
    """A valid --sdr-curve on an HDR project is forwarded to node as --sdr-curve <id>."""
    project = _write_project(tmp_path, "hdr_hlg")
    out = tmp_path / "frame.png"
    proc = run_step_env(
        STEP, fake_node_env,
        "--project", str(project),
        "--at", "1.0",
        "--sdr-curve", "vivid1-neutral",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    argv = json.loads(proc.stdout)
    assert "--sdr-curve" in argv
    assert argv[argv.index("--sdr-curve") + 1] == "vivid1-neutral"


def test_no_sdr_curve_flag_omitted_from_node_argv(fake_node_env, tmp_path):
    """Omitting --sdr-curve entirely leaves the node argv untouched (no flag added)."""
    project = _write_project(tmp_path, "hdr_hlg")
    out = tmp_path / "frame.png"
    proc = run_step_env(
        STEP, fake_node_env,
        "--project", str(project),
        "--at", "1.0",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    argv = json.loads(proc.stdout)
    assert "--sdr-curve" not in argv


# ── SDR project: ignored, not an error ──────────────────────────────────────

def test_sdr_curve_ignored_on_sdr_project(fake_node_env, tmp_path):
    """On an SDR project the curve is meaningless: not forwarded to node, a
    stderr warning explains why, and the step still succeeds."""
    project = _write_project(tmp_path, "sdr_bt709")
    out = tmp_path / "frame.png"
    proc = run_step_env(
        STEP, fake_node_env,
        "--project", str(project),
        "--at", "1.0",
        "--sdr-curve", "vivid1",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    argv = json.loads(proc.stdout)
    assert "--sdr-curve" not in argv

    warn = json.loads(proc.stderr.strip().splitlines()[-1])
    assert "warn" in warn
    assert "vivid1" in warn["warn"]
    assert "sdr_bt709" in warn["warn"]


def test_sdr_curve_ignored_on_project_with_no_colorspace(fake_node_env, tmp_path):
    """A project.json with no settings.colorSpace defaults to SDR (matches
    lib.types.colorspace.DEFAULT_COLOR_SPACE) — curve still gets ignored, not errored."""
    project = _write_project(tmp_path, None)
    out = tmp_path / "frame.png"
    proc = run_step_env(
        STEP, fake_node_env,
        "--project", str(project),
        "--at", "1.0",
        "--sdr-curve", "vivid1",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    argv = json.loads(proc.stdout)
    assert "--sdr-curve" not in argv
    assert "warn" in json.loads(proc.stderr.strip().splitlines()[-1])


# ── invalid curve id ─────────────────────────────────────────────────────────

def test_invalid_sdr_curve_fails_with_friendly_error(tmp_path):
    """An unknown curve id fails fast with a structured error listing valid ids
    — validated in Python against lib.look.curve_ids() before node is ever
    invoked (no fake node on PATH needed: if it fell through to a real `node`
    call this would fail differently, e.g. a missing-binary or JS-side error)."""
    project = _write_project(tmp_path, "hdr_hlg")
    out = tmp_path / "frame.png"
    proc = run_step_env(
        STEP, {},
        "--project", str(project),
        "--at", "1.0",
        "--sdr-curve", "not-a-real-curve",
        "--out", str(out),
    )
    assert_error(proc, "invalid_sdr_curve")
    assert "not-a-real-curve" in proc.stderr
    assert "vivid1" in proc.stderr  # valid ids listed in the message


def test_invalid_sdr_curve_missing_project_file_fails_cleanly(tmp_path):
    """Curve id is valid but --project points nowhere: fails with a structured
    error instead of an uncaught traceback."""
    out = tmp_path / "frame.png"
    proc = run_step_env(
        STEP, {},
        "--project", str(tmp_path / "does-not-exist.json"),
        "--at", "1.0",
        "--sdr-curve", "vivid1",
        "--out", str(out),
    )
    assert_error(proc, "file_not_found")


# ── CLI surface ──────────────────────────────────────────────────────────────

def test_sample_frame_help_lists_sdr_curve():
    """--help advertises the new flag."""
    import subprocess as sp
    import sys
    from tests.conftest import REPO_ROOT
    script = REPO_ROOT / "steps" / "render" / "sample_frame.py"
    r = sp.run([sys.executable, str(script), "--help"], capture_output=True, text=True)
    assert r.returncode == 0
    assert "--sdr-curve" in r.stdout
