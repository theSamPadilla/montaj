"""§558 cut, fix pass 4: no long silence kept inside the applied timeline, at its lead and tail, or inside a word's
span; the take rules still read the spans as they were. Synthetic tones over a set room, invented words.

The flat check is tests/cut_checks.py (v5): flat.py's definitions exactly, with no slack and no exemption but the
attached words' frames (the orchestrator's rule). b7639ba5's version of it exempted every tone 10 dB over the room
and allowed a frame or two each side; v5 needs neither."""
import json
import math
import re
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from lib.common import ffmpeg_bin
from tests import cut_checks
from tests.steps import test_cut as tc
from tests.steps.test_cut import stub_transcribe  # noqa: F401  (the fixture)
from tests.steps.test_cut_pass3 import assert_no_unwarned_island, cover, plan_apply

SP = -20.0
ROOM = -65.0
MAX_PAUSE = 0.45
LEAD_S = 0.10
BASE_A6 = "A6 Then drag it onto the timeline. [10.7]"        # the row at 04bdbd9b, before the trim


def room_media(path, spans, total, room=ROOM, wobble=1.0, dips=(), seed=7, rate=tc.RATE):
    """A .mov like test_cut.tone_media: room noise whose level moves within `wobble` dB each 10 ms, a much quieter
    stretch over each (t0, t1) of `dips` (-90 dB, as a camera's first frames or a gate), and a 220 Hz tone at `db`
    over each (t0, t1, db) of `spans`."""
    rnd = np.random.default_rng(seed)
    n = int(total * rate)
    hop = rate // 100
    level = room + rnd.uniform(-wobble, wobble, size=n // hop + 1)
    for a, b in dips:
        level[int(a * 100):int(b * 100)] = -90.0
    amp = 10 ** (np.repeat(level, hop)[:n] / 20) * math.sqrt(3)
    x = rnd.uniform(-1, 1, size=n) * amp
    t = np.arange(n) / rate
    for t0, t1, db in spans:
        k0, k1 = int(t0 * rate), min(n, int(t1 * rate))
        x[k0:k1] += np.sin(2 * np.pi * 220 * t[k0:k1]) * 10 ** (db / 20) * math.sqrt(2)
    pcm = np.clip(np.round(x * 32767), -32767, 32767).astype("<i2")
    wav = Path(str(path) + ".wav")
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s=64x64:r=30:d={total}",
                    "-i", str(wav), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest",
                    str(path)], check=True, capture_output=True)
    wav.unlink()


def room_project(tmp_path, monkeypatch, clips, **kw):
    """test_cut.tone_project on room_media."""
    monkeypatch.setattr(tc, "tone_media", lambda path, spans, total: room_media(path, spans, total, **kw))
    return tc.tone_project(tmp_path, clips)


def unused_soft(text):
    """PL89: "soft" went with the silence, listed under ## Unused tagged inaudible."""
    return any(re.match(r"^A\d+ soft \[[\d.]+ inaudible\]$", r) for r in tc.sections(text)[1])


def assert_flat_ok(d, text=""):
    """cut_checks' flat and edge checks (flat.py, exactly): no flat run over max-pause in a kept item, at most LEAD_S
    of flat at the video's lead and tail."""
    rep = cut_checks.flat_report(d, MAX_PAUSE)
    assert not rep["runs"] and rep["lead_s"] <= LEAD_S + 1e-9 and rep["tail_s"] <= LEAD_S + 1e-9, \
        f"{rep}\niv={tc.kept_iv(d)}\n{text.split('## Cut')[-1]}"
    return rep


# ── the red case: whisper's spans stretched over silences, and a soft word ────────────────────────────

STRETCHED = (
    [(0.30, 0.60, SP), (2.10, 2.40, SP), (2.45, 2.75, SP), (4.70, 5.00, ROOM + 7), (5.45, 5.75, SP), (5.80, 6.10, SP)],
    [("alpha", 0.30, 2.10), ("beta", 2.10, 2.45), ("gamma", 2.45, 4.25), ("soft", 4.25, 5.45), ("delta", 5.45, 5.80),
     ("epsilon.", 5.80, 6.10)],
    6.8)


