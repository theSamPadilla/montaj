#!/usr/bin/env python3
"""montaj install — install optional dependencies (whisper binary + weights, rvm)."""
import os, platform, shutil, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
import models as _models
from cli.main import MONTAJ_ROOT
from cli.deps import whisper_bin_path
from common import DEFAULT_WHISPER_MODEL
from cli.help import bold, green, red, yellow, cyan, dim


_parser = None


def register(subparsers):
    global _parser
    from cli.help import ColorHelpFormatter
    _parser = subparsers.add_parser("install", help="Install optional dependencies",
                                    formatter_class=lambda prog: ColorHelpFormatter(prog, max_help_position=40))
    sub = _parser.add_subparsers(dest="component", metavar="<component>")

    whisper_p = sub.add_parser("whisper", help="whisper-cpp binary + model weights")
    whisper_p.add_argument("--model", default=DEFAULT_WHISPER_MODEL,
                           help=f"Model to download (default: {DEFAULT_WHISPER_MODEL}, multilingual). "
                                f"The default weight is always added too.")

    sub.add_parser("rvm",    help="onnxruntime/av + RVM model")
    sub.add_parser("demucs", help="Demucs stem separation + htdemucs model weights")
    sub.add_parser("connectors", help="pyjwt + requests + google-genai for external API steps")
    sub.add_parser("ui",     help="npm deps + UI build")
    sub.add_parser("ffmpeg", help="Download the pinned static ffmpeg/ffprobe with zscale (libzimg) support")
    sub.add_parser("all",    help="Everything above, including ffmpeg")

    _parser.set_defaults(func=handle)


def handle(args):
    if not args.component:
        _parser.print_help()
        return
    ok = True
    if args.component == "all":
        ok &= _ensure_whisper([DEFAULT_WHISPER_MODEL])
        ok &= _ensure_rvm()
        ok &= _ensure_demucs()
        ok &= _ensure_connectors()
        ok &= _ensure_ui()
        ok &= _ensure_ffmpeg_managed()
    elif args.component == "whisper":
        ok &= _ensure_whisper(getattr(args, "model", DEFAULT_WHISPER_MODEL))
    elif args.component == "rvm":
        ok &= _ensure_rvm()
    elif args.component == "demucs":
        ok &= _ensure_demucs()
    elif args.component == "connectors":
        ok &= _ensure_connectors()
    elif args.component == "ui":
        ok &= _ensure_ui()
    elif args.component == "ffmpeg":
        ok = _ensure_ffmpeg_managed()
    if ok:
        print(f"\n{green('Done.')}")
    else:
        sys.exit(1)


