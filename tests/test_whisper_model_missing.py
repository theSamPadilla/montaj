"""Whisper steps without the whisper model (PL20).

The Montaj App starts `serve` before its whisper model has been downloaded, so
every path that runs whisper must fail with ONE distinct error code,
`whisper_model_missing`, rather than a generic `file_not_found`: the app maps
that code to "still preparing speech" wherever it surfaces. `GET /api/steps`
also says which steps run whisper (`runsWhisper`), so the app builds its gate
list from serve itself.
"""
import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

import common
import lib.common
import models
import serve.routes.projects as projects_mod
from lib.common import DEFAULT_WHISPER_MODEL, ffmpeg_bin, ffprobe_bin
from serve.server import app
from tests.conftest import assert_error, run_step_env

REPO_ROOT = Path(__file__).parent.parent
WHISPER_STEPS = {"transcribe", "rm_nonspeech", "rm_fillers", "lyrics_sync", "generate_captions"}
PID = "66666666-6666-4666-8666-666666666666"


@pytest.fixture
def no_model_env(tmp_path, fake_whisper_env):
    """Env for a step subprocess on a machine with the whisper binary (the fake
    on PATH) and no whisper weight anywhere: HOME is a scratch dir, so both the
    managed models dir and the legacy whisper.cpp dir are empty."""
    home = tmp_path / "home"
    home.mkdir()
    return {
        **fake_whisper_env,
        "HOME": str(home),
        "USERPROFILE": str(home),
        "MONTAJ_FFMPEG": ffmpeg_bin(),
        "MONTAJ_FFPROBE": ffprobe_bin(),
    }


@pytest.fixture
def no_weights(tmp_path, monkeypatch):
    """In-process: no whisper weight installed, in either module copy of common."""
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.setattr(common, "LEGACY_WHISPER_DIR", str(tmp_path / "no-legacy"))
    monkeypatch.setattr(lib.common, "LEGACY_WHISPER_DIR", str(tmp_path / "no-legacy"))

    def install(*names):
        wdir = tmp_path / "models" / "whisper"
        wdir.mkdir(parents=True, exist_ok=True)
        for n in names:
            (wdir / f"ggml-{n}.bin").write_bytes(b"x")
        return wdir
    return install


def _assert_model_missing(proc, model=DEFAULT_WHISPER_MODEL):
    assert_error(proc, "whisper_model_missing")
    assert model in json.loads(proc.stderr)["message"]


# ── the steps ────────────────────────────────────────────────────────────────

def test_transcribe_without_the_model(test_video, no_model_env):
    proc = run_step_env("transcribe.py", no_model_env, "--input", str(test_video))
    _assert_model_missing(proc)


def test_transcribe_without_any_model_for_another_language(test_video, no_model_env):
    # Nothing installed at all is the missing model, not a missing multilingual one.
    proc = run_step_env("transcribe.py", no_model_env,
                        "--input", str(test_video), "--model", "base.en", "--language", "es")
    _assert_model_missing(proc, "base.en")


def test_rm_nonspeech_without_the_model(test_video, no_model_env):
    proc = run_step_env("rm_nonspeech.py", no_model_env, "--input", str(test_video))
    _assert_model_missing(proc)


def test_rm_fillers_without_the_model(test_video, no_model_env):
    proc = run_step_env("rm_fillers.py", no_model_env, "--input", str(test_video))
    _assert_model_missing(proc)


def test_lyrics_sync_without_the_model(test_video, no_model_env, tmp_path):
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text("hello world\n")
    proc = run_step_env("lyrics_sync.py", no_model_env,
                        "--input", str(test_video), "--lyrics", str(lyrics))
    _assert_model_missing(proc)


def test_generate_captions_without_the_model_fails_before_mixing(tmp_path, monkeypatch, capsys, no_weights):
    spec = importlib.util.spec_from_file_location(
        "generate_captions_step", REPO_ROOT / "steps" / "transform" / "generate_captions.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(json.dumps({"name": "t", "tracks": [{"clips": []}]}))
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: project_dir)
    calls = []
    monkeypatch.setattr(mod, "run", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1"])

    with pytest.raises(SystemExit):
        mod.main()

    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "whisper_model_missing"
    assert DEFAULT_WHISPER_MODEL in err["message"]
    assert calls == []


def test_transcribe_words_without_the_model(tmp_path, monkeypatch, capsys, no_weights):
    # rm_nonspeech and rm_fillers transcribe through this helper.
    monkeypatch.setattr(common, "run", lambda *a, **k: pytest.fail("ran a subprocess"))
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF....WAVE")

    with pytest.raises(SystemExit):
        common.transcribe_words(str(wav), work_dir=str(tmp_path))

    assert json.loads(capsys.readouterr().err)["error"] == "whisper_model_missing"


def test_an_installed_weight_still_resolves(no_weights):
    wdir = no_weights("base.en")
    assert common.require_whisper_model(DEFAULT_WHISPER_MODEL, "en") == (
        "base.en", str(wdir / "ggml-base.en.bin"))


# ── POST /api/projects/{id}/captions ─────────────────────────────────────────

class _FakeRequest:
    def __init__(self, query):
        self.query_params = query
        self.app = Mock()

    async def is_disconnected(self):
        return False


@pytest.mark.parametrize("query", [{"async": "1"}, {}], ids=["async", "sse"])
def test_captions_route_without_the_model(tmp_path, monkeypatch, no_weights, query):
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text(json.dumps({"name": "t", "tracks": [{"clips": []}]}))
    started = []

    async def fake_run(*a, **k):
        started.append(1)

    monkeypatch.setattr(projects_mod, "_run_caption_detached", fake_run)
    monkeypatch.setattr(projects_mod, "_run_caption_pipeline", fake_run)
    projects_mod._active_caption_jobs.discard(PID)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(projects_mod.generate_captions(
            PID, _FakeRequest(query), body={}, project_dir=project_dir))

    assert exc.value.status_code == 503
    assert exc.value.detail["error"] == "whisper_model_missing"
    assert DEFAULT_WHISPER_MODEL in exc.value.detail["message"]
    assert PID not in projects_mod._active_caption_jobs
    assert started == []


# ── GET /api/steps ───────────────────────────────────────────────────────────

def test_api_steps_reports_runs_whisper(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))  # no custom steps from ~/.montaj/steps
    monkeypatch.setenv("USERPROFILE", str(tmp_path))

    resp = TestClient(app).get("/api/steps")

    assert resp.status_code == 200
    steps = resp.json()
    assert all(isinstance(s.get("runsWhisper"), bool) for s in steps)
    assert {s["name"] for s in steps if s["runsWhisper"]} == WHISPER_STEPS
