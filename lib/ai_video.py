"""Shared helpers for ai_video project-aware steps.

Used by kling_generate.py, veo_generate.py and eval_scene.py. Lives in lib/ so
it's on the sys.path that all step scripts set up.
"""
import json, re, time
from pathlib import Path
from common import fail, get_duration
from normalize import normalize, normalized_output_path, is_normalized, probe_video
from lib.types.colorspace import normalize_key, DEFAULT_COLOR_SPACE, detect_from_transfer, is_hdr
from lib.project_tracks import track_items, replace_track_items
from lib.project_lock import project_lock_or_fail, update_project_or_fail, write_json_atomic
from lib import project_revisions


# Optimal Kling prompt order: camera first (framing context), then subject
# (anchors identity), action (motion), dialogue (voice-tagged speech).
#
# Sources:
# - Kling guides: "[Camera Movement] + [Subject & Action] + [Environment]"
# - agent-free-strike: shot scale + camera move as first-class elements
# - https://promnest.com/blog/kling-3-omni-prompting-guide/
SECTION_ORDER = ["camera", "subject", "action", "dialogue"]

# Valid section names the agent can use with ## headers.
VALID_SECTIONS = set(SECTION_ORDER)


def parse_prompt_sections(prompt: str) -> dict[str, str]:
    """Parse a ## section-formatted prompt into {section_name: text}.

    Accepts prompts like:
        ## Camera
        Slow zoom into a sunny playground

        ## Subject
        Rennie leans forward nervously...

    Returns {"camera": "Slow zoom...", "subject": "Rennie leans..."}.
    If the prompt has no ## headers, returns {"_raw": prompt} (legacy flat string).
    """
    # Check if prompt uses ## sections
    if not re.search(r"^##\s+\w", prompt, re.MULTILINE):
        return {"_raw": prompt}

    sections: dict[str, str] = {}
    current_key = None
    current_lines: list[str] = []

    for line in prompt.splitlines():
        header_match = re.match(r"^##\s+(.+)$", line)
        if header_match:
            # Save previous section
            if current_key is not None:
                sections[current_key] = "\n".join(current_lines).strip()
            current_key = header_match.group(1).strip().lower()
            current_lines = []
        else:
            current_lines.append(line)

    # Save last section
    if current_key is not None:
        sections[current_key] = "\n".join(current_lines).strip()

    return sections


def flatten_prompt_sections(sections: dict[str, str]) -> str:
    """Flatten parsed sections into optimal Kling prompt order as flowing prose.

    Reorders sections per SECTION_ORDER, strips headers, joins with periods.
    Each section is terminated with a period before the next begins — this
    prevents Kling from reading run-on noun phrases across section boundaries.
    Unknown sections are appended at the end.
    """
    if "_raw" in sections:
        return sections["_raw"]

    ordered_parts: list[str] = []

    # Known sections in optimal order
    for key in SECTION_ORDER:
        if key in sections and sections[key]:
            text = sections[key].strip()
            # Ensure each section ends with sentence-ending punctuation
            if text and text[-1] not in ".!?\"'":
                text += "."
            ordered_parts.append(text)

    # Unknown sections appended at end
    for key, text in sections.items():
        if key not in SECTION_ORDER and text:
            t = text.strip()
            if t and t[-1] not in ".!?\"'":
                t += "."
            ordered_parts.append(t)

    return " ".join(ordered_parts)


def resolve_workspace() -> Path:
    config_path = Path.home() / ".montaj" / "config.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text())
            if "workspaceDir" in cfg:
                return Path(cfg["workspaceDir"])
        except Exception:
            pass
    return Path.home() / "Montaj"


def find_project(project_id: str) -> tuple[Path, dict]:
    """Find and load project by ID. Returns (project_json_path, project_dict)."""
    workspace = resolve_workspace()
    for p in workspace.glob("*/project.json"):
        try:
            data = json.loads(p.read_text())
            if data.get("id") == project_id:
                return p, data
        except Exception:
            pass
    fail("not_found", f"Project {project_id} not found in {workspace}")


def save_project(path: Path, project: dict):
    """Write the WHOLE document back (atomic, under the project lock). A step
    that read the project earlier must use save_project_changes instead, so a
    concurrent edit survives.

    WARNING: this overwrites the whole file with `project`. Anything another
    writer (the editor, serve, another step) saved since `project` was read is
    lost. Use it only when `project` was read under the same lock hold, or when
    the document is yours alone (a new project)."""
    with project_lock_or_fail(path, fail):
        write_json_atomic(path, project, indent=2, ensure_ascii=False)


