#!/usr/bin/env python3
"""montaj credentials — manage API credentials for connectors."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))

from cli.help import c as _c, bold as _bold, dim as _dim, green as _green, yellow as _yellow, blue as _blue, cyan as _cyan, red as _red


_parser = None


def register(subparsers):
    global _parser
    from cli.help import ColorHelpFormatter
    _parser = subparsers.add_parser(
        "credentials",
        help="Manage API credentials for connectors",
        formatter_class=lambda prog: ColorHelpFormatter(prog, max_help_position=40),
    )
    _parser.add_argument("--provider", help="Provider name (e.g. kling, gemini)")
    _parser.add_argument("--key", help="Credential key (e.g. access_key, api_key)")
    _parser.add_argument("--value", help="Credential value")
    _parser.add_argument("--list", dest="list_creds", action="store_true",
                         help="List current credential status")
    _parser.set_defaults(func=handle)


def handle(args):
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


# ── Provider metadata ────────────────────────────────────────────────────────

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


# ── Helpers ──────────────────────────────────────────────────────────────────

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
        try:
            sys.stderr.write(prompt)
            sys.stderr.flush()
            return input().strip()
        except (EOFError, KeyboardInterrupt):
            return ""
