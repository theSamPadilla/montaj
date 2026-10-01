import os

import cli.commands.doctor as doctor


def test_resolve_source_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("MONTAJ_FFMPEG", "/some/override/ffmpeg")
    monkeypatch.setattr(doctor, "_managed_ffmpeg_dir", lambda: str(tmp_path / "managed"))
    monkeypatch.setattr(doctor, "_bundled_av_dir", lambda: str(tmp_path / "bundled"))

    result = doctor._resolve_source("/some/override/ffmpeg", "MONTAJ_FFMPEG")

    assert result == "MONTAJ_FFMPEG override"


def test_resolve_source_managed(tmp_path, monkeypatch):
    monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
    managed_dir = tmp_path / "managed"
    monkeypatch.setattr(doctor, "_managed_ffmpeg_dir", lambda: str(managed_dir))
    monkeypatch.setattr(doctor, "_bundled_av_dir", lambda: str(tmp_path / "bundled"))
    resolved = str(managed_dir / "ffmpeg")

    result = doctor._resolve_source(resolved, "MONTAJ_FFMPEG")

    assert result == f"managed: {resolved}"


def test_resolve_source_bundled(tmp_path, monkeypatch):
    monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
    bundled_dir = tmp_path / "bundled"
    monkeypatch.setattr(doctor, "_managed_ffmpeg_dir", lambda: str(tmp_path / "managed"))
    monkeypatch.setattr(doctor, "_bundled_av_dir", lambda: str(bundled_dir))
    resolved = str(bundled_dir / "ffmpeg")

    result = doctor._resolve_source(resolved, "MONTAJ_FFMPEG")

    assert result == f"bundled with Homebrew: {resolved}"


def test_resolve_source_system_path(tmp_path, monkeypatch):
    monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
    monkeypatch.setattr(doctor, "_managed_ffmpeg_dir", lambda: str(tmp_path / "managed"))
    monkeypatch.setattr(doctor, "_bundled_av_dir", lambda: str(tmp_path / "bundled"))

    result = doctor._resolve_source("ffmpeg", "MONTAJ_FFMPEG")

    assert result == "system PATH"


def test_resolve_source_unknown_absolute_path_not_mislabeled(tmp_path, monkeypatch):
    """An absolute path that matches neither the managed nor bundled dir
    (e.g. a hand-built ffmpeg someone points MONTAJ_FFMPEG-less config at)
    must not be silently mislabeled as 'managed' or 'bundled' — it should
    fall back to a neutral label that still shows the path."""
    monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
    monkeypatch.setattr(doctor, "_managed_ffmpeg_dir", lambda: str(tmp_path / "managed"))
    monkeypatch.setattr(doctor, "_bundled_av_dir", lambda: str(tmp_path / "bundled"))
    resolved = str(tmp_path / "somewhere-else" / "ffmpeg")

    result = doctor._resolve_source(resolved, "MONTAJ_FFMPEG")

    assert "managed:" not in result
    assert "bundled" not in result
    assert resolved in result


def test_doctor_still_reports_the_missing_whisper_model(tmp_path, monkeypatch, capsys):
    # serve now starts without the model (PL20); doctor must keep naming it.
    import types
    import models as _models
    from cli import deps

    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.setattr(deps, "LEGACY_WHISPER_MODELS_DIR", str(tmp_path / "legacy"))
    monkeypatch.setattr(doctor, "whisper_bin_path", lambda: "/fake/whisper-cli")
    monkeypatch.setattr(doctor, "_check_av_binary", lambda name, resolved: (f"/fake/{name}", name))
    monkeypatch.setattr(doctor, "_check_ffmpeg_filters",
                        lambda path: (doctor.REQUIRED_FFMPEG_FILTERS, [], []))
    monkeypatch.setattr(doctor, "_check_binary", lambda name: (f"/fake/{name}", name))
    monkeypatch.setattr(doctor, "check_ui", lambda: ("dev", None))

    doctor.handle(types.SimpleNamespace())

    out = capsys.readouterr().out
    assert "model: large-v3-turbo-q5_0" in out
    assert "not downloaded" in out