def _ensure_whisper(models=DEFAULT_WHISPER_MODEL) -> bool:
    """Install the whisper-cli binary (via Homebrew on macOS) and download model weights.

    *models* is a model name or a list of names. ``DEFAULT_WHISPER_MODEL``
    (large-v3-turbo-q5_0) is always included alongside whatever is requested:
    it is multilingual, so it serves every language, and it is what the speech
    steps (transcribe / rm_nonspeech / rm_fillers) default to and fall back to
    when a requested weight is not installed.

    Note: ggerganov/whisper.cpp moved to ggml-org/whisper.cpp and stopped
    publishing pre-built macOS/Linux tarballs. We delegate the binary install
    to Homebrew on macOS (`brew install whisper-cpp` — bottled, fast) and
    instruct the user to build from source on Linux. Model weights are
    downloaded from HuggingFace in either case (independent of the binary
    upstream)."""
    from cli.commands.models import is_downloaded, _download as _download_model

    if not _ensure_whisper_binary():
        return False

    if isinstance(models, str):
        models = [models]
    # Always guarantee the default (multilingual) weight.
    wanted = list(dict.fromkeys([*models, DEFAULT_WHISPER_MODEL]))

    ok = True
    for model in wanted:
        if not is_downloaded(model):
            print(f"{cyan('→')} downloading whisper model {bold(model)}…")
            try:
                _download_model(model)
                print(f"{green('✓')} whisper model {bold(model)}")
            except (Exception, SystemExit):
                ok = False
        else:
            print(f"{green('✓')} whisper model {bold(model)}")
    return ok


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
    import rvm_model
    print(f"{cyan('→')} installing {bold('rvm')} deps {dim('(onnxruntime, av, numpy)')}\u2026")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "montaj[rvm]"])
    if r.returncode != 0:
        print(f"{red('error:')} {dim('pip install montaj[rvm]')} failed", file=sys.stderr)
        return False
    print(f"{green('✓')} rvm deps installed")
    # remove_bg never downloads, so the pinned model has to be here.
    try:
        _models.ensure_model("rvm", rvm_model.FILENAME, rvm_model.URL, rvm_model.SHA256)
    except (Exception, SystemExit) as e:
        print(f"{red('error:')} could not fetch {dim(rvm_model.FILENAME)}: {e}", file=sys.stderr)
        return False
    print(f"{green('✓')} {dim(rvm_model.FILENAME)}")
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

    # Five Node.js bundles ship with montaj. All need `npm install`; only the
    # UI needs build. A sixth directory, timeline-core, is a `file:` dependency
    # of two of these bundles but is not itself a bundle — see its own note
    # below, and the copytree loop further down.
    #
    # ORDERING IS LOAD-BEARING — each file: dependency must be staged before the
    # bundle that links it:
    #   - overlay-runtime MUST stay first: in prod mode the copytree loop below
    #     copies each source dir into BUILD_CACHE_DIR, and the runtime must exist
    #     on disk before render's `npm install` runs (render declares
    #     `montaj-overlay-runtime: file:../overlay-runtime`).
    #   - editor MUST precede ui: the UI declares `@bycrux/editor: file:../editor`,
    #     so `cache/editor` has to exist before ui's `npm install` resolves it.
    #     (Omitting it makes ui's build fail with `TS2307: Cannot find module
    #     '@bycrux/editor'` — the editor source never lands in the cache.)
    #   - In both dev and prod modes, ui/vite.config.ts hard-codes
    #     `resolve.alias` entries pointing at `../overlay-runtime/node_modules/*`
    #     for transitive deps that npm doesn't hoist out of file: symlinks
    #     (three, r3f, Phosphor, FontAwesome). Those node_modules MUST exist
    #     before UI's `npm run build` runs.
    #   - render AND editor both declare `@bycrux/timeline-core: file:../timeline-core`
    #     (SP2). Unlike the file: deps above, timeline-core has zero runtime
    #     dependencies and no build step (its only devDependency, typescript,
    #     is for local typechecking, not install/build), so it never needs its
    #     own `npm install` and isn't in `bundles` at all — it's copied into
    #     the cache alongside "schemas" below, which already runs before ANY
    #     bundle's `npm install`. It still needs to exist on disk first, same
    #     failure mode as the other file: deps if that copy is ever skipped.
    #
    # If you ever reorder this list, expect a file: dependency's install or the
    # UI build to fail with confusing module-resolution errors.
    bundles = [
        ("overlay runtime", "overlay-runtime"),
        ("render engine", "render"),
        ("editor", "editor"),
        ("UI", "ui"),
        ("MCP server", "mcp"),
    ]
    src_root = os.path.join(MONTAJ_ROOT, "montaj_assets")

    if is_dev_checkout():
        # Dev: build in place so Vite HMR works against source.
        targets = [(name, os.path.join(src_root, sub)) for name, sub in bundles]
        return _npm_install_and_build(targets)

    current = _pkg_version("montaj")
    if not _cache_is_stale(BUILD_CACHE_DIR, current):
        # Cache already matches this version: refresh it in place (fast, keeps
        # node_modules). Nothing is deleted, so a failure here cannot lose a
        # working cache.
        return _build_cache_tree(BUILD_CACHE_DIR, current, src_root, bundles)

    # Stale or missing: build a complete new tree NEXT TO the cache and swap it
    # in only once every step succeeded. The old cache is never touched before
    # that point, so an offline or failed rebuild leaves it exactly as it was.
    return _rebuild_and_swap(BUILD_CACHE_DIR, current, src_root, bundles)


