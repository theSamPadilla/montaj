#!/usr/bin/env python3
"""Validate step, project, and workflow JSON files against the montaj spec."""
import argparse, json, math, os, re, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.types.carousel import CAROUSEL_ASPECTS, CAROUSEL_RESOLUTIONS
from lib.project_tracks import track_items

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


def _orientation(w, h):
    return "landscape" if w > h else "portrait" if w < h else "square"


def _int_dim(val):
    """A recorded pixel dimension as an int, or None if it isn't one.

    `1080.0` counts (JSON round-trips whole numbers as floats); `True` does not,
    bool being a subclass of int. Anything else has no dimension to compare.
    """
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return None
    return int(val) if float(val).is_integer() else None


def _probe_display_dims(src, project_dir, cache):
    """Rotation-corrected (display_width, display_height) for `src`, or None.

    None means "don't judge this item" — an unresolvable relative path, a file
    that isn't there, an ffprobe failure, a source with no usable dims. See the
    `sourceCrop`/`sourceWidth` check in `_validate_clip_extensions` for why an
    unprobeable source is skipped rather than failed.

    `cache` is per-validation-run, keyed by resolved path: a 69-clip b-roll
    project draws from a handful of sources, so this is a handful of ffprobe
    calls rather than one per clip. It is deliberately NOT module-level — a
    long-lived process would then serve dims from before a file was replaced.
    """
    if not isinstance(src, str) or not src:
        return None
    if not os.path.isabs(src):
        # Relative `src` is relative to the project.json, never the process CWD.
        # With no project dir to resolve against, there is nothing to probe.
        if not project_dir:
            return None
        src = os.path.normpath(os.path.join(project_dir, src))
    if src in cache:
        return cache[src]

    dims = None
    if os.path.isfile(src):
        # Lazy import: `lib/normalize.py` drags in lib.types.colorspace and
        # lib.look, and the overwhelmingly common project carries no sourceCrop
        # at all. Importing at module scope would charge every validate for a
        # check that almost never runs.
        import subprocess
        from normalize import probe_video
        try:
            info = probe_video(src) or {}
        except (OSError, subprocess.SubprocessError):
            info = {}
        dw, dh, rot = info.get("display_width"), info.get("display_height"), info.get("rotation")
        if dw and dh:
            dims = (int(dw), int(dh), int(rot or 0))
    cache[src] = dims
    return dims


