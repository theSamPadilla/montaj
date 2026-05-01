#!/usr/bin/env python3
"""montaj install — install optional dependencies (whisper binary + weights, rvm)."""
import os, platform, shutil, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
import models as _models
from cli.main import MONTAJ_ROOT
from cli.deps import whisper_bin_path
from cli.help import bold, green, red, yellow, cyan, dim


_parser = None


def register(subparsers):
    global _parser
    from cli.help import ColorHelpFormatter
    _parser = subparsers.add_parser("install", help="Install optional dependencies",
                                    formatter_class=lambda prog: ColorHelpFormatter(prog, max_help_position=40))
    sub = _parser.add_subparsers(dest="component", metavar="<component>")

    whisper_p = sub.add_parser("whisper", help="whisper-cpp binary + model weights")
    whisper_p.add_argument("--model", default="base.en",
                           help="Whisper model to download (default: base.en)")

    sub.add_parser("rvm",    help="torch/torchvision/av + RVM weights")
    sub.add_parser("demucs", help="Demucs stem separation + htdemucs model weights")
    sub.add_parser("connectors", help="pyjwt + requests + google-genai for external API steps")
    sub.add_parser("ui",     help="npm deps + UI build")
    sub.add_parser("ffmpeg", help="Install/upgrade ffmpeg with zscale (libzimg) for HDR video support")
    sub.add_parser("all",    help="Everything above (except ffmpeg — run separately)")

    _parser.set_defaults(func=handle)


def handle(args):
    if not args.component:
        _parser.print_help()
        return
    ok = True
    if args.component == "all":
        ok &= _ensure_whisper("base.en")
        ok &= _ensure_rvm()
        ok &= _ensure_demucs()
        ok &= _ensure_connectors()
        ok &= _ensure_ui()
    elif args.component == "whisper":
        ok &= _ensure_whisper(getattr(args, "model", "base.en"))
    elif args.component == "rvm":
        ok &= _ensure_rvm()
    elif args.component == "demucs":
        ok &= _ensure_demucs()
    elif args.component == "connectors":
        ok &= _ensure_connectors()
    elif args.component == "ui":
        ok &= _ensure_ui()
    elif args.component == "ffmpeg":
        ok = _ensure_ffmpeg_zscale()
    if ok:
        print(f"\n{green('Done.')}")
    else:
        sys.exit(1)


def _ensure_whisper(model: str = "base.en") -> bool:
    """Install the whisper-cli binary (via Homebrew on macOS) and download model weights.

    Note: ggerganov/whisper.cpp moved to ggml-org/whisper.cpp and stopped
    publishing pre-built macOS/Linux tarballs. We delegate the binary install
    to Homebrew on macOS (`brew install whisper-cpp` — bottled, fast) and
    instruct the user to build from source on Linux. Model weights are
    downloaded from HuggingFace in either case (independent of the binary
    upstream)."""
    from cli.commands.models import is_downloaded, _download as _download_model

    if not _ensure_whisper_binary():
        return False

    if not is_downloaded(model):
        print(f"{cyan('→')} downloading whisper model {bold(model)}\u2026")
        try:
            _download_model(model)
            print(f"{green('✓')} whisper model {bold(model)}")
        except (Exception, SystemExit):
            return False
    else:
        print(f"{green('✓')} whisper model {bold(model)}")
    return True


def _ensure_whisper_binary() -> bool:
    """Resolve the whisper-cli binary: brew on macOS, source build instructions on Linux."""
    existing = whisper_bin_path()
    if existing:
        print(f"{green('✓')} whisper-cli already available {dim(f'({existing})')}")
        return True

    system = platform.system()
    if system == "Darwin":
        if not shutil.which("brew"):
            print(f"{red('error:')} Homebrew not found. Install from {cyan('https://brew.sh')} and retry.", file=sys.stderr)
            return False
        print(f"{cyan('→')} installing {bold('whisper-cpp')} via Homebrew \u2026")
        r = subprocess.run(["brew", "install", "whisper-cpp"])
        if r.returncode != 0:
            print(f"{red('error:')} {dim('brew install whisper-cpp')} failed — see output above", file=sys.stderr)
            return False
        print(f"{green('✓')} whisper-cpp installed via Homebrew")
        return True

    # Linux (and anything else): no reliable pre-built binary upstream. Tell the user.
    print(f"{yellow('⚠')} pre-built whisper-cpp binaries are no longer published for {system}.", file=sys.stderr)
    print(f"  Build from source:", file=sys.stderr)
    print(f"    {cyan('git clone https://github.com/ggml-org/whisper.cpp')}", file=sys.stderr)
    print(f"    {cyan('cd whisper.cpp && cmake -B build && cmake --build build --config Release -j')}", file=sys.stderr)
    print(f"    {cyan('sudo cp build/bin/whisper-cli /usr/local/bin/')}", file=sys.stderr)
    print(f"  Then re-run: {cyan('montaj install whisper')}", file=sys.stderr)
    return False



