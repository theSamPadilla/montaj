"""§558 cut: lib/speech_energy places whisper's words by the audio's level (two reviews' probes, pass 2).

Synthetic only: envelopes written frame by frame (dB per 10 ms) and media generated here, with invented words.
"""
import contextlib
import io
import json
import math
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

from lib import speech_energy as se  # noqa: E402
from lib.common import ffmpeg_bin  # noqa: E402
from lib.speech_lines import Word, norm  # noqa: E402

F = se.FRAME_S
NOISE = -70.0


def env_of(total, *parts, noise=NOISE):
    """An envelope of `total` seconds at `noise`, with each (t0, t1, dB) part set."""
    env = [noise] * int(round(total / F))
    for t0, t1, db in parts:
        for k in range(int(round(t0 / F)), min(len(env), int(round(t1 / F)))):
            env[k] = db
    return env


def words(*spec):
    """Words from (text, start, end)."""
    return [Word(i, t, norm(t), a, b) for i, (t, a, b) in enumerate(spec)]


def refined(ws, env, floor=None, noise=None):
    noise = se.noise_db(ws, env) if noise is None else noise
    floor = se.floor_db(ws, env, noise) if floor is None else floor
    return se.refine(ws, env, floor, noise)


# ── the two levels: the room's noise and the speech-relative floor ──────────────────────────────────────────

def test_the_floor_is_no_longer_clamped_at_minus_48():
    """B3: speech at -40 dB has its floor at -66, not -48."""
    ws = words(("one", 0.3, 0.6), ("two", 0.6, 0.9), ("three", 0.9, 1.2))
    env = env_of(2.0, (0.3, 0.55, -40.0), (0.6, 0.85, -40.0), (0.9, 1.15, -40.0))
    assert se.floor_db(ws, env) == pytest.approx(-66.0)


def test_the_noise_is_the_tenth_percentile_outside_the_words():
    ws = words(("one", 0.5, 0.8))
    env = env_of(3.0, (0.5, 0.75, -20.0), noise=-72.0)
    env[250:260] = [-30.0] * 10                       # a door slam outside the words is not the room
    assert se.noise_db(ws, env) == pytest.approx(-72.0)
    assert se.noise_db(ws, env) == se.noise_db(ws, list(env))          # deterministic


def test_the_floor_reads_the_heard_words_only():
    """A clip of mostly silent (made-up) words keeps its speech's floor, not the room's."""
    ws = words(*[(f"w{k}", 0.3 * k, 0.3 * k + 0.3) for k in range(10)])
    env = env_of(4.0, (0.0, 0.25, -20.0), (0.3, 0.55, -20.0))
    assert se.floor_db(ws, env, se.noise_db(ws, env)) == pytest.approx(-46.0)


def test_soft_words_in_a_quiet_recording_are_heard():
    """B3: speech at -40, two words at -50 over a -70 room: kept, not inaudible."""
    ws = words(("you", 0.3, 0.6), ("feel", 0.6, 0.9), ("a", 0.9, 1.2), ("slight", 1.2, 1.5), ("lean.", 1.5, 1.8))
    env = env_of(2.5, (0.3, 0.55, -40.0), (0.6, 0.85, -40.0), (0.9, 1.15, -50.0), (1.2, 1.45, -50.0),
                 (1.5, 1.75, -40.0))
    out, stats, _ = refined(ws, env)
    assert stats["inaudible"] == [] and stats["quiet"] == []


