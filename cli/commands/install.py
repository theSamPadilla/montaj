#!/usr/bin/env python3
"""montaj install — install system dependencies (ffmpeg, whisper.cpp, base model)."""
import shutil
import subprocess
import sys


def register(subparsers):
    p = subparsers.add_parser("install", help="Install system dependencies (ffmpeg, whisper.cpp, model)")
    p.set_defaults(func=handle)


def handle(args):
    ok = True
    ok &= _ensure_ffmpeg()
    ok &= _ensure_whisper()
    ok &= _ensure_model()
    if ok:
        print("\nAll dependencies installed. Run: montaj serve")
    else:
        sys.exit(1)


# ---------------------------------------------------------------------------
# Individual installers
# ---------------------------------------------------------------------------

def _ensure_ffmpeg() -> bool:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        print("✓ ffmpeg")
        return True
    print("→ installing ffmpeg…")
    r = subprocess.run(["brew", "install", "ffmpeg"])
    if r.returncode != 0:
        print("error: brew install ffmpeg failed", file=sys.stderr)
        return False
    print("✓ ffmpeg installed")
    return True


def _ensure_whisper() -> bool:
    if shutil.which("whisper-cpp") or shutil.which("whisper-cli"):
        print("✓ whisper-cpp")
        return True
    print("→ installing whisper-cpp…")
    r = subprocess.run(["brew", "install", "whisper-cpp"])
    if r.returncode != 0:
        print("error: brew install whisper-cpp failed", file=sys.stderr)
        return False
    print("✓ whisper-cpp installed")
    return True


def _ensure_model() -> bool:
    from cli.commands.models import is_downloaded, _download
    model = "base.en"
    if is_downloaded(model):
        print(f"✓ whisper model {model}")
        return True
    print(f"→ downloading whisper model {model}…")
    try:
        _download(model)
        print(f"✓ whisper model {model} downloaded")
        return True
    except SystemExit:
        return False
