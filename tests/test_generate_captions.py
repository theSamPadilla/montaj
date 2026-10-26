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
    # A whisper weight is installed (the route 503s without one), whatever the host has.
    monkeypatch.setattr(projects_mod, "whisper_model_missing", lambda model: None)

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


# ── §231: captions transcribe with --fit-pauses, in both caption paths ──────

def test_route_pipeline_transcribes_with_fit_pauses(tmp_path, monkeypatch):
    from serve.routes.projects import _run_caption_pipeline

    calls = []
    proc = _FakeCaptionProc()

    async def _recording_exec(*args, **kwargs):
        calls.append([str(a) for a in args])
        return proc

    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _recording_exec)
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "_caption_track.json").write_text(json.dumps({"style": "pop", "segments": []}))

    asyncio.run(_run_caption_pipeline(
        "proj-fit", project_dir, _audible_project(),
        model="base.en", language="auto", style="pop", broadcaster=_FakeBroadcaster(),
    ))

    transcribe = [c for c in calls if any(a.endswith("transcribe.py") for a in c)]
    assert len(transcribe) == 1 and "--fit-pauses" in transcribe[0]
    assert all("--fit-pauses" not in c for c in calls if c not in transcribe)


def test_step_transcribes_with_fit_pauses(tmp_path, monkeypatch, capsys):
    mod = _load_step_module()
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(json.dumps(_audible_project()))
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append([str(a) for a in cmd])
        if any(a.endswith("caption.py") for a in cmd):
            Path(cmd[cmd.index("--out") + 1]).write_text(json.dumps({"style": "pop", "segments": []}))

    monkeypatch.setattr(mod, "get_project_dir", lambda pid: project_dir)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "build_audio_mix_spec", lambda project: {"inputs": []})
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda path: 60)
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(mod.sys, "argv", ["generate_captions.py", "--project-id", "proj"])
    mod.main()

    transcribe = [c for c in calls if any(a.endswith("transcribe.py") for a in c)]
    assert len(transcribe) == 1 and "--fit-pauses" in transcribe[0]
    assert all("--fit-pauses" not in c for c in calls if c not in transcribe)


# ── §467: the step writes only `captions`, under the project lock ────────────

def _run_step_with_human_edit(tmp_path, monkeypatch, capsys, human_edit):
    """Drive the step's real main() with the pipeline subprocesses stubbed;
    `human_edit(path)` runs while 'whisper' is working (before the step's write)."""
    import sys as _sys
    mod = _load_step_module()
    proj_dir = tmp_path / "proj"
    proj_dir.mkdir()
    path = proj_dir / "project.json"
    path.write_text(json.dumps({
        "id": "p1", "name": "orig",
        "tracks": [{"id": "trk-0", "items": [{"id": "c", "type": "video", "src": "a.mp4",
                                              "start": 0, "end": 2, "inPoint": 0, "outPoint": 2}]}],
    }))
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: proj_dir)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "build_audio_mix_spec", lambda p: {"segments": []})
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda p: 1)

    def fake_run(cmd, **kw):
        if "caption.py" in " ".join(cmd):
            (proj_dir / "_caption_track.json").write_text(json.dumps({"style": "pop", "segments": []}))
            human_edit(path)
        if "transcribe.py" in " ".join(cmd):
            (proj_dir / "_caption_words.json").write_text("{}")
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(_sys, "argv", ["generate_captions.py", "--project-id", "p1"])
    mod.main()
    return json.loads(path.read_text())


def test_step_keeps_an_edit_made_while_whisper_ran(tmp_path, monkeypatch, capsys):
    def human(path):
        doc = json.loads(path.read_text())
        doc["name"] = "renamed by hand"
        doc["tracks"][0]["items"][0]["volume"] = 0.5
        path.write_text(json.dumps(doc))

    out = _run_step_with_human_edit(tmp_path, monkeypatch, capsys, human)
    assert out["name"] == "renamed by hand"
    assert out["tracks"][0]["items"][0]["volume"] == 0.5
    assert out["captions"]["segments"] == []


def test_step_write_waits_for_the_project_lock(tmp_path, monkeypatch, capsys):
    from tests.test_project_lock import spawn_holder

    holder = {}

    def human(path):
        holder["p"] = spawn_holder(path, 0.6)       # another process is mid-write
        started[0] = __import__("time").monotonic()

    started = [0]
    out = _run_step_with_human_edit(tmp_path, monkeypatch, capsys, human)
    holder["p"].wait()
    assert __import__("time").monotonic() - started[0] >= 0.3
    assert "captions" in out


# ── caption ink: the pass after the write runs only for a project with a card, and never fails the run ─────────────

def _ink_project_doc(with_card):
    items = [{"id": "card", "type": "overlay", "src": "engine:scene3d", "start": 0, "end": 4, "opaque": True}] if with_card else []
    return {"id": "p1", "name": "orig", "settings": {"resolution": [1080, 1920], "fps": 30},
            "tracks": [{"id": "trk-0", "items": [{"id": "c", "type": "video", "src": "a.mp4", "start": 0, "end": 4,
                                                  "inPoint": 0, "outPoint": 4}]}, {"id": "ovl", "items": items}]}


