"""Review fixes for the project write lock (§467): the lock must not freeze
serve's event loop, a filesystem that cannot lock is not 'held', a read-only
folder still opens, steps fail only on the keys they read, a lock timeout is a
503, and the lock key is the file's identity."""
import ast
import asyncio
import errno
import json
import os
import stat
import sys
import threading
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import lib.project_lock as pl  # noqa: E402
from tests.test_project_lock import spawn_holder  # noqa: E402
from tests.test_server_canvas_follows_footage import _setup as _serve_setup, client  # noqa: E402,F401
from tests.test_server_source_dims import PID  # noqa: E402


def _project(tmp_path):
    p = tmp_path / "project.json"
    p.write_text("{}")
    return p


# ── 1. serve's event loop is not frozen by a waiting lock ────────────────────

def test_a_waiting_put_does_not_freeze_other_requests(client, tmp_path):
    c, holder = client
    holder["dir"] = _serve_setup(tmp_path)
    proc = spawn_holder(holder["dir"] / "project.json", 2.0)
    out = {}
    try:
        def put():
            started = time.monotonic()
            out["put"] = c.put(f"/api/projects/{PID}", json={"id": PID, "name": "x"})
            out["put_wait"] = time.monotonic() - started
        t = threading.Thread(target=put)
        t.start()
        time.sleep(0.3)                       # the PUT is now waiting on the lock
        started = time.monotonic()
        r = c.get(f"/api/projects/{PID}/generated")
        out["get_wait"] = time.monotonic() - started
        t.join()
    finally:
        proc.wait()
    assert r.status_code == 200
    assert out["get_wait"] < 0.3, out
    assert out["put"].status_code == 200
    assert out["put_wait"] >= 1.0             # it did wait for the holder
    assert json.loads((holder["dir"] / "project.json").read_text())["name"] == "x"


def test_async_lock_waits_without_blocking_the_loop(tmp_path):
    path = _project(tmp_path)
    proc = spawn_holder(path, 1.0)
    ticks = []

    async def main():
        async def ticker():
            while True:
                ticks.append(time.monotonic())
                await asyncio.sleep(0.02)
        tk = asyncio.create_task(ticker())
        async with pl.project_lock_async(path, timeout=5):
            pass
        tk.cancel()

    try:
        asyncio.run(main())
    finally:
        proc.wait()
    gaps = [b - a for a, b in zip(ticks, ticks[1:])]
    assert len(ticks) > 20 and max(gaps) < 0.2


def test_async_lock_times_out_and_is_reentrant(tmp_path):
    path = _project(tmp_path)

    async def main():
        async with pl.project_lock_async(path, timeout=0.5):
            async with pl.project_lock_async(path, timeout=0.5):   # same task: reenters
                with pl.project_lock(path, timeout=0.5):           # sync helper inside
                    pass
    asyncio.run(main())

    proc = spawn_holder(path, 1.5)

    async def timeout():
        with pytest.raises(pl.ProjectLockTimeout):
            async with pl.project_lock_async(path, timeout=0.3):
                pass
    try:
        asyncio.run(timeout())
    finally:
        proc.kill()
        proc.wait()


def test_async_lock_excludes_a_thread(tmp_path):
    path = _project(tmp_path)
    got = []

    def thread_work():
        with pl.project_lock(path, timeout=5):
            got.append(time.monotonic())

    async def main():
        async with pl.project_lock_async(path, timeout=5):
            t = threading.Thread(target=thread_work)
            t.start()
            time.sleep(0.3)           # holding (synchronously): the thread must wait
            assert not got
            release = time.monotonic()
        t.join()
        assert got and got[0] >= release
    asyncio.run(main())


def _async_lock_with_bodies(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncWith):
            for item in node.items:
                call = item.context_expr
                if isinstance(call, ast.Call) and getattr(call.func, "attr", getattr(call.func, "id", "")) == "project_lock_async":
                    yield node


def _scan(path):
    return ast.parse(Path(path).read_text(encoding="utf-8"))


