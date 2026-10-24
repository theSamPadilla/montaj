"""Speech units, transcripts and the speech track, shared by the steps that read speech (§558: cut, place).

Moved verbatim from steps/edit/cut.py, renamed public; `transcribe_missing` takes the transcriber as an argument
(cut passes steps.speech.transcribe.transcribe, its tests a fake), and `filler_test` imports rm_fillers when called.
"""
import contextlib, io, json, os, shutil, tempfile
from pathlib import Path

from lib import write_places
from lib.common import fail
from lib.project_tracks import normalize_tracks
from lib.speech_lines import _ends_sentence, load_words, sidecar_for
from lib.take_select import BREAK_GAP_S, Unit

HESITATION_S = 0.5          # a pause this long inside a take counts against it (select-takes: less dead air)
UNIT_MAX_TOKENS = 40        # a sentence the transcript did not punctuate stops growing here
NON_MEDIA = ("overlay", "image", "text", "caption")
# A transcription that ran and failed falls back to silence removal; any other error (no model yet, a missing
# file) fails the step with that error.
FALLBACK_ERRORS = ("transcription_failed", "transcription_timeout")
# Languages written without spaces between words: take selection would compare characters, so it is off.
NON_SPACED = {"ja", "zh", "yue", "th", "lo", "km", "my", "bo"}
# A clip whose transcript covers this little of it is not speech (b-roll, with a word whisper made up).
MIN_WORDS_PER_S = 0.2
DENSE_WINDOW_S = 10.0       # ... unless some DENSE_WINDOW_S of it holds DENSE_WORDS words: a real short line
DENSE_WORDS = 5
# Words whisper makes up over music or sound effects have no gaps and stretch to fill the clip: a median word
# length over MADE_UP_MEDIAN_S, or ZERO_SHARE or more words of zero length, is made up, never speech. Measured
# 2026-10-24: 172 real transcripts have a longest median word length of 1.42 s and a largest zero-length share
# of 0.30; whisper on music and sound-effect slices gave medians of 4.4 to 15 s, or 71% zero-length words.
MADE_UP_MEDIAN_S = 2.5
ZERO_SHARE = 0.5
ZERO_LENGTH_S = 0.02


def resolve_path(path, project_dir):
    return path if os.path.isabs(path) else os.path.join(project_dir, path)


def resolved_item(item, project_dir):
    out = dict(item)
    for k in ("src", "normalizedSrc"):
        if isinstance(out.get(k), str) and out[k]:
            out[k] = resolve_path(out[k], project_dir)
    return out


def media_items(track):
    return [it for it in track["items"] if it.get("src") and it.get("type") not in NON_MEDIA]


def quiet(fn, *a, **k):
    """Run fn with its stderr held back. (ok, result): a fail() inside it is (False, its error)."""
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            return True, fn(*a, **k)
    except SystemExit:
        lines = err.getvalue().strip().splitlines()
        try:
            return False, json.loads(lines[-1])
        except (ValueError, IndexError):
            return False, {"error": "failed", "message": err.getvalue().strip()[-300:]}


def speech_track_id(project, project_dir):
    """The track with the most seconds of transcribed clips (a fresh clip counts its source length), else
    the first track."""
    tracks = normalize_tracks(project).get("tracks", [])
    if not tracks:
        fail("no_tracks", "The project has no tracks to cut")
    best, best_s = None, -1.0
    for t in tracks:
        clips = [it for it in media_items(t) if sidecar_for(resolved_item(it, project_dir))]
        if not clips:
            continue
        secs = sum(max(0.0, float(it.get("outPoint", 0)) - float(it.get("inPoint", 0)))
                   if "inPoint" in it and "outPoint" in it else float(it.get("sourceDuration") or 0) for it in clips)
        if secs > best_s:
            best, best_s = t["id"], secs
    return best if best is not None else tracks[0]["id"]


def find_track(project, track_id):
    for i, t in enumerate(project["tracks"]):
        if t["id"] == track_id:
            return i, t
    fail("project_changed", f"Track {track_id} is gone from the project: run cut again")


