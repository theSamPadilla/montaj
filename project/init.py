#!/usr/bin/env python3
"""Initialize a montaj project workspace."""
import argparse, json, os, re, shutil, subprocess, sys, threading, time, uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.common import SAFE_NAME, fail, ffprobe_bin, progress
from lib.remote_io import fetch_to_disk, parse_allowed_hosts
from lib.normalize import normalize, normalized_output_path, is_normalized, probe_video
from lib.proxy import is_proxy_fresh, make_proxy, proxy_path_for
from lib.types.project import normalize_project_type
from lib.types.kling import is_valid_aspect_ratio, ASPECT_RATIOS, ASPECT_RESOLUTIONS, DEFAULT_ASPECT_RATIO
from lib.types.carousel import CAROUSEL_ASPECTS, CAROUSEL_RESOLUTIONS, DEFAULT_CAROUSEL_ASPECT
from lib.types.colorspace import (
    ALL_COLOR_SPACES, DEFAULT_COLOR_SPACE, ColorSpaceKey,
    detect_from_transfer, is_hdr, normalize_key, smart_detect,
)
from lib.profile_assets import build_profile_snapshot
from lib.voiceover import concat_takes
from lib.workflow import read_workflow


NORMALIZE_POOL_SIZE = 4  # outer pool — fast-path/skip workers don't acquire heavy_encode_sem
HEAVY_ENCODE_LIMIT = 2   # libx264 -preset slow at 4K is memory-heavy — precedent: materialize_cut.py:22
# Proxy encodes are their own pool, separate from libx264/265 masters so proxies
# never queue behind normalize. Sized by measurement, not taste — both numbers are
# recorded so this doesn't get re-litigated from intuition: with AV1 proxies, 2
# concurrent encodes already drew 976% CPU of the 1200% available, so 2 was the
# correct cap. H.264 proxies are far cheaper — the same 2-wide pool reaches only
# 535% — and widening to 4 took a 14-clip folder from 2:02 to 1:19.
PROXY_ENCODE_LIMIT = 4
# Inline-proxy TOTAL-footage budget (SP3 fix B1). init runs inside serve's
# project-creation subprocess with a hard 1800s budget (serve/routes/projects.py).
# The gate is the whole import, not any one source: N individually-short clips each
# pass a per-clip gate and then all encode inline, and that batch is the wait the
# creator actually feels. At the measured ~0.19s of wall per second of footage
# (78.8s for 415s at concurrency 4), a 300s budget caps inline proxy work at roughly
# a minute — a tolerable wait behind a loading modal. An import over budget defers
# every proxy to the POST /api/proxy backfill job instead of blocking (and 504ing)
# project creation. Override per-run with --proxy-inline-max; disable proxies
# entirely with --no-proxy or a workflow's "proxy": false.
PROXY_INLINE_MAX_TOTAL_SEC = 300.0