def test_a_word_within_ten_db_of_the_room_is_inaudible_a_quieter_heard_one_is_only_quiet():
    """R2-Q2: removal needs the peak within 10 dB of the noise; under the floor but over that, it is quiet."""
    ws = words(("so", 0.3, 0.6), ("just", 0.6, 0.9), ("between", 0.9, 1.2), ("us", 1.2, 1.5), ("now.", 1.5, 1.8))
    aside = env_of(2.5, (0.3, 0.55, -20.0), (0.6, 0.85, -48.0), (0.9, 1.15, -48.0), (1.2, 1.45, -20.0),
                   (1.5, 1.75, -20.0))
    _, stats, _ = refined(ws, aside)
    assert stats["inaudible"] == [] and stats["quiet"] == [1, 2]
    gone = env_of(2.5, (0.3, 0.55, -20.0), (0.6, 0.85, -64.0), (0.9, 1.15, -64.0), (1.2, 1.45, -20.0),
                  (1.5, 1.75, -20.0))
    _, stats, _ = refined(ws, gone)
    assert stats["inaudible"] == [1, 2]


# ── B4: hysteresis edges and the release ───────────────────────────────────────────────────────────────────

def test_a_weak_fricative_decay_is_kept():
    ws = words(("you", 0.3, 0.6), ("laugh", 0.6, 1.7), ("now.", 1.7, 1.95))
    env = env_of(2.5, (0.3, 0.55, -20.0), (0.6, 0.85, -20.0), (0.85, 0.97, -48.0), (1.7, 1.95, -20.0))
    out, _, _ = refined(ws, env)
    assert out[1].start == pytest.approx(0.6) and out[1].end >= 0.97 - 1e-6       # the whole decay


def test_a_weak_onset_is_kept():
    ws = words(("you", 0.3, 0.6), ("feel", 0.6, 1.55), ("happy.", 1.55, 1.92))
    env = env_of(2.5, (0.3, 0.55, -20.0), (0.6, 0.85, -20.0), (1.55, 1.67, -48.0), (1.67, 1.92, -20.0))
    out, _, _ = refined(ws, env)
    assert out[2].start == pytest.approx(1.55)


def test_a_sharp_ending_keeps_the_release():
    ws = words(("one", 0.3, 1.0), ("two.", 1.0, 1.3))
    env = env_of(2.0, (0.3, 0.55, -20.0), (1.0, 1.25, -20.0))
    out, _, _ = refined(ws, env)
    assert out[0].end == pytest.approx(0.55 + se.RELEASE_S)


def test_a_zero_length_last_word_keeps_its_own_sound():
    """B2: whisper's zero-length last word over its own sound: its span reaches over the sound after it."""
    ws = words(("that's", 0.3, 0.8), ("it.", 0.8, 0.8))
    env = env_of(2.0, (0.3, 0.55, -20.0), (0.7, 0.95, -20.0))
    out, stats, _ = refined(ws, env)
    assert out[1].end >= 0.95 and 1 in stats["heard"] and stats["inaudible"] == []


# ── silent words: inaudible runs, whisper's timing, misplaced words ─────────────────────────────────────────

def test_a_lone_silent_word_is_folded_against_its_neighbour():
    ws = words(("and", 0.3, 0.6), ("that", 0.6, 0.9), ("is", 0.9, 1.2), ("what", 1.2, 1.5), ("we", 1.5, 1.8))
    env = env_of(2.5, (0.3, 0.55, -20.0), (0.6, 0.85, -20.0), (1.2, 1.45, -20.0), (1.5, 1.75, -20.0))
    out, stats, _ = refined(ws, env)
    assert stats["inaudible"] == [] and stats["folded"] == [2]
    assert out[2].start == pytest.approx(out[1].end) and out[2].end - out[2].start == pytest.approx(se.LONE_WORD_S)


def test_misplaced_words_whose_sound_is_in_a_long_neighbour_are_kept():
    """"ride the bike": whisper put "the bike" in the pause, and "ride"'s span holds the sound of all three."""
    ws = words(("we", 0.1, 0.3), ("ride", 0.3, 1.5), ("the", 1.5, 1.9), ("bike", 1.9, 2.3), ("now.", 2.3, 2.6))
    env = env_of(3.0, (0.1, 0.28, -20.0), (0.3, 1.35, -20.0), (2.3, 2.55, -20.0))
    out, stats, _ = refined(ws, env)
    assert stats["inaudible"] == [] and stats["folded"] == [2, 3]
    assert out[2].start == pytest.approx(out[1].end)


