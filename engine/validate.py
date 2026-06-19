#!/usr/bin/env python3
"""Validate step, project, and workflow JSON files against the montaj spec."""
import argparse, json, os, re, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.types.carousel import CAROUSEL_ASPECTS, CAROUSEL_RESOLUTIONS

# Re-export existing step validation so tests can import from validate
from validate_step import validate as validate_step  # noqa: F401
from validate_step import resolve_step_path  # noqa: F401

VALID_USES_PREFIXES = {"montaj/", "user/", "./steps/"}

# `foreach` accepts any dotted identifier path — `"clips"`, `"storyboard.scenes"`,
# `"storyboard.imageRefs"`, etc. No whitelist and no predicate grammar; the agent
# decides what it means to iterate. The regex only rejects genuinely malformed
# values (empty strings, whitespace, leading dots, non-identifier characters).
FOREACH_PATH_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$")

# PRIMARY_CLIP_REQUIRED and VISUAL_ITEM_REQUIRED are currently the same set but kept
# separate — primary clips and overlay items are expected to diverge in future parts.
PRIMARY_CLIP_REQUIRED = {"id", "type", "src", "start", "end"}
VISUAL_ITEM_REQUIRED = {"id", "type", "src", "start", "end"}


_BASE_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$")
_CAROUSEL_FORBIDDEN = ("tracks", "sources", "audio", "storyboard")


def _validate_clip_extensions(data):
    """Optional clips-workflow fields: derivedFrom (top-level) + sourceCrop on video items."""
    df = data.get("derivedFrom")
    if df is not None and not isinstance(df, str):
        fail("invalid_field", "derivedFrom must be a string")
    for ti, track in enumerate(data.get("tracks", [])):
        for item in track:
            sc = item.get("sourceCrop")
            if sc is None:
                continue
            if not isinstance(sc, dict):
                fail("invalid_field", f"tracks[{ti}] item '{item.get('id','?')}': sourceCrop must be an object")
            for k in ("x", "y", "w", "h"):
                val = sc.get(k)
                if not isinstance(val, (int, float)) or not (0.0 <= float(val) <= 1.0):
                    fail("invalid_field", f"tracks[{ti}] item '{item.get('id','?')}': sourceCrop.{k} must be a number in [0,1]")


