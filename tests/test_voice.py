"""§577 cut voice: lib/voice reads whether sound is a voice (each frame's pitch strength over the voice line), and the
rule cuts only sound cut off from any voiced frame. Synthetic replicas of each measured class
(a harmonic voice with formants, clicks, handling noise, hum, breath, fricatives); no real media."""
import sys
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib import voice  # noqa: E402

R = voice.RATE


def scaled(x, db):
    return x * (10 ** (db / 20) / (np.sqrt(np.mean(x ** 2)) + 1e-20))


def band(rng, n, lo, hi):
    X = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / R)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, n)


def vowel(rng, n, f0, breath=0.05):
    """A voice: harmonics of f0 (5 Hz vibrato) shaped by three formants, with `breath` of aspiration noise."""
    t = np.arange(n) / R
    ph = 2 * np.pi * np.cumsum(f0 * (1 + 0.03 * np.sin(2 * np.pi * 5 * t))) / R
    x = np.zeros(n)
    for h in range(1, int(4000 / f0)):
        g = sum(np.exp(-0.5 * ((h * f0 - c) / bw) ** 2) for c, bw in ((700, 120), (1200, 150), (2600, 200)))
        x += (g + 0.05 / h) * np.sin(h * ph)
    return scaled(scaled(x, 0) + breath * scaled(band(rng, n, 300, 6000), 0), 0)


def clicks(rng, n):
    x = np.zeros(n)
    for s in range(0, n - 400, 1600):
        x[s:s + 320] = band(rng, 320, 1500, 7000) * np.exp(-np.arange(320) / 60)
    return x


def smack(rng, n):
    x = np.zeros(n)
    x[n // 2:n // 2 + 80] = rng.standard_normal(80) * np.exp(-np.arange(80) / 15)
    return x


NOISE = {   # the classes measured on the real file as no voice, and the shapes cut must never call a voice
    "clicks": clicks,
    "smack": smack,
    "handling-low": lambda rng, n: band(rng, n, 50, 800),
    "handling": lambda rng, n: band(rng, n, 100, 3000),
    "breath": lambda rng, n: band(rng, n, 500, 3000),
    "s": lambda rng, n: band(rng, n, 4000, 8000),
    "sh": lambda rng, n: band(rng, n, 2000, 5000),
    "f": lambda rng, n: band(rng, n, 1000, 8000),
    "white": lambda rng, n: rng.standard_normal(n),
}


LINE = -66.0        # the voice line of a source whose room is at -72 (lib/speech_energy: the room + 6)


def voiced(x, line=LINE):
    """lib/voice's voiced frames of x at the voice line."""
    p, _, _, low = voice.features(x)
    return voice.voiced(voice.pitched_db(p, low), line)


def hum(n, db):
    t = np.arange(n) / R
    return scaled(sum(np.sin(2 * np.pi * 120 * h * t) / h for h in range(1, 8)), db)


@pytest.mark.parametrize("f0", [100, 140, 220])
def test_a_voice_is_voiced(f0):
    rng = np.random.default_rng(1)
    x = scaled(vowel(rng, int(0.3 * R), f0), -20) + scaled(rng.standard_normal(int(0.3 * R)), -72)
    p = voice.features(x)[0]
    assert voice.like(p)[5:-5].mean() > 0.95 and np.median(p[5:-5]) > 0.8
    assert sum(voiced(x)[5:-5]) == len(p) - 10


def test_a_soft_breathy_voice_is_still_voiced():
    """A voice at -44 with as much aspiration noise as voice, in a room at -72."""
    for seed in (1, 2, 3):
        rng = np.random.default_rng(seed)
        x = scaled(vowel(rng, int(0.3 * R), 120, breath=1.0), -44) + scaled(rng.standard_normal(int(0.3 * R)), -72)
        assert sum(voiced(x)) >= 10, seed


@pytest.mark.parametrize("room_hum", [False, True])
@pytest.mark.parametrize("kind", sorted(set(NOISE) - {"breath", "f"}))
def test_noise_of_each_measured_class_holds_no_voiced_frame(kind, room_hum):
    """Over three seeds: a click, a smack, handling noise, an "s", an "sh" and white noise, alone at -37, read no
    voiced frame; over a pitched room hum at -56 too (the click's energy lies above the low-pass, the hum's pitch
    under it: gated by the low-passed part's level, the hum's pitch stays at the hum's level)."""
    for seed in (1, 2, 3):
        rng = np.random.default_rng(seed)
        n = int(0.3 * R)
        x = scaled(NOISE[kind](rng, n), -37) + scaled(rng.standard_normal(n), -72) + (hum(n, -56) if room_hum else 0)
        assert not any(voiced(x, -56.0 + 6.0 if room_hum else LINE)), (kind, seed)     # the room is the hum's level


@pytest.mark.parametrize("kind", ["breath", "f"])
def test_breath_and_an_f_are_mostly_no_voice_and_a_chance_pitched_frame_keeps_them(kind):
    """Band noise near 1 kHz (a breath, an "f") reads a chance pitched frame now and then (its low-passed band rings
    near the cut-off): most of it is no voice, and one such frame makes the sound voiced, so it is kept: the rule only
    errs on the side of keeping."""
    for seed in (1, 2, 3):
        rng = np.random.default_rng(seed)
        n = int(0.3 * R)
        x = scaled(NOISE[kind](rng, n), -37) + scaled(rng.standard_normal(n), -72)
        assert sum(voiced(x)) <= 0.5 * len(voiced(x)), (kind, seed)


def test_room_hum_is_not_voice():
    """A 120 Hz buzz with harmonics at -56 (as pitched as a voice: the real room read 0.8) over noise at -62 is pitched
    by its spectrum alone, so the level decides: the room is the hum's level, and under the voice line (the room plus
    6 dB) no frame is voiced."""
    rng = np.random.default_rng(4)
    n = int(1.0 * R)
    x = hum(n, -56) + scaled(rng.standard_normal(n), -62)
    assert voice.like(voice.features(x)[0])[5:-5].mean() > 0.9        # its spectrum alone says voice
    assert not any(voiced(x, -56.0 + 6.0))        # the voice line: the room (the hum's level) + 6


def test_only_sound_cut_off_from_voice_is_noise():
    """A run of sound is noise only when no voiced frame lies in it or within VOICE_REACH_S of it."""
    env = [-70.0] * 100
    vo = bytearray(100)
    for k in range(10, 30):
        env[k], vo[k] = -15.0, 1               # a voiced word
    for k in range(40, 44):
        env[k] = -35.0                         # a click 0.10 s after it: attached
    for k in range(70, 74):
        env[k] = -35.0                         # a click 0.40 s after it: cut off
    assert voice.noise_frames(env, -43.0, vo) == set(range(70, 74))
    assert voice.noise_word(env, vo, -66.0, 68, 76)
    assert not voice.noise_word(env, vo, -66.0, 38, 46)
    assert not voice.noise_word(env, vo, -66.0, 80, 90)     # no sound in its span: inaudible, never noise
    assert voice.noise_frames(env, -43.0, None) == set() and not voice.noise_word(env, None, -66.0, 68, 76)
