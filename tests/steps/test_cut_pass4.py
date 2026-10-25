"""§558 cut, fix pass 4: no long silence kept inside the applied timeline, at its lead and tail, or inside a word's
span; the take rules still read the spans as they were. Synthetic tones over a set room, invented words.

The flat check mirrors the controller's acceptance tool (flat.py): 10 ms RMS frames of each kept item's source,
"flat" when 30 dB or more under the source's 95th-percentile frame; no flat run inside a kept item longer than
max-pause, and at most a breath (0.1 s) of flat before the video's first sound and after its last. Frames of a tone
a person hears (10 dB or more over the room), and the RELEASE_S after it (a tone stops dead where a word's sound
decays), are a word, never flat ("unless it holds an audible word")."""
import json
import math
import re
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from lib import speech_energy as se
from lib.common import ffmpeg_bin
from lib.speech_lines import Word, norm
from tests.steps import test_cut as tc
from tests.steps.test_cut import stub_transcribe  # noqa: F401  (the fixture)
from tests.steps.test_cut_pass3 import _fuzz, assert_no_unwarned_island, cover, plan_apply

SP = -20.0
ROOM = -65.0
MAX_PAUSE = 0.45
LEAD_S = 0.10
# what a flat run (and the fuzz's lead and tail) may run over the bar in these synthetic files: a tone's edge falls
# inside a 10 ms frame (one frame each side), and a word whisper placed with no sound of its own is folded
# LONE_WORD_S against its host's edge, inside the pause max-pause caps between word spans (a known limit: the cap
# reads word spans, not sound)
QUANT_S = 2 * se.FRAME_S + se.LONE_WORD_S
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


def flat_report(d, tones, room, max_pause=MAX_PAUSE):
    """flat.py's numbers on the applied timeline: {"runs": [(item, source start, length)] over max_pause, "lead",
    "tail", "items": [(head flat, tail flat)] per item}. `tones`: {media name: [(t0, t1, db)]}; a tone 10 dB or more
    over `room` is an audible word, never flat."""
    p = json.loads((d / "project.json").read_text())
    items = [it for it in p["tracks"][0]["items"] if it.get("type") in (None, "video", "audio")]
    cache, runs, timeline, heads = {}, [], [], []
    for it in items:
        f = Path(it["src"]).name
        if f not in cache:
            db = np.array(se.envelope(it["src"]))
            heard = np.zeros(len(db), bool)
            for t0, t1, lv in tones.get(Path(f).stem, ()):
                if lv >= room + 10:          # with its release: a tone stops dead where a word's sound decays
                    heard[int(round(t0 * 100)):int(round((t1 + se.RELEASE_S) * 100))] = True
            cache[f] = (db, np.percentile(db, 95), heard)
        db, ref, heard = cache[f]
        a, b = float(it["inPoint"]), float(it["outPoint"])
        seg = ((db < ref - 30) & ~heard)[int(a * 100):int(b * 100)]
        timeline.extend(seg.tolist())
        head = next((k for k, v in enumerate(seg) if not v), len(seg)) / 100
        tail = next((k for k, v in enumerate(seg[::-1]) if not v), len(seg)) / 100
        heads.append((head, tail))
        i = 0
        while i < len(seg):
            if seg[i]:
                j = i
                while j < len(seg) and seg[j]:
                    j += 1
                if (j - i) / 100 > max_pause + 1e-9:
                    runs.append((it["id"], round(a + i / 100, 2), (j - i) / 100))
                i = j
            else:
                i += 1
    lead = next((k for k, v in enumerate(timeline) if not v), len(timeline)) / 100
    tail = next((k for k, v in enumerate(timeline[::-1]) if not v), len(timeline)) / 100
    return {"runs": runs, "lead": lead, "tail": tail, "items": heads}


def assert_flat_ok(d, tones, room, text="", slack=0.0):
    """No flat run over max-pause (+ slack) in a kept item; at most LEAD_S of flat at the video's lead and tail,
    unless that edge's item is an island the island rule widened (ISLAND_S, P3-1: it wins over the edge trim)."""
    rep = flat_report(d, tones, room, MAX_PAUSE + slack)
    iv = tc.kept_iv(d)
    island = [b - a <= se.ISLAND_S + 0.011 for a, b in (iv[0], iv[-1])] if iv else [False, False]
    assert not rep["runs"] and (rep["lead"] <= LEAD_S + slack + 1e-9 or island[0]) and \
        (rep["tail"] <= LEAD_S + slack + 1e-9 or island[1]), f"{rep}\niv={iv}\n{text.split('## Cut')[-1]}"
    return rep


# ── the red case: whisper's spans stretched over silences, and an offered soft word ────────────────────────────

STRETCHED = (
    [(0.30, 0.60, SP), (2.10, 2.40, SP), (2.45, 2.75, SP), (4.70, 5.00, ROOM + 7), (5.45, 5.75, SP), (5.80, 6.10, SP)],
    [("alpha", 0.30, 2.10), ("beta", 2.10, 2.45), ("gamma", 2.45, 4.25), ("soft", 4.25, 5.45), ("delta", 5.45, 5.80),
     ("epsilon.", 5.80, 6.10)],
    6.8)


