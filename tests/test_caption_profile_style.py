"""A caption run with no style asked for draws in the profile's caption style (round 8: a profile set to
outline got pop, because neither the generate_captions step nor the caption route read the profile)."""
import asyncio
import importlib.util
import json
import os

import serve.routes.projects as projects_mod
from lib.profile_assets import profile_caption_style
from serve.routes.projects import generate_captions

STEP_PY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "steps", "transform", "generate_captions.py")
PID = "cap-profile-style"


def _step():
    spec = importlib.util.spec_from_file_location("generate_captions_step", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _profile(home, name, prefs):
    d = home / ".montaj" / "profiles" / name
    d.mkdir(parents=True)
    (d / "preferences.json").write_text(json.dumps(prefs) if isinstance(prefs, dict) else prefs)


def test_live_profile_style(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "outline"})
    assert profile_caption_style({"profile": "p1"}) == "outline"


def test_live_profile_beats_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "karaoke"})
    project = {"profile": "p1", "profileSnapshot": {"preferences": {"captionStyle": "outline"}}}
    assert profile_caption_style(project) == "karaoke"


def test_snapshot_when_no_live_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    project = {"profile": "gone", "profileSnapshot": {"preferences": {"captionStyle": "outline"}}}
    assert profile_caption_style(project) == "outline"


def test_unknown_or_missing_style_is_none(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "bad", {"captionStyle": "sparkles"})
    _profile(tmp_path, "nostyle", {"captionStyle": None})
    _profile(tmp_path, "corrupt", "{not json")
    assert profile_caption_style({"profile": "bad"}) is None
    assert profile_caption_style({"profile": "nostyle"}) is None
    assert profile_caption_style({"profile": "corrupt"}) is None
    assert profile_caption_style({}) is None
    # a corrupt live file falls back to the snapshot
    assert profile_caption_style({"profile": "corrupt", "profileSnapshot": {"preferences": {"captionStyle": "pop"}}}) == "pop"


def test_profile_name_never_leaves_the_profiles_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "preferences.json").write_text(json.dumps({"captionStyle": "outline"}))
    assert profile_caption_style({"profile": "../.."}) is None


def test_step_order(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "outline"})
    mod = _step()
    # explicit, then the track's own style, then the profile's, then the default
    assert mod.resolve_style("karaoke", {"profile": "p1", "captions": {"style": "subtitle"}}) == "karaoke"
    assert mod.resolve_style(None, {"profile": "p1", "captions": {"style": "subtitle"}}) == "subtitle"
    assert mod.resolve_style(None, {"profile": "p1"}) == "outline"
    assert mod.resolve_style(None, {"profile": "p1", "captions": {"segments": []}}) == "outline"
    assert mod.resolve_style(None, {}) == "pop"


def _route_style(tmp_path, monkeypatch, project, body):
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(json.dumps(project))
    captured = {}

    async def fake_detached(project_id, proj_dir, project, model, language, style, broadcaster, job, theme=None, who=None):
        captured["style"] = style

    monkeypatch.setattr(projects_mod, "_run_caption_detached", fake_detached)
    monkeypatch.setattr(projects_mod, "whisper_model_missing", lambda model: None)

    class Req:
        query_params = {"async": "1"}
        headers = {}

        class app:
            class state:
                broadcaster = None

        async def is_disconnected(self):
            return False

    try:
        asyncio.run(generate_captions(PID, Req(), body=body, project_dir=project_dir))
    finally:
        projects_mod._active_caption_jobs.discard(PID)
        projects_mod._caption_jobs.pop(PID, None)
    return captured["style"]


def test_route_uses_profile_style(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "outline"})
    project = {"name": "T", "profile": "p1", "tracks": [{"clips": []}]}
    assert _route_style(tmp_path, monkeypatch, project, {}) == "outline"


def test_route_body_style_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "outline"})
    project = {"name": "T", "profile": "p1", "tracks": [{"clips": []}]}
    assert _route_style(tmp_path, monkeypatch, project, {"style": "pop"}) == "pop"


