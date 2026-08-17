#!/usr/bin/env python3
"""montaj doctor — check system dependencies and report status.

Exit codes:
  0 — all required dependencies OK
  1 — one or more required dependencies missing or misconfigured
"""
import os, re, subprocess, sys, shutil
from cli.main import add_global_flags
from cli.deps import check_ui, whisper_bin_path, whisper_model_path, is_dev_checkout, BUILD_CACHE_DIR
from cli.help import bold, green, red, yellow, cyan, dim
from lib.common import ffmpeg_bin, ffprobe_bin


REQUIRED_FFMPEG_FILTERS = ["zscale", "tonemap", "overlay", "scale", "format", "amix", "adelay", "lut3d"]
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


def _resolve_source(resolved: str, env_var: str) -> str:
    """Human-readable origin of the resolved av binary."""
    if os.environ.get(env_var):
        return f"{env_var} override"
    if os.path.isabs(resolved):
        return f"managed: {resolved}"
    return "system PATH"


def _check_av_binary(name: str, resolved: str):
    """Like _check_binary but honors an absolute resolved path. Returns
    (path, version_first_line) or None."""
    path = resolved if os.path.isabs(resolved) else shutil.which(resolved)
    if not path or not os.access(path, os.X_OK):
        return None
    try:
        r = subprocess.run([path, "-version"], capture_output=True, text=True, timeout=5)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if r.returncode != 0:
        return None
    first_line = (r.stdout or "").splitlines()[0] if r.stdout else name
    return path, first_line


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
    ffmpeg_resolved = ffmpeg_bin()
    check = _check_av_binary("ffmpeg", ffmpeg_resolved)
    if check:
        path, info = check
        source = _resolve_source(ffmpeg_resolved, "MONTAJ_FFMPEG")
        print(f"  {green('✓')} {bold('ffmpeg')}: {dim(info)} {dim('(' + source + ')')}")
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
            print(f"    {yellow('⚠')} zscale requires libzimg. Fix: {cyan('montaj install ffmpeg')}")
            print(f"      {dim('(downloads a pinned static build with zscale into the managed dir)')}")
            print()
    else:
        print(f"  {red('✗')} {bold('ffmpeg')}: not found or not executable")
        print(f"    Fix: {cyan('montaj install ffmpeg')}")
        ok = False

    # ffprobe
    ffprobe_resolved = ffprobe_bin()
    check = _check_av_binary("ffprobe", ffprobe_resolved)
    if check:
        path, info = check
        source = _resolve_source(ffprobe_resolved, "MONTAJ_FFPROBE")
        print(f"  {green('✓')} {bold('ffprobe')}: {dim(info)} {dim('(' + source + ')')}")
    else:
        print(f"  {red('✗')} {bold('ffprobe')}: not found or not executable")
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

    # whisper — single source of truth via cli.deps.whisper_bin_path()
    # Checks PATH (brew, apt, manual installs) then legacy local install paths.
    whisper_path = whisper_bin_path()
    if whisper_path:
        print(f"  {green('✓')} {bold('whisper-cli')}: {dim(whisper_path)}")
        # Model weights. base.en is the English default; the multilingual `base`
        # is what the speech steps auto-upgrade to for non-English audio — without
        # it, the first non-English clip fails. Both are recommendations, not hard
        # requirements (English-only setups don't need `base`), so neither flips `ok`.
        if whisper_model_path("base.en"):
            print(f"    {green('✓')} model: base.en {dim('(English default)')}")
        else:
            print(f"    {yellow('○')} model: base.en {dim('— not downloaded; run')} {cyan('montaj install whisper')}")
        if whisper_model_path("base"):
            print(f"    {green('✓')} model: base {dim('(multilingual)')}")
        else:
            print(f"    {yellow('○')} model: base {dim('(multilingual) — needed for non-English audio; run')} {cyan('montaj models download base')}")
    else:
        print(f"  {yellow('○')} {bold('whisper-cli')}: {dim('not installed (optional — run')} {cyan('montaj install whisper')}{dim(')')}")

    # UI build — required for `montaj serve`
    ui_mode, ui_error = check_ui()
    if ui_error is None:
        label = "ui (dev)" if ui_mode == "dev" else "ui"
        # Prod-only: the cached UI bundle is built once at install time and
        # bakes the package version into __APP_VERSION__. After `brew upgrade`
        # bumps the Python package, the cache is left over from the previous
        # version until `montaj install ui` rewrites it — so the footer shows
        # a stale version. Compare the cache stamp to the installed package
        # version and warn on mismatch. Dev checkouts skip this entirely;
        # they build in-place against source.
        stale_msg = None
        if not is_dev_checkout():
            try:
                from importlib.metadata import version as _pkg_version
                installed = _pkg_version("montaj")
                stamp_path = os.path.join(BUILD_CACHE_DIR, ".version")
                cached = open(stamp_path).read().strip() if os.path.isfile(stamp_path) else None
                if cached and cached != installed:
                    stale_msg = f"cache built for v{cached}, package is v{installed}"
            except Exception:
                pass
        if stale_msg:
            print(f"  {yellow('○')} {bold(label)}: {dim('ready, but ' + stale_msg)}")
            print(f"    Fix: {cyan('montaj install ui')} {dim('(rebuilds cache against installed source)')}")
        else:
            print(f"  {green('✓')} {bold(label)}: {dim('ready')}")
    else:
        print(f"  {red('✗')} {bold('ui')}: {ui_error}")
        print(f"    Fix: {cyan('montaj install ui')}")
        ok = False

    print()
    if ok:
        print(green("All required dependencies OK."))
    else:
        print(red("Some dependencies are missing.") + f" Fix the {red('✗')} items above.")
        sys.exit(1)
