#!/usr/bin/env python3
"""montaj profile — creator profile management."""
import glob, os, re, shutil, subprocess, sys
from pathlib import Path
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error

# Mirrors regex in serve/routes/profile_assets.py and serve/routes/projects.py — keep in sync.
_NAME_RE     = re.compile(r"^[a-zA-Z0-9_-]+$")
_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$")


def register(subparsers):
    p = subparsers.add_parser("profile", help="Creator profile management (analyze, list)")
    sub = p.add_subparsers(dest="profile_command", required=True)

    # montaj profile analyze
    a = sub.add_parser("analyze", help="Analyze videos and write analysis_current.json")
    a.add_argument("--name",    required=True, help="Profile name (e.g. techbyjaz)")
    a.add_argument("--source",  choices=["current", "inspired"], default="current")
    a.add_argument("--videos",  nargs="+", metavar="VIDEO",
                   help="Video files to analyze. Omit to auto-discover from ~/.montaj/profiles/<name>/videos/<source>/")
    add_global_flags(a)
    a.set_defaults(func=handle_analyze)

    # montaj profile list
    ls = sub.add_parser("list", help="List all profiles")
    ls.set_defaults(func=handle_list)

    # montaj profile asset <subcommand>
    ast = sub.add_parser("asset", help="Manage profile asset library")
    ast_sub = ast.add_subparsers(dest="asset_command", required=True)

    # montaj profile asset list <name>
    ast_ls = ast_sub.add_parser("list", help="List assets in a profile")
    ast_ls.add_argument("name", help="Profile name")
    ast_ls.set_defaults(func=handle_asset_list)

    # montaj profile asset add <name> <path>
    ast_add = ast_sub.add_parser("add", help="Add a file to the profile's asset library")
    ast_add.add_argument("name", help="Profile name")
    ast_add.add_argument("path", help="Path to the file to add")
    ast_add.add_argument("--description", default=None, help="Description for the asset")
    ast_add.add_argument("--tags",        default=None, help="Comma-separated tags (e.g. logo,brand)")
    ast_add.set_defaults(func=handle_asset_add)

    # montaj profile asset rm <name> <filename>
    ast_rm = ast_sub.add_parser("rm", help="Remove an asset from the profile's asset library")
    ast_rm.add_argument("name",     help="Profile name")
    ast_rm.add_argument("filename", help="Filename to remove")
    ast_rm.set_defaults(func=handle_asset_rm)

    # montaj profile asset notes <name> [--get | --set TEXT]
    ast_notes = ast_sub.add_parser("notes", help="Get or set the asset library notes")
    ast_notes.add_argument("name", help="Profile name")
    grp = ast_notes.add_mutually_exclusive_group()
    grp.add_argument("--get", action="store_true", default=False, help="Print current notes (default)")
    grp.add_argument("--set", dest="set_value", metavar="TEXT", default=None, help="Set notes to TEXT")
    ast_notes.set_defaults(func=handle_asset_notes)

    ast.set_defaults(func=lambda args: ast.print_help())
    p.set_defaults(func=lambda args: p.print_help())


def handle_analyze(args):
    out = args.out or os.path.expanduser(f"~/.montaj/profiles/{args.name}/")

    videos = args.videos
    if not videos:
        videos_dir = os.path.join(out, "videos", args.source)
        videos = sorted(glob.glob(os.path.join(videos_dir, "*.mp4")))
        if not videos:
            emit_error("no_videos", f"No videos found in {videos_dir}. Pass --videos or run montaj fetch first.")
            sys.exit(1)

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "profiles", "analyze.py"),
        "--name",   args.name,
        "--source", args.source,
        "--out",    out,
        "--videos", *videos,
    ]

    result = subprocess.run(cmd, capture_output=False, text=True)
    if result.returncode != 0:
        sys.exit(result.returncode)


from cli.help import R, Y, C, D, G


def handle_list(args):
    profiles_dir = os.path.expanduser("~/.montaj/profiles/")
    if not os.path.isdir(profiles_dir):
        print(f"{D}no profiles found{R}")
        return
    found = False
    for entry in sorted(os.listdir(profiles_dir)):
        path = os.path.join(profiles_dir, entry)
        if not os.path.isdir(path):
            continue
        if not os.path.isfile(os.path.join(path, "analysis_current.json")):
            continue
        found = True
        style_path = os.path.join(path, "style_profile.md")
        username = entry
        summary = ""
        videos  = ""
        if os.path.isfile(style_path):
            with open(style_path) as f:
                text = f.read()
            if text.startswith("---"):
                try:
                    end = text.index("---", 3)
                    for line in text[3:end].strip().splitlines():
                        if line.startswith("username:"):
                            username = line.partition(":")[2].strip()
                        elif line.startswith("style_summary:"):
                            summary = line.partition(":")[2].strip()
                        elif line.startswith("videos_current:"):
                            videos = line.partition(":")[2].strip()
                except ValueError:
                    pass
        videos_str = f" {D}({videos} videos){R}" if videos else ""
        summary_str = f"\n    {D}{summary}{R}" if summary else ""
        print(f"  {C}{username}{R}{videos_str}{summary_str}")
    if not found:
        print(f"{D}no profiles found{R}")


