"""§558 cut v5: the trim layer, audio first. Layer 1 (where the sound is: waveform_trim on the source's own 10 ms
RMS reading, at its speech level less 30 dB) decides silence; layer 2 (whisper's words) decides what goes. Every
applied result is judged by tests/cut_checks.py (flat.py's definitions, no slack). Synthetic tones and noise at set
levels, invented words; no real media but the repo's own fixture."""
import json
import math
import random
import re
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from lib import speech_energy as se
from lib.common import ffmpeg_bin
from steps.audio import waveform_trim
from tests import cut_checks
from tests.steps import test_cut as tc
from tests.steps.test_cut import stub_transcribe  # noqa: F401  (the fixture)
from tests.steps.test_cut_pass3 import apply_without_labeled

SP = -20.0


# ── synthetic media: a room, bursts and tones at set levels ─────────────────────────────────────────────────

def media(path, total, room, tones=(), bursts=(), seed=7, rate=tc.RATE):
    """A .mov like test_cut.tone_media: room noise at `room` dB RMS, a 220 Hz tone at `db` over each (t0, t1, db) of
    `tones`, and a burst of noise at `db` over each (t0, t1, db) of `bursts`."""
    rnd = np.random.default_rng(seed)
    n = int(total * rate)
    x = rnd.uniform(-1, 1, size=n) * 10 ** (room / 20) * math.sqrt(3)
    t = np.arange(n) / rate
    for t0, t1, db in tones:
        k0, k1 = int(t0 * rate), min(n, int(t1 * rate))
        x[k0:k1] += np.sin(2 * np.pi * 220 * t[k0:k1]) * 10 ** (db / 20) * math.sqrt(2)
    for t0, t1, db in bursts:
        k0, k1 = int(t0 * rate), min(n, int(t1 * rate))
        x[k0:k1] = rnd.uniform(-1, 1, size=k1 - k0) * 10 ** (db / 20) * math.sqrt(3)
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


def project(tmp_path, monkeypatch, clips, room=-70.0, bursts=None):
    """test_cut.tone_project on `media`: clips [(name, tones, total, words)]; bursts: {name: [(t0, t1, db)]}."""
    bursts = bursts or {}
    monkeypatch.setattr(tc, "tone_media",
                        lambda path, tones, total: media(path, total, room, tones, bursts.get(Path(path).stem, ())))
    return tc.tone_project(tmp_path, clips)


