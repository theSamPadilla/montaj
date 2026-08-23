#!/usr/bin/env python3
"""montaj init — create an empty project in the current directory."""
import json, os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error
from lib.types.colorspace import ALL_COLOR_SPACES


def register(subparsers):
    p = subparsers.add_parser("init", help="Create an empty project in the current directory")
    p.add_argument("--prompt",   required=True, help="Editing prompt")
    p.add_argument("--workflow", default="clean_cut", help="Workflow name (default: clean_cut)")
    p.add_argument("--name",     help="Project name label")
    p.add_argument(
        "--project-path",
        dest="project_path",
        default=None,
        help=(
            "Relative path (under the workspace root) where this project's "
            "directory should be created. Single segment for flat layouts "
            "(e.g. 'my-project'), multi-segment slash-separated for nested "
            "layouts (e.g. 'teamA/my-project'). When omitted, the directory "
            "name is generated as '<date>-<slug>' from --name."
        ),
    )
    p.add_argument(
        "--color-space",
        dest="color_space",
        choices=("auto",) + ALL_COLOR_SPACES,
        default="auto",
        help="Project working color space. 'auto' (default) detects from clip metadata.",
    )
    p.add_argument(
        "--no-proxy", dest="no_proxy", action="store_true",
        help="Skip editing-proxy generation entirely. The editor falls back to "
             "playing masters; proxies can be backfilled later via POST /api/proxy or "
             "`montaj step proxy`. Also settable per-workflow with \"proxy\": false.",
    )
    p.add_argument(
        "--proxy-inline-max", dest="proxy_inline_max", type=float, default=None,
        help="Max source duration (seconds) proxied inline during init; longer sources "
             "defer to the backfill job so project creation never blocks on a long encode. "
             # Keep in sync with project/init.py's PROXY_INLINE_MAX_SEC — this
             # help string doesn't read the constant (this module only builds
             # the subprocess argv; project/init.py's own module isn't imported
             # here), so a change there needs this string updated by hand.
             "Default 480.",
    )
    # Local file pass-through flags (project/init.py accepts --clips/--assets;
    # the CLI now exposes them as --clip/--asset for a nicer UX).
    p.add_argument("--clip", dest="clips", action="append", default=[],
                   help="Local clip path (repeatable)")
    p.add_argument("--asset", dest="assets", action="append", default=[],
                   help="Local asset path (image, logo, etc.) (repeatable)")
    p.add_argument("--voiceover-asset", action="append", dest="voiceover_asset",
                   help="Audio or video file supplying the voiceover (broll only). "
                        "Repeat once per take, in order, to concatenate them.")
    # Remote fetch flags (passed verbatim to project/init.py).
    p.add_argument("--remote-clip", dest="remote_clips", action="append", default=[],
                   help="Remote clip JSON: {url, destPath, contentType, sizeBytes, method?, headers?}. "
                        "Repeatable.")
    p.add_argument("--remote-asset", dest="remote_assets", action="append", default=[],
                   help="Remote asset JSON: {url, destPath, contentType, sizeBytes, method?, headers?}. "
                        "Repeatable.")
    # Convenience file-based flags: JSON array of items, expanded into per-item flags.
    p.add_argument("--remote-clips-file", dest="remote_clips_file", default=None,
                   help="Path to a JSON file containing an array of remote-clip objects.")
    p.add_argument("--remote-assets-file", dest="remote_assets_file", default=None,
                   help="Path to a JSON file containing an array of remote-asset objects.")
    add_global_flags(p)
    p.set_defaults(func=handle)


def _load_remote_file(path: str, kind: str) -> list:
    """Load a JSON array from *path* for --remote-{kind}s-file. Errors via emit_error."""
    if not os.path.isfile(path):
        emit_error("file_not_found",
                   f"--remote-{kind}s-file: file not found: {path!r}")
    try:
        with open(path) as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        emit_error("invalid_json",
                   f"--remote-{kind}s-file {path!r} is not valid JSON: {exc}")
    if not isinstance(data, list):
        emit_error("invalid_format",
                   f"--remote-{kind}s-file {path!r} must contain a JSON array, got {type(data).__name__}")
    return data


def handle(args):
    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "project", "init.py"),
        "--prompt", args.prompt,
        "--workflow", args.workflow,
    ]
    if args.name:
        cmd += ["--name", args.name]
    if args.project_path:
        cmd += ["--project-path", args.project_path]
    # Default 'auto' is omitted to keep CLI invocations clean — init.py also
    # defaults to 'auto', so passing it explicitly is unnecessary noise.
    if args.color_space and args.color_space != "auto":
        cmd += ["--color-space", args.color_space]
    if args.no_proxy:
        cmd += ["--no-proxy"]
    if args.proxy_inline_max is not None:
        cmd += ["--proxy-inline-max", str(args.proxy_inline_max)]

    # Local clips and assets (pass each as a separate --clips / --assets value;
    # project/init.py uses nargs="*" with action=append semantics via multiple flags).
    if args.clips:
        cmd += ["--clips"] + args.clips
    if args.assets:
        cmd += ["--assets"] + args.assets
    if args.voiceover_asset:
        cmd += ["--voiceover-asset"] + list(args.voiceover_asset)

    # Remote clips: collect from --remote-clip flags + optional --remote-clips-file.
    remote_clips = list(args.remote_clips)
    if args.remote_clips_file:
        items = _load_remote_file(args.remote_clips_file, "clip")
        remote_clips += [json.dumps(item) for item in items]
    for r in remote_clips:
        cmd += ["--remote-clip", r]

    # Remote assets: collect from --remote-asset flags + optional --remote-assets-file.
    remote_assets = list(args.remote_assets)
    if args.remote_assets_file:
        items = _load_remote_file(args.remote_assets_file, "asset")
        remote_assets += [json.dumps(item) for item in items]
    for r in remote_assets:
        cmd += ["--remote-asset", r]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
