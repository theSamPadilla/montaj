import json, subprocess, sys, wave
from tests.conftest import REPO_ROOT

STEP = REPO_ROOT / "steps" / "audio" / "synth_audio.py"


def _run(tmp_path, cues, *extra):
    cf = tmp_path / "cues.json"
    cf.write_text(json.dumps(cues))
    out = tmp_path / "out.wav"
    proc = subprocess.run([sys.executable, str(STEP), "--cues", str(cf), "--out", str(out), *extra],
                          capture_output=True, text=True, timeout=120)
    return proc, out


def test_writes_48k_stereo_16bit_of_the_requested_length(tmp_path):
    proc, out = _run(tmp_path, {"duration": 2.0, "cues": [{"t": 0, "voice": "kick"}, {"t": 0.5, "voice": "hat"}]})
    assert proc.returncode == 0, proc.stderr
    with wave.open(str(out)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (48000, 2, 2)
        assert w.getnframes() == 96000


def test_length_defaults_to_last_cue_end_plus_tail(tmp_path):
    proc, out = _run(tmp_path, {"cues": [{"t": 1.0, "voice": "pad", "dur": 1.0}]})
    assert proc.returncode == 0, proc.stderr
    with wave.open(str(out)) as w:
        assert abs(w.getnframes() / 48000 - 2.5) < 0.01


def test_peak_is_limited_to_minus_1_dbfs(tmp_path):
    cues = {"duration": 1.0, "cues": [{"t": 0, "voice": v, "gain": 2.0} for v in ("kick", "bass", "hit", "sub")]}
    proc, out = _run(tmp_path, cues)
    report = json.loads(proc.stdout)
    assert report["peak_db"] <= -0.99


def test_same_seed_same_bytes(tmp_path):
    cues = {"duration": 1.0, "cues": [{"t": 0, "voice": "whoosh", "dur": 0.4}, {"t": 0.5, "voice": "snare"}]}
    _, a = _run(tmp_path, cues)
    first = a.read_bytes()
    _, b = _run(tmp_path, cues)
    assert b.read_bytes() == first


def test_every_voice_renders(tmp_path):
    voices = ["kick", "snare", "hat", "bass", "sub", "pad", "pluck", "whoosh", "hit", "click", "riser"]
    cues = {"cues": [{"t": i * 0.1, "voice": v, "note": 57} for i, v in enumerate(voices)]}
    proc, _ = _run(tmp_path, cues)
    assert proc.returncode == 0, proc.stderr


def test_unknown_voice_fails(tmp_path):
    proc, _ = _run(tmp_path, {"cues": [{"t": 0, "voice": "kazoo"}]})
    assert proc.returncode != 0 and "invalid_argument" in proc.stderr
