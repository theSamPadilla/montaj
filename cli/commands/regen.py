#!/usr/bin/env python3
"""montaj regen — queue a regeneration request for an ai_video clip.

Two modes:
  montaj regen full <clip_id>      — regenerate the entire clip (default)
  montaj regen subcut <clip_id>    — regenerate a sub-range within a clip

Appends an entry to project.regenQueue[]. The agent picks these up during
Phase 7 of the ai-video skill, validates each entry, calls kling_generate,
and patches tracks[0].
"""
import json, os, tempfile, time
from datetime import datetime, timezone

from cli.main import add_global_flags
from cli.output import emit_error


def register(subparsers):
    p = subparsers.add_parser(
        "regen",
        help="Queue a regeneration request for an ai_video clip.",
    )

    sub = p.add_subparsers(dest="mode", required=True,
                           metavar="{full,subcut}")

    # --- montaj regen full <clip-id> ---
    p_full = sub.add_parser("full", help="Regenerate the entire clip")
    p_full.add_argument("clip_id", help="Clip ID to regenerate")
    _add_optional_args(p_full)
    add_global_flags(p_full)
    p_full.set_defaults(func=_handle_full, _mode="full")

    # --- montaj regen subcut <clip-id> --start N --end M ---
    p_sub = sub.add_parser("subcut", help="Regenerate a sub-range within a clip")
    p_sub.add_argument("clip_id", help="Clip ID to regenerate")
    _add_optional_args(p_sub)
    p_sub.add_argument("--start", type=int, required=True,
                       help="Start second of the subrange (integer)")
    p_sub.add_argument("--end", type=int, required=True,
                       help="End second of the subrange (integer)")
    p_sub.add_argument("--use-first-frame", action="store_true",
                       help="Condition generation on the first frame of the subrange")
    p_sub.add_argument("--use-last-frame", action="store_true",
                       help="Condition generation on the last frame of the subrange")
    add_global_flags(p_sub)
    p_sub.set_defaults(func=_handle_subcut, _mode="subcut")


def _add_optional_args(parser):
    """Add the optional override flags shared by full + subcut."""
    parser.add_argument("--project", metavar="PATH",
                        help="Path to project.json (default: auto-discover from cwd / workspace/)")
    parser.add_argument("--prompt", help="Override the generation prompt")
    parser.add_argument("--duration", type=int, help="Override clip duration in seconds")
    parser.add_argument("--ref-image", action="append", metavar="PATH",
                        help="Reference image path (repeatable)")
    parser.add_argument("--model", help="Model identifier (default: from clip or kling-v3-omni)")


# ---------------------------------------------------------------------------
# Helpers reused from approve.py pattern
# ---------------------------------------------------------------------------

def _find_project():
    candidate = os.path.join(os.getcwd(), "project.json")
    if os.path.isfile(candidate):
        return candidate
    workspace_dir = os.path.join(os.getcwd(), "workspace")
    if os.path.isdir(workspace_dir):
        entries = [
            os.path.join(workspace_dir, d)
            for d in os.listdir(workspace_dir)
            if os.path.isdir(os.path.join(workspace_dir, d))
        ]
        entries.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for entry in entries:
            candidate = os.path.join(entry, "project.json")
            if os.path.isfile(candidate):
                return candidate
    return None


def _write_atomic(path, data):
    """Write JSON atomically so a concurrent reader never sees a torn file."""
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".project.", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def _handle_full(args):
    _build_and_enqueue(args, mode="full", subrange=None)


def _handle_subcut(args):
    start, end = args.start, args.end
    if start >= end:
        emit_error("invalid_subrange", f"--start ({start}) must be less than --end ({end}).")
    length = end - start
    if length < 3 or length > 15:
        emit_error(
            "invalid_subrange_length",
            f"Subrange length must be between 3 and 15 seconds (got {length}).",
        )
    _build_and_enqueue(args, mode="subcut", subrange={"start": start, "end": end})


def _build_and_enqueue(args, *, mode, subrange):
    # 1. Find project.json
    path = getattr(args, "project", None) or _find_project()
    if not path or not os.path.isfile(path):
        emit_error(
            "project_not_found",
            "No project.json found. Pass --project PATH or cd into the project directory.",
        )

    try:
        with open(path) as f:
            project = json.load(f)
    except json.JSONDecodeError as e:
        emit_error("invalid_json", f"Could not parse {path}: {e}")

    # 2. Validate project type and status
    project_type = project.get("projectType")
    if project_type != "ai_video":
        emit_error(
            "wrong_project_type",
            f"regen is only for ai_video projects (this one is projectType={project_type!r}).",
        )

    status = project.get("status")
    if status not in ("draft", "final"):
        emit_error(
            "wrong_status",
            f"Project status is {status!r}; expected 'draft' or 'final'.",
        )

    # 3. Find clip in tracks[0]
    tracks = project.get("tracks") or []
    if not tracks or not tracks[0]:
        emit_error("no_tracks", "project.tracks[0] is empty.")

    clip = None
    for c in tracks[0]:
        if c.get("id") == args.clip_id:
            clip = c
            break
    if clip is None:
        emit_error("clip_not_found", f"No clip with id={args.clip_id!r} in tracks[0].")

    # 4. Validate generation block
    gen = clip.get("generation")
    if not gen:
        emit_error(
            "no_generation",
            f"Clip {args.clip_id!r} has no generation block — nothing to regenerate.",
        )

    # 5. Build entry
    entry = {
        "id": f"req-{int(time.time())}",
        "clipId": args.clip_id,
        "mode": mode,
        "subrange": subrange,
        "prompt": args.prompt or gen.get("prompt", ""),
        "refImages": args.ref_image or gen.get("refImages", []),
        # Falls back to subrange length (subcut) or 5s (full) when neither --duration nor gen.duration exist
        "duration": args.duration or gen.get("duration") or (subrange["end"] - subrange["start"] if subrange else 5),
        "useFirstFrame": getattr(args, "use_first_frame", False),
        "useLastFrame": getattr(args, "use_last_frame", False),
        "model": args.model or gen.get("model", "kling-v3-omni"),
        "requestedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }

    # 6. Append to regenQueue and write
    queue = project.setdefault("regenQueue", [])
    queue.append(entry)
    _write_atomic(path, project)

    # 7. Output
    label = project.get("name") or project.get("id") or "<unnamed>"
    pid = project.get("id")
    count = len(queue)
    agent_msg = _agent_message(label, pid, count)

    if args.json:
        print(json.dumps({
            "status": "ok",
            "entry": entry,
            "project": label,
            "projectId": pid,
            "projectPath": path,
            "pendingEntries": count,
            "nextAction": "Tell your agent in chat to process the regen queue.",
            "agentMessage": agent_msg,
        }))
        return

    print(f'Queued {mode} regen for clip {args.clip_id} in project "{label}" (id: {pid}).')
    print(f"  project.json: {path}")
    print(f"  pending entries: {count}")
    print()
    print("Next: tell your agent in chat:")
    print()
    print(f"  {agent_msg}")
    print()
    print("The agent will validate each entry, call kling_generate, and patch tracks[0].")


def _agent_message(label, project_id, count):
    id_frag = f" (id: {project_id})" if project_id else ""
    return (
        f'I queued {count} regeneration request(s) for project "{label}"{id_frag}. '
        f"Please process project.regenQueue[] per the ai-video skill Phase 7 contract."
    )
