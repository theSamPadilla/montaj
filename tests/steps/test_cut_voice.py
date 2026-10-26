"""§577 cut voice: sound counts as speech only when it is loud enough AND a voice (lib/voice), and only sound cut off
from any voiced frame (no continuously audible sound joining it to one: a dip to the room between) is read as no
voice. A whisper word whose only sound is that, and that is not speech by its own evidence (SPEECH_WORD_S, the
guard), is removed and tagged `noise`. Synthetic replicas of the measured shapes
(a harmonic voice with formants, clicks, handling noise, hum, fricatives), invented words; no real media."""
import json
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


def _ramp(x, ms=10):
    k = min(len(x) // 4, int(ms / 1000 * R))
    if k:
        x[:k] *= np.linspace(0, 1, k)
        x[-k:] *= np.linspace(1, 0, k)
    return x


FORMANTS = ((700, 120), (1200, 150), (2600, 200))


def _whisper(rng, n):
    """A whispered vowel: white noise shaped by three formants (no glottal source, so no pitch), syllabic envelope."""
    X = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / R)
    g = sum(np.exp(-0.5 * ((f - c) / (bw * 1.6)) ** 2) for c, bw in FORMANTS) + 0.02
    x = np.fft.irfft(X * g, n)
    t = np.arange(n) / R
    return _ramp(x * (0.35 + 0.65 * np.abs(np.sin(np.pi * 4.0 * t))))


def _creak(rng, n, f0=45.0, jitter=0.15):
    """Creaky voice (fry) or a deep voice: glottal pulses at f0, each period jittered, each ringing the formants."""
    tt = np.arange(400) / R
    ir = sum(np.exp(-np.pi * bw * tt) * np.sin(2 * np.pi * c * tt) for c, bw in FORMANTS)
    x = np.zeros(n)
    k = int(rng.uniform(0, R / f0))
    while k < n:
        m = min(len(ir), n - k)
        x[k:k + m] += ir[:m] * rng.uniform(0.7, 1.0)
        k += int(R / f0 * (1 + jitter * rng.uniform(-1, 1)))
    return _ramp(x)


def _burst(rng, n):
    """A plosive's release: a few ms of broadband burst, then aspiration noise."""
    x = _band(rng, n, 500, 7900)
    k = min(n, int(0.01 * R))
    x[k:] *= 0.3
    return x


SHAPES = {
    "voice": lambda rng, n: _vowel(rng, n),
    "breathy": lambda rng, n: _vowel(rng, n, breath=2.0),     # more aspiration than voice: hardly pitched (~0.3)
    "breathy4": lambda rng, n: _vowel(rng, n, breath=4.0),
    "whisper": _whisper,
    "creak45": lambda rng, n: _creak(rng, n, 45.0),
    "low70": lambda rng, n: _creak(rng, n, 70.0, jitter=0.0),
    "click": _clicks,
    "handling": lambda rng, n: _band(rng, n, 60, 900),
    "s": lambda rng, n: _band(rng, n, 4000, 7900),
    "f": lambda rng, n: _band(rng, n, 1000, 7900),
    "t": _burst,
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
    """An "s" (4-8 kHz noise, as noisy as a click) closing "yes." after a 40 ms closure (a dip to the room), and an "f"
    opening "fine." after 1.5 s of silence: each in its word's whisper span, a word that is speech by its own evidence
    (SPEECH_WORD_S, the guard), so each plays whole."""
    parts = [(0.30, 0.55, SPEECH, "voice"), (0.60, 0.80, SPEECH, "voice"), (0.84, 1.00, -28.0, "s"),
             (2.50, 2.60, -32.0, "f"), (2.60, 2.90, SPEECH, "voice"), (2.95, 3.30, SPEECH, "voice")]
    words = [("oh", 0.30, 0.58), ("yes.", 0.58, 1.00), ("fine", 2.50, 2.92), ("then.", 2.92, 3.30)]
    d = project(tmp_path, monkeypatch, parts, 3.9, words)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert v5.cover(d, 0.84, 1.00) > 0.99, tc.kept_iv(d)
    assert v5.cover(d, 2.50, 2.60) > 0.99, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, [("vo", a, b) for a, b, _, _ in parts])


