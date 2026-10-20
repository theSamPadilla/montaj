"""Fifth review of the project write lock (§467): a canvas decision is made under
the lock, every blocking-lock helper runs under the async lock when called from
the event loop, a read-only lock file still locks, and background and step
callers fail only when they must."""
import ast
import asyncio
import json
import os
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import lib.project_lock as pl  # noqa: E402
from lib.project_lock import project_lock  # noqa: E402
from tests.test_project_lock import spawn_holder  # noqa: E402
from tests.test_project_lock_review4 import (  # noqa: E402,F401
    senv, _drop_a4, _two_clip_project,
)
from tests.test_server_canvas_follows_footage import _setup as _serve_setup, client  # noqa: E402,F401
from tests.test_server_source_dims import PID  # noqa: E402


class _BC:
    def __init__(self):
        self.frames = []

    def publish(self, pid, frame):
        self.frames.append(frame)


# ── 1. the canvas follows footage only on a read taken under the lock ────────

def test_canvas_decision_is_made_under_the_lock(tmp_path):
    import serve.routes.projects as P

    async def trial(i):
        d = tmp_path / f"c{i}"
        d.mkdir()
        proj = {
            "id": f"c{i}", "status": "draft", "version": "0.2",
            "settings": {"resolution": [1080, 1920], "resolutionSource": "default",
                         "fps": 30, "fpsSource": "explicit"},
            "tracks": [{"id": "trk-0", "items": [
                {"id": "clip-0", "type": "video", "src": "/nonexistent/a.mp4", "start": 0, "end": 1,
                 "inPoint": 0, "outPoint": 1, "sourceWidth": 1920, "sourceHeight": 1080}]}],
            "sources": [],
        }
        path = d / "project.json"
        path.write_text(json.dumps(proj))
        held = threading.Event()

        def holder():
            with project_lock(path):
                held.set()
                time.sleep(0.2)
        th = threading.Thread(target=holder)
        th.start()
        held.wait()
        canvas = asyncio.create_task(P._ensure_canvas_follows_footage(proj["id"], d, proj, None))
        await asyncio.sleep(0.03)   # it has read and is waiting for the lock
        req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(broadcaster=_BC())))
        body = {"id": proj["id"], "settings": {"resolution": [720, 1280], "fps": 30, "fpsSource": "explicit"}}
        put = asyncio.create_task(P.save_project(proj["id"], SimpleNamespace(headers={}), body, req, d))
        await asyncio.gather(canvas, put)
        th.join()
        return json.loads(path.read_text())["settings"]

    async def main():
        return [await trial(i) for i in range(20)]
    kept = [s for s in asyncio.run(main()) if s.get("resolutionSource") == "explicit"
            and s["resolution"] == [720, 1280]]
    assert len(kept) == 20


# ── 2. no blocking-lock helper runs on the loop outside the async lock ───────

# Sync helpers that take the blocking project_lock. The scan below adds anything
# that reaches one; this floor stops the list shrinking unnoticed.
KNOWN_BLOCKING_HELPERS = {
    "_apply_project_edits", "_update_downloading_record", "_start_source_download",
    "_ensure_source_download", "_patch_copied_media", "_ensure_current_proxies",
    "_finish_save_copy", "_fail_source_download",
}


def _callname(call):
    return getattr(call.func, "id", None) or getattr(call.func, "attr", None)


def _is_async_lock(node):
    return isinstance(node, ast.AsyncWith) and any(
        isinstance(i.context_expr, ast.Call) and _callname(i.context_expr) in ("project_lock_async", "_patient_lock")
        for i in node.items)


def _unguarded_calls(node, names, guarded=False):
    """(lineno, callee) for every call to one of `names` not under an async project
    lock (or inside an argument of _locked_writeback, which holds the locks)."""
    if _is_async_lock(node):
        guarded = True
    if isinstance(node, ast.Call):
        if _callname(node) == "_locked_writeback":
            guarded = True
        if _callname(node) in names and not guarded:
            yield node.lineno, _callname(node)
    for child in ast.iter_child_nodes(node):
        yield from _unguarded_calls(child, names, guarded)


