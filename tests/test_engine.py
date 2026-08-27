"""Unit tests for engine/resolve_workflow.py and engine/validate_step.py."""
import json
import math
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

import resolve_workflow as rw
import validate_step as vs
import validate as v


# ---------------------------------------------------------------------------
# resolve_workflow — resolve_step()
# ---------------------------------------------------------------------------

def test_resolve_step_builtin(tmp_path):
    ref = rw.resolve_step("montaj/materialize_cut", str(tmp_path))
    assert ref["kind"] == "step"
    assert Path(ref["executable"]).exists()
    assert Path(ref["schema_path"]).exists()
    assert ref["executable"].endswith("materialize_cut.py")
    assert ref["schema_path"].endswith("materialize_cut.json")


def test_resolve_step_builtin_in_subdirectory(tmp_path):
    """Built-in steps now live in subdirectories like steps/media/probe.py."""
    ref = rw.resolve_step("montaj/probe", str(tmp_path))
    assert ref["kind"] == "step"
    assert Path(ref["executable"]).exists()
    assert Path(ref["schema_path"]).exists()
    assert ref["executable"].endswith("probe.py")
    assert ref["schema_path"].endswith("probe.json")


def test_resolve_step_unknown_scope(tmp_path):
    with pytest.raises(SystemExit):
        rw.resolve_step("unknown/trim", str(tmp_path))


def test_resolve_step_missing_file(tmp_path):
    with pytest.raises(SystemExit):
        rw.resolve_step("montaj/does_not_exist", str(tmp_path))


def test_resolve_step_project_local(tmp_path):
    steps_dir = tmp_path / "steps"
    steps_dir.mkdir()
    (steps_dir / "my_step.py").write_text("# stub")
    (steps_dir / "my_step.json").write_text('{"name":"my_step"}')
    ref = rw.resolve_step("./steps/my_step", str(tmp_path))
    assert ref["kind"] == "step"
    assert ref["executable"].endswith("my_step.py")
    assert ref["schema_path"].endswith("my_step.json")


def test_resolve_step_skill_fallback_builtin(tmp_path):
    # Skills-as-steps precedent: lyrics_video.json references `montaj/lyrics-video`
    # which has no step files, only skills/lyrics-video/SKILL.md.
    ref = rw.resolve_step("montaj/lyrics-video", str(tmp_path))
    assert ref["kind"] == "skill"
    assert ref["skill_path"].endswith("skills/lyrics-video/SKILL.md")
    assert Path(ref["skill_path"]).exists()


def test_resolve_step_skill_fallback_project_local(tmp_path):
    # ./skills/<name>/SKILL.md is reachable via the ./steps/ scope prefix.
    skills_dir = tmp_path / "skills" / "my_skill"
    skills_dir.mkdir(parents=True)
    (skills_dir / "SKILL.md").write_text("# my skill")
    ref = rw.resolve_step("./steps/my_skill", str(tmp_path))
    assert ref["kind"] == "skill"
    assert ref["skill_path"].endswith("my_skill/SKILL.md")


def test_resolve_step_prefers_step_over_skill(tmp_path):
    # When both exist, the step script wins — skills-as-steps is a fallback.
    steps_dir = tmp_path / "steps"
    steps_dir.mkdir()
    (steps_dir / "dual.py").write_text("# stub")
    (steps_dir / "dual.json").write_text('{"name":"dual"}')
    skills_dir = tmp_path / "skills" / "dual"
    skills_dir.mkdir(parents=True)
    (skills_dir / "SKILL.md").write_text("# skill")
    ref = rw.resolve_step("./steps/dual", str(tmp_path))
    assert ref["kind"] == "step"


# ---------------------------------------------------------------------------
# resolve_workflow — merge_params()
# ---------------------------------------------------------------------------

def test_merge_params_applies_defaults():
    params = [{"name": "threshold", "default": -30}, {"name": "min_silence", "default": 0.3}]
    result = rw.merge_params(params, {})
    assert result == {"threshold": -30, "min_silence": 0.3}


def test_merge_params_workflow_wins():
    params = [{"name": "threshold", "default": -30}]
    result = rw.merge_params(params, {"threshold": -40})
    assert result["threshold"] == -40