def test_no_await_inside_a_locked_section_and_no_blocking_lock_in_async_handlers():
    """The protected section is synchronous: a task that awaits while holding it
    would let another task on the same thread reenter the lock."""
    files = [p for p in (REPO_ROOT / "serve").rglob("*.py")]
    used = 0
    for f in files:
        tree = _scan(f)
        for node in _async_lock_with_bodies(tree):
            used += 1
            for stmt in node.body:
                for sub in ast.walk(stmt):
                    assert not isinstance(sub, (ast.Await, ast.AsyncFor, ast.AsyncWith)), \
                        f"{f.name}:{sub.lineno} awaits inside a project lock"
        # an `async def` must not take the blocking form directly
        for fn in ast.walk(tree):
            if isinstance(fn, ast.AsyncFunctionDef):
                for sub in ast.walk(fn):
                    if isinstance(sub, ast.With):
                        for item in sub.items:
                            ce = item.context_expr
                            name = getattr(ce.func, "id", None) if isinstance(ce, ast.Call) else None
                            assert name != "project_lock", f"{f.name}:{sub.lineno} blocking lock in async def {fn.name}"
    assert used >= 8


# ── 2. a filesystem that cannot lock is not 'held' ───────────────────────────

@pytest.mark.skipif(pl.fcntl is None, reason="posix flock")
@pytest.mark.parametrize("code", [errno.ENOLCK, errno.ENOTSUP, errno.ENOSYS, errno.EIO])
def test_unlockable_filesystem_falls_back_to_the_process_lock(tmp_path, monkeypatch, code):
    p = _project(tmp_path)

    def no_flock(fd, op):
        if op & pl.fcntl.LOCK_UN:
            return
        raise OSError(code, "cannot lock")
    monkeypatch.setattr(pl.fcntl, "flock", no_flock)
    started = time.monotonic()
    with pl.project_lock(p, timeout=3):
        pass
    assert time.monotonic() - started < 0.5

    async def a():
        async with pl.project_lock_async(p, timeout=3):
            pass
    asyncio.run(a())


@pytest.mark.skipif(pl.fcntl is None, reason="posix flock")
def test_unlockable_filesystem_is_logged_once_and_still_excludes_threads(tmp_path, monkeypatch, caplog):
    p = _project(tmp_path)
    monkeypatch.setattr(pl, "_warned_unlockable", False, raising=False)

    def no_flock(fd, op):
        if op & pl.fcntl.LOCK_UN:
            return
        raise OSError(errno.ENOLCK, "cannot lock")
    monkeypatch.setattr(pl.fcntl, "flock", no_flock)
    with caplog.at_level("WARNING"):
        for _ in range(3):
            with pl.project_lock(p, timeout=1):
                pass
    assert len([r for r in caplog.records if "lock" in r.getMessage().lower()]) == 1
    order = []

    def other():
        with pl.project_lock(p, timeout=3):
            order.append("other")
    with pl.project_lock(p, timeout=1):
        t = threading.Thread(target=other)
        t.start()
        time.sleep(0.2)
        order.append("first")
    t.join()
    assert order == ["first", "other"]


@pytest.mark.skipif(pl.fcntl is None, reason="posix flock")
def test_a_held_lock_is_still_busy(tmp_path):
    p = _project(tmp_path)
    proc = spawn_holder(p, 1.5)
    try:
        with pytest.raises(pl.ProjectLockTimeout):
            with pl.project_lock(p, timeout=0.3):
                pass
    finally:
        proc.kill()
        proc.wait()


# ── 3. a read-only folder still opens ────────────────────────────────────────

