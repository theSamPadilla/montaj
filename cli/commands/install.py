#!/usr/bin/env python3
"""montaj install — install optional dependencies (whisper binary + weights, rvm)."""
import os, platform, subprocess, sys
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
    sub.add_parser("all",    help="Everything above")

    cred_p = sub.add_parser("credentials", help="Set up API credentials for connectors")
    cred_p.add_argument("--provider", help="Provider name (e.g. kling, gemini)")
    cred_p.add_argument("--key", help="Credential key (e.g. access_key, api_key)")
    cred_p.add_argument("--value", help="Credential value")
    cred_p.add_argument("--list", dest="list_creds", action="store_true",
                        help="List current credential status")

    _parser.set_defaults(func=handle)


def handle(args):
    if not args.component:
        _parser.print_help()
        return
    if args.component == "credentials":
        _handle_credentials(args)
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
    if ok:
        print("\nDone.")
    else:
        sys.exit(1)


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
    version_file = bin_path + ".version"
    installed_version = None
    if os.path.isfile(version_file):
        with open(version_file) as f:
            installed_version = f.read().strip()
    needs_install = not os.path.isfile(bin_path)
    needs_upgrade = installed_version and installed_version != WHISPER_VERSION
    if needs_install or needs_upgrade:
        if needs_upgrade:
            print(f"\u2192 upgrading whisper-cpp {installed_version} \u2192 {WHISPER_VERSION} ({system}/{machine})\u2026")
        else:
            print(f"\u2192 downloading whisper-cpp binary ({system}/{machine})\u2026")
        try:
            _install_whisper_binary(url, checksum, bin_path)
            print("\u2713 whisper-cpp binary installed")
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return False
    else:
        print(f"\u2713 whisper-cpp {WHISPER_VERSION}")
    if not is_downloaded(model):
        print(f"\u2192 downloading whisper model {model}\u2026")
        try:
            _download_model(model)
            print(f"\u2713 whisper model {model}")
        except (Exception, SystemExit):
            return False
    else:
        print(f"\u2713 whisper model {model}")
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
    print("\u2192 installing demucs deps\u2026")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-e", ".[demucs]"])
    if r.returncode != 0:
        print("error: pip install .[demucs] failed", file=sys.stderr)
        return False
    print("\u2713 demucs deps installed")
    # Pre-warm: downloads htdemucs model weights on first use
    print("\u2192 downloading htdemucs model weights\u2026")
    try:
        from demucs.pretrained import get_model
        get_model("htdemucs")
        print("\u2713 htdemucs model ready")
    except Exception as e:
        print(f"warning: could not pre-warm demucs model: {e}", file=sys.stderr)
    return True


def _ensure_rvm() -> bool:
    print("\u2192 installing rvm deps (torch, torchvision, av)\u2026")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-e", ".[rvm]"])
    if r.returncode != 0:
        print("error: pip install .[rvm] failed", file=sys.stderr)
        return False
    print("\u2713 rvm deps installed")
    # Pre-fetch all model weights so there are no lazy downloads at runtime
    RVM_WEIGHTS = {
        "rvm_mobilenetv3.pth": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3.pth",
        "rvm_resnet50.pth":    "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50.pth",
    }
    for filename, url in RVM_WEIGHTS.items():
        try:
            _models.ensure_model("rvm", filename, url, None)
            print(f"\u2713 {filename}")
        except Exception as e:
            print(f"warning: could not pre-fetch {filename}: {e}", file=sys.stderr)
    return True


def _ensure_connectors() -> bool:
    from cli.main import MONTAJ_ROOT
    print("\u2192 installing connector deps (pyjwt, requests, google-genai, openai)\u2026")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-e", ".[connectors]"],
                       cwd=MONTAJ_ROOT)
    if r.returncode != 0:
        print("error: pip install .[connectors] failed", file=sys.stderr)
        return False
    print("\u2713 connector deps installed")
    return True


