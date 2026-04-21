#!/usr/bin/env python3
"""Generate video via Kling v3 Omni.

Single-shot mode (default):
    --prompt "..." --out video.mp4 [--ref-image path ...] [--first-frame ...]

Multi-shot customize mode (up to 6 scenes, one API call):
    --multi-shot --shot-type customize \
    --multi-prompt '[{"index":1,"prompt":"...","duration":"3"}, ...]' \
    --out video.mp4

Multi-shot intelligence mode (Kling splits one prompt into shots):
    --multi-shot --shot-type intelligence --prompt "..." --out video.mp4
"""
import sys, os, argparse, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from common import fail, require_file
from connectors import kling, ConnectorError


def main():
    p = argparse.ArgumentParser(description="Generate video via Kling v3 Omni")
    p.add_argument("--prompt",
                   help="Scene description. Required in single-shot mode and in "
                        "multi-shot intelligence mode; invalid in multi-shot customize mode.")
    p.add_argument("--out", required=True)
    p.add_argument("--first-frame", dest="first_frame",
                   help="Starting image (not supported in multi-shot mode)")
    p.add_argument("--last-frame", dest="last_frame",
                   help="Ending image; requires --first-frame (not supported in multi-shot mode)")
    p.add_argument("--ref-image", dest="ref_image", action="append", default=[],
                   help="Reference image (repeatable, max 7)")
    p.add_argument("--duration", type=int, default=5,
                   help="Clip length in seconds (3-15). Ignored in multi-shot customize mode "
                        "(derived from sum of multi_prompt durations).")
    p.add_argument("--negative-prompt", dest="negative_prompt")
    p.add_argument("--sound", default="on", choices=["on", "off"])
    p.add_argument("--aspect-ratio", dest="aspect_ratio", default="16:9")
    p.add_argument("--mode", default="std", choices=["std", "pro"])
    p.add_argument("--external-task-id", dest="external_task_id",
                   help="Caller correlation ID echoed back by Kling on queries")
    p.add_argument("--multi-shot", dest="multi_shot", action="store_true",
                   help="Enable multi-shot mode (up to 6 scenes in one API call)")
    p.add_argument("--shot-type", dest="shot_type", choices=["customize", "intelligence"],
                   help="Multi-shot storyboard strategy. Required when --multi-shot is set.")
    p.add_argument("--multi-prompt", dest="multi_prompt",
                   help='JSON array of storyboard entries: '
                        '\'[{"index":1,"prompt":"...","duration":"3"}, ...]\' '
                        '(1-6 entries, per-prompt cap 512 chars). Required when '
                        '--shot-type=customize.')
    args = p.parse_args()

    # --- Validate flag combinations that argparse can't express ---
    if args.multi_shot and not args.shot_type:
        fail("invalid_args", "--multi-shot requires --shot-type (customize|intelligence)")
    if args.shot_type and not args.multi_shot:
        fail("invalid_args", "--shot-type requires --multi-shot")
    if args.multi_prompt and not args.multi_shot:
        fail("invalid_args", "--multi-prompt requires --multi-shot")
    if args.multi_shot and args.shot_type == "customize" and not args.multi_prompt:
        fail("invalid_args", "--shot-type=customize requires --multi-prompt")
    if args.multi_shot and args.shot_type == "customize" and args.prompt:
        # Kling's spec: `prompt` is invalid when multi_shot=true with customize.
        # The connector omits it from the body anyway, but silently dropping the
        # caller's prompt is a footgun — make it loud.
        fail(
            "invalid_args",
            "--prompt is not supported with --shot-type=customize. In customize mode, "
            "per-shot prompts live in --multi-prompt entries. Kling ignores the top-level "
            "prompt here; passing both is almost certainly a mistake.",
        )
    if args.multi_shot and args.shot_type == "intelligence" and not args.prompt:
        fail("invalid_args", "--shot-type=intelligence requires --prompt")
    if not args.multi_shot and not args.prompt:
        fail("invalid_args", "--prompt is required in single-shot mode")
    if args.multi_shot and (args.first_frame or args.last_frame):
        fail("invalid_args", "--first-frame / --last-frame are not supported with --multi-shot")

    multi_prompt = None
    if args.multi_prompt:
        try:
            multi_prompt = json.loads(args.multi_prompt)
        except json.JSONDecodeError as e:
            fail("invalid_args", f"--multi-prompt must be valid JSON: {e}")

    if args.last_frame and not args.first_frame:
        fail("invalid_args", "--last-frame requires --first-frame")
    if args.first_frame:
        require_file(args.first_frame)
    if args.last_frame:
        require_file(args.last_frame)
    for r in args.ref_image:
        require_file(r)

    # Surface single-shot truncation as a stderr warning before launching the
    # (long-running) network call. The connector's MAX_PROMPT_CHARS is 2500;
    # if the combined prompt composed by the caller exceeds that, Kling
    # would silently truncate — we warn loudly instead so the caller can
    # notice and tighten the prompt.
    if args.prompt and not args.multi_shot and len(args.prompt) > kling.MAX_PROMPT_CHARS:
        print(
            json.dumps({
                "warn": "prompt_truncated",
                "message": (
                    f"Prompt is {len(args.prompt)} chars; Kling cap is "
                    f"{kling.MAX_PROMPT_CHARS}. Tail will be dropped at the connector. "
                    f"Tighten the combined prompt (styleAnchor + scene prose) to stay under the cap."
                ),
                "original_length": len(args.prompt),
                "max": kling.MAX_PROMPT_CHARS,
            }),
            file=sys.stderr,
        )

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
            external_task_id=args.external_task_id,
            multi_shot=args.multi_shot,
            shot_type=args.shot_type,
            multi_prompt=multi_prompt,
        )
    except ConnectorError as e:
        fail("api_error", str(e))

    print(out_path)


if __name__ == "__main__":
    main()