def _blocking_helpers(trees):
    funcs = {}
    for tree in trees.values():
        for fn in tree.body:
            if isinstance(fn, ast.FunctionDef):
                funcs[fn.name] = fn
    blocking = set()
    for name, fn in funcs.items():
        for sub in ast.walk(fn):
            if isinstance(sub, ast.With) and any(
                    isinstance(i.context_expr, ast.Call) and _callname(i.context_expr) == "project_lock"
                    for i in sub.items):
                blocking.add(name)
    changed = True
    while changed:
        changed = False
        for name, fn in funcs.items():
            if name not in blocking and any(True for _ in _unguarded_calls(fn, blocking)):
                blocking.add(name)
                changed = True
    return blocking


def test_blocking_lock_helpers_are_only_called_under_the_async_lock():
    trees = {f: ast.parse(f.read_text(encoding="utf-8")) for f in (REPO_ROOT / "serve").rglob("*.py")}
    blocking = _blocking_helpers(trees)
    assert KNOWN_BLOCKING_HELPERS <= blocking, KNOWN_BLOCKING_HELPERS - blocking
    bad = []
    for f, tree in trees.items():
        for fn in ast.walk(tree):
            if isinstance(fn, ast.AsyncFunctionDef):
                for stmt in fn.body:
                    for line, callee in _unguarded_calls(stmt, blocking):
                        bad.append(f"{f.name}:{line} {fn.name} -> {callee}")
    assert not bad, bad


# ── 2b. a lock held by another process does not stall unrelated requests ─────

def test_get_project_resuming_a_download_does_not_freeze_other_requests(client, tmp_path, monkeypatch):
    from serve.routes import projects as routes
    c, holder = client
    holder["dir"] = d = _serve_setup(tmp_path)
    pj = d / "project.json"
    doc = json.loads(pj.read_text())
    doc["sourceDownload"] = {"kind": "youtube", "url": "https://youtu.be/dQw4w9WgXcQ",
                             "status": "downloading", "jobId": "old"}
    pj.write_text(json.dumps(doc))

    async def no_download(*a, **k):
        return None
    monkeypatch.setattr(routes, "_run_source_download", no_download)
    proc = spawn_holder(pj, 1.5)
    out = {}
    try:
        def get():
            out["r"] = c.get(f"/api/projects/{PID}")
        t = threading.Thread(target=get)
        t.start()
        time.sleep(0.3)
        started = time.monotonic()
        r = c.get(f"/api/projects/{PID}/generated")
        out["other"] = time.monotonic() - started
        t.join()
    finally:
        proc.wait()
    assert r.status_code == 200
    assert out["other"] < 0.3, out
    assert out["r"].status_code == 200
    assert out["r"].json()["sourceDownload"]["jobId"] != "old"   # it did wait, then resumed


def test_proxies_endpoint_does_not_freeze_other_requests(client, tmp_path, monkeypatch):
    from serve.routes import projects as routes
    c, holder = client
    holder["dir"] = d = _serve_setup(tmp_path)
    pj = d / "project.json"

    def sweep(project_id, project_dir, project, broadcaster=None):
        with project_lock(pj):   # what its write-back does when a proxy is already fresh
            pass
        return {"scheduled": 0, "alreadyFresh": 1, "probeFailed": []}
    monkeypatch.setattr(routes, "_ensure_current_proxies", sweep)
    proc = spawn_holder(pj, 1.5)
    out = {}
    try:
        def post():
            out["r"] = c.post(f"/api/projects/{PID}/proxies")
        t = threading.Thread(target=post)
        t.start()
        time.sleep(0.3)
        started = time.monotonic()
        r = c.get(f"/api/projects/{PID}/generated")
        out["other"] = time.monotonic() - started
        t.join()
    finally:
        proc.wait()
    assert r.status_code == 200 and out["other"] < 0.3, out
    assert out["r"].status_code == 200


def _max_loop_gap_during(coro_factory, hold_seconds, path):
    proc = spawn_holder(path, hold_seconds)
    gaps = []

    async def main():
        stop = asyncio.Event()

        async def ticker():
            last = time.monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.02)
                now = time.monotonic()
                gaps.append(now - last)
                last = now
        t = asyncio.create_task(ticker())
        try:
            return await coro_factory()
        finally:
            stop.set()
            await t
    try:
        result = asyncio.run(main())
    finally:
        proc.wait()
    return result, max(gaps)


