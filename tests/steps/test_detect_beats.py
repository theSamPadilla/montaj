"""Tests for steps/audio/detect_beats.py

Every fixture is synthesized here with a seeded generator (wave +
random.Random), so the tests are deterministic and need nothing but ffmpeg.
Tolerances absorb small resampler differences between ffmpeg builds.
"""
import array
import ast
import importlib.util
import json
import math
import random
import re
import subprocess
import sys
import wave
from pathlib import Path

import pytest

from tests.conftest import HAS_FFMPEG, run_step, assert_error

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")

STEP_PATH = Path(__file__).parent.parent.parent / "steps" / "audio" / "detect_beats.py"
LEAD_IN = 0.37
T_TOL = 0.015


# ── generator (port of the prototype's gen.py; breakdown defaults to None) ──

def gen_track(path, bpm, off=LEAD_IN, bars=16, breakdown=None, sr=22050, seed=7, pickup=0):
    """Kick every beat, noise snare on 2 and 4, noise hats on eighths, a 55 Hz
    bass note on each downbeat, `off` seconds of leading silence, `pickup`
    beats before bar one, optional quiet (hats only) bars [start, end)."""
    rnd = random.Random(seed)
    p = 60.0 / bpm
    n = int(sr * (off + bars * 4 * p + 0.5))
    buf = [0.0] * n

    def add(t0, dur, fn, gain):
        i0 = int(t0 * sr)
        for i in range(int(dur * sr)):
            j = i0 + i
            if j >= n:
                break
            buf[j] += gain * fn(i / sr)

    for b in range(bars * 4):
        t = off + b * p
        bar = (b - pickup) // 4
        quiet = breakdown is not None and breakdown[0] <= bar < breakdown[1]
        if not quiet:
            add(t, 0.25, lambda x: math.sin(2 * math.pi * (50 + 60 * math.exp(-x * 40)) * x) * math.exp(-x * 18), 0.8)
            if (b - pickup) % 4 in (1, 3):
                add(t, 0.15, lambda x: (rnd.random() * 2 - 1) * math.exp(-x * 30), 0.35)
            if (b - pickup) % 4 == 0:
                add(t, p * 3.5, lambda x: math.sin(2 * math.pi * 55 * x) * math.exp(-x * 1.2), 0.35)
        for e in (0, 0.5):
            add(t + e * p, 0.04, lambda x: (rnd.random() * 2 - 1) * math.exp(-x * 150), 0.08 if quiet else 0.15)
    peak = max(abs(v) for v in buf) or 1
    pcm = array.array("h", (int(v / peak * 0.9 * 32767) for v in buf))
    if sys.byteorder == "big":
        pcm.byteswap()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return path


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True, capture_output=True)


def has_encoder(name):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True)
    return re.search(rf"\b{name}\b", r.stdout) is not None