def _run_step_with_ink(tmp_path, monkeypatch, capsys, with_card, renderer):
    import sys as _sys
    mod = _load_step_module()
    proj_dir = tmp_path / "proj"
    proj_dir.mkdir()
    path = proj_dir / "project.json"
    path.write_text(json.dumps(_ink_project_doc(with_card)))
    track = {"style": "pop", "segments": [{"id": "cap-1", "text": "hello", "start": 1, "end": 2, "words": []}]}
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: proj_dir)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "build_audio_mix_spec", lambda p: {"segments": []})
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda p: 1)

    def fake_run(cmd, **kw):
        if "caption.py" in " ".join(cmd):
            (proj_dir / "_caption_track.json").write_text(json.dumps(track))
        if "transcribe.py" in " ".join(cmd):
            (proj_dir / "_caption_words.json").write_text("{}")
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(mod.caption_ink, "frame_renderer", lambda project_path, out_dir, deadline=None: renderer)
    monkeypatch.setattr(_sys, "argv", ["generate_captions.py", "--project-id", "p1"])
    mod.main()
    return json.loads(path.read_text()), json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_ink_pass_runs_for_a_project_with_a_card(tmp_path, monkeypatch, capsys):
    from PIL import Image

    def light(t):
        p = tmp_path / "light.png"
        Image.new("RGB", (540, 960), (0xef, 0xec, 0xe4)).save(p)
        return str(p)
    doc, printed = _run_step_with_ink(tmp_path, monkeypatch, capsys, True, light)
    seg = doc["captions"]["segments"][0]
    assert seg["ink"] == "dark" and seg["inkAuto"] == {"card": "card", "ink": "dark"}
    assert "warnings" not in printed


def test_ink_pass_renders_nothing_for_a_project_without_a_card(tmp_path, monkeypatch, capsys):
    calls = []
    doc, printed = _run_step_with_ink(tmp_path, monkeypatch, capsys, False, lambda t: calls.append(t))
    assert calls == [] and "ink" not in doc["captions"]["segments"][0] and "warnings" not in printed


def test_ink_failure_is_a_warning_and_the_captions_stay_written(tmp_path, monkeypatch, capsys):
    def boom(t):
        raise RuntimeError("no browser")
    doc, printed = _run_step_with_ink(tmp_path, monkeypatch, capsys, True, boom)
    assert doc["captions"]["segments"][0]["text"] == "hello" and "ink" not in doc["captions"]["segments"][0]
    assert printed["warnings"] and "1.5" in printed["warnings"][0]
    assert printed["segments"][0]["id"] == "cap-1", "the caption track is still the answer"


def test_ink_pass_exception_is_a_warning(tmp_path, monkeypatch, capsys):
    mod = _load_step_module()
    monkeypatch.setattr(mod.caption_ink, "update", lambda *a, **k: (_ for _ in ()).throw(OSError("disk")))
    ws = mod.ink_pass("/nope/project.json")
    assert len(ws) == 1 and "caption_ink" in ws[0]


# ── caption ink in the serve route: after the write and broadcast, a subprocess, only with a card ──────────────────

class _InkProc(_FakeCaptionProc):
    def __init__(self, returncode=0, out=b"", err=b"", hang=False, on_run=None):
        super().__init__(returncode)
        self._out, self._err, self._hang, self._on_run = out, err, hang, on_run
        self.killed = self.waited = False

    async def communicate(self):
        if self._hang:
            await asyncio.sleep(60)
        if self._on_run:
            self._on_run()
        return self._out, self._err

    async def wait(self):
        self.waited = True

    def kill(self):
        self.killed = True


WROTE = b'{"dark": 1, "light": 0, "cleared": 0, "kept": 0, "changed": true}\n'


def _route_ink_run(tmp_path, monkeypatch, with_card, ink_proc, who=None, drain=True, segments=None):
    """(track, broadcaster, argv of every subprocess, project dir, kwargs of the ink step's spawn, ink passes still
    running when the pipeline returned)."""
    from serve.routes.projects import _run_caption_pipeline

    argvs, ink_kwargs = [], []
    monkeypatch.setattr(projects_mod, "_kill_tree", lambda p: p.kill())   # the fake has no process group

    async def exec_(*args, **kwargs):
        argvs.append([str(a) for a in args])
        if any(str(a).endswith("caption_ink.py") for a in args):
            ink_kwargs.append(kwargs)
            return ink_proc
        return _FakeCaptionProc()

    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", exec_)
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "_caption_track.json").write_text(json.dumps({"style": "pop", "segments": segments or [{"text": "hi", "start": 1, "end": 2}]}))
    project = {"tracks": [{"id": "m", "items": [{"id": "v", "type": "video", "src": "/x/a.mov", "start": 0, "end": 4,
                                                 "inPoint": 0, "outPoint": 4}]},
                          {"id": "o", "items": [{"id": "card", "type": "overlay", "src": "engine:scene3d", "start": 0,
                                                 "end": 4, "opaque": True}] if with_card else []}]}
    broadcaster = _FakeBroadcaster()

    async def run():
        track = await _run_caption_pipeline("proj-ink", project_dir, project, model="base.en", language="auto",
                                            style="pop", broadcaster=broadcaster, who=who)
        running = len(projects_mod._caption_ink_tasks)
        if not drain:
            for t in list(projects_mod._caption_ink_tasks):
                t.cancel()
        await projects_mod.drain_caption_ink_tasks()
        return track, running
    track, running = asyncio.run(run())
    return track, broadcaster, argvs, project_dir, ink_kwargs, running


