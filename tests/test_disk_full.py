"""§541: a full disk is one plain sentence, never a traceback or "Internal Server Error".

The incident (2026-10-22): a new project with 13 videos on a full disk. The upload
answered a bare 500 ("Internal Server Error"), and the retry answered init's
Python traceback (OSError: [Errno 28] No space left on device, in shutil.copy2).

Now: lib/disk_space.py recognises a full disk (ENOSPC, a quota, Windows' codes)
and serve answers HTTP 507 `{"detail": {"error": "disk_full", "message", "needed",
"free", "path"}}`. A write that fails part way removes what it half wrote (and
nothing that was there before), a create that fails removes its half-made
project folder, and a write whose size is known is refused before anything is
written when it would not fit. A CLI or step prints its one JSON error line.
"""
import errno
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import lib.disk_space as disk_space
import project.init as init_mod
import serve.routes.projects as projects_mod
from serve.server import app

REPO_ROOT = Path(__file__).resolve().parent.parent
GIB = 1024 ** 3


def _enospc(*_a, **_k):
    raise OSError(errno.ENOSPC, "No space left on device")


def _free(monkeypatch, free, total=500 * GIB):
    monkeypatch.setattr(disk_space.shutil, "disk_usage",
                        lambda _p: types.SimpleNamespace(total=total, used=total - free, free=free))


@pytest.fixture()
def ws(tmp_path, monkeypatch):
    w = (tmp_path / "ws").resolve()
    w.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(w))
    return w


@pytest.fixture()
def client(ws):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _project(folder: Path, pid: str) -> Path:
    folder.mkdir(parents=True)
    (folder / "project.json").write_text(json.dumps({"id": pid, "version": "0.2", "tracks": []}))
    return folder


def _disk_full(r, status=507):
    assert r.status_code == status, r.text
    d = r.json()["detail"]
    assert d["error"] == "disk_full"
    assert d["message"].startswith("Not enough disk space.")
    assert "Traceback" not in d["message"] and "Errno" not in d["message"]
    return d


# ---------------------------------------------------------------------------
# The helper
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("exc", [
    OSError(errno.ENOSPC, "No space left on device"),
    OSError(errno.EDQUOT, "Disk quota exceeded"),
    IOError(errno.ENOSPC, "No space left on device"),
])
def test_disk_full_errors_are_recognised(exc):
    assert disk_space.is_disk_full(exc)


def test_a_windows_disk_full_code_is_recognised():
    for code in (39, 112):
        e = OSError(errno.EIO, "There is not enough space on the disk")
        e.winerror = code
        assert disk_space.is_disk_full(e)


def test_a_disk_full_error_under_another_one_is_recognised():
    try:
        try:
            _enospc()
        except OSError as inner:
            raise RuntimeError("copy failed") from inner
    except RuntimeError as outer:
        assert disk_space.is_disk_full(outer)


@pytest.mark.parametrize("exc", [
    OSError(errno.EACCES, "Permission denied"), FileNotFoundError(2, "gone"), ValueError("x"), None,
])
def test_other_errors_are_not_a_full_disk(exc):
    assert not disk_space.is_disk_full(exc)


def test_the_message_is_one_short_sentence_with_the_numbers():
    # `needed` is the free space wanted (the write plus its headroom), so the sentence is true as said.
    # Bytes read the way the app's formatBytes reads them (1024-based), so 0.9 GiB is "921.6 MB".
    assert disk_space.message(int(4.2 * GIB), int(1.9 * GIB)) == \
        "Not enough disk space. Montaj needs about 4.2 GB free for this, 1.9 GB is free."
    assert disk_space.message(int(4.2 * GIB), int(0.9 * GIB)) == \
        "Not enough disk space. Montaj needs about 4.2 GB free for this, 921.6 MB is free."
    assert disk_space.message(None, int(1.9 * GIB)) == "Not enough disk space. 1.9 GB is free."
    assert disk_space.message(None, None) == "Not enough disk space."
    assert "—" not in disk_space.message(1, 1)


def test_bytes_read_as_the_app_reads_them():
    # desktop/ui/src/lib/storageSize.ts formatBytes, case for case.
    for n, s in [(0, "0 B"), (-5, "0 B"), (512, "512 B"), (1024, "1.0 KB"), (1536, "1.5 KB"),
                 (1024 ** 2, "1.0 MB"), (GIB, "1.0 GB"), (3.25 * GIB, "3.3 GB"), (300 * 1024 ** 2, "300.0 MB")]:
        assert disk_space.format_bytes(n) == s


MIB = 1024 ** 2


def test_headroom_is_2_percent_between_256_mib_and_1_gib_and_none_for_a_tiny_write():
    assert disk_space.headroom(50 * 1024) == 0                 # under 16 MiB: none
    assert disk_space.headroom(15 * MIB) == 0
    assert disk_space.headroom(100 * MIB) == 256 * MIB         # 2% is 2 MiB: the 256 MiB floor
    assert disk_space.headroom(25 * GIB) == 512 * MIB          # 2%
    assert disk_space.headroom(100 * GIB) == GIB               # 2% is 2 GiB: capped at 1 GiB


def test_preflight_refuses_what_would_not_fit_with_headroom_and_says_the_whole_need(tmp_path, monkeypatch):
    _free(monkeypatch, int(1.6 * GIB))
    with pytest.raises(disk_space.DiskFull) as e:
        disk_space.preflight(tmp_path, int(1.5 * GIB))   # 1.5 GB + 256 MB headroom > 1.6 GB
    want = int(1.5 * GIB) + 256 * MIB
    assert e.value.needed == want and e.value.headroom == 256 * MIB and e.value.free == int(1.6 * GIB)
    assert e.value.message == f"Not enough disk space. Montaj needs about {disk_space.format_bytes(want)} free for this, 1.6 GB is free."
    assert e.value.needed > e.value.free                  # the sentence never contradicts itself
    disk_space.preflight(tmp_path, int(1.2 * GIB))         # fits with its headroom


def test_preflight_headroom_is_capped_at_1_gib(tmp_path, monkeypatch):
    _free(monkeypatch, int(100.9 * GIB))
    with pytest.raises(disk_space.DiskFull):
        disk_space.preflight(tmp_path, 100 * GIB)
    _free(monkeypatch, int(101.1 * GIB))
    disk_space.preflight(tmp_path, 100 * GIB)