@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="chmod")
def test_lock_degrades_in_a_read_only_folder(tmp_path):
    d = tmp_path / "ro"
    d.mkdir()
    (d / "project.json").write_text("{}")
    os.chmod(d, stat.S_IRUSR | stat.S_IXUSR)
    try:
        with pl.project_lock(d / "project.json", timeout=0.5):
            pass

        async def a():
            async with pl.project_lock_async(d / "project.json", timeout=0.5):
                pass
        asyncio.run(a())
    finally:
        os.chmod(d, 0o755)


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="chmod")
def test_get_project_opens_in_a_read_only_folder(client, tmp_path):
    c, holder = client
    holder["dir"] = _serve_setup(tmp_path)
    os.chmod(holder["dir"], stat.S_IRUSR | stat.S_IXUSR)
    try:
        r = c.get(f"/api/projects/{PID}")
    finally:
        os.chmod(holder["dir"], 0o755)
    assert r.status_code == 200
    assert r.json()["id"] == PID


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="chmod")
def test_get_project_with_a_legacy_shape_in_a_read_only_folder_still_opens(client, tmp_path):
    c, holder = client
    d = _serve_setup(tmp_path)
    holder["dir"] = d
    doc = json.loads((d / "project.json").read_text())
    doc["tracks"] = [[]]                                   # legacy shape: the migration wants to write
    (d / "project.json").write_text(json.dumps(doc))
    os.chmod(d, stat.S_IRUSR | stat.S_IXUSR)
    try:
        r = c.get(f"/api/projects/{PID}")
    finally:
        os.chmod(d, 0o755)
    assert r.status_code == 200                            # the write degrades, as it did before the lock


def test_get_project_does_not_take_the_lock_when_nothing_migrates(client, tmp_path, monkeypatch):
    c, holder = client
    holder["dir"] = _serve_setup(tmp_path)
    proc = spawn_holder(holder["dir"] / "project.json", 1.5)
    try:
        started = time.monotonic()
        r = c.get(f"/api/projects/{PID}")
        waited = time.monotonic() - started
    finally:
        proc.kill()
        proc.wait()
    assert r.status_code == 200 and waited < 1.0


# ── 5. a lock timeout is a 503 ───────────────────────────────────────────────

def test_put_lock_timeout_is_503(client, tmp_path, monkeypatch):
    c, holder = client
    holder["dir"] = _serve_setup(tmp_path)
    monkeypatch.setattr(pl, "DEFAULT_TIMEOUT", 0.3)
    proc = spawn_holder(holder["dir"] / "project.json", 3.0)
    try:
        r = c.put(f"/api/projects/{PID}", json={"id": PID, "name": "x"})
    finally:
        proc.kill()
        proc.wait()
    assert r.status_code == 503
    assert r.json()["detail"] == {
        "error": "project_locked",
        "message": "Montaj is finishing another change to this project. Try again in a moment."}


def test_translation_site_lock_timeout_is_503(client, tmp_path, monkeypatch):
    c, holder = client
    holder["dir"] = _serve_setup(tmp_path)
    monkeypatch.setattr(pl, "DEFAULT_TIMEOUT", 0.3)
    proc = spawn_holder(holder["dir"] / "project.json", 3.0)
    try:
        r = c.post(f"/api/projects/{PID}/captions/translation", json={"lang": "es", "phrases": []})
    finally:
        proc.kill()
        proc.wait()
    assert r.status_code == 503
    assert r.json()["detail"]["error"] == "project_locked"


def test_the_app_maps_a_lock_timeout_to_503():
    """The mapping is app-wide: restore, rerun, include and the rest go through it."""
    from serve.server import app, _project_locked_handler
    assert app.exception_handlers[pl.ProjectLockTimeout] is _project_locked_handler
    r = asyncio.run(_project_locked_handler(None, pl.ProjectLockTimeout("busy")))
    assert r.status_code == 503
    assert json.loads(r.body)["detail"] == {
        "error": "project_locked",
        "message": "Montaj is finishing another change to this project. Try again in a moment."}


def test_background_write_back_retries_a_busy_lock(tmp_path, monkeypatch):
    from serve.routes import projects as routes
    monkeypatch.setattr(routes, "_WRITEBACK_PAUSE_SECONDS", 0.01)
    monkeypatch.setattr(pl, "DEFAULT_TIMEOUT", 0.05)
    d = _serve_setup(tmp_path)
    path = d / "project.json"
    calls = []
    proc = spawn_holder(path, 0.5)

    async def main():
        monkeypatch.setattr(routes, "_WRITEBACK_TRIES", 40)
        return await routes._locked_writeback([path], lambda: calls.append(1) or "done")
    try:
        assert asyncio.run(main()) == "done"       # retried until the holder let go
    finally:
        proc.wait()
    assert calls == [1]


