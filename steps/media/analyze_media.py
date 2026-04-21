#!/usr/bin/env python3
"""Analyze a media file (video, audio, or image) with Gemini Flash."""
import sys, os, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail, require_file
from connectors import gemini, ConnectorError


def main():
    p = argparse.ArgumentParser(description="Analyze a media file (video, audio, or image) with Gemini Flash")
    p.add_argument("--input", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--model", default="gemini-2.5-flash")
    p.add_argument("--json-output", dest="json_output", action="store_true",
                   help="Ask the model to return structured JSON")
    p.add_argument("--out")
    args = p.parse_args()

    require_file(args.input)

    try:
        text = gemini.analyze_media(
            path=args.input,
            prompt=args.prompt,
            model=args.model,
            json_output=args.json_output,
        )
    except ConnectorError as e:
        fail("api_error", str(e))

    if args.out:
        try:
            with open(args.out, "w") as f:
                f.write(text)
        except OSError as e:
            fail("write_error", f"Could not write to {args.out}: {e}")
        print(args.out)
    else:
        print(text)


if __name__ == "__main__":
    main()
