#!/usr/bin/env python3
"""Analyze a media file (video, audio, or image) with Gemini."""
import sys, os, argparse, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail, require_file
from connectors import gemini, ConnectorError
from connectors.gemini import invalid_api_key_message


def main():
    p = argparse.ArgumentParser(description="Analyze a media file (video, audio, or image) with Gemini")
    p.add_argument("--input", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--model", default=gemini.DEFAULT_MODEL)
    p.add_argument("--json-output", dest="json_output", action="store_true",
                   help="Ask the model to return structured JSON")
    p.add_argument("--out")
    p.add_argument("--max-output-tokens", dest="max_output_tokens", type=int)
    p.add_argument("--thinking-budget", dest="thinking_budget", type=int)
    p.add_argument("--fps", type=float, help="Video sampling rate (frames per second)")
    p.add_argument("--media-resolution", dest="media_resolution", choices=["low", "medium", "high"])
    p.add_argument("--meta", action="store_true", help="Print one JSON object with text, usage and model")
    args = p.parse_args()

    require_file(args.input)

    try:
        result = gemini.analyze_media_meta(
            path=args.input,
            prompt=args.prompt,
            model=args.model,
            json_output=args.json_output,
            max_output_tokens=args.max_output_tokens,
            thinking_budget=args.thinking_budget,
            video_fps=args.fps,
            media_resolution=args.media_resolution,
        )
    except ConnectorError as e:
        if e.reason == "invalid_api_key":
            fail("invalid_api_key", invalid_api_key_message(e))
        fail("api_error", str(e))

    text = result["text"]

    # The raw reply is written before any JSON check: a paid reply is never lost.
    if args.out:
        try:
            with open(args.out, "w") as f:
                f.write(text)
        except OSError as e:
            fail("write_error", f"Could not write to {args.out}: {e}")

    if not args.meta:
        print(args.out if args.out else text)
        return

    payload = {"path": args.out} if args.out else {"text": text}
    payload["usage"] = result["usage"]
    payload["model"] = result["model"]
    if args.json_output:
        try:
            json.loads(text)
        except ValueError as e:
            payload["parseError"] = str(e)
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
