#!/usr/bin/env python3
"""Generate video via Seedance (ByteDance) on fal.ai.

Standalone only — no project-aware mode. The ai-video skill picks the vendor
per scene and writes results into the project itself (YAGNI, PV29 T7);
project-aware generation for now stays with Kling (kling_generate.py).

Mode follows the inputs, same rule as connectors.fal.generate_video:
    t2v  prompt only
    i2v  --image (first frame), optional --end-image (last frame)
    r2v  --ref-image (repeatable; mutually exclusive with --image)
"""
import sys, os, argparse, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, require_file
from connectors import ConnectorError, fal
from _fail_reasons import fail_for


def main():
    p = argparse.ArgumentParser(description="Generate video via Seedance (ByteDance) on fal.ai")
    p.add_argument("--prompt", required=True, help="Scene description")
    p.add_argument("--out", required=True)
    p.add_argument("--image", help="Starting image (first frame). Mutually exclusive with --ref-image.")
    p.add_argument("--end-image", dest="end_image", help="Ending image; requires --image")
    p.add_argument("--ref-image", dest="ref_image", action="append", default=[],
                   help="Reference image (repeatable). Mutually exclusive with --image.")
    p.add_argument("--duration", default="5",
                   help="Clip length in seconds, or 'auto'. Range is model-dependent.")
    p.add_argument("--aspect-ratio", dest="aspect_ratio",
                   help="e.g. '16:9', '9:16', 'auto'. Default: auto for --image, 9:16 otherwise.")
    p.add_argument("--resolution", default="720p", choices=["480p", "720p", "1080p", "4k"])
    p.add_argument("--model", default=fal.DEFAULT_MODEL, choices=sorted(fal.MODELS),
                   help=f"{fal.DEFAULT_MODEL} is the default and best model.")
    p.add_argument("--seed", type=int,
                   help="RNG seed. Only used in modes that support one (2.5 reference-to-video); "
                        "dropped with a warning elsewhere.")
    p.add_argument("--sound", action="store_true",
                   help="Generate audio with the clip (costs more). Off by default.")
    p.add_argument("--negative-prompt", dest="negative_prompt",
                   help="Things to avoid. Appended to the prompt as 'Avoid: ...'.")
    p.add_argument("--json", action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    if args.image and args.ref_image:
        fail("invalid_args", "Use either --image or --ref-image, not both")
    if args.end_image and not args.image:
        fail("invalid_args", "--end-image requires --image")

    if args.image:
        require_file(args.image)
    if args.end_image:
        require_file(args.end_image)
    for r in args.ref_image:
        require_file(r)

    mode = "i2v" if args.image else "r2v" if args.ref_image else "t2v"

    try:
        out_path = fal.generate_video(
            prompt=args.prompt,
            out_path=args.out,
            image_path=args.image,
            duration=args.duration,
            aspect_ratio=args.aspect_ratio,
            resolution=args.resolution,
            model=args.model,
            seed=args.seed,
            end_image_path=args.end_image,
            reference_image_paths=args.ref_image or None,
            generate_audio=args.sound,
            negative_prompt=args.negative_prompt,
        )
    except ConnectorError as e:
        fail_for(e, "Seedance")

    result = {"path": out_path, "model": args.model, "mode": mode}

    if args.json:
        print(json.dumps(result))
    else:
        print(out_path)


if __name__ == "__main__":
    main()
