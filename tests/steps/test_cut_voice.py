"""§577 cut voice: sound counts as speech only when it is loud enough AND a voice (lib/voice), and only sound cut off
from any voiced frame (a quiet gap on both sides, no voiced frame within VOICE_REACH_S) is read as no voice. A
whisper word whose only sound is that is removed and tagged `noise`. Synthetic replicas of the measured shapes
(a harmonic voice with formants, clicks, handling noise, hum, fricatives), invented words; no real media."""
import math
import re
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from lib import speech_energy as se
from lib import voice
from lib.common import ffmpeg_bin
from tests.steps import test_cut as tc
from tests.steps import test_cut_v5 as v5
from tests.steps.test_cut import stub_transcribe  # noqa: F401  (the fixture)

R = tc.RATE
SPEECH = -13.0
ROOM = -72.0


def _scaled(x, db):
    return x * (10 ** (db / 20) / (np.sqrt(np.mean(x ** 2)) + 1e-20))


def _band(rng, n, lo, hi):
    X = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / R)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, n)


def _vowel(rng, n, f0=130.0, breath=0.05):
    t = np.arange(n) / R
    ph = 2 * np.pi * np.cumsum(f0 * (1 + 0.03 * np.sin(2 * np.pi * 5 * t))) / R
    x = np.zeros(n)
    for h in range(1, int(4000 / f0)):
        g = sum(np.exp(-0.5 * ((h * f0 - c) / bw) ** 2) for c, bw in ((700, 120), (1200, 150), (2600, 200)))
        x += (g + 0.05 / h) * np.sin(h * ph)
    x = _scaled(x, 0) + breath * _scaled(_band(rng, n, 300, 6000), 0)
    ramp = min(n // 4, int(0.01 * R))           # 10 ms onset and offset, as a voice has
    if ramp:
        x[:ramp] *= np.linspace(0, 1, ramp)
        x[-ramp:] *= np.linspace(1, 0, ramp)
    return x


def _clicks(rng, n):
    x = np.zeros(n)
    for s in range(0, max(1, n - 320), 1600):
        m = min(320, n - s)
        x[s:s + m] = _band(rng, m, 1500, 7000) * np.exp(-np.arange(m) / 60)
    return x


SHAPES = {
    "voice": lambda rng, n: _vowel(rng, n),
    "breathy": lambda rng, n: _vowel(rng, n, breath=2.0),     # more aspiration than voice: hardly pitched
    "click": _clicks,
    "handling": lambda rng, n: _band(rng, n, 60, 900),
    "s": lambda rng, n: _band(rng, n, 4000, 7900),
    "f": lambda rng, n: _band(rng, n, 1000, 7900),
}


def media(path, total, parts, room=ROOM, hum=None, seed=11):
    """A .mov (PCM audio) of `total` s: room noise at `room` dB RMS, a 120 Hz buzz at `hum` dB under it all when set,
    and each (t0, t1, dB, shape) of `parts` at that RMS (a frame's level, as the envelope reads it)."""
    rng = np.random.default_rng(seed)
    n = int(total * R)
    x = rng.uniform(-1, 1, size=n) * 10 ** (room / 20) * math.sqrt(3)
    if hum is not None:
        t = np.arange(n) / R
        x += _scaled(sum(np.sin(2 * np.pi * 120 * h * t) / h for h in range(1, 8)), hum)
    for t0, t1, db, shape in parts:
        k0, k1 = int(t0 * R), min(n, int(t1 * R))
        x[k0:k1] += _scaled(SHAPES[shape](rng, k1 - k0), db)
    pcm = np.clip(np.round(x * 32767), -32767, 32767).astype("<i2")
    wav = Path(str(path) + ".wav")
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(R)
        w.writeframes(pcm.tobytes())
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s=64x64:r=30:d={total}",
                    "-i", str(wav), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest",
                    str(path)], check=True, capture_output=True)
    wav.unlink()


def project(tmp_path, monkeypatch, parts, total, words, room=ROOM, hum=None):
    monkeypatch.setattr(tc, "tone_media", lambda path, spans, tot: media(path, tot, spans, room, hum))
    return tc.tone_project(tmp_path, [("vo", parts, total, words)])


def voiced(parts):
    return [("vo", a, b) for a, b, _, shape in parts if shape == "voice"]


def tags(text):
    """{word: why} of the rows of ## Unused."""
    out = {}
    for row in text.split("## Unused")[-1].splitlines():
        m = re.search(r"\[\d+(?:\.\d+)?\s+(\S+)\]\s*$", row)
        if m:
            for w in row[:m.start()].split()[1:]:
                out[w.strip(".,")] = m.group(1)
    return out


SENT = [(0.30, 0.55, SPEECH, "voice"), (0.60, 0.95, SPEECH, "voice")]
SENT_W = [("we", 0.30, 0.60), ("went", 0.60, 0.95)]
BACK = [(2.80, 3.10, SPEECH, "voice"), (3.15, 3.50, SPEECH, "voice")]
BACK_W = [("back", 2.80, 3.15), ("home.", 3.15, 3.50)]


