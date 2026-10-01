"""Tests for steps/lyrics/lyrics_sync.py: model selection, lyric alignment, and
windowed transcription (checked at the leaf, through a stub whisper-cli)."""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import wave
from array import array
from pathlib import Path

import pytest

from lib.common import ffprobe_bin
from tests.conftest import FFMPEG_BIN, HAS_FFMPEG, skip_or_fail

REPO_ROOT = Path(__file__).parent.parent.parent
_STEP_PATH = REPO_ROOT / "steps" / "lyrics" / "lyrics_sync.py"


def _load_step():
    spec = importlib.util.spec_from_file_location("lyrics_sync_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Stop(Exception):
    pass


def test_default_model_is_turbo():
    assert _load_step().WHISPER_MODEL == "large-v3-turbo-q5_0"


def test_model_goes_through_resolve_whisper_model(tmp_path, monkeypatch):
    """lyrics_sync picks its weight via require_whisper_model (resolve_whisper_model
    plus the missing-model check), so a requested model that is not installed
    falls back like every other whisper step."""
    mod = _load_step()
    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"x")
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text("hello world\n")

    calls = []

    def fake_resolve(model, language):
        calls.append((model, language))
        raise _Stop()

    monkeypatch.setattr(mod, "require_whisper_model", fake_resolve)
    monkeypatch.setattr(sys, "argv", [
        "lyrics_sync.py", "--input", str(audio), "--lyrics", str(lyrics),
        "--model", "base.en", "--language", "es",
    ])
    with pytest.raises(_Stop):
        mod.main()
    assert calls == [("base.en", "es")]


# ── alignment: pure functions, no whisper ─────────────────────────────────────
# Made-up lyrics. A1 and A2 are verse lines; B1..B3 are a chorus that repeats.
A1 = "red lights over the water"
B1 = "we keep on running"
B2 = "tell me what you want"
B3 = "tell me what you need"
A2 = "cold hands in the morning"
CHORUS = [B1, B2, B3]
SONG = [A1, *CHORUS, A2, *CHORUS]

# Whisper mishears one word of the first chorus and A2's last word, so the
# second chorus is the only exact copy. Longest-block-first matching gave that
# copy to the FIRST written chorus and everything after collapsed onto the end.
MISHEARD = {(2, 4): "won't", (4, 4): "mornin'"}


def _groups(lines):
    return [line.split() for line in lines]


def _heard(lines, misheard=MISHEARD):
    """Whisper words for `lines`: line k at 4k s, words 0.5 s apart, 0.4 s long."""
    words = []
    for k, line in enumerate(lines):
        for i, w in enumerate(line.split()):
            start = 4.0 * k + 0.5 * i
            words.append({"word": misheard.get((k, i), w), "start": start, "end": start + 0.4})
    return words


def _assert_in_own_slot(segments, n_heard):
    """Each of the first `n_heard` lines starts inside its own 4 s slot."""
    starts = [s["start"] for s in segments]
    off = [(k, s) for k, s in enumerate(starts[:n_heard]) if not 4 * k <= s < 4 * k + 4]
    assert not off, f"lines outside their slot (line, start): {off}; all line starts: {starts}"


def _assert_word_starts_non_decreasing(segments):
    starts = [w["start"] for s in segments for w in s["words"]]
    back = [(k, starts[k - 1], starts[k]) for k in range(1, len(starts)) if starts[k] < starts[k - 1]]
    assert not back, f"word starts go backwards (index, prev, this): {back}"


def test_a_repeated_chorus_lands_on_its_own_audio():
    """The tie that broke the song: every line lands in its own slot."""
    segs = _load_step().align(_groups(SONG), _heard(SONG))
    assert len(segs) == len(SONG)
    _assert_in_own_slot(segs, len(SONG))
    _assert_word_starts_non_decreasing(segs)


def test_detect_window_spans_first_anchor_to_last():
    assert _load_step().detect_window(_heard(SONG), _groups(SONG)) == (0.0, 30.4)


