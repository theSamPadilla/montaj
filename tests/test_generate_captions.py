"""Unit tests for the generate_captions step's pure helpers + step discovery.

These tests deliberately avoid running materialize_cut/transcribe/caption
end-to-end (those need real media + whisper). They cover the unit-testable
caption-theme merge and style-default logic, plus the scan_steps discovery.
"""
import importlib.util
import os

import pytest

STEP_PY = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "steps", "transform", "generate_captions.py",
)


def _load_step_module():
    spec = importlib.util.spec_from_file_location("generate_captions_step", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── caption-theme merge ─────────────────────────────────────────────────────

def test_merge_carries_theme_forward():
    mod = _load_step_module()
    track = {"style": "pop", "segments": []}
    prev = {
        "style": "subtitle",
        "position": "bottom",
        "color": "#fff",
        "fontsize": 42,
        "bgColor": "#000",
    }
    merged = mod.merge_caption_theme(track, prev)
    assert merged["position"] == "bottom"
    assert merged["color"] == "#fff"
    assert merged["fontsize"] == 42
    assert merged["bgColor"] == "#000"
    # style is NOT one of the carried keys — fresh track keeps its own
    assert merged["style"] == "pop"


def test_merge_does_not_overwrite_existing():
    mod = _load_step_module()
    track = {
        "style": "pop",
        "segments": [],
        "position": "top",
        "color": "#abc",
        "fontsize": 30,
        "bgColor": "#111",
    }
    prev = {
        "position": "bottom",
        "color": "#fff",
        "fontsize": 42,
        "bgColor": "#000",
    }
    merged = mod.merge_caption_theme(track, prev)
    assert merged["position"] == "top"
    assert merged["color"] == "#abc"
    assert merged["fontsize"] == 30
    assert merged["bgColor"] == "#111"


def test_merge_with_no_prev():
    mod = _load_step_module()
    track = {"style": "pop", "segments": []}
    merged = mod.merge_caption_theme(track, {})
    assert merged == {"style": "pop", "segments": []}
    # None prev is treated as empty
    merged2 = mod.merge_caption_theme({"style": "pop", "segments": []}, None)
    assert merged2 == {"style": "pop", "segments": []}


# ── style-default resolution ────────────────────────────────────────────────

def test_resolve_style_explicit_wins():
    mod = _load_step_module()
    project = {"captions": {"style": "subtitle"}}
    assert mod.resolve_style("karaoke", project) == "karaoke"


def test_resolve_style_falls_back_to_prior():
    mod = _load_step_module()
    project = {"captions": {"style": "subtitle"}}
    assert mod.resolve_style(None, project) == "subtitle"


def test_resolve_style_defaults_to_pop():
    mod = _load_step_module()
    assert mod.resolve_style(None, {}) == "pop"
    assert mod.resolve_style(None, {"captions": None}) == "pop"
    assert mod.resolve_style(None, {"captions": {}}) == "pop"


# ── discovery ───────────────────────────────────────────────────────────────

def test_scan_steps_discovers_generate_captions():
    from serve.routes.steps import scan_steps
    assert "generate_captions" in scan_steps()
