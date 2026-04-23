"""Shared helpers for ai_video project-aware steps.

Used by kling_generate.py and eval_scene.py. Lives in lib/ so it's on
the sys.path that all step scripts set up.
"""
import json, re, time
from pathlib import Path
from common import fail


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
    """Write project JSON back to disk."""
    path.write_text(json.dumps(project, indent=2, ensure_ascii=False))


def compose_prompt(project: dict, scene: dict) -> str:
    """Compose the full Kling prompt from project context + scene prose.

    The scene prompt may be either:
    - **Structured** (## headers): parsed into sections, reordered to optimal
      Kling sequence (Camera → Subject → Action → Dialogue → Environment → Mood),
      then flattened into flowing prose.
    - **Legacy flat string**: used as-is.

    In both cases, the step then applies:
    - styleAnchor prefix
    - Ref clause + inline <<<image_N>>> tokens at label positions
    - [SHOT SCALE] / [CAMERA MOVE] tags from structured scene fields
    - CHARACTER/OBJECT SPECS section from imageRefs[i].anchor
    """
    style_anchor = project.get("storyboard", {}).get("styleAnchor", "")
    image_refs = {r["id"]: r for r in project.get("storyboard", {}).get("imageRefs", [])}

    # Parse and flatten sections
    sections = parse_prompt_sections(scene["prompt"])
    prompt = flatten_prompt_sections(sections)

    ref_ids = scene.get("refImages", [])

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
                         seed: int = None):
    """Append the generated clip to tracks[0] and save the project."""
    tracks0 = project.get("tracks", [[]])[0]
    scenes = project.get("storyboard", {}).get("scenes", [])

    # Remove any existing clip for this scene before appending (idempotency)
    tracks0 = [c for c in tracks0 if c.get("generation", {}).get("sceneId") != scene["id"]]

    # Compute cumulative start from storyboard scene order and durations.
    # Always use storyboard scene durations — not clip outPoints — so
    # position is deterministic regardless of which clips exist or what
    # order they were generated in.
    scene_order = [s["id"] for s in scenes]
    scene_durations = {s["id"]: s["duration"] for s in scenes}
    cumulative = 0.0
    for sid in scene_order:
        if sid == scene["id"]:
            break
        cumulative += scene_durations.get(sid, 0)

    clip = {
        "id": f"clip-{scene['id']}",
        "type": "video",
        "src": out_path,
        "start": cumulative,
        "end": cumulative + scene["duration"],
        "inPoint": 0,
        "outPoint": scene["duration"],
        "generation": {
            "sceneId": scene["id"],
            "provider": "kling",
            "model": model,
            "prompt": composed_prompt,
            "refImages": scene.get("refImages", []),
            "duration": scene["duration"],
            "seed": seed,
            "attempts": [],
        },
    }
    tracks0.append(clip)
    tracks0.sort(key=lambda c: c.get("start", 0))
    project["tracks"][0] = tracks0

    # Clear lastError on this scene
    for s in scenes:
        if s["id"] == scene["id"]:
            s.pop("lastError", None)

    # Check if all scenes have clips → set draft
    scene_ids = {s["id"] for s in scenes}
    clip_ids = {c.get("generation", {}).get("sceneId") for c in tracks0}
    for c in tracks0:
        for bs in c.get("generation", {}).get("batchShots", []):
            clip_ids.add(bs.get("sceneId"))
    if scene_ids and scene_ids <= clip_ids:
        project["status"] = "draft"

    save_project(project_path, project)


def save_error_to_project(project_path: Path, project: dict, scene_id: str, error_msg: str):
    """Record lastError on a scene and save."""
    for s in project.get("storyboard", {}).get("scenes", []):
        if s["id"] == scene_id:
            s["lastError"] = {
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "message": error_msg,
            }
    save_project(project_path, project)