def plan_apply(d, monkeypatch, *extra):
    before = json.loads((d / "project.json").read_text())
    plan, _ = tc.run(d, *extra, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    return plan, text, applied, [w for w, _, _ in tc.played_words(d)], before


def checked(d, plan, applied, before, kept=()):
    """cut_checks on the applied project: no failure."""
    fails = cut_checks.check(d, before, kept, (plan, applied))
    assert not fails, (fails, tc.kept_iv(d), (d / "cut-plan.md").read_text().split("## Cut")[-1])


def cover(d, a, b):
    return sum(max(0.0, min(e, b) - max(s, a)) for s, e in tc.kept_iv(d)) / (b - a)


def kept_tones(name, tones, keep=None):
    return [(name, a, b) for k, (a, b, _) in enumerate(tones) if keep is None or k in keep]


# ── layer 1 is waveform_trim, adapted ──────────────────────────────────────────────────────────────────────

def test_the_step_cli_still_reads_silencedetect(monkeypatch):
    """The step's own path is unchanged: process_one with no silences runs ffmpeg's silencedetect at its threshold,
    and keeps its 50 ms floor."""
    seen = []

    class R:
        stderr = "silence_start: 1.0\nsilence_end: 2.0 | silence_duration: 1.0\n"
    monkeypatch.setattr(waveform_trim, "require_file", lambda p: None)
    monkeypatch.setattr(waveform_trim, "get_duration", lambda p: 3.0)
    monkeypatch.setattr(waveform_trim, "ff_input", lambda p: p)
    monkeypatch.setattr(waveform_trim, "run", lambda cmd, check=False: seen.append(cmd) or R())
    spec = waveform_trim.process_one("x.mp4", -30.0, 0.3)
    assert any("silencedetect=noise=-30.0dB:d=0.3" in a for a in seen[0]), seen
    assert spec["keeps"] == [[0.0, 1.0], [2.0, 3.0]]
    # min_keep: a 40 ms keep between two silences goes by default, stays with min_keep 0 (cut's)
    sils = [(0.0, 1.0), (1.04, 3.0)]
    with pytest.raises(SystemExit):                                       # no keep left: no_speech, as before
        waveform_trim.process_one("x.mp4", 0, 0, silences=sils)
    assert waveform_trim.process_one("x.mp4", 0, 0, silences=sils, min_keep=0.0)["keeps"] == [[1.0, 1.04]]
    assert len(seen) == 1                                                  # given silences: no ffmpeg


def test_the_envelope_silences_are_flat_runs_of_max_pause_or_more():
    env = [-20.0] * 10 + [-60.0] * 45 + [-20.0] * 5 + [-60.0] * 44 + [-20.0] * 3
    assert waveform_trim.envelope_silences(env, -50.0, 0.45) == [(0.1, 0.55)]
    assert waveform_trim.flat_runs(env, -50.0) == [(10, 55), (60, 104)]
    assert waveform_trim.percentile([1.0, 2.0, 3.0, 4.0], 95) == pytest.approx(float(np.percentile([1, 2, 3, 4], 95)))


# ── pov's opening (red on b7639ba5: the video opened 2.1 s early) ──────────────────────────────────────────────

POV_ROOM = -72.0


def _pov():
    bursts = [(round(0.4 + 0.1 * k, 2), round(0.43 + 0.1 * k, 2), (-45.0, -50.0, -55.0, -60.0, -65.0, -69.0)[k % 6])
              for k in range(24)]
    tones = [(2.80, 3.10, -13.0), (3.15, 3.45, -11.0), (3.50, 3.80, -13.0), (3.85, 4.15, -15.0),
             (4.20, 4.50, -13.0), (4.55, 4.85, -13.0)]
    words = [("you", 0.4, 3.15), ("are", 3.15, 3.50), ("riding", 3.50, 3.85), ("a", 3.85, 4.20), ("bike", 4.20, 4.55),
             ("today.", 4.55, 4.85)]
    return bursts, tones, words


def test_povs_opening_starts_a_breath_before_its_speech(tmp_path, monkeypatch):
    """Room at -72, mouth bursts at -45..-69 every 100 ms from 0.4 s, speech at -13 from 2.8 s, whisper's first word
    stretched from 0.4: the bursts are silence (30 dB or more under the speech), so the video opens at most 0.1 s
    before 2.8."""
    bursts, tones, words = _pov()
    d = project(tmp_path, monkeypatch, [("pov", tones, 5.6, words)], room=POV_ROOM, bursts={"pov": bursts})
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    assert tc.kept_iv(d)[0][0] >= 2.80 - 0.10 - 1e-6, tc.kept_iv(d)
    assert said == [w for w, _, _ in words], (said, text)
    checked(d, plan, applied, before, kept_tones("pov", tones))


# ── stretched spans (red on b7639ba5: flat runs of 1.5 s kept) ─────────────────────────────────────────────────

STRETCHED = (
    [(0.30, 0.60, SP), (2.10, 2.40, SP), (2.45, 2.75, SP), (4.70, 5.00, -58.0), (5.45, 5.75, SP), (5.80, 6.10, SP)],
    [("alpha", 0.30, 2.10), ("beta", 2.10, 2.45), ("gamma", 2.45, 4.25), ("soft", 4.25, 5.45), ("delta", 5.45, 5.80),
     ("epsilon.", 5.80, 6.10)],
    6.8)


@pytest.mark.parametrize("soft_db", [-56.0, -66.0])
def test_stretched_spans_and_a_quiet_word_keep_no_long_silence(tmp_path, monkeypatch, soft_db):
    """Whisper stretches "alpha" and "gamma" over 1.5 s silences, and "soft" over 1.2 s of which 0.3 s is its sound,
    under the line. No flat run over max-pause. At -56 (36 dB under, over the attached line, room + 10) "soft" is
    attached: its own sound plays (an island), never its 1.2 s, and every word stays in the text. At -66 (46 dB
    under) it has no sound, and the guard does not hear it: inaudible, removed, and none of its 1.2 s plays."""
    tones, words, total = STRETCHED
    tones = [t if k != 3 else (t[0], t[1], soft_db) for k, t in enumerate(tones)]
    d = project(tmp_path, monkeypatch, [("vo", tones, total, words)], room=-65.0)
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    checked(d, plan, applied, before, kept_tones("vo", tones))
    if soft_db == -56.0:
        assert said == [w for w, _, _ in words], (said, text)
        assert cover(d, 4.70, 5.00) > 0.99 and cover(d, 4.25, 5.45) * 1.2 <= 0.45, tc.kept_iv(d)
    else:
        assert said == [w for w, _, _ in words if w != "soft"], (said, text)
        # PL89: the silence takes it, listed under ## Unused tagged inaudible
        assert cover(d, 4.25, 5.45) * 1.2 <= 0.05 and any(re.match(r"^A\d+ soft \[[\d.]+ inaudible\]$", r)
                                                         for r in tc.sections(text)[1]), (tc.kept_iv(d), text)


# ── gain down (red on b7639ba5 for the flat check) ────────────────────────────────────────────────────────────

def test_a_gain_down_clip_loses_no_word_sound(tmp_path, monkeypatch):
    """Clip two at -50 with its room at -78: read on its own speech level, every word's sound plays and nothing
    fails no_speech or empty_cut."""
    clips = []
    for n, (lines, db) in enumerate([(["this first clip is loud and clear."], -14.0),
                                     (["the second clip was recorded with the gain down", "but you hear it."], -50.0)]):
        tones, words, end = tc.spoken(lines, db=db)
        clips.append((f"vo{n}", tones, end + 1.0, words))
    d = project(tmp_path, monkeypatch, clips, room=-78.0)
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    assert said == [w for _, _, _, ws in clips for w, _, _ in ws], (said, text)
    for name, tones, _, _ in clips:
        p = json.loads((d / "project.json").read_text())
        iv = [(it["inPoint"], it["outPoint"]) for it in p["tracks"][0]["items"] if Path(it["src"]).stem == name]
        assert all(any(x <= a + 1e-3 and b - 1e-3 <= y for x, y in iv) for a, b, _ in tones), (name, iv)
    checked(d, plan, applied, before)


def test_a_whole_clip_at_minus_52_is_cut_and_keeps_every_word(tmp_path, monkeypatch):
    tones, words, end = tc.spoken(["this whole clip was recorded quietly", "but every word is clear."], db=-52.0)
    d = project(tmp_path, monkeypatch, [("vo", tones, end + 1.0, words)], room=-75.0)
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words] and applied["mode"] == "applied"
    assert all(cover(d, a, b) > 0.99 for a, b, _ in tones), tc.kept_iv(d)
    checked(d, plan, applied, before)


