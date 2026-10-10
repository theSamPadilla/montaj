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