def test_chorus_written_three_times_heard_twice():
    """Tie order: the unheard third chorus must not take the second chorus's
    audio. Backtracking that prefers the diagonal on a tie gives the audio to
    the LAST written copy and squeezes chorus 2 in before it."""
    segs = _load_step().align(_groups(SONG + CHORUS), _heard(SONG))
    assert len(segs) == len(SONG) + len(CHORUS)
    _assert_in_own_slot(segs, len(SONG))
    _assert_word_starts_non_decreasing(segs)


def test_whisper_words_after_the_lyrics_cost_nothing():
    """Free trailing end: an ad-lib that repeats the last line after the song
    (heard at 32 s) must not pull the written last line off its own audio."""
    segs = _load_step().align(_groups(SONG), _heard(SONG + [B3]))
    _assert_in_own_slot(segs, len(SONG))
    _assert_word_starts_non_decreasing(segs)


def test_symbols_and_cyrillic_never_anchor():
    """`♪`, `—` and `&` normalize to '' and '' matches nothing, so they never
    match each other; a Cyrillic line keeps its letters and so never matches a
    symbol either (it used to normalize to '' and take whisper's `♪`)."""
    mod = _load_step()
    assert [mod.normalize(t) for t in ("♪", "—", "&")] == ["", "", ""]
    assert mod.normalize("Привет,") == "привет"

    groups = _groups(["♪", "— &", "привет тёмный мир", A1])
    symbols = [{"word": t, "start": float(k), "end": k + 0.4} for k, t in enumerate(["♪", "&", "—"])]
    real = [{"word": w, "start": 20.0 + 0.5 * i, "end": 20.4 + 0.5 * i} for i, w in enumerate(A1.split())]
    w_words = symbols + real

    assert mod.detect_window(w_words, groups) == (20.0, 22.4)

    segs = mod.align(groups, w_words)
    symbol_times = {(w["start"], w["end"]) for w in symbols}
    took = [(w["word"], w["start"]) for s in segs[:3] for w in s["words"]
            if (w["start"], w["end"]) in symbol_times]
    assert not took, f"lyric words took a whisper symbol's timing: {took}"
    assert [w["start"] for w in segs[3]["words"]] == [20.0, 20.5, 21.0, 21.5, 22.0]

    assert mod._align_tokens(["", "", ""], ["", "", ""]) == {}


def test_no_shared_word_means_no_alignment():
    """Zero anchors: align returns [] so main fails alignment_failed, instead of
    emitting a track of zeros."""
    mod = _load_step()
    groups = _groups(["red lights", "over the water"])
    w_words = [{"word": w, "start": 0.5 * i, "end": 0.5 * i + 0.4}
               for i, w in enumerate("blue moon rising slow".split())]
    assert mod.align(groups, w_words) == []
    assert mod.detect_window(w_words, groups) == (None, None)


def test_a_thousand_words_align_in_under_two_seconds():
    """Size guard for the pure-Python O(n*m) alignment."""
    import random
    import time

    rng = random.Random(7)
    vocab = [f"{a}{b}" for a in ("ba", "do", "ki", "lu", "mo", "ne", "ra", "so", "ti", "vu")
             for b in ("la", "me", "no", "pi", "ru", "sa", "te", "wo", "xi", "zo")]
    lyric = [rng.choice(vocab) for _ in range(1000)]
    heard = [rng.choice(vocab) if rng.random() < 0.1 else w for w in lyric]
    groups = [lyric[k:k + 8] for k in range(0, 1000, 8)]
    w_words = [{"word": w, "start": 0.3 * i, "end": 0.3 * i + 0.25} for i, w in enumerate(heard)]

    mod = _load_step()
    t0 = time.perf_counter()
    segs = mod.align(groups, w_words)
    elapsed = time.perf_counter() - t0
    assert len(segs) == len(groups)
    assert elapsed < 2.0, f"aligning 1000 x 1000 words took {elapsed:.2f} s"