def test_background_write_back_gives_up_and_logs(tmp_path, monkeypatch, caplog):
    from serve.routes import projects as routes
    monkeypatch.setattr(routes, "_WRITEBACK_PAUSE_SECONDS", 0.01)
    monkeypatch.setattr(routes, "_WRITEBACK_TRIES", 3)
    monkeypatch.setattr(pl, "DEFAULT_TIMEOUT", 0.05)
    d = _serve_setup(tmp_path)
    path = d / "project.json"
    proc = spawn_holder(path, 3.0)
    try:
        with caplog.at_level("WARNING"):
            assert asyncio.run(routes._locked_writeback([path], lambda: "done")) is None
    finally:
        proc.kill()
        proc.wait()
    assert any("write-back" in r.getMessage() for r in caplog.records)


def test_generate_captions_step_waits_up_to_30_seconds_and_then_fails_structured():
    src = (REPO_ROOT / "steps/transform/generate_captions.py").read_text()
    assert "timeout=30" in src or "STEP_LOCK_TIMEOUT" in src
    assert 'fail("project_locked"' in src


# ── 6. lock identity ─────────────────────────────────────────────────────────

def test_folder_with_a_dot_in_its_name_takes_one_lock(tmp_path):
    d = tmp_path / "Ad v1.2"
    d.mkdir()
    (d / "project.json").write_text("{}")
    assert pl._lock_path(d) == pl._lock_path(d / "project.json")
    with pl.project_lock(d, timeout=0.5):
        with pl.project_lock(d / "project.json", timeout=0.5):   # reentrant across spellings
            pass


def test_case_variants_of_one_folder_share_a_lock(tmp_path):
    d = tmp_path / "Proj"
    d.mkdir()
    (d / "project.json").write_text("{}")
    other = Path(str(d).replace("/Proj", "/proj")) / "project.json"
    if not other.exists():
        pytest.skip("case-sensitive filesystem")
    with pl.project_lock(d / "project.json", timeout=0.5):
        with pl.project_lock(other, timeout=0.5):
            pass


def test_symlinked_spellings_share_a_lock(tmp_path):
    d = tmp_path / "real"
    d.mkdir()
    (d / "project.json").write_text("{}")
    link = tmp_path / "link"
    link.symlink_to(d)
    with pl.project_lock(d / "project.json", timeout=0.5):
        with pl.project_lock(link / "project.json", timeout=0.5):
            pass


# ── 4. steps fail only on the keys they read ─────────────────────────────────

import shutil  # noqa: E402
import subprocess  # noqa: E402
from lib import speech_apply  # noqa: E402
from lib.speech_text import derive, render  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "speech_text")


@pytest.fixture
def senv(tmp_path):
    pdir = tmp_path / "proj"
    shutil.copytree(FIX, pdir)
    pj = pdir / "project.json"
    pj.write_text(pj.read_text().replace("/FIXTURE", str(pdir)))
    git = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]
    for args in (["init", "-q"], ["add", "project.json"], ["commit", "-q", "-m", "init"]):
        subprocess.run([*git, *args], cwd=pdir, capture_output=True, check=True)
    project = json.loads(pj.read_text())
    text = render(derive(project, str(pdir)), project.get("name") or project["id"])
    return type("E", (), {"dir": str(pdir), "path": str(pj), "text": text})


def _drop_a4(text):
    return "\n".join(ln for ln in text.split("\n") if not ln.startswith("A4 "))


def _edit_during_window(monkeypatch, path, mutate):
    real = speech_apply.commit_version

    def commit(*a, **k):
        v = real(*a, **k)
        doc = json.loads(Path(path).read_text())
        mutate(doc)
        Path(path).write_text(json.dumps(doc))
        return v
    monkeypatch.setattr(speech_apply, "commit_version", commit)


