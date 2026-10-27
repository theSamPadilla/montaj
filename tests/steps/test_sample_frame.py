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


# ── --no-captions: the frame without the captions overlay ───────────────────

def test_no_captions_threaded_to_node_argv(fake_node_env, tmp_path):
    project = _write_project(tmp_path, "sdr_bt709")
    proc = run_step_env(STEP, fake_node_env, "--project", str(project), "--at", "1.0",
                        "--no-captions", "--out", str(tmp_path / "f.png"))
    assert proc.returncode == 0, proc.stderr
    assert "--no-captions" in json.loads(proc.stdout)


def test_captions_stay_on_by_default(fake_node_env, tmp_path):
    project = _write_project(tmp_path, "sdr_bt709")
    proc = run_step_env(STEP, fake_node_env, "--project", str(project), "--at", "1.0",
                        "--out", str(tmp_path / "f.png"))
    assert proc.returncode == 0, proc.stderr
    assert "--no-captions" not in json.loads(proc.stdout)


def test_schema_declares_no_captions():
    from tests.conftest import REPO_ROOT
    schema = json.loads((REPO_ROOT / "steps" / "render" / "sample_frame.json").read_text())
    p = next(p for p in schema["params"] if p["name"] == "no-captions")
    assert p["type"] == "bool" and p.get("required") is False and p.get("default") is False


# ── --scene: one 3D alone (§308) ─────────────────────────────────────────────

def test_scene_threaded_to_node_argv(fake_node_env, tmp_path):
    """--scene <id> reaches sample-frame.js as --scene <id>, with --at as given."""
    project = _write_project(tmp_path, "sdr_bt709")
    proc = run_step_env(
        STEP, fake_node_env,
        "--project", str(project), "--scene", "lab", "--at", "2.5", "--out", str(tmp_path / "s.png"),
    )
    assert proc.returncode == 0, proc.stderr
    argv = json.loads(proc.stdout)
    assert argv[argv.index("--scene") + 1] == "lab"
    assert argv[argv.index("--at") + 1] == "2.5"


def test_empty_scene_is_the_projects_own_and_is_forwarded(fake_node_env, tmp_path):
    """An empty --scene is the project's own 3D: forwarded as an empty argument, not dropped."""
    project = _write_project(tmp_path, "sdr_bt709")
    proc = run_step_env(
        STEP, fake_node_env,
        "--project", str(project), "--scene", "", "--at", "0", "--out", str(tmp_path / "s.png"),
    )
    assert proc.returncode == 0, proc.stderr
    argv = json.loads(proc.stdout)
    assert argv[argv.index("--scene") + 1] == ""


def test_no_scene_samples_the_timeline(fake_node_env, tmp_path):
    project = _write_project(tmp_path, "sdr_bt709")
    proc = run_step_env(STEP, fake_node_env, "--project", str(project), "--at", "1.0", "--out", str(tmp_path / "f.png"))
    assert proc.returncode == 0, proc.stderr
    assert "--scene" not in json.loads(proc.stdout)


def test_scene_default_out_names_the_3d(fake_node_env, tmp_path):
    project = _write_project(tmp_path, "sdr_bt709")
    for scene, name in (("lab", "3d-lab-2.5s.png"), ("", "3d-2.5s.png")):
        proc = run_step_env(STEP, fake_node_env, "--project", str(project), "--scene", scene, "--at", "2.5")
        assert proc.returncode == 0, proc.stderr
        argv = json.loads(proc.stdout)
        assert argv[argv.index("--out") + 1] == str(tmp_path / "render" / "samples" / name)


@pytest.mark.parametrize("scene", ["Lab", "../x", "a/b", "a_b", "x" * 49, "lab\n"])
def test_scene_id_is_checked_before_node(scene, tmp_path):
    """An id render would refuse fails here with a clean code (no node on PATH needed)."""
    project = _write_project(tmp_path, "sdr_bt709")
    proc = run_step_env(STEP, {}, "--project", str(project), "--scene", scene, "--at", "1", "--out", str(tmp_path / "s.png"))
    assert_error(proc, "invalid_scene")


def test_scene_time_cannot_be_negative(tmp_path):
    project = _write_project(tmp_path, "sdr_bt709")
    proc = run_step_env(STEP, {}, "--project", str(project), "--scene", "lab", "--at", "-1", "--out", str(tmp_path / "s.png"))
    assert_error(proc, "invalid_at")


def test_schema_declares_scene():
    """serve's /api/steps drops a param the step does not declare, so the schema must carry it."""
    from tests.conftest import REPO_ROOT
    schema = json.loads((REPO_ROOT / "steps" / "render" / "sample_frame.json").read_text())
    scene = next(p for p in schema["params"] if p["name"] == "scene")
    assert scene["type"] == "string" and scene.get("required") is False


# ── several times: one node call, one labelled sheet ─────────────────────────