@pytest.fixture(scope="module")
def tracks(tmp_path_factory):
    d = tmp_path_factory.mktemp("detect_beats")
    t = {}
    for bpm in (90, 120, 128, 140):
        t[bpm] = gen_track(d / f"clean_{bpm}.wav", bpm)
    t["pickup"] = gen_track(d / "pickup_128.wav", 128, pickup=3)
    t["breakdown"] = gen_track(d / "breakdown_120.wav", 120, breakdown=(8, 12))
    t[70] = gen_track(d / "clean_70.wav", 70)
    t["pink"] = d / "pink.wav"
    ffmpeg("-f", "lavfi", "-i", "anoisesrc=c=pink:seed=3:d=25:a=0.5", str(t["pink"]))
    t["white"] = d / "white.wav"
    ffmpeg("-f", "lavfi", "-i", "anoisesrc=c=white:seed=11:d=20:a=0.5", str(t["white"]))
    t["tone"] = d / "tone.wav"
    ffmpeg("-f", "lavfi", "-i", "sine=f=220:d=20", str(t["tone"]))
    t["short"] = d / "short.wav"
    ffmpeg("-f", "lavfi", "-i", "sine=f=220:d=2", str(t["short"]))
    t["stereo"] = d / "stereo_120.wav"
    ffmpeg("-i", str(t[120]), "-ac", "2", str(t["stereo"]))
    t["mp4"] = d / "video_120.mp4"
    ffmpeg("-f", "lavfi", "-i", "color=c=black:s=64x64:r=10", "-i", str(t[120]), "-shortest",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(t["mp4"]))
    t["silent_video"] = d / "no_audio.mp4"
    ffmpeg("-f", "lavfi", "-i", "color=c=black:s=64x64:r=10", "-t", "5",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", str(t["silent_video"]))
    if has_encoder("libmp3lame"):
        t["mp3"] = d / "track_120.mp3"
        ffmpeg("-i", str(t[120]), "-c:a", "libmp3lame", "-b:a", "192k", str(t["mp3"]))
    return t


_cache = {}


def detect(path, *args):
    key = (str(path), args)
    if key not in _cache:
        proc = run_step("detect_beats.py", "--input", str(path), *args)
        assert proc.returncode == 0, proc.stderr
        _cache[key] = json.loads(proc.stdout)
    return _cache[key]


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("detect_beats", STEP_PATH)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# ── tempo, first beat, downbeat on clean tracks ──────────────────────────────

@pytest.mark.parametrize("bpm", [90, 120, 128, 140])
def test_clean_track_with_hint(tracks, bpm):
    r = detect(tracks[bpm], "--bpm-hint", str(bpm))
    assert r["bpm"] == pytest.approx(bpm, abs=0.1)
    assert r["first_beat"] == pytest.approx(LEAD_IN, abs=T_TOL)
    assert r["downbeat"] == pytest.approx(LEAD_IN, abs=T_TOL)
    assert r["downbeat_source"] == "accent"
    assert r["bpm_confidence"] >= 0.6
    assert r["warning"] is None
    assert r["bpm_hint"] == bpm
    assert r["beats"][0] == r["first_beat"]
    assert r["bars"][0] == r["downbeat"]
    gaps = [b - a for a, b in zip(r["beats"], r["beats"][1:])]
    assert max(gaps) - min(gaps) <= 0.0025          # constant spacing (3 dp rounding)
    assert r["beat_period"] == pytest.approx(60 / bpm, abs=0.001)
    assert r["bar_length"] == pytest.approx(4 * 60 / bpm, abs=0.004)
    # 16 bars of 4 beats; the grid stops at the last audible sound
    assert len(r["beats"]) in (64, 65)
    assert [s["energy"] for s in r["sections"]] == ["high"]
    assert r["sections"][0]["start"] == 0.0
    assert r["events"] == []


@pytest.mark.parametrize("bpm", [90, 120, 128, 140])
def test_clean_track_without_hint(tracks, bpm):
    r = detect(tracks[bpm])
    assert r["bpm"] == pytest.approx(bpm, abs=0.1)
    assert r["bpm_hint"] is None


def test_pickup_downbeat(tracks):
    r = detect(tracks["pickup"], "--bpm-hint", "128")
    expected = LEAD_IN + 3 * 60 / 128
    assert r["bpm"] == pytest.approx(128, abs=0.1)
    assert r["first_beat"] == pytest.approx(LEAD_IN, abs=T_TOL)
    assert r["downbeat"] == pytest.approx(expected, abs=T_TOL)
    assert r["bars"][0] == r["downbeat"]
    pickup = [b for b in r["beats"] if b < r["downbeat"]]
    assert len(pickup) == 3
    assert r["beats"].index(r["downbeat"]) == 3


def test_breakdown_sections_and_events(tracks):
    r = detect(tracks["breakdown"], "--bpm-hint", "120")
    assert r["bpm"] == pytest.approx(120, abs=0.1)
    assert r["downbeat_source"] == "energy_change"
    assert r["downbeat"] == pytest.approx(LEAD_IN, abs=T_TOL)
    secs = r["sections"]
    assert [s["energy"] for s in secs] == ["high", "low", "high"]
    assert [s["bar_start"] for s in secs] == [0, 8, 12]
    assert secs[-1]["bar_end"] == 16
    assert secs[0]["start"] == 0.0
    assert secs[-1]["end"] == r["duration"]
    assert secs[1]["loudness_db"] < secs[0]["loudness_db"] - 9
    ev = {(e["type"], e["bar"]): e["t"] for e in r["events"]}
    assert set(ev) == {("breakdown", 8), ("drop", 12)}
    assert ev[("breakdown", 8)] == pytest.approx(LEAD_IN + 8 * 2.0, abs=0.02)
    assert ev[("drop", 12)] == pytest.approx(LEAD_IN + 12 * 2.0, abs=0.02)


# ── the hint picks the octave, and only the octave ───────────────────────────

def test_hint_picks_octave(tracks):
    slow = detect(tracks[70], "--bpm-hint", "70")
    fast = detect(tracks[70], "--bpm-hint", "140")
    assert slow["bpm"] == pytest.approx(70, abs=0.1)
    assert fast["bpm"] == pytest.approx(140, abs=0.2)
    for b in slow["beats"]:
        assert min(abs(b - f) for f in fast["beats"]) <= T_TOL


@pytest.mark.parametrize("hint", ["124", "132"])
def test_hint_a_few_percent_off_does_not_drag_tempo(tracks, hint):
    r = detect(tracks[128], "--bpm-hint", hint)
    assert r["bpm"] == pytest.approx(128, abs=0.1)


# ── no pulse ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", ["pink", "white", "tone"])
def test_no_clear_pulse(tracks, name):
    r = detect(tracks[name])
    assert r["warning"] == "no_clear_pulse"
    assert r["bpm_confidence"] < 0.3


# ── containers and channel layouts ───────────────────────────────────────────

def test_stereo_same_result(tracks):
    ref = detect(tracks[120])
    r = detect(tracks["stereo"])
    assert r["bpm"] == pytest.approx(ref["bpm"], abs=0.1)
    assert r["first_beat"] == pytest.approx(ref["first_beat"], abs=T_TOL)


def test_mp3_same_bpm(tracks):
    if "mp3" not in tracks:
        pytest.skip("ffmpeg lacks libmp3lame")
    ref = detect(tracks[120])
    r = detect(tracks["mp3"])
    assert r["bpm"] == pytest.approx(ref["bpm"], abs=0.1)
    assert r["first_beat"] == pytest.approx(ref["first_beat"], abs=0.03)   # encoder delay


def test_video_container_same_bpm(tracks):
    ref = detect(tracks[120])
    r = detect(tracks["mp4"])
    assert r["bpm"] == pytest.approx(ref["bpm"], abs=0.1)


# ── CLI contract and errors ──────────────────────────────────────────────────

def test_out_writes_file(tracks, tmp_path):
    out = tmp_path / "nested" / "beats.json"
    proc = run_step("detect_beats.py", "--input", str(tracks[120]), "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout) == {"path": str(out.resolve())}
    data = json.loads(out.read_text())
    assert data["bpm"] == pytest.approx(120, abs=0.1)
    assert data["method"] == "bandflux-autocorr-v1"


def test_output_keys(tracks):
    r = detect(tracks[120])
    assert set(r) == {
        "input", "duration", "method", "bpm", "bpm_confidence", "bpm_hint", "beat_period",
        "first_beat", "beats", "beats_per_bar", "downbeat", "downbeat_confidence",
        "downbeat_source", "bar_length", "bars", "sections", "events",
        "tempo_stability_ms", "warning",
    }
    assert r["input"] == str(Path(tracks[120]).resolve())


def test_beats_per_bar_param(tracks):
    r = detect(tracks["breakdown"], "--beats-per-bar", "2")
    assert r["beats_per_bar"] == 2
    assert r["bar_length"] == pytest.approx(1.0, abs=0.004)


def test_missing_file(tmp_path):
    assert_error(run_step("detect_beats.py", "--input", str(tmp_path / "nope.wav")), "file_not_found")


def test_video_without_audio(tracks):
    assert_error(run_step("detect_beats.py", "--input", str(tracks["silent_video"])), "no_audio")


def test_too_short(tracks):
    assert_error(run_step("detect_beats.py", "--input", str(tracks["short"])), "too_short")


# ── pure functions ───────────────────────────────────────────────────────────

def test_energies_mean_power(mod):
    hop = mod.HOP
    sig = array.array("f", [0.5] * hop + [0.0] * hop + [-1.0] * hop + [0.25] * 10)
    e = mod.energies(sig)
    assert len(e) == 3                                   # trailing partial hop dropped
    scale = mod.PCM_SCALE ** 2
    assert e[0] == pytest.approx(0.25 * scale)
    assert e[1] == 0
    assert e[2] == pytest.approx(scale)


def test_onset_env_peaks_at_rise(mod):
    n = 400
    quiet, loud = 1.0, 1e6
    e = [quiet] * n
    for i in range(100, 110):
        e[i] = loud
    o = mod.onset_env([e, e, e])
    assert len(o) == n
    assert max(range(n), key=lambda i: o[i]) == 100
    assert all(v >= 0 for v in o)
    assert o[50] == 0 and o[300] == 0


def test_label_smooth_runs_events(mod):
    ref = -20.0
    bars = [ref] * 4 + [ref - 20] * 3 + [ref] + [ref - 20] + [ref] * 3 + [-80.0]
    labels = mod.label_bars(bars)
    assert labels[:4] == ["high"] * 4
    assert labels[4] == "low"
    assert labels[-1] == "silent"
    assert mod.label_bars([ref, ref - 5, ref - 12]) == ["high", "mid", "low"]
    sm = mod.smooth_labels(labels)
    assert sm[7] == "low"                                # single-bar island absorbed
    rs = mod.runs(sm)
    assert rs == [("high", 0, 4), ("low", 4, 9), ("high", 9, 12), ("silent", 12, 13)]
    assert mod.events_from_runs(rs) == [("breakdown", 4), ("drop", 9)]
    assert mod.events_from_runs([("low", 0, 2), ("high", 2, 6), ("low", 6, 8)]) == [
        ("intro", 0), ("drop", 2), ("outro", 6)]
    assert mod.events_from_runs([("high", 0, 2), ("mid", 2, 4), ("high", 4, 6)]) == [("drop", 4)]


def test_module_imports_no_numeric_libraries():
    """The dev .venv has numpy (via torch), so an accidental import would pass
    every other test; only this guard catches it."""
    tree = ast.parse(STEP_PATH.read_text())
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    assert names, "guard parsed no imports"
    assert not names & {"numpy", "scipy", "librosa"}, names