def test_speech_apply_survives_an_unrelated_change_in_its_window(senv, monkeypatch):
    def mutate(doc):
        doc["name"] = "renamed meanwhile"
        doc.setdefault("settings", {})["proxyReady"] = True
    _edit_during_window(monkeypatch, senv.path, mutate)
    out = speech_apply.apply(senv.path, _drop_a4(senv.text), preview=False, max_pause=None, feel="tight")
    assert out["applied"]
    doc = json.loads(Path(senv.path).read_text())
    assert doc["name"] == "renamed meanwhile"
    assert doc["settings"]["proxyReady"] is True


def test_speech_apply_refuses_a_change_to_its_own_keys(senv, monkeypatch, capsys):
    def mutate(doc):
        doc["markers"] = [{"id": "m-new", "time": 1.0, "label": "x"}]
    _edit_during_window(monkeypatch, senv.path, mutate)
    before = None
    with pytest.raises(SystemExit):
        speech_apply.apply(senv.path, _drop_a4(senv.text), preview=False, max_pause=None, feel="tight")
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "project_changed"
    assert json.loads(Path(senv.path).read_text())["markers"][0]["id"] == "m-new"


def test_speech_apply_refuses_changed_tracks(senv, monkeypatch, capsys):
    def mutate(doc):
        doc["tracks"][0]["volume"] = 0.5
    _edit_during_window(monkeypatch, senv.path, mutate)
    with pytest.raises(SystemExit):
        speech_apply.apply(senv.path, _drop_a4(senv.text), preview=False, max_pause=None, feel="tight")
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "project_changed"


# cross_cut and montage: project_changed on tracks, not on anything else

import steps.edit.cross_cut as cross_cut  # noqa: E402
import steps.edit.montage as montage  # noqa: E402


def _two_clip_project(tmp_path):
    def clip(cid, start):
        return {"id": cid, "type": "video", "src": f"./{cid}.mp4", "start": start,
                "end": start + 4.0, "inPoint": 0.0, "outPoint": 4.0}
    path = tmp_path / "project.json"
    path.write_text(json.dumps({"id": "p1", "name": "orig",
                                "tracks": [{"id": "trk-0", "items": [clip("a", 0.0), clip("b", 4.0)]}]}))
    return path


def _run(monkeypatch, module, path, argv, mutate):
    def find(pid):
        got = (path, json.loads(path.read_text()))
        doc = json.loads(path.read_text())
        mutate(doc)
        path.write_text(json.dumps(doc))
        return got
    monkeypatch.setattr(module, "find_project", find)
    monkeypatch.setattr(sys, "argv", argv)
    module.main()


CROSS = ["cross_cut.py", "--project-id", "p1", "--clip-a", "a", "--clip-b", "b", "--segment-duration", "1.0"]
MONT = ["montage.py", "--project-id", "p1", "--clips", json.dumps(["a", "b"]), "--beat-duration", "1.0"]


@pytest.mark.parametrize("module,argv", [(cross_cut, CROSS), (montage, MONT)])
def test_edit_steps_keep_an_unrelated_change(module, argv, tmp_path, monkeypatch):
    path = _two_clip_project(tmp_path)
    _run(monkeypatch, module, path, argv, lambda d: d.update(name="renamed"))
    doc = json.loads(path.read_text())
    assert doc["name"] == "renamed"
    assert len(doc["tracks"][0]["items"]) != 2 or doc["tracks"][0]["items"][0]["id"] != "a"


@pytest.mark.parametrize("module,argv", [(cross_cut, CROSS), (montage, MONT)])
def test_edit_steps_refuse_changed_tracks(module, argv, tmp_path, monkeypatch, capsys):
    path = _two_clip_project(tmp_path)
    with pytest.raises(SystemExit):
        _run(monkeypatch, module, path, argv, lambda d: d["tracks"][0]["items"].pop())
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "project_changed"


# approve / regen write through the lock

def test_approve_and_regen_use_update_project():
    for name in ("approve", "regen"):
        src = (REPO_ROOT / "cli" / "commands" / f"{name}.py").read_text()
        assert "update_project" in src, name