# ── a whisper (soft real word 20-29 dB under the speech) ──────────────────────────────────────────────────────

@pytest.mark.parametrize("under", [21.0, 25.0, 29.0])
def test_a_soft_real_word_plays_whole(tmp_path, monkeypatch, under):
    tones, words, end = tc.spoken(["and that is what we did today."])
    tones[2] = (tones[2][0], tones[2][1], SP - under)
    d = project(tmp_path, monkeypatch, [("vo", tones, end + 1.0, words)])
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words] and tc.plays_whole(d, *tones[2][:2]), tc.kept_iv(d)
    checked(d, plan, applied, before, kept_tones("vo", tones))


# ── kungfu's twin sayings (P3-2's exact shape) ────────────────────────────────────────────────────────────────

def test_kungfus_loud_last_take_is_applied_whole(tmp_path, monkeypatch):
    from tests.steps.test_cut_pass3 import KUNGFU_TONES, KUNGFU_WORDS
    d = project(tmp_path, monkeypatch, [("kf", KUNGFU_TONES, 16.4, KUNGFU_WORDS)], room=-55.0)
    before = json.loads((d / "project.json").read_text())
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    labeled = [r for r in tc.sections(text)[0] if " retake? " in r]
    assert labeled and all(r.split()[0] in ("A1", "A2", "A3", "A4") for r in labeled), labeled   # the first saying
    applied = apply_without_labeled(d, monkeypatch, text)                  # the agent takes the label
    said = [w for w, _, _ in tc.played_words(d)]
    assert said == [w for w, _, _ in KUNGFU_WORDS[9:]], (said, text)
    assert all(cover(d, a, b) > 0.99 for a, b, _ in KUNGFU_TONES[9:]), tc.kept_iv(d)
    assert all(cover(d, a, b) < 0.01 for a, b, _ in KUNGFU_TONES[:9]), tc.kept_iv(d)
    checked(d, plan, applied, before, kept_tones("kf", KUNGFU_TONES, range(9, len(KUNGFU_TONES))))