def test_a_curly_apostrophe_anchors_on_a_straight_one():
    """Lyrics pasted from the web carry ’ (and ‘, ʼ) where whisper writes '.
    Stripped instead of mapped, "don’t" normalized to "dont" and never anchored."""
    mod = _load_step()
    lyr = [mod.normalize(t) for t in ("don’t", "‘cause", "yʼall")]
    heard = [mod.normalize(t) for t in ("don't", "'cause", "y'all")]
    assert mod._align_tokens(lyr, heard) == {0: 0, 1: 1, 2: 2}

    # Through align: anchored, "don’t" takes whisper's 5.0 s; interpolated, it
    # would sit halfway between its neighbours, at 3.0 s.
    w_words = [{"word": w, "start": s, "end": s + 0.4}
               for w, s in (("you", 0.0), ("don't", 5.0), ("stop", 6.0))]
    segs = mod.align([["you", "don’t", "stop"]], w_words)
    assert [w["start"] for w in segs[0]["words"]] == [0.0, 5.0, 6.0]


def test_a_quoted_word_anchors_and_a_lone_apostrophe_does_not():
    """‘love’ used as quotation marks must still match whisper's love, and a
    token that is only an apostrophe must never anchor to another one."""
    mod = _load_step()
    assert mod.normalize("‘love’") == mod.normalize("love")
    assert mod._align_tokens([mod.normalize("‘love’")], [mod.normalize("love")]) == {0: 0}
    assert mod._align_tokens([mod.normalize("'")], [mod.normalize("'")]) == {}
    w_words = [{"word": w, "start": s, "end": s + 0.4}
               for w, s in (("you", 0.0), ("love", 5.0), ("me", 6.0))]
    segs = mod.align([["you", "‘love’", "me"]], w_words)
    assert [w["start"] for w in segs[0]["words"]] == [0.0, 5.0, 6.0]


def _win(tmp_path, text):
    prefix = str(tmp_path / "w")
    Path(prefix + ".json").write_text(text, encoding="utf-8")
    return {"prefix": prefix, "start": 0, "lo": 0, "hi": 10**9}


def test_whisper_json_with_a_raw_control_character_still_parses(tmp_path):
    mod = _load_step()
    win = _win(tmp_path, '{"transcription": [{"text": " he\x01llo", '
                         '"offsets": {"from": 0, "to": 500}}]}')
    words = mod._window_words(win, None)
    assert [w["word"] for w in words] == ["he\x01llo"]


def test_malformed_whisper_json_fails_cleanly(tmp_path, capsys):
    mod = _load_step()
    win = _win(tmp_path, '{"transcription": [')
    with pytest.raises(SystemExit):
        mod._window_words(win, None)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "whisper_failed"


# ── the cut rule: pure function, a real quiet dip ─────────────────────────────

def test_the_cut_lands_in_the_quiet_dip_of_its_search_range():
    """A 50 ms envelope, loud everywhere except a 400 ms dip about 27.3 s after
    each cut. Deeper decoys sit just outside [c+25, c+30] on both sides, so a
    wrong search window takes a decoy, and a wrong argmin misses the dip."""
    mod = _load_step()
    loud, dip, decoy = 0.5, 0.001, 0.0
    rms = [loud] * 1800                       # 90 s of 50 ms frames

    def put(t0, t1, v):
        for i in range(round(t0 / 0.05), round(t1 / 0.05)):
            rms[i] = v

    put(24.5, 24.9, decoy)
    put(27.1, 27.5, dip)                      # cut 1: fully quiet 300 ms centred in [27.25, 27.35]
    put(30.1, 30.5, decoy)
    c1 = 27.25                                # what cut 1 must be (first quietest centre)
    put(c1 + 27.1, c1 + 27.5, dip)
    put(c1 + 30.1, c1 + 30.5, decoy)

    cuts = [s / 16000 for s in mod.quiet_cuts(rms, len(rms) * 800)]
    assert cuts[0] == 0.0 and cuts[-1] == 90.0
    assert 27.25 <= cuts[1] <= 27.35, f"cut 1 at {cuts[1]} s, the dip's quiet centre is 27.25-27.35 s"
    assert c1 + 27.25 <= cuts[2] <= c1 + 27.35, f"cut 2 at {cuts[2]} s"
    assert len(cuts) == 5, cuts               # 0, ~27.3, ~54.6, one more, then the end
    assert all(25 <= b - a < 30 for a, b in zip(cuts, cuts[1:-1]))
    assert cuts[-1] - cuts[-2] <= 30


