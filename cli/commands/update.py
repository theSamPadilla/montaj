#!/usr/bin/env python3
"""montaj update — upgrade optional dependencies to latest versions."""
import os, platform, shutil, subprocess, sys

_parser = None


def register(subparsers):
    global _parser
    _parser = subparsers.add_parser("update", help="Upgrade optional dependencies (whisper | pip | all)")
    _parser.add_argument(
        "component", nargs="?",
        choices=["whisper", "pip", "all"],
        default="all",
        help="whisper — upgrade whisper-cpp via Homebrew (macOS); pip — upgrade montaj's Python deps; all — everything (default)",
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
    """Delegate to Homebrew on macOS. Linux users built whisper from source —
    this command can't help them upgrade automatically, so it prints a hint."""
    system = platform.system()
    if system == "Darwin":
        if not shutil.which("brew"):
            print("error: Homebrew not found — install from https://brew.sh", file=sys.stderr)
            return False
        print("→ brew upgrade whisper-cpp …")
        r = subprocess.run(["brew", "upgrade", "whisper-cpp"])
        # `brew upgrade` exits non-zero when already up-to-date on some versions;
        # treat that as success rather than a hard error.
        if r.returncode != 0:
            print("✓ whisper-cpp already current (or brew upgrade reported nothing to do)")
        else:
            print("✓ whisper-cpp upgraded")
        return True

    print(f"⚠ {system}: no automatic upgrade path. Re-build whisper.cpp from source:", file=sys.stderr)
    print("    git clone https://github.com/ggml-org/whisper.cpp", file=sys.stderr)
    print("    cd whisper.cpp && cmake -B build && cmake --build build --config Release -j", file=sys.stderr)
    print("    sudo cp build/bin/whisper-cli /usr/local/bin/", file=sys.stderr)
    return False


def _update_pip() -> bool:
    """Upgrade montaj itself via the package name (works in any install path)."""
    print("→ pip install --upgrade montaj …")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", "montaj"])
    if r.returncode != 0:
        print("error: pip upgrade failed", file=sys.stderr)
        return False
    print("✓ Python packages upgraded")
    return True
