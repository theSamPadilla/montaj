"""Step-level tests for steps/generate/generate_music.py — PV29 T7.

Covers the new --vendor elevenlabs path (duration -> length_ms conversion,
the --duration-required precheck) and the ConnectorError.reason -> fail()
mapping for both vendors. Every test monkeypatches the connector's
generate_music directly and lib.common.get_duration (no real audio file, no
ffprobe) — the connectors' own SDK/HTTP-mocked tests cover what
generate_music() itself does. Nothing here makes a real network call.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import ConnectorError
import connectors.gemini as gemini_mod
import connectors.elevenlabs as elevenlabs_mod

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "generate_music.py"


@pytest.fixture
def step_module(monkeypatch):
    spec = importlib.util.spec_from_file_location("generate_music_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "get_duration", lambda path: 12.0)
    return mod


def _last_stderr_json(capsys):
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


class TestDefaultVendorUnchanged:
    def test_default_vendor_is_still_gemini(self, step_module, monkeypatch, capsys, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(gemini_mod, "generate_music", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "lofi", "--out", str(tmp_path / "m.mp3"), "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["vendor"] == "gemini"
        assert seen["prompt"] == "lofi"


class TestElevenLabsVendorDispatch:
    def test_duration_converts_to_length_ms(self, step_module, monkeypatch, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(elevenlabs_mod, "generate_music", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "ambient pad", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "5.5",
        ])
        step_module.main()
        assert seen["length_ms"] == 5500
        assert seen["prompt"] == "ambient pad"

    def test_duration_required_for_elevenlabs(self, step_module, monkeypatch, capsys, tmp_path):
        def boom(**kw):
            raise AssertionError("must not reach the connector")
        monkeypatch.setattr(elevenlabs_mod, "generate_music", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "ambient pad", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs",
        ])
        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 1
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_args"

    def test_model_override_passed_through(self, step_module, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(elevenlabs_mod, "generate_music", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3", "--model", "custom", "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["model"] == "custom"

    def test_default_model_reported_when_not_overridden(self, step_module, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(elevenlabs_mod, "generate_music", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3", "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["model"] == elevenlabs_mod.DEFAULT_MUSIC_MODEL

    def test_seed_and_with_vocals_not_passed_to_elevenlabs(self, step_module, monkeypatch, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(elevenlabs_mod, "generate_music", capture)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3", "--seed", "7", "--with-vocals",
        ])
        step_module.main()
        assert "seed" not in seen
        assert "instrumental" not in seen

    def test_reported_instrumental_is_none_not_true(self, step_module, monkeypatch, capsys, tmp_path):
        """PV29 review item 16: nothing about ElevenLabs music forces
        instrumental-only output (--with-vocals isn't even accepted for it —
        see test above), so the result must report `instrumental: None`,
        not the Gemini-only `not args.with_vocals` computation."""
        monkeypatch.setattr(elevenlabs_mod, "generate_music", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3", "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["instrumental"] is None


class TestConnectorErrorMapping:
    def test_gemini_invalid_api_key_uses_gemini_specific_message(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        def boom(**kw):
            err = ConnectorError("Gemini rejected the API key: bad key", reason="invalid_api_key")
            err.google_detail = "API key expired."
            raise err
        monkeypatch.setattr(gemini_mod, "generate_music", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_api_key"
        assert "Google said: API key expired." in err["message"]

    def test_elevenlabs_insufficient_credit_maps_through(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        """This is the plan-gate case: ElevenLabs music needs a paid plan."""
        def boom(**kw):
            raise ConnectorError("ElevenLabs music needs a paid plan.", reason="insufficient_credit")
        monkeypatch.setattr(elevenlabs_mod, "generate_music", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "insufficient_credit"
        assert err["message"] == "ElevenLabs music needs a paid plan."

    def test_elevenlabs_invalid_api_key_does_not_use_gemini_message(
        self, step_module, monkeypatch, capsys, tmp_path
    ):
        def boom(**kw):
            raise ConnectorError("ElevenLabs key check failed (HTTP 401): invalid key",
                                  reason="invalid_api_key")
        monkeypatch.setattr(elevenlabs_mod, "generate_music", boom)
        monkeypatch.setattr(sys, "argv", [
            "generate_music.py", "--prompt", "x", "--out", str(tmp_path / "m.mp3"),
            "--vendor", "elevenlabs", "--duration", "3",
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_api_key"
        assert err["message"] == "ElevenLabs key check failed (HTTP 401): invalid key"


class TestGeminiDurationTrim:
    """--duration applies to Gemini: a longer vendor track is trimmed (one encode,
    same codec family) with a fade-out; a shorter one is kept. The vendor call is
    mocked; the audio is a short sine made with the bundled ffmpeg."""

    @pytest.fixture
    def real_step(self):
        spec = importlib.util.spec_from_file_location("generate_music_step_real", _STEP_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    @staticmethod
    def _make(path, seconds, *codec):
        import subprocess
        from common import ffmpeg_bin
        subprocess.run([ffmpeg_bin(), "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
                        f"sine=f=440:d={seconds}", *codec, str(path)], check=True)

    def _run(self, step, monkeypatch, capsys, out, extra):
        monkeypatch.setattr(sys, "argv", ["generate_music.py", "--prompt", "x", "--out", str(out),
                                          "--json", *extra])
        step.main()
        return json.loads(capsys.readouterr().out)

    def test_longer_track_is_trimmed_with_fade(self, real_step, monkeypatch, capsys, tmp_path):
        from common import get_duration, ffmpeg_bin
        import subprocess
        out = tmp_path / "m.mp3"
        monkeypatch.setattr(gemini_mod, "generate_music",
                            lambda **kw: (self._make(kw["out_path"], 8, "-c:a", "libmp3lame"), kw["out_path"])[1])
        r = self._run(real_step, monkeypatch, capsys, out, ["--duration", "3"])
        assert r["vendorSeconds"] == pytest.approx(8.0, abs=0.1)
        assert r["seconds"] == pytest.approx(3.0, abs=0.1)
        assert get_duration(str(out)) == pytest.approx(3.0, abs=0.1)
        assert r["trimmed"] is True and r["trimCodec"] == "mp3"
        assert not list(tmp_path.glob("*.trim*"))
        # the tail fades out: last 0.1 s is far quieter than the middle
        def rms(ss, t):
            import array, math
            p = subprocess.run([ffmpeg_bin(), "-nostdin", "-v", "error", "-ss", str(ss), "-t", str(t), "-i", str(out),
                                "-ac", "1", "-f", "f32le", "-"], capture_output=True)
            a = array.array("f")
            a.frombytes(p.stdout[: len(p.stdout) // 4 * 4])
            return math.sqrt(sum(x * x for x in a) / len(a))
        assert rms(2.85, 0.15) < rms(1.0, 0.15) * 0.5

    def test_a_hung_trim_keeps_the_vendor_file_with_a_note(self, real_step, monkeypatch, capsys, tmp_path):
        import subprocess
        out = tmp_path / "m.mp3"
        monkeypatch.setattr(gemini_mod, "generate_music",
                            lambda **kw: (self._make(kw["out_path"], 4, "-c:a", "libmp3lame"), kw["out_path"])[1])
        real_run = subprocess.run

        def slow(cmd, *a, **kw):
            if "-af" in cmd:     # the trim, not ffprobe
                assert kw.get("timeout")
                open(cmd[-1], "wb").write(b"half")
                raise subprocess.TimeoutExpired(cmd, kw["timeout"])
            return real_run(cmd, *a, **kw)
        monkeypatch.setattr(real_step.subprocess, "run", slow)
        r = self._run(real_step, monkeypatch, capsys, out, ["--duration", "1"])
        assert r["trimmed"] is False and "took over" in r["note"]
        assert r["seconds"] == r["vendorSeconds"] and not list(tmp_path.glob("*.trim*"))

    def test_shorter_track_is_kept_and_noted(self, real_step, monkeypatch, capsys, tmp_path):
        out = tmp_path / "m.mp3"
        monkeypatch.setattr(gemini_mod, "generate_music",
                            lambda **kw: (self._make(kw["out_path"], 2, "-c:a", "libmp3lame"), kw["out_path"])[1])
        r = self._run(real_step, monkeypatch, capsys, out, ["--duration", "5"])
        assert r["trimmed"] is False and r["seconds"] == r["vendorSeconds"]
        assert "shorter" in r["note"]

    def test_no_duration_leaves_vendor_track_alone(self, real_step, monkeypatch, capsys, tmp_path):
        out = tmp_path / "m.mp3"
        monkeypatch.setattr(gemini_mod, "generate_music",
                            lambda **kw: (self._make(kw["out_path"], 4, "-c:a", "libmp3lame"), kw["out_path"])[1])
        r = self._run(real_step, monkeypatch, capsys, out, [])
        assert r["trimmed"] is False and r["note"] is None
        assert r["seconds"] == r["vendorSeconds"]

    def test_short_fade_scales_to_ten_percent(self, real_step, monkeypatch, capsys, tmp_path):
        out = tmp_path / "m.wav"
        monkeypatch.setattr(gemini_mod, "generate_music",
                            lambda **kw: (self._make(kw["out_path"], 4, "-c:a", "pcm_s16le"), kw["out_path"])[1])
        r = self._run(real_step, monkeypatch, capsys, out, ["--duration", "1"])
        assert r["trimCodec"] == "pcm_s16le"
        assert r["seconds"] == pytest.approx(1.0, abs=0.05)
