#!/usr/bin/env python3
"""Check a provider key with one free vendor call. Credentials come from the
environment (serve's per-request overlay or the CLI's stored file), so the app
can test a key before saving it. Never prints the key."""
import argparse, importlib, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib.common import fail  # noqa: E402
from connectors import ConnectorError, INVALID_API_KEY, INSUFFICIENT_CREDIT, UNREACHABLE  # noqa: E402

# kling, fal and elevenlabs are added by tasks 4/5/6 once their connectors gain
# check_key() — listing them here now would import modules that don't exist yet.
PROVIDERS = {"gemini": "connectors.gemini", "openai": "connectors.openai"}

def main():
    ap = argparse.ArgumentParser(description="Check a provider API key with one free call")
    ap.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    args = ap.parse_args()
    mod = importlib.import_module(PROVIDERS[args.provider])
    try:
        result = mod.check_key()
    except ConnectorError as e:
        code = {INVALID_API_KEY: "invalid_api_key", INSUFFICIENT_CREDIT: "insufficient_credit",
                UNREACHABLE: "provider_unreachable"}.get(e.reason, "check_failed")
        fail(code, str(e))
    print(json.dumps({"provider": args.provider, **result}))

if __name__ == "__main__":
    main()