def test_a_click_joined_to_a_word_by_audible_sound_is_never_touched(tmp_path, monkeypatch):
    """A click 0.1 s after a voiced word, reached from it through audible sound (handling noise running on from the
    word, never down to the room): joined, so it plays, as before."""
    parts = SENT + [(0.95, 1.05, -50.0, "handling"), (1.05, 1.09, -37.0, "click")] + BACK
    d = project(tmp_path, monkeypatch, parts, 4.0, SENT_W + BACK_W)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == ["we", "went", "back", "home."], (said, text)
    assert v5.cover(d, 1.05, 1.09) > 0.99, tc.kept_iv(d)


def test_a_click_just_before_a_word_with_a_dip_to_the_room_between_goes(tmp_path, monkeypatch):
    """Sam's 0:17.3 click: 0.1 s before a voiced word, the room between (no audible sound joins them): cut off from
    the voice, so it is silence, and the word after it starts on its own sound (red before: within 0.15 s, kept)."""
    parts = SENT + [(2.66, 2.70, -37.0, "click")] + BACK
    d = project(tmp_path, monkeypatch, parts, 4.0, SENT_W + BACK_W)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == ["we", "went", "back", "home."], (said, text)
    assert v5.cover(d, 2.66, 2.70) < 0.01, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, voiced(parts))


def test_a_sibilant_and_a_plosive_running_into_their_vowel_are_kept(tmp_path, monkeypatch):
    """An "s" running on from "yes"'s vowel, and a "t" (burst and aspiration) running into "top"'s, each outside its
    word's whisper span (whisper's drift): joined to the voice by audible sound, so each plays whole."""
    parts = [(0.30, 0.55, SPEECH, "voice"), (0.60, 0.80, SPEECH, "voice"), (0.80, 0.96, -28.0, "s"),
             (2.50, 2.56, -30.0, "t"), (2.56, 2.85, SPEECH, "voice"), (2.90, 3.25, SPEECH, "voice")]
    words = [("oh", 0.30, 0.58), ("yes.", 0.58, 0.80), ("top", 2.60, 2.87), ("it.", 2.87, 3.25)]
    d = project(tmp_path, monkeypatch, parts, 3.9, words)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert v5.cover(d, 0.80, 0.96) > 0.99, tc.kept_iv(d)
    assert v5.cover(d, 2.50, 2.56) > 0.99, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, [("vo", a, b) for a, b, _, _ in parts])


def test_a_breathy_yeah_alone_between_pauses_is_kept(tmp_path, monkeypatch):
    """kungfu's "yeah" (real3 v10, Sam kept it): 0.57 s of unpitched (whispered-like) voice at -32 (the real one: pitch
    about 0.3), alone between two pauses. A whisper word of SPEECH_WORD_S or more reaching GUARD_DB is speech, never
    noise: it plays, all of it (red before: removed as noise)."""
    parts = SENT + [(1.60, 2.17, -32.0, "whisper")] + BACK
    words = SENT_W + [("yeah", 1.60, 2.17)] + BACK_W
    d = project(tmp_path, monkeypatch, parts, 4.0, words)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == ["we", "went", "yeah", "back", "home."], (said, tags(text))
    assert v5.cover(d, 1.62, 2.15) > 0.99, tc.kept_iv(d)
    v5.checked(d, plan, applied, before, [("vo", a, b) for a, b, _, _ in parts])


@pytest.mark.parametrize("shape,db", [("whisper", -35.0), ("whisper", -41.0), ("breathy", -38.0),
                                      ("breathy4", -38.0), ("creak45", -38.0), ("low70", -38.0)])