def test_stretched_spans_and_an_offered_soft_word_keep_no_long_silence(tmp_path, monkeypatch):
    """Whisper stretches "alpha" and "gamma" over 1.5 s silences, and "soft" (7 dB over the room: offered, never
    removed) over 1.2 s of which 0.3 s is its sound. A quieter first stretch (a camera's first frames) reads the
    room low, which switched the old trim off. The applied timeline keeps no flat run over max-pause, every word
    stays said, "soft" is offered, and it keeps a breath-length anchor, not its 1.2 s."""
    spans, words, total = STRETCHED
    d = room_project(tmp_path, monkeypatch, [("vo", spans, total, words)], dips=[(0.0, 0.25)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert "soft [inaudible?]" in plan.get("cut", ""), (plan.get("cut"), text)       # offered, kept in ## Cut
    assert_flat_ok(d, {"vo": spans}, ROOM, text)
    lost = [(a, b) for a, b, db in spans if db >= ROOM + 10 and cover(d, a, b) < 0.99]
    assert not lost, (lost, tc.kept_iv(d))
    assert cover(d, 4.25, 5.45) * 1.2 <= 0.2, (tc.kept_iv(d), text)
    assert_no_unwarned_island(d, plan, applied)


def test_dense_speech_trims_a_silence_inside_a_stretched_span(tmp_path, monkeypatch):
    """Dense delivery, whisper's words gapless from 0.0 to the end, so no frame lies outside them (an untrusted
    room reading). Word 12's span runs over a 1 s silence after its sound: trimmed all the same."""
    spans, words, t = [], [], 0.0
    for k in range(24):
        spans.append((round(t, 2), round(t + 0.25, 2), SP))
        span_end = t + 0.26 + (1.0 if k == 12 else 0.0)
        words.append((f"w{k}" + ("." if k == 23 else ""), round(t, 2), round(span_end, 2)))
        t = round(span_end, 2)
    d = room_project(tmp_path, monkeypatch, [("vo", spans, t, words)])
    raw = [Word(i, w, norm(w), a, b) for i, (w, a, b) in enumerate(words)]
    assert se.noise_reading(raw, se.envelope(str(d / "vo.mov")))[1] is False        # untrusted
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert_flat_ok(d, {"vo": spans}, ROOM, text)
    assert all(cover(d, a, b) > 0.99 for a, b, _ in spans), tc.kept_iv(d)


# ── the video's lead and tail (Sam, pov v3), and a clip's tail ────────────────────────────────────────────────

def test_a_first_word_stretched_from_zero_over_silence_starts_at_its_sound(tmp_path, monkeypatch):
    """Whisper's first word runs from 0.0 over 2.8 s of silence, then the speech: the video starts at most a breath
    before the sound."""
    spans = [(2.80, 3.10, SP), (3.15, 3.45, SP), (3.50, 3.80, SP), (3.85, 4.15, SP)]
    words = [("you", 0.0, 3.10), ("are", 3.10, 3.50), ("riding", 3.50, 3.85), ("bikes.", 3.85, 4.15)]
    d = room_project(tmp_path, monkeypatch, [("vo", spans, 4.8, words)], dips=[(4.5, 4.8)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    rep = assert_flat_ok(d, {"vo": spans}, ROOM, text)
    assert tc.kept_iv(d)[0][0] >= 2.80 - LEAD_S - 1e-6, (rep, tc.kept_iv(d))
    assert said == [w for w, _, _ in words]


def test_a_last_word_stretched_over_silence_ends_at_its_sound(tmp_path, monkeypatch):
    spans = [(0.30, 0.60, SP), (0.65, 0.95, SP), (1.00, 1.30, SP), (1.35, 1.65, SP)]
    words = [("you", 0.30, 0.65), ("are", 0.65, 1.00), ("riding", 1.00, 1.35), ("bikes.", 1.35, 4.45)]
    d = room_project(tmp_path, monkeypatch, [("vo", spans, 4.5, words)], dips=[(0.0, 0.2)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    assert_flat_ok(d, {"vo": spans}, ROOM, text)
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
    rep = assert_flat_ok(d, {"c1": s1, "c2": s2}, ROOM, text)
    assert rep["items"][0][1] <= 0.2 + 1e-9, rep          # a sentence end's pause, not the 0.5 s
    assert said == [w for w, _, _ in w1 + w2]


# ── the existing fuzz, under the flat check ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("seed", range(80))
def test_the_drift_fuzz_keeps_no_long_silence(tmp_path, monkeypatch, seed):
    """Fix pass 3's fuzz (whisper drift up to 0.25 s, gapless spans, very short and near-noise tones): besides
    every heard tone playing whole, no flat run over max-pause, and at most a breath of lead and tail."""
    tones, words, end = _fuzz(seed)
    d = tc.tone_project(tmp_path, [("vo", tones, end, words)])
    plan, text, applied, said = plan_apply(d, monkeypatch)
    lost = [(w[0], a, b, db) for w, (a, b, db) in zip(words, tones) if not tc.plays_whole(d, a, b)]
    assert not lost and said == [w[0] for w in words], (lost, said, tc.kept_iv(d), words, tones, text)
    assert_flat_ok(d, {"vo": tones}, tc.NOISE_DB, f"words={words}\ntones={tones}\n{text}", slack=QUANT_S)


# ── the take rules read the spans as they were (fix pass 4 is the timeline only) ───────────────────────────────

def test_the_trim_leaves_the_take_rules_their_offer(tmp_path, stub_transcribe, monkeypatch):  # noqa: F811
    """The fixture's real pauses inside whisper's spans now show in the plan as dead air ("drag it {0.08} onto"),
    but the take rules still read the untrimmed spans: the fuzzy retake? offer of A6 is still made."""
    stub_transcribe(tc.retake_transcript())
    d = tc.make_project(tmp_path)
    tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    cut, unused = tc.sections(text)
    row = next(r for r in cut if r.startswith("A6 "))
    assert "{0.08}" in row and "{0.08}" not in BASE_A6, row                       # the trim is on
    assert any(re.fullmatch(r"A6 Then drag (\{0\.\d\d\} )?it (\{0\.\d\d\} )?onto the timeline\. "
                            r"\[10\.7 retake\? A7 17\.8\]", r) for r in unused), unused