def save_project_changes(path: Path, original: dict, project: dict, keys=("tracks",), *, guard=("tracks",)):
    """Write only `keys` of `project` onto a fresh read of the file, under the
    project lock. `original` is a deep copy of the document as the step read it
    (taken before the step mutated anything). When a `guard` key on disk no
    longer equals the original's, someone edited it meanwhile: fail with
    `project_changed` and write nothing. Everything else in the fresh document
    is kept.

    With the engine guard on (§477) the compare is the shared one: the guard
    keys' revisions as read (from `original`) against the fresh document's,
    with the shared step message."""
    read = project_revisions.revisions_of(original, guard) if project_revisions.engine_guard_enabled() else None

    def apply(fresh):
        if read is not None:
            stale = project_revisions.stale_fields(fresh, list(guard), read)["stale"]
            if stale:
                fail("project_changed", project_revisions.step_stale_message(stale))
        else:
            for key in guard:
                if fresh.get(key) != original.get(key):
                    fail("project_changed",
                         f"The project's {key} changed while this step ran: read it again and redo the cut.")
        for key in keys:
            if key in project:
                fresh[key] = project[key]
            else:
                fresh.pop(key, None)
        return fresh
    return update_project_or_fail(path, apply, fail, indent=2, ensure_ascii=False)


def compose_prompt(project: dict, scene: dict, ref_tokens: bool = True) -> str:
    """Compose the full prompt from project context + scene prose.

    `ref_tokens` places Kling's inline <<<image_N>>> tokens at the reference
    labels; veo_generate passes False, since Veo takes its references as plain
    asset images with nothing to address them by in the prompt.

    The scene prompt may be either:
    - **Structured** (## headers): parsed into sections, reordered to optimal
      Kling sequence (Camera → Subject → Action → Dialogue → Environment → Mood),
      then flattened into flowing prose.
    - **Legacy flat string**: used as-is.

    In both cases, the step then applies:
    - styleAnchor prefix
    - Inline <<<image_N>>> tokens at label positions (when ref_tokens)
    - [SHOT SCALE] / [CAMERA MOVE] tags from structured scene fields
    - CHARACTER/OBJECT SPECS section from imageRefs[i].anchor
    """
    style_anchor = project.get("storyboard", {}).get("styleAnchor", "")
    image_refs = {r["id"]: r for r in project.get("storyboard", {}).get("imageRefs", [])}

    # Parse and flatten sections
    sections = parse_prompt_sections(scene["prompt"])
    prompt = flatten_prompt_sections(sections)

    ref_ids = scene.get("refImages", []) if ref_tokens else []

    # Build tokens and place inline at label matches.
    # Match on the first word of the label (e.g. "Rosie" from "Rosie the Dog")
    # to handle prompts that use variants like "Rosie the corgi".
    token_parts = []
    for i, rid in enumerate(ref_ids):
        token = f"<<<image_{i + 1}>>>"
        token_parts.append(token)
        ref = image_refs.get(rid, {})
        label = ref.get("label", "")
        if not label:
            continue
        # Try full label first, then first word
        if label in prompt:
            prompt = prompt.replace(label, f"{label} {token}", 1)
        else:
            first_word = label.split()[0]
            if len(first_word) >= 3 and first_word in prompt:
                prompt = prompt.replace(first_word, f"{first_word} {token}", 1)

    # No ref clause prefix — inline <<<image_N>>> tokens at the nouns are
    # the binding signal.
    #
    # Style anchor goes AFTER the scene content, not before. The most
    # valuable real estate in the prompt is the first sentence — Kling
    # anchors identity from it. Style preamble wastes that position.
    # Ref images already carry the visual style.

    parts = [prompt]
    if style_anchor:
        parts.append(style_anchor)

    composed = " ".join(parts)

    # shotScale and cameraMove are stored as structured data on the scene
    # for UI display and agent planning, but are NOT appended as tags to
    # the wire prompt. Camera direction should be written naturally in the
    # scene prose by the agent. Bracketed tags like [SHOT SCALE] conflict
    # with prose-style camera instructions and aren't a Kling convention.

    # CHARACTER/OBJECT SPECS appendix removed — it added 150+ words of text
    # that bloated prompts past Kling's sweet spot (60-100 words). The ref
    # images + inline <<<image_N>>> tokens carry identity signal; the verbose
    # text specs were redundant and caused scale/proportion confusion.

    return composed


def resolve_ref_paths(project: dict, scene: dict) -> list[str]:
    """Resolve scene refImage IDs to file paths."""
    image_refs = {r["id"]: r for r in project.get("storyboard", {}).get("imageRefs", [])}
    paths = []
    for rid in scene.get("refImages", []):
        ref = image_refs.get(rid, {})
        ref_images = ref.get("refImages", [])
        if ref_images:
            paths.append(ref_images[0])
    return paths


