#!/usr/bin/env python3
"""Generate video via Kling v3 Omni.

Standalone mode (no project context):
    --prompt "..." --out video.mp4 [--ref-image path ...] [--first-frame ...]

Project-aware mode (reads project, composes prompt, saves clip):
    --project-id <id> --scene-id <scene-id> --out video.mp4

Multi-shot customize mode (up to 6 scenes, one API call):
    --multi-shot --shot-type customize \
    --multi-prompt '[{"index":1,"prompt":"...","duration":"3"}, ...]' \
    --out video.mp4

Multi-shot intelligence mode (Kling splits one prompt into shots):
    --multi-shot --shot-type intelligence --prompt "..." --out video.mp4
"""
import sys, os, argparse, json, time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from common import fail, require_file, progress
from connectors import kling, ConnectorError
from pathlib import Path


# ---------------------------------------------------------------------------
# Project-aware helpers
# ---------------------------------------------------------------------------

def _resolve_workspace() -> Path:
    config_path = Path.home() / ".montaj" / "config.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text())
            if "workspaceDir" in cfg:
                return Path(cfg["workspaceDir"])
        except Exception:
            pass
    return Path.home() / "Montaj"


def _find_project(project_id: str) -> tuple[Path, dict]:
    """Find and load project by ID. Returns (project_json_path, project_dict)."""
    workspace = _resolve_workspace()
    for p in workspace.glob("*/project.json"):
        try:
            data = json.loads(p.read_text())
            if data.get("id") == project_id:
                return p, data
        except Exception:
            pass
    fail("not_found", f"Project {project_id} not found in {workspace}")


def _save_project(path: Path, project: dict):
    """Write project JSON back to disk."""
    path.write_text(json.dumps(project, indent=2, ensure_ascii=False))


def _compose_prompt(project: dict, scene: dict) -> str:
    """Compose the full Kling prompt from project context + scene prose.

    Applies: styleAnchor prefix + ref clause + inline <<<image_N>>> tokens
    at character/object label positions in the scene prompt.
    """
    style_anchor = project.get("storyboard", {}).get("styleAnchor", "")
    image_refs = {r["id"]: r for r in project.get("storyboard", {}).get("imageRefs", [])}

    prompt = scene["prompt"]
    ref_ids = scene.get("refImages", [])

    # Build tokens and place inline at label matches
    token_parts = []
    for i, rid in enumerate(ref_ids):
        token = f"<<<image_{i + 1}>>>"
        token_parts.append(token)
        ref = image_refs.get(rid, {})
        label = ref.get("label", "")
        if label and label in prompt:
            prompt = prompt.replace(label, f"{label} {token}", 1)

    # Prepend ref clause
    ref_clause = ""
    if token_parts:
        ref_clause = "Use the character/style from " + ", ".join(token_parts) + ". "

    parts = []
    if style_anchor:
        parts.append(style_anchor)
    if ref_clause:
        parts.append(ref_clause + prompt)
    else:
        parts.append(prompt)

    return " ".join(parts)


def _resolve_ref_paths(project: dict, scene: dict) -> list[str]:
    """Resolve scene refImage IDs to file paths."""
    image_refs = {r["id"]: r for r in project.get("storyboard", {}).get("imageRefs", [])}
    paths = []
    for rid in scene.get("refImages", []):
        ref = image_refs.get(rid, {})
        ref_images = ref.get("refImages", [])
        if ref_images:
            paths.append(ref_images[0])
    return paths


