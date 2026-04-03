#!/usr/bin/env python3
"""montaj models — list and download whisper.cpp models."""
import os
import subprocess
import sys
import urllib.request


# name → approximate size in MB
AVAILABLE = {
    "tiny":      39,
    "tiny.en":   39,
    "base":      74,
    "base.en":   74,
    "small":    244,
    "small.en": 244,
    "medium":   769,
    "medium.en":769,
    "large-v1": 1550,
    "large-v2": 1550,
    "large-v3": 1550,
}

HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"


def _resolve_models_dir() -> str:
    """Return the models directory, preferring $WHISPER_DIR, then brew prefix, then ~/.local."""
    if "WHISPER_DIR" in os.environ:
        return os.path.join(os.environ["WHISPER_DIR"], "models")
    # Try brew-installed whisper-cpp
    try:
        prefix = subprocess.check_output(
            ["brew", "--prefix", "whisper-cpp"], stderr=subprocess.DEVNULL, text=True
        ).strip()
        brew_models = os.path.join(prefix, "share", "whisper-cpp", "models")
        if os.path.isdir(brew_models):
            return brew_models
    except Exception:
        pass
    # Fall back to source-build convention
    return os.path.expanduser("~/.local/share/whisper.cpp/models")


def model_path(name: str) -> str:
    return os.path.join(_resolve_models_dir(), f"ggml-{name}.bin")


def is_downloaded(name: str) -> bool:
    return os.path.isfile(model_path(name))


def register(subparsers):
    p = subparsers.add_parser("models", help="List and download whisper.cpp models")
    sub = p.add_subparsers(dest="models_cmd", required=True)

    sub.add_parser("list", help="Show available models and download status")

    dl = sub.add_parser("download", help="Download a whisper model")
    dl.add_argument("model", choices=list(AVAILABLE), help="Model name")

    p.set_defaults(func=handle)


def handle(args):
    if args.models_cmd == "list":
        _list()
    elif args.models_cmd == "download":
        _download(args.model)


def _list():
    print(f"{'MODEL':<12}  {'SIZE':>7}  STATUS")
    print("-" * 32)
    for name, size_mb in AVAILABLE.items():
        status = "downloaded" if is_downloaded(name) else "not downloaded"
        print(f"{name:<12}  {size_mb:>5} MB  {status}")


def _download(name: str):
    dest = model_path(name)
    os.makedirs(_resolve_models_dir(), exist_ok=True)

    if os.path.isfile(dest):
        print(f"Already downloaded: {dest}")
        return

    url = f"{HF_BASE}/ggml-{name}.bin"
    print(f"Downloading {name} (~{AVAILABLE[name]} MB)…")

    def _progress(count, block_size, total_size):
        if total_size <= 0:
            return
        pct = min(count * block_size * 100 // total_size, 100)
        bar = "#" * (pct // 5) + "-" * (20 - pct // 5)
        print(f"\r  [{bar}] {pct}%", end="", flush=True)

    try:
        urllib.request.urlretrieve(url, dest, reporthook=_progress)
    except Exception as e:
        if os.path.exists(dest):
            os.remove(dest)
        print(f"\nerror: download failed — {e}", file=sys.stderr)
        sys.exit(1)

    print(f"\nSaved to {dest}")