def stem_clash(track, project_dir):
    """Fail when two clips of the track share a transcript name (`clip.mov` and `clip.mp4` both read
    `clip.json`): one would be cut with the other's words."""
    by_stem = {}
    for it in media_items(track):
        src = os.path.abspath(resolve_path(it["src"], project_dir))
        by_stem.setdefault(os.path.normcase(os.path.splitext(src)[0]), set()).add(src)
    for stem, srcs in by_stem.items():
        if len(srcs) > 1:
            names = ", ".join(sorted(os.path.basename(x) for x in srcs))
            fail("transcript_name_clash", f"Clips {names} would share the transcript {os.path.basename(stem)}.json. "
                                          "Rename one so each clip has its own name, then run cut again.")


def sidecar_refusal(src, project_path, project_dir):
    """Why the transcript of `src` may not be written at `<stem>.json`, or None."""
    dest = os.path.splitext(src)[0] + ".json"
    if write_places.real(dest) == write_places.real(project_path):
        return "its transcript would replace project.json"
    if os.path.lexists(dest):
        return f"{os.path.basename(dest)} already exists and is not a transcript"
    if not write_places.sidecar_folder_ok(os.path.dirname(dest) or ".", project_dir):
        return "its folder is not a place a transcript may be written"
    return None


def install_sidecar(tmp_json, dest):
    """Put the transcript at dest, never over a file there (O_EXCL). False when one appeared meanwhile."""
    data = Path(tmp_json).read_bytes()
    try:
        fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        return False
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return True


def transcribe_missing(project, track_id, project_path, project_dir, model, language, transcribe):
    """Transcribe every clip of the track with no transcript. Whisper writes into a temp folder; only the
    `.json` is installed, as `<stem>.json` beside the clip's src as the project holds it (where speech_text
    looks), and never over an existing file. The `.srt` is never written. A clip whose transcript may not be
    written there is left untranscribed, with a warning. (transcribed clip ids, failed clip ids, warnings)."""
    _, track = find_track(normalize_tracks(project), track_id)
    done, failed, warnings, seen, failed_srcs = [], [], [], {}, set()
    for it in media_items(track):
        r = resolved_item(it, project_dir)
        if sidecar_for(r):
            continue
        src = r["src"]
        if src not in seen:
            why = sidecar_refusal(src, project_path, project_dir)
            if why:
                seen[src] = False
                warnings.append(f"not transcribed {os.path.basename(src)}: {why}")
            else:
                tmp = tempfile.mkdtemp(prefix="montaj-cut-")
                try:
                    prefix = os.path.join(tmp, "transcript")
                    ok, res = quiet(transcribe, src, prefix, model, language)
                    if not ok and res.get("error") not in FALLBACK_ERRORS:
                        # no model yet, a missing file, a full disk: the step fails as transcribe would
                        fail(res.get("error", "transcription_failed"), res.get("message", ""))
                    if not ok:
                        warnings.append(f"transcription failed for {os.path.basename(src)}: {res.get('message', '')}"[:300])
                    elif not install_sidecar(prefix + ".json", os.path.splitext(src)[0] + ".json"):
                        ok = False
                        warnings.append(f"not transcribed {os.path.basename(src)}: its transcript file appeared meanwhile")
                    seen[src] = ok
                    if not ok and res.get("error") in FALLBACK_ERRORS:
                        failed_srcs.add(src)
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
        if seen[src]:
            done.append(it["id"])
        elif src in failed_srcs:
            failed.append(it["id"])
    return done, failed, warnings


def line_key(line_id):
    letters = line_id.rstrip("0123456789")
    return letters, int(line_id[len(letters):])