# ── faint words between pause cuts (P3-1, the island case) ────────────────────────────────────────────────────

@pytest.mark.parametrize("faint", [-47.0, -52.0, -58.0])
def test_faint_words_between_pause_cuts_leave_no_island(tmp_path, monkeypatch, faint):
    """'so {pause} how {pause} much {pause} should' with 'how' and 'much' faint: no kept item under 0.35 s unless
    named, and every word's sound that is heard plays."""
    tones = [(0.30, 0.50, SP), (0.95, 1.10, faint), (1.60, 1.75, faint), (2.25, 2.55, SP), (2.60, 2.85, SP),
             (2.90, 3.15, SP)]
    words = [("so", 0.30, 0.95), ("how", 0.95, 1.60), ("much", 1.60, 2.25), ("should", 2.25, 2.60),
             ("we", 2.60, 2.90), ("pay.", 2.90, 3.15)]
    d = project(tmp_path, monkeypatch, [("vo", tones, 3.9, words)])
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert not [x for x in tc.kept_iv(d) if x[1] - x[0] < 0.35 - 1e-6], tc.kept_iv(d)
    checked(d, plan, applied, before, kept_tones("vo", tones))


def test_an_isolated_short_loud_tone_between_two_silences_plays(tmp_path, monkeypatch):
    """A loud 30 ms 'I' alone between two silences of 0.45 s or more: layer 1 keeps every frame of sound (min_keep 0),
    and the island rule widens it into its own silence."""
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (1.50, 1.53, SP), (2.20, 2.45, SP), (2.50, 2.75, SP)]
    words = [("we", 0.30, 0.60), ("went", 0.60, 1.50), ("I", 1.50, 1.53), ("think", 1.53, 2.50), ("home.", 2.50, 2.75)]
    d = project(tmp_path, monkeypatch, [("vo", tones, 3.4, words)])
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    assert "I" in said and cover(d, 1.50, 1.53) > 0.99, (said, tc.kept_iv(d))
    checked(d, plan, applied, before, kept_tones("vo", tones))


# ── the orchestrator's attached-word rule (binding, 2026-10-24) ────────────────────────────────────────────────