def _ensure_demucs() -> bool:
    print(f"{cyan('→')} installing {bold('demucs')} deps\u2026")
    # Resolve extras via the installed package metadata, not via `-e .`, so this
    # works whether MONTAJ_ROOT is a working tree or site-packages (no pyproject).
    r = subprocess.run([sys.executable, "-m", "pip", "install", "montaj[demucs]"])
    if r.returncode != 0:
        print(f"{red('error:')} {dim('pip install montaj[demucs]')} failed", file=sys.stderr)
        return False
    print(f"{green('✓')} demucs deps installed")
    # Pre-warm: downloads htdemucs model weights on first use
    print(f"{cyan('→')} downloading {bold('htdemucs')} model weights\u2026")
    try:
        from demucs.pretrained import get_model
        get_model("htdemucs")
        print(f"{green('✓')} htdemucs model ready")
    except Exception as e:
        print(f"{yellow('warning:')} could not pre-warm demucs model: {e}", file=sys.stderr)
    return True


def _ensure_rvm() -> bool:
    print(f"{cyan('→')} installing {bold('rvm')} deps {dim('(torch, torchvision, av)')}\u2026")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "montaj[rvm]"])
    if r.returncode != 0:
        print(f"{red('error:')} {dim('pip install montaj[rvm]')} failed", file=sys.stderr)
        return False
    print(f"{green('✓')} rvm deps installed")
    # Pre-fetch all model weights so there are no lazy downloads at runtime
    RVM_WEIGHTS = {
        "rvm_mobilenetv3.pth": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3.pth",
        "rvm_resnet50.pth":    "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50.pth",
    }
    for filename, url in RVM_WEIGHTS.items():
        try:
            _models.ensure_model("rvm", filename, url, None)
            print(f"{green('✓')} {dim(filename)}")
        except Exception as e:
            print(f"{yellow('warning:')} could not pre-fetch {dim(filename)}: {e}", file=sys.stderr)
    return True


def _ensure_connectors() -> bool:
    print(f"{cyan('→')} installing {bold('connector')} deps {dim('(pyjwt, requests, google-genai, openai)')}\u2026")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "montaj[connectors]"])
    if r.returncode != 0:
        print(f"{red('error:')} {dim('pip install montaj[connectors]')} failed", file=sys.stderr)
        return False
    print(f"{green('✓')} connector deps installed")
    return True



def _cache_is_stale(cache_root: str, current_version: str) -> bool:
    """True if the cache stamp is missing or doesn't match the installed version."""
    stamp_path = os.path.join(cache_root, ".version")
    if not os.path.isfile(stamp_path):
        return True
    with open(stamp_path) as f:
        return f.read().strip() != current_version


def _write_stamp(cache_root: str, current_version: str) -> None:
    """Stamp the cache with the installed package version. Called only after
    every build step succeeds — partial installs leave the stamp absent so the
    next run starts from scratch."""
    with open(os.path.join(cache_root, ".version"), "w") as f:
        f.write(current_version)