# ── windowed transcription at the leaf: a stub whisper-cli ────────────────────
# The step runs as a subprocess with HOME=<tmp>, so it finds the stub and the
# empty weights under <tmp>/.local/share/montaj/models/whisper. The input's
# sample value is round(t * 100), so each window's first sample tells the stub
# its absolute start. Every 0.5 s of absolute time is one lyric word, w<k> at
# 0.5 k s. The stub puts the true time in t_dtw and a start 0.3 s early in
# offsets.from, so the output shows which one the step used.

# Resolved here, before any test moves HOME: with HOME moved, the step no
# longer finds the managed build and falls back to PATH, so the subprocess's
# PATH gets these binaries' directories first (on CI they are apt's, on PATH).
_FFPROBE_BIN = ffprobe_bin()

SR = 16000

_STUB = r'''#!{python}
import json, os, sys, wave

argv = sys.argv[1:]
ins, outs = [], []
i = 0
while i < len(argv):
    if argv[i] in ("-f", "--file"):
        ins.append(argv[i + 1]); i += 2; continue
    if argv[i] in ("-of", "--output-file"):
        outs.append(argv[i + 1]); i += 2; continue
    i += 1

files = []
for path in ins:
    with wave.open(path, "rb") as w:
        n = w.getnframes()
        first = w.readframes(1)
    t0_cs = int.from_bytes(first[:2], "little", signed=True) if n else 0
    files.append({"path": path, "n": n, "t0_cs": t0_cs, "dur": n / 16000, "t0": t0_cs / 100})
with open(os.environ["PL7_STUB_LOG"], "a") as f:
    f.write(json.dumps({"argv": argv, "files": [{k: fi[k] for k in ("path", "dur", "t0")} for fi in files]}) + "\n")

if os.environ.get("PL7_STUB_REJECT_NFA") == "1" and "-nfa" in argv:
    # whisper-cli v1.9.4 on an unknown flag: usage on stdout, exit 0, no JSON.
    print("error: unknown argument: -nfa\n\nusage: whisper-cli [options] file0 file1 ...")
    sys.exit(0)

full = "-ojf" in argv or "--output-json-full" in argv
# Flash attention is on unless -nfa: then every t_dtw is -1, as measured.
dtw = ("-dtw" in argv or "--dtw" in argv) and ("-nfa" in argv or "--no-flash-attn" in argv)

def ts(ms):
    s, ms = divmod(ms, 1000); m, s = divmod(s, 60); h, m = divmod(m, 60)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)

def tok(text, frm, to, t_dtw):
    return {"text": text, "timestamps": {"from": ts(frm), "to": ts(to)},
            "offsets": {"from": frm, "to": to}, "id": 0, "p": 0.9, "t_dtw": t_dtw}

def entry(text, frm, to, tokens):
    e = {"timestamps": {"from": ts(frm), "to": ts(to)}, "offsets": {"from": frm, "to": to}, "text": text}
    if full:
        e["tokens"] = tokens
    return e

for fi, of in zip(files, outs):
    t0_cs, n = fi["t0_cs"], fi["n"]
    trans = [entry("", 0, 0, [tok("[_BEG_]", 0, 0, -1)])]
    k = -(-t0_cs // 50)                      # first 0.5 s slot at or after t0
    while 8000 * k < 160 * t0_cs + n:        # slot k at 50 k cs lies inside the window
        rel_cs = 50 * k - t0_cs
        frm, to = max(0, rel_cs * 10 - 300), rel_cs * 10 + 200
        word = tok(" w%d" % k, frm, to, rel_cs if dtw else -1)
        tokens = [word]
        if k % 4 == 1:                       # a special token first: the step must skip it
            tokens = [tok("[_TT_%d]" % (frm // 20), frm, frm, -1), word]
        if k % 8 == 7:
            tokens.append(tok("[_TT_%d]" % (to // 20), to, to, -1))
        trans.append(entry(" w%d" % k, frm, to, tokens))
        k += 1
    doc = {"systeminfo": "stub", "model": {"type": "large", "multilingual": True},
           "params": {"model": "stub", "language": "en", "translate": False},
           "result": {"language": "en"}, "transcription": trans}
    with open(of + ".json", "w") as f:
        json.dump(doc, f)
print("stub transcribed %d file(s)" % len(files))
'''