# ── the profile's caption look (font, emphasis colour), as the editor seeds it ──

import re  # noqa: E402

from lib.caption_profile_look import FONT_OPTIONS, caption_look, resolve_style_and_look  # noqa: E402

FONT_PICKER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "montaj_assets", "editor", "src", "text", "FontPicker.tsx")


def test_font_options_match_the_editor():
    src = open(FONT_PICKER, encoding="utf-8").read()
    body = src[src.index("export const FONT_OPTIONS"):]
    body = body[:body.index("]\n")]
    rows = re.findall(r"label: '([^']+)', value: '([^']+)', isGoogleFont: true, spec: '([^']+)'", body)
    assert tuple(rows) == FONT_OPTIONS


def test_look_for_outline_is_the_profile_font():
    prefs = {"fontFamily": "JetBrains Mono", "captionStyle": "outline"}
    assert caption_look("outline", prefs) == {
        "fontFamily": '"JetBrains Mono", ui-monospace, monospace', "googleFonts": ["JetBrains+Mono:wght@400;700"]}


def test_look_emphasis_colour():
    assert caption_look("pop", {"accentColor": "#101010", "primaryColor": "#33ccff"}) == {"activeColor": "#33ccff"}
    assert caption_look("pop", {}) == {"activeColor": "#FF8C00"}
    assert caption_look("karaoke", {"accentColor": "#ff0000"}) == {"highlightColor": "#ff0000"}
    assert caption_look("pop", {"accentColor": "#ff0000"}, emphasis=False) == {}


def test_look_skips_font_for_subtitle_and_clean_and_unknown_fonts():
    assert caption_look("subtitle", {"fontFamily": "Inter"}) == {}
    assert caption_look("clean", {"fontFamily": "Inter"}) == {}
    assert caption_look("outline", {"fontFamily": "Comic Whatever"}) == {}
    assert caption_look("outline", {"fontFamily": "bebas neue"})["fontFamily"].startswith('"Bebas Neue"')


def test_resolve_seeds_only_a_new_track(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "outline", "fontFamily": "JetBrains Mono"})
    style, look = resolve_style_and_look(None, {"profile": "p1"})
    assert style == "outline" and look["googleFonts"] == ["JetBrains+Mono:wght@400;700"]
    # an explicit style still gets the profile's font (and, the profile having picked a style, its emphasis colour)
    style, look = resolve_style_and_look("pop", {"profile": "p1"})
    assert style == "pop" and look["fontFamily"].startswith('"JetBrains Mono"') and look["activeColor"] == "#FF8C00"
    # a track that already has a style is the person's: nothing seeded
    assert resolve_style_and_look(None, {"profile": "p1", "captions": {"style": "karaoke"}}) == ("karaoke", {})
    # a profile with a font but no caption style: the font, no emphasis colour
    _profile(tmp_path, "p2", {"fontFamily": "Inter"})
    assert resolve_style_and_look(None, {"profile": "p2"}) == ("pop", {
        "fontFamily": '"Inter", system-ui, sans-serif', "googleFonts": ["Inter:wght@400;700"]})


import pytest  # noqa: E402


@pytest.mark.parametrize("case", ["none", "uppercase", "lowercase", "capitalize"])
def test_look_caption_case_seeds_text_transform(case):
    assert caption_look("outline", {"captionCase": case})["textTransform"] == case
    assert caption_look("subtitle", {"captionCase": case}) == {"textTransform": case}
    assert caption_look("clean", {"captionCase": case}) == {"textTransform": case}
    assert caption_look("pop", {"captionCase": case}, emphasis=False) == {"textTransform": case}


@pytest.mark.parametrize("bad", ["UPPER", "", None, 3, ["uppercase"]])
def test_look_caption_case_invalid_seeds_nothing(bad):
    assert "textTransform" not in caption_look("outline", {"captionCase": bad})
    assert caption_look("subtitle", {"captionCase": bad}) == {}
    assert caption_look("subtitle", {}) == {}


