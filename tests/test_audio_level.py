"""silentAudio flag: lib/audio_level.py plus its ingest and init callers (data only)."""
import json
import subprocess
import sys
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


@pytest.mark.parametrize("mode", [[], ["--normalize", "lazy"]])
def test_init_flags_only_silent(tmp_path, mode):
    silent = _mp4(tmp_path / "s.mp4", "silent")
    tone = _mp4(tmp_path / "t.mp4", "tone")
    result = run_init("--prompt", "p", "--workflow", "overlays",
                      "--clips", str(silent), str(tone), *mode,
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    data = json.loads(_project_path_from_stdout(result.stdout).read_text())
    by_name = {Path(s["src"]).name.split("_normalized_")[0]: s for s in data["sources"]}
    flagged = {n for n, s in by_name.items() if s.get("silentAudio") is True}
    assert flagged == {n for n in by_name if n.startswith("s")}
