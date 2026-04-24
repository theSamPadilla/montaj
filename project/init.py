#!/usr/bin/env python3
"""Initialize a montaj project workspace."""
import argparse, json, os, re, shutil, subprocess, sys, uuid
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.common import fail, get_duration
from lib.normalize import normalize, is_normalized, probe_video
from lib.types.project import normalize_project_type
from lib.types.kling import is_valid_aspect_ratio, ASPECT_RATIOS, ASPECT_RESOLUTIONS, DEFAULT_ASPECT_RATIO
from lib.workflow import read_workflow


def _read_project_type(workflow_name: str) -> str:
    """Read project_type from the workflow JSON, default 'editing' on any failure."""
    wf = read_workflow(workflow_name)
    return normalize_project_type(wf.get("project_type") if wf else None)


def git(args, cwd):
    result = subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True,
        env={**os.environ,
             "GIT_AUTHOR_NAME": "montaj", "GIT_AUTHOR_EMAIL": "montaj@local",
             "GIT_COMMITTER_NAME": "montaj", "GIT_COMMITTER_EMAIL": "montaj@local"}
    )
    if result.returncode != 0:
        fail("git_error", result.stderr.strip())
    return result


def main():
    parser = argparse.ArgumentParser(description="Initialize a montaj project workspace")
    parser.add_argument("--clips", nargs="*", default=[], help="Input clip paths")
    parser.add_argument("--assets", nargs="*", default=[], help="Asset file paths (images, logos, etc.)")
    parser.add_argument("--prompt", required=True, help="Editing prompt")
    parser.add_argument("--workflow", default="clean_cut", help="Workflow name")
    parser.add_argument("--name", help="Project name (used as workspace directory suffix)")
    parser.add_argument("--profile", help="Creator profile name to associate with this project")
    parser.add_argument("--canvas", action="store_true", help="Canvas project — no source footage")
    parser.add_argument("--image-ref", dest="image_refs", action="append", default=[],
                        help="ai_video only. JSON objects: {label, path|text}")
    parser.add_argument("--style-ref", dest="style_refs", action="append", default=[],
                        help="ai_video only. JSON objects: {label, path}")
    parser.add_argument("--aspect-ratio", dest="aspect_ratio", default=None,
                        help="ai_video only. Kling aspect_ratio parameter (e.g. '16:9', '9:16', '1:1').")
    parser.add_argument("--target-duration", dest="target_duration", type=int, default=None,
                        help="ai_video only. Target total duration in seconds (editorial goal, not a per-scene value).")
    parser.add_argument('--music-upload', dest='music_upload', help='Path to uploaded music file')
    parser.add_argument('--music-describe', dest='music_describe', help='Prompt describing the music to generate')
    parser.add_argument('--voiceover-prompt', dest='voiceover_prompt', help='Voiceover script or brief')
    args = parser.parse_args()

    if args.canvas and args.clips:
        fail("mutually_exclusive", "--canvas and --clips are mutually exclusive")

    if args.aspect_ratio and not is_valid_aspect_ratio(args.aspect_ratio):
        fail("invalid_aspect_ratio",
             f"--aspect-ratio must be one of {', '.join(ASPECT_RATIOS)} (got {args.aspect_ratio!r})")

    if args.music_upload and args.music_describe:
        fail('invalid_args', 'Use either --music-upload or --music-describe, not both')

    if args.music_upload and not os.path.isfile(args.music_upload):
        fail('file_not_found', f'Music file not found: {args.music_upload}')

    for clip in args.clips:
        if not os.path.isfile(clip):
            fail("file_not_found", f"Clip not found: {clip}")

    for asset in args.assets:
        if not os.path.isfile(asset):
            fail("file_not_found", f"Asset not found: {asset}")

    date = datetime.now().strftime("%Y-%m-%d")
    if args.name:
        slug = re.sub(r"[^a-z0-9]+", "-", args.name.lower()).strip("-")
        base_name = f"{date}-{slug}"
    else:
        base_name = datetime.now().strftime("%Y-%m-%d-%H%M%S")

    # Avoid collisions: append -2, -3, ... if the directory already exists
    workspace_name = base_name
    config_path = os.path.join(os.path.expanduser("~"), ".montaj", "config.json")
    workspace_root = os.environ.get("MONTAJ_WORKSPACE_DIR") or os.path.join(os.path.expanduser("~"), "Montaj")
    if not os.environ.get("MONTAJ_WORKSPACE_DIR") and os.path.isfile(config_path):
        try:
            cfg = json.loads(open(config_path).read())
            if "workspaceDir" in cfg:
                workspace_root = cfg["workspaceDir"]
        except Exception:
            pass
    counter = 2
    while os.path.exists(os.path.join(workspace_root, workspace_name)):
        workspace_name = f"{base_name}-{counter}"
        counter += 1

    workspace_dir = os.path.join(workspace_root, workspace_name)
    os.makedirs(workspace_dir)

    if not os.path.isdir(os.path.join(workspace_dir, ".git")):
        git(["init", workspace_dir], cwd=os.getcwd())

    def copy_into_workspace(src: str, prefix: str) -> str:
        """Copy src into workspace_dir, avoiding name collisions with a numeric suffix."""
        name = os.path.basename(src)
        dest = os.path.join(workspace_dir, name)
        if os.path.abspath(src) == os.path.abspath(dest):
            return dest  # already in workspace
        if os.path.exists(dest):
            base, ext = os.path.splitext(name)
            counter = 2
            while os.path.exists(os.path.join(workspace_dir, f"{base}_{prefix}{counter}{ext}")):
                counter += 1
            dest = os.path.join(workspace_dir, f"{base}_{prefix}{counter}{ext}")
        shutil.copy2(src, dest)
        return dest

    clips = [
        # start/end are placeholder 0.0 values — the agent sets real values
        # after running probe. Zero-duration is technically valid under the
        # validator (which only requires the fields exist, not that end > start).
        {"id": f"clip-{i}", "type": "video", "src": copy_into_workspace(os.path.abspath(clip), "clip"),
         "start": 0.0, "end": 0.0}
        for i, clip in enumerate(args.clips)
    ]

    # Detect resolution and fps from the first clip so settings always reflect
    # the actual source footage — prevents overlay misalignment at render time.
    # For ai_video with no clips, derive from the requested aspect ratio.
    ar = args.aspect_ratio or DEFAULT_ASPECT_RATIO
    detected_resolution = list(ASPECT_RESOLUTIONS.get(ar, ASPECT_RESOLUTIONS[DEFAULT_ASPECT_RATIO]))
    detected_fps = 30
    if clips:
        try:
            probe = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", clips[0]["src"]],
                capture_output=True, text=True, timeout=30
            )
            if probe.returncode == 0:
                streams = json.loads(probe.stdout).get("streams", [])
                video = next((s for s in streams if s.get("codec_type") == "video"), None)
                if video:
                    w, h = video.get("width"), video.get("height")
                    if w and h:
                        detected_resolution = [w, h]
                    fps_str = video.get("r_frame_rate", "")
                    if "/" in fps_str:
                        num, den = fps_str.split("/")
                        if int(den) > 0:
                            detected_fps = round(int(num) / int(den))
        except Exception:
            pass

    # Normalize clips to the project working format (H.264, target res/fps, etc.)
    for clip in clips:
        clip_path = clip["src"]
        info = probe_video(clip_path)
        if info and not is_normalized(clip_path, info, detected_resolution[0], detected_resolution[1]):
            normalized_path = clip_path.rsplit(".", 1)[0] + "_normalized.mp4"
            try:
                normalize(clip_path, normalized_path, detected_resolution[0], detected_resolution[1], crf=16)
                clip["src"] = normalized_path
            except SystemExit:
                # normalize calls fail() which raises SystemExit — fall back to original
                print(f"Warning: normalize failed for {clip_path}, using original", file=sys.stderr)

        # Cache source duration so the UI can clamp edits against it
        try:
            clip["sourceDuration"] = get_duration(clip["src"])
        except Exception:
            pass

    assets = [
        {"id": f"asset-{i}", "src": copy_into_workspace(os.path.abspath(a), "asset"), "type": "image", "name": os.path.basename(a)}
        for i, a in enumerate(args.assets)
    ]

    project_type = _read_project_type(args.workflow)

    project = {
        "version": "0.2",
        "id": str(uuid.uuid4()),
        "status": "pending",
        "projectType": project_type,
        "name": args.name or None,
        "workflow": args.workflow,
        "editingPrompt": args.prompt,
        "runCount": 1,
        "sources": clips,
        "settings": {
            "resolution": detected_resolution,
            "fps": detected_fps
        },
        "tracks": [[] if args.canvas else clips],
        "assets": assets,
        "audio": {},
        **({"profile": args.profile} if args.profile else {})
    }

    if project_type == "ai_video":
        image_refs_stub = []
        for i, raw in enumerate(args.image_refs):
            entry = json.loads(raw)
            label = entry.get("label", f"ref{i+1}")
            src_path = entry.get("path")
            text = entry.get("text")
            if src_path and not os.path.isfile(src_path):
                fail("file_not_found", f"Image ref not found: {src_path}")
            copied = copy_into_workspace(os.path.abspath(src_path), "imageref") if src_path else None
            ref = {
                "id": f"ref{i+1}",
                "label": label,
                "refImages": [copied] if copied else [],
                "source": "upload" if src_path else "text",
                "status": "pending",
            }
            if text:
                ref["anchor"] = text
            image_refs_stub.append(ref)

        style_refs_stub = []
        for i, raw in enumerate(args.style_refs):
            entry = json.loads(raw)
            src_path = entry["path"]
            if not os.path.isfile(src_path):
                fail("file_not_found", f"Style ref not found: {src_path}")
            copied = copy_into_workspace(os.path.abspath(src_path), "styleref")
            ext = os.path.splitext(copied)[1].lower()
            kind = "video" if ext in (".mp4", ".mov", ".webm", ".mkv") else \
                   "audio" if ext in (".mp3", ".wav", ".m4a", ".aac", ".flac") else \
                   "image"
            style_refs_stub.append({
                "id": f"style{i+1}",
                "kind": kind,
                "path": copied,
                "label": entry.get("label", f"style ref {i+1}"),
            })

        storyboard = {
            "imageRefs": image_refs_stub,
            "styleRefs": style_refs_stub,
            "scenes": [],  # agent populates during `pending`; empty at intake
        }
        if args.aspect_ratio:
            storyboard["aspectRatio"] = args.aspect_ratio
        if args.target_duration is not None:
            storyboard["targetDurationSeconds"] = args.target_duration

        if args.music_upload:
            storyboard['music'] = {'mode': 'upload', 'path': copy_into_workspace(os.path.abspath(args.music_upload), 'music')}
        elif args.music_describe:
            storyboard['music'] = {'mode': 'describe', 'prompt': args.music_describe}

        if args.voiceover_prompt:
            storyboard['voiceover'] = {'prompt': args.voiceover_prompt}

        project["storyboard"] = storyboard

    project_path = os.path.join(workspace_dir, "project.json")
    with open(project_path, "w") as f:
        json.dump(project, f, indent=2)

    git(["add", "project.json"], cwd=workspace_dir)
    git(["commit", "-m", "init: new project"], cwd=workspace_dir)

    print(project_path)


if __name__ == "__main__":
    main()
