#!/usr/bin/env python3
"""Generate video (with sound) via Veo on the Gemini API.

Standalone mode: mode follows the inputs, same rule as connectors.gemini.generate_video:
    t2v     prompt only
    i2v     --image (first frame)
    frames  --image with --last-frame
    r2v     --ref-image (repeatable, up to 3; mutually exclusive with --image)

Project-aware mode (like kling_generate): --project-id and --scene-id. The step
reads the project, composes the prompt, generates, and saves the clip to
tracks[0] with generation.provider "gemini". Veo clips are 4, 6 or 8 s, so the
scene's duration is rounded up to the next one (the clip is trimmed to the
scene on the track).
"""
import sys, os, argparse, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, require_file, progress
from connectors import ConnectorError, gemini
from _fail_reasons import fail_for
from lib.ai_video import (
    find_project, compose_prompt, resolve_ref_paths, save_clip_to_project, save_error_to_project,
)


def _mode(image, last_frame, refs) -> str:
    if image:
        return "frames" if last_frame else "i2v"
    return "r2v" if refs else "t2v"


def _default_aspect(image_path) -> str:
    """16:9 for a landscape first frame, else 9:16. Without Pillow, 9:16."""
    if image_path:
        try:
            from PIL import Image
            with Image.open(image_path) as im:
                width, height = im.size
            if width > height:
                return "16:9"
        except Exception:
            pass
    return "9:16"


def _veo_seconds(seconds) -> int | None:
    """The shortest Veo clip length that holds `seconds`, None when over 8."""
    return next((d for d in gemini.VIDEO_DURATIONS if d >= seconds), None)


def _emit(args, out_path, mode):
    if args.json:
        print(json.dumps({"path": out_path, "model": args.model, "mode": mode}))
    else:
        print(out_path)


def _project_mode(args):
    project_path, project = find_project(args.project_id)
    scenes = project.get("storyboard", {}).get("scenes", [])
    scene = next((s for s in scenes if s["id"] == args.scene_id), None)
    if not scene:
        fail("not_found", f"Scene {args.scene_id} not found in project {args.project_id}")

    scene_seconds = scene.get("duration")
    if isinstance(scene_seconds, bool) or not isinstance(scene_seconds, (int, float)) or scene_seconds <= 0:
        fail("invalid_args", f"Scene {args.scene_id} has no duration to generate for")
    veo_seconds = _veo_seconds(scene_seconds)
    if veo_seconds is None:
        fail("invalid_args", f"Scene {args.scene_id} is {scene_seconds:g}s and Veo clips are 8s at most. "
                             f"Split the scene.")

    # No <<<image_N>>> tokens: Veo gets its references as plain asset images.
    composed_prompt = compose_prompt(project, scene, ref_tokens=False)
    ref_paths = resolve_ref_paths(project, scene)
    if len(ref_paths) > gemini.VIDEO_MAX_REFERENCE_IMAGES:
        fail("invalid_args", f"Scene {args.scene_id} has {len(ref_paths)} reference images and "
                             f"Veo takes up to {gemini.VIDEO_MAX_REFERENCE_IMAGES}.")
    for rp in ref_paths:
        require_file(rp)

    # kling_generate's project default, so a storyboard without one reads the same.
    aspect_ratio = project.get("storyboard", {}).get("aspectRatio", "16:9")
    if aspect_ratio not in gemini.VIDEO_ASPECT_RATIOS:
        fail("invalid_args", f"Storyboard aspect ratio {aspect_ratio} is not one Veo makes "
                             f"(16:9 or 9:16).")
    # Reference images, 1080p and 4k all need an 8 s clip; the track trims it.
    if ref_paths or args.resolution != "720p":
        veo_seconds = 8

    problem = gemini.video_request_problem(
        composed_prompt, image_path=args.image, last_frame_path=args.last_frame,
        reference_image_paths=ref_paths, duration=veo_seconds, aspect_ratio=aspect_ratio,
        resolution=args.resolution, model=args.model,
    )
    if problem:
        fail("invalid_args", problem)
    if args.image:
        require_file(args.image)
    if args.last_frame:
        require_file(args.last_frame)

    progress(f"Composing prompt for {args.scene_id}: {len(composed_prompt)} chars, "
             f"{len(ref_paths)} refs, {veo_seconds}s clip for a {scene_seconds:g}s scene")
    progress(f"Generating {args.scene_id} via Veo ({args.model})...")

    try:
        out_path = gemini.generate_video(
            prompt=composed_prompt,
            out_path=args.out,
            image_path=args.image,
            last_frame_path=args.last_frame,
            reference_image_paths=ref_paths or None,
            duration=veo_seconds,
            aspect_ratio=aspect_ratio,
            resolution=args.resolution,
            negative_prompt=args.negative_prompt,
            model=args.model,
        )
    except ConnectorError as e:
        progress(f"Failed {args.scene_id}: {e}")
        # Re-read project in case another scene wrote concurrently
        project_path, project = find_project(args.project_id)
        save_error_to_project(project_path, project, args.scene_id, str(e))
        fail_for(e, "Veo")

    progress(f"Done {args.scene_id} -> {out_path}")

    # Re-read project to get latest state (other scenes may have written)
    project_path, project = find_project(args.project_id)
    save_clip_to_project(project_path, project, scene, out_path, composed_prompt,
                         model=args.model, provider="gemini")
    progress(f"Saved clip for {args.scene_id} to project tracks[0]")

    _emit(args, out_path, _mode(args.image, args.last_frame, ref_paths))


