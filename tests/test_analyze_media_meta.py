"""analyze_media options, usage metadata, the step's out/meta modes, and wrap_output's fallback."""
import json, subprocess, sys, types as stdlib_types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from connectors import ConnectorError
import connectors.gemini as mod
from serve.routes.steps import wrap_output

STEP = Path(__file__).resolve().parent.parent / "steps" / "media" / "analyze_media.py"


def _file():
    f = MagicMock()
    f.name = "files/abc"
    f.uri = "https://example.invalid/files/abc"
    f.mime_type = "video/mp4"
    f.state.name = "ACTIVE"
    return f


def _client(text="hello", usage=None):
    client = MagicMock()
    client.files.upload.return_value = _file()
    client.files.get.return_value = _file()
    resp = MagicMock()
    resp.text = text
    resp.usage_metadata = usage
    client.models.generate_content.return_value = resp
    return client


def _usage(**kw):
    return stdlib_types.SimpleNamespace(
        prompt_token_count=kw.get("prompt"), candidates_token_count=kw.get("output"),
        thoughts_token_count=kw.get("thinking"), total_token_count=kw.get("total"))


@pytest.fixture
def video(tmp_path):
    p = tmp_path / "v.mp4"
    p.write_bytes(b"\x00" * 64)
    return str(p)


def _use(monkeypatch, client):
    monkeypatch.setattr("connectors.gemini._client", lambda: client)


def _call_kwargs(client):
    return client.models.generate_content.call_args.kwargs


def test_config_fields_reach_generate_content(monkeypatch, video):
    client = _client()
    _use(monkeypatch, client)
    mod.analyze_media(video, "p", max_output_tokens=900, thinking_budget=0, media_resolution="low")
    cfg = _call_kwargs(client)["config"]
    assert cfg.max_output_tokens == 900
    assert cfg.thinking_config.thinking_budget == 0
    assert cfg.media_resolution.name == "MEDIA_RESOLUTION_LOW"


def test_defaults_send_no_config(monkeypatch, video):
    client = _client()
    _use(monkeypatch, client)
    mod.analyze_media(video, "p")
    assert _call_kwargs(client)["config"] is None


def test_video_fps_rides_on_the_video_part(monkeypatch, video):
    client = _client()
    _use(monkeypatch, client)
    mod.analyze_media(video, "p", video_fps=5.0)
    part = _call_kwargs(client)["contents"][0]
    assert part.video_metadata.fps == 5.0
    assert part.file_data.file_uri == "https://example.invalid/files/abc"


def test_no_fps_passes_the_uploaded_file_through(monkeypatch, video):
    client = _client()
    _use(monkeypatch, client)
    mod.analyze_media(video, "p")
    assert _call_kwargs(client)["contents"][0] is client.files.get.return_value


def test_bad_media_resolution_is_a_connector_error(monkeypatch, video):
    _use(monkeypatch, _client())
    with pytest.raises(ConnectorError):
        mod.analyze_media(video, "p", media_resolution="ultra")


def test_meta_reads_usage_with_missing_fields(monkeypatch, video):
    _use(monkeypatch, _client(usage=_usage(prompt=100, output=20, total=150)))
    r = mod.analyze_media_meta(video, "p", model="m-x")
    assert r == {"text": "hello", "model": "m-x",
                 "usage": {"prompt": 100, "output": 20, "thinking": None, "total": 150}}


def test_meta_usage_none_when_response_has_none(monkeypatch, video):
    _use(monkeypatch, _client(usage=None))
    assert mod.analyze_media_meta(video, "p")["usage"] is None


def test_analyze_media_still_returns_str(monkeypatch, video):
    _use(monkeypatch, _client(text="plain", usage=_usage(prompt=1)))
    assert mod.analyze_media(video, "p") == "plain"


# ── the step script, run in-process with the connector faked ────────────────

def _run_step(monkeypatch, capsys, tmp_path, reply, argv_extra, usage=None):
    import importlib.util
    spec = importlib.util.spec_from_file_location("analyze_media_step", STEP)
    step = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(step)
    monkeypatch.setattr(step.gemini, "analyze_media_meta",
                        lambda **kw: {"text": reply, "usage": usage, "model": kw["model"]})
    src = tmp_path / "in.mp4"
    src.write_bytes(b"\x00")
    monkeypatch.setattr(sys, "argv", ["analyze_media.py", "--input", str(src), "--prompt", "p", *argv_extra])
    step.main()
    return capsys.readouterr().out


def test_out_is_written_before_a_bad_json_check(monkeypatch, capsys, tmp_path):
    out = tmp_path / "raw.txt"
    bad = '{"a": 1,, }'
    stdout = _run_step(monkeypatch, capsys, tmp_path, bad, ["--json-output", "--out", str(out)])
    assert out.read_text() == bad
    assert stdout.strip() == str(out)


def test_meta_without_out(monkeypatch, capsys, tmp_path):
    u = {"prompt": 1, "output": 2, "thinking": 3, "total": 6}
    stdout = _run_step(monkeypatch, capsys, tmp_path, "hi", ["--meta", "--model", "m"], usage=u)
    assert json.loads(stdout) == {"text": "hi", "usage": u, "model": "m"}


def test_meta_with_out_reports_path_and_parse_error(monkeypatch, capsys, tmp_path):
    out = tmp_path / "raw.txt"
    stdout = _run_step(monkeypatch, capsys, tmp_path, '{"a": 1,, }',
                       ["--meta", "--json-output", "--out", str(out)])
    payload = json.loads(stdout)
    assert payload["path"] == str(out) and "text" not in payload
    assert payload["parseError"]
    assert out.read_text() == '{"a": 1,, }'


def test_meta_valid_json_has_no_parse_error(monkeypatch, capsys, tmp_path):
    stdout = _run_step(monkeypatch, capsys, tmp_path, '{"a": 1}', ["--meta", "--json-output"])
    assert "parseError" not in json.loads(stdout)


def test_options_reach_the_connector(monkeypatch, capsys, tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("analyze_media_step2", STEP)
    step = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(step)
    seen = {}
    monkeypatch.setattr(step.gemini, "analyze_media_meta",
                        lambda **kw: seen.update(kw) or {"text": "t", "usage": None, "model": "m"})
    src = tmp_path / "in.mp4"
    src.write_bytes(b"\x00")
    monkeypatch.setattr(sys, "argv", ["x", "--input", str(src), "--prompt", "p", "--max-output-tokens", "99",
                                      "--thinking-budget", "0", "--fps", "4", "--media-resolution", "high"])
    step.main()
    assert (seen["max_output_tokens"], seen["thinking_budget"], seen["video_fps"], seen["media_resolution"]) \
        == (99, 0, 4.0, "high")


# ── wrap_output ─────────────────────────────────────────────────────────────

def test_wrap_output_keeps_unparseable_json_like_text():
    bad = '{"a": 1,, }'
    r = wrap_output(bad + "\n", {"output": {"type": "text"}})
    assert r["text"] == bad and r["type"] == "text" and r["parseError"]


def test_wrap_output_fallback_type_defaults_to_text():
    assert wrap_output("[1,", {})["type"] == "text"


def test_wrap_output_valid_json_and_paths_unchanged():
    assert wrap_output('{"a": 1}', {}) == {"a": 1}
    assert wrap_output("/x/y.mp4", {"output": {"type": "video"}}) == {"path": "/x/y.mp4", "type": "video"}