def test_merge_params_no_default_skipped():
    params = [{"name": "end"}]
    result = rw.merge_params(params, {})
    assert "end" not in result


def test_merge_params_workflow_extra_keys():
    # Keys in overrides not in schema still pass through (agent-supplied values)
    result = rw.merge_params([], {"out": "/tmp/foo.mp4"})
    assert result["out"] == "/tmp/foo.mp4"


# ---------------------------------------------------------------------------
# validate_step — validate()
# ---------------------------------------------------------------------------

def _write_schema(tmp_path, name, data):
    path = tmp_path / f"{name}.json"
    path.write_text(json.dumps(data))
    return str(path)


VALID_SCHEMA = {
    "name": "my_step",
    "description": "A test step",
    "input":  {"type": "video"},
    "output": {"type": "video"},
    "params": [],
}


def test_validate_passes_for_valid_schema(tmp_path):
    path = _write_schema(tmp_path, "my_step", VALID_SCHEMA)
    schema = vs.validate(path)
    assert schema["name"] == "my_step"


def test_validate_fails_missing_name(tmp_path):
    data = {**VALID_SCHEMA}
    del data["name"]
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_name_mismatch(tmp_path):
    data = {**VALID_SCHEMA, "name": "wrong_name"}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_empty_description(tmp_path):
    data = {**VALID_SCHEMA, "description": "   "}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_invalid_input_type(tmp_path):
    data = {**VALID_SCHEMA, "input": {"type": "spreadsheet"}}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_invalid_output_type(tmp_path):
    data = {**VALID_SCHEMA, "output": {"type": "spreadsheet"}}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_enum_missing_options(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "style", "type": "enum", "description": "Style"}
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_passes_enum_with_options(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "style", "type": "enum", "description": "Style", "options": ["a", "b"]}
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    schema = vs.validate(path)
    assert schema["params"][0]["options"] == ["a", "b"]


def test_validate_fails_param_missing_field(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "x", "type": "float"}  # missing description
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_invalid_param_type(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "x", "type": "blob", "description": "test"}
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


def test_validate_fails_required_not_bool(tmp_path):
    data = {**VALID_SCHEMA, "params": [
        {"name": "x", "type": "float", "description": "test", "required": "yes"}
    ]}
    path = _write_schema(tmp_path, "my_step", data)
    with pytest.raises(SystemExit):
        vs.validate(path)


# ---------------------------------------------------------------------------
# validate_step — resolve_step_path()
# ---------------------------------------------------------------------------

def test_resolve_step_path_finds_builtin():
    path = vs.resolve_step_path("materialize_cut")
    assert path.endswith("materialize_cut.json")
    assert Path(path).exists()


def test_resolve_step_path_finds_builtin_in_subdirectory():
    """validate_step.resolve_step_path must find steps inside subdirectories."""
    path = vs.resolve_step_path("probe")
    assert path.endswith("probe.json")
    assert Path(path).exists()


def test_resolve_step_path_missing():
    with pytest.raises(SystemExit):
        vs.resolve_step_path("does_not_exist_xyz")


def test_resolve_step_path_prefers_project_local(tmp_path):
    steps_dir = tmp_path / "steps"
    steps_dir.mkdir()
    local = steps_dir / "materialize_cut.json"
    local.write_text('{"name":"materialize_cut","local":true}')
    path = vs.resolve_step_path("materialize_cut", str(tmp_path))
    assert path == str(local)


# ---------------------------------------------------------------------------
# validate_project — v0.2 unified tracks schema
# ---------------------------------------------------------------------------

VALID_PROJECT = {
    "version": "0.2",
    "id": "abc",
    "status": "pending",
    "workflow": "default",
    "editingPrompt": "test",
    "settings": {"resolution": [1080, 1920], "fps": 30},
    "tracks": [[]],
    "assets": [],
    "audio": {},
}

VALID_PRIMARY_CLIP = {
    "id": "clip-0", "type": "video", "src": "./clip.mp4",
    "start": 0.0, "end": 5.0
}


def _write_project(tmp_path, name, data):
    path = tmp_path / name
    path.write_text(json.dumps(data))
    return str(path)


