#!/usr/bin/env python3
"""Capture a website for a brand/product film: desktop, mobile and full-page
screenshots, logo candidates, the computed palette and font families."""
import argparse, json, os, subprocess, sys
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib.common import node_child_env, fail  # noqa: E402
from cli.deps import render_runtime_dir  # noqa: E402  (as steps/render/sample_frame.py does)

CAPTURE_JS = os.path.join(render_runtime_dir(), "capture-site.js")


def main():
    ap = argparse.ArgumentParser(description="Capture screenshots, logos, palette and fonts from a URL")
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    if urlparse(args.url).scheme not in ("http", "https", "file"):
        fail("invalid_argument", "url must be http(s) or file")
    out = os.path.abspath(args.out_dir)
    os.makedirs(out, exist_ok=True)
    try:
        proc = subprocess.run(["node", CAPTURE_JS, args.url, out], capture_output=True, text=True,
                              env=node_child_env(), timeout=240)
    except subprocess.TimeoutExpired:
        fail("capture_timeout", "capture-site.js exceeded 240s")
    manifest = os.path.join(out, "manifest.json")
    if proc.returncode != 0 or not os.path.isfile(manifest):
        fail("capture_failed", proc.stderr.strip()[-600:] or "capture-site.js wrote no manifest")
    print(json.dumps({"path": manifest}))


if __name__ == "__main__":
    main()
