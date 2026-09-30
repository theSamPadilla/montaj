"""Tests for steps/audio/stem_separation.py I/O.

torch, torchaudio and demucs are faked (CI's test extra has none of them), so
these run everywhere. The torchaudio fake raises the exact ImportError that
torchaudio >= 2.9 raises without torchcodec, which a fresh install hits.
"""
import contextlib
import importlib.util
import json
import subprocess
import sys
import types
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
_STEP_PATH = REPO_ROOT / "steps" / "audio" / "stem_separation.py"
sys.path.insert(0, str(REPO_ROOT / "lib"))
from common import ffmpeg_bin, ffprobe_bin  # noqa: E402

TORCHCODEC_MSG = ("TorchCodec is required for load_with_torchcodec. "
                  "Please install torchcodec to use this function.")
WEIGHTS = [0.1, 0.2, 0.3, 0.5]
SOURCES = ["drums", "bass", "other", "vocals"]


def _load_step():
    spec = importlib.util.spec_from_file_location("stem_separation_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _T:
    """Minimal tensor: numpy-backed, only what the step uses."""
    def __init__(self, a):
        self.a = a

    def __getitem__(self, i):
        return _T(self.a[i])

    def unsqueeze(self, d):
        return _T(np.expand_dims(self.a, d))

    def to(self, *_a, **_k):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.a

    @property
    def shape(self):
        return self.a.shape


def _fake_modules():
    torch = types.ModuleType("torch")
    torch.from_numpy = lambda a: _T(np.asarray(a))
    torch.device = lambda name: name
    torch.no_grad = lambda: contextlib.nullcontext()
    torch.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: False))
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)

    def _boom(*_a, **_k):
        raise ImportError(TORCHCODEC_MSG)
    torchaudio = types.ModuleType("torchaudio")
    torchaudio.load = _boom
    torchaudio.save = _boom
    torchaudio.functional = types.SimpleNamespace(resample=_boom)

    class _Model:
        samplerate = 44100
        sources = SOURCES
        def eval(self): return self
        def to(self, *_a): return self

    pretrained = types.ModuleType("demucs.pretrained")
    pretrained.get_model = lambda name: _Model()
    apply = types.ModuleType("demucs.apply")

    def apply_model(model, x, progress=False):
        a = x.a  # (1, 2, n)
        return _T(np.stack([a * w for w in WEIGHTS], axis=1))  # (1, 4, 2, n)
    apply.apply_model = apply_model
    demucs = types.ModuleType("demucs")
    demucs.pretrained = pretrained
    demucs.apply = apply
    return {"torch": torch, "torchaudio": torchaudio, "demucs": demucs,
            "demucs.pretrained": pretrained, "demucs.apply": apply}


@pytest.fixture
def fakes(monkeypatch):
    for k, v in _fake_modules().items():
        monkeypatch.setitem(sys.modules, k, v)


def _make_wav(path, lavfi, channels):
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", *lavfi,
                    "-ac", str(channels), "-ar", "48000", "-c:a", "pcm_s16le",
                    "-t", "2", str(path)], check=True)


def _decode_f32(path, channels=2):
    """Reference decode: f32 at 44.1 kHz, interleaved -> (channels, n)."""
    out = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", str(path), "-f", "f32le",
                          "-ar", "44100", "-ac", str(channels), "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(out, "<f4").reshape(-1, channels).T


def _probe(path):
    out = subprocess.run([ffprobe_bin(), "-v", "error", "-select_streams", "a:0",
                          "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
                          "-of", "json", str(path)],
                         check=True, capture_output=True, text=True).stdout
    j = json.loads(out)
    return j["streams"][0], float(j["format"]["duration"])