def test_validate_project_passes_for_valid(tmp_path):
    path = _write_project(tmp_path, "project.json", VALID_PROJECT)
    result = v.validate_project(path)
    assert result["valid"] is True


def test_validate_project_fails_missing_version(tmp_path):
    data = {**VALID_PROJECT}; del data["version"]
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_fails_missing_tracks(tmp_path):
    data = {**VALID_PROJECT}; del data["tracks"]
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_track_object_requires_an_items_array(tmp_path):
    data = {**VALID_PROJECT, "tracks": [{"id": "x"}]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


# ── both track shapes ─────────────────────────────────────────────────────────

def test_validate_project_accepts_object_shape_tracks(tmp_path):
    data = {**VALID_PROJECT, "tracks": [
        {"id": "trk-0", "items": [VALID_PRIMARY_CLIP]},
        {"id": "trk-1", "items": [], "volume": 0.8, "muted": False, "enabled": True},
    ]}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_still_accepts_legacy_list_of_lists(tmp_path):
    data = {**VALID_PROJECT, "tracks": [[VALID_PRIMARY_CLIP], []]}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_accepts_the_two_shapes_mixed(tmp_path):
    data = {**VALID_PROJECT, "tracks": [[VALID_PRIMARY_CLIP], {"id": "trk-1", "items": []}]}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


@pytest.mark.parametrize("track", ["nope", 7, None, True])
def test_validate_project_rejects_a_track_that_is_neither_shape(tmp_path, track):
    data = {**VALID_PROJECT, "tracks": [track]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_track_object_items_must_be_a_list(tmp_path):
    data = {**VALID_PROJECT, "tracks": [{"id": "trk-0", "items": {"a": 1}}]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


@pytest.mark.parametrize("settings", [
    {"id": 7},
    {"volume": "loud"},
    {"volume": True},
    {"muted": "yes"},
    {"enabled": 1},
])
def test_validate_project_rejects_bad_track_settings(tmp_path, settings):
    track = {"id": "trk-0", "items": [], **settings}
    data = {**VALID_PROJECT, "tracks": [track]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_accepts_integer_volume(tmp_path):
    data = {**VALID_PROJECT, "tracks": [{"id": "trk-0", "items": [], "volume": 1}]}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_overlap_still_fires_on_object_shape_overlay_track(tmp_path):
    # The subject here is the TRACK SHAPE, not the overlap flavour: an object-shape
    # track is checked like a bare list. The fixture is a containment because a
    # bounded overlap is legal now — see the bounded-overlay-overlap block below.
    items = [
        {"id": "v1", "type": "overlay", "src": "./a.jsx", "start": 0.0, "end": 5.0},
        {"id": "v2", "type": "overlay", "src": "./b.jsx", "start": 1.0, "end": 3.0},
    ]
    data = {**VALID_PROJECT, "tracks": [
        {"id": "trk-0", "items": []},
        {"id": "trk-1", "items": items},
    ]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_source_crop_is_checked_on_object_shape(tmp_path):
    clip = {**VALID_PRIMARY_CLIP, "sourceCrop": {"x": 0.0, "y": 0.0, "w": 2.0, "h": 1.0}}
    data = {**VALID_PROJECT, "tracks": [{"id": "trk-0", "items": [clip]}]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_primary_clip_must_be_video_type(tmp_path):
    clip = {**VALID_PRIMARY_CLIP, "type": "overlay"}
    data = {**VALID_PROJECT, "tracks": [[clip]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_primary_clip_must_have_start(tmp_path):
    clip = {k: v for k, v in VALID_PRIMARY_CLIP.items() if k != "start"}
    data = {**VALID_PROJECT, "tracks": [[clip]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_primary_clip_must_have_end(tmp_path):
    clip = {k: v for k, v in VALID_PRIMARY_CLIP.items() if k != "end"}
    data = {**VALID_PROJECT, "tracks": [[clip]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_overlay_track_item_missing_required_field(tmp_path):
    item = {"id": "ov-0", "type": "overlay", "src": "./x.jsx", "start": 0.0}  # missing end
    data = {**VALID_PROJECT, "tracks": [[], [item]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_opaque_must_be_bool(tmp_path):
    item = {"id": "ov-0", "type": "overlay", "src": "./x.jsx", "start": 0.0, "end": 3.0, "opaque": "yes"}
    data = {**VALID_PROJECT, "tracks": [[], [item]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_rejects_overlay_containment_sharing_an_end_point(tmp_path):
    # Was `..._no_overlap_in_overlay_track`, which asserted the retired
    # any-overlap-is-an-error rule. Repointed to the boundary the new rule turns
    # on: b ends exactly where a ends, so it is contained, not a transition.
    # This is where a `>` written in place of `>=` would hide.
    items = [
        {"id": "ov-0", "type": "overlay", "src": "./a.jsx", "start": 0.0, "end": 5.0},
        {"id": "ov-1", "type": "overlay", "src": "./b.jsx", "start": 3.0, "end": 5.0},
    ]
    data = {**VALID_PROJECT, "tracks": [[], items]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_sequential_overlay_items_pass(tmp_path):
    items = [
        {"id": "ov-0", "type": "overlay", "src": "./a.jsx", "start": 0.0, "end": 3.0},
        {"id": "ov-1", "type": "overlay", "src": "./b.jsx", "start": 3.0, "end": 7.0},
    ]
    data = {**VALID_PROJECT, "tracks": [[], items]}
    path = _write_project(tmp_path, "project.json", data)
    result = v.validate_project(path)
    assert result["valid"] is True


# ── bounded overlay overlap ───────────────────────────────────────────────────

def _overlay_project(items):
    return {**VALID_PROJECT, "tracks": [[], items]}


def _visual(id_, start, end, **extra):
    item = {"id": id_, "type": "overlay", "src": "Card.jsx", "start": start, "end": end}
    item.update(extra)
    return item


def test_validate_project_allows_a_bounded_overlay_overlap(tmp_path):
    # A transition: B starts inside A, neither contains the other.
    data = _overlay_project([_visual("a", 0.0, 4.0), _visual("b", 3.0, 8.0)])
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_rejects_full_containment_on_an_overlay_track(tmp_path):
    data = _overlay_project([_visual("a", 0.0, 9.0), _visual("b", 3.0, 5.0)])
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_rejects_identical_spans_on_an_overlay_track(tmp_path):
    # Mutual containment — the "two overlays fighting for the same instant" case.
    data = _overlay_project([_visual("a", 0.0, 4.0), _visual("b", 0.0, 4.0)])
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


@pytest.mark.parametrize("order", ["outer_first", "inner_first"])
def test_validate_project_rejects_containment_when_both_share_a_start(tmp_path, order):
    # Regression: sorting by (start, end) puts the SHORTER item first when two
    # items share a start, so a one-directional "a contains b" test reads
    # (0,3) then (0,9) and lets the buried overlay through. The 3-live check
    # does not cover it either — only two items are live at t=0. Both input
    # orders are asserted so the sort, not the authoring order, is what's proven.
    outer, inner = _visual("outer", 0.0, 9.0), _visual("inner", 0.0, 3.0)
    items = [outer, inner] if order == "outer_first" else [inner, outer]
    path = _write_project(tmp_path, "project.json", _overlay_project(items))
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_rejects_three_items_live_at_the_same_instant(tmp_path):
    # Each PAIR is a legal transition; all three are live at t=3.4.
    data = _overlay_project([
        _visual("a", 0.0, 4.0), _visual("b", 3.0, 8.0), _visual("c", 3.4, 12.0),
    ])
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_three_way_overlap_names_the_three_way_rule(tmp_path, capsys):
    # Guards the *reason* for the rejection: not the old consecutive-overlap
    # message, but the one naming how many items are live at once.
    data = _overlay_project([
        _visual("a", 0.0, 4.0), _visual("b", 3.0, 8.0), _visual("c", 3.4, 12.0),
    ])
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "visual_track_overlap"
    assert "3 items are live at t=3.4" in err["message"]


def test_validate_project_containment_names_the_containment_rule(tmp_path, capsys):
    data = _overlay_project([_visual("a", 0.0, 9.0), _visual("b", 3.0, 5.0)])
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "visual_track_overlap"
    assert "fully contained by" in err["message"]


def test_validate_project_still_allows_butt_joined_overlays(tmp_path):
    # The animation-sections model: nine sections, every second covered exactly once.
    data = _overlay_project([_visual("a", 0.0, 4.0), _visual("b", 4.0, 8.0)])
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


# ── track 0 three-live check (Finding 7) ──────────────────────────────────────
# Containment stays exempt on tracks[0] — primary clips have always been free to
# overlap, compose.js orders them via itsoffset — but a three-way overlap breaks
# the pair model `activation.js`'s `crossfadesAt` / `transitions.js`'s
# `transitionPairs` are built on, on ANY track, track 0 included.

def _primary(id_, start, end, **extra):
    item = {"id": id_, "type": "video", "src": "./x.mp4", "start": start, "end": end}
    item.update(extra)
    return item


def test_validate_project_still_allows_a_bounded_overlap_on_track_0(tmp_path):
    # A pairwise overlap on the primary track is a legal transition, unchanged.
    data = {**VALID_PROJECT, "tracks": [[_primary("a", 0.0, 4.0), _primary("b", 3.0, 8.0)]]}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_still_allows_containment_on_track_0(tmp_path):
    # Containment is exempt on tracks[0] — unlike overlay tracks, this must NOT fail.
    data = {**VALID_PROJECT, "tracks": [[_primary("outer", 0.0, 9.0), _primary("inner", 3.0, 5.0)]]}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_rejects_three_items_live_at_the_same_instant_on_track_0(tmp_path):
    # Each PAIR is a legal transition; all three are live at t=3.4 — same rule
    # as the overlay-track version of this test, now proven on track 0 too.
    data = {**VALID_PROJECT, "tracks": [[
        _primary("a", 0.0, 4.0), _primary("b", 3.0, 8.0), _primary("c", 3.4, 12.0),
    ]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_track_0_three_way_overlap_names_the_three_way_rule(tmp_path, capsys):
    data = {**VALID_PROJECT, "tracks": [[
        _primary("a", 0.0, 4.0), _primary("b", 3.0, 8.0), _primary("c", 3.4, 12.0),
    ]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "visual_track_overlap"
    assert "3 items are live at t=3.4" in err["message"]


def test_validate_project_primary_clip_passes_full_valid(tmp_path):
    data = {**VALID_PROJECT, "tracks": [[VALID_PRIMARY_CLIP]]}
    path = _write_project(tmp_path, "project.json", data)
    result = v.validate_project(path)
    assert result["valid"] is True


def test_validate_project_accepts_derived_from(tmp_path):
    data = {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP}]], "derivedFrom": "src-proj-123"}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_rejects_non_string_derived_from(tmp_path):
    data = {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP}]], "derivedFrom": 123}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_accepts_valid_source_crop(tmp_path):
    clip = {**VALID_PRIMARY_CLIP, "sourceCrop": {"x": 0.25, "y": 0.0, "w": 0.5, "h": 1.0},
            "sourceWidth": 1920, "sourceHeight": 1080}
    data = {**VALID_PROJECT, "tracks": [[clip]]}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_rejects_out_of_range_source_crop(tmp_path):
    clip = {**VALID_PRIMARY_CLIP, "sourceCrop": {"x": -0.1, "y": 0.0, "w": 0.5, "h": 1.0}}
    data = {**VALID_PROJECT, "tracks": [[clip]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


# ── per-clip speed (montaj/speed) ──────────────────────────────────────────────

def test_validate_project_accepts_absent_speed(tmp_path):
    # No speed field ⇒ default 1.0 ⇒ valid (VALID_PRIMARY_CLIP has none).
    path = _write_project(tmp_path, "project.json", {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP}]]})
    assert v.validate_project(path)["valid"] is True


@pytest.mark.parametrize("speed", [0.25, 0.5, 1, 1.0, 2, 4, 4.0])
def test_validate_project_accepts_in_range_speed(tmp_path, speed):
    data = {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP, "speed": speed}]]}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


@pytest.mark.parametrize("speed", [0.24, 0, -1, 4.01, 5])
def test_validate_project_rejects_out_of_range_speed(tmp_path, speed):
    data = {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP, "speed": speed}]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


@pytest.mark.parametrize("speed", ["2", True, None])
def test_validate_project_rejects_non_number_speed(tmp_path, speed):
    # A JSON null round-trips to None, which validates as "absent" (valid); a
    # string or bool is a type error. Split so the None case asserts acceptance.
    clip = {**VALID_PRIMARY_CLIP, "speed": speed}
    data = {**VALID_PROJECT, "tracks": [[clip]]}
    path = _write_project(tmp_path, "project.json", data)
    if speed is None:
        assert v.validate_project(path)["valid"] is True
    else:
        with pytest.raises(SystemExit):
            v.validate_project(path)


# ── per-item rotation ────────────────────────────────────────────────────────

def test_validate_project_accepts_absent_rotation(tmp_path):
    # No rotation field ⇒ default 0 ⇒ valid (VALID_PRIMARY_CLIP has none).
    path = _write_project(tmp_path, "project.json", {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP}]]})
    assert v.validate_project(path)["valid"] is True


@pytest.mark.parametrize("rotation", [0, 90, 360, 720, -45, 0.5])
def test_validate_project_accepts_finite_rotation(tmp_path, rotation):
    # Range is intentionally unchecked here — a helper elsewhere normalizes
    # any finite value into [0,360) — so out-of-range values like 720 or -45
    # are still valid at this layer.
    data = {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP, "rotation": rotation}]]}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


@pytest.mark.parametrize("rotation", [math.nan, math.inf, -math.inf])
def test_validate_project_rejects_non_finite_rotation(tmp_path, rotation):
    # json.load parses NaN/Infinity into float instances, so isinstance alone
    # would accept them; math.isfinite() is what catches these.
    data = {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP, "rotation": rotation}]]}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


@pytest.mark.parametrize("rotation", ["90", [90], True, None])
def test_validate_project_rejects_non_number_rotation(tmp_path, rotation):
    # A JSON null round-trips to None, which validates as "absent" (valid); a
    # string, list, or bool is a type error. Split so the None case asserts
    # acceptance.
    clip = {**VALID_PRIMARY_CLIP, "rotation": rotation}
    data = {**VALID_PROJECT, "tracks": [[clip]]}
    path = _write_project(tmp_path, "project.json", data)
    if rotation is None:
        assert v.validate_project(path)["valid"] is True
    else:
        with pytest.raises(SystemExit):
            v.validate_project(path)


# ---------------------------------------------------------------------------
# validate_project — broll
# ---------------------------------------------------------------------------

VALID_BROLL_PROJECT = {
    **VALID_PROJECT,
    "projectType": "broll",
    "voiceover": {"src": "/abs/path/vo.wav"},
}


def test_broll_is_a_valid_project_type():
    from lib.types.project import PROJECT_TYPES, is_valid_project_type
    assert "broll" in PROJECT_TYPES
    assert is_valid_project_type("broll")


def test_validate_broll_project_passes(tmp_path):
    path = _write_project(tmp_path, "project.json", VALID_BROLL_PROJECT)
    assert v.validate_project(path)["valid"] is True


def test_validate_broll_requires_voiceover(tmp_path):
    data = {**VALID_BROLL_PROJECT}
    del data["voiceover"]
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_broll_voiceover_must_be_object(tmp_path):
    data = {**VALID_BROLL_PROJECT, "voiceover": "/abs/path/vo.wav"}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_broll_voiceover_requires_src(tmp_path):
    data = {**VALID_BROLL_PROJECT, "voiceover": {"cleanedSrc": "/abs/x.wav"}}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_broll_still_enforces_track_rules(tmp_path):
    """broll uses the standard video validator, so tracks[0] rules still apply."""
    data = {**VALID_BROLL_PROJECT}
    del data["tracks"]
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_voiceover_ignored_on_non_broll_projects(tmp_path):
    """A stray voiceover block on an editing project is not validated."""
    data = {**VALID_PROJECT, "voiceover": "whatever"}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


# ── audio.tracks ──────────────────────────────────────────────────────────────
#
# The load-bearing assertion in this block is the FIRST one: a track with no
# `end` must stay valid. That shape is what `mix-audio.js` renders as "play the
# bed for its natural length", and making the validator reject it would outlaw
# a legitimate project to paper over an editor bug. If a future change makes
# that test fail, the change is wrong, not the test.

def _audio(*tracks):
    return {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP}]], "audio": {"tracks": list(tracks)}}