# ── ANSI helpers (shared from cli.help) ───────────────────────────────────────

from cli.help import c as _c, bold as _bold, dim as _dim, green as _green, yellow as _yellow, blue as _blue, cyan as _cyan, red as _red


# ── Credentials TUI ──────────────────────────────────────────────────────────

_PROVIDER_INFO = {
    "kling": {
        "display": "Kling AI",
        "desc": "Video generation",
        "url": "https://platform.klingai.com",
        "keys": {
            "access_key": "Your identity (becomes the JWT issuer claim)",
            "secret_key": "Your signing secret (signs the JWT, never sent over the wire)",
        },
    },
    "gemini": {
        "display": "Google Gemini",
        "desc": "Video analysis & image generation",
        "url": "https://aistudio.google.com/apikey",
        "keys": {
            "api_key": "API key from Google AI Studio",
        },
    },
    "openai": {
        "display": "OpenAI",
        "desc": "Image generation",
        "url": "https://platform.openai.com/api-keys",
        "keys": {
            "api_key": "API key from OpenAI dashboard",
        },
    },
}


def _handle_credentials(args):
    from lib.credentials import (
        KNOWN_PROVIDERS, CredentialError,
        get_credential, set_credential, list_providers,
    )

    try:
        # --list mode
        if getattr(args, "list_creds", False):
            data = list_providers()
            print()
            print(_bold("  Credential status"))
            print()
            for provider, keys in data.items():
                info = _PROVIDER_INFO.get(provider, {})
                display = info.get("display", provider)
                print(f"  {_bold(_cyan(display))} {_dim('(' + provider + ')')}")
                for k, v in keys.items():
                    if v == "set":
                        print(f"    {_green('\u2713')} {k}")
                    else:
                        print(f"    {_dim('\u2717')} {k} {_dim('not set')}")
                print()
            return

        # Scripted mode: --provider + --key + --value
        if args.provider and args.key and args.value:
            if args.provider not in KNOWN_PROVIDERS:
                print(f"{_red('error')}: unknown provider '{args.provider}'. "
                      f"Known: {', '.join(KNOWN_PROVIDERS)}", file=sys.stderr)
                sys.exit(1)
            if args.key not in KNOWN_PROVIDERS[args.provider]:
                print(f"{_red('error')}: unknown key '{args.key}' for {args.provider}. "
                      f"Known: {', '.join(KNOWN_PROVIDERS[args.provider])}", file=sys.stderr)
                sys.exit(1)
            set_credential(args.provider, args.key, args.value)
            print(f"{_green('\u2713')} Saved {args.provider}.{args.key}")
            return

        # If partial scripted args given, error
        if args.provider or args.key or args.value:
            print(f"{_red('error')}: --provider, --key, and --value must all be specified together",
                  file=sys.stderr)
            sys.exit(1)

        # ── Interactive mode ──────────────────────────────────────────────

        print()
        print(f"  {_bold('montaj')} {_dim('credential setup')}")
        print()
        print(f"  Keys are stored in {_dim('~/.montaj/credentials.json')} (0600, never logged).")
        print(f"  You can also set env vars instead — e.g. {_dim('KLING_ACCESS_KEY')}.")
        print()

        providers = list(KNOWN_PROVIDERS.keys())
        for i, p in enumerate(providers, 1):
            info = _PROVIDER_INFO.get(p, {})
            display = info.get("display", p)
            desc = info.get("desc", "")
            url = info.get("url", "")

            # Check current status
            keys = KNOWN_PROVIDERS[p]
            all_set = all(_key_is_set(get_credential, p, k) for k in keys)
            status = _green(" \u2713 ready") if all_set else ""

            print(f"  {_bold(str(i))}  {_bold(_cyan(display))}{status}")
            print(f"     {desc}")
            if url:
                print(f"     {_dim(url)}")
            print()

        choice = input(f"  Which provider? {_dim('(number, comma-separated, or all)')}: ").strip()
        if not choice:
            print(f"\n  {_dim('Nothing selected, exiting.')}")
            return

        if choice.lower() == "all":
            selected = providers
        else:
            selected = []
            for part in choice.split(","):
                part = part.strip()
                try:
                    idx = int(part) - 1
                    if 0 <= idx < len(providers):
                        selected.append(providers[idx])
                    else:
                        print(f"\n  {_red('error')}: invalid number: {part}", file=sys.stderr)
                        sys.exit(1)
                except ValueError:
                    if part in providers:
                        selected.append(part)
                    else:
                        print(f"\n  {_red('error')}: unknown provider: {part}", file=sys.stderr)
                        sys.exit(1)

        saved_count = 0
        for provider in selected:
            info = _PROVIDER_INFO.get(provider, {})
            display = info.get("display", provider)
            url = info.get("url", "")
            key_descs = info.get("keys", {})

            print()
            print(f"  {_bold(_cyan(display))}")
            if url:
                print(f"  Get your keys at: {_cyan(url)}")
            print()

            keys = KNOWN_PROVIDERS[provider]
            for key in keys:
                already_set = _key_is_set(get_credential, provider, key)
                hint = key_descs.get(key, "")

                if already_set:
                    label = f"  {key} {_green('[set]')} {_dim('enter to keep, or paste new value')}: "
                else:
                    label = f"  {key} {_dim('(' + hint + ')')}{_dim(' — hidden input')}: " if hint else f"  {key}{_dim(' — hidden input')}: "

                value = _read_secret(label)
                if value:
                    set_credential(provider, key, value)
                    saved_count += 1
                    print(f"  {_green('\u2713')} {key} saved")
                elif already_set:
                    print(f"  {_dim('\u2013 kept existing')}")
                else:
                    print(f"  {_yellow('\u2013 skipped')}")

        print()
        if saved_count:
            print(f"  {_green('\u2713')} Saved to {_dim('~/.montaj/credentials.json')}")
        else:
            print(f"  {_dim('No changes made.')}")
        print()

    except KeyboardInterrupt:
        print(f"\n\n  {_dim('Cancelled.')}")
        sys.exit(130)
    except CredentialError as e:
        print(f"\n  {_red('error')}: {e}", file=sys.stderr)
        sys.exit(1)