def test_route_runs_the_ink_step_when_a_card_exists_and_broadcasts_the_result(tmp_path, monkeypatch):
    def ink_wrote():
        p = tmp_path / "proj" / "project.json"
        doc = json.loads(p.read_text())
        doc["captions"]["segments"][0]["ink"] = "dark"
        p.write_text(json.dumps(doc))
    track, b, calls, d, _, _ = _route_ink_run(tmp_path, monkeypatch, True, _InkProc(out=WROTE, on_run=ink_wrote))
    ink = [c for c in calls if c[1].endswith("caption_ink.py")]
    assert len(ink) == 1 and ink[0][2:] == ["--project", str(d / "project.json")]
    assert len([f for f in b.frames if f.startswith("data:")]) == 2, "the write, then the ink"
    assert '"ink": "dark"' in b.frames[-1]
    assert track["segments"][0]["text"] == "hi"


def test_route_skips_the_ink_step_without_a_card(tmp_path, monkeypatch):
    _, b, calls, _, _, _ = _route_ink_run(tmp_path, monkeypatch, False, _InkProc())
    assert not [c for c in calls if c[1].endswith("caption_ink.py")]
    assert len([f for f in b.frames if f.startswith("data:")]) == 1


def test_route_runs_the_step_to_clear_its_own_ink_when_no_card_remains(tmp_path, monkeypatch):
    own = [{"text": "hi", "start": 1, "end": 2, "ink": "dark", "inkAuto": {"card": "gone", "ink": "dark"}}]
    _, _, calls, _, _, _ = _route_ink_run(tmp_path, monkeypatch, False, _InkProc(), segments=own)
    assert [c for c in calls if c[1].endswith("caption_ink.py")]


def test_route_does_not_broadcast_again_when_the_step_wrote_nothing(tmp_path, monkeypatch):
    out = b'{"dark": 1, "light": 0, "cleared": 0, "kept": 0, "changed": false}\n'
    _, b, _, _, _, _ = _route_ink_run(tmp_path, monkeypatch, True, _InkProc(out=out))
    assert len([f for f in b.frames if f.startswith("data:")]) == 1


def test_route_gives_the_step_the_requests_write_origin_and_its_own_process_group(tmp_path, monkeypatch):
    from lib import sync_clash
    monkeypatch.setattr(sync_clash, "state_dir", lambda: "/x")
    human = projects_mod.save_guard.SyncWho("human")
    _, _, _, _, kw, _ = _route_ink_run(tmp_path, monkeypatch, True, _InkProc(), who=human)
    assert kw[0]["env"][sync_clash.ORIGIN_ENV] == "human" and kw[0]["env"]["MONTAJ_ROOT"]
    assert kw[0].get("start_new_session") is True or "creationflags" in kw[0]
    (tmp_path / "proj").rename(tmp_path / "proj2")
    _, _, _, _, kw, _ = _route_ink_run(tmp_path, monkeypatch, True, _InkProc())
    assert kw[0]["env"][sync_clash.ORIGIN_ENV] == "ai", "a request with no writer is the AI's"


def test_route_job_is_done_before_the_ink_pass_ends(tmp_path, monkeypatch):
    track, _, _, _, _, running = _route_ink_run(tmp_path, monkeypatch, True, _InkProc(hang=True), drain=False)
    assert track["segments"][0]["text"] == "hi" and running == 1, "returned with the pass still running"
    assert not projects_mod._caption_ink_tasks


@pytest.mark.parametrize("proc", [
    _InkProc(returncode=1, err=b'{"error": "project_changed"}\n'),
    _InkProc(out=b"not json"),
])
def test_route_ink_failure_is_only_a_log_event(tmp_path, monkeypatch, proc):
    track, b, _, _, _, _ = _route_ink_run(tmp_path, monkeypatch, True, proc)
    assert track["segments"][0]["text"] == "hi"
    assert len([f for f in b.frames if f.startswith("data:")]) == 1
    if proc.returncode:
        assert any(f.startswith("event: log") and "caption ink not set" in f for f in b.frames)


def test_route_ink_timeout_kills_the_tree_waits_and_is_only_a_log_event(tmp_path, monkeypatch):
    monkeypatch.setattr(projects_mod, "CAPTION_INK_TIMEOUT_S", 0.05)
    proc = _InkProc(hang=True)
    track, b, _, _, _, _ = _route_ink_run(tmp_path, monkeypatch, True, proc)
    assert proc.killed and proc.waited and track["segments"][0]["text"] == "hi"
    assert any("timed out" in f for f in b.frames)
