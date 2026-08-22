#!/usr/bin/env python3
"""montaj clean — remove disposable derived files (editing proxies, superseded
look-tagged normalized masters)."""
import json, os, re, sys
from itertools import chain
from cli.main import add_global_flags
from cli.output import emit_error
from lib.project_tracks import track_items
from lib.proxy import PROXY_LOOK

# Only files carrying a KNOWN look tag are ever deleted (SP3 fix S5) — the loose
# `*_proxy_*.mp4` glob also matched user files like `reverse_proxy_demo.mp4`.
# APPEND (never remove) old tags here when lib/proxy.py's PROXY_LOOK bumps, so
# the previous look's files stay cleanable after a regeneration.
KNOWN_LOOKS = tuple(dict.fromkeys(("hable1", PROXY_LOOK)))
PROXY_RE = re.compile(r"_proxy_(%s)\.mp4$" % "|".join(re.escape(look) for look in KNOWN_LOOKS))

# Superseded normalized masters (SP6b Task T5). lib/normalize.py's
# normalized_output_path() only ever look-tags a tone-mapped HDR→SDR master
# (`*_normalized_sdr_bt709_<look>.mp4`, see its docstring) — a plain
# `*_normalized_sdr_bt709.mp4` is either an SDR-native source's untagged
# conformance master (still live, never delete) or, once the SAME source has
# been re-graded and gained a look-tagged sibling, a stale leftover from
# before that look existed. Only the latter — untagged file WITH a tagged
# sibling present — is ever listed here. Reuses KNOWN_LOOKS so a bumped
# PROXY_LOOK/MASTER_LOOK is picked up automatically, same as PROXY_RE above.
UNTAGGED_MASTER_RE = re.compile(r"^(.+)_normalized_sdr_bt709\.mp4$")


