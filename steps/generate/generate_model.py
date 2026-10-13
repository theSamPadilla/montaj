#!/usr/bin/env python3
"""Generate a 3D model (.glb) on Tripo from a prompt, an image or views.

Standalone, like kinovi_generate. Mode follows the inputs
(connectors.tripo.build_generation_body):
    --prompt [--negative-prompt]          text-to-model
    --image                               image-to-model
    --view-front plus one or more of --view-left/--view-back/--view-right
                                          multiview-to-model
Always PBR-textured, at --texture quality, with --face-limit faces (30,000 by
default). WebP or AVIF textures in Tripo's GLB are re-encoded locally to PNG or
JPEG (lib/glb_textures.py), so the model loads in Montaj.

The task id is recorded in `<out>.tripo.json` before polling: running the same
command again re-attaches to it instead of paying twice. --task-id collects a
task already submitted (no new charge).
"""
import sys, os, argparse, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, require_file
from connectors import ConnectorError, tripo
from _fail_reasons import fail_for

VIEWS = ("front", "left", "back", "right")


def _is_url(value: str) -> bool:
    return value.startswith(("http://", "https://"))


def main():
    p = argparse.ArgumentParser(description="Generate a 3D model (.glb) on Tripo")
    p.add_argument("--prompt", help="What to model. Exactly one of --prompt, --image or the views.")
    p.add_argument("--image", help="One image of the subject (path or URL).")
    for view in VIEWS:
        p.add_argument(f"--view-{view}", dest=f"view_{view}",
                       help=f"The {view} view (path or URL). Multiview needs the front and at least one more.")
    p.add_argument("--out", required=True)
    p.add_argument("--texture", default="standard", choices=["standard", "detailed"],
                   help="Texture quality. detailed is slower.")
    p.add_argument("--face-limit", dest="face_limit", type=int, default=tripo.FACE_LIMIT_DEFAULT,
                   help="Most faces in the mesh: 1,000 to 150,000.")
    p.add_argument("--negative-prompt", dest="negative_prompt", help="What to avoid (with --prompt only).")
    p.add_argument("--task-id", dest="task_id",
                   help="A task already submitted: wait for it and download it (no new charge).")
    p.add_argument("--json", action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    views = {v: getattr(args, f"view_{v}") for v in VIEWS}
    given_views = {v: path for v, path in views.items() if path}

    if os.path.lexists(args.out):
        fail("invalid_out", f"{args.out} already exists. Montaj does not overwrite a model: choose a new --out.")
    if not args.out.lower().endswith(".glb"):
        fail("invalid_out", f"Tripo models are GLB files: --out must end in .glb, got {args.out!r}")

    if not args.task_id:
        modes = [flag for flag, on in (("--prompt", args.prompt is not None), ("--image", args.image is not None),
                                       ("views", bool(given_views))) if on]
        if len(modes) != 1:
            fail("invalid_args", "Give exactly one of --prompt, --image or views (--view-front and at least "
                                 "one of --view-left, --view-back, --view-right)"
                                 + (f"; got {' and '.join(modes)}" if modes else ""))
        if args.prompt is not None and not args.prompt.strip():
            fail("invalid_args", "--prompt must not be empty")
        if args.image is not None and not args.image.strip():
            fail("invalid_args", "--image must not be empty")
        if given_views:
            if "front" not in given_views:
                fail("invalid_args", "Multiview needs --view-front")
            if len(given_views) < 2:
                fail("invalid_args", "Multiview needs --view-front and at least one of --view-left, "
                                     "--view-back or --view-right")
        if args.negative_prompt and args.prompt is None:
            fail("invalid_args", "--negative-prompt goes with --prompt only")
        for path in [args.image, *given_views.values()]:
            if path and not _is_url(path):
                require_file(path)

    try:
        if args.task_id:
            result = tripo.resume_model(args.task_id, args.out)
        else:
            result = tripo.generate_model(
                out_path=args.out, prompt=args.prompt, image_path=args.image,
                view_paths=views if given_views else None, texture=args.texture,
                face_limit=args.face_limit, negative_prompt=args.negative_prompt,
            )
    except tripo.UnsupportedModel as e:
        fail("unsupported_model", str(e))
    except ConnectorError as e:
        fail_for(e, "Tripo")

    if args.json:
        print(json.dumps(result))
    else:
        print(result["path"])


if __name__ == "__main__":
    main()
