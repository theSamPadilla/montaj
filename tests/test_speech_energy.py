"""§558 cut v5: lib/speech_energy's two layers (layer 1, where the sound is; layer 2, whisper's words placed on it) and
the silence trim of the apply's runs. Synthetic only: envelopes written frame by frame (dB per 10 ms) and media
generated here, with invented words."""
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
from lib.speech_build import Report, Run  # noqa: E402
from lib.speech_lines import Line, Word, norm  # noqa: E402

F = se.FRAME_S
NOISE = -70.0
SP = -20.0
MEDIA = __file__            # layer 1 is given its silences, so process_one only checks the media exists


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


def refiner(by_src, max_pause=0.45):
    """A real Refiner over envelopes: {src: (env, words)}."""
    ref = se.Refiner(max_pause)
    for src, (env, ws) in by_src.items():
        lay = se.layer1(MEDIA, env, max_pause)
        placed, kind = se.place(ws, lay, ref.breath)
        att = se._attached_frames(ws, placed, kind, lay, max_pause)
        if att:
            lay = se.layer1(MEDIA, env, max_pause, att)
            placed, kind = se.place(ws, lay, ref.breath)
        ref.layers[src], ref.raw[src], ref.placed[src], ref.kinds[src] = lay, ws, placed, kind
        ref.heard[src] = {w.idx for w, k in zip(ws, kind) if k == "heard"}
    return ref


def placed_of(env, ws, max_pause=0.45):
    ref = refiner({"a": (env, ws)}, max_pause)
    return [(w.text, round(p.start, 3), round(p.end, 3), k) for w, p, k in zip(ws, ref.placed["a"], ref.kinds["a"])]


# ── the envelope ────────────────────────────────────────────────────────────────────────────────────────────

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


# ── layer 1 ─────────────────────────────────────────────────────────────────────────────────────────────────

def test_layer_1_reads_each_source_on_its_own_speech_level():
    """Speech at -50 over a -78 room: the line is -80, so the room is sound and nothing is cut (gain down)."""
    env = env_of(4.0, (0.5, 3.5, -50.0), noise=-78.0)
    lay = se.layer1(MEDIA, env, 0.45)
    assert lay.speech == pytest.approx(-50.0) and lay.threshold == pytest.approx(-80.0) and lay.silences == []
    env = env_of(4.0, (0.5, 1.5, SP), (2.5, 3.5, SP))
    lay = se.layer1(MEDIA, env, 0.45)
    assert lay.silences == [(0.0, 0.5), (1.5, 2.5), (3.5, 4.0)] and lay.voiced == [[0.5, 1.5], [2.5, 3.5]]


def test_a_pause_under_max_pause_stays_and_any_sound_is_kept():
    env = env_of(3.0, (0.5, 1.0, SP), (1.5, 1.53, SP), (2.0, 2.5, SP))
    lay = se.layer1(MEDIA, env, 0.45)
    assert [1.5, 1.53] in lay.voiced                    # 30 ms of sound between two silences: kept (min_keep 0)
    env = env_of(3.0, (0.5, 1.0, SP), (1.4, 2.4, SP))
    assert se.layer1(MEDIA, env, 0.45).voiced == [[0.5, 2.4]]       # a 0.4 s pause stays


def test_the_keeps_take_a_breath_each_side_and_a_sentence_end_takes_more():
    env = env_of(4.0, (0.5, 1.5, SP), (2.5, 3.5, SP))
    ws = words(("one", 0.5, 1.5), ("two", 2.5, 3.5))
    ref = refiner({"a": (env, ws)})
    assert ref.keeps("a") == [[0.46, 1.54], [2.46, 3.54]]
    ws = words(("one.", 0.5, 1.5), ("two", 2.5, 3.5))
    ref = refiner({"a": (env, ws)})
    assert ref.keeps("a") == [[0.46, 1.59], [2.41, 3.54]]          # min(1.0, 0.18) at a sentence end, half a side


def test_a_held_silence_is_kept_whole():
    env = env_of(4.0, (0.5, 1.5, SP), (2.5, 3.5, SP))
    ref = refiner({"a": (env, words(("one", 0.5, 1.5), ("two", 2.5, 3.5)))})
    ref.hold("a", 1)
    assert ref.keeps("a") == [[0.46, 3.54]]


def test_a_short_keep_widens_into_its_own_silence_away_from_the_source_edge():
    env = env_of(4.0, (0.1, 0.15, SP), (2.5, 3.5, SP))
    ref = refiner({"a": (env, words(("I", 0.1, 0.15), ("two", 2.5, 3.5)))})
    first = ref.keeps("a")[0]
    assert first[1] - first[0] == pytest.approx(se.ISLAND_S) and first[0] >= 0.1 - se.VIDEO_EDGE_S - 1e-9