def test_a_faint_phrase_alone_between_pauses_is_kept(tmp_path, monkeypatch, shape, db):
    """Review B1: "i don't think" said softly (whispered, breathy, creaky or deep), alone between two sentences with
    0.6 s of room either side, peaking over the -46 guard: whisper wrote it, the guard hears it, it plays."""
    parts = SENT + [(1.60, 1.80, db, shape), (1.85, 2.05, db, shape), (2.10, 2.25, db, shape)] + BACK
    words = SENT_W + [("i", 1.60, 1.80), ("don't", 1.80, 2.05), ("think", 2.05, 2.25)] + BACK_W
    d = project(tmp_path, monkeypatch, parts, 4.0, words)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert max(se.envelope(str(d / "vo.mov"))[160:225]) >= se.GUARD_DB
    assert said == ["we", "went", "i", "don't", "think", "back", "home."], (said, tags(text))
    v5.checked(d, plan, applied, before, [("vo", a, b) for a, b, _, _ in parts])


def test_a_deep_voice_under_80_hz_keeps_its_words(tmp_path, monkeypatch):
    """Review B2: a whole clip spoken at 70 Hz (a deep voice, or fry throughout): every word plays."""
    parts = [(a, b, db, "low70") for a, b, db, _ in SENT + BACK]
    d = project(tmp_path, monkeypatch, parts, 4.0, SENT_W + BACK_W)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert said == ["we", "went", "back", "home."], (said, tags(text))


def test_a_sentence_final_creaky_word_after_a_short_pause_is_kept(tmp_path, monkeypatch):
    """Review B1/B2: "...went [0.25 s] there." with "there." in fry (45 Hz, as sentence ends often are)."""
    parts = SENT + [(1.20, 1.60, -30.0, "creak45")] + BACK
    words = SENT_W + [("there.", 1.20, 1.60)] + BACK_W
    d = project(tmp_path, monkeypatch, parts, 4.0, words)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert "there." in said, (said, tags(text))


def test_a_soft_voiced_word_in_a_noisy_room_is_kept(tmp_path, monkeypatch):
    """Review should-fix 1: a clean pitched word at -41 in a white room at -50, over layer 1's line: the voice line is
    the LOW-PASSED room plus 6, so its low-passed part is voiced (against the full-band room, no frame was)."""
    parts = SENT + [(1.60, 2.00, -41.0, "voice")] + BACK
    words = SENT_W + [("so", 1.60, 1.75)] + BACK_W
    d = project(tmp_path, monkeypatch, parts, 4.0, words, room=-50.0)
    plan, text, applied, said, before = v5.plan_apply(d, monkeypatch)
    assert "so" in said, (said, tags(text))


def test_a_noise_row_put_back_is_refused_clearly(tmp_path, monkeypatch, capsys):
    """Review should-fix 2: a `noise` row moved back into ## Cut would play as nothing (its sound is silence to the
    cut): the apply refuses it and says which word and what to do."""
    parts = SENT + [(1.70, 1.76, -37.0, "click")] + BACK
    words = SENT_W + [("it", 1.65, 1.80)] + BACK_W
    d = project(tmp_path, monkeypatch, parts, 4.0, words)
    tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    head, rest = text.split("\n## Cut\n", 1)
    cut, unused = rest.split("\n## Unused", 1)
    row = next(r for r in unused.splitlines() if "[" in r and "noise" in r)
    rid = row.split()[0].lstrip("*")
    line = re.sub(r"\s*\[[^\]]*\]\s*$", "", row).lstrip("*")
    rows = [line if r.split() and r.split()[0] == rid else r for r in cut.splitlines() if r.strip()]
    (d / "cut-plan.md").write_text(head + "\n## Cut\n" + "\n".join(rows) + "\n\n## Unused" + unused.replace(row, ""))
    before = (d / "project.json").read_text()
    with pytest.raises(SystemExit):
        tc.run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "noise_kept" and '"it"' in err["message"] and "Delete" in err["message"], err
    assert (d / "project.json").read_text() == before


def test_the_voice_constants_are_in_the_energy_stamp():
    assert voice.STAMP in se.Refiner.STAMP and se.VERSION == "speech-energy v6"
    for k in ("VERSION", "RATE", "PITCH_MIN", "WINDOW_S", "PITCH_LAG_S", "LOWPASS_HZ", "_LOWPASS_TAPS"):
        assert f"{getattr(voice, k)}" in se.Refiner.STAMP
    assert f"SPEECH_WORD_S={se.SPEECH_WORD_S}" in se.Refiner.STAMP
