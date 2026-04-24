#!/usr/bin/env python3
"""montaj models — list and download whisper.cpp models."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
import models as _models

from cli.help import bold, green, yellow, cyan, dim

AVAILABLE = {
    "tiny": 39, "tiny.en": 39,
    "base": 74, "base.en": 74,
    "small": 244, "small.en": 244,
    "medium": 769, "medium.en": 769,
    "large-v1": 1550, "large-v2": 1550, "large-v3": 1550,
}

HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# TODO: populate with real SHA-256 checksums per model
CHECKSUMS: dict = {name: None for name in AVAILABLE}


def model_path(name: str) -> str:
    return _models.model_path("whisper", f"ggml-{name}.bin")


def is_downloaded(name: str) -> bool:
    return _models.is_downloaded("whisper", f"ggml-{name}.bin")


def register(subparsers):
    p = subparsers.add_parser("models", help="List and download whisper.cpp models")
    sub = p.add_subparsers(dest="models_cmd", required=True)
    sub.add_parser("list", help="Show available models and download status")
    dl = sub.add_parser("download", help="Download a whisper model")
    dl.add_argument("model", choices=list(AVAILABLE))
    p.set_defaults(func=handle)


def handle(args):
    if args.models_cmd == "list":
        _list()
    elif args.models_cmd == "download":
        _download(args.model)


def _list():
    print(bold(f"{'MODEL':<12}  {'SIZE':>7}  STATUS"))
    print(dim("-" * 32))
    for name, size_mb in AVAILABLE.items():
        status = green("downloaded") if is_downloaded(name) else yellow("not downloaded")
        print(f"{bold(f'{name:<12}')}  {size_mb:>5} MB  {status}")


def _download(name: str):
    url = f"{HF_BASE}/ggml-{name}.bin"
    checksum = CHECKSUMS.get(name)
    print(f"Downloading whisper model {bold(name)} (~{AVAILABLE[name]} MB)…")
    dest = _models.ensure_model("whisper", f"ggml-{name}.bin", url, checksum)
    print(f"Saved to {dim(dest)}")