def test_resolve_seeds_caption_case_only_for_a_new_track(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "pc", {"captionCase": "uppercase"})
    assert resolve_style_and_look(None, {"profile": "pc"}) == ("pop", {"textTransform": "uppercase"})
    assert resolve_style_and_look(None, {"profile": "pc", "captions": {"style": "karaoke"}}) == ("karaoke", {})


def test_route_seeds_the_profile_caption_case(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "outline", "captionCase": "lowercase"})
    project = {"name": "T", "profile": "p1", "tracks": [{"clips": []}]}
    assert _route_theme(tmp_path, monkeypatch, project, {})["textTransform"] == "lowercase"


def _route_theme(tmp_path, monkeypatch, project, body):
    project_dir = tmp_path / "proj2"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(json.dumps(project))
    captured = {}

    async def fake_detached(project_id, proj_dir, project, model, language, style, broadcaster, job, theme=None, who=None):
        captured["theme"] = theme

    monkeypatch.setattr(projects_mod, "_run_caption_detached", fake_detached)
    monkeypatch.setattr(projects_mod, "whisper_model_missing", lambda model: None)

    class Req:
        query_params = {"async": "1"}
        headers = {}

        class app:
            class state:
                broadcaster = None

        async def is_disconnected(self):
            return False

    try:
        asyncio.run(generate_captions(PID, Req(), body=body, project_dir=project_dir))
    finally:
        projects_mod._active_caption_jobs.discard(PID)
        projects_mod._caption_jobs.pop(PID, None)
    return captured["theme"]


def test_route_seeds_the_profile_look_when_no_theme_is_sent(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "outline", "fontFamily": "JetBrains Mono"})
    project = {"name": "T", "profile": "p1", "tracks": [{"clips": []}]}
    assert _route_theme(tmp_path, monkeypatch, project, {})["fontFamily"].startswith('"JetBrains Mono"')


def test_route_theme_sent_by_the_editor_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "outline", "fontFamily": "JetBrains Mono"})
    project = {"name": "T", "profile": "p1", "tracks": [{"clips": []}]}
    assert _route_theme(tmp_path, monkeypatch, project, {"theme": {"color": "#ff0000"}}) == {"color": "#ff0000"}


def test_step_writes_the_profile_style_and_font(tmp_path, monkeypatch, capsys):
    """The step's real main() with the pipeline stubbed: a project with no captions and a profile set to outline in
    JetBrains Mono gets an outline track in JetBrains Mono (round 8 got pop in the default face)."""
    import sys
    monkeypatch.setenv("HOME", str(tmp_path))
    _profile(tmp_path, "p1", {"captionStyle": "outline", "fontFamily": "JetBrains Mono"})
    mod = _step()
    pdir = tmp_path / "proj"
    pdir.mkdir()
    path = pdir / "project.json"
    path.write_text(json.dumps({
        "id": "p1", "name": "t", "profile": "p1", "settings": {"colorSpace": "sdr"},
        "tracks": [{"id": "trk-0", "items": [{"id": "c1", "type": "video", "src": str(pdir / "a.mp4"),
                                              "start": 0.0, "end": 2.0, "inPoint": 0.0, "outPoint": 2.0}]}]}))
    seen = {}
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: pdir)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda p: 1)
    monkeypatch.setattr(mod, "ink_pass", lambda p: [])

    def fake_run(cmd, **kw):
        joined = " ".join(cmd)
        if "transcribe.py" in joined:
            (pdir / "_caption_words.json").write_text("{}")
        if "caption.py" in joined:
            seen["style"] = cmd[cmd.index("--style") + 1]
            (pdir / "_caption_track.json").write_text(json.dumps({"style": seen["style"], "segments": [
                {"text": "hi", "start": 0.0, "end": 1.0, "words": [{"word": "hi", "start": 0.0, "end": 1.0}]}]}))
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1"])
    mod.main()
    cap = json.loads(path.read_text())["captions"]
    assert seen["style"] == "outline" and cap["style"] == "outline"
    assert cap["fontFamily"] == '"JetBrains Mono", ui-monospace, monospace'
    assert cap["googleFonts"] == ["JetBrains+Mono:wght@400;700"]