def test_stereo_round_trip_without_torchaudio(fakes, tmp_path):
    inp = tmp_path / "in.wav"
    # different L and R so a channel swap is caught
    _make_wav(inp, ["-f", "lavfi", "-i", "sine=f=440:d=2:r=48000",
                    "-f", "lavfi", "-i", "sine=f=660:d=2:r=48000",
                    "-filter_complex", "[0][1]amerge=inputs=2"], 2)
    mod = _load_step()
    res = mod.separate(str(inp), ["vocals"], "htdemucs", str(tmp_path / "out"))
    assert list(res) == ["vocals"]
    stream, dur = _probe(res["vocals"])
    assert stream["codec_name"] == "pcm_f32le"
    assert int(stream["sample_rate"]) == 44100
    assert int(stream["channels"]) == 2
    assert abs(dur - 2.0) <= 1 / 44100 * 1024 + 1 / 30
    got = _decode_f32(res["vocals"])
    ref = _decode_f32(inp, 2) * 0.5
    n = min(got.shape[1], ref.shape[1])
    assert abs(got.shape[1] - ref.shape[1]) <= 1
    assert np.max(np.abs(got[:, :n] - ref[:, :n])) < 1e-5
    # left and right really differ (guards the reference itself)
    assert np.max(np.abs(ref[0] - ref[1])) > 0.1


def test_mono_input_is_copied_at_full_level(fakes, tmp_path):
    inp = tmp_path / "mono.wav"
    _make_wav(inp, ["-f", "lavfi", "-i", "sine=f=440:d=2:r=48000"], 1)
    mod = _load_step()
    res = mod.separate(str(inp), ["vocals"], "htdemucs", str(tmp_path / "out"))
    got = _decode_f32(res["vocals"])
    mono = _decode_f32(inp, 1)[0]
    n = min(got.shape[1], mono.shape[0])
    assert np.max(np.abs(got[0, :n] - 0.5 * mono[:n])) < 1e-5
    assert np.max(np.abs(got[1, :n] - 0.5 * mono[:n])) < 1e-5


def test_missing_numpy_names_the_module(fakes, tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "numpy", None)
    mod = _load_step()
    inp = tmp_path / "in.wav"
    inp.write_bytes(b"x")
    monkeypatch.setattr(sys, "argv", ["stem_separation.py", "--input", str(inp),
                                      "--stems", "vocals", "--out-dir", str(tmp_path / "o"),
                                      "--out", str(tmp_path / "o.json")])
    with pytest.raises(SystemExit):
        mod.main()
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "missing_dependency"
    assert "numpy" in err["message"]


def test_mono_video_is_copied_at_full_level(fakes, tmp_path, monkeypatch):
    mov = tmp_path / "clip.mov"
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y",
                    "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=2",
                    "-f", "lavfi", "-i", "sine=f=440:d=2:r=48000",
                    "-ac", "1", "-c:a", "pcm_s16le", "-c:v", "mpeg4",
                    "-shortest", str(mov)], check=True)
    mod = _load_step()
    monkeypatch.setattr(sys, "argv", ["stem_separation.py", "--input", str(mov),
                                      "--stems", "vocals"])
    mod.main()
    got = _decode_f32(tmp_path / "clip_stems" / "vocals.wav")
    mono = _decode_f32(mov, 1)[0]
    n = min(got.shape[1], mono.shape[0])
    assert np.max(np.abs(mono[:n])) > 0.1
    assert np.max(np.abs(got[0, :n] - 0.5 * mono[:n])) < 1e-5
    assert np.max(np.abs(got[1, :n] - 0.5 * mono[:n])) < 1e-5


def test_surround_keeps_the_centre(fakes, tmp_path):
    wav = tmp_path / "c51.wav"
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi",
                    "-i", "sine=f=440:d=2:r=48000",
                    "-af", "pan=5.1|FL=0*c0|FR=0*c0|FC=c0|LFE=0*c0|BL=0*c0|BR=0*c0",
                    "-c:a", "pcm_s16le", str(wav)], check=True)
    mod = _load_step()
    res = mod.separate(str(wav), ["vocals"], "htdemucs", str(tmp_path / "o"))
    got = _decode_f32(res["vocals"])
    ref = _decode_f32(wav, 2) * 0.5  # ffmpeg's own stereo downmix
    n = min(got.shape[1], ref.shape[1])
    assert np.max(np.abs(ref[:, :n])) > 0.01
    assert np.max(np.abs(got[:, :n] - ref[:, :n])) < 1e-5