@pytest.fixture(scope="module")
def frames_node_env(tmp_path_factory) -> dict:
    """A fake `node` that logs its argv (one JSON line per call) and, given
    --frames-dir, writes a solid PNG per --at and prints each path."""
    d = tmp_path_factory.mktemp("framesnode")
    log = d / "calls.jsonl"
    node = d / "node"
    node.write_text(textwrap.dedent(f"""\
        #!{__import__('sys').executable}
        import sys, json, os
        from PIL import Image
        a = sys.argv[1:]
        open({str(log)!r}, "a").write(json.dumps(a) + "\\n")
        if "--frames-dir" in a:
            fd = a[a.index("--frames-dir") + 1]
            os.makedirs(fd, exist_ok=True)
            n = a.count("--at")
            if os.environ.get("FAKE_SPACE"):
                fd = os.path.join(fd, "John Smith")
                os.makedirs(fd, exist_ok=True)
            if os.environ.get("FAKE_SHORT"):
                n -= 1
            for i in range(n):
                p = os.path.join(fd, "f_%04d.png" % i)
                Image.new("RGB", (640, 360), (i * 20, 0, 0)).save(p)
                print(p)
    """))
    node.chmod(0o755)
    return {"PATH": f"{d}:{os.environ.get('PATH', '')}", "FAKE_LOG": str(log)}


def _calls(env):
    p = Path(env["FAKE_LOG"])
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


def test_several_times_make_one_node_call_and_one_sheet(frames_node_env, tmp_path):
    from PIL import Image
    project = _write_project(tmp_path, None)
    before = len(_calls(frames_node_env))
    proc = run_step_env(STEP, frames_node_env, "--project", str(project),
                        "--at", "1", "--at", "2.5", "--at", "4")
    assert proc.returncode == 0, proc.stderr
    calls = _calls(frames_node_env)[before:]
    assert len(calls) == 1
    argv = calls[0]
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "--at"] == ["1.0", "2.5", "4.0"]
    assert "--frames-dir" in argv and "--out" not in argv
    out = proc.stdout.strip()
    assert out == str(tmp_path / "render" / "samples" / "sheet-1.0-4.0s.png")
    img = Image.open(out)
    assert 1272 <= img.size[0] <= 1280  # the shared look layout (lib/sheet.look_sheet): 1280 px wide


def test_several_times_forward_no_captions(frames_node_env, tmp_path):
    project = _write_project(tmp_path, None)
    before = len(_calls(frames_node_env))
    proc = run_step_env(STEP, frames_node_env, "--project", str(project), "--no-captions",
                        "--at", "1", "--at", "2")
    assert proc.returncode == 0, proc.stderr
    assert "--no-captions" in _calls(frames_node_env)[before:][0]


def test_several_times_name_raw_and_scene_sheets(frames_node_env, tmp_path):
    project = _write_project(tmp_path, None)
    raw = run_step_env(STEP, frames_node_env, "--project", str(project), "--raw", "--at", "1", "--at", "2")
    assert raw.stdout.strip().endswith("sheet-1.0-2.0s-raw.png"), raw.stderr
    s = run_step_env(STEP, frames_node_env, "--project", str(project), "--scene", "rig", "--at", "1", "--at", "2")
    assert s.stdout.strip().endswith("3d-rig-sheet-1.0-2.0s.png"), s.stderr
    own = run_step_env(STEP, frames_node_env, "--project", str(project), "--scene", "", "--at", "1", "--at", "2")
    assert own.stdout.strip().endswith("3d-sheet-1.0-2.0s.png"), own.stderr


def test_several_times_go_to_out_when_given(frames_node_env, tmp_path):
    project = _write_project(tmp_path, None)
    out = tmp_path / "mine.png"
    proc = run_step_env(STEP, frames_node_env, "--project", str(project),
                        "--at", "1", "--at", "2", "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == str(out) and out.is_file()


def test_more_than_the_cap_of_times_is_refused(frames_node_env, tmp_path):
    project = _write_project(tmp_path, None)
    args = [x for i in range(121) for x in ("--at", str(i))]
    proc = run_step_env(STEP, frames_node_env, "--project", str(project), *args)
    assert proc.returncode != 0
    assert "invalid_args" in proc.stderr and "120" in proc.stderr


def test_every_time_is_validated_with_a_scene(tmp_path):
    project = _write_project(tmp_path, None)
    proc = run_step_env(STEP, {}, "--project", str(project), "--scene", "rig", "--at", "1", "--at", "-2")
    assert proc.returncode != 0 and "invalid_at" in proc.stderr
    proc = run_step_env(STEP, {}, "--project", str(project), "--raw", "--scene", "rig", "--at", "1", "--at", "2")
    assert proc.returncode != 0 and "invalid_args" in proc.stderr


def test_frame_paths_with_spaces_are_kept_whole(frames_node_env, tmp_path):
    project = _write_project(tmp_path, None)
    proc = run_step_env(STEP, {**frames_node_env, "FAKE_SPACE": "1"}, "--project", str(project),
                        "--at", "1", "--at", "2")
    assert proc.returncode == 0, proc.stderr
    assert Path(proc.stdout.strip()).is_file()


def test_wrong_number_of_frame_paths_fails_naming_both(frames_node_env, tmp_path):
    project = _write_project(tmp_path, None)
    proc = run_step_env(STEP, {**frames_node_env, "FAKE_SHORT": "1"}, "--project", str(project),
                        "--at", "1", "--at", "2", "--at", "3")
    assert proc.returncode != 0
    assert "sample_failed" in proc.stderr and "expected 3" in proc.stderr and "got 2" in proc.stderr
