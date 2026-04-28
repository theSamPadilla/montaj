#!/usr/bin/env python3
"""Initialize a montaj project workspace."""
import argparse, json, os, re, shutil, subprocess, sys, threading, uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.common import fail, get_duration
from lib.normalize import normalize, is_normalized, probe_video, _can_use_audio_fast_path
from lib.types.project import normalize_project_type
from lib.types.kling import is_valid_aspect_ratio, ASPECT_RATIOS, ASPECT_RESOLUTIONS, DEFAULT_ASPECT_RATIO
from lib.workflow import read_workflow


NORMALIZE_POOL_SIZE = 4  # outer pool — fast-path/skip workers don't acquire heavy_encode_sem
HEAVY_ENCODE_LIMIT = 2   # libx264 -preset slow at 4K is memory-heavy — precedent: materialize_cut.py:22


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
    parser.add_argument("--resolution", default=None,
                        help="Project output resolution as WxH (e.g. '3840x2160'). "
                             "Overrides the auto-detected default.")
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

    # Project resolution = output canvas size (final MP4 dimensions, Puppeteer overlay
    # design dims). Source clips are NOT scaled to match this — they remain at native
    # resolution and the segment encoder scales per-item at compose time.
    ar = args.aspect_ratio or DEFAULT_ASPECT_RATIO
    default_resolution = list(ASPECT_RESOLUTIONS.get(ar, ASPECT_RESOLUTIONS[DEFAULT_ASPECT_RATIO]))
    detected_resolution = default_resolution
    detected_fps = 30

    # Cache probe results so _normalize_one below doesn't re-ffprobe each clip.
    # Keyed by absolute source path. Populated below for non-canvas projects.
    probe_cache: dict[str, dict] = {}

    # Single probe pass — populates probe_cache (consumed by _normalize_one below),
    # collects (w, h, r_frame_rate) tuples for resolution + fps detection. This loop
    # runs unconditionally when clips are present; the override path (--resolution)
    # ignores the (w, h) data but still benefits from the cache + fps detection.
    detected_pairs = []  # [(w, h, r_frame_rate)] in clip order, successfully-probed clips only
    if clips:
        for clip in clips:
            info = probe_video(clip["src"])
            if info is None:
                continue
            probe_cache[clip["src"]] = info
            w, h = info.get("width"), info.get("height")
            if w and h:
                detected_pairs.append((w, h, info.get("r_frame_rate", "")))

    if args.resolution:
        # Explicit override (creator intent: "I want 4K output regardless of source")
        try:
            w_str, h_str = args.resolution.lower().split("x", 1)
            detected_resolution = [int(w_str), int(h_str)]
        except (ValueError, AttributeError):
            fail("invalid_resolution", f"--resolution must be WxH (got {args.resolution!r})")
    elif detected_pairs:
        # Modal resolution; tiebreak: first-appearance among tied modes (deterministic,
        # generalizes the prior "first clip wins" behavior, respects user-passed
        # --clips order as intent). Override via --resolution.
        counts = Counter((w, h) for w, h, _ in detected_pairs)
        max_count = max(counts.values())
        # First-appearance tiebreak: pick the first (w,h) in clip order whose count == max_count
        for w, h, _ in detected_pairs:
            if counts[(w, h)] == max_count:
                detected_resolution = [w, h]
                break
    # else: no clips OR no clips probed successfully → keep default_resolution.

    # fps from first successfully-probed clip (independent of resolution-detection branch).
    if detected_pairs:
        fps_str = detected_pairs[0][2]
        if "/" in fps_str:
            num, den = fps_str.split("/")
            if int(den) > 0:
                detected_fps = round(int(num) / int(den))

    # Limit concurrent libx264 -preset slow encodes. Fast-path workers (-c:v copy +
    # audio re-encode) bypass this — they're I/O-bound and don't strain memory.
    #
    # Race acknowledged: if a fast-path attempt fails inside lib.normalize and
    # falls through to the full re-encode (rare — typically <1s container errors),
    # that re-encode runs WITHOUT the lock. Briefly exceeding HEAVY_ENCODE_LIMIT
    # by 1-2 jobs in this case is acceptable and self-corrects within seconds.
    _heavy_encode_sem = threading.Semaphore(HEAVY_ENCODE_LIMIT)

    # Each thread mutates its OWN clip dict. There is no shared state between workers
    # (no shared lists/dicts, no shared file handles, no shared probe cache). If a
    # future change ever has multiple threads operating on the same clip dict or
    # the same source file, this needs reconsideration.
    def _normalize_one(clip):
        """Normalize a single clip in place. Mutates clip['src'] and clip['sourceDuration']."""
        clip_path = clip["src"]
        # Reuse the probe cached during smart-resolution detection above.
        # Falls back to a fresh probe for clips not in cache (e.g., probe failed earlier
        # or this code path is reached from a non-init caller).
        info = probe_cache.get(clip_path) or probe_video(clip_path)
        if info and not is_normalized(clip_path, info, detected_resolution[0], detected_resolution[1]):
            normalized_path = clip_path.rsplit(".", 1)[0] + "_normalized.mp4"
            # Path classification: fast-path workers run uncapped (in the outer pool of 4);
            # full-encode workers acquire the heavy-encode semaphore (cap=2).
            will_use_fast_path = _can_use_audio_fast_path(info)
            try:
                # Pass `info` through so normalize() doesn't re-probe — saves
                # 2 redundant ffprobe calls per clip on heavy footage.
                if will_use_fast_path:
                    normalize(clip_path, normalized_path, detected_resolution[0], detected_resolution[1], crf=16, info=info)
                else:
                    with _heavy_encode_sem:
                        normalize(clip_path, normalized_path, detected_resolution[0], detected_resolution[1], crf=16, info=info)
                clip["src"] = normalized_path
            except SystemExit:
                # normalize calls fail() which raises SystemExit — fall back to original
                print(f"Warning: normalize failed for {clip_path}, using original", file=sys.stderr)
        # Cache source duration so the UI can clamp edits against it
        try:
            clip["sourceDuration"] = get_duration(clip["src"])
        except (Exception, SystemExit):
            pass

    if clips:
        with ThreadPoolExecutor(max_workers=NORMALIZE_POOL_SIZE) as pool:
            # list() forces evaluation + propagates exceptions (lazy iterator otherwise swallows them).
            list(pool.map(_normalize_one, clips))

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