def test_a_truly_silent_run_between_two_short_words_is_inaudible():
    ws = words(("we", 0.1, 0.3), ("ride", 0.3, 0.8), ("the", 0.8, 1.2), ("bike", 1.2, 1.6), ("now.", 1.6, 1.9))
    env = env_of(2.5, (0.1, 0.28, -20.0), (0.3, 0.6, -20.0), (1.6, 1.85, -20.0))
    _, stats, _ = refined(ws, env)
    assert stats["inaudible"] == [2, 3]


def test_a_silent_run_just_before_an_over_long_word_is_kept():
    """#2 should-fix 5: whisper starts the line early, in the pause: "and so" over silence, "we" spans their sound."""
    ws = words(("one.", 1.2, 1.5), ("and", 1.9, 2.2), ("so", 2.2, 2.5), ("we", 2.5, 3.85), ("went", 3.9, 4.2))
    env = env_of(5.0, (1.2, 1.45, -20.0), (3.0, 3.25, -20.0), (3.3, 3.55, -20.0), (3.6, 3.85, -20.0),
                 (3.9, 4.15, -20.0))
    out, stats, _ = refined(ws, env)
    assert stats["inaudible"] == [] and stats["folded"] == [1, 2]
    assert out[2].end == pytest.approx(out[3].start)


# ── the envelope ──────────────────────────────────────────────────────────────────────────────────────────

def _stereo(path, total, anti_phase=True):
    rate = 16000
    frames = bytearray()
    for i in range(int(total * rate)):
        v = int(0.1 * 32767 * math.sin(2 * math.pi * 220 * i / rate)) if 0.5 * rate <= i < 1.0 * rate else 0
        frames += struct.pack("<hh", v, -v if anti_phase else 0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))


def test_the_envelope_takes_the_louder_channel_never_a_mixdown(tmp_path):
    """Nit 12: two channels in anti-phase cancel in a mono mixdown; the louder channel per frame does not."""
    p = tmp_path / "anti.wav"
    _stereo(p, 1.5)
    env = se.envelope(str(p))
    assert max(env[55:95]) > -25.0


def test_a_clip_with_no_audio_is_refused_clearly(tmp_path, capsys):
    p = tmp_path / "silent.mp4"
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=32x32:r=10:d=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(p)], check=True, capture_output=True)
    with pytest.raises(SystemExit):
        se.envelope(str(p))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "no_audio" and "silent.mp4" in err["message"]