def test_an_attached_soft_word_between_kept_words_keeps_its_sound(tmp_path, monkeypatch):
    """(1) 'your' at -44 between two kept words at -13 (31 dB under: under the line), with pauses that make a long
    flat run around it: its frames play, and the -46 guard loses no word."""
    tones = [(0.30, 0.60, -13.0), (0.65, 0.95, -13.0), (1.20, 1.40, -44.0), (1.65, 1.95, -13.0), (2.00, 2.30, -13.0)]
    words = [("this", 0.30, 0.65), ("is", 0.65, 1.20), ("your", 1.20, 1.65), ("bike", 1.65, 2.00), ("now.", 2.00, 2.30)]
    d = project(tmp_path, monkeypatch, [("vo", tones, 3.0, words)], room=-72.0)
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert cover(d, 1.20, 1.40) > 0.99, tc.kept_iv(d)
    checked(d, plan, applied, before, kept_tones("vo", tones))


def test_a_breath_with_no_word_between_kept_words_stays_silence(tmp_path, monkeypatch):
    """(2) a breath at -50 with no word, between two kept words 1.0 s apart: it stays silence (no word attached to
    it), and the gap is cut to the pause rule."""
    tones = [(0.30, 0.60, -13.0), (0.65, 0.95, -13.0), (1.95, 2.25, -13.0), (2.30, 2.60, -13.0)]
    words = [("we", 0.30, 0.65), ("went", 0.65, 1.95), ("back", 1.95, 2.30), ("home.", 2.30, 2.60)]
    d = project(tmp_path, monkeypatch, [("vo", tones, 3.3, words)], room=-72.0, bursts={"vo": [(1.40, 1.55, -50.0)]})
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    assert said == [w for w, _, _ in words], (said, text)
    assert cover(d, 1.40, 1.55) < 0.01, tc.kept_iv(d)
    gaps = [b[1] - a[2] for a, b in zip(tc.played_words(d), tc.played_words(d)[1:])]
    assert max(gaps) == pytest.approx(0.08, abs=0.02), gaps
    checked(d, plan, applied, before, kept_tones("vo", tones))


# ── a music track under a cut stretch ─────────────────────────────────────────────────────────────────────────

def test_a_music_track_under_a_cut_stretch_survives(tmp_path, monkeypatch):
    tones = [(0.30, 0.60, SP), (0.65, 0.95, SP), (2.95, 3.25, SP), (3.30, 3.60, SP)]
    words = [("we", 0.30, 0.65), ("start", 0.65, 2.95), ("again", 2.95, 3.30), ("now.", 3.30, 3.60)]
    d = project(tmp_path, monkeypatch, [("vo", tones, 4.3, words)])
    p = json.loads((d / "project.json").read_text())
    p["audio"] = {"tracks": [{"id": "music", "src": str(d / "vo.mov"), "start": 1.2, "end": 2.6, "inPoint": 0.0,
                              "outPoint": 1.4, "volume": 0.3}]}
    (d / "project.json").write_text(json.dumps(p, indent=2))
    tc.git(d, "commit", "-qam", "music")
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    music = json.loads((d / "project.json").read_text())["audio"]["tracks"]
    assert [m["id"] for m in music] == ["music"], music
    checked(d, plan, applied, before, kept_tones("vo", tones))


# ── the fixture: the A6 retake? pin, "timeline." kept, and the checks ──────────────────────────────────────────

