#!/usr/bin/env python3
"""Generate video on Kinovi (Seedance and Wan models behind one API key).

Standalone, like seedance_generate: the ai-video skill picks the vendor per
scene and writes the result into the project itself.

Mode follows the inputs (connectors.kinovi.build_video_inputs):
    text only            text-to-video
    --image [--end-image]  frames: first, optional last (Seedance keyframe, Wan image-to-video)
    --ref-image ... [--ref-video ...] [--ref-audio ...]  Seedance reference mode
--task-id waits for and downloads a task already submitted (a run that timed
out): no new task, no new charge. --upgrade turns a Seedance 2.5 480p draft
(--draft) into a 1080p task.
"""
import sys, os, argparse, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, require_file
from connectors import ConnectorError, kinovi
from _fail_reasons import fail_for


def main():
    p = argparse.ArgumentParser(description="Generate video on Kinovi (Seedance, Wan)")
    p.add_argument("--prompt", help="Scene description. Required unless --task-id or --upgrade.")
    p.add_argument("--out", required=True)
    p.add_argument("--model", default=kinovi.DEFAULT_VIDEO_MODEL, choices=sorted(kinovi.VIDEO_MODELS),
                   help=f"{kinovi.DEFAULT_VIDEO_MODEL} is the default.")
    p.add_argument("--image", help="First frame. Mutually exclusive with --ref-image.")
    p.add_argument("--end-image", dest="end_image", help="Last frame; requires --image")
    p.add_argument("--ref-image", dest="ref_image", action="append", default=[],
                   help="Reference image (repeatable; Seedance). Mutually exclusive with --image.")
    p.add_argument("--ref-video", dest="ref_video", action="append", default=[],
                   help="Reference video (repeatable; Seedance; costs the reference-video rate).")
    p.add_argument("--ref-audio", dest="ref_audio", action="append", default=[],
                   help="Reference audio (repeatable; Seedance; needs an image or video beside it).")
    p.add_argument("--duration", type=int, default=5, help="Seconds. Range is model-dependent.")
    p.add_argument("--aspect-ratio", dest="aspect_ratio",
                   help="e.g. '16:9', '9:16', '1:1'. Frames follow the first frame's ratio.")
    p.add_argument("--resolution", default="720p", choices=["480p", "720p", "1080p", "4k"],
                   help="Availability is model-dependent.")
    p.add_argument("--seed", type=int, help="RNG seed (-1 for random).")
    p.add_argument("--sound", action="store_true", help="Generate audio with the clip. Off by default.")
    p.add_argument("--draft", action="store_true",
                   help="seedance2-5 at 480p only: a cheap preview that --upgrade turns into 1080p.")
    p.add_argument("--upgrade", help="A seedance2-5 draft's task id: generate it again at 1080p.")
    p.add_argument("--task-id", dest="task_id",
                   help="A task already submitted: wait for it and download it (no new charge).")
    p.add_argument("--json", action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    if args.task_id and args.upgrade:
        fail("invalid_args", "Use either --task-id or --upgrade, not both")
    if not (args.task_id or args.upgrade) and not (args.prompt and args.prompt.strip()):
        fail("invalid_args", "--prompt is required (unless --task-id or --upgrade)")
    if args.image and args.ref_image:
        fail("invalid_args", "Use either --image or --ref-image, not both")
    if args.end_image and not args.image:
        fail("invalid_args", "--end-image requires --image")
    for path in [args.image, args.end_image, *args.ref_image, *args.ref_video, *args.ref_audio]:
        if path and not path.startswith(("http://", "https://")):
            require_file(path)

    try:
        if args.task_id:
            result = kinovi.resume(args.task_id, args.out)
        elif args.upgrade:
            result = kinovi.upgrade_draft(args.upgrade, args.out)
        else:
            result = kinovi.generate_video(
                prompt=args.prompt, out_path=args.out, model=args.model,
                image_path=args.image, end_image_path=args.end_image,
                reference_image_paths=args.ref_image or None,
                reference_video_paths=args.ref_video or None,
                reference_audio_paths=args.ref_audio or None,
                duration=args.duration, aspect_ratio=args.aspect_ratio, resolution=args.resolution,
                sound=args.sound, seed=args.seed, draft=args.draft,
            )
    except ConnectorError as e:
        fail_for(e, "Kinovi")

    if args.json:
        print(json.dumps(result))
    else:
        print(result["path"])


if __name__ == "__main__":
    main()
