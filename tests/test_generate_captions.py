"""Unit tests for the generate_captions step's pure helpers + step discovery.

These tests deliberately avoid running mix_timeline/transcribe/caption
end-to-end (those need real media + whisper). They cover the unit-testable
caption-theme merge and style-default logic, plus the scan_steps discovery.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
from unittest.mock import Mock

import pytest

import serve.routes.projects as projects_mod

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


# ── stderr-tail regression test ──────────────────────────────────────────────

class _FakeBroadcaster:
    """Minimal broadcaster stub: records every published frame."""
    def __init__(self):
        self.frames: list[str] = []

    def publish(self, project_id: str, frame: str) -> None:
        self.frames.append(frame)


def test_caption_pipeline_stderr_tail_in_error(tmp_path):
    """When mix_timeline exits 1 (missing src), CaptionPipelineError.message
    carries the stderr tail and the fake broadcaster records it too."""
    from serve.routes.projects import _run_caption_pipeline, CaptionPipelineError

    project_dir = tmp_path / "proj"
    project_dir.mkdir()

    # Minimal project: one audible video clip pointing at a non-existent file.
    # build_audio_mix_spec accepts it (it is unmuted and has a real timeline
    # span); mix_timeline is where the missing file is caught.
    project = {
        "tracks": [[
            {
                "type": "video",
                "src": "/nonexistent/none.mov",
                "start": 0.0,
                "end": 2.0,
                "inPoint": 0.0,
                "outPoint": 2.0,
            }
        ]]
    }

    broadcaster = _FakeBroadcaster()

    with pytest.raises(CaptionPipelineError) as exc_info:
        asyncio.run(_run_caption_pipeline(
            "test-project-id",
            project_dir,
            project,
            model="base.en",
            language="auto",
            style="pop",
            broadcaster=broadcaster,
            on_log=None,
            is_disconnected=None,
        ))

    msg = exc_info.value.message
    assert "mix_timeline failed (exit 1)" in msg, f"unexpected message: {msg!r}"
    assert "--- stderr tail ---" in msg, f"stderr tail header missing: {msg!r}"
    assert "file_not_found" in msg, f"file_not_found error missing: {msg!r}"

    # The broadcaster must have recorded at least the error frame containing the tail.
    combined = "\n".join(broadcaster.frames)
    assert "--- stderr tail ---" in combined, (
        f"broadcaster did not record the tail. frames: {broadcaster.frames!r}"
    )


# ── request theme seeding (montaj-app caption profiles) ─────────────────────
#
# `serve.caption_theme.sanitize_theme`/`seed_prev` seed a profile's theme
# (fontFamily/googleFonts + the style's emphasis colour) into the saved
# caption track only where the prior track lacks a value — the prior track's
# own values still win. These tests exercise that wiring through
# `_run_caption_pipeline` (subprocess steps faked, since only the persist
# step at the end is under test) and through the route's theme sanitization.

class _FakeCaptionStream:
    """No stderr/stdout output, immediate EOF."""
    async def readline(self):
        return b""

    async def read(self):
        return b""


class _FakeCaptionProc:
    def __init__(self, returncode=0):
        self.stderr = _FakeCaptionStream()
        self.stdout = _FakeCaptionStream()
        self.returncode = returncode

    async def wait(self):
        pass


def _patch_caption_subprocess(monkeypatch):
    """Every pipeline subprocess step (mix_timeline, transcribe, caption)
    "succeeds" instantly with no output, so the pipeline reaches its persist
    step against whatever the test pre-writes to _caption_track.json."""
    proc = _FakeCaptionProc()

    async def _fake_exec(*args, **kwargs):
        return proc

    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _fake_exec)


def _audible_project(**extra):
    project = {
        "tracks": [[
            {
                "type": "video",
                "src": "/nonexistent/none.mov",
                "start": 0.0,
                "end": 2.0,
                "inPoint": 0.0,
                "outPoint": 2.0,
            }
        ]]
    }
    project.update(extra)
    return project


def test_theme_seeds_new_track_with_no_prior_captions(tmp_path, monkeypatch):
    from serve.routes.projects import _run_caption_pipeline

    _patch_caption_subprocess(monkeypatch)

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "_caption_track.json").write_text(
        json.dumps({"style": "pop", "segments": [{"text": "hi"}]})
    )

    theme = {
        "fontFamily": "Inter",
        "googleFonts": ["Inter:wght@400"],
        "highlightColor": "#0ff",
    }
    broadcaster = _FakeBroadcaster()

    track = asyncio.run(_run_caption_pipeline(
        "proj-theme-1", project_dir, _audible_project(),
        model="base.en", language="auto", style="pop",
        broadcaster=broadcaster, theme=theme,
    ))

    assert track["fontFamily"] == "Inter"
    assert track["googleFonts"] == ["Inter:wght@400"]
    assert track["highlightColor"] == "#0ff"

    saved = json.loads((project_dir / "project.json").read_text())
    assert saved["captions"]["fontFamily"] == "Inter"
    assert saved["captions"]["highlightColor"] == "#0ff"


def test_theme_does_not_override_prior_track_values(tmp_path, monkeypatch):
    """A prior track's own fontFamily wins over the theme's, and since prev
    carries fontFamily without googleFonts, the theme's googleFonts is not
    added either (they travel together)."""
    from serve.routes.projects import _run_caption_pipeline

    _patch_caption_subprocess(monkeypatch)

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "_caption_track.json").write_text(
        json.dumps({"style": "pop", "segments": [{"text": "hi"}]})
    )

    project = _audible_project(captions={"style": "pop", "fontFamily": "Roboto"})
    theme = {
        "fontFamily": "Inter",
        "googleFonts": ["Inter:wght@400"],
        "highlightColor": "#0ff",
    }
    broadcaster = _FakeBroadcaster()

    track = asyncio.run(_run_caption_pipeline(
        "proj-theme-2", project_dir, project,
        model="base.en", language="auto", style="pop",
        broadcaster=broadcaster, theme=theme,
    ))

    assert track["fontFamily"] == "Roboto"
    assert "googleFonts" not in track
    # A field prev didn't have still seeds in from the theme.
    assert track["highlightColor"] == "#0ff"


def test_pipeline_without_theme_behaves_as_before(tmp_path, monkeypatch):
    """No theme kwarg at all (the pre-existing call shape) merges exactly as
    it did before this change: prior track fields carry forward, nothing new
    is seeded."""
    from serve.routes.projects import _run_caption_pipeline

    _patch_caption_subprocess(monkeypatch)

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "_caption_track.json").write_text(
        json.dumps({"style": "pop", "segments": [{"text": "hi"}]})
    )

    project = _audible_project(captions={"style": "subtitle", "color": "#fff"})
    broadcaster = _FakeBroadcaster()

    track = asyncio.run(_run_caption_pipeline(
        "proj-theme-3", project_dir, project,
        model="base.en", language="auto", style="pop",
        broadcaster=broadcaster,
    ))

    assert track["color"] == "#fff"
    assert "fontFamily" not in track
    assert "highlightColor" not in track


def _run_generate_captions_sse(project_id, project_dir, body, monkeypatch, captured):
    from serve.routes.projects import generate_captions

    async def fake_pipeline(*args, **kwargs):
        captured["theme"] = kwargs.get("theme")
        return {"style": "pop", "segments": []}

    monkeypatch.setattr(projects_mod, "_run_caption_pipeline", fake_pipeline)

    class _FakeRequest:
        def __init__(self):
            self.query_params = {}
            self.app = Mock()
            self.app.state.broadcaster = Mock()

        async def is_disconnected(self):
            return False

    async def run():
        resp = await generate_captions(
            project_id, _FakeRequest(), body=body, project_dir=project_dir
        )
        async for _ in resp.body_iterator:
            pass

    projects_mod._active_caption_jobs.discard(project_id)
    try:
        asyncio.run(run())
    finally:
        projects_mod._active_caption_jobs.discard(project_id)


def test_route_sanitizes_theme_before_threading(tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(
        json.dumps({"name": "t", "tracks": [{"clips": []}]})
    )

    body = {
        "theme": {
            "fontFamily": "Inter",
            "googleFonts": ["Inter:wght@400"],
            "highlightColor": "#0ff",
            "notAllowed": "nope",
        },
    }
    captured: dict = {}
    _run_generate_captions_sse("proj-theme-route-1", project_dir, body, monkeypatch, captured)

    assert captured["theme"] == {
        "fontFamily": "Inter",
        "googleFonts": ["Inter:wght@400"],
        "highlightColor": "#0ff",
    }


def test_route_non_dict_theme_is_ignored(tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(
        json.dumps({"name": "t", "tracks": [{"clips": []}]})
    )

    body = {"theme": "not-a-dict"}
    captured: dict = {}
    _run_generate_captions_sse("proj-theme-route-2", project_dir, body, monkeypatch, captured)

    assert captured["theme"] == {}


def test_route_missing_theme_defaults_to_empty(tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(
        json.dumps({"name": "t", "tracks": [{"clips": []}]})
    )

    captured: dict = {}
    _run_generate_captions_sse("proj-theme-route-3", project_dir, {}, monkeypatch, captured)

    assert captured["theme"] == {}
