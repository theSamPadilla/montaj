#!/usr/bin/env python3
"""Generate video via Kling v3 Omni."""
import sys, os, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from common import fail, require_file
from connectors import kling, ConnectorError


def main():
    p = argparse.ArgumentParser(description="Generate video via Kling v3 Omni")
    p.add_argument("--prompt", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--first-frame", dest="first_frame")
    p.add_argument("--last-frame", dest="last_frame")
    p.add_argument("--ref-image", dest="ref_image", action="append", default=[])
    p.add_argument("--duration", type=int, default=5)
    p.add_argument("--negative-prompt", dest="negative_prompt")
    p.add_argument("--sound", default="on", choices=["on", "off"])
    p.add_argument("--aspect-ratio", dest="aspect_ratio", default="16:9")
    p.add_argument("--mode", default="std", choices=["std", "pro"])
    args = p.parse_args()

    if args.last_frame and not args.first_frame:
        fail("invalid_args", "--last-frame requires --first-frame")
    if args.first_frame:
        require_file(args.first_frame)
    if args.last_frame:
        require_file(args.last_frame)
    for r in args.ref_image:
        require_file(r)

    try:
        out_path = kling.generate(
            prompt=args.prompt,
            out_path=args.out,
            first_frame_path=args.first_frame,
            last_frame_path=args.last_frame,
            reference_image_paths=args.ref_image or None,
            duration_seconds=args.duration,
            negative_prompt=args.negative_prompt,
            sound=args.sound,
            aspect_ratio=args.aspect_ratio,
            mode=args.mode,
        )
    except ConnectorError as e:
        fail("api_error", str(e))

    print(out_path)


if __name__ == "__main__":
    main()