def test_save_copy_patch_does_not_freeze_the_loop(tmp_path, monkeypatch):
    from serve.routes import projects as routes
    d = _serve_setup(tmp_path)
    pj = d / "project.json"
    monkeypatch.setattr(routes, "copy_borrowed_media", lambda wanted, folder: ({"k": "/copied"}, []))

    async def go():
        return await routes._copy_and_patch_media(PID, d, {}, {"k": "/borrowed"}, (), _BC(), False)
    (patched, report), gap = _max_loop_gap_during(go, 0.8, pj)
    assert gap < 0.3, gap


def test_download_progress_lines_do_not_freeze_the_loop(tmp_path):
    from serve.routes import projects as routes
    d = _serve_setup(tmp_path)
    pj = d / "project.json"
    doc = json.loads(pj.read_text())
    doc["sourceDownload"] = {"kind": "youtube", "url": "u", "status": "downloading", "jobId": "j1"}
    doc["name"] = ""
    pj.write_text(json.dumps(doc))
    from lib.youtube import MONTAJ_PREFIX
    bc = _BC()

    async def go():
        await asyncio.sleep(0.1)   # the ticker is running
        on_line = routes._source_download_line_handler(PID, d, "j1", bc)
        on_line(f"{MONTAJ_PREFIX} title " + json.dumps("A real title"))
        await asyncio.sleep(1.2)   # the holder lets go; the small task then writes
    _, gap = _max_loop_gap_during(go, 0.8, pj)
    assert gap < 0.3, gap
    assert json.loads(pj.read_text())["name"] == "A real title"


# ── 3. an unwritable lock file still locks ───────────────────────────────────

@pytest.mark.skipif(pl.fcntl is None or os.name == "nt" or os.geteuid() == 0, reason="posix chmod")
def test_read_only_lock_file_still_excludes_another_process(tmp_path, caplog):
    pj = tmp_path / "project.json"
    pj.write_text("{}")
    lock = tmp_path / pl.LOCK_NAME
    lock.write_text("")
    os.chmod(lock, 0o444)
    proc = spawn_holder(pj, 1.5)
    try:
        with pytest.raises(pl.ProjectLockTimeout):
            with pl.project_lock(pj, timeout=0.3):
                pass
    finally:
        proc.wait()
    with pl.project_lock(pj, timeout=1):   # free again
        pass


@pytest.mark.skipif(pl.fcntl is None or os.name == "nt" or os.geteuid() == 0, reason="posix chmod")
def test_every_degraded_path_is_logged_once_per_path(tmp_path, caplog, monkeypatch):
    monkeypatch.setattr(pl, "_warned_paths", set())
    d = tmp_path / "ro"
    d.mkdir()
    (d / "project.json").write_text("{}")
    os.chmod(d, stat.S_IRUSR | stat.S_IXUSR)
    try:
        with caplog.at_level("WARNING"):
            for _ in range(3):
                with pl.project_lock(d / "project.json", timeout=0.5):
                    pass
    finally:
        os.chmod(d, 0o755)
    assert len([r for r in caplog.records if "locking" in r.getMessage().lower()]) == 1


# ── 4. spurious failures ─────────────────────────────────────────────────────

def _flip_while_locked(path, change, secs=0.4):
    held = threading.Event()

    def run():
        with project_lock(path):
            held.set()
            time.sleep(secs)
            doc = json.loads(Path(path).read_text())
            change(doc)
            Path(path).write_text(json.dumps(doc))
    t = threading.Thread(target=run)
    t.start()
    held.wait()
    return t


