"""§631: `init --adopt-seed` turns a seed project into the real project in place.

A seed is the empty `blank` project the app makes when a person records with no
project: `seed: true`, `status: "draft"`, and the takes as `sources`. Picking a
template later must make THAT folder the project (same id, same folder, takes
untouched) rather than a new one. Run in process, as test_init_failed_create does.
"""
import hashlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

import project.init as init_mod
from tests.conftest import HAS_FFMPEG, FFMPEG_BIN

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


@pytest.fixture()
def ws(tmp_path, monkeypatch):
    w = (tmp_path / "ws").resolve()
    w.mkdir()
    home = (tmp_path / "home").resolve()
    home.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(w))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    return w


def _make_clip(path: Path, *, width=320, height=240, fps=30):
    subprocess.run([
        FFMPEG_BIN, "-v", "error", "-y",
        "-f", "lavfi", "-i", f"color=red:size={width}x{height}:rate={fps}:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(path),
    ], check=True, capture_output=True, timeout=60)


def _run(monkeypatch, capsys, *args):
    """init's main() in process: (exception or None, stdout, stderr)."""
    monkeypatch.setattr(sys, "argv", ["init.py", *args])
    exc = None
    try:
        init_mod.main()
    except BaseException as e:  # noqa: BLE001 - fail() raises SystemExit
        exc = e
    out = capsys.readouterr()
    return exc, out.out, out.err


def _error_code(err: str) -> str:
    return json.loads([ln for ln in err.splitlines() if '"error"' in ln][-1])["error"]


def _hashes(folder: Path, *, skip_git=False) -> dict:
    out = {}
    for root, dirs, files in os.walk(folder):
        if skip_git:
            dirs[:] = [d for d in dirs if d != ".git"]
        for name in files:
            p = Path(root) / name
            rel = str(p.relative_to(folder))
            out[rel] = "link:" + os.readlink(p) if p.is_symlink() else hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def _make_seed(ws, tmp_path, monkeypatch, capsys, **extra):
    """A seed as the app makes one: blank init with --id, then seed/status merged
    in and the takes ingested as sources (one absolute src, one relative, extra
    fields, a non-clip id). Returns (folder, id)."""
    seed_id = str(uuid.uuid4())
    exc, out, err = _run(monkeypatch, capsys, "--prompt", "", "--workflow", "blank", "--id", seed_id)
    assert exc is None, err
    folder = Path(out.strip().splitlines()[-1]).parent
    take_a = folder / "take-a.mp4"
    _make_clip(take_a, width=240, height=320, fps=24)       # portrait, 24 fps
    (folder / "take-b.m4a").write_bytes(b"not really audio")  # fails to probe: skipped
    (folder / "take-a.json").write_text('{"words": []}')      # a file keyed by source id
    pj = folder / "project.json"
    project = json.loads(pj.read_text())
    project.update({
        "seed": True,
        "status": "draft",
        "sources": [
            {"id": "clip-0", "type": "video", "src": str(take_a), "start": 0.0, "end": 0.0,
             "sourceDuration": 1.0, "recordedLine": 3, "proxySrc": None},
            {"id": "take-b", "type": "audio", "src": "take-b.m4a", "kind": "take"},
        ],
        "recorder": {"script": "hello"},
        **extra,
    })
    pj.write_text(json.dumps(project, indent=2))
    return folder, seed_id


def _adopt(monkeypatch, capsys, seed_id, *args, workflow="overlays"):
    return _run(monkeypatch, capsys, "--prompt", "make it good", "--workflow", workflow,
                "--id", seed_id, "--adopt-seed", "--normalize", "lazy", "--no-proxy", *args)