@pytest.mark.parametrize("hum", [None, -56.0])
def test_a_click_with_a_whisper_word_on_it_is_removed_tagged_noise_and_keeps_no_island(tmp_path, monkeypatch, hum):
    """A click train at -37 (over the line: the speech is at -13), 0.7 s from any voice, with whisper's "it" on it: the
    word goes, tagged noise, and no piece of the click plays (red before: "it" played on a 0.49 s island). With a
    pitched room hum at -56 (as the real room: pitch 0.8) the click is still no voice."""
    parts = SENT + [(1.70, 1.76, -37.0, "click")] + BACK
    words = SENT_W + [("it", 1.65, 1.80)] + BACK_W
    d = project(tmp_path, monkeypatch, parts, 4.0, words, room=-62.0 if hum else ROOM, hum=hum)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == ["we", "went", "back", "home."], (said, text)
    assert tags(text).get("it") == "noise", text
    assert v5.cover(d, 1.60, 1.85) < 0.01, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, voiced(parts))


def test_handling_noise_between_words_is_silence_cut_to_the_pause_rule(tmp_path, monkeypatch):
    """Handling noise (60-900 Hz) at -40 for 0.5 s between two sentences, no word on it, 0.45 s or more from any
    voice: silence for layer 1, so the gap is cut to two breaths (red before: kept, 0.5 s of sound)."""
    parts = SENT + [(1.40, 1.90, -40.0, "handling")] + BACK
    d = project(tmp_path, monkeypatch, parts, 4.0, SENT_W + BACK_W)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == ["we", "went", "back", "home."], (said, text)
    assert v5.cover(d, 1.40, 1.90) < 0.01, tc.kept_iv(d)
    played = tc.played_words(d)
    gaps = [b[1] - a[2] for a, b in zip(played, played[1:])]
    assert max(gaps) <= 0.08 + 0.18 + 0.02, gaps        # the sentence end's breath at most (D1)
    v5.checked(d, plan, applied, before, voiced(parts))


@pytest.mark.parametrize("shape", ["voice", "breathy"])
def test_a_soft_real_word_beside_voiced_words_is_kept_and_heard(tmp_path, monkeypatch, shape):
    """The canary: "your" at -44 dB peak, speech at -13, room at -72, beside voiced words. Kept and heard, whether it
    is a clean voice or as unpitched as the real one (pitch 0.11-0.17 measured; here more aspiration than voice):
    attached to voiced speech, so never read as no voice."""
    parts = [(0.30, 0.60, SPEECH, "voice"), (0.62, 0.85, SPEECH, "voice"), (0.95, 1.13, -45.5, shape),
             (1.22, 1.55, SPEECH, "voice"), (2.60, 2.90, SPEECH, "voice"), (2.95, 3.30, SPEECH, "voice")]
    words = [("this", 0.30, 0.62), ("is", 0.62, 0.90), ("your", 0.90, 1.18), ("bike.", 1.18, 1.55),
             ("ride", 2.60, 2.95), ("it.", 2.95, 3.30)]
    d = project(tmp_path, monkeypatch, parts, 3.9, words)
    env = se.envelope(str(d / "vo.mov"))
    assert -45.0 <= max(env[95:113]) <= -43.0, max(env[95:113])        # its peak: -44
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert v5.cover(d, 0.96, 1.12) > 0.99, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, [("vo", a, b) for a, b, _, _ in parts])


def test_fricative_edges_of_a_voiced_word_are_kept(tmp_path, monkeypatch):
    """An "s" (4-8 kHz noise, as noisy as a click) closing "yes." after a 40 ms closure, and an "f" opening "fine."
    after 1.5 s of silence: each is attached to its word's voice, so each plays whole."""
    parts = [(0.30, 0.55, SPEECH, "voice"), (0.60, 0.80, SPEECH, "voice"), (0.84, 1.00, -28.0, "s"),
             (2.50, 2.60, -32.0, "f"), (2.60, 2.90, SPEECH, "voice"), (2.95, 3.30, SPEECH, "voice")]
    words = [("oh", 0.30, 0.58), ("yes.", 0.58, 1.00), ("fine", 2.50, 2.92), ("then.", 2.92, 3.30)]
    d = project(tmp_path, monkeypatch, parts, 3.9, words)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert v5.cover(d, 0.84, 1.00) > 0.99, tc.kept_iv(d)
    assert v5.cover(d, 2.50, 2.60) > 0.99, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, [("vo", a, b) for a, b, _, _ in parts])


def test_a_click_right_against_a_word_is_never_touched(tmp_path, monkeypatch):
    """A click 0.1 s after a voiced word (within VOICE_REACH_S) is attached to it: it plays, as before."""
    parts = SENT + [(1.05, 1.09, -37.0, "click")] + BACK
    d = project(tmp_path, monkeypatch, parts, 4.0, SENT_W + BACK_W)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == ["we", "went", "back", "home."], (said, text)
    assert v5.cover(d, 1.05, 1.09) > 0.99, tc.kept_iv(d)


def test_the_voice_constants_are_in_the_energy_stamp():
    assert voice.STAMP in se.Refiner.STAMP
    for k in ("PITCH_MIN", "VOICE_REACH_S", "WINDOW_S", "LOWPASS_HZ"):
        assert f"{k}={getattr(voice, k)}" in se.Refiner.STAMP