def _save_clip_to_project(project_path: Path, project: dict, scene: dict,
                          out_path: str, composed_prompt: str, model: str = "kling-v3-omni"):
    """Append the generated clip to tracks[0] and save the project."""
    tracks0 = project.get("tracks", [[]])[0]
    scenes = project.get("storyboard", {}).get("scenes", [])

    # Compute cumulative start from scene order
    scene_order = [s["id"] for s in scenes]
    cumulative = 0.0
    for sid in scene_order:
        if sid == scene["id"]:
            break
        existing = next(
            (c for c in tracks0 if c.get("generation", {}).get("sceneId") == sid),
            None,
        )
        if existing:
            cumulative += existing["outPoint"]
        else:
            cumulative += next(
                (s["duration"] for s in scenes if s["id"] == sid), 0
            )

    clip = {
        "id": f"clip-{scene['id']}",
        "type": "video",
        "src": out_path,
        "start": cumulative,
        "end": cumulative + scene["duration"],
        "inPoint": 0,
        "outPoint": scene["duration"],
        "generation": {
            "sceneId": scene["id"],
            "provider": "kling",
            "model": model,
            "prompt": composed_prompt,
            "refImages": scene.get("refImages", []),
            "duration": scene["duration"],
            "attempts": [],
        },
    }
    tracks0.append(clip)
    project["tracks"] = [tracks0]

    # Clear lastError on this scene
    for s in scenes:
        if s["id"] == scene["id"]:
            s.pop("lastError", None)

    # Check if all scenes have clips → set draft
    scene_ids = {s["id"] for s in scenes}
    clip_ids = {c.get("generation", {}).get("sceneId") for c in tracks0}
    for c in tracks0:
        for bs in c.get("generation", {}).get("batchShots", []):
            clip_ids.add(bs.get("sceneId"))
    if scene_ids and scene_ids <= clip_ids:
        project["status"] = "draft"

    _save_project(project_path, project)