def main():
    p = argparse.ArgumentParser(description="Generate video (with sound) via Veo on the Gemini API")
    p.add_argument("--prompt",
                   help="Scene description. Required in standalone mode. "
                        "Ignored in project-aware mode (composed from project context).")
    p.add_argument("--out", required=True)
    p.add_argument("--image", help="Starting image (first frame). Mutually exclusive with --ref-image.")
    p.add_argument("--last-frame", dest="last_frame", help="Ending image; requires --image")
    p.add_argument("--ref-image", dest="ref_image", action="append", default=[],
                   help="Reference image (repeatable, up to 3, needs an 8 s clip, not on lite). "
                        "Mutually exclusive with --image. Ignored in project-aware mode.")
    p.add_argument("--duration", type=int, default=8,
                   help="Clip length in seconds: 4, 6 or 8. 1080p, 4k and reference images need 8. "
                        "Ignored in project-aware mode (read from the scene).")
    p.add_argument("--aspect-ratio", dest="aspect_ratio", choices=list(gemini.VIDEO_ASPECT_RATIOS),
                   help="Default: 16:9 for a landscape --image, 9:16 otherwise. "
                        "Ignored in project-aware mode (read from the storyboard).")
    p.add_argument("--resolution", default="720p", choices=list(gemini.VIDEO_RESOLUTIONS))
    p.add_argument("--model", default=gemini.DEFAULT_VIDEO_MODEL, choices=list(gemini.VIDEO_MODELS),
                   help=f"{gemini.DEFAULT_VIDEO_MODEL} is the default and best model; "
                        f"fast and lite are cheaper.")
    p.add_argument("--negative-prompt", dest="negative_prompt", help="Things to avoid")
    p.add_argument("--project-id", dest="project_id",
                   help="Project ID. With --scene-id, the step reads the project, composes the "
                        "prompt, generates, and saves the clip to tracks[0].")
    p.add_argument("--scene-id", dest="scene_id",
                   help="Scene ID within the storyboard. Requires --project-id.")
    p.add_argument("--json", action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    if args.project_id and args.scene_id:
        return _project_mode(args)
    if args.project_id or args.scene_id:
        fail("invalid_args", "--project-id and --scene-id must be used together")

    aspect_ratio = args.aspect_ratio or _default_aspect(args.image)
    problem = gemini.video_request_problem(
        args.prompt, image_path=args.image, last_frame_path=args.last_frame,
        reference_image_paths=args.ref_image, duration=args.duration, aspect_ratio=aspect_ratio,
        resolution=args.resolution, model=args.model,
    )
    if problem:
        fail("invalid_args", problem)

    if args.image:
        require_file(args.image)
    if args.last_frame:
        require_file(args.last_frame)
    for r in args.ref_image:
        require_file(r)

    mode = _mode(args.image, args.last_frame, args.ref_image)

    try:
        out_path = gemini.generate_video(
            prompt=args.prompt,
            out_path=args.out,
            image_path=args.image,
            last_frame_path=args.last_frame,
            reference_image_paths=args.ref_image or None,
            duration=args.duration,
            aspect_ratio=aspect_ratio,
            resolution=args.resolution,
            negative_prompt=args.negative_prompt,
            model=args.model,
        )
    except ConnectorError as e:
        fail_for(e, "Veo")

    _emit(args, out_path, mode)


if __name__ == "__main__":
    main()
