#!/usr/bin/env python3
"""montaj update — upgrade optional dependencies to latest versions."""
import os, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
import models as _models

from cli.commands.install import (
    WHISPER_VERSION, WHISPER_BINARY_URLS, _install_whisper_binary,
)

_parser = None


def register(subparsers):
    global _parser
    _parser = subparsers.add_parser("update", help="Upgrade optional dependencies (whisper | pip | all)")
    _parser.add_argument(
        "component", nargs="?",
        choices=["whisper", "pip", "all"],
        default="all",
        help="whisper — re-download binary if version changed; pip — upgrade Python packages; all — everything (default)",
    )
    _parser.set_defaults(func=handle)


def handle(args):
    ok = True
    if args.component == "whisper":
        ok &= _update_whisper()
    elif args.component == "pip":
        ok &= _update_pip()
    else:  # all
        ok &= _update_whisper()
        ok &= _update_pip()
    if ok:
        print("\nDone.")
    else:
        sys.exit(1)


def _update_whisper() -> bool:
    import platform
    system  = platform.system()
    machine = platform.machine()
    key = (system, machine)
    if key not in WHISPER_BINARY_URLS:
        print(f"error: no pre-built whisper binary for {system}/{machine}", file=sys.stderr)
        return False

    bin_path     = _models.model_path("whisper", "whisper-cli")
    version_file = bin_path + ".version"

    installed_version = None
    if os.path.isfile(version_file):
        with open(version_file) as f:
            installed_version = f.read().strip()

    if installed_version == WHISPER_VERSION and os.path.isfile(bin_path):
        print(f"✓ whisper-cpp {WHISPER_VERSION} (already current)")
        return True

    if installed_version:
        print(f"→ upgrading whisper-cpp {installed_version} → {WHISPER_VERSION}…")
    else:
        print(f"→ installing whisper-cpp {WHISPER_VERSION}…")

    url, checksum = WHISPER_BINARY_URLS[key]
    try:
        _install_whisper_binary(url, checksum, bin_path)
        print(f"✓ whisper-cpp {WHISPER_VERSION}")
        return True
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return False


def _update_pip() -> bool:
    print("→ upgrading Python packages…")
    r = subprocess.run([
        sys.executable, "-m", "pip", "install", "--upgrade", "-e", ".[test]"
    ])
    if r.returncode != 0:
        print("error: pip upgrade failed", file=sys.stderr)
        return False
    print("✓ Python packages upgraded")
    return True
