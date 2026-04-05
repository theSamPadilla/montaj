#!/usr/bin/env python3
"""Initialize a montaj project workspace."""
import argparse, json, os, re, shutil, subprocess, sys, uuid
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail


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
    parser.add_argument("--workflow", default="basic_trim", help="Workflow name")
    parser.add_argument("--name", help="Project name (used as workspace directory suffix)")
    parser.add_argument("--profile", help="Creator profile name to associate with this project")
    parser.add_argument("--canvas", action="store_true", help="Canvas project — no source footage")
    args = parser.parse_args()

    if args.canvas and args.clips:
        fail("mutually_exclusive", "--canvas and --clips are mutually exclusive")

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
    detected_resolution = [1080, 1920]
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

    assets = [
        {"id": f"asset-{i}", "src": copy_into_workspace(os.path.abspath(a), "asset"), "type": "image", "name": os.path.basename(a)}
        for i, a in enumerate(args.assets)
    ]

    project = {
        "version": "0.2",
        "id": str(uuid.uuid4()),
        "status": "pending",
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

    project_path = os.path.join(workspace_dir, "project.json")
    with open(project_path, "w") as f:
        json.dump(project, f, indent=2)

    git(["add", "project.json"], cwd=workspace_dir)
    git(["commit", "-m", "init: new project"], cwd=workspace_dir)

    print(project_path)


if __name__ == "__main__":
    main()
