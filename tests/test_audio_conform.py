"""Conformed audio cache (§190 T1): /api/audio/conform, /api/audio/conformed, LRU.

Fixtures are generated with ffmpeg lavfi in a tmp workspace; no real footage.
"""
import os
import subprocess
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from lib.common import ffmpeg_bin
from serve import audio_conform as ac
from serve.server import app


def _ff(*args):
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", *args], check=True)


@pytest.fixture
def ws(tmp_path, monkeypatch):
    w = tmp_path / "workspace"
    w.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(w))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    ac._running.clear()
    ac._failed.clear()
    return w


@pytest.fixture
def client(ws):
    return TestClient(app)


def _tone(path: Path, secs=1, freq=440, fmt_args=()):
    _ff("-f", "lavfi", "-i", f"sine=f={freq}:d={secs}:r=44100", *fmt_args, str(path))
    return path


def _wait_ready(client, path, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        r = client.get("/api/audio/conformed", params={"path": str(path)}).json()
        if r["status"] not in ("running", "missing"):
            return r
        time.sleep(0.05)
    raise AssertionError(f"conform never finished: {r}")


def _wait_idle(timeout=30):
    end = time.time() + timeout
    while ac._running and time.time() < end:
        time.sleep(0.02)


def test_conform_ready_with_exact_byte_size(client, ws):
    src = _tone(ws / "a.wav", secs=1)
    r = client.post("/api/audio/conform", json={"paths": [str(src)]})
    assert r.status_code == 200
    assert r.json()["results"][0]["status"] in ("running", "ready")
    st = _wait_ready(client, src)
    assert st["status"] == "ready"
    assert (st["format"], st["sampleRate"], st["channels"]) == ("pcm_s16le", 48000, 2)
    assert st["bytes"] == st["frames"] * 2 * 2
    assert abs(st["frames"] - 48000) <= 1024
    pcm = Path(ac.cache_dir()) / (Path(st["url"].split("path=")[1]).name)
    assert pcm.stat().st_size == st["bytes"]
    assert not list(ac.cache_dir().glob("*.tmp"))


def test_codecs_conform(client, ws):
    m4a = ws / "a.m4a"
    _tone(m4a, fmt_args=("-c:a", "aac"))
    mp3 = ws / "a.mp3"
    _tone(mp3, fmt_args=("-c:a", "libmp3lame"))
    for p in (m4a, mp3):
        client.post("/api/audio/conform", json={"paths": [str(p)]})
        assert _wait_ready(client, p)["status"] == "ready"


def test_second_request_reuses_entry(client, ws):
    src = _tone(ws / "a.wav")
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    _wait_ready(client, src)
    before = sorted(p.name for p in ac.cache_dir().iterdir())
    pcm = next(ac.cache_dir().glob("*.pcm"))
    mtime = pcm.stat().st_mtime_ns
    r = client.post("/api/audio/conform", json={"paths": [str(src)]}).json()
    assert r["results"][0]["status"] == "ready"
    assert sorted(p.name for p in ac.cache_dir().iterdir()) == before
    assert pcm.stat().st_mtime_ns == mtime


def test_changed_source_gets_new_key(client, ws):
    src = _tone(ws / "a.wav")
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    _wait_ready(client, src)
    old = {p.name for p in ac.cache_dir().glob("*.pcm")}
    st = src.stat()
    os.utime(src, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    assert client.get("/api/audio/conformed", params={"path": str(src)}).json()["status"] == "missing"
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    _wait_ready(client, src)
    new = {p.name for p in ac.cache_dir().glob("*.pcm")}
    assert len(new - old) == 1


def test_silent_source(client, ws):
    src = ws / "v.mp4"
    _ff("-f", "lavfi", "-i", "color=c=black:s=64x64:d=1:r=10", "-an", str(src))
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    st = _wait_ready(client, src)
    assert st["status"] == "silent"
    assert st["url"] is None
    assert not list(ac.cache_dir().glob("*.pcm"))
    assert len(list(ac.cache_dir().glob("*.json"))) == 1


def test_video_with_audio_conforms(client, ws):
    src = ws / "v.mp4"
    _ff("-f", "lavfi", "-i", "color=c=black:s=64x64:d=1:r=10",
        "-f", "lavfi", "-i", "sine=f=300:d=1", "-shortest", "-c:a", "aac", str(src))
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    assert _wait_ready(client, src)["status"] == "ready"


def test_outside_roots_refused(client, ws, tmp_path):
    outside = _tone(tmp_path / "outside.wav")
    r = client.post("/api/audio/conform", json={"paths": [str(outside)]})
    assert r.status_code == 403
    r = client.get("/api/audio/conformed", params={"path": str(outside)})
    assert r.status_code == 403
    assert not ac.cache_dir().exists()


def test_traversal_and_relative_refused(client, ws):
    assert client.get("/api/audio/conformed", params={"path": "a.wav"}).status_code == 400
    assert client.get("/api/audio/conformed",
                      params={"path": str(ws / ".." / "x.wav")}).status_code == 403


def test_missing_source(client, ws):
    r = client.post("/api/audio/conform", json={"paths": [str(ws / "nope.wav")]}).json()
    assert r["results"][0]["status"] == "missing"


def _entry(d, key, size, last_access):
    import json
    (d / f"{key}.pcm").write_bytes(b"\0" * size)
    (d / f"{key}.json").write_text(json.dumps({"lastAccess": last_access, "bytes": size}))


def test_lru_evicts_oldest_accessed(ws):
    d = ac.cache_dir()
    d.mkdir(parents=True)
    _entry(d, "old", 1000, 100)
    _entry(d, "mid", 1000, 200)
    _entry(d, "new", 1000, 300)
    assert ac.evict(max_bytes=2500) == ["old"]
    assert not (d / "old.pcm").exists() and not (d / "old.json").exists()
    assert (d / "mid.pcm").exists() and (d / "new.pcm").exists()


def test_lru_cap_env_override(ws, monkeypatch):
    monkeypatch.setenv("MONTAJ_CONFORM_CACHE_BYTES", "1500")
    d = ac.cache_dir()
    d.mkdir(parents=True)
    _entry(d, "a", 1000, 1)
    _entry(d, "b", 1000, 2)
    assert ac.evict() == ["a"]


def test_running_job_never_evicted(ws):
    d = ac.cache_dir()
    d.mkdir(parents=True)
    _entry(d, "old", 1000, 100)
    _entry(d, "new", 1000, 300)
    ac._running["old"] = object()
    try:
        # old is the LRU victim but has a running job: it is skipped, the next goes
        assert ac.evict(max_bytes=1000) == ["new"]
    finally:
        ac._running.clear()
    assert (d / "old.pcm").exists()


def test_eviction_after_conform_with_small_cap(client, ws, monkeypatch):
    a = _tone(ws / "a.wav")
    client.post("/api/audio/conform", json={"paths": [str(a)]})
    _wait_ready(client, a)
    _wait_idle()
    import json
    ja = next(ac.cache_dir().glob("*.json"))  # age it past the protection window
    meta = json.loads(ja.read_text())
    meta["lastAccess"] = 1.0
    ja.write_text(json.dumps(meta))
    monkeypatch.setenv("MONTAJ_CONFORM_CACHE_BYTES", str(250_000))  # one 1 s entry is ~192 KB
    b = _tone(ws / "b.wav", freq=880)
    client.post("/api/audio/conform", json={"paths": [str(b)]})
    _wait_ready(client, b)
    _wait_idle()
    assert client.get("/api/audio/conformed", params={"path": str(a)}).json()["status"] == "missing"
    assert client.get("/api/audio/conformed", params={"path": str(b)}).json()["status"] == "ready"


def test_lookup_updates_last_access(client, ws):
    import json
    src = _tone(ws / "a.wav")
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    _wait_ready(client, src)
    j = next(ac.cache_dir().glob("*.json"))
    meta = json.loads(j.read_text())
    meta["lastAccess"] = 1.0
    j.write_text(json.dumps(meta))
    client.get("/api/audio/conformed", params={"path": str(src)})
    assert json.loads(j.read_text())["lastAccess"] > 1000.0


def test_pcm_served_with_range(client, ws):
    src = _tone(ws / "a.wav")
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    st = _wait_ready(client, src)
    pcm = next(ac.cache_dir().glob("*.pcm"))
    data = pcm.read_bytes()
    r = client.get(st["url"], headers={"Range": "bytes=100-299"})
    assert r.status_code == 206
    assert r.content == data[100:300]
    assert r.headers["content-range"] == f"bytes 100-299/{len(data)}"


def test_concurrent_requests_join_one_job(client, ws, monkeypatch):
    src = _tone(ws / "a.wav")
    calls = []
    real = ac._conform
    def slow(*a):
        calls.append(1)
        time.sleep(0.3)
        return real(*a)
    monkeypatch.setattr(ac, "_conform", slow)
    for _ in range(3):
        client.post("/api/audio/conform", json={"paths": [str(src)]})
    _wait_ready(client, src)
    assert len(calls) == 1


def test_hung_ffmpeg_times_out_and_frees_slot(client, ws, monkeypatch):
    src = _tone(ws / "a.wav")
    fake = ws / "fake_ffmpeg.sh"
    fake.write_text("#!/bin/sh\nfor last; do :; done\necho x > \"$last\"\nsleep 30\n")
    fake.chmod(0o755)
    monkeypatch.setattr(ac, "ffmpeg_bin", lambda: str(fake))
    monkeypatch.setattr(ac, "FFMPEG_BASE_TIMEOUT", 0.3)
    monkeypatch.setattr(ac, "FFMPEG_DURATION_FACTOR", 0)
    t0 = time.time()
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    r = _wait_ready(client, src, timeout=10)
    assert r == {"path": str(src), "status": "failed", "error": "timeout"}
    assert time.time() - t0 < 10
    assert not ac._running
    d = ac.cache_dir()
    assert not list(d.glob("*.tmp")) and not list(d.glob("*.pcm"))


def test_ffmpeg_timeout_is_capped():
    assert ac._ffmpeg_timeout(0) == ac.FFMPEG_BASE_TIMEOUT
    assert ac._ffmpeg_timeout(10) == ac.FFMPEG_BASE_TIMEOUT + 2 * 10
    assert ac._ffmpeg_timeout(10 ** 9) == ac.FFMPEG_MAX_TIMEOUT


def test_fifo_refused(client, ws):
    fifo = ws / "pipe.wav"
    os.mkfifo(fifo)
    r = client.post("/api/audio/conform", json={"paths": [str(fifo)]})
    assert r.status_code == 400
    assert client.get("/api/audio/conformed", params={"path": str(fifo)}).status_code == 400
    assert ac.start(fifo) == {"status": "missing"}
    assert ac.lookup(fifo) == {"status": "missing"}


def test_tmp_names_unique_per_process_and_thread(ws, monkeypatch):
    src = _tone(ws / "a.wav")
    seen = []
    real = subprocess.run
    def spy(cmd, *a, **k):
        if ac.ffmpeg_bin() in cmd:
            seen.append(cmd[-1])
        return real(cmd, *a, **k)
    monkeypatch.setattr(ac.subprocess, "run", spy)
    key, st = ac.key_for(src)
    ac._conform(src, key, st)
    name = Path(seen[0]).name
    assert name == f"{key}.{os.getpid()}.{__import__('threading').get_ident()}.pcm.tmp"


def test_evict_sweeps_old_orphan_tmp_only(ws):
    d = ac.cache_dir()
    d.mkdir(parents=True)
    old, new = d / "a.1.2.pcm.tmp", d / "b.1.2.pcm.tmp"
    old.write_bytes(b"x")
    new.write_bytes(b"x")
    t = time.time() - 7200
    os.utime(old, (t, t))
    ac.evict()
    assert not old.exists() and new.exists()


def test_evict_sweeps_orphan_json(ws):
    import json
    d = ac.cache_dir()
    d.mkdir(parents=True)
    (d / "orphan.json").write_text(json.dumps({"lastAccess": time.time(), "silent": False}))
    _entry(d, "live", 10, time.time())
    ac.evict()
    assert not (d / "orphan.json").exists()
    assert (d / "live.json").exists() and (d / "live.pcm").exists()


def test_evict_ages_out_silent_entries(ws):
    import json
    d = ac.cache_dir()
    d.mkdir(parents=True)
    (d / "stale.json").write_text(json.dumps({"silent": True, "lastAccess": time.time() - 31 * 86400}))
    (d / "fresh.json").write_text(json.dumps({"silent": True, "lastAccess": time.time() - 86400}))
    ac.evict()
    assert not (d / "stale.json").exists()
    assert (d / "fresh.json").exists()


def test_conform_follows_timestamp_hole(client, ws):
    """A 300 ms timestamp hole is filled, as the export does (§190 T8 M1)."""
    src = ws / "hole.m4a"
    _ff("-f", "lavfi", "-i", "sine=f=440:d=1:r=48000",
        "-af", "asetpts='if(gte(N,24000),PTS+0.3/TB,PTS)'", "-c:a", "aac", str(src))
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    st = _wait_ready(client, src)
    assert abs(st["frames"] - 62400) <= 1024


def test_post_hit_updates_last_access(client, ws):
    import json
    src = _tone(ws / "a.wav")
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    _wait_ready(client, src)
    _wait_idle()
    j = next(ac.cache_dir().glob("*.json"))
    meta = json.loads(j.read_text())
    meta["lastAccess"] = 1.0
    j.write_text(json.dumps(meta))
    assert client.post("/api/audio/conform", json={"paths": [str(src)]}).json()["results"][0]["status"] == "ready"
    assert json.loads(j.read_text())["lastAccess"] > 1000.0


def test_post_hit_protects_entry_from_eviction(client, ws):
    import json
    a, b = _tone(ws / "a.wav"), _tone(ws / "b.wav", freq=880)
    for p in (a, b):
        client.post("/api/audio/conform", json={"paths": [str(p)]})
        _wait_ready(client, p)
    _wait_idle()
    ka, kb = ac.key_for(a)[0], ac.key_for(b)[0]
    d = ac.cache_dir()
    for k, t in ((ka, 100.0), (kb, 200.0)):  # A older than B
        meta = json.loads((d / f"{k}.json").read_text())
        meta["lastAccess"] = t
        (d / f"{k}.json").write_text(json.dumps(meta))
    client.post("/api/audio/conform", json={"paths": [str(a)]})
    size = (d / f"{ka}.pcm").stat().st_size
    assert ac.evict(max_bytes=size) == [kb]
    assert (d / f"{ka}.pcm").exists()


def test_evict_continues_past_undeletable_entry(ws, monkeypatch):
    d = ac.cache_dir()
    d.mkdir(parents=True)
    for k, t in (("a", 1), ("b", 2), ("c", 3)):
        _entry(d, k, 1000, t)
    real = Path.unlink
    def flaky(self, *a, **k):
        if self.name == "a.pcm":
            raise PermissionError("in use")
        return real(self, *a, **k)
    monkeypatch.setattr(Path, "unlink", flaky)
    ac.evict(max_bytes=1000)
    assert not (d / "b.pcm").exists()
    assert (d / "c.pcm").exists()


def test_shutdown_cancels_queued_futures(ws, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    pool = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(ac, "_pool", pool)
    gate = threading.Event()
    pool.submit(gate.wait)
    queued = pool.submit(lambda: 1)
    try:
        ac.shutdown()
        assert queued.cancelled()
    finally:
        gate.set()


# --- §191: low priority, backup exclusion, recent-use protection ---

class _FakeRun:
    def __init__(self, real, calls):
        self.real, self.calls = real, calls

    def __call__(self, cmd, *a, **k):
        self.calls.append((cmd, k))
        return self.real(cmd, *a, **k)


def _ffmpeg_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(ac.subprocess, "run", _FakeRun(subprocess.run, calls))
    return calls


def _conform_ffmpeg_call(client, ws, monkeypatch):
    calls = _ffmpeg_calls(monkeypatch)
    src = _tone(ws / "a.wav")
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    _wait_ready(client, src)
    ff = [c for c in calls if "-af" in c[0]]
    assert len(ff) == 1
    return ff[0]


def test_conform_ffmpeg_gets_posix_priority(client, ws, monkeypatch):
    monkeypatch.setattr(ac.sys, "platform", "linux")
    fake = ws / "fake_nice.sh"  # drops "-n 10" and runs the rest
    fake.write_text('#!/bin/sh\nshift 2\nexec "$@"\n')
    fake.chmod(0o755)
    monkeypatch.setattr(ac, "_nice_bin", lambda: str(fake))
    cmd, kw = _conform_ffmpeg_call(client, ws, monkeypatch)
    assert cmd[:3] == [str(fake), "-n", "10"]
    assert "preexec_fn" not in kw and "creationflags" not in kw
    assert kw["timeout"] > 0 and kw["capture_output"] is True


def test_posix_argv_starts_with_nice(monkeypatch):
    monkeypatch.setattr(ac.sys, "platform", "linux")
    monkeypatch.setattr(ac, "_nice_bin", lambda: "/usr/bin/nice")
    argv, kw = ac._low_priority(["ffmpeg", "-i", "x"])
    assert argv == ["/usr/bin/nice", "-n", "10", "ffmpeg", "-i", "x"] and kw == {}


def test_no_nice_runs_ffmpeg_unprefixed(monkeypatch):
    monkeypatch.setattr(ac.sys, "platform", "linux")
    monkeypatch.setattr(ac.os.path, "exists", lambda p: False)
    monkeypatch.setattr(ac.shutil, "which", lambda n: None)
    assert ac._low_priority(["ffmpeg", "-i", "x"]) == (["ffmpeg", "-i", "x"], {})


def test_nice_falls_back_to_path_lookup(monkeypatch):
    monkeypatch.setattr(ac.sys, "platform", "linux")
    monkeypatch.setattr(ac.os.path, "exists", lambda p: False)
    monkeypatch.setattr(ac.shutil, "which", lambda n: "/opt/nice")
    assert ac._low_priority(["f"])[0] == ["/opt/nice", "-n", "10", "f"]


def test_conform_ffmpeg_gets_windows_priority(monkeypatch):
    monkeypatch.setattr(ac.sys, "platform", "win32")
    monkeypatch.setattr(ac.subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0x4000, raising=False)
    assert ac._low_priority(["f"]) == (["f"], {"creationflags": 0x4000})


def test_backup_exclusion_called_once_on_darwin(client, ws, monkeypatch):
    monkeypatch.setattr(ac.sys, "platform", "darwin")
    ac._tm_done.clear()
    calls = []
    real = subprocess.run
    def fake(cmd, *a, **k):
        if cmd and cmd[0] == "/usr/bin/xattr":
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, "", "")
        return real(cmd, *a, **k)
    monkeypatch.setattr(ac.subprocess, "run", fake)
    for n in ("a", "b"):
        src = _tone(ws / f"{n}.wav")
        client.post("/api/audio/conform", json={"paths": [str(src)]})
        _wait_ready(client, src)
    assert calls == [["/usr/bin/xattr", "-w", "com.apple.metadata:com_apple_backup_excludeItem",
                      "com.apple.backupd", str(ws / ".cache")]]


def test_backup_exclusion_skipped_off_darwin(client, ws, monkeypatch):
    monkeypatch.setattr(ac.sys, "platform", "linux")
    ac._tm_done.clear()
    calls = _ffmpeg_calls(monkeypatch)
    src = _tone(ws / "a.wav")
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    _wait_ready(client, src)
    assert not [c for c in calls if c[0][0] == "/usr/bin/xattr"]


@pytest.mark.parametrize("exc", [FileNotFoundError("x"), subprocess.TimeoutExpired("x", 5)])
def test_backup_exclusion_error_never_fails_conform(client, ws, monkeypatch, exc):
    monkeypatch.setattr(ac.sys, "platform", "darwin")
    ac._tm_done.clear()
    real = subprocess.run
    def fake(cmd, *a, **k):
        if cmd and cmd[0] == "/usr/bin/xattr":
            raise exc
        return real(cmd, *a, **k)
    monkeypatch.setattr(ac.subprocess, "run", fake)
    src = _tone(ws / "a.wav")
    client.post("/api/audio/conform", json={"paths": [str(src)]})
    assert _wait_ready(client, src)["status"] == "ready"


@pytest.mark.skipif(not (ac.sys.platform == "darwin" and os.path.exists("/usr/bin/xattr")),
                    reason="macOS only")
def test_backup_exclusion_real_xattr(tmp_path):
    ac._tm_done.discard(str(tmp_path))
    ac._exclude_from_backup(tmp_path)
    out = subprocess.run(["/usr/bin/xattr", "-p", "com.apple.metadata:com_apple_backup_excludeItem",
                          str(tmp_path)], capture_output=True, text=True)
    assert out.stdout.strip() == "com.apple.backupd"


def test_recent_entry_survives_eviction_old_one_goes(ws):
    d = ac.cache_dir()
    d.mkdir(parents=True)
    now = time.time()
    _entry(d, "old", 1000, now - ac.PROTECT_SECONDS - 60)
    _entry(d, "recent", 1000, now - 60)
    assert ac.evict(max_bytes=1000) == ["old"]
    assert (d / "recent.pcm").exists()


def test_recent_entry_spared_even_when_oldest(ws):
    d = ac.cache_dir()
    d.mkdir(parents=True)
    now = time.time()
    _entry(d, "recent", 1000, now - 60)
    _entry(d, "newer", 1000, now - 10)
    _entry(d, "old", 1000, now - 5000)
    assert ac.evict(max_bytes=1000) == ["old"]


def test_over_budget_with_only_recent_entries_evicts_nothing(ws):
    d = ac.cache_dir()
    d.mkdir(parents=True)
    now = time.time()
    for k in "abc":
        _entry(d, k, 1000, now - 5)
    ac._warned_over_budget = False
    assert ac.evict(max_bytes=1000) == []
    assert len(list(d.glob("*.pcm"))) == 3