def _ensure_ui() -> bool:
    import shutil
    from importlib.metadata import version as _pkg_version
    from cli.deps import is_dev_checkout, BUILD_CACHE_DIR
    if not shutil.which("npm"):
        print(f"{red('error:')} npm not found \u2014 install Node.js >=18 first: {cyan('https://nodejs.org')}", file=sys.stderr)
        return False

    # Three Node.js bundles ship with montaj: the render engine, the Vite UI,
    # and the MCP server. All three need `npm install`; only the UI needs build.
    bundles = [("render engine", "render"), ("UI", "ui"), ("MCP server", "mcp")]
    src_root = os.path.join(MONTAJ_ROOT, "montaj_assets")

    if is_dev_checkout():
        # Dev: build in place so Vite HMR works against source.
        targets = [(name, os.path.join(src_root, sub)) for name, sub in bundles]
        current = None
    else:
        # Prod: copy source → cache, build in cache. Site-packages stays immutable.
        # `shutil.copytree(..., dirs_exist_ok=True)` overwrites changed files but
        # never removes deleted ones — version-stamp the cache and clear it on
        # mismatch so post-upgrade the cache mirrors the new source tree exactly.
        current = _pkg_version("montaj")
        if _cache_is_stale(BUILD_CACHE_DIR, current):
            shutil.rmtree(BUILD_CACHE_DIR, ignore_errors=True)
        os.makedirs(BUILD_CACHE_DIR, exist_ok=True)

        ignore = shutil.ignore_patterns("node_modules", "__pycache__", "*.pyc")
        # Bundles + the shared schemas/ dir (loaded by render/color-space.js
        # via ../schemas/color_space.json — must be copied alongside).
        for sub in [s for _, s in bundles] + ["schemas"]:
            shutil.copytree(
                os.path.join(src_root, sub),
                os.path.join(BUILD_CACHE_DIR, sub),
                dirs_exist_ok=True,
                ignore=ignore,
            )
        targets = [(name, os.path.join(BUILD_CACHE_DIR, sub)) for name, sub in bundles]

    for name, path in targets:
        print(f"{cyan('→')} npm install ({bold(name)})\u2026")
        r = subprocess.run(["npm", "install", "--prefix", path])
        if r.returncode != 0:
            print(f"{red('error:')} npm install failed for {dim(path)}", file=sys.stderr)
            return False
        print(f"{green('✓')} {name} deps installed")

    # UI build (only target needing `npm run build`)
    ui_target = next(p for n, p in targets if n == "UI")
    print(f"{cyan('→')} npm run build ({bold('UI')})\u2026")
    r = subprocess.run(["npm", "run", "build", "--prefix", ui_target])
    if r.returncode != 0:
        print(f"{red('error:')} npm run build failed for {dim(ui_target)}", file=sys.stderr)
        return False
    print(f"{green('✓')} UI built")

    # Stamp the cache only after every step succeeded — partial installs leave
    # the stamp absent so the next run starts from scratch.
    if not is_dev_checkout():
        _write_stamp(BUILD_CACHE_DIR, current)
    return True