def _key_is_set(get_fn, provider: str, key: str) -> bool:
    try:
        get_fn(provider, key)
        return True
    except Exception:
        return False


def _read_secret(prompt: str) -> str:
    """Read a secret from the terminal. Falls back to plain input() if getpass fails."""
    try:
        import getpass
        return getpass.getpass(prompt).strip()
    except (EOFError, OSError):
        # getpass can fail in some terminal environments (piped stdin, IDE terminals)
        try:
            sys.stderr.write(prompt)
            sys.stderr.flush()
            return input().strip()
        except (EOFError, KeyboardInterrupt):
            return ""


def _ensure_ui() -> bool:
    import shutil
    if not shutil.which("npm"):
        print("error: npm not found \u2014 install Node.js >=18 first: https://nodejs.org", file=sys.stderr)
        return False
    root = os.path.join(os.path.dirname(__file__), "..", "..")
    for name, directory in [("render engine", "render"), ("UI", "ui")]:
        path = os.path.normpath(os.path.join(root, directory))
        print(f"\u2192 npm install ({name})\u2026")
        r = subprocess.run(["npm", "install", "--prefix", path])
        if r.returncode != 0:
            print(f"error: npm install failed for {directory}/", file=sys.stderr)
            return False
        print(f"\u2713 {name} deps installed")
    ui_path = os.path.normpath(os.path.join(root, "ui"))
    print("\u2192 npm run build (UI)\u2026")
    r = subprocess.run(["npm", "run", "build", "--prefix", ui_path])
    if r.returncode != 0:
        print("error: npm run build failed for ui/", file=sys.stderr)
        return False
    print("\u2713 UI built")
    return True