# ---------------------------------------------------------------------------
# profile asset handlers
# ---------------------------------------------------------------------------

from lib.profile_assets import load_assets_manifest, save_assets_manifest


def handle_asset_list(args):
    name       = args.name
    if not _NAME_RE.match(name or ""):
        emit_error("invalid_name", "Invalid profile name")
    home       = Path.home()
    profile_dir = home / ".montaj" / "profiles" / name
    if not profile_dir.is_dir():
        emit_error("not_found", f"Profile '{name}' not found")

    assets_dir = profile_dir / "assets"
    if not assets_dir.is_dir():
        print(f"{D}no assets{R}")
        return

    manifest = load_assets_manifest(name)
    files = sorted(
        f for f in assets_dir.iterdir()
        if f.is_file() and f.name != "manifest.json"
    )
    for f in files:
        desc = manifest["files"].get(f.name, {}).get("description", "")
        desc_str = f"  {D}{desc}{R}" if desc else ""
        print(f"  {f.name}{desc_str}")

    if manifest["notes"]:
        print(f"{D}notes: {manifest['notes']}{R}")


def handle_asset_add(args):
    name   = args.name
    if not _NAME_RE.match(name or ""):
        emit_error("invalid_name", "Invalid profile name")
    src    = Path(args.path)
    home   = Path.home()

    if not src.is_file():
        emit_error("file_not_found", f"File not found: {args.path}")

    profile_dir = home / ".montaj" / "profiles" / name
    if not profile_dir.is_dir():
        emit_error("not_found", f"Profile '{name}' not found")

    assets_dir = profile_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    # Collision-suffix: hello.txt → hello_1.txt → hello_2.txt …
    dest   = assets_dir / src.name
    stem   = dest.stem
    suffix = dest.suffix
    counter = 1
    while dest.exists():
        dest = assets_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    shutil.copy2(src, dest)

    final_name = dest.name
    if args.description is not None or args.tags is not None:
        manifest = load_assets_manifest(name)
        desc     = args.description if args.description is not None else ""
        entry: dict = {"description": desc}
        if args.tags is not None:
            tag_list = [t.strip() for t in args.tags.split(",") if t.strip()]
            entry["tags"] = tag_list
        manifest["files"][final_name] = entry
        save_assets_manifest(name, manifest)

    print(f"added: {final_name}")


def handle_asset_rm(args):
    name     = args.name
    filename = args.filename
    home     = Path.home()

    if not _NAME_RE.match(name or ""):
        emit_error("invalid_name", "Invalid profile name")
    if not _FILENAME_RE.match(filename or ""):
        emit_error("invalid_filename", "Invalid filename")

    profile_dir = home / ".montaj" / "profiles" / name
    if not profile_dir.is_dir():
        emit_error("not_found", f"Profile '{name}' not found")

    assets_dir = profile_dir / "assets"
    target     = (assets_dir / filename).resolve()

    # Traversal check — must stay inside assets_dir.
    try:
        target.relative_to(assets_dir.resolve())
    except (ValueError, OSError):
        emit_error("invalid_filename", "Path escapes assets dir")

    manifest  = load_assets_manifest(name)
    has_file  = target.exists()
    has_entry = filename in manifest["files"]

    if not has_file and not has_entry:
        emit_error("not_found", f"Asset '{filename}' not found")

    if has_file:
        try:
            target.unlink()
        except FileNotFoundError:
            pass

    if has_entry:
        manifest["files"].pop(filename, None)
        save_assets_manifest(name, manifest)

    print(f"removed: {filename}")


def handle_asset_notes(args):
    name = args.name
    if not _NAME_RE.match(name or ""):
        emit_error("invalid_name", "Invalid profile name")
    home = Path.home()

    profile_dir = home / ".montaj" / "profiles" / name
    if not profile_dir.is_dir():
        emit_error("not_found", f"Profile '{name}' not found")

    if args.set_value is not None:
        manifest = load_assets_manifest(name)
        manifest["notes"] = args.set_value
        save_assets_manifest(name, manifest)
    else:
        # --get or default
        manifest = load_assets_manifest(name)
        print(manifest["notes"])