def test_promote_with_no_new_clips_keeps_the_folder_and_the_takes(ws, tmp_path, monkeypatch, capsys):
    folder, seed_id = _make_seed(ws, tmp_path, monkeypatch, capsys)
    seed = json.loads((folder / "project.json").read_text())
    takes_before = _hashes(folder, skip_git=True)
    takes_before.pop("project.json")

    exc, out, err = _adopt(monkeypatch, capsys, seed_id)
    assert exc is None, err
    assert Path(out.strip().splitlines()[-1]) == folder / "project.json"
    assert [p.name for p in ws.iterdir()] == [folder.name]       # no new folder

    project = json.loads((folder / "project.json").read_text())
    assert project["id"] == seed_id
    assert project["sources"] == seed["sources"]                   # verbatim, same order
    assert "seed" not in project
    assert project["workflow"] == "overlays"
    assert project["editingPrompt"] == "make it good"
    assert project["projectType"] == "editing"
    assert project["status"] == "pending"
    assert project["recorder"] == {"script": "hello"}              # an unknown key is kept
    # The canvas and fps come from the take, which is a source, not a new clip.
    assert project["settings"]["resolution"] == [240, 320]
    assert project["settings"]["fps"] == 24
    after = _hashes(folder, skip_git=True)
    after.pop("project.json")
    assert after == takes_before                                    # takes untouched, nothing added
    log = subprocess.run(["git", "log", "--format=%s"], cwd=folder, capture_output=True, text=True).stdout
    assert log.splitlines() == ["init: new project", "init: new project"]


def test_the_seed_name_and_profile_stay_unless_given(ws, tmp_path, monkeypatch, capsys):
    folder, seed_id = _make_seed(ws, tmp_path, monkeypatch, capsys, name="My take", profile="sam")
    monkeypatch.setattr(init_mod, "build_profile_snapshot", lambda _p: None)
    exc, _, err = _adopt(monkeypatch, capsys, seed_id)
    assert exc is None, err
    project = json.loads((folder / "project.json").read_text())
    assert project["name"] == "My take"
    assert project["profile"] == "sam"


def test_promote_with_a_new_clip_appends_it_with_a_free_id(ws, tmp_path, monkeypatch, capsys):
    folder, seed_id = _make_seed(ws, tmp_path, monkeypatch, capsys)
    seed = json.loads((folder / "project.json").read_text())
    new_clip = tmp_path / "broll.mp4"
    _make_clip(new_clip)

    exc, _, err = _adopt(monkeypatch, capsys, seed_id, "--clips", str(new_clip))
    assert exc is None, err
    project = json.loads((folder / "project.json").read_text())
    assert project["sources"][:2] == seed["sources"]
    [added] = project["sources"][2:]
    assert added["id"] == "clip-1"                                  # clip-0 is a take's
    assert Path(added["src"]).parent == folder
    assert Path(added["src"]).read_bytes() == new_clip.read_bytes()
    assert added["sourceDuration"] > 0


@pytest.mark.parametrize("case", ["not_a_seed", "track_item", "track_item_list_shape", "asset",
                                  "audio_track", "voiceover", "carousel", "ai_video",
                                  "missing_id", "unknown_id", "project_path"])
def test_refusals_leave_the_folder_byte_identical(ws, tmp_path, monkeypatch, capsys, case):
    extra = {
        "not_a_seed": {"seed": False},
        "track_item": {"tracks": [{"id": "trk-0", "items": [{"id": "i1", "type": "video"}]}]},
        "track_item_list_shape": {"tracks": [[], [{"id": "i1", "type": "video"}]]},
        "asset": {"assets": [{"id": "asset-0", "src": "x.png"}]},
        "audio_track": {"audio": {"tracks": [{"id": "a"}]}},
        "voiceover": {"voiceover": {"src": "vo.wav"}},
    }.get(case, {})
    folder, seed_id = _make_seed(ws, tmp_path, monkeypatch, capsys, **extra)
    new_clip = tmp_path / "broll.mp4"
    _make_clip(new_clip)
    before = _hashes(folder)

    if case in ("carousel", "ai_video"):
        exc, _, err = _adopt(monkeypatch, capsys, seed_id, "--clips", str(new_clip), workflow=case)
        expected = "adopt_unsupported"
    elif case == "missing_id":
        exc, _, err = _run(monkeypatch, capsys, "--prompt", "p", "--adopt-seed", "--clips", str(new_clip))
        expected = "adopt_needs_id"
    elif case == "unknown_id":
        exc, _, err = _adopt(monkeypatch, capsys, str(uuid.uuid4()), "--clips", str(new_clip))
        expected = "adopt_not_found"
    elif case == "project_path":
        exc, _, err = _adopt(monkeypatch, capsys, seed_id, "--project-path", "x", "--clips", str(new_clip))
        expected = "mutually_exclusive"
    else:
        exc, _, err = _adopt(monkeypatch, capsys, seed_id, "--clips", str(new_clip))
        expected = "adopt_refused"

    assert isinstance(exc, SystemExit) and exc.code == 1
    assert _error_code(err) == expected
    assert _hashes(folder) == before                                # .git included
    assert [p.name for p in ws.iterdir()] == [folder.name]