def _ensure_ffmpeg_zscale() -> bool:
    """Ensure ffmpeg is installed with zscale (libzimg) support.

    Steps:
    0. If ffmpeg is not installed at all, install it via Homebrew
    1. Install zimg via Homebrew
    2. Locate the Homebrew ffmpeg formula file
    3. Patch it to add --enable-libzimg and depends_on "zimg" if not present
    4. Clear Homebrew API cache (prevents brew from ignoring local edits)
    5. Rebuild ffmpeg from source
    6. Verify zscale is available
    """
    import shutil, re, platform
    # Note: os, subprocess already imported at module level in install.py.

    if platform.system() != "Darwin":
        print(f"{yellow('⚠')} montaj install ffmpeg currently supports macOS (Homebrew) only.")
        print(f"  On Linux, install ffmpeg with {bold('libzimg')} from your package manager or build from source.")
        return False

    if not shutil.which("brew"):
        print(f"{red('✗')} Homebrew not found. Install from {cyan('https://brew.sh')}")
        return False

    # 0. If ffmpeg is not installed, install it first
    if not shutil.which("ffmpeg"):
        print(f"{cyan('→')} ffmpeg not found — installing via Homebrew...")
        r = subprocess.run(["brew", "install", "ffmpeg"])
        if r.returncode != 0:
            print(f"{red('✗')} {dim('brew install ffmpeg')} failed")
            return False
        print(f"{green('✓')} ffmpeg installed")

    # Check if zscale already works
    r = subprocess.run(["ffmpeg", "-filters"], capture_output=True, text=True, timeout=5)
    if r.returncode == 0 and re.search(r'\bzscale\b', r.stdout or ""):
        print(f"{green('✓')} ffmpeg already has zscale \u2014 nothing to do")
        return True

    # 1. Install zimg
    print(f"{cyan('→')} installing {bold('zimg')}...")
    r = subprocess.run(["brew", "install", "zimg"])
    if r.returncode != 0:
        print(f"{red('✗')} {dim('brew install zimg')} failed")
        return False
    print(f"{green('✓')} zimg installed")

    # 2. Find the ffmpeg formula file
    # Homebrew 4.x uses the API by default and may not have homebrew-core tapped locally.
    # Tap it first to ensure the formula file exists on disk.
    r = subprocess.run(["brew", "--prefix"], capture_output=True, text=True)
    brew_prefix = r.stdout.strip()
    formula_path = os.path.join(brew_prefix, "Library", "Taps", "homebrew",
                                "homebrew-core", "Formula", "f", "ffmpeg.rb")
    if not os.path.isfile(formula_path):
        # Homebrew 4.x silently skips `brew tap homebrew/core` unless
        # HOMEBREW_NO_INSTALL_FROM_API=1 is set — without it, brew prefers the
        # API and never clones the tap, leaving the formula file absent.
        print(f"{cyan('→')} tapping {bold('homebrew/core')} {dim('(needed for formula editing — clones ~1GB, may take several minutes)')}...")
        tap_env = os.environ.copy()
        tap_env["HOMEBREW_NO_INSTALL_FROM_API"] = "1"
        r = subprocess.run(["brew", "tap", "homebrew/core"], env=tap_env)
        if r.returncode != 0:
            print(f"{red('✗')} {dim('brew tap homebrew/core')} failed", file=sys.stderr)
            return False
    if not os.path.isfile(formula_path):
        print(f"{red('✗')} ffmpeg formula not found at {dim(formula_path)}")
        print(f"  Try: {dim('HOMEBREW_NO_INSTALL_FROM_API=1 brew tap homebrew/core')}")
        return False

    # 3. Patch the formula
    print(f"{cyan('→')} patching {dim(formula_path)}...")
    with open(formula_path) as f:
        content = f.read()
    patched = False

    if '--enable-libzimg' not in content:
        # Add --enable-libzimg after --enable-libx264 (or any existing --enable- line)
        content = re.sub(
            r'(--enable-libx264)',
            r'\1\n      --enable-libzimg',
            content, count=1
        )
        patched = True

    if 'depends_on "zimg"' not in content:
        # Add depends_on "zimg" after depends_on "x264"
        content = re.sub(
            r'(depends_on "x264")',
            r'\1\n  depends_on "zimg"',
            content, count=1
        )
        patched = True

    if patched:
        with open(formula_path, "w") as f:
            f.write(content)
        print(f"{green('✓')} formula patched")
    else:
        print(f"{green('✓')} formula already has libzimg")

    # 4. Clear API cache
    cache_file = os.path.expanduser("~/Library/Caches/Homebrew/api/formula.jws.json")
    if os.path.isfile(cache_file):
        os.remove(cache_file)
        print(f"{green('✓')} cleared Homebrew API cache")

    # 5. Rebuild ffmpeg from source
    print(f"{cyan('→')} rebuilding {bold('ffmpeg')} from source {dim('(this takes 1-3 minutes)')}...")
    env = os.environ.copy()
    env["HOMEBREW_NO_INSTALL_FROM_API"] = "1"
    env["HOMEBREW_NO_AUTO_UPDATE"] = "1"
    r = subprocess.run(
        ["brew", "reinstall", "--formula", formula_path, "--build-from-source"],
        env=env
    )
    if r.returncode != 0:
        print(f"{red('✗')} ffmpeg rebuild failed")
        return False

    # 6. Verify
    r = subprocess.run(["ffmpeg", "-filters"], capture_output=True, text=True, timeout=5)
    if r.returncode == 0 and re.search(r'\bzscale\b', r.stdout or ""):
        print(f"{green('✓')} ffmpeg rebuilt with zscale support")
        return True
    else:
        print(f"{red('✗')} ffmpeg rebuilt but zscale still not found \u2014 check build output above")
        return False
