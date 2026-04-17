#!/usr/bin/env python3
"""Generate an image via Gemini or OpenAI."""
import sys, os, argparse

# Make lib/ importable (for common) and project root importable (for connectors/).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from common import fail, require_file
from connectors import ConnectorError


def main():
    p = argparse.ArgumentParser(description="Generate an image via Gemini or OpenAI")
    p.add_argument("--prompt", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--provider", default="gemini", choices=["gemini", "openai"])
    p.add_argument("--ref-image", dest="ref_image", action="append", default=[])
    p.add_argument("--size", default="1024x1024")
    p.add_argument("--aspect-ratio", dest="aspect_ratio")
    p.add_argument("--model")
    args = p.parse_args()

    for ref in args.ref_image:
        require_file(ref)

    kwargs = {
        "prompt": args.prompt,
        "out_path": args.out,
        "ref_images": args.ref_image or None,
        "size": args.size,
    }
    if args.model:
        kwargs["model"] = args.model

    try:
        if args.provider == "gemini":
            from connectors import gemini
            if args.aspect_ratio:
                kwargs["aspect_ratio"] = args.aspect_ratio
            out_path = gemini.generate_image(**kwargs)
        elif args.provider == "openai":
            from connectors import openai as openai_connector
            if args.aspect_ratio:
                # OpenAI doesn't use aspect_ratio — warn via stderr,
                # but don't fail. User might be switching providers quickly.
                print(
                    '{"warn": "aspect_ratio ignored by openai provider"}',
                    file=sys.stderr,
                )
            out_path = openai_connector.generate_image(**kwargs)
        else:
            fail("bad_provider", f"Unknown provider: {args.provider}")
    except ConnectorError as e:
        fail("api_error", str(e))

    print(out_path)


if __name__ == "__main__":
    main()