def _validate_clip_extensions(data, project_dir=None):
    """Optional clips-workflow fields plus per-item speed/rotation checks.

    Validates derivedFrom (top-level) and sourceCrop on video items.

    `project_dir` is the directory holding the project.json, used to resolve a
    relative item `src` for the source-dimension check below. Omit it to skip
    that check for relative paths.

    Also range-checks the optional per-clip `speed` (montaj/speed): a number in
    [0.25, 4] when present; absent means the default 1.0.

    Also validates the optional per-item `rotation` (degrees, clockwise, set by
    the editor's rotate handle): must be a finite number when present.
    `json.load` accepts `NaN`/`Infinity` as valid floats, so an isinstance
    check alone would let either through to poison the geometry math
    downstream — `math.isfinite()` catches what isinstance can't. Range is
    intentionally unchecked here: a helper elsewhere normalizes any finite
    value into [0,360)."""
    df = data.get("derivedFrom")
    if df is not None and not isinstance(df, str):
        fail("invalid_field", "derivedFrom must be a string")
    probe_cache = {}
    # The remediation command below is an instruction the agent will follow, so
    # it must name THIS project's canvas, not a hardcoded 9:16.
    _res = (data.get("settings") or {}).get("resolution")
    if (isinstance(_res, list) and len(_res) == 2
            and all(isinstance(n, (int, float)) and not isinstance(n, bool) and n > 0 for n in _res)):
        _g = math.gcd(int(_res[0]), int(_res[1])) or 1
        _target = f"{int(_res[0]) // _g}:{int(_res[1]) // _g}"
    else:
        _target = "9:16"
    for ti, items in enumerate(track_items(data)):
        for item in items:
            speed = item.get("speed")
            if speed is not None:
                # bool is a subclass of int — reject it so `True`/`False` isn't read as 1/0.
                if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not (0.25 <= float(speed) <= 4.0):
                    fail("invalid_field", f"tracks[{ti}] item '{item.get('id','?')}': speed must be a number in [0.25, 4]")

            rotation = item.get("rotation")
            if rotation is not None:
                # bool is a subclass of int — reject it, as the speed check above does.
                if isinstance(rotation, bool) or not isinstance(rotation, (int, float)) or not math.isfinite(rotation):
                    fail("invalid_field", f"tracks[{ti}] item '{item.get('id','?')}': rotation must be a finite number")

            sc = item.get("sourceCrop")
            if sc is None:
                continue
            if not isinstance(sc, dict):
                fail("invalid_field", f"tracks[{ti}] item '{item.get('id','?')}': sourceCrop must be an object")
            for k in ("x", "y", "w", "h"):
                val = sc.get(k)
                if not isinstance(val, (int, float)) or not (0.0 <= float(val) <= 1.0):
                    fail("invalid_field", f"tracks[{ti}] item '{item.get('id','?')}': sourceCrop.{k} must be a number in [0,1]")

            # Boundary invariant: the crop's frame of reference must be the frame
            # of reference the renderer will use. `sourceCrop` is a fraction of
            # `sourceWidth`/`sourceHeight`, and the renderer applies it to the
            # source AS DISPLAYED. So a reframe computed from CODED dimensions
            # crops the wrong axis: an iPhone portrait clip codes 1920x1080 with a
            # -90 rotation flag but displays 1080x1920, and a "crop this landscape
            # down to 9:16" computed off the coded 1.78 aspect becomes a ~228px
            # sliver of an already-upright frame, stretched to fill the canvas.
            # Nothing downstream notices — the crop is in [0,1], the render
            # succeeds, and the defect is only visible in the output.
            #
            # This lives here rather than in render because the agent gets it as
            # early, actionable feedback instead of a wasted export. The reframe
            # step computes these dims correctly; this catches whatever routes
            # around it — a hand-written crop, a project that arrives by PUT.
            #
            # Only items that carry a `sourceCrop` are probed (a project without
            # one pays nothing, not even the import), and only "video" items —
            # a still's recorded dims can legitimately differ from its coded ones
            # (EXIF orientation, which no displaymatrix reports).
            rw, rh = _int_dim(item.get("sourceWidth")), _int_dim(item.get("sourceHeight"))
            if item.get("type") != "video" or rw is None or rh is None:
                # Missing dims mean there is nothing to compare against. That
                # combination no-ops the crop at render time — a separate,
                # documented behaviour, not this check's business.
                continue
            dims = _probe_display_dims(item.get("src"), project_dir, probe_cache)
            if dims is None:
                # An unprobeable source is skipped, never failed: validate has
                # never been a file-existence checker, and projects are routinely
                # validated away from their media.
                continue
            dw, dh, rot = dims
            if (rw, rh) != (dw, dh):
                rot_clause = f" after its {rot} rotation" if rot else ""
                if _orientation(rw, rh) != _orientation(dw, dh):
                    diagnosis = f"the reframe was computed as if the source were {_orientation(rw, rh)}"
                else:
                    diagnosis = "the recorded dimensions are not this source's"
                fail(
                    "source_dims_mismatch",
                    f"tracks[{ti}] item '{item.get('id','?')}': source displays {dw}x{dh}{rot_clause}; "
                    f"recorded sourceWidth/sourceHeight are {rw}x{rh} — {diagnosis}. "
                    f"Recompute it with the reframe step "
                    f"(`montaj step reframe --input {item.get('src')} --target {_target}`), "
                    f"which reads rotation-corrected display dimensions."
                )


