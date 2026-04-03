"""Dependency preflight checks shared across CLI commands."""
import shutil
import os

WHISPER_MODELS_DIR = os.path.expanduser("~/.local/share/whisper.cpp/models")
WHISPER_MODEL = "base.en"


def check_deps() -> list[str]:
    """Return a list of missing dependency descriptions. Empty = all good."""
    missing = []

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        missing.append("ffmpeg / ffprobe not found")

    whisper_bin = (
        shutil.which("whisper-cpp")
        or shutil.which("whisper-cli")
        or _local_whisper_bin()
    )
    if not whisper_bin:
        missing.append("whisper.cpp binary not found")

    model_path = os.path.join(WHISPER_MODELS_DIR, f"ggml-{WHISPER_MODEL}.bin")
    if not os.path.isfile(model_path):
        missing.append(f"whisper model '{WHISPER_MODEL}' not downloaded")

    return missing


def _local_whisper_bin() -> str | None:
    candidate = os.path.expanduser("~/.local/bin/whisper-cpp")
    return candidate if os.path.isfile(candidate) else None
