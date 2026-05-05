#!/usr/bin/env python3
"""Initialize a montaj project workspace."""
import argparse, json, os, re, shutil, subprocess, sys, threading, time, uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.common import SAFE_NAME, fail, get_duration, progress
from lib.remote_io import fetch_to_disk, parse_allowed_hosts
from lib.normalize import normalize, is_normalized, probe_video
from lib.types.project import normalize_project_type
from lib.types.kling import is_valid_aspect_ratio, ASPECT_RATIOS, ASPECT_RESOLUTIONS, DEFAULT_ASPECT_RATIO
from lib.types.colorspace import (
    ALL_COLOR_SPACES, DEFAULT_COLOR_SPACE, ColorSpaceKey,
    detect_from_transfer, normalize_key, smart_detect,
)
from lib.profile_assets import build_profile_snapshot
from lib.workflow import read_workflow


NORMALIZE_POOL_SIZE = 4  # outer pool — fast-path/skip workers don't acquire heavy_encode_sem
HEAVY_ENCODE_LIMIT = 2   # libx264 -preset slow at 4K is memory-heavy — precedent: materialize_cut.py:22


def _copy_into_workspace(src: str, dest_dir: str, prefix: str) -> str:
    """Copy *src* into *dest_dir*, avoiding name collisions with a numeric suffix.

    On collision the destination is renamed ``<base>_<prefix><N><ext>`` where N
    starts at 2 (matching the existing init.py / projects.py convention).
    Returns the absolute path of the copied file.

    This is the shared implementation used by both the ``create_project`` closure
    (via its thin wrapper) and external callers such as
    ``serve/routes/projects.py:include_profile_asset``.
    """
    name = os.path.basename(src)
    dest = os.path.join(dest_dir, name)
    if os.path.abspath(src) == os.path.abspath(dest):
        return dest  # already in workspace
    if os.path.exists(dest):
        base, ext = os.path.splitext(name)
        counter = 2
        while os.path.exists(os.path.join(dest_dir, f"{base}_{prefix}{counter}{ext}")):
            counter += 1
        dest = os.path.join(dest_dir, f"{base}_{prefix}{counter}{ext}")
    shutil.copy2(src, dest)
    return dest


def _read_project_type(workflow_name: str) -> str:
    """Read project_type from the workflow JSON, default 'editing' on any failure."""
    wf = read_workflow(workflow_name)
    return normalize_project_type(wf.get("project_type") if wf else None)