def _validate_audio_tracks(data):
    """`audio.tracks` shape check.

    **Deliberately does NOT require `end`.** A track with no `end` is legal and
    renders correctly: `montaj_assets/render/mix-audio.js` delays by
    `track.start ?? 0` and never trims on `end` (it uses `end` only to place a
    fade-out), so the source window is `inPoint`/`outPoint` alone and a music
    bed with neither plays its natural length. Requiring `end` here would
    outlaw a valid project in order to paper over an editor defect; the editor
    is fixed instead — see `audioWindow` / `groupAudioLanes` in
    `montaj_assets/editor/src/video/timeline/timeline-model.ts`.

    What IS checked is the shape. A track with no `src` renders nothing at all.
    A non-numeric `start`/`end`/`volume` reaches ffmpeg as a malformed filter
    argument. And `end <= start` is a zero- or negative-width lane, which is
    the exact defect this validator exists to catch: it is never a legitimate
    edit, and it is invisible in the editor and correct in the export, so
    nothing else will tell you about it.
    """
    audio = data.get("audio")
    if audio is None:
        return
    if not isinstance(audio, dict):
        fail("invalid_field", "'audio' must be an object")

    tracks = audio.get("tracks")
    if tracks is None:
        return
    if not isinstance(tracks, list):
        fail("invalid_field", "'audio.tracks' must be an array")

    seen_ids = set()
    for i, track in enumerate(tracks):
        if not isinstance(track, dict):
            fail("invalid_field", f"audio.tracks[{i}] must be an object")

        src = track.get("src")
        if not isinstance(src, str) or not src:
            fail("missing_field", f"audio.tracks[{i}]: 'src' must be a non-empty string")

        track_id = track.get("id")
        if track_id is not None:
            if not isinstance(track_id, str) or not track_id:
                fail("invalid_field", f"audio.tracks[{i}]: 'id' must be a non-empty string")
            if track_id in seen_ids:
                fail("duplicate_audio_track_id",
                     f"Duplicate audio track id '{track_id}' at audio.tracks[{i}]")
            seen_ids.add(track_id)

        # bool is a subclass of int — reject it so True/False isn't read as 1/0.
        for key in ("start", "end", "volume", "inPoint", "outPoint", "fadeIn", "fadeOut"):
            val = track.get(key)
            if val is None:
                continue
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                fail("invalid_field", f"audio.tracks[{i}]: '{key}' must be a number")
            # Negatives are the other half of "malformed filter argument": a
            # negative `start` reaches ffmpeg as `adelay=-2000` (mix-audio.js:66)
            # and a negative `inPoint` as `-ss -3`, neither of which ffmpeg
            # accepts. Nothing in this repo emits one.
            if val < 0:
                fail("invalid_field", f"audio.tracks[{i}]: '{key}' must be >= 0")

        lane = track.get("lane")
        if lane is not None and (isinstance(lane, bool) or not isinstance(lane, int)):
            fail("invalid_field", f"audio.tracks[{i}]: 'lane' must be an integer")

        muted = track.get("muted")
        if muted is not None and not isinstance(muted, bool):
            fail("invalid_field", f"audio.tracks[{i}]: 'muted' must be a boolean")

        # Compare against the RENDERED default, not just an explicit `start`.
        # `mix-audio.js` delays by `track.start ?? 0`, so `{"src": ..., "end": 0}`
        # with no `start` is the same zero-width lane as `start: 0, end: 0` — the
        # omitted-`start` spelling of the exact defect this check exists to catch.
        start, end = track.get("start"), track.get("end")
        base = start if isinstance(start, (int, float)) else 0
        if isinstance(end, (int, float)) and end <= base:
            fail("invalid_field",
                 f"audio.tracks[{i}]: 'end' ({end}) must be greater than 'start' ({base}); "
                 f"omit 'end' to play the source's natural length")


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

        if project_type == "broll":
            vo = data.get("voiceover")
            if vo is None:
                fail("missing_field", "broll projects require a 'voiceover' object")
            if not isinstance(vo, dict):
                fail("invalid_field", "'voiceover' must be an object")
            if not isinstance(vo.get("src"), str) or not vo["src"]:
                fail("invalid_field", "'voiceover.src' must be a non-empty string")

        tracks = data["tracks"]
        if not isinstance(tracks, list):
            fail("invalid_tracks", "tracks must be an array")

        for i, track in enumerate(tracks):
            # Both shapes are legal: a bare array of items (legacy) or a track
            # object carrying an `items` array plus optional track settings.
            if isinstance(track, list):
                items = track
            elif isinstance(track, dict):
                items = track.get("items")
                if not isinstance(items, list):
                    fail("invalid_tracks", f"tracks[{i}] must be an array of items, or an object with an 'items' array")
                if "id" in track and not isinstance(track["id"], str):
                    fail("invalid_field", f"tracks[{i}]: 'id' must be a string")
                if "volume" in track and (isinstance(track["volume"], bool) or not isinstance(track["volume"], (int, float))):
                    fail("invalid_field", f"tracks[{i}]: 'volume' must be a number")
                for key in ("muted", "enabled"):
                    if key in track and not isinstance(track[key], bool):
                        fail("invalid_field", f"tracks[{i}]: '{key}' must be a boolean")
            else:
                fail("invalid_tracks", f"tracks[{i}] must be an array of items, or an object with an 'items' array")

            if i == 0:
                # Primary track: items must be type "video" with start/end.
                # Overlap is intentionally NOT checked here — primary clips can overlap
                # on the timeline; compose.js handles rendering order via itsoffset.
                for item in items:
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
                sorted_items = sorted(items, key=lambda x: x.get("start", 0))
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

        _validate_clip_extensions(data, os.path.dirname(os.path.abspath(path)))
        _validate_audio_tracks(data)

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
        if "input" in step:
            value = step["input"]
            if not isinstance(value, str) or not FOREACH_PATH_RE.match(value):
                fail(
                    "invalid_input",
                    f"Step '{step['id']}': input must be a dotted identifier path "
                    f"(e.g. 'clips', 'voiceover.src'); got {value!r}",
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