def _probe_duration(path: str) -> float | None:
    """Source duration in seconds, or None when the file can't be read.

    Deliberately NOT lib.common.get_duration: that routes through run(check=True),
    which fail()s on an unreadable file — printing an {"error": ...} JSON line to
    stderr before raising SystemExit. Every duration read in init is best-effort
    (a clip whose duration is unknown just doesn't get a sourceDuration and
    doesn't count toward the proxy budget), and init must not leave a stray error
    object on stderr for a failure it went on to ignore — serve parses stderr for
    {"error": ...} when init exits non-zero.

    Retries once, with a much longer timeout, but ONLY on a timeout — a
    TimeoutExpired is plausibly transient (a cold 4K MOV on a network volume or
    an external spinning disk can genuinely blow past 60s on the header read),
    so it's worth a second, more patient attempt. A clean non-zero exit or
    unparseable stdout is a deterministic failure (corrupt file, not a video,
    ffprobe missing, ...) — retrying it would just wait out the same failure
    twice, so those return None on the first attempt without retrying.
    """
    def _attempt(timeout: int) -> float | None:
        r = subprocess.run(
            [ffprobe_bin(), "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=timeout,
        )
        return float(r.stdout.strip()) if r.returncode == 0 else None

    try:
        # 60, not the 10 this first shipped with: it replaced get_duration,
        # whose run() default is 300, and a cold 4K MOV on a network volume
        # or an external spinning disk can genuinely exceed 10s on the
        # header read. Timing out here is not free — it silently drops
        # sourceDuration AND removes the clip from the inline-proxy budget.
        return _attempt(60)
    except subprocess.TimeoutExpired:
        pass
    except (Exception, SystemExit):
        return None
    try:
        # Second, more patient attempt — 180s — after the first attempt
        # specifically timed out (not any other failure).
        return _attempt(180)
    except (Exception, SystemExit):
        return None


def _copy_into_workspace(src: str, dest_dir: str, prefix: str, link: bool = False) -> str:
    """Copy (or symlink) *src* into *dest_dir*, avoiding name collisions with a numeric suffix.

    On collision the destination is renamed ``<base>_<prefix><N><ext>`` where N
    starts at 2 (matching the existing init.py / projects.py convention).
    Returns the absolute path of the copied/linked file.

    When *link* is True, an absolute symlink is created instead of a copy so
    that the staged file survives cwd changes.

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
    if link:
        os.symlink(os.path.abspath(src), dest)
    else:
        shutil.copy2(src, dest)
    return dest


def _cleanup_staged_uploads(staged: set) -> None:
    """Best-effort removal of staged browser uploads consumed by this init.

    Files dropped into the workspace-level ``_uploads/`` junk drawer (by the
    ``POST /upload`` endpoint, or by the delete-with-``preserve_assets``
    eviction flow) are *copied* into the project dir by
    ``copy_into_workspace`` — after a successful init the staged original is
    dead weight that nothing references and nothing ever garbage-collects.
    Remove each consumed source here. Failures are non-fatal: a locked or
    already-missing file must never fail a project that was just created.
    """
    for path in staged:
        try:
            os.unlink(path)
            progress(f"init: removed consumed upload {path}")
        except OSError:
            pass


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


def _validate_carousel_args(args) -> None:
    """Reject flags that are incompatible with carousel projects. Exits on first violation."""
    def _reject_if(condition: bool, flag: str) -> None:
        if condition:
            fail("invalid_args", f"{flag} not allowed for carousel projects")

    _reject_if(bool(args.clips),              "--clips")
    _reject_if(bool(args.canvas),             "--canvas")
    _reject_if(bool(args.music_upload),       "--music-upload")
    _reject_if(bool(args.music_describe),     "--music-describe")
    _reject_if(bool(args.voiceover_prompt),   "--voiceover-prompt")
    _reject_if(bool(args.image_refs),         "--image-ref")
    _reject_if(bool(args.style_refs),         "--style-ref")
    _reject_if(args.target_duration is not None, "--target-duration")
    _reject_if(bool(args.aspect_ratio),       "--aspect-ratio")
    _reject_if(bool(args.resolution),         "--resolution")
    _reject_if(bool(args.remote_clips),       "--remote-clip")
    _reject_if(bool(args.remote_assets),      "--remote-asset")
    _reject_if(args.color_space != "auto",    "--color-space")


def _build_carousel_project(args, workspace_dir: str, assets: list) -> None:
    """Build, write, and commit a carousel project.json. Prints the project path on success."""
    aspect = args.carousel_aspect or DEFAULT_CAROUSEL_ASPECT
    resolution = list(CAROUSEL_RESOLUTIONS[aspect])

    project = {
        "version": "0.2",
        "id": args.project_id or str(uuid.uuid4()),
        "status": "pending",
        "projectType": "carousel",
        "name": args.name or None,
        "workflow": args.workflow,
        "editingPrompt": args.prompt or "",
        "runCount": 1,
        "settings": {
            "resolution": resolution,
            "colorSpace": "sdr_bt709",
        },
        "carousel": {"aspect": aspect},
        "slides": [],
        "assets": assets,
        **({"profile": args.profile} if args.profile else {}),
    }

    project_path = os.path.join(workspace_dir, "project.json")
    with open(project_path, "w") as f:
        json.dump(project, f, indent=2)

    git(["add", "project.json"], cwd=workspace_dir)
    git(["commit", "-m", "init: new project"], cwd=workspace_dir)

    print(project_path)


def main():
    parser = argparse.ArgumentParser(description="Initialize a montaj project workspace")
    parser.add_argument("--clips", nargs="*", default=[], help="Input clip paths")
    parser.add_argument("--assets", nargs="*", default=[], help="Asset file paths (images, logos, etc.)")
    parser.add_argument("--voiceover-asset", nargs="+", dest="voiceover_asset",
                        help="Audio or video file(s) supplying the voiceover. "
                             "For broll projects only. Only its audio is used. "
                             "Pass several, in order, when narration was recorded "
                             "as one take per script section — they are concatenated.")
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
    parser.add_argument("--carousel-aspect", dest="carousel_aspect", default=None,
                        choices=list(CAROUSEL_ASPECTS),
                        help="carousel only. Aspect ratio for all slides (square, portrait, vertical).")
    parser.add_argument("--id", dest="project_id", default=None,
                        help="Optional project id. If supplied, used as project.json['id'] verbatim. "
                             "Must be a canonical UUID string (8-4-4-4-12 hex). When absent, a fresh "
                             "UUID is generated server-side.")
    parser.add_argument("--symlink-clips", action="store_true",
                        help="Stage clips as symlinks instead of copies — the standard path for clips-workflow fan-out so a multi-GB source is not copied per child project.")
    parser.add_argument("--derived-from", dest="derived_from", default=None,
                        help="Source project or asset id that this project was derived from "
                             "(e.g. a source-clip project id in the clips workflow).")
    parser.add_argument(
        "--normalize",
        choices=("eager", "lazy"),
        default=None,
        help="Normalize mode. 'eager' (default) transcodes non-conformant clips at init time. "
             "'lazy' skips all transcoding — clips are left as-is and normalized on demand at "
             "compose time. Overrides the workflow's normalize setting when provided.",
    )
    parser.add_argument(
        "--no-proxy", dest="no_proxy", action="store_true",
        help="Skip editing-proxy generation entirely (SP3). The editor falls back to "
             "playing masters; proxies can be backfilled later via POST /api/proxy or "
             "`montaj step proxy`. Also settable per-workflow with \"proxy\": false.",
    )
    parser.add_argument(
        "--proxy-inline-max", dest="proxy_inline_max", type=float, default=None,
        help=f"Inline-proxy budget in seconds of TOTAL footage, summed across every source "
             f"in the import; an import over budget defers all of its proxies to the "
             f"background backfill job so project creation never blocks on a long encode. "
             f"Default {PROXY_INLINE_MAX_TOTAL_SEC:.0f}.",
    )
    parser.add_argument(
        "--language", default="en",
        help="Spoken language of the footage as a whisper code (e.g. 'es', 'pt', 'fr'), or "
             "'auto' to detect. Stored in settings.language and passed to the speech steps "
             "(transcribe, rm_nonspeech, rm_fillers); non-English values auto-select a "
             "multilingual whisper model. Default 'en'.",
    )
    args = parser.parse_args()

    # Normalize mode: CLI flag overrides workflow JSON; workflow JSON overrides default "eager".
    _workflow_json = read_workflow(args.workflow) or {}
    normalize_mode = args.normalize or _workflow_json.get("normalize", "eager")

    # Proxy policy (SP3 fix B1): --no-proxy beats the workflow's "proxy" setting,
    # which beats the default (enabled). The inline total-footage budget follows the
    # same CLI-over-default rule.
    proxy_enabled = (not args.no_proxy) and _workflow_json.get("proxy", True) is not False
    proxy_inline_max_total = (
        args.proxy_inline_max if args.proxy_inline_max is not None else PROXY_INLINE_MAX_TOTAL_SEC
    )

    # Early carousel detection — validate incompatible args BEFORE any on-disk side effects.
    early_project_type = _read_project_type(args.workflow)
    if early_project_type == "carousel":
        _validate_carousel_args(args)

    # Parse --id BEFORE any on-disk side effects and canonicalize. uuid.UUID()
    # raises ValueError on truly malformed input (wrong length, non-hex, empty,
    # non-string). It also accepts non-canonical forms (hex32, braced,
    # urn:uuid:..., uppercase) — for those, str(uuid.UUID(raw)) returns the
    # canonical lowercase 8-4-4-4-12 form, which is what we store. This makes
    # find_project_dir's string-equality match safe against callers who pass
    # logically-equal-but-textually-different ids.
    if args.project_id is not None:
        try:
            args.project_id = str(uuid.UUID(args.project_id))
        except (ValueError, AttributeError):
            fail("invalid_id",
                 f"--id must be a parseable UUID (got {args.project_id!r})")

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

    # Voiceover is required by (and exclusive to) broll projects. Checked here,
    # before makedirs below, so a rejected init leaves no partial workspace.
    if args.voiceover_asset and early_project_type != "broll":
        fail("invalid_argument",
             "--voiceover-asset is only valid for broll workflows")
    if early_project_type == "broll" and not args.voiceover_asset:
        fail("missing_argument",
             "broll projects require --voiceover-asset")
    for _vo in (args.voiceover_asset or []):
        if not os.path.isfile(_vo):
            fail("file_not_found", f"File not found: {_vo}")

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

    # Staged-upload tracking: sources consumed out of the workspace-level
    # _uploads/ junk drawer are recorded here and deleted after a successful
    # init (see _cleanup_staged_uploads). Deleting only at the end keeps a
    # mid-init failure from destroying the user's staged files.
    uploads_dir = os.path.realpath(os.path.join(workspace_root, "_uploads"))
    staged_uploads: set = set()

    def copy_into_workspace(src: str, prefix: str, link: bool = False) -> str:
        """Thin wrapper around the module-level helper, bound to workspace_dir."""
        dest = _copy_into_workspace(src, workspace_dir, prefix, link=link)
        # Track for post-init cleanup: real copies only (a symlink still
        # points at the source), and only files sitting directly inside the
        # workspace-level _uploads/ junk drawer.
        if not link:
            src_real = os.path.realpath(src)
            if os.path.dirname(src_real) == uploads_dir and os.path.isfile(src_real):
                staged_uploads.add(src_real)
        return dest

    clips = [
        # start/end are placeholder 0.0 values — the agent sets real values
        # after running probe. Zero-duration is technically valid under the
        # validator (which only requires the fields exist, not that end > start).
        {"id": f"clip-{i}", "type": "video",
         "src": copy_into_workspace(os.path.abspath(clip), "clip", link=args.symlink_clips),
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
    # Source durations, keyed by the ORIGINAL staged path. Filled in the same
    # single pass as probe_cache — probe_video's ffprobe asks for stream entries
    # only, so duration needs its own `format=duration` read, and the
    # total-footage proxy budget has to be known BEFORE the normalize pool starts.
    # This is the ONE duration read per clip: _normalize_one reads sourceDuration
    # out of here (both arms) rather than probing again, so the per-clip ffprobe
    # budget is unchanged — it moved, it didn't grow.
    duration_cache: dict[str, float] = {}

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
            _duration = _probe_duration(clip["src"])
            if _duration is not None:
                duration_cache[clip["src"]] = _duration
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

    # Whether this import's proxies are encoded inline or deferred wholesale to
    # the backfill job — decided ONCE, here, before the pool starts, from the
    # durations collected in the single probe pass above. The gate is the total
    # footage rather than any one clip: fourteen individually-short sources each
    # clear a per-clip gate and then all encode inline, which is exactly the wait
    # this is meant to bound. Already-encoded proxies are still adopted below
    # regardless — deferral only suppresses new encodes.
    total_source_duration = sum(duration_cache.values())
    defer_proxies = total_source_duration > proxy_inline_max_total
    # A clip contributes 0 to the total when its duration could not be read, so
    # a partial probe failure understates the budget. That only MATTERS for a
    # clip that goes on to be proxied anyway, and the two reads are independent
    # ffprobe calls: a raw elementary stream (and some fragmented MP4s) reports
    # `format=duration` as N/A while probing its streams perfectly, so it clears
    # the `info is not None` gate below and encodes inline at unknown cost.
    #
    # So fail closed on exactly that set, and no wider. Deferring whenever ANY
    # probe failed was tried and reverted: a clip that fails BOTH reads is never
    # proxied at all, and treating it as unknown cost makes one corrupt file
    # suppress inline proxies for every healthy clip beside it — which is what
    # `test_init_continues_when_one_clip_fails` exists to prevent, and it fires
    # on tiny imports nowhere near the budget.
    unknown_cost = [src for src in probe_cache if src not in duration_cache]
    if unknown_cost:
        defer_proxies = True
        progress(f"proxy deferred: {len(unknown_cost)} source(s) probed OK but "
                 f"reported no duration, so the inline budget cannot be trusted")
    if proxy_enabled and defer_proxies:
        progress(f"proxy deferred for all {len(clips)} clips (total footage "
                 f"{total_source_duration:.0f}s > inline budget {proxy_inline_max_total:.0f}s) — "
                 f"backfill runs in the background via POST /api/proxy or `montaj step proxy`")

    # Proxies are their own encoder pool, separate from _heavy_encode_sem so proxy
    # encodes never queue behind libx264/libx265 master transcodes. Its capacity is
    # >1, so this alone does NOT serialize same-path racers (several threads can
    # hold it at once) — that's _proxy_locks_guard's job below.
    #
    # NOTE: at PROXY_ENCODE_LIMIT == NORMALIZE_POOL_SIZE this semaphore no longer
    # bounds anything. _schedule_proxy runs inline inside _normalize_one, so the
    # outer pool is the real cap and at most NORMALIZE_POOL_SIZE proxies can be in
    # flight whatever this is set to. It mattered at 2 (it was the binding
    # constraint, and raising it to 4 is what took the reference folder from 2:02
    # to 1:19); it would matter again if the pool grew. Raise the pool without
    # raising this and proxies quietly become the bottleneck again.
    _proxy_encode_sem = threading.Semaphore(PROXY_ENCODE_LIMIT)

    # Per-proxy-path mutual exclusion for the "is it fresh, and if not, claim
    # the encode" decision. Concurrent children of one shared lazy source
    # compute the SAME proxy_out (see the lazy branch's realpath resolution
    # below) and must fully serialize on THAT check — a semaphore with
    # capacity > 1 does not provide this (two racers can both pass a
    # capacity-2 semaphore at once and both encode). Different proxy paths
    # use different locks, so unrelated clips never block on each other here;
    # _proxy_encode_sem still separately caps how many encodes run at once.
    _proxy_locks_guard = threading.Lock()
    _proxy_locks: dict[str, threading.Lock] = {}

    def _proxy_lock_for(path: str) -> threading.Lock:
        with _proxy_locks_guard:
            lock = _proxy_locks.get(path)
            if lock is None:
                lock = threading.Lock()
                _proxy_locks[path] = lock
            return lock

    def _resolve_source_duration(clip: dict, clip_id: str, cache_key: str, probe_path: str) -> None:
        """Set clip['sourceDuration'] from duration_cache (falling back to a
        fresh probe on a cache miss), or emit a visible notice when the
        duration is still unknown afterward.

        Shared by both the lazy and eager _normalize_one arms below — same
        cache-then-fallback-probe idiom, same miss-visibility contract, so
        the notice can't silently drift between them. `cache_key` is the
        ORIGINAL staged clip path (what duration_cache is keyed by);
        `probe_path` is what a cache-miss fallback probe actually reads —
        the two differ in the eager arm once a clip has been transcoded.

        A miss here means a clip with no sourceDuration reaches project.json
        — downstream that makes it silently undraggable in the editor's
        footage bin, so this notice is what turns that into something
        visible instead. It is NOT a hard failure: the recovery path (a
        "duration unknown" card state + a one-click server re-probe) lives
        elsewhere; this function only makes the miss loud.
        """
        _duration = duration_cache.get(cache_key)
        if _duration is None:
            _duration = _probe_duration(probe_path)
        if _duration is not None:
            clip["sourceDuration"] = _duration
        else:
            progress(f"[{clip_id}] duration unknown for {os.path.basename(probe_path)}"
                     f": the editor will offer a retry")

    def _schedule_proxy(clip: dict, clip_id: str, src: str, *, tonemap: bool, info: dict) -> None:
        """Encode (or reuse) the full-source editing proxy for `src`, writing
        `clip["proxySrc"]` on success.

        Proxies are an enhancement, never a blocker: any failure here is
        reported via progress() and swallowed — the clip simply keeps no
        proxySrc and the editor falls back to playing the master.

        SP3 fix B1: two gates run BEFORE any encode. Proxies disabled
        (--no-proxy / workflow "proxy": false) → silent no-op. Import over the
        total-footage budget (`defer_proxies`, decided once above and already
        logged once for the batch) → no new encode; the proxy is backfilled
        later via POST /api/proxy. That second gate is checked AFTER the
        freshness check, so an already-fresh proxy from a previous run — the
        clips fan-out case, where every child adopts one shared proxy — still
        gets picked up even when this import is over budget.

        The freshness check + encode is fully serialized per-path via
        _proxy_lock_for, so N concurrent children of one shared lazy source
        only encode once — a thread that loses the race blocks on the lock,
        then finds the proxy already fresh once it acquires it and skips
        straight to writing proxySrc.
        """
        if not proxy_enabled:
            return
        proxy_out = proxy_path_for(src)
        try:
            if defer_proxies and not is_proxy_fresh(proxy_out, src):
                return
            with _proxy_lock_for(proxy_out):
                if not is_proxy_fresh(proxy_out, src):
                    with _proxy_encode_sem:
                        make_proxy(src, proxy_out, tonemap=tonemap, info=info)
            clip["proxySrc"] = proxy_out
        except (Exception, SystemExit):
            progress(f"[{clip_id}] proxy FAILED — editor will play the master")

    # Per-clip path classification stats (collected for the summary log at end).
    # Thread-safe append-only list; final summary read after pool join.
    _stats: list[dict] = []
    _stats_lock = threading.Lock()

    # Each thread mutates its OWN clip dict. The only shared state is the proxy
    # bookkeeping above (`_proxy_locks` / `_proxy_locks_guard`, both guarded) —
    # SP3 deliberately has N lazy children converge on ONE proxy output path via
    # realpath, and `_proxy_lock_for` serializes the freshness-check-and-encode
    # for that path. No shared lists, file handles, or probe-cache writes beyond
    # that. Any NEW cross-thread write needs the same treatment.
    def _normalize_one(clip):
        """Normalize a single clip in place. Mutates clip['src'] and clip['sourceDuration']."""
        clip_path = clip["src"]
        clip_id = clip["id"]

        # Lazy mode: skip all probing and transcoding. sourceDuration is still
        # set so the UI can clamp edits; src is left pointing at the original
        # staged file.
        if normalize_mode == "lazy":
            # Reuse the duration read in the single pre-pool pass above; only
            # re-read on a cache miss (that probe failed), same idiom as the
            # probe_cache use below.
            _resolve_source_duration(clip, clip_id, clip_path, clip_path)
            progress(f"[{clip_id}] lazy skip")

            # Full-source editing proxy from the original — lazy mode never
            # conforms a master, so there's no post-normalize src to encode
            # from. Reuse the unconditional probe pass above (init.py's single
            # ffprobe-per-clip contract); only re-probe on an earlier probe
            # failure (cache miss), same idiom as the eager path below.
            info = probe_cache.get(clip_path) or probe_video(clip_path)
            if info is not None:
                tonemap = is_hdr(detect_from_transfer(info.get("color_transfer")))
                # Lazy clips are commonly --symlink-clips'd into a shared
                # source (clips-workflow fan-out — see skills/find_clips):
                # each child project stages its OWN local symlink under its
                # own basename-collision-avoided name, so clip_path differs
                # per child even though the underlying file is identical.
                # Resolve to the real file so every child names (and races
                # on) the SAME proxy path — that's what lets is_proxy_fresh()
                # + make_proxy()'s atomic os.replace (see lib/proxy.py)
                # converge on ONE shared proxy instead of one redundant proxy
                # per child, per the one-proxy-serves-every-child contract on
                # lib/proxy.proxy_path_for. _proxy_encode_sem/_proxy_locks
                # only dedupe within this one process; cross-process races
                # (separate init.py calls for separate children) are safe by
                # construction via that same freshness check + atomic write.
                # For a non-symlinked (copied) clip under the real ~/Montaj
                # workspace root this is a no-op — the copy already lives at
                # its own realpath, so proxy naming/behavior is unchanged.
                # (The ONLY exception is a path with a symlinked ANCESTOR
                # directory, e.g. tests running under macOS's /tmp → /private/tmp
                # — cosmetically different string, same physical file/dir,
                # no behavior change either way.)
                #
                # Placement: proxy_path_for() routes in-workspace sources to a
                # sibling path (the shared `.sources/<id>/` case) and
                # OUTSIDE-workspace sources into
                # `<workspace>/.sources/_proxycache/<realpath-hash>/` so an
                # ad-hoc `--clips <outside path> --symlink-clips` call never
                # litters the user's own footage folders and clean --proxies
                # can always find the artifact (SP3 fix S7).
                _schedule_proxy(clip, clip_id, os.path.realpath(clip_path), tonemap=tonemap,
                                info=info)
            return

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

        # The color space of whatever clip["src"] ends up pointing at below —
        # used to decide the preview proxy's tonemap arm. In the normal
        # "skip"/"transcode" cases this equals project_color_space by
        # construction: is_normalized() only lets "skip" through when the
        # source already matches the project's color space, and normalize()
        # conforms a "transcode" source to it. Only the transcode-FAILED
        # fallback below (still the untouched original) can disagree, so it's
        # corrected there.
        master_color_space = project_color_space

        if path_kind == "transcode":
            tonemapped = (
                is_hdr(detect_from_transfer(info.get("color_transfer")))
                and project_color_space == "sdr_bt709"
            )
            normalized_path = normalized_output_path(clip_path, project_color_space, tonemapped=tonemapped)
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
                master_color_space = detect_from_transfer(info.get("color_transfer"))

        # Full-source editing proxy, encoded from the current (post-normalize)
        # clip["src"]. Policy v3: the editor preview must ALWAYS show montaj's
        # own SDR curve, never the browser's own ad-hoc HDR tone-mapping — so
        # the proxy tone-maps whenever the master feeding it is HDR, regardless
        # of the project's own working color space. Previously this was
        # unconditionally tonemap=False, which left an EAGER-HDR project (an
        # HDR-native master, e.g. all-iPhone-HLG import) with an un-tone-mapped
        # HDR AV1 proxy, leaving the browser to improvise its own tone-mapping
        # for preview. Mirrors the lazy arm's tonemap decision above — just
        # derived from master_color_space instead of a fresh probe, since the
        # master here may be the post-normalize conformed file rather than the
        # original.
        # Skipped when probing failed (no info to build the encode from).

        # Cache source duration so the UI can clamp edits against it. Taken from
        # the pre-pool read on the ORIGINAL staged file rather than a fresh probe
        # of the post-normalize clip["src"]: normalize() conforms codec/color, it
        # never trims, so the two are the same length — and the budget gate above
        # needs this number before the pool starts either way. One read, reused.
        _resolve_source_duration(clip, clip_id, clip_path, clip["src"])

        if info is not None:
            _schedule_proxy(clip, clip_id, clip["src"], tonemap=is_hdr(master_color_space), info=info)

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

    # Stage every take into the workspace first, so the project owns its inputs
    # even if the originals move. One take is used directly (byte-identical to
    # the pre-list behavior); several are concatenated into one narration file.
    voiceover_takes = [copy_into_workspace(os.path.abspath(v), "voiceover")
                       for v in (args.voiceover_asset or [])]
    if len(voiceover_takes) > 1:
        # A take of the user's own can already be sitting at voiceover_full.wav
        # (re-running init on a narration Montaj produced does it), and ffmpeg
        # refuses to read and write one path. De-collide the same way
        # _copy_into_workspace does rather than failing on valid input.
        concat_out = os.path.join(workspace_dir, "voiceover_full.wav")
        _n = 2
        while os.path.exists(concat_out):
            concat_out = os.path.join(workspace_dir, f"voiceover_full_{_n}.wav")
            _n += 1
        voiceover_path = concat_takes(voiceover_takes, concat_out)
    else:
        voiceover_path = voiceover_takes[0] if voiceover_takes else None

    project_type = _read_project_type(args.workflow)

    if project_type == "carousel":
        _build_carousel_project(args, workspace_dir, assets)
        _cleanup_staged_uploads(staged_uploads)
        return

    # Snapshot of the profile's asset manifest + style-profile pointer for
    # the agent. Returns None when --profile is absent. See build_profile_snapshot
    # in lib/profile_assets.py for the full shape and rationale.
    profile_snapshot = build_profile_snapshot(args.profile)

    project = {
        "version": "0.2",
        "id": args.project_id or str(uuid.uuid4()),
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
            "language": args.language,
        },
        "tracks": [{"id": "trk-0", "items": [] if args.canvas else clips}],
        "assets": assets,
        "audio": {},
        **({"profile": args.profile} if args.profile else {}),
        **({"profileSnapshot": profile_snapshot} if profile_snapshot else {}),
    }

    if normalize_mode == "lazy":
        project["settings"]["normalize"] = "lazy"

    if not proxy_enabled:
        # Record the opt-out so backfill tooling and future sessions can see the
        # intent (SP3 fix B1); absent means proxies are on (the default).
        project["settings"]["proxy"] = False

    if voiceover_path:
        project["voiceover"] = {"src": voiceover_path}
        # Provenance for a concatenated narration: which takes produced `src`,
        # in order. Omitted for a single take, where `src` IS the take.
        if len(voiceover_takes) > 1:
            project["voiceover"]["takes"] = voiceover_takes

    if args.derived_from:
        project["derivedFrom"] = args.derived_from

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

    _cleanup_staged_uploads(staged_uploads)

    print(project_path)


if __name__ == "__main__":
    main()
