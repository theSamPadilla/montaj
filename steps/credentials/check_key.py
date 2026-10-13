#!/usr/bin/env python3
"""Check a provider key with one free vendor call. Credentials come from the
environment (serve's per-request overlay or the CLI's stored file), so the app
can test a key before saving it. Never prints the key."""
import argparse, importlib, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib.common import fail  # noqa: E402
from connectors import (  # noqa: E402
    ConnectorError, INVALID_API_KEY, INSUFFICIENT_CREDIT, MODEL_RETIRED, UNREACHABLE,
)

PROVIDERS = {
    "gemini": "connectors.gemini",
    "openai": "connectors.openai",
    "kling": "connectors.kling",
    "fal": "connectors.fal",
    "elevenlabs": "connectors.elevenlabs",
}

def main():
    ap = argparse.ArgumentParser(description="Check a provider API key with one free call")
    ap.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    args = ap.parse_args()
    mod = importlib.import_module(PROVIDERS[args.provider])
    try:
        result = mod.check_key()
    except ConnectorError as e:
        code = {INVALID_API_KEY: "invalid_api_key", INSUFFICIENT_CREDIT: "insufficient_credit",
                MODEL_RETIRED: "model_retired",
                UNREACHABLE: "provider_unreachable"}.get(e.reason, "check_failed")
        fail(code, str(e))
    print(json.dumps({"provider": args.provider, **result}))

if __name__ == "__main__":
    main()
