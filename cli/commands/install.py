#!/usr/bin/env python3
"""montaj install — install system dependencies."""
import os, platform, shutil, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
import models as _models

WHISPER_VERSION = "1.7.4"  # update to latest if needed
WHISPER_BINARY_URLS = {
    ("Darwin", "arm64"):  (f"https://github.com/ggerganov/whisper.cpp/releases/download/v{WHISPER_VERSION}/whisper-cpp-{WHISPER_VERSION}-macos-arm64.tar.gz", None),
    ("Darwin", "x86_64"): (f"https://github.com/ggerganov/whisper.cpp/releases/download/v{WHISPER_VERSION}/whisper-cpp-{WHISPER_VERSION}-macos-x86_64.tar.gz", None),
    ("Linux",  "x86_64"): (f"https://github.com/ggerganov/whisper.cpp/releases/download/v{WHISPER_VERSION}/whisper-cpp-{WHISPER_VERSION}-ubuntu-22.04-x86_64.tar.gz", None),
}


_parser = None


def register(subparsers):
    global _parser
    _parser = subparsers.add_parser("install", help="Install dependencies (whisper | rvm | all)")
    _parser.add_argument("component", nargs="?", choices=["whisper", "rvm", "all"],
                         help="whisper — ffmpeg + whisper binary + model weights; rvm — torch/torchvision/av + RVM weights; all — everything")
    _parser.add_argument("--model", default="base.en",
                         help="Whisper model to download (default: base.en)")
    _parser.set_defaults(func=handle)


def handle(args):
    ok = True
    if args.component == "all":
        ok &= _ensure_ffmpeg()
        ok &= _ensure_whisper(args.model)
        ok &= _ensure_rvm()
    elif args.component == "whisper":
        ok &= _ensure_ffmpeg()
        ok &= _ensure_whisper(args.model)
    elif args.component == "rvm":
        ok &= _ensure_rvm()
    else:
        # default: install essentials (ffmpeg + whisper)
        ok &= _ensure_ffmpeg()
        ok &= _ensure_whisper(args.model)
    if ok:
        print("\nDone.")
    else:
        sys.exit(1)


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


def _ensure_whisper(model: str = "base.en") -> bool:
    from cli.commands.models import is_downloaded, _download as _download_model
    system  = platform.system()
    machine = platform.machine()
    key = (system, machine)
    if key not in WHISPER_BINARY_URLS:
        print(f"error: no pre-built whisper binary for {system}/{machine}", file=sys.stderr)
        return False
    url, checksum = WHISPER_BINARY_URLS[key]
    bin_path = _models.model_path("whisper", "whisper-cli")
    if not os.path.isfile(bin_path):
        print(f"→ downloading whisper-cpp binary ({system}/{machine})…")
        try:
            _install_whisper_binary(url, checksum, bin_path)
            print("✓ whisper-cpp binary installed")
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return False
    else:
        print("✓ whisper-cpp binary")
    if not is_downloaded(model):
        print(f"→ downloading whisper model {model}…")
        try:
            _download_model(model)
            print(f"✓ whisper model {model}")
        except (Exception, SystemExit):
            return False
    else:
        print(f"✓ whisper model {model}")
    return True


def _install_whisper_binary(url: str, checksum, bin_path: str):
    import hashlib, shutil, tarfile, tempfile, urllib.request
    tmp_dir = tempfile.mkdtemp(prefix="montaj_whisper_")
    archive_path = os.path.join(tmp_dir, "whisper.tar.gz")
    try:
        urllib.request.urlretrieve(url, archive_path)
        os.makedirs(os.path.dirname(bin_path), exist_ok=True)
        with tarfile.open(archive_path, "r:gz") as tar:
            target_member = None
            for member in tar.getmembers():
                name = member.name
                if name.endswith("whisper-cli") or name.endswith("/main") or name == "main":
                    target_member = member
                    break
            if target_member is None:
                import json as _json
                raise RuntimeError(_json.dumps({
                    "error": "whisper_binary_not_found",
                    "message": f"whisper-cli not found in archive: {url}",
                }))
            # Extract via file-like object — no path traversal risk
            part_path = bin_path + ".part"
            f = tar.extractfile(target_member)
            if f is None:
                raise RuntimeError("Could not open whisper-cli member from archive")
            try:
                with open(part_path, "wb") as out_f:
                    shutil.copyfileobj(f, out_f)
            finally:
                f.close()
        # Verify checksum if provided
        if checksum:
            h = hashlib.sha256()
            with open(part_path, "rb") as fh:
                for chunk in iter(lambda: fh.read(65536), b""):
                    h.update(chunk)
            if h.hexdigest() != checksum:
                os.remove(part_path)
                raise RuntimeError(
                    f"SHA-256 mismatch for whisper-cli binary. Expected {checksum}. "
                    f"The download may be corrupt or the URL has changed. URL: {url}"
                )
        os.rename(part_path, bin_path)
        os.chmod(bin_path, 0o755)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _ensure_rvm() -> bool:
    print("→ installing rvm deps (torch, torchvision, av)…")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-e", ".[rvm]"])
    if r.returncode != 0:
        print("error: pip install .[rvm] failed", file=sys.stderr)
        return False
    print("✓ rvm deps installed")
    # Pre-fetch all model weights so there are no lazy downloads at runtime
    RVM_WEIGHTS = {
        "rvm_mobilenetv3.pth": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3.pth",
        "rvm_resnet50.pth":    "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50.pth",
    }
    for filename, url in RVM_WEIGHTS.items():
        try:
            _models.ensure_model("rvm", filename, url, None)
            print(f"✓ {filename}")
        except Exception as e:
            print(f"warning: could not pre-fetch {filename}: {e}", file=sys.stderr)
    return True
