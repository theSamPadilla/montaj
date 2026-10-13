#!/usr/bin/env python3
"""Generate an image via Gemini, OpenAI or Kinovi."""
import sys, os, argparse

# Make lib/ importable (for common) and project root importable (for connectors/).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, require_file
from connectors import ConnectorError
from connectors.gemini import invalid_api_key_message
from _fail_reasons import fail_for


def main():
    p = argparse.ArgumentParser(description="Generate an image via Gemini, OpenAI or Kinovi")
    p.add_argument("--prompt", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--provider", default="gemini", choices=["gemini", "kinovi", "openai"])
    p.add_argument("--ref-image", dest="ref_image", action="append", default=[])
    p.add_argument("--size", default="1024x1024")
    p.add_argument("--aspect-ratio", dest="aspect_ratio")
    p.add_argument("--model")
    p.add_argument("--resolution", help="Kinovi only: 1k, 2k or 4k (model-dependent).")
    p.add_argument("--quality", help="Kinovi gpt-image-2 only: low, medium or high.")
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
        elif args.provider == "kinovi":
            from connectors import kinovi
            if args.size != "1024x1024":
                print('{"warn": "size ignored by kinovi provider; use --resolution"}', file=sys.stderr)
            out_path = kinovi.generate_image(
                prompt=args.prompt, out_path=args.out, model=args.model or kinovi.DEFAULT_IMAGE_MODEL,
                ref_images=args.ref_image or None, aspect_ratio=args.aspect_ratio,
                resolution=args.resolution, quality=args.quality,
            )
        else:
            fail("bad_provider", f"Unknown provider: {args.provider}")
    except ConnectorError as e:
        if args.provider == "gemini" and e.reason == "invalid_api_key":
            fail("invalid_api_key", invalid_api_key_message(e))
        fail_for(e, {"openai": "OpenAI", "kinovi": "Kinovi"}.get(args.provider, "Gemini"))

    print(out_path)


if __name__ == "__main__":
    main()