def test_sound_after_the_last_word_is_not_kept():
    env = env_of(6.0, (0.5, 1.5, SP), (3.0, 5.0, SP))
    ref = refiner({"a": (env, words(("one", 0.5, 1.5)))})
    assert ref.keeps("a") == [[0.46, 1.54]]


# ── layer 2: the words on the sound ─────────────────────────────────────────────────────────────────────────

def test_a_stretched_word_is_placed_on_its_sound():
    env = env_of(4.0, (2.8, 3.1, SP), (3.15, 3.45, SP))
    assert placed_of(env, words(("you", 0.0, 3.15), ("are.", 3.15, 3.45)))[0] == ("you", 2.8, 3.1, "heard")


def test_a_short_run_of_the_next_words_sound_at_a_spans_end_goes_to_it():
    """Whisper drift: 'is' ends 0.2 s inside 'bike's sound, after a silence in its own span."""
    env = env_of(4.0, (0.3, 0.6, SP), (1.6, 2.0, SP))
    out = placed_of(env, words(("is", 0.3, 1.8), ("bike.", 1.8, 2.0)))
    assert out == [("is", 0.3, 0.6, "heard"), ("bike.", 1.6, 2.0, "heard")]


def test_a_soft_word_whose_span_takes_in_a_neighbours_onset_keeps_its_own_sound():
    """R3-B1: 'pigeon' at -55 (35 dB under the speech, under the line) between kept words, its span running 20 ms
    into 'pepper': the 20 ms are pepper's; pigeon is attached, so its own frames play."""
    env = env_of(3.2, (0.30, 0.55, SP), (0.60, 0.85, SP), (0.95, 1.55, -55.0), (1.60, 1.85, SP), (1.90, 2.15, SP))
    ws = words(("so", 0.30, 0.60), ("the", 0.60, 0.95), ("pigeon", 0.95, 1.62), ("pepper", 1.62, 1.90),
               ("hot.", 1.90, 2.15))
    out = placed_of(env, ws)
    assert out[2] == ("pigeon", 0.95, 1.55, "heard") and out[3][1] == 1.6, out


def test_an_attached_word_needs_kept_words_beside_it_and_never_opens_the_video():
    env = env_of(3.0, (0.30, 0.50, -55.0), (1.20, 1.50, SP), (2.40, 2.60, -55.0))
    out = placed_of(env, words(("faint", 0.3, 0.5), ("loud", 1.2, 1.5), ("faint.", 2.4, 2.6)))
    assert [k for *_, k in out] == ["inaudible", "heard", "inaudible"], out


def test_a_breath_with_no_word_stays_silence():
    env = env_of(3.3, (0.30, 0.60, -13.0), (0.65, 0.95, -13.0), (1.40, 1.55, -50.0), (1.95, 2.25, -13.0))
    ref = refiner({"a": (env, words(("we", 0.3, 0.65), ("went", 0.65, 1.95), ("back.", 1.95, 2.25)))})
    assert not ref.layers["a"].attached and not any(a < 1.5 < b for a, b in ref.keeps("a"))


def test_a_word_with_no_sound_in_a_pause_is_offered_and_one_in_a_silence_is_inaudible():
    env = env_of(4.0, (0.3, 0.6, SP), (0.9, 1.2, SP), (2.9, 3.2, SP))
    out = placed_of(env, words(("a", 0.3, 0.6), ("x", 0.65, 0.85), ("b", 0.9, 1.2), ("y", 1.6, 1.8),
                               ("z", 2.0, 2.2), ("c.", 2.9, 3.2)))
    assert [k for *_, k in out] == ["heard", "quiet", "heard", "inaudible", "inaudible", "heard"], out


def test_a_lone_word_in_a_silence_is_whispers_timing_and_kept():
    env = env_of(4.0, (0.3, 0.6, SP), (2.9, 3.2, SP))
    out = placed_of(env, words(("a", 0.3, 0.6), ("x", 1.6, 1.8), ("c.", 2.9, 3.2)))
    assert out[1][3] == "folded" and 0.6 <= out[1][1] <= 0.64, out


def test_a_run_a_long_neighbour_holds_is_kept():
    env = env_of(4.0, (0.3, 0.55, SP), (0.6, 1.65, SP), (2.4, 2.65, SP))
    out = placed_of(env, words(("we", 0.3, 0.6), ("ride", 0.6, 1.7), ("the", 1.7, 2.05), ("bike", 2.05, 2.4),
                               ("all.", 2.4, 2.65)))
    assert [k for *_, k in out] == ["heard", "heard", "folded", "folded", "heard"], out


def test_an_inaudible_word_sits_in_the_breath_of_the_sound_before_it():
    env = env_of(4.0, (0.3, 0.6, SP), (2.9, 3.2, SP))
    ref = refiner({"a": (env, words(("a", 0.3, 0.6), ("x", 1.4, 1.6), ("y", 1.6, 1.8), ("c.", 2.9, 3.2)))})
    p = ref.placed["a"]
    assert all(0.6 < (w.start + w.end) / 2 < ref.keeps("a")[0][1] for w in p[1:3]), p