def validate_project(path):
    if not os.path.isfile(path):
        fail("file_not_found", f"File not found: {path}")

    try:
        with open(path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        fail("invalid_json", f"Invalid JSON in {path}: {e}")

    project_type = data.get("projectType")

    if project_type == "carousel":
        for field in ("version", "id", "status", "workflow", "editingPrompt", "settings", "carousel", "slides"):
            if field not in data:
                fail("missing_field", f"Missing required field: {field}")

        for key in _CAROUSEL_FORBIDDEN:
            if key in data:
                fail("invalid_carousel_field", f"carousel projects must not have '{key}' field")

        carousel = data["carousel"]
        if not isinstance(carousel, dict) or carousel.get("aspect") not in CAROUSEL_ASPECTS:
            fail("invalid_carousel", f"carousel.aspect must be one of {list(CAROUSEL_ASPECTS)}")

        slides = data["slides"]
        if not isinstance(slides, list):
            fail("invalid_slides", "slides must be an array")

        aspect = carousel["aspect"]
        expected_res = list(CAROUSEL_RESOLUTIONS[aspect])
        actual_res = list(data["settings"].get("resolution", []))
        if actual_res != expected_res:
            fail("invalid_resolution", f"settings.resolution {actual_res} does not match expected {expected_res} for aspect '{aspect}'")

        slide_ids = set()
        for si, slide in enumerate(slides):
            slide_id = slide.get("id")
            if not isinstance(slide_id, str):
                fail("missing_field", f"slides[{si}].id must be a string")
            if slide_id in slide_ids:
                fail("duplicate_slide_id", f"Duplicate slide id '{slide_id}' at slides[{si}]")
            slide_ids.add(slide_id)

            base_color = slide.get("base_color")
            if not isinstance(base_color, str) or not _BASE_COLOR_RE.match(base_color):
                fail("invalid_field", f"slides[{si}].base_color must be a 6- or 8-digit hex color")

            elements = slide.get("elements")
            if not isinstance(elements, list):
                fail("missing_field", f"slides[{si}].elements must be an array")

            el_ids = set()
            for ei, el in enumerate(elements):
                el_id = el.get("id")
                if not isinstance(el_id, str):
                    fail("missing_field", f"slides[{si}].elements[{ei}].id must be a string")
                if el_id in el_ids:
                    fail("duplicate_element_id", f"Duplicate element id '{el_id}' in slides[{si}]")
                el_ids.add(el_id)

                el_type = el.get("type")
                if el_type not in ("image", "overlay"):
                    fail("invalid_field", f"slides[{si}].elements[{ei}].type must be 'image' or 'overlay'")

                for coord in ("x", "y", "w", "h", "rotation"):
                    val = el.get(coord)
                    if not isinstance(val, (int, float)):
                        fail("missing_field", f"slides[{si}].elements[{ei}].{coord} must be a number")
                if el["w"] <= 0:
                    fail("invalid_field", f"slides[{si}].elements[{ei}].w must be > 0")
                if el["h"] <= 0:
                    fail("invalid_field", f"slides[{si}].elements[{ei}].h must be > 0")

                if el_type == "image":
                    src = el.get("src")
                    if not isinstance(src, str) or not src:
                        fail("missing_field", f"slides[{si}].elements[{ei}].src must be a non-empty string")
                    crop = el.get("crop")
                    if crop is not None:
                        if not isinstance(crop, dict):
                            fail("invalid_field", f"slides[{si}].elements[{ei}].crop must be an object")
                        for k in ("x", "y", "w", "h"):
                            v = crop.get(k)
                            if not isinstance(v, (int, float)):
                                fail("missing_field", f"slides[{si}].elements[{ei}].crop.{k} must be a number")
                            if v < 0 or v > 1:
                                fail("invalid_field", f"slides[{si}].elements[{ei}].crop.{k} must be in [0, 1]")
                        if crop["w"] <= 0 or crop["h"] <= 0:
                            fail("invalid_field", f"slides[{si}].elements[{ei}].crop w/h must be > 0")
                        if crop["x"] + crop["w"] > 1 + 1e-6 or crop["y"] + crop["h"] > 1 + 1e-6:
                            fail("invalid_field", f"slides[{si}].elements[{ei}].crop exceeds source bounds")
                elif el_type == "overlay":
                    overlay = el.get("overlay")
                    if not isinstance(overlay, dict):
                        fail("missing_field", f"slides[{si}].elements[{ei}].overlay must be an object")
                    if not isinstance(overlay.get("template"), str):
                        fail("missing_field", f"slides[{si}].elements[{ei}].overlay.template must be a string")
                    if not isinstance(overlay.get("props"), dict):
                        fail("missing_field", f"slides[{si}].elements[{ei}].overlay.props must be an object")
                    frame = el.get("frame")
                    if not isinstance(frame, (int, float)) or frame < 0:
                        fail("missing_field", f"slides[{si}].elements[{ei}].frame must be a number >= 0")

    else:
        for field in ("version", "id", "status", "workflow", "editingPrompt", "settings", "tracks"):
            if field not in data:
                fail("missing_field", f"Missing required field: {field}")

        tracks = data["tracks"]
        if not isinstance(tracks, list):
            fail("invalid_tracks", "tracks must be an array")

        for i, track in enumerate(tracks):
            if not isinstance(track, list):
                fail("invalid_tracks", f"tracks[{i}] must be an array of items, not an object")

            if i == 0:
                # Primary track: items must be type "video" with start/end.
                # Overlap is intentionally NOT checked here — primary clips can overlap
                # on the timeline; compose.js handles rendering order via itsoffset.
                for item in track:
                    for field in PRIMARY_CLIP_REQUIRED:
                        if field not in item:
                            fail("missing_field", f"tracks[0] item missing required field '{field}': {item.get('id', '?')}")
                    if item.get("type") != "video":
                        fail("invalid_primary_clip", f"tracks[0] item '{item.get('id', '?')}' must have type 'video', got '{item.get('type')}'")
                    s, e = item.get("start"), item.get("end")
                    if isinstance(s, (int, float)) and isinstance(e, (int, float)):
                        # Permit start == end == 0.0: init.py writes these as placeholders;
                        # the agent fills real values after probing the source file.
                        if not (s == 0.0 and e == 0.0) and e < s:
                            fail("invalid_field", f"tracks[0] item '{item.get('id', '?')}': end ({e}) < start ({s})")
            else:
                # Overlay tracks: standard visual item validation + overlap check
                sorted_items = sorted(track, key=lambda x: x.get("start", 0))
                prev_end = None
                for item in sorted_items:
                    for field in VISUAL_ITEM_REQUIRED:
                        if field not in item:
                            fail("missing_field", f"tracks[{i}] item missing required field '{field}': {item.get('id', '?')}")
                    if "opaque" in item and not isinstance(item["opaque"], bool):
                        fail("invalid_field", f"Visual item '{item['id']}': 'opaque' must be boolean")
                    if prev_end is not None and item["start"] < prev_end:
                        fail(
                            "visual_track_overlap",
                            f"Overlap in tracks[{i}]: item '{item['id']}' starts at {item['start']} "
                            f"but previous item ends at {prev_end}"
                        )
                    prev_end = item["end"]

        _validate_clip_extensions(data)

    return {"valid": True}


def validate_workflow(path):
    if not os.path.isfile(path):
        fail("file_not_found", f"File not found: {path}")

    try:
        with open(path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        fail("invalid_json", f"Invalid JSON in {path}: {e}")

    stem = os.path.splitext(os.path.basename(path))[0]

    for field in ("name", "description", "steps"):
        if field not in data:
            fail("missing_field", f"Missing required field: {field}")

    if data["name"] != stem:
        fail("name_mismatch", f"name '{data['name']}' does not match filename '{stem}'")

    if "requires_clips" in data and not isinstance(data["requires_clips"], bool):
        fail("invalid_field", "'requires_clips' must be boolean")

    steps = data["steps"]
    if not isinstance(steps, list):
        fail("invalid_field", "'steps' must be an array")

    step_ids = set()
    for step in steps:
        if "id" not in step:
            fail("missing_field", "Step entry missing required field 'id'")
        if "uses" not in step:
            fail("missing_field", f"Step '{step['id']}' missing required field 'uses'")
        if not any(step["uses"].startswith(p) for p in VALID_USES_PREFIXES):
            fail("invalid_uses", f"Step '{step['id']}' uses '{step['uses']}' — prefix must be montaj/, user/, or ./steps/")
        if "foreach" in step:
            value = step["foreach"]
            if not isinstance(value, str) or not FOREACH_PATH_RE.match(value):
                fail(
                    "invalid_foreach",
                    f"Step '{step['id']}': foreach must be a dotted identifier path "
                    f"(e.g. 'clips', 'storyboard.scenes'); got {value!r}",
                )
        step_ids.add(step["id"])

    # Validate needs references
    graph = {}
    for step in steps:
        needs = step.get("needs", [])
        for dep in needs:
            if dep not in step_ids:
                fail("unknown_step", f"Step '{step['id']}' needs '{dep}' which is not defined in this workflow")
        graph[step["id"]] = needs

    # DFS cycle detection
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {sid: WHITE for sid in step_ids}

    def dfs(node, path):
        color[node] = GRAY
        for neighbor in graph.get(node, []):
            if color[neighbor] == GRAY:
                cycle = " → ".join(path + [neighbor])
                fail("circular_dependency", f"Cycle detected: {cycle}")
            if color[neighbor] == WHITE:
                dfs(neighbor, path + [neighbor])
        color[node] = BLACK

    for sid in step_ids:
        if color[sid] == WHITE:
            dfs(sid, [sid])

    return {"valid": True}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="kind", required=True)

    sp = sub.add_parser("step")
    sp.add_argument("filename")

    pp = sub.add_parser("project")
    pp.add_argument("filename")

    wp = sub.add_parser("workflow")
    wp.add_argument("filename")

    args = parser.parse_args()

    if args.kind == "step":
        schema = validate_step(args.filename)
        print(json.dumps({"valid": True, "name": schema["name"]}))
    elif args.kind == "project":
        result = validate_project(args.filename)
        print(json.dumps(result))
    elif args.kind == "workflow":
        result = validate_workflow(args.filename)
        print(json.dumps(result))


if __name__ == "__main__":
    main()