def build_units(d, is_filler):
    """[(Unit, rows, attached)] in cut order. rows: (cut index, Row) whose words make the unit, in order;
    attached: the non-speech rows right before it. A unit is a run of consecutive rows of one source line,
    joined with the next line of the same source while the sentence has not ended. Plus the trailing rows."""
    occs, pending = [], []
    for i, r in enumerate(d.cut):
        if r.kind != "speech":
            pending.append(r)
            continue
        if occs and occs[-1]["line"] == r.line and not pending:
            occs[-1]["rows"].append((i, r))
            continue
        occs.append({"line": r.line, "rows": [(i, r)], "attached": pending})
        pending = []
    units = []
    for oc in occs:
        if units:
            last = units[-1]
            lw = last["rows"][-1][1].words
            pl, pn = line_key(last["line"])
            cl, cn = line_key(oc["line"])
            if (lw and not _ends_sentence(lw[-1].text) and not oc["attached"] and cl == pl and cn == pn + 1
                    and sum(len(r.words) for _, r in last["rows"]) < UNIT_MAX_TOKENS):
                last["rows"] += oc["rows"]
                last["line"] = oc["line"]
                last["lines"].append(oc["line"])
                continue
        units.append({"line": oc["line"], "lines": [oc["line"]], "rows": list(oc["rows"]), "attached": oc["attached"]})
    out = []
    for u in units:
        words = [w for _, r in u["rows"] for w in r.words]
        fillers = 0
        for lid in dict.fromkeys(u["lines"]):
            played = [w.idx for _, r in u["rows"] if r.line == lid for w in r.words]
            ln = d.lines.get(lid)
            if ln and played:
                lo, hi = min(played), max(played)
                fillers += sum(1 for w in ln.words if lo <= w.idx <= hi and w.norm and is_filler(w.norm))
        hes = sum(1 for a, b in zip(words, words[1:]) if b.start - a.end >= HESITATION_S)
        # a timing break before a word: it opens another source line, or follows a pause in the source
        breaks, pos, prev_line = set(), 0, None
        for _, r in u["rows"]:
            for k, w in enumerate(r.words):
                if pos and w.start - words[pos - 1].end >= BREAK_GAP_S:      # a measured pause only
                    breaks.add(pos)
                pos += 1
            prev_line = r.line
        clip = line_key(u["line"])[0]
        out.append((Unit([w.text for w in words], fillers=fillers, hesitations=hes, clip=clip, breaks=breaks),
                    u["rows"], u["attached"]))
    return out, pending


def filler_test(language):
    from steps.speech import rm_fillers
    rx = rm_fillers.filler_matcher(language)
    return lambda tok: bool(rx.match(tok))


def made_up(words):
    """Words whisper made up (over music, sound effects or noise): too long, or too many of zero length."""
    lens = sorted(w["end"] - w["start"] for w in words if any(c.isalnum() for c in w.get("text", "x")))
    if not lens:
        return False
    median = lens[len(lens) // 2] if len(lens) % 2 else (lens[len(lens) // 2 - 1] + lens[len(lens) // 2]) / 2
    zero = sum(1 for x in lens if x < ZERO_LENGTH_S) / len(lens)
    return median > MADE_UP_MEDIAN_S or zero >= ZERO_SHARE


def hardly_speech(words, span):
    """A clip whose words are too few and too spread out to be speech: b-roll, with words whisper made up
    ("Thank you." over music). Fewer than MIN_WORDS_PER_S over the clip, and no DENSE_WINDOW_S of it with
    DENSE_WORDS words."""
    if len(words) >= MIN_WORDS_PER_S * span:
        return False
    starts = sorted(w["start"] for w in words)
    return not any(sum(1 for x in starts if s0 <= x < s0 + DENSE_WINDOW_S) >= DENSE_WORDS for s0 in starts)


def language_of(arg, track, project_dir):
    """The speech language: the param, else (auto or none) what whisper detected in the transcript of the clip
    with the most words, b-roll left out (music is often detected as some other language)."""
    if arg and arg != "auto":
        return arg
    best, best_n = None, -1
    for it in media_items(track):
        r = resolved_item(it, project_dir)
        sc = sidecar_for(r)
        if not sc:
            continue
        try:
            with open(sc, encoding="utf-8") as f:
                lang = ((json.load(f).get("result") or {}).get("language") or "").strip()
        except (OSError, ValueError):
            continue
        words = [{"start": w.start} for w in load_words(sc)]
        span = max(float(it.get("outPoint", 0)) - float(it.get("inPoint", 0)), float(it.get("sourceDuration") or 0), 1e-6)
        if lang and not hardly_speech(words, span) and not made_up(
                [{"text": w.text, "start": w.start, "end": w.end} for w in load_words(sc)]) and len(words) > best_n:
            best, best_n = lang, len(words)
    return best or "en"