def test_validate_project_audio_track_does_not_require_end(tmp_path):
    """A music bed with no `end` plays its natural length. Legal, and stays legal."""
    path = _write_project(tmp_path, "project.json", _audio({"src": "/a/song.mp3", "volume": 0.2}))
    assert v.validate_project(path)["valid"] is True


def test_validate_project_audio_track_does_not_require_start_or_id(tmp_path):
    path = _write_project(tmp_path, "project.json", _audio({"src": "/a/song.mp3"}))
    assert v.validate_project(path)["valid"] is True


def test_validate_project_audio_track_accepts_a_full_track(tmp_path):
    data = _audio({"id": "aud-0", "src": "/a/vo.wav", "volume": 1.0, "start": 0, "end": 36.4,
                   "inPoint": 0, "outPoint": 36.4, "lane": 0, "muted": False,
                   "fadeIn": 0.5, "fadeOut": 0.5})
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_audio_track_requires_src(tmp_path):
    path = _write_project(tmp_path, "project.json", _audio({"id": "aud-0", "start": 0, "end": 5}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_audio_track_rejects_empty_src(tmp_path):
    path = _write_project(tmp_path, "project.json", _audio({"src": ""}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_audio_track_rejects_zero_width_lane(tmp_path):
    """`start: 0, end: 0` — the exact shape skills/lyrics-video used to ship."""
    path = _write_project(tmp_path, "project.json",
                          _audio({"id": "music", "src": "/a/song.mp3", "start": 0, "end": 0}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_audio_track_rejects_zero_end_with_no_start(tmp_path):
    """`mix-audio.js` delays by `start ?? 0`, so this is the same zero-width lane."""
    path = _write_project(tmp_path, "project.json", _audio({"src": "/a/song.mp3", "end": 0}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


@pytest.mark.parametrize("key", ["start", "end", "volume", "inPoint", "outPoint", "fadeIn", "fadeOut"])
def test_validate_project_audio_track_rejects_negative_numbers(tmp_path, key):
    """A negative reaches ffmpeg as a malformed filter argument (adelay=-2000)."""
    path = _write_project(tmp_path, "project.json", _audio({"src": "/a/song.mp3", key: -1}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_audio_track_rejects_end_before_start(tmp_path):
    path = _write_project(tmp_path, "project.json",
                          _audio({"src": "/a/song.mp3", "start": 10, "end": 4}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


@pytest.mark.parametrize("key", ["start", "end", "volume", "inPoint", "outPoint", "fadeIn", "fadeOut"])
def test_validate_project_audio_track_numeric_fields_must_be_numbers(tmp_path, key):
    path = _write_project(tmp_path, "project.json", _audio({"src": "/a/song.mp3", key: "1.0"}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


@pytest.mark.parametrize("key", ["start", "end", "volume", "inPoint", "outPoint", "fadeIn", "fadeOut", "lane"])
def test_validate_project_audio_track_rejects_bool_for_a_number(tmp_path, key):
    """bool is a subclass of int — True must not be read as 1."""
    path = _write_project(tmp_path, "project.json", _audio({"src": "/a/song.mp3", key: True}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_audio_track_lane_must_be_an_integer(tmp_path):
    path = _write_project(tmp_path, "project.json", _audio({"src": "/a/song.mp3", "lane": 1.5}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_audio_track_muted_must_be_a_bool(tmp_path):
    path = _write_project(tmp_path, "project.json", _audio({"src": "/a/song.mp3", "muted": "yes"}))
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_audio_track_rejects_duplicate_ids(tmp_path):
    data = _audio({"id": "aud-0", "src": "/a/one.wav"}, {"id": "aud-0", "src": "/a/two.wav"})
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_audio_tracks_must_be_a_list(tmp_path):
    data = {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP}]], "audio": {"tracks": {"src": "/a.mp3"}}}
    path = _write_project(tmp_path, "project.json", data)
    with pytest.raises(SystemExit):
        v.validate_project(path)


def test_validate_project_empty_audio_object_still_valid(tmp_path):
    """`"audio": {}` is what project/init.py writes. It must stay valid."""
    data = {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP}]], "audio": {}}
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


def test_validate_project_no_audio_key_still_valid(tmp_path):
    data = {**VALID_PROJECT, "tracks": [[{**VALID_PRIMARY_CLIP}]]}
    del data["audio"]
    path = _write_project(tmp_path, "project.json", data)
    assert v.validate_project(path)["valid"] is True


# ---------------------------------------------------------------------------
# validate_workflow
# ---------------------------------------------------------------------------

VALID_WORKFLOW = {
    "name": "my_workflow",
    "description": "A test workflow",
    "steps": [
        {"id": "probe",  "uses": "montaj/probe"},
        {"id": "resize", "uses": "montaj/resize", "needs": ["probe"]},
    ]
}


def _write_workflow(tmp_path, name, data):
    path = tmp_path / f"{name}.json"
    path.write_text(json.dumps(data))
    return str(path)


def test_validate_workflow_passes_valid(tmp_path):
    path = _write_workflow(tmp_path, "my_workflow", VALID_WORKFLOW)
    result = v.validate_workflow(path)
    assert result["valid"] is True


def test_validate_workflow_fails_missing_name(tmp_path):
    data = {**VALID_WORKFLOW}; del data["name"]
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_fails_name_mismatch(tmp_path):
    data = {**VALID_WORKFLOW, "name": "wrong"}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_fails_needs_unknown_step(tmp_path):
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "resize", "uses": "montaj/resize", "needs": ["does_not_exist"]}
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_detects_cycle(tmp_path):
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "a", "uses": "montaj/probe",  "needs": ["b"]},
        {"id": "b", "uses": "montaj/resize", "needs": ["a"]},
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_requires_clips_must_be_bool(tmp_path):
    data = {**VALID_WORKFLOW, "requires_clips": "yes"}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_requires_clips_optional_true(tmp_path):
    data = {**VALID_WORKFLOW, "requires_clips": True}
    path = _write_workflow(tmp_path, "my_workflow", data)
    result = v.validate_workflow(path)
    assert result["valid"] is True


@pytest.mark.parametrize("value", [
    "clips",
    "storyboard.scenes",
    "storyboard.imageRefs",
    "storyboard.styleRefs",
    "tracks",
    "foo.bar.baz.qux",
])
def test_validate_workflow_foreach_accepts_dotted_paths(tmp_path, value):
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "x", "uses": "montaj/probe", "foreach": value}
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    result = v.validate_workflow(path)
    assert result["valid"] is True


@pytest.mark.parametrize("value", [
    "",
    "a b c",
    ".leading.dot",
    "trailing.",
    "has-dash",
    "1startsWithDigit",
    42,
    None,
])
def test_validate_workflow_foreach_rejects_bad_shape(tmp_path, value):
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "x", "uses": "montaj/probe", "foreach": value}
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


@pytest.mark.parametrize("value", [
    "clips",
    "voiceover.src",
    "assets",
    "foo.bar.baz",
])
def test_validate_workflow_input_accepts_dotted_paths(tmp_path, value):
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "x", "uses": "montaj/probe", "input": value}
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    assert v.validate_workflow(path)["valid"] is True


@pytest.mark.parametrize("value", [
    "",
    "a b c",
    ".leading.dot",
    "trailing.",
    "has-dash",
    "1startsWithDigit",
    42,
    None,
])
def test_validate_workflow_input_rejects_bad_shape(tmp_path, value):
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "x", "uses": "montaj/probe", "input": value}
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    with pytest.raises(SystemExit):
        v.validate_workflow(path)


def test_validate_workflow_input_is_optional(tmp_path):
    """Every pre-existing workflow omits `input` — it must stay optional."""
    data = {**VALID_WORKFLOW, "steps": [
        {"id": "x", "uses": "montaj/probe", "foreach": "clips"}
    ]}
    path = _write_workflow(tmp_path, "my_workflow", data)
    assert v.validate_workflow(path)["valid"] is True