def _build_cache_tree(root: str, current: str, src_root: str, bundles) -> bool:
    """Copy source -> `root`, npm install every bundle, build the UI, then
    stamp `root/.version`. Site-packages stays immutable."""
    import shutil
    os.makedirs(root, exist_ok=True)
    # `shutil.copytree(..., dirs_exist_ok=True)` overwrites changed files but
    # never removes deleted ones, which is why a stale cache is rebuilt into
    # a fresh directory (see `_rebuild_and_swap`) rather than refreshed here.
    ignore = shutil.ignore_patterns("node_modules", "__pycache__", "*.pyc")
    # Bundles + the shared schemas/ dir (loaded by render/color-space.js
    # via ../schemas/color_space.json — must be copied alongside) + the
    # shared timeline-core/ package (SP2; render and editor both declare
    # `file:../timeline-core` — see the ordering note above for why it's
    # copied here instead of added to `bundles`) + the shared luts/ dir
    # (SP6b; render/look.js resolves ../luts/<file>.cube the same way
    # color-space.js resolves ../schemas/color_space.json, so it has to
    # exist in the cache alongside the render bundle in prod mode).
    for sub in [s for _, s in bundles] + ["schemas", "timeline-core", "luts"]:
        shutil.copytree(
            os.path.join(src_root, sub),
            os.path.join(root, sub),
            dirs_exist_ok=True,
            ignore=ignore,
        )
    targets = [(name, os.path.join(root, sub)) for name, sub in bundles]
    if not _npm_install_and_build(targets):
        return False
    # Stamp only after every step succeeded — a partial build carries no stamp.
    _write_stamp(root, current)
    return True


def _npm_install_and_build(targets) -> bool:
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
    return True


def _rebuild_and_swap(cache_root: str, current: str, src_root: str, bundles) -> bool:
    """Build a complete cache in a private temp dir beside `cache_root`, then
    swap it into place. On any failure the temp dir is deleted and the old
    cache is left untouched.

    Each caller gets its own temp dir, so two processes rebuilding at once
    never write the same directory; whichever swaps last wins, and both
    results are complete, stamped trees."""
    import shutil, tempfile
    parent = os.path.dirname(cache_root.rstrip(os.sep)) or "."
    os.makedirs(parent, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=f".montaj-build-{os.getpid()}-", dir=parent)
    try:
        if not _build_cache_tree(tmp, current, src_root, bundles):
            if os.path.isdir(cache_root):
                print(f"{yellow('⚠')} previous runtime cache left in place {dim(f'({cache_root})')}",
                      file=sys.stderr)
            return False
        _swap_into_place(tmp, cache_root)
        return True
    finally:
        # Gone already after a successful swap; a leftover after a failure.
        shutil.rmtree(tmp, ignore_errors=True)


def _swap_into_place(new_dir: str, cache_root: str, attempts: int = 5) -> None:
    """Replace `cache_root` with `new_dir`: rename the old cache to a trash
    name, rename `new_dir` to `cache_root`, then delete the trash. Both
    renames are same-filesystem (siblings), so each is atomic.

    Retries if a concurrent swap lands between our two renames (our second
    rename then finds `cache_root` occupied again)."""
    import shutil, uuid
    parent = os.path.dirname(cache_root.rstrip(os.sep)) or "."
    last_err = None
    for _ in range(attempts):
        trash = os.path.join(parent, f".montaj-trash-{os.getpid()}-{uuid.uuid4().hex[:8]}")
        try:
            os.rename(cache_root, trash)
        except FileNotFoundError:
            trash = None
        try:
            os.rename(new_dir, cache_root)
        except OSError as e:
            last_err = e
            if trash:
                shutil.rmtree(trash, ignore_errors=True)
            continue
        if trash:
            shutil.rmtree(trash, ignore_errors=True)
        return
    raise last_err


def _ensure_ffmpeg_managed() -> bool:
    """Download the pinned static ffmpeg/ffprobe (with zscale) into the managed dir."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
    import ffmpeg_static
    try:
        if ffmpeg_static.is_installed():
            print(f"{green('✓')} managed ffmpeg already installed {dim(f'({ffmpeg_static.bin_dir()})')}")
            return True
        print(f"{cyan('→')} downloading static ffmpeg {bold(ffmpeg_static.PINNED_BUILDS[ffmpeg_static._platform_key()]['build_id'])} …")
        paths = ffmpeg_static.ensure_ffmpeg()
        r = subprocess.run([paths["ffmpeg"], "-hide_banner", "-filters"],
                           capture_output=True, text=True, timeout=10)
        if "zscale" not in (r.stdout or ""):
            print(f"{red('✗')} downloaded ffmpeg lacks zscale — unexpected; report this", file=sys.stderr)
            return False
        print(f"{green('✓')} ffmpeg + ffprobe installed with zscale {dim(f'({ffmpeg_static.bin_dir()})')}")
        return True
    except ffmpeg_static.UnsupportedPlatform as e:
        print(f"{yellow('⚠')} {e} — falling back to system ffmpeg; install one with libzimg manually", file=sys.stderr)
        return False
