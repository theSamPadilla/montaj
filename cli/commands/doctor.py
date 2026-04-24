#!/usr/bin/env python3
"""montaj doctor — check system dependencies and report status.

Exit codes:
  0 — all required dependencies OK
  1 — one or more required dependencies missing or misconfigured
"""
import os, re, subprocess, sys, shutil
from cli.main import add_global_flags
from cli.help import bold, green, red, yellow, cyan, dim


REQUIRED_FFMPEG_FILTERS = ["zscale", "tonemap", "overlay", "scale", "format", "amix", "adelay"]
RECOMMENDED_FFMPEG_FILTERS = ["sidechaincompress"]  # for audio ducking


def register(subparsers):
    p = subparsers.add_parser("doctor", help="Check system dependencies (exit 0 = OK, exit 1 = issues)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def _check_binary(name):
    """Return (path, version_str) or (None, error_msg)."""
    path = shutil.which(name)
    if not path:
        return None, f"{name} not found on PATH"
    try:
        r = subprocess.run([path, "-version"], capture_output=True, text=True, timeout=5)
        version_line = r.stdout.split("\n")[0] if r.stdout else "unknown"
        return path, version_line
    except Exception as e:
        return path, f"found but version check failed: {e}"


def _check_ffmpeg_filters(ffmpeg_path):
    """Return (available, missing, recommended_missing) lists of filter names.
    Uses word-boundary matching to avoid false positives (e.g. 'format' matching 'information')."""
    try:
        r = subprocess.run([ffmpeg_path, "-filters"], capture_output=True, text=True, timeout=5)
        filter_text = r.stdout
    except Exception:
        return [], REQUIRED_FFMPEG_FILTERS, RECOMMENDED_FFMPEG_FILTERS

    available = []
    missing = []
    for f in REQUIRED_FFMPEG_FILTERS:
        if re.search(rf'\b{f}\b', filter_text):
            available.append(f)
        else:
            missing.append(f)

    recommended_missing = []
    for f in RECOMMENDED_FFMPEG_FILTERS:
        if not re.search(rf'\b{f}\b', filter_text):
            recommended_missing.append(f)

    return available, missing, recommended_missing


def handle(args):
    ok = True
    print(bold("montaj doctor") + "\n")

    # ffmpeg
    path, info = _check_binary("ffmpeg")
    if path:
        print(f"  {green('✓')} {bold('ffmpeg')}: {dim(info)}")
        avail, missing, rec_missing = _check_ffmpeg_filters(path)
        for f in avail:
            print(f"    {green('✓')} filter: {f}")
        for f in missing:
            print(f"    {red('✗')} filter: {f} — {red('MISSING')}")
            ok = False
        for f in rec_missing:
            print(f"    {yellow('○')} filter: {f} — {dim('recommended (audio ducking)')}")
        if "zscale" in missing:
            print()
            print(f"    {yellow('⚠')} zscale requires libzimg (the z.lib image processing library).")
            print(f"    Without it, HDR video normalization uses a fallback with degraded colors.")
            print()
            print(f"    {bold('Easiest fix:')}")
            print(f"      {cyan('montaj install ffmpeg')}")
            print(f"    {dim('This installs zimg, patches the Homebrew formula, and rebuilds ffmpeg.')}")
            print()
            print(f"    {bold('Manual alternatives:')}")
            print()
            print(f"    {bold('Option A')} — Edit your local Homebrew formula:")
            print(f"      1. {cyan('brew install zimg')}")
            print(f"      2. {cyan('brew edit ffmpeg')}")
            print(f"         → Find the configure args block (look for '--enable-libx264' etc.)")
            print(f"         → Add: {green('--enable-libzimg')}")
            print(f"         → Add to the dependencies: {green('depends_on \"zimg\"')}")
            print(f"         → Save and close")
            print(f"      3. {cyan('rm ~/Library/Caches/Homebrew/api/formula.jws.json')}")
            print(f"      4. {cyan('HOMEBREW_NO_INSTALL_FROM_API=1 brew reinstall ffmpeg --build-from-source')}")
            print()
            print(f"    {bold('Option B')} — Use the homebrew-ffmpeg third-party tap:")
            print(f"      1. {cyan('brew uninstall ffmpeg')}")
            print(f"      2. {cyan('brew tap homebrew-ffmpeg/ffmpeg')}")
            print(f"      3. {cyan('brew install homebrew-ffmpeg/ffmpeg/ffmpeg --with-zimg')}")
            print(f"      {dim('This tap restores --with-* options removed from core Homebrew.')}")
            print()
            print(f"    {bold('Option C')} — Build ffmpeg from source (full control):")
            print(f"      1. {cyan('brew install zimg')}")
            print(f"      2. {cyan('git clone https://git.ffmpeg.org/ffmpeg.git && cd ffmpeg')}")
            print(f"      3. {cyan('./configure --enable-libzimg --enable-libx264 --enable-gpl ...')}")
            print(f"      4. {cyan('make -j$(nproc) && make install')}")
            print()
            print(f"    After fixing, verify: {cyan('ffmpeg -filters 2>/dev/null | grep zscale')}")
            print()
    else:
        print(f"  {red('✗')} {bold('ffmpeg')}: {info}")
        print(f"    Fix: {cyan('brew install ffmpeg')}")
        ok = False

    # ffprobe
    path, info = _check_binary("ffprobe")
    if path:
        print(f"  {green('✓')} {bold('ffprobe')}: {dim(info)}")
    else:
        print(f"  {red('✗')} {bold('ffprobe')}: {info}")
        ok = False

    # node
    path, info = _check_binary("node")
    if path:
        print(f"  {green('✓')} {bold('node')}: {dim(info)}")
    else:
        print(f"  {red('✗')} {bold('node')}: {info}")
        print(f"    Fix: {cyan('brew install node')}")
        ok = False

    # python
    path, info = _check_binary("python3")
    if path:
        print(f"  {green('✓')} {bold('python3')}: {dim(info)}")
    else:
        print(f"  {red('✗')} {bold('python3')}: {info}")
        ok = False

    # whisper — check the standard user-level model path
    # (lib/models.py stores at ~/.local/share/montaj/models/)
    whisper_path = os.path.expanduser("~/.local/share/montaj/models/whisper/whisper-cli")
    if os.path.isfile(whisper_path):
        print(f"  {green('✓')} {bold('whisper-cli')}: {dim(whisper_path)}")
    else:
        print(f"  {yellow('○')} {bold('whisper-cli')}: {dim('not installed (optional — run')} {cyan('montaj install whisper')}{dim(')')}")

    print()
    if ok:
        print(green("All required dependencies OK."))
    else:
        print(red("Some dependencies are missing.") + f" Fix the {red('✗')} items above.")
        sys.exit(1)