def register(subparsers):
    p = subparsers.add_parser("clean", help="Remove disposable derived files")
    p.add_argument("--proxies", action="store_true", required=True,
                   help="Clean editing proxies (*_proxy_*.mp4) and superseded look-tagged "
                        "normalized masters. The only supported mode today.")
    scope = p.add_mutually_exclusive_group()
    scope.add_argument("--project", metavar="DIR",
                        help="Limit to one project directory (default: auto-discover from cwd)")
    scope.add_argument("--all-projects", action="store_true",
                        help="Scan the whole workspace instead of just the current project")
    p.add_argument("--yes", action="store_true",
                   help="Actually delete. Without --yes, clean only LISTS what it would "
                        "remove — the safe default for a recursive destructive command. (SP3 fix S6)")
    p.add_argument("--dry-run", action="store_true",
                   help="Explicit alias for the default list-only behavior (overrides --yes)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def _workspace_root():
    """Global workspace root: MONTAJ_WORKSPACE_DIR env var > ~/.montaj/config.json's
    workspaceDir > ~/Montaj. Mirrors project/init.py's resolution (duplicated per
    existing precedent in serve/common.py and lib/ai_video.py — no shared helper
    exists to import from cli/ without pulling in serve)."""
    env = os.environ.get("MONTAJ_WORKSPACE_DIR")
    if env:
        return env
    config_path = os.path.join(os.path.expanduser("~"), ".montaj", "config.json")
    if os.path.isfile(config_path):
        try:
            cfg = json.loads(open(config_path).read())
            if "workspaceDir" in cfg:
                return cfg["workspaceDir"]
        except Exception:
            pass
    return os.path.join(os.path.expanduser("~"), "Montaj")


def _find_project_dir():
    """Auto-discover the current project directory: cwd first, then the
    most-recently-modified subdirectory of cwd/workspace/. Mirrors status.py's
    _find_project(), returning the containing directory instead of the
    project.json path."""
    if os.path.isfile(os.path.join(os.getcwd(), "project.json")):
        return os.getcwd()
    workspace_dir = os.path.join(os.getcwd(), "workspace")
    if os.path.isdir(workspace_dir):
        entries = [
            os.path.join(workspace_dir, d)
            for d in os.listdir(workspace_dir)
            if os.path.isdir(os.path.join(workspace_dir, d))
        ]
        entries.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for entry in entries:
            if os.path.isfile(os.path.join(entry, "project.json")):
                return entry
    return None


def _scan_roots(args):
    """Resolve the directories to scan for this invocation.

    --all-projects: the whole workspace root (which already contains
    .sources/, so it isn't added separately). --project: that directory plus
    .sources/. Default: the auto-discovered current project plus .sources/.
    Shared lazy sources (~/Montaj/.sources/) are always included, per SP3.
    """
    workspace_root = _workspace_root()
    sources_dir = os.path.join(workspace_root, ".sources")

    if args.all_projects:
        roots = [workspace_root]
    elif args.project:
        if not os.path.isdir(args.project):
            emit_error("not_found", f"Directory not found: {args.project}")
        if not os.path.isfile(os.path.join(args.project, "project.json")):
            # SP3 fix S4: the same rule auto-discovery applies. Without this,
            # `--project ~` is a valid recursive delete-and-rewrite walk over
            # an arbitrary directory tree. Whole-workspace cleans go through
            # --all-projects instead.
            emit_error("not_a_project",
                       f"--project must point at a project directory (no project.json in "
                       f"{args.project}). Use --all-projects for a whole-workspace clean.")
        roots = [args.project, sources_dir]
    else:
        project_dir = _find_project_dir()
        if not project_dir:
            emit_error(
                "project_not_found",
                "No project found in the current directory. Pass --project <dir> "
                "or --all-projects.",
            )
        roots = [project_dir, sources_dir]

    # Dedupe roots that are exact-realpath duplicates of each other, and drop
    # roots that don't exist (.sources/ may not exist yet). This does NOT
    # cover a root that is an *ancestor* of another root (e.g. --project
    # pointing at the workspace root itself, making .sources/ a descendant
    # rather than a duplicate) — that overlap is handled by deduping the
    # collected files themselves in handle(), keyed by realpath.
    seen = set()
    result = []
    for root in roots:
        real = os.path.realpath(root)
        if real in seen or not os.path.isdir(root):
            continue
        seen.add(real)
        result.append(root)
    return result


def _find_proxy_files(root):
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            if PROXY_RE.search(name):
                yield os.path.join(dirpath, name)


def _find_superseded_masters(root):
    for dirpath, _dirnames, filenames in os.walk(root):
        names = set(filenames)
        for name in sorted(filenames):
            m = UNTAGGED_MASTER_RE.match(name)
            if not m:
                continue
            prefix = m.group(1)
            has_tagged_sibling = any(
                f"{prefix}_normalized_sdr_bt709_{look}.mp4" in names for look in KNOWN_LOOKS
            )
            if has_tagged_sibling:
                yield os.path.join(dirpath, name)


def _human_size(num_bytes):
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024


def handle(args):
    roots = _scan_roots(args)

    matches = []
    seen_paths = set()
    for root in roots:
        for path in chain(_find_proxy_files(root), _find_superseded_masters(root)):
            real = os.path.realpath(path)
            if real in seen_paths:
                # A scan root can be an ancestor of another root (e.g.
                # --project pointing at the workspace root itself makes
                # .sources/ a descendant, not just an exact-realpath
                # duplicate), so os.walk() can yield the same file from more
                # than one root. Dedupe the collected files themselves,
                # keyed by realpath, so each is only acted on once.
                continue
            seen_paths.add(real)
            matches.append({"path": path, "bytes": os.path.getsize(path)})

    # SP3 fix S6: deleting requires an explicit --yes; the bare command (and
    # --dry-run) only lists. --dry-run beats --yes when both are passed.
    will_delete = args.yes and not args.dry_run
    if will_delete:
        for match in matches:
            try:
                os.remove(match["path"])
                match["deleted"] = True
            except OSError as e:
                match["deleted"] = False
                match["error"] = str(e)
    else:
        for match in matches:
            match["deleted"] = False

    # A deleted proxy whose proxySrc survives in project.json is worse than no
    # proxy at all: timeline-core still selects it and the preview <video> has
    # no error fallback, so the clip goes black. Strip the pointers we just
    # invalidated so the editor really does fall back to the master.
    deleted = {m["path"] for m in matches if m.get("deleted")}
    projects_updated = 0
    for root in roots:
        for dirpath, _dirnames, filenames in os.walk(root):
            if "project.json" not in filenames:
                continue
            pj = os.path.join(dirpath, "project.json")
            try:
                data = json.loads(open(pj).read())
            except Exception:
                continue
            changed = False
            for group in track_items(data) + [data.get("sources", [])]:
                for item in group or []:
                    if isinstance(item, dict) and item.get("proxySrc") in deleted:
                        del item["proxySrc"]
                        changed = True
            if changed:
                # Atomic rewrite (SP3 fix S6): truncate-then-dump destroys the
                # project file on a crash or full disk. Same tmp+os.replace
                # pattern as lib/credentials.py.
                tmp = pj + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(data, f, indent=2)
                os.replace(tmp, pj)
                projects_updated += 1

    if args.json:
        print(json.dumps(matches, indent=2))
        # Keeping `matches` a bare top-level list preserves the existing
        # machine-readable shape (existing tests parse the whole stdout as
        # `json.loads(...)` and index straight into it) — wrapping it in an
        # envelope object would be a breaking change for every consumer of
        # `--json`. projects_updated is reported as a separate JSON line on
        # stderr instead, mirroring how this file already routes auxiliary
        # signals (errors) to stderr via emit_error.
        if projects_updated:
            print(json.dumps({"projects_updated": projects_updated}), file=sys.stderr)
        return

    for match in matches:
        print(f"{_human_size(match['bytes']):>8}  {match['path']}")
    if projects_updated:
        print(f"cleared proxySrc from {projects_updated} project.json file(s)")
    if matches and not will_delete:
        print("(nothing deleted — pass --yes to delete)")