def test_stretched_spans_and_an_offered_soft_word_keep_no_long_silence(tmp_path, monkeypatch):
    """Whisper stretches "alpha" and "gamma" over 1.5 s silences, and "soft" (7 dB over the room) over 1.2 s of which
    0.3 s is its sound. A quieter first stretch (a camera's first frames) reads the room low, which switched the old
    trim off. The applied timeline keeps no flat run over max-pause, every other word stays said, and none of
    "soft"'s 1.2 s plays."""
    spans, words, total = STRETCHED
    d = room_project(tmp_path, monkeypatch, [("vo", spans, total, words)], dips=[(0.0, 0.25)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words if w != "soft"], (said, text)
    # FINISH v5: "soft" (38 dB under the speech, 3 dB under the attached line, room + 10) keeps no sound and none of
    # its 1.2 s; under the guard, in a silence between heard words: inaudible, removed
    assert_flat_ok(d, text)
    lost = [(a, b) for a, b, db in spans if db >= ROOM + 10 and cover(d, a, b) < 0.99]
    assert not lost, (lost, tc.kept_iv(d))
    assert cover(d, 4.25, 5.45) * 1.2 <= 0.05 and unused_soft(text), (tc.kept_iv(d), text)
    assert_no_unwarned_island(d, plan, applied)


def test_dense_speech_trims_a_silence_inside_a_stretched_span(tmp_path, monkeypatch):
    """Dense delivery, whisper's words gapless from 0.0 to the end, so no frame lies outside them (an untrusted
    room reading at b7639ba5; v5 reads no room). Word 12's span runs over a 1 s silence after its sound: trimmed all
    the same."""
    spans, words, t = [], [], 0.0
    for k in range(24):
        spans.append((round(t, 2), round(t + 0.25, 2), SP))
        span_end = t + 0.26 + (1.0 if k == 12 else 0.0)
        words.append((f"w{k}" + ("." if k == 23 else ""), round(t, 2), round(span_end, 2)))
        t = round(span_end, 2)
    d = room_project(tmp_path, monkeypatch, [("vo", spans, t, words)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert_flat_ok(d, text)
    assert all(cover(d, a, b) > 0.99 for a, b, _ in spans), tc.kept_iv(d)


# ── the video's lead and tail (Sam, pov v3), and a clip's tail ────────────────────────────────────────────────

def test_a_first_word_stretched_from_zero_over_silence_starts_at_its_sound(tmp_path, monkeypatch):
    """Whisper's first word runs from 0.0 over 2.8 s of silence, then the speech: the video starts at most a breath
    before the sound."""
    spans = [(2.80, 3.10, SP), (3.15, 3.45, SP), (3.50, 3.80, SP), (3.85, 4.15, SP)]
    words = [("you", 0.0, 3.10), ("are", 3.10, 3.50), ("riding", 3.50, 3.85), ("bikes.", 3.85, 4.15)]
    d = room_project(tmp_path, monkeypatch, [("vo", spans, 4.8, words)], dips=[(4.5, 4.8)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    rep = assert_flat_ok(d, text)
    assert tc.kept_iv(d)[0][0] >= 2.80 - LEAD_S - 1e-6, (rep, tc.kept_iv(d))
    assert said == [w for w, _, _ in words]


def test_a_last_word_stretched_over_silence_ends_at_its_sound(tmp_path, monkeypatch):
    spans = [(0.30, 0.60, SP), (0.65, 0.95, SP), (1.00, 1.30, SP), (1.35, 1.65, SP)]
    words = [("you", 0.30, 0.65), ("are", 0.65, 1.00), ("riding", 1.00, 1.35), ("bikes.", 1.35, 4.45)]
    d = room_project(tmp_path, monkeypatch, [("vo", spans, 4.5, words)], dips=[(0.0, 0.2)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert_flat_ok(d, text)
    assert tc.kept_iv(d)[-1][1] <= 1.65 + LEAD_S + 1e-6, tc.kept_iv(d)
    assert said == [w for w, _, _ in words]


def test_a_clips_flat_tail_is_trimmed(tmp_path, monkeypatch):
    """Clip one's last word runs on over 0.5 s of silence to the clip's end: its item ends a breath after the
    sound."""
    s1 = [(0.30, 0.60, SP), (0.65, 0.95, SP), (1.00, 1.30, SP)]
    w1 = [("one", 0.30, 0.65), ("more", 0.65, 1.00), ("thing.", 1.00, 1.80)]
    s2 = [(0.30, 0.60, SP), (0.65, 0.95, SP), (1.00, 1.30, SP)]
    w2 = [("then", 0.30, 0.65), ("we", 0.65, 1.00), ("go.", 1.00, 1.30)]
    d = room_project(tmp_path, monkeypatch, [("c1", s1, 1.8, w1), ("c2", s2, 1.9, w2)], dips=[(0.0, 0.2)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert_flat_ok(d, text)
    iv = tc.kept_iv(d)
    assert iv[0][1] <= 1.30 + 0.09 + 1e-6, iv             # a sentence end's pause (half of 0.18), not the 0.5 s
    assert said == [w for w, _, _ in w1 + w2]


# the drift fuzz under the flat check: test_cut_v5's, with every check (cut_checks)


def a6_offer(cut):
    """The fuzzy retake? label on A6's take ("Then drag it onto the timeline.", at 10.7, naming the later take at
    17.8): its rows in ## Cut, which v5 cuts at the take's silences, so the line ids are the ones its words have now."""
    rows = [r for r in cut if re.search(r" retake\? A\d+ 17\.8\]$", r)]
    text = " ".join(re.sub(r"\{[\d.]+\}|\[[^]]*\]", "", r).split(None, 1)[1] for r in rows)
    return " ".join(text.split()) == "Then drag it onto the timeline." and bool(re.search(r"\[10\.7 retake\? A\d+ 17\.8\]$",
                                                                                            rows[0]))


# ── the take rules read the spans as they were (fix pass 4 is the timeline only) ───────────────────────────────

def test_the_trim_leaves_the_take_rules_their_label(tmp_path, stub_transcribe, monkeypatch):  # noqa: F811
    """The fixture's real pauses inside whisper's spans are cut (v5: by layer 1, so A6's line is several rows, where
    b7639ba5 showed "drag it {0.08} onto"), and the fuzzy retake? label on A6 is still made (F1 splits clauses at
    punctuation and units, not at the cut's silences)."""
    stub_transcribe(tc.retake_transcript())
    d = tc.make_project(tmp_path)
    tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    cut, unused = tc.sections(text)
    assert BASE_A6 not in cut and any(re.match(r"A\d+ drag it \[", r) for r in cut), cut     # the trim is on
    assert a6_offer(cut), cut