def test_a_decode_over_the_limit_answers_clearly(monkeypatch, tmp_path, capsys):
    def slow(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
    monkeypatch.setattr(se, "run", slow)
    with pytest.raises(SystemExit):
        se.envelope(str(tmp_path / "long.mov"))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "audio_timeout" and "600 s" in err["message"]


# ── tidy: no partial word, no sliver (dead slivers, word fragments) ────────────────────────────────────────

from lib.speech_build import Report, Run  # noqa: E402
from lib.speech_lines import Line  # noqa: E402


class _Derived:
    def __init__(self, by_src):
        self.letters = {src: chr(ord("A") + n) for n, src in enumerate(by_src)}
        self.lines = {f"{self.letters[src]}1": Line(f"{self.letters[src]}1", tuple(ws)) for src, ws in by_src.items()}


class _Heard:
    def __init__(self, heard, end=60.0):
        self.heard, self._end = heard, end

    def end(self, src):
        return self._end


def run_of(src, a, b, ws=()):
    return Run(src, a, b, 0, "A1", words=list(ws))


def spans(runs):
    return [(r.src, round(r.s_in, 3), round(r.s_out, 3), r.words) for r in runs]


def test_a_breath_left_alone_between_removed_words_is_dropped():
    ws = words(("we", 0.3, 0.6), ("lean", 0.6, 0.9), ("is", 1.5, 1.54), ("so", 2.4, 2.7))
    d = _Derived({"a": ws})
    runs = [run_of("a", 0.26, 0.94, [0, 1]), Run("", 0, 0, 0, None, kind="gap", dur=0.5),
            run_of("a", 1.46, 1.58, [2]), Run("", 0, 0, 0, None, kind="gap", dur=0.5), run_of("a", 2.36, 2.74, [3])]
    rep = Report()
    out = se.tidy(runs, d, _Heard({"a": {0, 1, 3}}), rep)
    assert [r for r in out if r.kind == "speech" and r.s_out - r.s_in < se.SLIVER_S] == []
    assert {"kind": "sliver", "letter": "A", "idx": [2], "seconds": 0.12} in rep.flagged


def test_a_sliver_that_follows_on_in_the_source_is_merged_into_its_neighbour():
    ws = words(("we", 0.3, 0.6), ("lean.", 0.6, 0.9), ("so", 2.4, 2.7))
    d = _Derived({"a": ws})
    runs = [run_of("a", 0.26, 0.94, [0, 1]), run_of("a", 1.2, 1.32), run_of("b", 0.0, 2.0)]
    out = se.tidy(runs, d, _Heard({"a": {0, 1, 2}}))
    assert spans(out)[:1] == [("a", 0.26, 1.06, [0, 1])] and len(out) == 2


def test_a_short_whole_word_is_kept_but_never_a_piece_under_a_tenth():
    ws = words(("Yes.", 1.0, 1.15))
    d = _Derived({"a": ws})
    keep = se.tidy([run_of("a", 0.98, 1.18, [0]), run_of("b", 0.0, 2.0)], d, _Heard({"a": {0}}))
    assert spans(keep)[0] == ("a", 0.98, 1.18, [0])
    ws = words(("a", 1.0, 1.05))
    gone = se.tidy([run_of("a", 1.0, 1.06, [0]), run_of("b", 0.0, 2.0)], _Derived({"a": ws}), _Heard({"a": {0}}))
    assert [r.src for r in gone] == ["b"]


def test_a_breath_opening_a_clip_before_a_removed_retake_is_dropped():
    """The kungfu case: the first kept piece of a clip, 0.13 s of breath, with nothing of its source before it."""
    ws = words(("um", 0.0, 0.1), ("so", 0.2, 0.5), ("go", 0.5, 0.8), ("now.", 2.0, 2.3))
    d = _Derived({"b": ws})
    out = se.tidy([run_of("a", 0.0, 3.0), run_of("b", 0.07, 0.2), run_of("b", 1.96, 2.34, [3])], d,
                  _Heard({"b": {1, 2, 3}}))
    assert spans(out) == [("a", 0.0, 3.0, []), ("b", 1.96, 2.34, [3])]


def test_a_removed_words_fragment_is_trimmed_off_a_kept_word_clipped_is_restored():
    ws = words(("cut", 0.9, 1.1), ("keep", 1.1, 1.5), ("this", 1.5, 1.9))
    d = _Derived({"a": ws})
    out = se.tidy([run_of("a", 1.0, 1.95, [1, 2])], d, _Heard({"a": {0, 1, 2}}))
    assert spans(out) == [("a", 1.1, 1.95, [1, 2])]            # (a): none of "cut" plays
    out = se.tidy([run_of("a", 1.2, 1.95, [1, 2])], d, _Heard({"a": {0, 1, 2}}))
    assert spans(out) == [("a", 1.1, 1.95, [1, 2])]            # (b): "keep" plays whole
    out = se.tidy([run_of("a", 0.5, 1.15), run_of("a", 1.2, 1.95, [1, 2])], d, _Heard({"a": {1, 2}}))
    assert spans(out) == [("a", 0.5, 1.95, [1, 2])]              # never over another piece: up to it, then one
