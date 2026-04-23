"""Tests for lib/ai_video.py — shared project helpers."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import pytest
from lib.ai_video import compose_prompt, resolve_ref_paths, parse_prompt_sections, flatten_prompt_sections, SECTION_ORDER


def _make_project(style_anchor="test style", image_refs=None):
    return {
        "storyboard": {
            "styleAnchor": style_anchor,
            "imageRefs": image_refs or [],
        }
    }


def _make_scene(prompt="A dog runs", ref_images=None, shot_scale=None, camera_move=None):
    s = {"id": "scene-1", "prompt": prompt, "duration": 5, "refImages": ref_images or []}
    if shot_scale:
        s["shotScale"] = shot_scale
    if camera_move:
        s["cameraMove"] = camera_move
    return s


def test_compose_basic():
    project = _make_project()
    scene = _make_scene()
    result = compose_prompt(project, scene)
    assert "test style" in result
    assert "A dog runs" in result


def test_compose_inline_tokens():
    project = _make_project(image_refs=[
        {"id": "ref1", "label": "Max", "refImages": ["/fake.png"]},
    ])
    scene = _make_scene(prompt="Max runs fast", ref_images=["ref1"])
    result = compose_prompt(project, scene)
    # No ref clause prefix — just inline tokens
    assert "Use the character/style from" not in result
    assert "Max <<<image_1>>> runs fast" in result


def test_compose_partial_label_match():
    """Token placement matches on first word of label when full label not found."""
    project = _make_project(image_refs=[
        {"id": "ref1", "label": "Rosie the Dog", "refImages": ["/fake.png"]},
    ])
    scene = _make_scene(prompt="Rosie the corgi wags her tail", ref_images=["ref1"])
    result = compose_prompt(project, scene)
    assert "Rosie <<<image_1>>> the corgi" in result


def test_compose_no_camera_tags_appended():
    """Camera tags are NOT appended — camera is written in prompt prose."""
    project = _make_project()
    scene = _make_scene(shot_scale="wide", camera_move="push-in")
    result = compose_prompt(project, scene)
    assert "[SHOT SCALE]" not in result
    assert "[CAMERA MOVE]" not in result


def test_compose_no_character_specs_appendix():
    """Character specs appendix was removed — prompts should not contain it."""
    project = _make_project(image_refs=[
        {"id": "ref1", "label": "Rosie the Dog", "refImages": ["/fake/dog.png"],
         "anchor": "A small playful corgi with short legs, tan and golden fur."},
    ])
    scene = _make_scene(ref_images=["ref1"])
    result = compose_prompt(project, scene)
    assert "CHARACTER/OBJECT SPECS" not in result


# ---------------------------------------------------------------------------
# Section parsing + flattening
# ---------------------------------------------------------------------------

def test_parse_sections_structured():
    prompt = """## Camera
Wide shot, camera pushes in

## Subject
Rennie at the top of the slide

## Action
She peeks over the edge

## Dialogue
(female, ~8yo, nervous) She says: "It looks high." """
    sections = parse_prompt_sections(prompt)
    assert sections["camera"] == "Wide shot, camera pushes in"
    assert sections["subject"] == "Rennie at the top of the slide"
    assert sections["action"] == "She peeks over the edge"
    assert "It looks high" in sections["dialogue"]


def test_parse_sections_legacy_flat():
    prompt = "A dog runs across a field under blue sky."
    sections = parse_prompt_sections(prompt)
    assert "_raw" in sections
    assert sections["_raw"] == prompt


def test_flatten_reorders_to_optimal():
    sections = {
        "dialogue": "She says: \"Hello.\"",
        "action": "She slides down",
        "camera": "Wide shot",
        "subject": "Rennie at the slide",
    }
    result = flatten_prompt_sections(sections)
    # Camera first, subject second, action third, dialogue last
    assert result.index("Wide shot") < result.index("Rennie at the slide")
    assert result.index("Rennie at the slide") < result.index("She slides down")
    assert result.index("She slides down") < result.index("Hello")


def test_flatten_legacy_passthrough():
    sections = {"_raw": "A dog runs."}
    assert flatten_prompt_sections(sections) == "A dog runs."


def test_flatten_unknown_sections_appended():
    sections = {
        "camera": "Wide shot",
        "custom_thing": "Some extra detail",
    }
    result = flatten_prompt_sections(sections)
    assert "Wide shot" in result
    assert "Some extra detail" in result
    # Unknown comes after known
    assert result.index("Wide shot") < result.index("Some extra detail")


def test_compose_with_structured_prompt():
    """compose_prompt should parse ## sections, reorder, and flatten."""
    project = _make_project(style_anchor="Cartoon style.")
    scene = _make_scene(prompt="""## Camera
Wide shot, camera pushes in

## Subject
A blonde girl at the slide

## Action
She looks down nervously""")
    result = compose_prompt(project, scene)
    # Should be flattened prose, not have ## headers
    assert "##" not in result
    # Camera before subject before action
    assert result.index("Wide shot") < result.index("blonde girl")
    assert result.index("blonde girl") < result.index("looks down")
    # Style anchor appended after scene content
    assert result.endswith("Cartoon style.")


def test_compose_with_structured_prompt_ref_tokens():
    """Ref tokens should be placed in the flattened prompt."""
    project = _make_project(style_anchor="", image_refs=[
        {"id": "ref1", "label": "Rennie", "refImages": ["/fake.png"]},
    ])
    scene = _make_scene(
        prompt="## Subject\nRennie sits at the top\n\n## Action\nShe looks down",
        ref_images=["ref1"],
    )
    result = compose_prompt(project, scene)
    assert "Rennie <<<image_1>>> sits at the top" in result


def test_resolve_ref_paths():
    project = _make_project(image_refs=[
        {"id": "ref1", "label": "Dog", "refImages": ["/path/dog.png"]},
        {"id": "ref2", "label": "Cat", "refImages": ["/path/cat.png"]},
    ])
    scene = _make_scene(ref_images=["ref2", "ref1"])
    paths = resolve_ref_paths(project, scene)
    assert paths == ["/path/cat.png", "/path/dog.png"]