def test_the_fixture_labels_a6_and_keeps_timeline_and_passes_the_checks(tmp_path, stub_transcribe, monkeypatch):  # noqa: F811
    """speech.mp4 with the retake transcript: the fuzzy retake? label on A6 is still made (F1 splits clauses at
    punctuation and units, not at the cut's silences); "timeline." (whisper put it in the silence after "the", which
    holds its sound) stays in the text; the agent takes the labeled takes by deleting their rows; and the applied cut passes every check (b7639ba5 kept a 0.52 s flat
    run at source 11.36)."""
    stub_transcribe(tc.retake_transcript())
    d = tc.make_project(tmp_path)
    before = json.loads((d / "project.json").read_text())
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    cut, unused = tc.sections(text)
    from tests.steps.test_cut_pass4 import a6_offer
    assert a6_offer(cut), cut
    assert "timeline." in " ".join(cut)
    # the agent takes the opening takes (the ones naming A4) and the false start, and keeps the A6 take
    kept = [ln for ln in text.splitlines() if not re.search(r"\[[\d.]+ (retake\? A4 [\d.]+|false-start\?[^]]*)\]$", ln)]
    assert len(kept) < len(text.splitlines())
    (d / "cut-plan.md").write_text("\n".join(kept) + "\n")
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert tc.said_text(d) == " ".join(tc.KEPT)
    checked(d, plan, applied, before)


def test_the_second_half_of_a_split_row_deletes_alone(tmp_path, monkeypatch):
    """A line cut at a silence is a row per piece, each its own id (review A-B1): deleting the second removes only
    its words."""
    tones = [(0.30, 0.55, SP), (0.60, 0.85, SP), (1.40, 1.65, SP), (1.70, 1.95, SP)]
    words = [("you", 0.30, 0.60), ("feel", 0.60, 0.90), ("lean", 0.90, 1.70), ("now.", 1.70, 1.95)]
    d = project(tmp_path, monkeypatch, [("vo", tones, 2.6, words)])
    tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    rows = [ln for ln in text.split("\n## Cut\n")[1].split("\n## Unused")[0].splitlines() if re.match(r"A\d+ ", ln)]
    # review A-B1: each piece of the line has its own id
    assert len(rows) == 2 and rows[0].startswith("A1 you feel [") and rows[1].startswith("A2 lean now. ["), rows
    (d / "cut-plan.md").write_text(text.replace(rows[1] + "\n", ""))
    tc.run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    assert tc.said_text(d) == "you feel", tc.said_text(d)
    assert cover(d, 1.40, 1.95) < 0.01 and tc.plays_whole(d, 0.30, 0.85), tc.kept_iv(d)


def test_a_pause_cut_by_layer_1_is_still_a_break_for_a_sure_retake(tmp_path, monkeypatch):
    """_sure is untouched: the 0.45 s pause before the second saying (a silence layer 1 cuts) is the break signal,
    so the first saying is labeled repeat? (its words named); the agent deletes them and the last is kept."""
    d = tc.spoken_project(tmp_path, ["okay so then you tip the whole frame over | then you tip the whole frame over "
                                     "and it falls."])
    before = json.loads((d / "project.json").read_text())
    plan, _ = tc.run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    assert plan["labels"] == {"repeat?": 1}, text
    assert re.search(r'^A1 okay so then you tip the whole frame over \[[\d.]+ repeat\? "then you tip the whole frame '
                     r'over"\]$', text, re.M), text
    (d / "cut-plan.md").write_text(text.replace("A1 okay so then you tip the whole frame over [",
                                                "A1 okay so ["))
    applied, _ = tc.run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    said = [w for w, _, _ in tc.played_words(d)]
    assert " ".join(said) == "okay so then you tip the whole frame over and it falls.", (said, text)
    checked(d, plan, applied, before)


# ── Sam's repeat rule, under the checks ───────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("lines, kept", [
    (["you overcorrected that as well.", "you overcorrected that too."], None),             # a paraphrase: both stay
    (["you can use it on your phone, you can use it on your laptop and you can use it on your tv."], None),   # a list
    (["press the red button now. | press the red button now."], "press the red button now."),  # clear: the last
])
def test_sams_repeat_rule_under_the_checks(tmp_path, monkeypatch, lines, kept):
    d = tc.spoken_project(tmp_path, lines)
    if kept:                        # a clear repeat: the first saying is labeled retake?; the agent deletes its row
        before = json.loads((d / "project.json").read_text())
        plan, _ = tc.run(d, monkeypatch=monkeypatch)
        text = (d / "cut-plan.md").read_text()
        assert plan["labels"] == {"retake?": 1}, text
        applied = apply_without_labeled(d, monkeypatch, text)
        said = [w for w, _, _ in tc.played_words(d)]
    else:                           # a paraphrase or a list: at most a fuzzy label, and the unedited plan plays both
        plan, text, applied, said, before = plan_apply(d, monkeypatch)
    assert " ".join(said) == (kept or " ".join(lines).replace(" |", "")), (said, text)
    checked(d, plan, applied, before)