def save_clip_to_project(project_path: Path, project: dict, scene: dict,
                         out_path: str, composed_prompt: str, model: str = "kling-v3-omni",
                         seed: int = None, provider: str = "kling"):
    """Append the generated clip to tracks[0] and save the project.

    `provider` is recorded as generation.provider ("gemini" for Veo clips)."""
    clip = {
        "id": f"clip-{scene['id']}",
        "type": "video",
        "src": out_path,
        "start": 0.0,   # placed on the fresh document, under the lock
        "end": scene["duration"],
        "inPoint": 0,
        "outPoint": scene["duration"],
        "generation": {
            "sceneId": scene["id"],
            "provider": provider,
            "model": model,
            "prompt": composed_prompt,
            "refImages": scene.get("refImages", []),
            "duration": scene["duration"],
            "seed": seed,
            "attempts": [],
        },
    }
    # Normalize clip to project working color space (e.g. Kling outputs SDR; iPhone
    # HDR projects need libx265 HDR HEVC). Color space is read from settings.colorSpace
    # (set at init time); falls back to SDR default for projects without the field.
    settings = project.get("settings", {})
    project_color_space = normalize_key(settings.get("colorSpace"))

    info = probe_video(out_path)
    if info and not is_normalized(out_path, info, project_color_space):
        tonemapped = (
            is_hdr(detect_from_transfer(info.get("color_transfer")))
            and project_color_space == "sdr_bt709"
        )
        sdr_stretch = (
            not is_hdr(detect_from_transfer(info.get("color_transfer")))
            and is_hdr(project_color_space)
        )
        normalized_path = normalized_output_path(out_path, project_color_space,
                                                 tonemapped=tonemapped, sdr_stretch=sdr_stretch)
        try:
            normalize(out_path, normalized_path, project_color_space, info=info)
            if sdr_stretch:
                # An SDR clip into an HDR project (PV42): the conversion is a
                # full-source cache, and `src` stays the generated clip itself.
                clip["normalizedSrc"] = normalized_path
                clip["normalizedInPoint"] = 0
            else:
                clip["src"] = normalized_path
        except SystemExit:
            clip["src"] = out_path

    # Cache actual file duration so the UI can clamp edits against it
    try:
        clip["sourceDuration"] = get_duration(clip["src"])
    except Exception:
        clip["sourceDuration"] = scene["duration"]

    def apply(fresh):
        # The slow work above ran outside the lock: place the clip on a fresh
        # read, so an edit made while it ran is kept.
        items = track_items(fresh)
        tracks0 = items[0] if items else []
        scenes = fresh.get("storyboard", {}).get("scenes", [])

        # Remove any existing clip for this scene before appending (idempotency)
        tracks0 = [c for c in tracks0 if c.get("generation", {}).get("sceneId") != scene["id"]]

        # Compute cumulative start from storyboard scene order and durations.
        # Always use storyboard scene durations, not clip outPoints, so
        # position is deterministic regardless of which clips exist or what
        # order they were generated in.
        cumulative = 0.0
        for s in scenes:
            if s["id"] == scene["id"]:
                break
            cumulative += s["duration"]
        clip["start"] = cumulative
        clip["end"] = cumulative + scene["duration"]

        tracks0.append(clip)
        tracks0.sort(key=lambda c: c.get("start", 0))
        # Assign into the document at the one key.
        fresh["tracks"] = replace_track_items(fresh, 0, tracks0)

        # Clear lastError on this scene
        for s in scenes:
            if s["id"] == scene["id"]:
                s.pop("lastError", None)

        # Check if all scenes have clips -> set draft
        scene_ids = {s["id"] for s in scenes}
        clip_ids = {c.get("generation", {}).get("sceneId") for c in tracks0}
        for c in tracks0:
            for bs in c.get("generation", {}).get("batchShots", []):
                clip_ids.add(bs.get("sceneId"))
        if scene_ids and scene_ids <= clip_ids:
            fresh["status"] = "draft"
        return fresh

    _commit_fresh(project_path, project, apply)


def _commit_fresh(project_path: Path, project: dict, apply):
    """Run `apply` on a fresh read under the project lock and write it; the
    caller's `project` dict is refreshed to what was written."""
    written = update_project_or_fail(project_path, apply, fail, indent=2, ensure_ascii=False)
    if written is not None and written is not project:
        project.clear()
        project.update(written)


def save_error_to_project(project_path: Path, project: dict, scene_id: str, error_msg: str):
    """Record lastError on a scene and save (on a fresh read, under the lock)."""
    def apply(fresh):
        for s in fresh.get("storyboard", {}).get("scenes", []):
            if s["id"] == scene_id:
                s["lastError"] = {
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "message": error_msg,
                }
        return fresh

    _commit_fresh(project_path, project, apply)
