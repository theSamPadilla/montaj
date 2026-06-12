#!/usr/bin/env python3
"""Fetch an image from any public host to a local path (SSRF/size/content-type guarded)."""
import os
import sys
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail
from image_sources import allowed_image_hosts, fetch_image_to_path


def main():
    p = argparse.ArgumentParser(description="Fetch a licensed image from an allowed URL")
    p.add_argument("--url", required=True, help="HTTPS image URL to fetch")
    p.add_argument("--out", required=True, help="Output file path")
    p.add_argument("--max-bytes", dest="max_bytes", type=int, default=26_214_400,
                   help="Maximum allowed file size in bytes (default: 25 MiB)")
    args = p.parse_args()

    from pathlib import Path
    out = Path(args.out)
    hosts = allowed_image_hosts()

    result = fetch_image_to_path(args.url, out, hosts, max_bytes=args.max_bytes)
    print(str(result))


if __name__ == "__main__":
    main()
