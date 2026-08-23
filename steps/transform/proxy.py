#!/usr/bin/env python3
"""Encode the full-source editing proxy: 720p, all-intra H.264+Opus, preview-only.

Wraps lib/proxy.py's make_proxy(). Render never reads a proxy file — this
step only ever produces a preview-track artifact (the project's proxySrc).
"""
import os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file
from normalize import probe_video
from proxy import make_proxy


def main():
    parser = argparse.ArgumentParser(
        description="Encode a full-source 720p all-intra H.264+Opus editing proxy (preview-only, never used by render)"
    )
    parser.add_argument("--input",   required=True,      help="Source video file")
    parser.add_argument("--tonemap", action="store_true", help="Source is HDR (original, not yet conformed) — compose scale-first HDR→SDR tonemap ahead of the encode")
    parser.add_argument("--out",     required=True,      help="Output path for the proxy")
    args = parser.parse_args()

    require_file(args.input)

    info = probe_video(args.input)
    if info is None:
        fail("probe_error", f"Cannot probe {args.input}")

    out_path = make_proxy(args.input, args.out, tonemap=args.tonemap, info=info)
    print(out_path)


if __name__ == "__main__":
    main()
