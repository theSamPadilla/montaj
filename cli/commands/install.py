#!/usr/bin/env python3
"""montaj install — install optional dependencies (whisper binary + weights, rvm)."""
import os, platform, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
import models as _models
from cli.help import bold, green, red, yellow, cyan, dim

WHISPER_VERSION = "1.7.4"  # update to latest if needed
WHISPER_BINARY_URLS = {
    ("Darwin", "arm64"):  (f"https://github.com/ggerganov/whisper.cpp/releases/download/v{WHISPER_VERSION}/whisper-cpp-{WHISPER_VERSION}-macos-arm64.tar.gz", None),
    ("Darwin", "x86_64"): (f"https://github.com/ggerganov/whisper.cpp/releases/download/v{WHISPER_VERSION}/whisper-cpp-{WHISPER_VERSION}-macos-x86_64.tar.gz", None),
    ("Linux",  "x86_64"): (f"https://github.com/ggerganov/whisper.cpp/releases/download/v{WHISPER_VERSION}/whisper-cpp-{WHISPER_VERSION}-ubuntu-22.04-x86_64.tar.gz", None),
}


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
    from cli.commands.models import is_downloaded, _download as _download_model
    system  = platform.system()
    machine = platform.machine()
    key = (system, machine)
    if key not in WHISPER_BINARY_URLS:
        print(f"{red('error:')} no pre-built whisper binary for {dim(f'{system}/{machine}')}", file=sys.stderr)
        return False
    url, checksum = WHISPER_BINARY_URLS[key]
    bin_path = _models.model_path("whisper", "whisper-cli")
    version_file = bin_path + ".version"
    installed_version = None
    if os.path.isfile(version_file):
        with open(version_file) as f:
            installed_version = f.read().strip()
    needs_install = not os.path.isfile(bin_path)
    needs_upgrade = installed_version and installed_version != WHISPER_VERSION
    if needs_install or needs_upgrade:
        if needs_upgrade:
            print(f"{cyan('→')} upgrading {bold('whisper-cpp')} {installed_version} → {WHISPER_VERSION} {dim(f'({system}/{machine})')}\u2026")
        else:
            print(f"{cyan('→')} downloading {bold('whisper-cpp')} binary {dim(f'({system}/{machine})')}\u2026")
        try:
            _install_whisper_binary(url, checksum, bin_path)
            print(f"{green('✓')} whisper-cpp binary installed")
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return False
    else:
        print(f"{green('✓')} whisper-cpp {WHISPER_VERSION}")
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
        # Write version marker so `montaj update` can detect stale installs
        with open(bin_path + ".version", "w") as vf:
            vf.write(WHISPER_VERSION)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)



def _ensure_demucs() -> bool:
    print(f"{cyan('→')} installing {bold('demucs')} deps\u2026")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-e", ".[demucs]"])
    if r.returncode != 0:
        print(f"{red('error:')} {dim('pip install .[demucs]')} failed", file=sys.stderr)
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
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-e", ".[rvm]"])
    if r.returncode != 0:
        print(f"{red('error:')} {dim('pip install .[rvm]')} failed", file=sys.stderr)
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
    from cli.main import MONTAJ_ROOT
    print(f"{cyan('→')} installing {bold('connector')} deps {dim('(pyjwt, requests, google-genai, openai)')}\u2026")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-e", ".[connectors]"],
                       cwd=MONTAJ_ROOT)
    if r.returncode != 0:
        print(f"{red('error:')} {dim('pip install .[connectors]')} failed", file=sys.stderr)
        return False
    print(f"{green('✓')} connector deps installed")
    return True



def _ensure_ui() -> bool:
    import shutil
    if not shutil.which("npm"):
        print(f"{red('error:')} npm not found \u2014 install Node.js >=18 first: {cyan('https://nodejs.org')}", file=sys.stderr)
        return False
    root = os.path.join(os.path.dirname(__file__), "..", "..")
    for name, directory in [("render engine", "render"), ("UI", "ui")]:
        path = os.path.normpath(os.path.join(root, directory))
        print(f"{cyan('→')} npm install ({bold(name)})\u2026")
        r = subprocess.run(["npm", "install", "--prefix", path])
        if r.returncode != 0:
            print(f"{red('error:')} npm install failed for {dim(directory + '/')}", file=sys.stderr)
            return False
        print(f"{green('✓')} {name} deps installed")
    ui_path = os.path.normpath(os.path.join(root, "ui"))
    print(f"{cyan('→')} npm run build ({bold('UI')})\u2026")
    r = subprocess.run(["npm", "run", "build", "--prefix", ui_path])
    if r.returncode != 0:
        print(f"{red('error:')} npm run build failed for {dim('ui/')}", file=sys.stderr)
        return False
    print(f"{green('✓')} UI built")
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
        print(f"{cyan('→')} tapping {bold('homebrew/core')} (needed for formula editing)...")
        subprocess.run(["brew", "tap", "homebrew/core"], capture_output=True)
    if not os.path.isfile(formula_path):
        print(f"{red('✗')} ffmpeg formula not found at {dim(formula_path)}")
        print(f"  Try: {dim('brew tap homebrew/core')}")
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