def _save_error_to_project(project_path: Path, project: dict, scene_id: str, error_msg: str):
    """Record lastError on a scene and save."""
    for s in project.get("storyboard", {}).get("scenes", []):
        if s["id"] == scene_id:
            s["lastError"] = {
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "message": error_msg,
            }
    _save_project(project_path, project)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Generate video via Kling v3 Omni")
    p.add_argument("--prompt",
                   help="Scene description. Required in standalone single-shot mode. "
                        "Ignored in project-aware mode (composed from project context).")
    p.add_argument("--out", required=True)
    p.add_argument("--first-frame", dest="first_frame",
                   help="Starting image (not supported in multi-shot mode)")
    p.add_argument("--last-frame", dest="last_frame",
                   help="Ending image; requires --first-frame (not supported in multi-shot mode)")
    p.add_argument("--ref-image", dest="ref_image", action="append", default=[],
                   help="Reference image (repeatable, max 7). Ignored in project-aware mode.")
    p.add_argument("--duration", type=int, default=5,
                   help="Clip length in seconds. Ignored in project-aware mode (read from scene).")
    p.add_argument("--negative-prompt", dest="negative_prompt")
    p.add_argument("--sound", default="on", choices=["on", "off"])
    p.add_argument("--aspect-ratio", dest="aspect_ratio", default="16:9")
    p.add_argument("--mode", default="std", choices=["std", "pro"])
    p.add_argument("--model", default="kling-v3-omni",
                   choices=["kling-v3-omni", "kling-video-o1"],
                   help="Kling model. kling-video-o1 is newer but only supports 5s/10s durations and no multi-shot.")
    p.add_argument("--external-task-id", dest="external_task_id",
                   help="Caller correlation ID. Auto-generated in project-aware mode.")
    p.add_argument("--multi-shot", dest="multi_shot", action="store_true",
                   help="Enable multi-shot mode (up to 6 scenes in one API call)")
    p.add_argument("--shot-type", dest="shot_type", choices=["customize", "intelligence"],
                   help="Multi-shot storyboard strategy. Required when --multi-shot is set.")
    p.add_argument("--multi-prompt", dest="multi_prompt",
                   help='JSON array of storyboard entries (multi-shot customize mode).')

    # Project-aware mode
    p.add_argument("--project-id", dest="project_id",
                   help="Project ID. When set with --scene-id, the step reads the project, "
                        "composes the prompt, generates, and saves the clip to tracks[0].")
    p.add_argument("--scene-id", dest="scene_id",
                   help="Scene ID within the storyboard. Requires --project-id.")

    args = p.parse_args()

    # -----------------------------------------------------------------------
    # Project-aware mode
    # -----------------------------------------------------------------------
    if args.project_id and args.scene_id:
        project_path, project = _find_project(args.project_id)
        scenes = project.get("storyboard", {}).get("scenes", [])
        scene = next((s for s in scenes if s["id"] == args.scene_id), None)
        if not scene:
            fail("not_found", f"Scene {args.scene_id} not found in project {args.project_id}")

        # Compose prompt from project context
        composed_prompt = _compose_prompt(project, scene)

        # Resolve ref image paths
        ref_paths = _resolve_ref_paths(project, scene)
        for rp in ref_paths:
            require_file(rp)

        # Read scene/project-level params
        duration = scene.get("duration", 5)
        sound = scene.get("sound", "on")
        aspect_ratio = project.get("storyboard", {}).get("aspectRatio", "16:9")
        task_id = f"{args.scene_id}-{int(time.time())}"
        negative_prompt = args.negative_prompt  # still allow override from CLI

        progress(f"Composing prompt for {args.scene_id}: {len(composed_prompt)} chars, {len(ref_paths)} refs, {duration}s, sound={sound}")
        progress(f"Generating {args.scene_id} via Kling ({args.model}, task={task_id})...")

        try:
            out_path = kling.generate(
                prompt=composed_prompt,
                out_path=args.out,
                first_frame_path=args.first_frame,
                last_frame_path=args.last_frame,
                reference_image_paths=ref_paths or None,
                duration_seconds=duration,
                negative_prompt=negative_prompt,
                sound=sound,
                aspect_ratio=aspect_ratio,
                mode=args.mode,
                external_task_id=task_id,
                model=args.model,
            )
        except ConnectorError as e:
            progress(f"Failed {args.scene_id}: {e}")
            # Re-read project in case another scene wrote concurrently
            _, project = _find_project(args.project_id)
            _save_error_to_project(project_path, project, args.scene_id, str(e))
            fail("api_error", str(e))

        progress(f"Done {args.scene_id} -> {out_path}")

        # Re-read project to get latest state (other scenes may have written)
        _, project = _find_project(args.project_id)
        _save_clip_to_project(project_path, project, scene, out_path, composed_prompt, model=args.model)
        progress(f"Saved clip for {args.scene_id} to project tracks[0]")

        # Output the path (same contract as standalone mode)
        print(out_path)
        return

    # -----------------------------------------------------------------------
    # Standalone mode (original behavior)
    # -----------------------------------------------------------------------
    if args.project_id or args.scene_id:
        fail("invalid_args", "--project-id and --scene-id must be used together")

    # --- Validate flag combinations ---
    if args.multi_shot and not args.shot_type:
        fail("invalid_args", "--multi-shot requires --shot-type (customize|intelligence)")
    if args.shot_type and not args.multi_shot:
        fail("invalid_args", "--shot-type requires --multi-shot")
    if args.multi_prompt and not args.multi_shot:
        fail("invalid_args", "--multi-prompt requires --multi-shot")
    if args.multi_shot and args.shot_type == "customize" and not args.multi_prompt:
        fail("invalid_args", "--shot-type=customize requires --multi-prompt")
    if args.multi_shot and args.shot_type == "customize" and args.prompt:
        fail(
            "invalid_args",
            "--prompt is not supported with --shot-type=customize. In customize mode, "
            "per-shot prompts live in --multi-prompt entries.",
        )
    if args.multi_shot and args.shot_type == "intelligence" and not args.prompt:
        fail("invalid_args", "--shot-type=intelligence requires --prompt")
    if not args.multi_shot and not args.prompt:
        fail("invalid_args", "--prompt is required in standalone single-shot mode")
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
            model=args.model,
        )
    except ConnectorError as e:
        fail("api_error", str(e))

    print(out_path)


if __name__ == "__main__":
    main()
