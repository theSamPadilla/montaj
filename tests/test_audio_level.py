"""silentAudio flag: lib/audio_level.py plus its ingest and init callers (data only)."""
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.audio_level import audio_levels, is_silent_audio
from lib.common import ffmpeg_bin
from lib.ingest import ingest_source
from tests.conftest import HAS_FFMPEG
from tests.test_init import _project_path_from_stdout, run_init

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


def _mp4(path, audio):
    """1 s video; audio is 'silent', 'tone' or None (no audio stream)."""
    cmd = [ffmpeg_bin(), "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=1:r=30"]
    if audio == "silent":
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1", "-c:a", "aac"]
    elif audio == "tone":
        cmd += ["-f", "lavfi", "-i", "sine=f=440:d=1", "-c:a", "aac"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    return path


def test_levels_silent_tone_and_no_audio(tmp_path):
    silent = _mp4(tmp_path / "s.mp4", "silent")
    tone = _mp4(tmp_path / "t.mp4", "tone")
    noaud = _mp4(tmp_path / "n.mp4", None)
    assert audio_levels(silent)[1] <= -60
    assert audio_levels(tone)[1] > -20
    assert audio_levels(noaud) is None
    assert audio_levels(tmp_path / "missing.mp4") is None
    assert is_silent_audio(silent) is True
    assert is_silent_audio(tone) is False
    assert is_silent_audio(noaud) is False


@pytest.mark.parametrize("audio,flagged", [("silent", True), ("tone", False), (None, False)])
def test_ingest_flags_only_silent(tmp_path, audio, flagged):
    src = _mp4(tmp_path / "in" / "a.mp4", audio) if (tmp_path / "in").mkdir() is None else None
    proj = tmp_path / "proj"
    proj.mkdir()
    clip = ingest_source(str(proj), str(src), "sdr_bt709", proxy=False)
    if flagged:
        assert clip["silentAudio"] is True
    else:
        assert "silentAudio" not in clip


def _wait_for(pred, secs=20):
    end = time.time() + secs
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.1)
    return pred()


@pytest.mark.parametrize("mode", [[], ["--normalize", "lazy"]])
def test_init_flags_silent_in_the_background(tmp_path, mode):
    silent = _mp4(tmp_path / "s.mp4", "silent")
    tone = _mp4(tmp_path / "t.mp4", "tone")
    noaud = _mp4(tmp_path / "n.mp4", None)
    result = run_init("--prompt", "p", "--workflow", "overlays",
                      "--clips", str(silent), str(tone), str(noaud), *mode,
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    path = _project_path_from_stdout(result.stdout)

    def flagged():
        data = json.loads(path.read_text())
        return {Path(s["src"]).name[0] for s in data["sources"] if s.get("silentAudio") is True}

    assert _wait_for(lambda: flagged() == {"s"}), flagged()
    time.sleep(0.5)
    assert flagged() == {"s"}


def test_init_does_not_measure_inline(tmp_path, monkeypatch):
    """Init hands the originals to the background scheduler and never measures itself."""
    import project.init as init
    clip = _mp4(tmp_path / "s.mp4", "silent")
    seen = {}
    monkeypatch.setattr(init, "schedule_silent_audio", lambda p, o: seen.update(path=p, originals=dict(o)))
    import lib.audio_level as al
    monkeypatch.setattr(al, "audio_levels", lambda *a, **k: pytest.fail("measured inline"))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["init.py", "--prompt", "p", "--workflow", "overlays",
                                      "--clips", str(clip), "--normalize", "lazy"])
    init._main()
    assert len(seen["originals"]) == 1
    assert list(seen["originals"].values())[0].endswith("s.mp4")


def _project(tmp_path, sources):
    path = tmp_path / "project.json"
    path.write_text(json.dumps({"id": "p1", "sources": sources, "tracks": []}))
    return path


def test_pass_flags_silent_only_and_ignores_removed(tmp_path, monkeypatch):
    import lib.audio_level as al
    path = _project(tmp_path, [{"id": "a", "src": "a.mp4"}, {"id": "b", "src": "b.mp4"}])
    monkeypatch.setattr(al, "is_silent_audio", lambda f: f == "a.mp4" or f == "gone.mp4")
    al.silent_audio_pass(path, {"a": "a.mp4", "b": "b.mp4", "gone": "gone.mp4"})
    srcs = {s["id"]: s for s in json.loads(path.read_text())["sources"]}
    assert srcs["a"]["silentAudio"] is True
    assert "silentAudio" not in srcs["b"]
    assert set(srcs) == {"a", "b"}


def test_pass_swallows_failures(tmp_path, monkeypatch):
    import lib.audio_level as al
    path = _project(tmp_path, [{"id": "a", "src": "a.mp4"}, {"id": "b", "src": "b.mp4"}])

    def boom(f):
        if f == "a.mp4":
            raise RuntimeError("x")
        return True

    monkeypatch.setattr(al, "is_silent_audio", boom)
    al.silent_audio_pass(path, {"a": "a.mp4", "b": "b.mp4"})
    srcs = {s["id"]: s for s in json.loads(path.read_text())["sources"]}
    assert "silentAudio" not in srcs["a"] and srcs["b"]["silentAudio"] is True
    al.silent_audio_pass(tmp_path / "nope.json", {"a": "a.mp4"})  # missing project: no raise


def test_pass_writes_through_the_project_lock_and_keeps_edits(tmp_path, monkeypatch):
    import lib.audio_level as al
    from tests.test_project_lock import spawn_holder
    path = _project(tmp_path, [{"id": "a", "src": "a.mp4"}])
    monkeypatch.setattr(al, "is_silent_audio", lambda f: True)
    holder = spawn_holder(path, 1.0)
    t0 = time.time()
    try:
        # A user edit lands while the holder has the lock; the pass must wait, then merge.
        al.silent_audio_pass(path, {"a": "a.mp4"})
    finally:
        holder.wait(timeout=10)
    assert time.time() - t0 >= 0.5, "did not wait for the lock"
    assert json.loads(path.read_text())["sources"][0]["silentAudio"] is True


def test_pass_re_reads_under_the_lock_keeping_a_concurrent_edit(tmp_path, monkeypatch):
    import lib.audio_level as al
    path = _project(tmp_path, [{"id": "a", "src": "a.mp4"}])

    def measure(f):
        d = json.loads(path.read_text())  # an edit lands during the (slow) measurement
        d["name"] = "renamed"
        path.write_text(json.dumps(d))
        return True

    monkeypatch.setattr(al, "is_silent_audio", measure)
    al.silent_audio_pass(path, {"a": "a.mp4"})
    d = json.loads(path.read_text())
    assert d["name"] == "renamed" and d["sources"][0]["silentAudio"] is True
