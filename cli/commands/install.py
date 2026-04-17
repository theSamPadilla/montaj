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
    _parser = subparsers.add_parser("install", help="Install optional dependencies")
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
            print(f"→ upgrading whisper-cpp {installed_version} → {WHISPER_VERSION} ({system}/{machine})…")
        else:
            print(f"→ downloading whisper-cpp binary ({system}/{machine})…")
        try:
            _install_whisper_binary(url, checksum, bin_path)
            print("✓ whisper-cpp binary installed")
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return False
    else:
        print(f"✓ whisper-cpp {WHISPER_VERSION}")
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
        # Write version marker so `montaj update` can detect stale installs
        with open(bin_path + ".version", "w") as vf:
            vf.write(WHISPER_VERSION)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)



def _ensure_demucs() -> bool:
    print("→ installing demucs deps…")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-e", ".[demucs]"])
    if r.returncode != 0:
        print("error: pip install .[demucs] failed", file=sys.stderr)
        return False
    print("✓ demucs deps installed")
    # Pre-warm: downloads htdemucs model weights on first use
    print("→ downloading htdemucs model weights…")
    try:
        from demucs.pretrained import get_model
        get_model("htdemucs")
        print("✓ htdemucs model ready")
    except Exception as e:
        print(f"warning: could not pre-warm demucs model: {e}", file=sys.stderr)
    return True


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


def _ensure_connectors() -> bool:
    from cli.main import MONTAJ_ROOT
    print("→ installing connector deps (pyjwt, requests, google-genai, openai)…")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-e", ".[connectors]"],
                       cwd=MONTAJ_ROOT)
    if r.returncode != 0:
        print("error: pip install .[connectors] failed", file=sys.stderr)
        return False
    print("✓ connector deps installed")
    return True


def _handle_credentials(args):
    from lib.credentials import (
        KNOWN_PROVIDERS, CredentialError,
        get_credential, set_credential, list_providers,
    )

    try:
        # --list mode
        if getattr(args, "list_creds", False):
            data = list_providers()
            if not data:
                print("No credentials configured yet.")
                print(f"Run: montaj install credentials")
                return
            for provider, keys in data.items():
                print(f"  {provider}:")
                for k, v in keys.items():
                    print(f"    {k}: {v}")
            return

        # Scripted mode: --provider + --key + --value
        if args.provider and args.key and args.value:
            if args.provider not in KNOWN_PROVIDERS:
                print(f"error: unknown provider '{args.provider}'. "
                      f"Known: {', '.join(KNOWN_PROVIDERS)}", file=sys.stderr)
                sys.exit(1)
            if args.key not in KNOWN_PROVIDERS[args.provider]:
                print(f"error: unknown key '{args.key}' for {args.provider}. "
                      f"Known: {', '.join(KNOWN_PROVIDERS[args.provider])}", file=sys.stderr)
                sys.exit(1)
            set_credential(args.provider, args.key, args.value)
            print(f"✓ Saved {args.provider}.{args.key}")
            return

        # If partial scripted args given, error
        if args.provider or args.key or args.value:
            print("error: --provider, --key, and --value must all be specified together",
                  file=sys.stderr)
            sys.exit(1)

        # Interactive mode
        import getpass

        _DESCRIPTIONS = {
            "kling":  "Kling AI — video generation",
            "gemini": "Google Gemini — video analysis & image generation",
            "openai": "OpenAI — image generation",
        }

        providers = list(KNOWN_PROVIDERS.keys())
        print("Available providers:")
        for i, p in enumerate(providers, 1):
            desc = _DESCRIPTIONS.get(p, "")
            print(f"  {i}. {p}" + (f" — {desc}" if desc else ""))

        choice = input("\nWhich provider? (number, comma-separated list, or 'all'): ").strip()
        if not choice:
            print("error: no provider selected", file=sys.stderr)
            sys.exit(1)

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
                        print(f"error: invalid number: {part}", file=sys.stderr)
                        sys.exit(1)
                except ValueError:
                    if part in providers:
                        selected.append(part)
                    else:
                        print(f"error: unknown provider: {part}", file=sys.stderr)
                        sys.exit(1)

        for provider in selected:
            print(f"\n{provider}:")
            keys = KNOWN_PROVIDERS[provider]
            for key in keys:
                # Check if already set
                try:
                    get_credential(provider, key)
                    already_set = True
                except CredentialError:
                    already_set = False

                if already_set:
                    prompt_str = f"  {key} [already set, press enter to keep]: "
                else:
                    prompt_str = f"  {key}: "

                value = getpass.getpass(prompt_str)
                if value:
                    set_credential(provider, key, value)
                elif not already_set:
                    print(f"    (skipped)")

        print(f"\n✓ Saved to ~/.montaj/credentials.json (0600)")

    except CredentialError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)


def _ensure_ui() -> bool:
    import shutil
    if not shutil.which("npm"):
        print("error: npm not found — install Node.js >=18 first: https://nodejs.org", file=sys.stderr)
        return False
    root = os.path.join(os.path.dirname(__file__), "..", "..")
    for name, directory in [("render engine", "render"), ("UI", "ui")]:
        path = os.path.normpath(os.path.join(root, directory))
        print(f"→ npm install ({name})…")
        r = subprocess.run(["npm", "install", "--prefix", path])
        if r.returncode != 0:
            print(f"error: npm install failed for {directory}/", file=sys.stderr)
            return False
        print(f"✓ {name} deps installed")
    ui_path = os.path.normpath(os.path.join(root, "ui"))
    print("→ npm run build (UI)…")
    r = subprocess.run(["npm", "run", "build", "--prefix", ui_path])
    if r.returncode != 0:
        print("error: npm run build failed for ui/", file=sys.stderr)
        return False
    print("✓ UI built")
    return True