def _bin_dirs():
    dirs = []
    for b in (FFMPEG_BIN, _FFPROBE_BIN):
        p = b if os.path.isabs(b) else shutil.which(b)
        if p and os.path.dirname(p) not in dirs:
            dirs.append(os.path.dirname(p))
    return dirs


def _write_wav(path, samples):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(samples.tobytes())


def _ramp_wav(path, seconds):
    """16 kHz mono s16 whose sample value is round(t * 100): t in centiseconds."""
    _write_wav(path, array("h", (round(i / 160) for i in range(int(seconds * SR)))))


def _silent_wav(path, seconds):
    _write_wav(path, array("h", bytes(2 * int(seconds * SR))))


def _lyrics(n_words):
    words = [f"w{k}" for k in range(n_words)]
    return "\n".join(" ".join(words[i:i + 8]) for i in range(0, n_words, 8)) + "\n"


def _run(tmp_path, seconds, *args, silent=False, reject_nfa=False,
         weights=("large-v3-turbo-q5_0",)):
    """Run the real step against the stub; return (proc, stub calls, output JSON or None)."""
    if not HAS_FFMPEG:
        skip_or_fail("ffmpeg not found")
    home = tmp_path / "home"
    wdir = home / ".local" / "share" / "montaj" / "models" / "whisper"
    wdir.mkdir(parents=True, exist_ok=True)
    stub = wdir / "whisper-cli"
    stub.write_text(_STUB.replace("{python}", sys.executable))
    stub.chmod(0o755)
    for w in weights:
        (wdir / f"ggml-{w}.bin").write_bytes(b"")

    wav = tmp_path / "vocals.wav"
    (_silent_wav if silent else _ramp_wav)(wav, seconds)
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text(_lyrics(int(seconds * 2)))
    out = tmp_path / "out.json"
    log = tmp_path / "stub.jsonl"

    env = dict(os.environ)
    env.pop("PL7_STUB_REJECT_NFA", None)
    env.update(HOME=str(home), PL7_STUB_LOG=str(log),
               PATH=os.pathsep.join(_bin_dirs() + [os.environ.get("PATH", "")]))
    if reject_nfa:
        env["PL7_STUB_REJECT_NFA"] = "1"
    proc = subprocess.run(
        [sys.executable, str(_STEP_PATH), "--input", str(wav), "--lyrics", str(lyrics),
         "--out", str(out), *args],
        env=env, capture_output=True, text=True, timeout=180)
    calls = [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []
    result = json.loads(out.read_text()) if proc.returncode == 0 and out.exists() else None
    return proc, calls, result


def _flag(argv, name):
    return argv[argv.index(name) + 1] if name in argv else None


def _words(result):
    return [(w["word"], w["start"] + result["audioInPoint"])
            for s in result["segments"] for w in s["words"]]


def _whisper_word_count(stderr):
    m = re.search(r"whisper words: (\d+), windows: (\d+)", stderr)
    assert m, f"no whisper word/window count on stderr:\n{stderr}"
    return int(m.group(1)), int(m.group(2))


def test_a_95s_song_goes_to_whisper_in_windows_of_at_most_30_5s_in_one_call(tmp_path):
    proc, calls, result = _run(tmp_path, 95.0)

    assert len(calls) == 1, f"whisper-cli ran {len(calls)} times; stderr:\n{proc.stderr}"
    files = calls[0]["files"]
    too_long = [f"{f['dur']:.2f} s" for f in files if f["dur"] > 30.5]
    assert not too_long, f"-f longer than 30.5 s: {too_long}"

    spans = sorted((f["t0"], f["t0"] + f["dur"]) for f in files)
    assert spans[0][0] <= 0.005, spans
    gaps = [(a, b) for (_, a), (b, _) in zip(spans, spans[1:]) if b > a + 0.005]
    assert not gaps, f"windows leave gaps (end, next start): {gaps}"
    assert spans[-1][1] >= 95.0 - 0.005, spans

    argv = calls[0]["argv"]
    assert "-ojf" in argv and "-nfa" in argv, argv
    assert _flag(argv, "-dtw") == "large.v3.turbo", argv

    assert proc.returncode == 0, proc.stderr
    words = _words(result)
    off = [(w, t) for w, t in words if abs(t - 0.5 * int(w[1:])) > 0.02]
    assert not off, f"words off their true time (word, time): {off[:10]}"

    assert [w for w, _ in words] == [f"w{k}" for k in range(190)]
    assert all(b[1] >= a[1] for a, b in zip(words, words[1:])), "word starts go backwards"
    n_words, n_windows = _whisper_word_count(proc.stderr)
    assert (n_words, n_windows) == (190, len(files)), \
        "each whisper word must survive the stitch exactly once"


def test_a_20s_song_is_one_window(tmp_path):
    proc, calls, result = _run(tmp_path, 20.0)
    assert proc.returncode == 0, proc.stderr
    assert len(calls) == 1
    assert [(f["t0"], f["dur"]) for f in calls[0]["files"]] == [(0.0, 20.0)]
    assert [w for w, _ in _words(result)] == [f"w{k}" for k in range(40)]


def test_a_whisper_that_rejects_nfa_is_rerun_once_without_dtw(tmp_path):
    """whisper-cli v1.9.4 on an unknown flag exits 0 and writes no JSON: the
    step reruns once without -ojf/-dtw/-nfa and uses the segment offsets."""
    proc, calls, result = _run(tmp_path, 95.0, reject_nfa=True)
    assert proc.returncode == 0, proc.stderr
    assert len(calls) == 2, f"whisper-cli ran {len(calls)} times"
    assert {"-ojf", "-dtw", "-nfa"} <= set(calls[0]["argv"])
    assert not {"-ojf", "-dtw", "-nfa"} & set(calls[1]["argv"]), calls[1]["argv"]
    assert len([l for l in proc.stderr.splitlines() if "DTW" in l]) == 1, proc.stderr

    words = _words(result)
    assert [w for w, _ in words] == [f"w{k}" for k in range(190)]
    off = [(w, t) for w, t in words if abs(t - max(0.0, 0.5 * int(w[1:]) - 0.3)) > 0.02]
    assert not off, f"starts are not the segment offsets (word, time): {off[:10]}"


def test_model_large_has_no_dtw_preset(tmp_path):
    proc, calls, result = _run(tmp_path, 40.0, "--model", "large",
                               weights=("large-v3-turbo-q5_0", "large"))
    assert proc.returncode == 0, proc.stderr
    assert len(calls) == 1
    argv = calls[0]["argv"]
    assert _flag(argv, "-m").endswith("ggml-large.bin"), argv
    assert not {"-dtw", "-nfa", "-ojf"} & set(argv), argv
    off = [(w, t) for w, t in _words(result) if abs(t - max(0.0, 0.5 * int(w[1:]) - 0.3)) > 0.02]
    assert not off, f"starts are not the segment offsets (word, time): {off[:10]}"


def test_silence_is_never_transcribed_and_fails_no_words(tmp_path):
    proc, calls, _ = _run(tmp_path, 60.0, silent=True)
    assert proc.returncode == 1
    assert calls == [], "a silent window went to whisper"
    err = json.loads([l for l in proc.stderr.splitlines() if l.startswith("{")][-1])
    assert err["error"] == "no_words", err
    assert "vocals" in err["message"], err


def test_start_end_override_filters_and_rezeroes_after_transcription(tmp_path):
    proc, calls, result = _run(tmp_path, 95.0, "--start", "10", "--end", "40")
    assert proc.returncode == 0, proc.stderr
    assert len(calls) == 1
    assert result["audioInPoint"] == 10.0
    starts = {w["word"]: w["start"] for s in result["segments"] for w in s["words"]}
    inside = {f"w{k}": 0.5 * k - 10 for k in range(20, 81)}   # 10.0 .. 40.0 s
    off = [(w, starts[w], t) for w, t in inside.items() if abs(starts[w] - t) > 0.02]
    assert not off, f"words inside the override off their rezeroed time: {off[:10]}"
    # Whisper words outside [10, 40] were dropped, so no lyric word keeps a time
    # outside the rezeroed span: the ones before squeeze onto 0, the ones after onto 30.
    outside = [(w, t) for w, t in starts.items() if not -0.001 <= t <= 30.25]
    assert not outside, f"lyric words placed outside the override: {outside[:10]}"