@pytest.mark.parametrize("size", [50 * 1024, 5 * MIB])
def test_a_small_write_is_never_refused_while_it_fits(tmp_path, monkeypatch, size):
    _free(monkeypatch, 900 * MIB)
    disk_space.preflight(tmp_path, size)
    _free(monkeypatch, size + 1)
    disk_space.preflight(tmp_path, size)
    _free(monkeypatch, size - 1)
    with pytest.raises(disk_space.DiskFull) as e:
        disk_space.preflight(tmp_path, size)
    assert e.value.needed == size


def test_preflight_counts_what_is_already_reserved(tmp_path, monkeypatch):
    _free(monkeypatch, 3 * GIB)
    disk_space.preflight(tmp_path, 600 * MIB)
    with pytest.raises(disk_space.DiskFull):
        disk_space.preflight(tmp_path, 600 * MIB, reserved=int(2.5 * GIB))


def test_preflight_fails_open_when_free_space_cannot_be_read(tmp_path, monkeypatch):
    monkeypatch.setattr(disk_space.shutil, "disk_usage", _enospc)
    disk_space.preflight(tmp_path, 10 ** 15)
    monkeypatch.setattr(disk_space.shutil, "disk_usage", lambda _p: (_ for _ in ()).throw(PermissionError(13, "no")))
    disk_space.preflight(tmp_path, 10 ** 15)


def test_preflight_reads_a_destination_that_does_not_exist_yet(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(disk_space.shutil, "disk_usage",
                        lambda p: seen.append(p) or types.SimpleNamespace(total=GIB, used=GIB, free=0))
    with pytest.raises(disk_space.DiskFull):
        disk_space.preflight(tmp_path / "not" / "yet", 10)
    assert seen == [str(tmp_path)]


def test_an_uncaught_full_disk_in_a_step_ends_with_one_json_line_after_its_traceback(tmp_path):
    # The traceback still goes to the log (a crash must stay diagnosable); the last line is the one
    # JSON error serve reads, so the person sees only the sentence. Free space is read at the workspace,
    # never the process's cwd.
    ws = tmp_path / "ws"
    ws.mkdir()
    code = "import lib.common\nraise OSError(28, 'No space left on device')\n"
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(REPO_ROOT),
                       env={**os.environ, "MONTAJ_WORKSPACE_DIR": str(ws)})
    assert r.returncode == 1
    assert "Traceback" in r.stderr
    last = json.loads([ln for ln in r.stderr.splitlines() if ln.strip()][-1])
    assert last["error"] == "disk_full" and last["path"] == str(ws)


def test_a_disk_full_error_in_an_exception_group_is_recognised():
    group = ExceptionGroup("copies", [ValueError("x"), OSError(errno.ENOSPC, "No space left on device")])
    assert disk_space.is_disk_full(group)
    assert not disk_space.is_disk_full(ExceptionGroup("copies", [ValueError("x")]))


def test_any_other_uncaught_error_still_prints_its_traceback(tmp_path):
    code = "import lib.common\nraise OSError(13, 'Permission denied')\n"
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(REPO_ROOT))
    assert r.returncode == 1 and "Traceback" in r.stderr


# ---------------------------------------------------------------------------
# Uploads (serve/routes/files.py save_upload)
# ---------------------------------------------------------------------------

class _HalfThenFull:
    """A file object whose second write fails with ENOSPC, having written the first."""

    def __init__(self, real):
        self.real, self.n = real, 0

    def write(self, data):
        self.n += 1
        if self.n > 1:
            raise OSError(errno.ENOSPC, "No space left on device")
        return self.real.write(data)

    def __getattr__(self, name):
        return getattr(self.real, name)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.real.close()


def _failing_open(monkeypatch):
    import serve.routes.files as files_mod
    real_open = open

    def fake_open(path, mode="r", *a, **k):
        f = real_open(path, mode, *a, **k)
        return _HalfThenFull(f) if "x" in mode else f
    monkeypatch.setattr(files_mod, "open", fake_open, raising=False)


def test_an_upload_that_fills_the_disk_is_507_and_leaves_no_half_file(client, ws, monkeypatch):
    uploads = ws / "_uploads"
    uploads.mkdir()
    (uploads / "keep.MOV").write_bytes(b"there before")
    _failing_open(monkeypatch)
    r = client.post("/api/upload", files={"file": ("IMG_1162.MOV", b"x" * (3 * 1024 * 1024))})
    d = _disk_full(r)
    assert d["path"] == str(ws)
    assert sorted(p.name for p in uploads.iterdir()) == ["keep.MOV"]
    assert (uploads / "keep.MOV").read_bytes() == b"there before"


def test_a_project_upload_that_fills_the_disk_is_507_and_leaves_no_half_file(client, ws, monkeypatch):
    proj = _project(ws / "proj", "p-full")
    _failing_open(monkeypatch)
    r = client.post("/api/projects/p-full/upload-asset", files={"file": ("big.mov", b"x" * (3 * 1024 * 1024))})
    _disk_full(r)
    assert sorted(p.name for p in proj.iterdir()) == ["project.json"]


def test_an_upload_too_big_for_the_free_space_is_refused_before_anything_is_written(client, ws, monkeypatch):
    _free(monkeypatch, 500)               # a tiny upload is refused only when it does not fit at all
    r = client.post("/api/upload", files={"file": ("IMG_1162.MOV", b"x" * 1024)})
    d = _disk_full(r)
    assert d["free"] == 500 and d["needed"] >= 1024 and d["needed"] > d["free"]
    assert not (ws / "_uploads").exists() or not any((ws / "_uploads").iterdir())


def test_an_upload_with_room_is_unchanged(client, ws, monkeypatch):
    _free(monkeypatch, 50 * GIB)
    r = client.post("/api/upload", files={"file": ("ok.mov", b"x" * 1024)})
    assert r.status_code == 200, r.text
    assert Path(r.json()["path"]).read_bytes() == b"x" * 1024


def test_an_upload_still_works_when_free_space_cannot_be_read(client, ws, monkeypatch):
    monkeypatch.setattr(disk_space.shutil, "disk_usage", _enospc)
    r = client.post("/api/upload", files={"file": ("ok.mov", b"x" * 10)})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# POST /api/files (write_file)
# ---------------------------------------------------------------------------