# ── the silence trim and the island rule on the apply's runs ────────────────────────────────────────────────


class _Derived:
    def __init__(self, by_src):
        self.letters = {src: chr(ord("A") + n) for n, src in enumerate(by_src)}
        self.lines = {f"{self.letters[src]}1": Line(f"{self.letters[src]}1", tuple(ws)) for src, ws in by_src.items()}


def run_of(src, a, b, ws=()):
    return Run(src, a, b, 0, "A1", words=list(ws))


def spans(runs):
    return [(r.src, round(r.s_in, 3), round(r.s_out, 3), r.words) for r in runs]


def test_a_kept_run_is_cut_to_layer_1s_keeps():
    env = env_of(4.0, (0.5, 1.5, SP), (2.5, 3.5, SP))
    ws = words(("one", 0.5, 1.5), ("two", 2.5, 3.5))
    ref = refiner({"a": (env, ws)})
    out = se.tidy([run_of("a", 0.0, 4.0, [0, 1])], _Derived({"a": ws}), ref)
    assert spans(out) == [("a", 0.46, 1.54, [0]), ("a", 2.46, 3.54, [1])]


def test_an_island_joins_its_neighbour_across_a_pause_cut():
    env = env_of(3.0, (0.3, 0.6, SP), (0.9, 1.0, SP), (1.3, 1.9, SP))
    ws = words(("so", 0.3, 0.6), ("how", 0.9, 1.0), ("much.", 1.3, 1.9))
    ref = refiner({"a": (env, ws)})
    out = se.tidy([run_of("a", 0.26, 0.64, [0]), run_of("a", 0.86, 1.04, [1]), run_of("a", 1.26, 1.94, [2])],
                  _Derived({"a": ws}), ref)
    assert spans(out) == [("a", 0.26, 1.04, [0, 1]), ("a", 1.26, 1.94, [2])]


def test_an_island_widens_into_its_own_silence_and_a_sliver_goes():
    env = env_of(4.0, (0.3, 0.6, SP), (1.5, 1.6, SP), (2.9, 3.2, SP))
    ws = words(("a", 0.3, 0.6), ("Yes.", 1.5, 1.6), ("c.", 2.9, 3.2))
    ref = refiner({"a": (env, ws)})
    rep = Report()
    out = se.tidy([run_of("a", 0.26, 0.64, [0]), run_of("a", 1.46, 1.64, [1]), run_of("a", 2.2, 2.3),
                   run_of("a", 2.86, 3.24, [2])], _Derived({"a": ws}), ref, rep)
    assert spans(out)[1] == ("a", 1.375, 1.725, [1]) and len(out) == 3
    assert not [f for f in rep.flagged if f["kind"] == "island"]


def test_an_island_that_can_neither_join_nor_widen_is_kept_and_named():
    """(d): removed words hug 'Yes.' on both sides, so it can only stay as it is, and the answer names it."""
    from steps.edit import cut as cc
    env = env_of(3.0, (0.3, 0.6, SP), (0.9, 0.98, SP), (1.0, 1.15, SP), (1.18, 1.3, SP), (2.4, 2.7, SP))
    ws = words(("a", 0.3, 0.6), ("x", 0.9, 0.98), ("Yes.", 1.0, 1.15), ("z", 1.18, 1.3), ("b.", 2.4, 2.7))
    ref = refiner({"a": (env, ws)})
    rep = Report()
    d = _Derived({"a": ws})
    out = se.tidy([run_of("a", 0.26, 0.64, [0]), run_of("a", 0.98, 1.18, [2]), run_of("a", 2.36, 2.74, [4])], d, ref,
                  rep)
    assert spans(out)[1] == ("a", 0.98, 1.18, [2])                      # never shortened, never dropped
    assert {"kind": "island", "letter": "A", "idx": [2], "seconds": 0.2} in rep.flagged
    assert cc._piece_warnings(d, rep.flagged) == ["kept 1 short piece(s) with a heard word, under 0.35 s: A1 0.20 s"]


def test_the_video_opens_and_ends_on_sound():
    env = env_of(4.0, (1.0, 1.5, SP), (1.6, 2.4, SP))
    ws = words(("one", 1.0, 1.5), ("two.", 1.6, 2.4))
    ref = refiner({"a": (env, ws)})
    ref.layers["a"].keeps = [[0.0, 4.0]]                                 # as a held silence would leave it
    out = se.tidy([run_of("a", 0.4, 3.0, [0, 1])], _Derived({"a": ws}), ref)
    assert spans(out) == [("a", 0.96, 2.44, [0, 1])]
