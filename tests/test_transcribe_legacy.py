"""transcribe step must find weights in the legacy whisper.cpp dir (like transcribe_words does)."""
import json
import os
import stat

import pytest

from tests.conftest import HAS_FFMPEG, run_step_env

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")

FAKE_WHISPER = """#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
prefix = args[args.index("--output-file") + 1]
with open(prefix + ".json", "w") as f:
    json.dump({"transcription": [
        {"text": "hola", "offsets": {"from": 0, "to": 500}},
    ]}, f)
# The step always passes --output-srt and check_output() rejects zero-byte
# files (lib/common.py:38-40), so the .srt must exist AND be non-empty.
with open(prefix + ".srt", "w") as f:
    f.write("1\\n00:00:00,000 --> 00:00:00,500\\nhola\\n\\n")
"""


def test_transcribe_finds_weight_in_legacy_dir(tmp_path, test_video):
    home = tmp_path / "home"
    legacy = home / ".local" / "share" / "whisper.cpp" / "models"
    legacy.mkdir(parents=True)
    (legacy / "ggml-base.en.bin").write_bytes(b"x")
    # Managed dir (~/.local/share/montaj/models) intentionally absent under fake HOME.

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "whisper-cpp"
    fake.write_text(FAKE_WHISPER)
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)

    env = {"HOME": str(home), "PATH": f"{bin_dir}:{os.environ['PATH']}"}
    proc = run_step_env("speech/transcribe.py", env, "--input", test_video, "--model", "base.en")
    assert proc.returncode == 0, proc.stderr