# ── the drift fuzz (±0.25 s), judged by the checks ────────────────────────────────────────────────────────────

VOCAB = ("apple river candle marble pigeon lantern velvet copper meadow saddle thimble walrus juniper falcon "
         "harbor nickel pepper quartz raven sable tundra umber violet willow yonder zephyr basket cobalt dagger "
         "ember fennel garnet hazel indigo jasper kettle lemon mango nectar olive parsley quill russet sorrel "
         "turnip ukulele vortex wombat").split()


def fuzz(seed, levels=(-20, -30, -45, -55, -58), drift=0.25, durs=(0.03, 0.05, 0.08, 0.15, 0.3, 0.6)):
    """Review #3's harsher fuzz (fix pass 3's): whisper drift up to 0.25 s, gapless spans, very short and faint
    tones."""
    rnd = random.Random(1000 + seed)
    n = rnd.randint(5, 12)
    toks = rnd.sample(VOCAB, n)
    t = round(rnd.uniform(0.3, 0.9), 2)
    tones = []
    for k in range(n):
        dur = rnd.choice(durs)
        tones.append((t, round(t + dur, 2), rnd.choice(levels)))
        t = round(t + dur + rnd.choice([0.01, 0.04, 0.1, 0.25, 0.5, 0.9]), 2)
    end = t + 0.8
    starts = []
    for k in range(n):
        s = max(0.0, tones[k][0] + rnd.uniform(-drift, drift))
        if starts:
            s = max(s, starts[-1] + 0.02)
        else:
            s = min(s, tones[0][0])
        starts.append(round(s, 3))
    words = []
    for k, tok in enumerate(toks):
        b = starts[k + 1] if k + 1 < n else min(end - 0.05, max(starts[k] + 0.1, tones[k][1] + rnd.uniform(-0.1, 0.4)))
        if k + 1 == n:
            b = max(b, tones[k][1])
        words.append((tok + ("." if k + 1 == n or rnd.random() < 0.15 else ""), starts[k], round(b, 3)))
    return tones, words, end


@pytest.mark.parametrize("seed", range(80))
def test_the_drift_fuzz_passes_every_check(tmp_path, monkeypatch, seed):
    """No repeats in the words, so the person keeps every word: every loud frame plays (the -46 guard), no flat run
    over max-pause, at most a breath of lead and tail, no unwarned island; and every word with a voiced frame keeps
    its text."""
    tones, words, end = fuzz(seed)
    d = tc.tone_project(tmp_path, [("vo", tones, end, words)])
    plan, text, applied, said, before = plan_apply(d, monkeypatch)
    checked(d, plan, applied, before, kept_tones("vo", tones))
    from lib.speech_lines import load_words
    ref = se.Refiner(0.45)
    raw = load_words(str(d / "vo.json"))
    ref("vo", str(d / "vo.mov"), raw)
    heard = [i for i in range(len(raw)) if ref.kinds["vo"][i] == "heard"]
    # 2b's (b): the video's very first and last words, soft and under the -46 guard, go to ## Unused (inaudible?)
    edge = {i for i in heard[:1] + heard[-1:] if ref.soft["vo"].get(raw[i].idx, 0.0) < se.GUARD_DB}
    assert all(raw[i].text in said for i in heard if i not in edge), ([raw[i].text for i in heard], said, text)