def test_write_file_full_disk_on_its_only_write(client, ws, monkeypatch):
    import serve.routes.files as files_mod

    class Full:
        def __init__(self, f):
            self.f = f

        def write(self, data):
            self.f.write(data[: len(data) // 2])
            raise OSError(errno.ENOSPC, "No space left on device")

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.f.close()
    real_fdopen = os.fdopen
    monkeypatch.setattr(files_mod.os, "fdopen", lambda fd, mode="r", *a, **k: Full(real_fdopen(fd, mode, *a, **k)))
    target = ws / "spec.json"
    r = client.post("/api/files", json={"path": str(target), "content": "{\"a\": 1}"})
    _disk_full(r)
    assert not target.exists()


# ---------------------------------------------------------------------------
# Project create: project/init.py, in process
# ---------------------------------------------------------------------------

def _run_init(monkeypatch, capsys, *args):
    monkeypatch.setattr(sys, "argv", ["init.py", "--prompt", "p", "--workflow", "overlays", *args])
    with pytest.raises(SystemExit) as e:
        init_mod.main()
    err = capsys.readouterr().err
    lines = [ln for ln in err.splitlines() if ln.strip() and not ln.startswith("MONTAJ_TIMING")]
    errors = [json.loads(ln) for ln in lines if ln.startswith("{") and '"error"' in ln]
    return e.value.code, errors, err


def _uploads(ws, *names):
    up = ws / "_uploads"
    up.mkdir(exist_ok=True)
    paths = []
    for n in names:
        p = up / n
        p.write_bytes(b"m" * 4096)
        paths.append(str(p))
    return paths


def test_init_on_a_full_disk_says_so_and_removes_the_half_made_project(ws, monkeypatch, capsys):
    clips = _uploads(ws, "IMG_1162_1.MOV", "IMG_1163.MOV")
    real_copy = init_mod.shutil.copy2
    calls = []

    def copy2(src, dest, *a, **k):
        calls.append(dest)
        if len(calls) == 1:
            return real_copy(src, dest, *a, **k)
        with open(dest, "wb") as f:          # half a file, then the disk is full
            f.write(b"m" * 100)
        raise OSError(errno.ENOSPC, "No space left on device", dest)
    monkeypatch.setattr(init_mod.shutil, "copy2", copy2)
    code, errors, err = _run_init(monkeypatch, capsys, "--name", "controlling my computer", "--clips", *clips)
    assert code == 1
    assert "Traceback" not in err
    assert errors and errors[-1]["error"] == "disk_full"
    assert errors[-1]["message"].startswith("Not enough disk space.")
    assert errors[-1]["path"] == str(ws)
    # Nothing half-made is left; the staged uploads are untouched.
    assert sorted(p.name for p in ws.iterdir()) == ["_uploads"]
    assert all(Path(c).read_bytes() == b"m" * 4096 for c in clips)


def test_init_refuses_before_writing_when_the_footage_will_not_fit(ws, monkeypatch, capsys):
    clips = _uploads(ws, "a.MOV", "b.MOV")
    _free(monkeypatch, 4000)
    monkeypatch.setattr(init_mod.shutil, "copy2", lambda *a, **k: pytest.fail("copied on a full disk"))
    code, errors, _ = _run_init(monkeypatch, capsys, "--name", "x", "--clips", *clips)
    assert code == 1 and errors[-1]["error"] == "disk_full"
    assert errors[-1]["needed"] == 2 * 4096 and errors[-1]["free"] == 4000
    assert sorted(p.name for p in ws.iterdir()) == ["_uploads"]


def test_init_symlinked_clips_take_no_space_in_the_preflight(ws, monkeypatch, capsys):
    # A clips-workflow child links its clip: nothing is copied, so a full disk is not checked against it.
    clips = _uploads(ws, "a.MOV")
    _free(monkeypatch, 0)
    monkeypatch.setattr(init_mod, "probe_video", lambda p: None)
    code, errors, _ = _run_init(monkeypatch, capsys, "--clips", *clips, "--symlink-clips")
    assert errors[-1]["error"] != "disk_full"


def test_copy_into_workspace_removes_its_half_copy_and_nothing_else(tmp_path, monkeypatch):
    src = tmp_path / "clip.mov"
    src.write_bytes(b"s" * 1000)
    dest_dir = tmp_path / "proj"
    dest_dir.mkdir()
    (dest_dir / "clip.mov").write_bytes(b"there before")

    def copy2(s, d, *a, **k):
        Path(d).write_bytes(b"half")
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(init_mod.shutil, "copy2", copy2)
    with pytest.raises(OSError):
        init_mod._copy_into_workspace(str(src), str(dest_dir), "clip")
    assert sorted(p.name for p in dest_dir.iterdir()) == ["clip.mov"]
    assert (dest_dir / "clip.mov").read_bytes() == b"there before"


# ---------------------------------------------------------------------------
# POST /api/run: init's answer reaches the person as a 507
# ---------------------------------------------------------------------------

def _clip(ws):
    p = ws / "_uploads" / "IMG_1162_1.MOV"
    p.parent.mkdir(exist_ok=True)
    p.write_bytes(b"m")
    return str(p)


def test_run_answers_init_disk_full_as_507(client, ws, monkeypatch):
    detail = {"error": "disk_full", "message": "Not enough disk space. Montaj needs about 4.2 GB, 1.9 GB is free.",
              "needed": int(4.2 * GIB), "free": int(1.9 * GIB), "path": str(ws)}

    async def run(cmd, **k):
        return "", json.dumps(detail) + "\n", 1
    monkeypatch.setattr(projects_mod, "run_subprocess", run)
    r = client.post("/api/run", json={"clips": [_clip(ws)], "prompt": "p", "workflow": "overlays"})
    d = _disk_full(r)
    # init's numbers kept; free space read again at the workspace, and the sentence says both.
    assert d["needed"] == detail["needed"] and d["message"] == disk_space.message(detail["needed"], d["free"])


def test_run_answers_an_old_style_disk_full_traceback_as_507_without_the_traceback(client, ws, monkeypatch):
    tb = ("Traceback (most recent call last):\n  File \"project/init.py\", line 261, in _copy_into_workspace\n"
          "    shutil.copy2(src, dest)\nOSError: [Errno 28] No space left on device: "
          f"'{ws}/_uploads/IMG_1162_1.MOV' -> '{ws}/2026-10-22-x/IMG_1162_1.MOV'\n")

    async def run(cmd, **k):
        return "", tb, 1
    monkeypatch.setattr(projects_mod, "run_subprocess", run)
    r = client.post("/api/run", json={"clips": [_clip(ws)], "prompt": "p", "workflow": "overlays"})
    d = _disk_full(r)
    assert "IMG_1162" not in json.dumps(d)


def test_run_other_init_failures_are_unchanged(client, ws, monkeypatch):
    async def run(cmd, **k):
        return "", json.dumps({"error": "init_failed", "message": "boom"}), 1
    monkeypatch.setattr(projects_mod, "run_subprocess", run)
    r = client.post("/api/run", json={"clips": [_clip(ws)], "prompt": "p", "workflow": "overlays"})
    assert r.status_code == 500 and r.json()["detail"]["error"] == "init_failed"


# ---------------------------------------------------------------------------
# Other writing routes
# ---------------------------------------------------------------------------

def test_a_save_on_a_full_disk_is_507_and_project_json_is_unchanged(client, ws, monkeypatch):
    folder = _project(ws / "p", "p-save")
    before = (folder / "project.json").read_text()
    real = Path.write_text

    def half(self, data, *a, **k):
        real(self, data[: len(data) // 2], *a, **k)
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(Path, "write_text", half)
    r = client.put("/api/projects/p-save", json={"id": "p-save", "name": "never written"})
    monkeypatch.undo()
    _disk_full(r)
    assert (folder / "project.json").read_text() == before
    assert sorted(p.name for p in folder.iterdir() if p.name.endswith(".tmp")) == []


def test_including_a_profile_asset_on_a_full_disk_is_507_with_no_half_copy(client, ws, tmp_path, monkeypatch):
    home = tmp_path / "home"
    assets = home / ".montaj" / "profiles" / "sam" / "assets"
    assets.mkdir(parents=True)
    (assets / "logo.png").write_bytes(b"png" * 100)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    folder = ws / "p"
    folder.mkdir()
    (folder / "project.json").write_text(json.dumps({"id": "p-inc", "profile": "sam", "tracks": []}))

    def copy2(s, d, *a, **k):
        Path(d).write_bytes(b"half")
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(init_mod.shutil, "copy2", copy2)
    r = client.post("/api/projects/p-inc/assets", json={"from": {"profile": "sam", "filename": "logo.png"}})
    _disk_full(r)
    assert sorted(p.name for p in folder.iterdir()) == ["project.json"]


def test_an_add_media_job_on_a_full_disk_says_so(ws, monkeypatch):
    import asyncio
    folder = _project(ws / "p", "p-ing")

    class B:
        def publish(self, *a, **k):
            pass
    monkeypatch.setattr(projects_mod, "ingest_source", _enospc)
    job = projects_mod._IngestJob()
    asyncio.run(projects_mod._run_ingest_detached("p-ing", folder, "/x/clip.mov", "sdr_bt709", B(), job))
    assert job.status == "error"
    assert job.error.startswith("Not enough disk space.")
    assert job.code == "disk_full"
    projects_mod._ingest_jobs["j-full"] = job
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            r = c.get("/api/projects/p-ing/sources/status/j-full")
        body = r.json()
        assert body["status"] == "error" and body["code"] == "disk_full"
        assert body["error"].startswith("Not enough disk space.")
    finally:
        projects_mod._ingest_jobs.pop("j-full", None)


def test_ingest_staging_removes_its_half_copy(tmp_path, monkeypatch):
    import lib.ingest as ingest_mod
    src = tmp_path / "in" / "clip.mov"
    src.parent.mkdir()
    src.write_bytes(b"s" * 100)
    proj = tmp_path / "proj"
    proj.mkdir()

    def copy2(s, d, *a, **k):
        Path(d).write_bytes(b"half")
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(ingest_mod.shutil, "copy2", copy2)
    with pytest.raises(OSError):
        ingest_mod._stage_into_project(str(src), str(proj), "clip")
    assert list(proj.iterdir()) == []


def test_a_step_that_hits_a_full_disk_is_507(tmp_path, monkeypatch):
    from serve.disk_full import child_disk_full
    _free(monkeypatch, 77)
    # Free space is read at the workspace (`root`), not taken from the child, which may have read another disk.
    d = child_disk_full({"error": "disk_full", "message": "Not enough disk space.", "free": 5}, "", str(tmp_path))
    assert d["error"] == "disk_full" and d["path"] == str(tmp_path) and d["free"] == 77
    d = child_disk_full({"error": "step_failed", "message": "x"}, "[out#0] Error writing trailer: No space left on device", str(tmp_path))
    assert d is not None and d["error"] == "disk_full" and "trailer" not in d["message"]
    assert child_disk_full({"error": "step_failed", "message": "bad input"}, "bad input", str(tmp_path)) is None


@pytest.mark.parametrize("err, stderr", [
    ({"error": "file_not_found", "message": "Clip not found: /Users/x/Errno 28.mov"}, ""),
    ({"error": "file_not_found", "message": "Clip not found: /Users/x/no space left on device.mov"}, ""),
    ({"error": "remote_failed", "message": "fal said: upstream error"},
     "provider echoed: No space left on device on their side\n{\"error\": \"remote_failed\"}\n"),
    ({"error": "step_failed", "message": "x"}, "warning: the last run said 'No space left on device' (fixed)\nok, then bad input\n"),
    ({"error": "step_failed", "message": "Clip not found: /Users/x/Errno 28: No space left on device.mov"}, ""),
])
def test_text_that_only_mentions_a_full_disk_is_not_one(tmp_path, err, stderr):
    from serve.disk_full import child_disk_full
    assert child_disk_full(err, stderr, str(tmp_path)) is None


def test_write_file_that_cannot_even_create_its_file_is_507_not_403(client, ws, monkeypatch):
    # Creating a file needs space too: that open failing was answered 403 "outside the workspace".
    import serve.routes.files as files_mod
    monkeypatch.setattr(files_mod, "open_write_no_follow", lambda p: _enospc())
    r = client.post("/api/files", json={"path": str(ws / "a.txt"), "content": "x"})
    _disk_full(r)


def test_an_uncaught_full_disk_in_any_route_is_507_not_500(client, ws, monkeypatch):
    # The catch-all: a write that never thought about a full disk still answers
    # the 507, not a bare "Internal Server Error".
    import serve.routes.files as files_mod

    async def full(file, dest_dir):
        _enospc()
    monkeypatch.setattr(files_mod, "save_upload", full)
    r = client.post("/api/upload", files={"file": ("a.mov", b"x")})
    _disk_full(r)


def test_an_uncaught_non_disk_oserror_is_still_a_500(client, ws, monkeypatch):
    import serve.routes.files as files_mod

    async def boom(file, dest_dir):
        raise OSError(errno.EIO, "I/O error")
    monkeypatch.setattr(files_mod, "save_upload", boom)
    r = client.post("/api/upload", files={"file": ("a.mov", b"x")})
    assert r.status_code == 500


# ---------------------------------------------------------------------------
# Steps, profile assets, the CLI
# ---------------------------------------------------------------------------

def _step_env(ws, monkeypatch, stderr):
    import serve.routes.steps as steps_mod
    render = REPO_ROOT / "steps" / "render"
    pdir = ws / "p"
    pdir.mkdir()
    (pdir / "project.json").write_text(json.dumps({"id": "p-step", "tracks": []}))
    steps_mod._RESERVED_OUTS.clear()
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {
        "sample_frame": (json.loads((render / "sample_frame.json").read_text()), render / "sample_frame.py")})

    async def run(cmd, **k):
        return "", stderr, 1
    monkeypatch.setattr(steps_mod, "run_subprocess", run)
    return {"project": str(pdir / "project.json"), "out": str(pdir / "o.png"), "at": 1.0}


@pytest.mark.parametrize("stderr", [
    json.dumps({"progress": "rendering"}) + "\n" + json.dumps({"error": "disk_full", "message": "x", "free": 7}),
    "[out#0/png] Error writing trailer of o.png: No space left on device\n",
])
def test_a_step_that_runs_out_of_disk_is_507(client, ws, monkeypatch, stderr):
    body = _step_env(ws, monkeypatch, stderr)
    d = _disk_full(client.post("/api/steps/sample_frame", json=body))
    assert "trailer" not in d["message"] and d["path"] == str(ws)


def test_a_step_that_fails_otherwise_is_unchanged(client, ws, monkeypatch):
    body = _step_env(ws, monkeypatch, json.dumps({"error": "bad_input", "message": "nope"}))
    r = client.post("/api/steps/sample_frame", json=body)
    assert r.status_code == 500 and r.json()["detail"]["error"] == "bad_input"


def test_a_profile_asset_upload_on_a_full_disk_is_507_with_no_half_file(client, ws, tmp_path, monkeypatch):
    import serve.routes.profile_assets as pa
    assets = tmp_path / "profiles" / "sam" / "assets"
    monkeypatch.setattr(pa, "_assets_dir", lambda name: assets)
    real_open = open

    def fake_open(path, mode="r", *a, **k):
        f = real_open(path, mode, *a, **k)
        return _HalfThenFull(f) if ("w" in mode or "x" in mode) else f
    monkeypatch.setattr(pa, "open", fake_open, raising=False)
    r = client.post("/api/profiles/sam/assets", files={"file": ("logo.png", b"x" * (3 * 1024 * 1024))})
    _disk_full(r)
    assert list(assets.iterdir()) == []


def test_montaj_init_on_a_full_disk_prints_one_line_not_a_traceback(ws):
    # The real CLI and script, in their own processes: a sitecustomize makes every copy hit a full disk.
    clip = ws / "_uploads" / "a.MOV"
    clip.parent.mkdir()
    clip.write_bytes(b"m" * 100)
    site = ws.parent / "site"
    site.mkdir()
    (site / "sitecustomize.py").write_text(
        "import errno, shutil\n"
        "def _full(*a, **k):\n"
        "    raise OSError(errno.ENOSPC, 'No space left on device')\n"
        "shutil.copy2 = _full\n")
    env = {**os.environ, "MONTAJ_WORKSPACE_DIR": str(ws), "PYTHONPATH": f"{site}{os.pathsep}{REPO_ROOT}"}
    r = subprocess.run([sys.executable, "-m", "cli.main", "init", "--prompt", "p", "--clip", str(clip)],
                       capture_output=True, text=True, env=env, cwd=str(REPO_ROOT))
    assert r.returncode == 1, r.stderr
    assert "Traceback" not in r.stderr
    errors = [json.loads(ln) for ln in r.stderr.splitlines() if ln.startswith("{") and '"error"' in ln]
    assert len(errors) == 1 and errors[0]["error"] == "disk_full"
    assert sorted(p.name for p in ws.iterdir()) == ["_uploads"]


# ---------------------------------------------------------------------------
# Review fixes (§541 second pass)
# ---------------------------------------------------------------------------

def test_a_full_disk_while_the_body_is_spooled_is_507_not_a_parse_error(client, ws, monkeypatch):
    # Starlette spools a multipart body to a temp file before the route runs; a full disk there was
    # FastAPI's 400 "There was an error parsing the body", shown raw on the New project form.
    import starlette.datastructures as sd

    async def full(self, data):
        _enospc()
    monkeypatch.setattr(sd.UploadFile, "write", full)
    r = client.post("/api/upload", files={"file": ("IMG_1162.MOV", b"x" * 2048)})
    _disk_full(r)
    assert "parsing" not in r.text


def test_a_body_that_does_not_parse_for_another_reason_is_still_400(client, ws):
    r = client.post("/api/upload", content=b"--nope\r\n\r\n", headers={"content-type": "multipart/form-data; boundary=x"})
    assert r.status_code in (400, 422)
    assert "disk_full" not in r.text


def test_uploads_in_flight_count_against_the_free_space(client, ws, monkeypatch):
    # 13 videos dropped at once each passed the preflight against the same free space, then filled
    # the disk together. An upload still being received holds its declared size.
    import serve.server as server_mod
    _free(monkeypatch, 3 * GIB)
    with server_mod.upload_reservation(int(2.5 * GIB)):
        r = client.post("/api/upload", files={"file": ("b.MOV", b"x" * 1024)})
        assert r.status_code == 200, r.text          # a tiny one still fits
        assert server_mod._upload_preflight({"headers": [(b"content-length", str(600 * MIB).encode())]}) is not None
    assert server_mod._upload_preflight({"headers": [(b"content-length", str(600 * MIB).encode())]}) is None
    assert server_mod.reserved_upload_bytes() == 0


def test_an_upload_releases_its_reservation_when_it_ends(client, ws, monkeypatch):
    import serve.server as server_mod
    _free(monkeypatch, 50 * GIB)
    assert client.post("/api/upload", files={"file": ("a.MOV", b"x" * 1024)}).status_code == 200
    _failing_open(monkeypatch)
    assert client.post("/api/upload", files={"file": ("b.MOV", b"x" * (3 * MIB))}).status_code == 507
    assert server_mod.reserved_upload_bytes() == 0


def test_two_imports_of_one_name_at_once_never_share_a_file(tmp_path, monkeypatch):
    # GX010001.MP4 repeats across cards. Two imports picking the same free name, one then hitting a full
    # disk, used to remove the other's finished copy.
    import threading
    import time
    import lib.ingest as ingest_mod
    a_src = tmp_path / "cardA" / "GX010001.MP4"
    b_src = tmp_path / "cardB" / "GX010001.MP4"
    for p, body in ((a_src, b"A" * 500), (b_src, b"B" * 500)):
        p.parent.mkdir()
        p.write_bytes(body)
    proj = tmp_path / "proj"
    proj.mkdir()
    b_chose, a_wrote = threading.Event(), threading.Event()
    real_copy = ingest_mod.shutil.copy2

    def copy2(s, d, *a, **k):
        if s == str(a_src):
            b_chose.wait(5)
            real_copy(s, d)
            a_wrote.set()
            return d
        b_chose.set()
        a_wrote.wait(5)
        Path(d).write_bytes(b"half")
        raise OSError(errno.ENOSPC, "No space left on device")
    monkeypatch.setattr(ingest_mod.shutil, "copy2", copy2)
    out, errs = {}, {}

    def run(name, src):
        try:
            out[name] = ingest_mod._stage_into_project(str(src), str(proj), "clip")
        except Exception as e:
            errs[name] = e
    ta = threading.Thread(target=run, args=("a", a_src))
    ta.start()
    time.sleep(0.2)                                # A has chosen its name and is copying
    tb = threading.Thread(target=run, args=("b", b_src))
    tb.start()
    ta.join(10)
    tb.join(10)
    assert "a" in out and "b" in errs and disk_space.is_disk_full(errs["b"])
    assert Path(out["a"]).read_bytes() == b"A" * 500
    assert sorted(p.name for p in proj.iterdir()) == ["GX010001.MP4"]


def test_write_file_over_an_existing_file_on_a_full_disk_keeps_the_old_content(client, ws, monkeypatch):
    import serve.routes.files as files_mod
    target = ws / "spec.json"
    target.write_text('{"old": true}')

    class Full:
        def __init__(self, f):
            self.f = f

        def write(self, data):
            self.f.write(data[: len(data) // 2])
            raise OSError(errno.ENOSPC, "No space left on device")

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.f.close()
    real_fdopen = os.fdopen
    monkeypatch.setattr(files_mod.os, "fdopen", lambda fd, mode="r", *a, **k: Full(real_fdopen(fd, mode, *a, **k)))
    r = client.post("/api/files", json={"path": str(target), "content": '{"new": "x" }'})
    _disk_full(r)
    assert target.read_text() == '{"old": true}'
    assert sorted(p.name for p in ws.iterdir()) == ["spec.json"]


def test_write_file_still_refuses_a_symlink_at_the_target(client, ws, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("keep")
    (ws / "link.txt").symlink_to(outside)
    r = client.post("/api/files", json={"path": str(ws / "link.txt"), "content": "x"})
    assert r.status_code == 403
    assert outside.read_text() == "keep" and (ws / "link.txt").is_symlink()


def test_write_file_overwrites_as_before(client, ws):
    target = ws / "o.jsx"
    target.write_text("old")
    r = client.post("/api/files", json={"path": str(target), "content": "new"})
    assert r.status_code == 200 and target.read_text() == "new"
    assert sorted(p.name for p in ws.iterdir()) == ["o.jsx"]


def test_a_failed_create_removes_the_parent_folders_it_made_for_a_nested_path(ws, monkeypatch, capsys):
    clips = _uploads(ws, "a.MOV")
    (ws / "teamA").mkdir()                       # there before: kept
    monkeypatch.setattr(init_mod.shutil, "copy2", lambda *a, **k: _enospc())
    code, errors, _ = _run_init(monkeypatch, capsys, "--project-path", "teamA/q4/launch", "--clips", *clips)
    assert code == 1 and errors[-1]["error"] == "disk_full"
    assert sorted(p.name for p in ws.iterdir()) == ["_uploads", "teamA"]
    assert list((ws / "teamA").iterdir()) == []


def test_run_keeps_init_own_error_code_when_progress_lines_come_first(client, ws, monkeypatch):
    # Deliberate (§541): init's error is its last JSON error line, so progress lines before it no longer
    # turn project_path_exists into a 500 init_failed carrying the raw text.
    err = {"error": "project_path_exists", "message": "--project-path 'x' already exists"}

    async def run(cmd, **k):
        return "", json.dumps({"progress": "probing"}) + "\n" + json.dumps(err) + "\n", 1
    monkeypatch.setattr(projects_mod, "run_subprocess", run)
    r = client.post("/api/run", json={"clips": [_clip(ws)], "prompt": "p", "workflow": "overlays", "projectPath": "x"})
    assert r.status_code == 400 and r.json()["detail"] == err


# ---------------------------------------------------------------------------
# Re-check fixes (§541 third pass)
# ---------------------------------------------------------------------------

# What ffmpeg 9 really prints when the disk fills mid-encode: the full-disk lines, then stats, a
# frame= line, and last "Conversion failed!".
FFMPEG_FULL = (
    "[out#0/mp4 @ 0x7f8] Error writing trailer: No space left on device\n"
    "[out#0/mp4 @ 0x7f8] Error closing file: No space left on device\n"
    "[out#0/mp4 @ 0x7f8] video:10KiB audio:0KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown\n"
    "frame=   25 fps=0.0 q=-1.0 Lsize=      10KiB time=00:00:01.00 bitrate=  81.9kbits/s speed=12.1x\n"
    "Conversion failed!\n"
)


def test_ffmpeg_real_full_disk_output_is_recognised():
    assert disk_space.tool_reported_disk_full(FFMPEG_FULL)
    from serve.disk_full import child_disk_full
    d = child_disk_full({"error": "unexpected_error", "message": "Command failed: ffmpeg ...\n" + FFMPEG_FULL}, FFMPEG_FULL, "/ws")
    assert d is not None and d["error"] == "disk_full"


@pytest.mark.parametrize("text", [
    "Clip not found: /Users/x/Errno 28.mov\nConversion failed!\n",
    "[in#0 @ 0x1] Error opening input: No such file or directory\nfile 'No space left on device.mov'\nConversion failed!\n",
    "echo: provider said No space left on device on their side\nConversion failed!\n",
])
def test_ffmpeg_output_that_only_mentions_a_full_disk_is_not_one(text):
    assert not disk_space.tool_reported_disk_full(text)


def _run_in_child(stderr_text):
    inner = f"import sys; sys.stderr.write({stderr_text!r}); sys.exit(1)"
    code = f"import sys\nfrom lib.common import run\nrun([sys.executable, '-c', {inner!r}])\n"
    return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(REPO_ROOT))


def test_a_step_whose_ffmpeg_fills_the_disk_says_disk_full():
    r = _run_in_child(FFMPEG_FULL)
    assert r.returncode == 1
    last = json.loads([ln for ln in r.stderr.splitlines() if ln.strip()][-1])
    assert last["error"] == "disk_full" and last["message"].startswith("Not enough disk space.")


def test_a_step_whose_ffmpeg_fails_otherwise_is_unchanged():
    r = _run_in_child("Clip not found: /Users/x/Errno 28.mov\nConversion failed!\n")
    last = json.loads([ln for ln in r.stderr.splitlines() if ln.strip()][-1])
    assert last["error"] == "unexpected_error"


def test_the_sentence_never_says_the_need_and_the_free_space_are_the_same():
    m = disk_space.message(5_000_000, 4_990_000)
    assert m == "Not enough disk space. Montaj needs about 9.8 KB more for this, 4.8 MB is free."
    assert disk_space.message(int(4.2 * GIB), int(1.9 * GIB)).endswith("4.2 GB free for this, 1.9 GB is free.")


def test_two_profile_uploads_of_one_name_at_once_never_share_a_file(tmp_path, monkeypatch):
    # Two uploads of logo.png to one profile, lined up on the name's exclusive create (a barrier at
    # each one's first open): whichever wins, they end with distinct names, the upload that succeeded
    # keeps an intact file, and the one that hit the full disk leaves nothing behind.
    import asyncio
    import threading
    import serve.routes.profile_assets as pa
    assets = tmp_path / "assets"
    monkeypatch.setattr(pa, "_assets_dir", lambda name: assets)
    at_create = threading.Barrier(2, timeout=5)
    a_done = threading.Event()
    first_open = {"A": True, "B": True}
    names = {}
    real_open = open

    class FullAfterA:
        def __init__(self, f):
            self.f, self.closed = f, False

        def write(self, data):
            a_done.wait(5)
            raise OSError(errno.ENOSPC, "No space left on device")

        def close(self):
            self.closed = True
            self.f.close()

    def fake_open(path, mode="r", *a, **k):
        who = threading.current_thread().name
        if "x" in mode and first_open.get(who):
            first_open[who] = False
            at_create.wait()                   # both reach the create of logo.png together
        f = real_open(path, mode, *a, **k)
        names[who] = os.path.basename(path)
        return FullAfterA(f) if who == "B" else f
    monkeypatch.setattr(pa, "open", fake_open, raising=False)

    class Up:
        def __init__(self, body):
            self.filename, self.body = "logo.png", body

        async def read(self, n=-1):
            out, self.body = self.body, b""
            return out
    results = {}

    def run(who, body):
        try:
            results[who] = asyncio.run(pa.upload_profile_asset("sam", Up(body)))
        except Exception as e:
            results[who] = e
        if who == "A":
            a_done.set()
    ta = threading.Thread(target=run, args=("A", b"A" * 100), name="A")
    tb = threading.Thread(target=run, args=("B", b"B" * 100), name="B")
    ta.start(); tb.start(); ta.join(10); tb.join(10)
    assert isinstance(results["A"], dict) and getattr(results["B"], "status_code", None) == 507
    assert names["A"] != names["B"] and {names["A"], names["B"]} == {"logo.png", "logo_1.png"}
    assert results["A"] == {"filename": names["A"]}
    assert sorted(p.name for p in assets.iterdir()) == [names["A"]]
    assert (assets / names["A"]).read_bytes() == b"A" * 100


def test_a_profile_upload_that_fails_otherwise_leaves_no_file(client, tmp_path, monkeypatch):
    import serve.routes.profile_assets as pa
    assets = tmp_path / "assets"
    monkeypatch.setattr(pa, "_assets_dir", lambda name: assets)
    real_open = open

    class Broken:
        def __init__(self, f):
            self.f, self.closed = f, False

        def write(self, data):
            raise RuntimeError("boom")

        def close(self):
            self.closed = True
            self.f.close()
    monkeypatch.setattr(pa, "open", lambda p, mode="r", *a, **k: Broken(real_open(p, mode, *a, **k)) if "x" in mode else real_open(p, mode, *a, **k), raising=False)
    r = client.post("/api/profiles/sam/assets", files={"file": ("logo.png", b"img")})
    assert r.status_code == 500
    assert not assets.exists() or list(assets.iterdir()) == []


def test_a_profile_upload_at_the_name_length_limit_gets_a_numbered_name_that_fits(client, tmp_path, monkeypatch):
    import serve.routes.profile_assets as pa
    assets = tmp_path / "assets"
    assets.mkdir()
    monkeypatch.setattr(pa, "_assets_dir", lambda name: assets)
    long = "a" * 251 + ".png"                  # 255 bytes: the longest a name can be
    (assets / long).write_bytes(b"old")
    r = client.post("/api/profiles/sam/assets", files={"file": (long, b"new")})
    assert r.status_code == 200, r.text
    got = r.json()["filename"]
    assert got != long and len(got.encode()) <= 255 and got.endswith("_1.png")
    assert (assets / long).read_bytes() == b"old" and (assets / got).read_bytes() == b"new"


def test_a_profile_upload_never_writes_through_a_dangling_link(client, tmp_path, monkeypatch):
    import serve.routes.profile_assets as pa
    assets = tmp_path / "assets"
    assets.mkdir()
    target = tmp_path / "elsewhere.png"
    (assets / "logo.png").symlink_to(target)
    monkeypatch.setattr(pa, "_assets_dir", lambda name: assets)
    r = client.post("/api/profiles/sam/assets", files={"file": ("logo.png", b"img")})
    assert r.status_code == 200 and r.json()["filename"] != "logo.png"
    assert not target.exists()


def _guard_app(free, body_parts, during):
    """Run one upload through _DiskFullGuard: `body_parts` arrive one per receive(); `during(received)` is
    called after each part is read and once at the end (still in the handler)."""
    import asyncio
    import serve.server as server_mod
    total = sum(len(p) for p in body_parts)

    async def inner(scope, receive, send):
        got = 0
        while True:
            m = await receive()
            got += len(m.get("body", b""))
            during(got)
            if not m.get("more_body"):
                break
        during(got)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    msgs = [{"type": "http.request", "body": p, "more_body": i < len(body_parts) - 1} for i, p in enumerate(body_parts)]

    async def receive():
        return msgs.pop(0)
    sent = []

    async def send(m):
        sent.append(m)
    scope = {"type": "http", "method": "POST", "path": "/api/upload", "headers": [(b"content-length", str(total).encode())]}
    asyncio.run(server_mod._DiskFullGuard(inner)(scope, receive, send))
    return sent


def test_an_upload_stops_holding_bytes_as_they_arrive(ws, monkeypatch):
    # 1000 B free; A (600 B) is on disk and still in its handler: 400 B free, and B (300 B) fits.
    import serve.server as server_mod
    state = {"free": 1000}
    monkeypatch.setattr(disk_space.shutil, "disk_usage",
                        lambda _p: types.SimpleNamespace(total=10 ** 6, used=0, free=state["free"]))
    seen = []

    def during(received):
        state["free"] = 1000 - received
        seen.append((received, server_mod.reserved_upload_bytes(),
                     server_mod._upload_preflight({"headers": [(b"content-length", b"300")]}) is None,
                     server_mod._upload_preflight({"headers": [(b"content-length", b"500")]}) is None))
    _guard_app(1000, [b"a" * 200, b"a" * 400], during)
    # After 200 of 600 B: 800 free, 400 still held: 300 fits, 500 does not.
    assert seen[0] == (200, 400, True, False)
    # Whole body in, still in the handler: nothing held, 400 free: 300 fits, 500 still does not.
    assert seen[-1] == (600, 0, True, False)
    assert server_mod.reserved_upload_bytes() == 0


def test_a_spool_on_another_disk_reports_that_disk(client, ws, tmp_path, monkeypatch):
    import serve.disk_full as dfm
    import starlette.datastructures as sd
    spool = tmp_path / "spool"
    spool.mkdir()
    monkeypatch.setattr(dfm.tempfile, "gettempdir", lambda: str(spool))
    monkeypatch.setattr(dfm, "_same_volume", lambda a, b: False)

    async def full(self, data):
        _enospc()
    monkeypatch.setattr(sd.UploadFile, "write", full)
    d = _disk_full(client.post("/api/upload", files={"file": ("a.MOV", b"x" * 2048)}))
    assert d["path"] == str(spool)


def test_write_file_onto_a_folder_is_still_403(client, ws):
    (ws / "folder").mkdir()
    r = client.post("/api/files", json={"path": str(ws / "folder"), "content": "x"})
    assert r.status_code == 403


def test_write_file_onto_a_read_only_file_is_still_refused(client, ws):
    target = ws / "locked.json"
    target.write_text("keep")
    target.chmod(0o444)
    try:
        r = client.post("/api/files", json={"path": str(target), "content": "x"})
        assert r.status_code == 403
        assert target.read_text() == "keep"
    finally:
        target.chmod(0o644)


# ---------------------------------------------------------------------------
# Third check (§541)
# ---------------------------------------------------------------------------

def test_a_metadata_tag_that_ends_in_the_sentence_is_not_a_full_disk():
    # A clip's title tag printed by ffmpeg, then an unrelated failure.
    text = (
        "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mov':\n"
        "  Metadata:\n"
        "    title           : the drive said: No space left on device\n"
        "  Duration: 00:00:01.00, start: 0.000000, bitrate: 81 kb/s\n"
        "  Stream #0:0[0x1](und): Video: h264 (avc1 / 0x31637661), yuv420p, 64x64, 25 fps\n"
        "      Metadata:\n"
        "        handler_name    : x: No space left on device\n"
        "[vist#0:0/h264 @ 0x1] Decoding error: Invalid data found when processing input\n"
        "Conversion failed!\n"
    )
    assert not disk_space.tool_reported_disk_full(text)
    assert disk_space.tool_reported_disk_full(FFMPEG_FULL)
    for line in ("av_interleaved_write_frame(): No space left on device",
                 "[mp4 @ 0x2] Error muxing a packet: No space left on device",
                 "/Users/x/Montaj/p/out.mp4: No space left on device",
                 "fatal: unable to write new index file: No space left on device"):
        assert disk_space.tool_reported_disk_full(line + "\nConversion failed!\n"), line


def test_a_cancelled_upload_check_releases_its_reservation(ws, monkeypatch):
    import asyncio
    import serve.server as server_mod

    async def hang(scope, own=0):
        await asyncio.sleep(3600)
    monkeypatch.setattr(server_mod, "_upload_preflight_off_loop", hang)

    async def inner(scope, receive, send):
        pytest.fail("never reached")

    async def main():
        scope = {"type": "http", "method": "POST", "path": "/api/upload", "headers": [(b"content-length", b"777")]}

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(m):
            pass
        task = asyncio.create_task(server_mod._DiskFullGuard(inner)(scope, receive, send))
        await asyncio.sleep(0.05)
        assert server_mod.reserved_upload_bytes() == 777
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(main())
    assert server_mod.reserved_upload_bytes() == 0


def test_init_runs_git_in_the_c_locale(ws, monkeypatch):
    # git prints its errors in the user's language; a French "Plus d'espace" was missed.
    monkeypatch.setenv("LANG", "fr_FR.UTF-8")
    monkeypatch.setenv("LC_ALL", "fr_FR.UTF-8")
    seen = {}

    def run(cmd, **k):
        seen.update(k.get("env") or {})
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")
    monkeypatch.setattr(init_mod.subprocess, "run", run)
    init_mod._git(["status"], str(ws))
    assert seen["LC_ALL"] == "C" and seen["LANG"] == "C"
    assert seen["GIT_AUTHOR_NAME"] == "montaj"