def test_a_failure_after_the_copy_removes_only_the_copy(ws, tmp_path, monkeypatch, capsys):
    folder, seed_id = _make_seed(ws, tmp_path, monkeypatch, capsys)
    new_clip = tmp_path / "broll.mp4"
    _make_clip(new_clip)
    before = _hashes(folder, skip_git=True)

    real, calls, seen = init_mod._read_project_type, [], []

    def read_type(workflow):        # the second read runs after every file is copied in
        calls.append(workflow)
        if len(calls) == 2:
            seen.extend(p.name for p in folder.iterdir())
            init_mod.fail("boom", "no")
        return real(workflow)
    monkeypatch.setattr(init_mod, "_read_project_type", read_type)

    exc, _, err = _adopt(monkeypatch, capsys, seed_id, "--clips", str(new_clip))
    assert isinstance(exc, SystemExit) and exc.code == 1
    assert _error_code(err) == "boom"
    assert "broll.mp4" in seen                                      # it was copied in
    assert folder.is_dir()
    assert _hashes(folder, skip_git=True) == before                 # copy gone, rest untouched
    assert new_clip.is_file()


def test_a_failed_commit_puts_the_seed_project_json_back(ws, tmp_path, monkeypatch, capsys):
    folder, seed_id = _make_seed(ws, tmp_path, monkeypatch, capsys)
    new_clip = tmp_path / "broll.mp4"
    _make_clip(new_clip)
    before = _hashes(folder, skip_git=True)
    real_git = init_mod.git

    def git(args, cwd):
        if args and args[0] == "commit":
            raise RuntimeError("commit failed")
        return real_git(args, cwd)
    monkeypatch.setattr(init_mod, "git", git)

    exc, _, _ = _adopt(monkeypatch, capsys, seed_id, "--clips", str(new_clip))
    assert isinstance(exc, RuntimeError)
    assert _hashes(folder, skip_git=True) == before
    assert json.loads((folder / "project.json").read_text())["seed"] is True
    staged = subprocess.run(["git", "diff", "--cached", "--name-only"], cwd=folder,
                            capture_output=True, text=True).stdout
    assert staged.strip() == ""


def test_project_json_as_a_symlink_is_refused(ws, tmp_path, monkeypatch, capsys):
    folder, seed_id = _make_seed(ws, tmp_path, monkeypatch, capsys)
    real = tmp_path / "elsewhere.json"
    pj = folder / "project.json"
    real.write_bytes(pj.read_bytes())
    pj.unlink()
    pj.symlink_to(real)
    before = _hashes(folder)
    target_before = real.read_bytes()

    exc, _, err = _adopt(monkeypatch, capsys, seed_id)
    # find_project_dir reads through the link and finds the folder; the adopt refuses it.
    assert isinstance(exc, SystemExit) and exc.code == 1
    assert _error_code(err) == "adopt_refused"
    assert _hashes(folder) == before
    assert real.read_bytes() == target_before


def test_the_atomic_writer_refuses_a_symlink(tmp_path):
    target = tmp_path / "t.json"
    target.write_text("{}")
    link = tmp_path / "project.json"
    link.symlink_to(target)
    with pytest.raises(OSError):
        init_mod._replace_project_json(str(link), {"a": 1})
    assert target.read_text() == "{}"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["project.json", "t.json"]  # no temp left


def test_the_atomic_writer_retries_a_held_file(tmp_path, monkeypatch):
    pj = tmp_path / "project.json"
    pj.write_text("{}")
    real, calls = os.replace, []

    def flaky(src, dst):
        calls.append(dst)
        if len(calls) < 3:
            raise PermissionError(13, "held open", dst)
        return real(src, dst)
    monkeypatch.setattr(init_mod.os, "replace", flaky)
    monkeypatch.setattr(init_mod.time, "sleep", lambda _s: None)
    data = init_mod._replace_project_json(str(pj), {"a": 1})
    assert pj.read_bytes() == data == json.dumps({"a": 1}, indent=2).encode("utf-8")
    assert len(calls) == 3