def validate_project_path(value: str) -> str:
    """Raise via fail() if value isn't a safe relative path under workspace.

    Rules: must be non-empty, must not start with '/', must not contain
    any '..' segment, every segment must match SAFE_NAME (the same regex
    used by serve/server.py for reserve-path validation), no empty segments.
    Returns the value unchanged on success.
    """
    if not value:
        fail("invalid_project_path", "--project-path must not be empty")
    if value.startswith("/"):
        fail("invalid_project_path", "--project-path must be relative (no leading '/')")
    parts = value.split("/")
    for seg in parts:
        if not seg:
            fail("invalid_project_path", f"--project-path has empty segment in {value!r}")
        if seg == "..":
            fail("invalid_project_path", "--project-path must not contain '..' segments")
        if not SAFE_NAME.match(seg):
            fail("invalid_project_path",
                 f"segment {seg!r} contains disallowed characters; "
                 "use [A-Za-z0-9_-]+ only")
    return value


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
    parser.add_argument(
        "--project-path",
        dest="project_path",
        default=None,
        help=(
            "Relative path (under the workspace root) where this project's "
            "directory should be created. Single segment (e.g. 'my-project') "
            "for flat layouts, multi-segment slash-separated (e.g. "
            "'teamA/my-project') for nested layouts. When omitted, the "
            "directory name is generated as '<date>-<slug>' from --name "
            "(or '<date>-<HHMMSS>' if --name is also absent)."
        ),
    )
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
    parser.add_argument(
        "--color-space",
        dest="color_space",
        choices=("auto",) + ALL_COLOR_SPACES,
        default="auto",
        help="Project working color space. 'auto' (default) picks the modal "
             "(most common) color space across all clips — outliers are converted "
             "on the fly. Tiebreaks: PQ wins HDR-only ties; SDR wins SDR-vs-HDR ties. "
             "Override to force a specific color space regardless of source.",
    )
    parser.add_argument('--music-upload', dest='music_upload', help='Path to uploaded music file')
    parser.add_argument('--music-describe', dest='music_describe', help='Prompt describing the music to generate')
    parser.add_argument('--voiceover-prompt', dest='voiceover_prompt', help='Voiceover script or brief')
    parser.add_argument("--remote-clip", dest="remote_clips", action="append", default=[],
                        help="JSON object: {url, destPath, contentType, sizeBytes, method?, headers?}. "
                             "Fetched into the project workspace before init proceeds. Repeatable.")
    parser.add_argument("--remote-asset", dest="remote_assets", action="append", default=[],
                        help="JSON object: {url, destPath, contentType, sizeBytes, method?, headers?}. "
                             "Fetched into the project workspace before init proceeds. Repeatable.")
    args = parser.parse_args()

    if args.canvas and args.clips:
        fail("mutually_exclusive", "--canvas and --clips are mutually exclusive")

    if args.canvas and args.remote_clips:
        fail("mutually_exclusive", "--canvas and --remote-clip are mutually exclusive")

    if args.aspect_ratio and not is_valid_aspect_ratio(args.aspect_ratio):
        fail("invalid_aspect_ratio",
             f"--aspect-ratio must be one of {', '.join(ASPECT_RATIOS)} (got {args.aspect_ratio!r})")

    if args.music_upload and args.music_describe:
        fail('invalid_args', 'Use either --music-upload or --music-describe, not both')

    if args.music_upload and not os.path.isfile(args.music_upload):
        fail('file_not_found', f'Music file not found: {args.music_upload}')

    # --- Parse + validate remote items BEFORE local file checks (spec order) ---
    # Tuple, not set: ordered iteration → deterministic error message, and aligns
    # with serve/routes/projects.py:_REMOTE_REQUIRED_KEYS so both surfaces walk the
    # same key order.
    _REQUIRED_REMOTE_KEYS = ("url", "destPath", "contentType", "sizeBytes")

    def _parse_remote_item(raw: str, kind: str) -> dict:
        """Parse and validate a JSON remote-item string. Calls fail() on errors."""
        try:
            item = json.loads(raw)
        except json.JSONDecodeError as exc:
            fail("invalid_remote_item",
                 f"--remote-{kind} value is not valid JSON: {exc} (got {raw!r})")
        for key in _REQUIRED_REMOTE_KEYS:
            if key not in item:
                fail("invalid_remote_item",
                     f"--remote-{kind} item missing required key: {key} (got {raw!r})")
        return item

    remote_clip_items = [_parse_remote_item(r, "clip") for r in args.remote_clips]
    remote_asset_items = [_parse_remote_item(r, "asset") for r in args.remote_assets]
    all_remote_items = remote_clip_items + remote_asset_items

    # Read allowlist — only required when there ARE remote items.
    allowed_hosts = parse_allowed_hosts()
    if all_remote_items and not allowed_hosts:
        fail("allowlist_unset",
             "MONTAJ_HTTP_ALLOWED_HOSTS is required for remote inputs")

    for clip in args.clips:
        if not os.path.isfile(clip):
            fail("file_not_found", f"Clip not found: {clip}")

    for asset in args.assets:
        if not os.path.isfile(asset):
            fail("file_not_found", f"Asset not found: {asset}")

    # Resolve workspace_root first — both branches below need it.
    # Precedence: MONTAJ_WORKSPACE_DIR env var > ~/.montaj/config.json's workspaceDir > ~/Montaj.
    config_path = os.path.join(os.path.expanduser("~"), ".montaj", "config.json")
    workspace_root = os.environ.get("MONTAJ_WORKSPACE_DIR") or os.path.join(os.path.expanduser("~"), "Montaj")
    if not os.environ.get("MONTAJ_WORKSPACE_DIR") and os.path.isfile(config_path):
        try:
            cfg = json.loads(open(config_path).read())
            if "workspaceDir" in cfg:
                workspace_root = cfg["workspaceDir"]
        except Exception:
            pass

    if args.project_path is not None:
        workspace_subpath = validate_project_path(args.project_path)
        full_dir = os.path.join(workspace_root, workspace_subpath)
        if os.path.exists(full_dir):
            fail("project_path_exists",
                 f"--project-path {workspace_subpath!r} already exists at {full_dir}")
        workspace_dir = full_dir
    else:
        # Existing date-slug generation (unchanged)
        date = datetime.now().strftime("%Y-%m-%d")
        if args.name:
            slug = re.sub(r"[^a-z0-9]+", "-", args.name.lower()).strip("-")
            base_name = f"{date}-{slug}"
        else:
            base_name = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        workspace_name = base_name
        counter = 2
        while os.path.exists(os.path.join(workspace_root, workspace_name)):
            workspace_name = f"{base_name}-{counter}"
            counter += 1
        workspace_dir = os.path.join(workspace_root, workspace_name)

    os.makedirs(workspace_dir)

    # --- Fetch remote items into workspace (all-or-nothing) ---
    if all_remote_items:
        fetch_results = fetch_to_disk(all_remote_items, Path(workspace_dir), allowed_hosts)
        for result in fetch_results:
            if result.get("status") == "error":
                # Clean up partially-created project dir before failing.
                shutil.rmtree(workspace_dir, ignore_errors=True)
                fail(result.get("error", "fetch_error"),
                     f"Remote fetch failed for {result.get('destPath', '?')}: "
                     f"{result.get('message', '')}")
        # Merge fetched clip paths into args.clips (so rest of flow treats them identically).
        for item in remote_clip_items:
            args.clips.append(os.path.join(workspace_dir, item["destPath"]))
        # Merge fetched asset paths into args.assets.
        for item in remote_asset_items:
            args.assets.append(os.path.join(workspace_dir, item["destPath"]))

    if not os.path.isdir(os.path.join(workspace_dir, ".git")):
        git(["init", workspace_dir], cwd=os.getcwd())

    def copy_into_workspace(src: str, prefix: str) -> str:
        """Thin wrapper around the module-level helper, bound to workspace_dir."""
        return _copy_into_workspace(src, workspace_dir, prefix)

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
    #
    # IMPORTANT: we feed DISPLAY dimensions (post-rotation) into the modal detector,
    # not stored sensor dimensions. iPhone vertical clips report stored=1920×1080
    # with rotation=-90 — players auto-rotate, so the visible frame is 1080×1920.
    # If we modal-detect on stored dims, an iPhone-vertical-dominant project gets
    # a landscape canvas and every clip ends up pillarboxed despite the content
    # being portrait. settings.resolution must reflect the OUTPUT MP4's display
    # orientation, not the on-disk pixel orientation.
    detected_pairs = []  # [(display_w, display_h, r_frame_rate)] in clip order
    if clips:
        for clip in clips:
            info = probe_video(clip["src"])
            if info is None:
                continue
            probe_cache[clip["src"]] = info
            w = info.get("display_width") or info.get("width")
            h = info.get("display_height") or info.get("height")
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

    # Smart-detect project color space from probed clips. Each clip's
    # `color_transfer` maps to a color space key; smart_detect picks the
    # MODAL (most common) color space — outliers get converted on the fly.
    detected_per_clip: list[ColorSpaceKey] = [
        detect_from_transfer(probe_cache[c["src"]].get("color_transfer"))
        for c in clips if c["src"] in probe_cache
    ]
    if args.color_space == "auto":
        project_color_space = smart_detect(detected_per_clip)
        # Surface the choice so the creator can see what happened. Especially
        # useful when there are outliers — they'll get converted on the fly.
        counts: dict[ColorSpaceKey, int] = {}
        for k in detected_per_clip:
            counts[k] = counts.get(k, 0) + 1
        if len(counts) > 1:
            total = sum(counts.values())
            chosen_count = counts.get(project_color_space, 0)
            outliers = total - chosen_count
            outlier_summary = ", ".join(
                f"{n} {k}" for k, n in sorted(counts.items()) if k != project_color_space
            )
            progress(
                f"detected colorSpace={project_color_space} "
                f"(modal: {chosen_count} of {total} clips). "
                f"{outliers} outlier(s) will be converted on the fly: {outlier_summary}. "
                f"Override with --color-space sdr_bt709|hdr_hlg|hdr_pq if needed."
            )
    else:
        project_color_space = normalize_key(args.color_space)

    # Limit concurrent heavy encodes (libx264 OR libx265 — both memory-heavy on 4K).
    # The semaphore is acquired by every transcode path; outer pool size 4 is fine
    # because clips that pass is_normalized() bypass the semaphore entirely.
    _heavy_encode_sem = threading.Semaphore(HEAVY_ENCODE_LIMIT)

    # Per-clip path classification stats (collected for the summary log at end).
    # Thread-safe append-only list; final summary read after pool join.
    _stats: list[dict] = []
    _stats_lock = threading.Lock()

    # Each thread mutates its OWN clip dict. There is no shared state between workers
    # (no shared lists/dicts, no shared file handles, no shared probe cache). If a
    # future change ever has multiple threads operating on the same clip dict or
    # the same source file, this needs reconsideration.
    def _normalize_one(clip):
        """Normalize a single clip in place. Mutates clip['src'] and clip['sourceDuration']."""
        clip_path = clip["src"]
        clip_id = clip["id"]
        t0 = time.monotonic()
        # Reuse the probe cached during smart-resolution detection above.
        # Falls back to a fresh probe for clips not in cache (e.g., probe failed earlier
        # or this code path is reached from a non-init caller).
        info = probe_cache.get(clip_path) or probe_video(clip_path)

        # 3-way classifier: skip / transcode / probe_failed.
        if info is None:
            path_kind = "probe_failed"
        elif is_normalized(clip_path, info, project_color_space):
            path_kind = "skip"
        else:
            path_kind = "transcode"

        progress(f"[{clip_id}] {path_kind} start "
                 f"({info['codec'] if info else '?'} "
                 f"{info.get('color_transfer', '?') if info else '?'} "
                 f"{info['pix_fmt'] if info else '?'} "
                 f"audio={info.get('audio_sample_rate') if info else '?'})")

        if path_kind == "transcode":
            normalized_path = clip_path.rsplit(".", 1)[0] + f"_normalized_{project_color_space}.mp4"
            try:
                sem_wait_t0 = time.monotonic()
                with _heavy_encode_sem:
                    sem_wait_elapsed = time.monotonic() - sem_wait_t0
                    if sem_wait_elapsed > 0.5:
                        progress(f"[{clip_id}] transcode waited {sem_wait_elapsed:.1f}s for encoder slot")
                    # Pass `info` through so normalize() doesn't re-probe — saves
                    # 2 redundant ffprobe calls per clip on heavy footage.
                    normalize(clip_path, normalized_path, project_color_space, info=info)
                clip["src"] = normalized_path
            except SystemExit:
                # normalize calls fail() which raises SystemExit — fall back to original
                progress(f"[{clip_id}] normalize FAILED, falling back to original src")

        # Cache source duration so the UI can clamp edits against it
        try:
            clip["sourceDuration"] = get_duration(clip["src"])
        except (Exception, SystemExit):
            pass

        elapsed = time.monotonic() - t0
        progress(f"[{clip_id}] {path_kind} done in {elapsed:.2f}s")
        with _stats_lock:
            _stats.append({"id": clip_id, "path": path_kind, "elapsed": elapsed})

    if clips:
        progress(f"normalize: starting {len(clips)} clips "
                 f"(pool={NORMALIZE_POOL_SIZE}, encoder_cap={HEAVY_ENCODE_LIMIT}, "
                 f"colorSpace={project_color_space})")
        _normalize_t0 = time.monotonic()
        with ThreadPoolExecutor(max_workers=NORMALIZE_POOL_SIZE) as pool:
            # list() forces evaluation + propagates exceptions (lazy iterator otherwise swallows them).
            list(pool.map(_normalize_one, clips))
        _normalize_total = time.monotonic() - _normalize_t0

        # Summary: counts by path, max/avg per-clip time, total wall time.
        # If parallelism is working, sum(per-clip)/wall ≈ effective concurrency.
        path_counts = Counter(s["path"] for s in _stats)
        per_clip_sum = sum(s["elapsed"] for s in _stats)
        per_clip_max = max((s["elapsed"] for s in _stats), default=0.0)
        speedup = per_clip_sum / _normalize_total if _normalize_total > 0 else 0
        progress(
            f"normalize: done in {_normalize_total:.2f}s wall — "
            f"{dict(path_counts)} | "
            f"per-clip max {per_clip_max:.2f}s, sum {per_clip_sum:.2f}s "
            f"(parallel speedup {speedup:.2f}x)"
        )

    assets = [
        {"id": f"asset-{i}", "src": copy_into_workspace(os.path.abspath(a), "asset"), "type": "image", "name": os.path.basename(a)}
        for i, a in enumerate(args.assets)
    ]

    project_type = _read_project_type(args.workflow)

    # Snapshot of the profile's asset manifest + style-profile pointer for
    # the agent. Returns None when --profile is absent. See build_profile_snapshot
    # in lib/profile_assets.py for the full shape and rationale.
    profile_snapshot = build_profile_snapshot(args.profile)

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
            "fps": detected_fps,
            "colorSpace": project_color_space,
        },
        "tracks": [[] if args.canvas else clips],
        "assets": assets,
        "audio": {},
        **({"profile": args.profile} if args.profile else {}),
        **({"profileSnapshot": profile_snapshot} if profile_snapshot else {}),
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
