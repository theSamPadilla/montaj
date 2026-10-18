#!/usr/bin/env python3
"""Animate a rigged 3D model (.glb) on Tripo with preset animations.

Standalone, like generate_model. --model must be a file rig_model made: Tripo
applies animations to the rig task, which the file's `<model>.tripo.json` record
names (a plain .glb is refused, with no call made). 1 to 5 --animation ids, each
checked against the rig's own list first (a misspelled one costs nothing):
    biped (rig v1.0-20240301): preset:biped:<name>, 101 of them (preset:biped:walk)
    other rigs (v2.5-20260210): preset:quadruped:walk, preset:hexapod:walk,
        preset:octopod:walk, preset:serpentine:march, preset:aquatic:march
The animation is baked into the .glb, geometry included. By default it plays in
place (the character stays where it is; the scene moves it); --root-motion keeps
the animation's own travel.

--task-id collects a task already submitted (a run that stopped or ran out of
time names it): no new task, no new charge, and no --model or --animation
needed. From the CLI, running the same command again with the same --out also
re-attaches to the task recorded in `<out>.tripo.json`.
"""
import sys, os, argparse, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, require_file
from connectors import ConnectorError, tripo
from _fail_reasons import fail_for


def main():
    p = argparse.ArgumentParser(description="Animate a rigged 3D model (.glb) on Tripo")
    p.add_argument("--model", help="The rigged .glb (made by rig_model) to animate. Required unless --task-id.")
    p.add_argument("--animation", action="append", default=[],
                   help=f"A preset animation id, e.g. preset:biped:walk (repeat for up to "
                        f"{tripo.MAX_ANIMATIONS}). Valid ids depend on the rig.")
    p.add_argument("--out", required=True)
    p.add_argument("--root-motion", dest="root_motion", action="store_true",
                   help="Keep the animation's own travel (a walk moves forward) instead of playing in place.")
    p.add_argument("--task-id", dest="task_id",
                   help="A task already submitted: wait for it and download it (no new charge).")
    p.add_argument("--json", action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    if os.path.lexists(args.out):
        fail("invalid_out", f"{args.out} already exists. Montaj does not overwrite a model: choose a new --out.")
    if not args.out.lower().endswith(".glb"):
        fail("invalid_out", f"Tripo models are GLB files: --out must end in .glb, got {args.out!r}")

    if not args.task_id:
        if not args.model:
            fail("invalid_args", "--model is required (unless --task-id collects a task already submitted)")
        if not 1 <= len(args.animation) <= tripo.MAX_ANIMATIONS:
            fail("invalid_args", f"Give 1 to {tripo.MAX_ANIMATIONS} --animation ids, such as "
                                 f"preset:biped:walk; got {len(args.animation)}")
        require_file(args.model)

    try:
        if args.task_id:
            result = tripo.resume_animation(args.task_id, args.out)
        else:
            result = tripo.animate_model(model_path=args.model, out_path=args.out,
                                         animations=args.animation, in_place=not args.root_motion)
    except tripo.UnsupportedModel as e:
        fail("unsupported_model", str(e))
    except tripo.InvalidInput as e:
        fail("invalid_args", str(e))
    except ConnectorError as e:
        fail_for(e, "Tripo")

    if args.json:
        print(json.dumps(result))
    else:
        print(result["path"])


if __name__ == "__main__":
    main()
