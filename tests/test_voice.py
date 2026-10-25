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
    p, _, _, low, _ = voice.features(x)
    return voice.voiced(voice.reading(p, low), line)


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


def test_only_sound_cut_off_from_voice_by_a_dip_to_the_room_is_noise():
    """Sound joins a voice through continuously audible frames (at or over the audible line, the room + 6): a click
    0.15 s from a voiced word with a dip to the room between is cut off; one reaching it through audible sound is not,
    however far; a piece holding a kept frame (a word's own burst or speech) is never noise."""
    env = [-70.0] * 120
    vo = bytearray(120)
    for k in range(10, 30):
        env[k], vo[k] = -15.0, 1               # a voiced word
    for k in range(30, 50):
        env[k] = -50.0                         # audible sound (over -64) running on from it ...
    for k in range(50, 54):
        env[k] = -35.0                         # ... into a click 0.2 s after it: joined
    for k in range(69, 73):
        env[k] = -35.0                         # a click 0.15 s before the next word, a dip to the room between
    for k in range(88, 110):
        env[k], vo[k] = -15.0, 1               # the next word
    line = -64.0
    assert voice.noise_frames(env, line, vo) == set(range(69, 73))
    assert voice.noise_word(env, vo, line, 67, 75)
    assert not voice.noise_word(env, vo, line, 48, 56)
    assert not voice.noise_word(env, vo, line, 60, 66)      # no sound in its span: inaudible, never noise
    assert not voice.noise_word(env, vo, line, 67, 75, keep={70})
    assert voice.noise_frames(env, line, vo, keep={70}) == set()
    assert voice.joined(env, vo, line, 50, 54) and not voice.joined(env, vo, line, 69, 73)
    assert voice.noise_frames(env, line, None) == set() and not voice.noise_word(env, None, line, 67, 75)


@pytest.mark.parametrize("f0", [45, 60, 70])
def test_a_deep_voice_under_80_hz_is_voiced(f0):
    """Review B2: a voice at 45-70 Hz (a deep voice, creak) reads pitched, every 0.1 s of it: the lags reach 40 Hz
    (one voiced frame is all a piece needs)."""
    rng = np.random.default_rng(1)
    n = int(0.4 * R)
    x = scaled(vowel(rng, n, f0), -30) + scaled(rng.standard_normal(n), -72)
    v = voiced(x)[4:-4]
    assert all(any(v[k:k + 10]) for k in range(0, len(v) - 9)), list(v)


def test_the_reading_is_the_same_read_in_chunks():
    """features reads _CHUNK frames at a time (no copy of the whole source): the same as one chunk."""
    x = (np.random.default_rng(0).standard_normal(R * 50) * 3000).astype("<i2")
    a = voice.features(x, scale=voice.SCALE)
    old = voice._CHUNK
    try:
        voice._CHUNK = 10 ** 7
        b = voice.features(x, scale=voice.SCALE)
    finally:
        voice._CHUNK = old
    assert all(np.allclose(u, v) for u, v in zip(a, b))
