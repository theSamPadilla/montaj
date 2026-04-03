"""Shared fixtures for the Montaj test suite."""
import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REPO_ROOT  = Path(__file__).parent.parent
STEPS_DIR  = REPO_ROOT / "steps"
HAS_FFMPEG = shutil.which("ffmpeg") is not None


# ── helpers ───────────────────────────────────────────────────────────────────

def run_step(script: str, *args) -> subprocess.CompletedProcess:
    """Run a step script as a subprocess and return the completed process."""
    path = STEPS_DIR / script
    return subprocess.run(
        [sys.executable, str(path), *args],
        capture_output=True, text=True,
    )


def assert_file_output(proc: subprocess.CompletedProcess) -> Path:
    """Assert step succeeded and stdout is a path to a non-empty file."""
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    out = Path(proc.stdout.strip())
    assert out.exists(), f"Output file does not exist: {out}"
    assert out.stat().st_size > 0, f"Output file is empty: {out}"
    return out


def assert_json_output(proc: subprocess.CompletedProcess) -> dict:
    """Assert step succeeded and stdout is valid JSON."""
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    return json.loads(proc.stdout)


def assert_error(proc: subprocess.CompletedProcess, code: str | None = None):
    """Assert step failed with a structured JSON error on stderr."""
    assert proc.returncode != 0
    err = json.loads(proc.stderr)
    assert "error" in err
    assert "message" in err
    if code:
        assert err["error"] == code


# ── video fixture ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def test_video(tmp_path_factory) -> Path:
    """3-second 640×480 black video with silent audio. Generated once per session."""
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not available")
    d = tmp_path_factory.mktemp("video")
    out = d / "test.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=640x480:r=30",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
            "-t", "3",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            str(out),
        ],
        check=True, capture_output=True,
    )
    return out


# ── transcript fixture ────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def transcript_json(tmp_path_factory) -> Path:
    """Fake whisper.cpp word-level transcript JSON."""
    d = tmp_path_factory.mktemp("transcript")
    path = d / "words.json"
    data = {
        "transcription": [
            {"text": "Hello",   "offsets": {"from": 0,    "to": 500}},
            {"text": "world",   "offsets": {"from": 600,  "to": 1200}},
            {"text": "this",    "offsets": {"from": 1300, "to": 1600}},
            {"text": "is",      "offsets": {"from": 1700, "to": 1900}},
            {"text": "a",       "offsets": {"from": 2000, "to": 2100}},
            {"text": "test",    "offsets": {"from": 2200, "to": 2800}},
        ]
    }
    path.write_text(json.dumps(data))
    return path


# ── fake whisper environment ──────────────────────────────────────────────────

@pytest.fixture(scope="session")
def fake_whisper_env(tmp_path_factory) -> dict:
    """
    A fake WHISPER_DIR containing:
      - main          (executable that outputs valid whisper JSON)
      - models/ggml-base.en.bin  (empty placeholder)

    Inject via env={"WHISPER_DIR": ...} when calling whisper-dependent steps.
    """
    d = tmp_path_factory.mktemp("whisper")
    models = d / "models"
    models.mkdir()
    (models / "ggml-base.en.bin").touch()
    (models / "ggml-base.bin").touch()

    fake_script = textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys, json

        args = sys.argv[1:]
        out_file = None
        for i, a in enumerate(args):
            if a == "--output-file" and i + 1 < len(args):
                out_file = args[i + 1]

        data = {
            "transcription": [
                {"text": "Hello",   "offsets": {"from": 0,    "to": 500}},
                {"text": "world",   "offsets": {"from": 600,  "to": 1200}},
                {"text": "this",    "offsets": {"from": 1300, "to": 1600}},
                {"text": "is",      "offsets": {"from": 1700, "to": 1900}},
                {"text": "a",       "offsets": {"from": 2000, "to": 2100}},
                {"text": "test",    "offsets": {"from": 2200, "to": 2800}},
            ]
        }
        if out_file:
            with open(out_file + ".json", "w") as f:
                json.dump(data, f)
            with open(out_file + ".srt", "w") as f:
                f.write("1\\n00:00:00,000 --> 00:00:02,800\\nHello world this is a test\\n")
    """)

    # main — used by WHISPER_DIR path
    main = d / "main"
    main.write_text(fake_script)
    main.chmod(0o755)

    # whisper-cpp — shadows any real binary on PATH
    bin_dir = d / "bin"
    bin_dir.mkdir()
    fake_bin = bin_dir / "whisper-cpp"
    fake_bin.write_text(fake_script)
    fake_bin.chmod(0o755)

    original_path = os.environ.get("PATH", "")
    return {
        "WHISPER_DIR": str(d),
        "PATH": f"{bin_dir}:{original_path}",
    }


def run_step_env(script: str, env_extra: dict, *args) -> subprocess.CompletedProcess:
    """Run a step with extra environment variables merged in."""
    env = {**os.environ, **env_extra}
    path = STEPS_DIR / script
    return subprocess.run(
        [sys.executable, str(path), *args],
        capture_output=True, text=True, env=env,
    )