def test_retry_download_rechecks_the_record_under_the_lock(client, tmp_path, monkeypatch):
    from serve.routes import projects as routes
    c, holder = client
    holder["dir"] = d = _serve_setup(tmp_path)
    pj = d / "project.json"
    doc = json.loads(pj.read_text())
    doc["sourceDownload"] = {"kind": "youtube", "url": "https://youtu.be/dQw4w9WgXcQ",
                             "status": "failed", "error": "failed"}
    pj.write_text(json.dumps(doc))
    ran = []

    async def no_download(*a, **k):
        ran.append(1)
    monkeypatch.setattr(routes, "_run_source_download", no_download)
    flipper = _flip_while_locked(pj, lambda doc: doc["sourceDownload"].update(status="done"))
    r = c.post(f"/api/projects/{PID}/source-download/retry")
    flipper.join()
    assert r.status_code == 409 and not ran
    assert json.loads(pj.read_text())["sourceDownload"]["status"] == "done"


def test_two_reruns_do_not_write_the_same_run_count(client, tmp_path, monkeypatch):
    from serve.routes import projects as routes
    c, holder = client
    holder["dir"] = d = _serve_setup(tmp_path)
    pj = d / "project.json"
    doc = json.loads(pj.read_text())
    doc["sources"] = [{"id": "s1", "src": "/x/a.mp4"}]
    doc["runCount"] = 1
    pj.write_text(json.dumps(doc))
    monkeypatch.setattr(routes, "_git_commit_sync", lambda *a, **k: time.sleep(0.3))
    threads = [threading.Thread(target=lambda: c.post(f"/api/projects/{PID}/rerun", json={})) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert json.loads(pj.read_text())["runCount"] == 3


def test_caption_pipeline_waits_as_long_as_the_caption_step():
    from serve.routes import projects as routes
    from steps.transform import generate_captions
    assert routes.CAPTION_LOCK_TIMEOUT == generate_captions.STEP_LOCK_TIMEOUT == 30.0


def test_get_project_with_a_legacy_shape_opens_when_the_lock_is_busy(client, tmp_path, monkeypatch):
    c, holder = client
    holder["dir"] = d = _serve_setup(tmp_path)
    pj = d / "project.json"
    doc = json.loads(pj.read_text())
    doc["tracks"] = [[{"id": "clip-0", "type": "video", "src": "/x/a.mp4", "start": 0, "end": 1,
                       "inPoint": 0, "outPoint": 1}]]
    pj.write_text(json.dumps(doc))
    before = pj.read_text()
    monkeypatch.setattr(pl, "DEFAULT_TIMEOUT", 0.1)
    proc = spawn_holder(pj, 1.0)
    try:
        r = c.get(f"/api/projects/{PID}")
    finally:
        proc.wait()
    assert r.status_code == 200
    assert isinstance(r.json()["tracks"][0], dict)   # served converged
    assert pj.read_text() == before                   # and nothing written


def _download_env(tmp_path, monkeypatch):
    from serve.routes import projects as routes
    d = _serve_setup(tmp_path)
    pj = d / "project.json"
    doc = json.loads(pj.read_text())
    doc["sourceDownload"] = {"kind": "youtube", "url": "https://youtu.be/dQw4w9WgXcQ",
                             "status": "downloading", "jobId": "j1"}
    pj.write_text(json.dumps(doc))
    media = d / "youtube-dQw4w9WgXcQ.mp4"
    media.write_bytes(b"x")
    monkeypatch.setattr(routes, "ingest_source", lambda *a, **k: {
        "type": "video", "src": str(media), "start": 0, "end": 1, "inPoint": 0, "outPoint": 1})
    monkeypatch.setattr(pl, "DEFAULT_TIMEOUT", 0.15)
    return routes, d, pj


def test_finalize_download_rides_out_a_short_lock_wait(tmp_path, monkeypatch):
    routes, d, pj = _download_env(tmp_path, monkeypatch)
    proc = spawn_holder(pj, 0.3)       # past one 0.15 s wait, within three
    try:
        asyncio.run(routes._run_source_download(PID, d, "https://youtu.be/dQw4w9WgXcQ",
                                                "dQw4w9WgXcQ", "j1", _BC()))
    finally:
        proc.wait()
    assert json.loads(pj.read_text())["sourceDownload"]["status"] == "done"


def test_failed_download_record_never_raises_out_of_the_task(tmp_path, monkeypatch):
    routes, d, pj = _download_env(tmp_path, monkeypatch)
    proc = spawn_holder(pj, 2.5)       # outlasts every try
    try:
        asyncio.run(routes._run_source_download(PID, d, "https://youtu.be/dQw4w9WgXcQ",
                                                "dQw4w9WgXcQ", "j1", _BC()))   # must not raise
    finally:
        proc.wait()
    assert json.loads(pj.read_text())["sourceDownload"]["status"] == "downloading"


def _step_locked(monkeypatch, capsys, fn):
    monkeypatch.setattr(pl, "DEFAULT_TIMEOUT", 0.2)
    with pytest.raises(SystemExit):
        fn()
    err = [ln for ln in capsys.readouterr().err.strip().splitlines() if ln.startswith("{")]
    assert json.loads(err[-1])["error"] == "project_locked"


@pytest.mark.parametrize("name,argv", [
    ("steps.edit.jump_cut", ["jump_cut.py", "--project-id", "p1", "--clip-id", "a", "--cuts", "[[1,2]]"]),
    ("steps.edit.cross_cut", ["cross_cut.py", "--project-id", "p1", "--clip-a", "a", "--clip-b", "b",
                              "--segment-duration", "1.0"]),
    ("steps.edit.montage", ["montage.py", "--project-id", "p1", "--clips", json.dumps(["a", "b"]),
                            "--beat-duration", "1.0"]),
])
def test_edit_steps_fail_structured_when_the_project_stays_locked(name, argv, tmp_path, monkeypatch, capsys):
    import importlib
    module = importlib.import_module(name)
    path = _two_clip_project(tmp_path)
    monkeypatch.setattr(module, "find_project", lambda pid: (path, json.loads(path.read_text())))
    monkeypatch.setattr(sys, "argv", argv)
    proc = spawn_holder(path, 2.5)
    try:
        _step_locked(monkeypatch, capsys, module.main)
    finally:
        proc.kill()
        proc.wait()


def test_speech_edit_fails_structured_when_the_project_stays_locked(senv, monkeypatch, capsys):
    proc = spawn_holder(senv.path, 2.5)
    try:
        _step_locked(monkeypatch, capsys, lambda: speech_apply_call(senv))
    finally:
        proc.kill()
        proc.wait()


def speech_apply_call(senv):
    from lib import speech_apply
    speech_apply.apply(senv.path, _drop_a4(senv.text), preview=False, max_pause=None, feel="tight")


def test_ai_video_helpers_fail_structured_when_the_project_stays_locked(tmp_path, monkeypatch, capsys):
    from lib import ai_video
    path = _two_clip_project(tmp_path)
    proc = spawn_holder(path, 2.5)
    try:
        project = json.loads(path.read_text())
        for call in (lambda: ai_video.save_project(path, project),
                     lambda: ai_video.save_project_changes(path, json.loads(path.read_text()), project),
                     lambda: ai_video._commit_fresh(path, project, lambda fresh: fresh)):
            _step_locked(monkeypatch, capsys, call)
    finally:
        proc.kill()
        proc.wait()


def test_multi_project_write_back_does_not_hold_one_lock_while_waiting_for_another(tmp_path, monkeypatch):
    from serve.routes import projects as routes
    a = tmp_path / "a"
    b = tmp_path / "b"
    for p in (a, b):
        p.mkdir()
        (p / "project.json").write_text("{}")
    monkeypatch.setattr(routes, "_WRITEBACK_LOCK_TIMEOUT", 0.1, raising=False)
    monkeypatch.setattr(routes, "_WRITEBACK_PAUSE_SECONDS", 0.2)
    monkeypatch.setattr(routes, "_WRITEBACK_TRIES", 40)
    proc = spawn_holder(b / "project.json", 2.0)
    got = {}

    def other_writer():
        time.sleep(0.3)
        try:
            with project_lock(a / "project.json", timeout=0.8):
                got["a"] = True
        except pl.ProjectLockTimeout:
            got["a"] = False

    t = threading.Thread(target=other_writer)
    t.start()
    try:
        result = asyncio.run(routes._locked_writeback([a / "project.json", b / "project.json"], lambda: "done"))
    finally:
        t.join()
        proc.wait()
    assert result == "done"
    assert got["a"] is True      # project a was free for other writers while b was busy


def test_unused_project_locked_helper_is_gone():
    import serve.common as common
    assert not hasattr(common, "project_locked")
