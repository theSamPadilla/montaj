"""Speech as text: derive a cut's transcript rows from a project and render them as plain text.

Every row is a run of one source line's words that plays on the chosen track, so an agent can edit
the cut by editing the text. Line ids come from the source (see lib/speech_lines.py), not from the
timeline, so splitting, repeating or reordering clips never renames a line.
"""
import hashlib
import json
import os
import re
from dataclasses import dataclass, field

from lib import speech_lines, speech_pauses
from lib.common import fail
from lib.project_tracks import normalize_tracks
from lib.speech_lines import (SHOW_PAUSE_S, Line, Word, load_words, refine, sidecar_for, split_lines,
                              uncertain_gaps)
from lib.speech_pauses import silences

STAMP_VERSION = "speech-text v1"
_STAMP_CONSTANTS = (
    "MIN_SILENCE_S", "FLOOR_MARGIN_DB", "SHOW_PAUSE_S", "LINE_BREAK_PAUSE_S", "LINE_MAX_WORDS",
    "PAUSE_SPLIT_S", "EDGE_TOUCH_S",
)
_NON_SPEECH_TYPES = ("overlay", "image", "text", "caption")


@dataclass
class Row:
    """One line of the cut. kind: "speech" | "gap" | "nospeech" | "notranscript" | "image".

    pauses are keyed by position: 0 is the lead-in, k is the gap before word k, len(words) is the tail.
    """
    kind: str
    line: str | None = None
    words: list = field(default_factory=list)
    pauses: dict = field(default_factory=dict)
    item_ids: list = field(default_factory=list)
    label: str | None = None
    t0: float | None = None
    t1: float | None = None
    dur: float | None = None


@dataclass
class Derived:
    track_id: str
    letters: dict          # source path -> letter
    lines: dict            # line id -> Line
    cut: list
    unused: list
    partly: set
    stamp: str
    uncertain: set = field(default_factory=set)   # (letter, i, j) word-index pairs whose pause position is unsure
    warnings: list = field(default_factory=list)


def _resolve(item: dict, project_dir: str | None) -> dict:
    if not project_dir:
        return item
    out = dict(item)
    for k in ("src", "normalizedSrc"):
        v = out.get(k)
        if isinstance(v, str) and v and not os.path.isabs(v):
            out[k] = os.path.join(project_dir, v)
    return out


def _dur(item: dict) -> float:
    return max(0.0, float(item.get("end", 0)) - float(item.get("start", 0)))


def _sorted_items(track: dict, project_dir: str | None) -> list:
    return sorted((_resolve(it, project_dir) for it in track["items"]), key=lambda it: it.get("start", 0))


def _missing(project: dict, project_dir: str | None):
    paths = []
    for t in normalize_tracks(project).get("tracks", []):
        for it in t["items"]:
            it = _resolve(it, project_dir)
            if it.get("src") and it.get("type") not in _NON_SPEECH_TYPES and it["src"] not in paths:
                paths.append(it["src"])
    lines = "; ".join(f"{p} (run step transcribe with {json.dumps({'input': p})})" for p in paths)
    fail("transcript_missing", f"No transcript found for: {lines or 'any source on the timeline'}")


def speech_track_index(project: dict, override: str | None, project_dir: str | None = None) -> int:
    """Index of the speech track: the override id, else the track with the most seconds of items that have a sidecar."""
    tracks = normalize_tracks(project).get("tracks", [])
    if override is not None:
        for i, t in enumerate(tracks):
            if t["id"] == override:
                return i
        fail("track_not_found", f"No track with id {override}")
    best, best_secs = None, 0.0
    for i, t in enumerate(tracks):
        secs = sum(_dur(it) for it in (_resolve(x, project_dir) for x in t["items"]) if sidecar_for(it))
        if secs > best_secs:
            best, best_secs = i, secs
    if best is None:
        _missing(project, project_dir)
    return best


def stamp(project: dict, track_index: int, sidecars: list) -> str:
    """sha256 hex[:12] over the track's items, each sidecar's content hash and the format constants."""
    tracks = normalize_tracks(project).get("tracks", [])
    items = sorted(tracks[track_index]["items"], key=lambda it: it.get("start", 0))
    rows = [[os.path.basename(it.get("src") or ""), it.get("inPoint"), it.get("outPoint"), it.get("start"), it.get("end"),
             it.get("speed", 1)] for it in items]
    sums = []
    for p in sidecars:
        with open(p, "rb") as f:
            sums.append(hashlib.sha256(f.read()).hexdigest())
    # only what changes the text: constants of speech_lines / speech_pauses (apply-only ones are left out)
    consts = {n: getattr(speech_lines, n, getattr(speech_pauses, n, None)) for n in _STAMP_CONSTANTS}
    blob = json.dumps([rows, sums, STAMP_VERSION, consts], sort_keys=True, separators=(",", ":"), default=list)
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def _letter(n: int) -> str:
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _media_for(item: dict, sidecar: str) -> str:
    src = item.get("src")
    if src and os.path.splitext(src)[0] + ".json" == sidecar:
        return src
    return item.get("normalizedSrc") or src


def _pause(v: float, pauses: dict, key: int):
    v = round(v, 2)
    if v >= SHOW_PAUSE_S:
        pauses[key] = v


def derive(project: dict, project_dir: str, track: str | None = None) -> Derived:
    idx = speech_track_index(project, track, project_dir)
    tr = normalize_tracks(project)["tracks"][idx]
    items = _sorted_items(tr, project_dir)
    fps = (project.get("settings") or {}).get("fps") or 30
    frame = 1.0 / fps

    # sources: first appearance on the track, then the project's own source list
    keys, sidecars, media = [], {}, {}
    def add(key, sc, med):
        if key not in sidecars:
            keys.append(key)
            sidecars[key] = sc
            media[key] = med
    for it in items:
        key = it.get("src") or it.get("normalizedSrc")
        if not key or it.get("type") in _NON_SPEECH_TYPES:
            continue
        sc = sidecar_for(it)
        add(key, sc, _media_for(it, sc) if sc else key)
    for s in project.get("sources") or []:
        s = _resolve(s, project_dir)
        sc = sidecar_for(s) if s.get("src") else None
        if sc:
            add(s["src"], sc, _media_for(s, sc))
    letters = {k: _letter(n) for n, k in enumerate(keys)}

    words, lines, uncertain = {}, {}, set()
    for k in keys:
        if sidecars[k] is None:
            words[k], lines[k] = [], []
            continue
        raw = load_words(sidecars[k])
        refined, stats = refine(raw, silences(media[k]))
        words[k] = refined
        letter = letters[k]
        for a, b in uncertain_gaps(stats):
            uncertain.add((letter, a, b))
        lines[k] = split_lines(letter, refined)
    line_of = {k: {w.idx: ln for ln in lines[k] for w in ln.words} for k in keys}

    cut, played = [], {k: set() for k in keys}
    end_so_far, warnings = 0.0, []
    for it in items:
        if float(it["start"]) - end_so_far >= frame - 1e-9:
            cut.append(Row("gap", dur=round(float(it["start"]) - end_so_far, 2)))
        end_so_far = max(end_so_far, float(it.get("end", it["start"])))
        key = it.get("src") or it.get("normalizedSrc")
        if it.get("type") == "image":
            cut.append(Row("image", item_ids=[it["id"]], label=os.path.basename(it.get("src") or ""),
                           dur=round(_dur(it), 2)))
            continue
        a, b = float(it.get("inPoint", 0)), float(it.get("outPoint", 0))
        if key not in letters or it.get("loop"):
            cut.append(Row("nospeech", item_ids=[it["id"]], label=letters.get(key) or os.path.basename(key or ""),
                           t0=a, t1=b))
            continue
        if sidecars[key] is None:
            cut.append(Row("notranscript", item_ids=[it["id"]], label=letters[key], t0=a, t1=b))
            warn = (f"No transcript for {key}; run step transcribe with "
                    + json.dumps({"input": key}))
            if warn not in warnings:
                warnings.append(warn)
            continue
        ws = [w for w in words[key] if a <= (w.start + w.end) / 2 < b]
        if not ws:
            cut.append(Row("nospeech", item_ids=[it["id"]], label=letters[key], t0=a, t1=b))
            continue
        played[key].update(w.idx for w in ws)
        runs = []
        for w in ws:
            ln = line_of[key][w.idx]
            if runs and runs[-1][0] is ln:
                runs[-1][1].append(w)
            else:
                runs.append((ln, [w]))
        prev_end = a
        for n, (ln, rw) in enumerate(runs):
            pauses = {}
            _pause(max(0.0, rw[0].start - prev_end), pauses, 0)
            for j in range(1, len(rw)):
                _pause(rw[j].start - rw[j - 1].end, pauses, j)
            if n == len(runs) - 1:
                _pause(max(0.0, b - rw[-1].end), pauses, len(rw))
            cut.append(Row("speech", line=ln.id, words=rw, pauses=pauses, item_ids=[it["id"]]))
            prev_end = rw[-1].end

    all_lines, unused, partly = {}, [], set()
    for k in keys:
        for ln in lines[k]:
            all_lines[ln.id] = ln
            n_played = sum(1 for w in ln.words if w.idx in played[k])
            if n_played < len(ln.words):
                unused.append(ln)
                if n_played:
                    partly.add(ln.id)
    used_sidecars = [sidecars[k] for k in keys if sidecars[k]]
    return Derived(tr["id"], letters, all_lines, cut, unused, partly, stamp(project, idx, used_sidecars), uncertain, warnings)


def _row_text(row: Row) -> str:
    out = []
    for k, w in enumerate(row.words):
        if k in row.pauses:
            out.append("{%.2f}" % row.pauses[k])
        out.append(w.text)
    if len(row.words) in row.pauses:
        out.append("{%.2f}" % row.pauses[len(row.words)])
    return " ".join(out)


def render(d: Derived, title: str, unused: str = "lines") -> str:
    out = [f"<!-- montaj speech text v1 · track {d.track_id} · stamp {d.stamp} -->", f"# {title}", ""]
    for src, letter in d.letters.items():
        out.append(f"{letter} = {os.path.basename(src)}")
    out += ["", "## Cut", ""]
    for r in d.cut:
        if r.kind == "speech":
            out.append(f"{r.line} {_row_text(r)}")
        elif r.kind == "gap":
            out.append(f"-- gap {r.dur:.2f}")
        elif r.kind in ("nospeech", "notranscript"):
            what = "no speech" if r.kind == "nospeech" else "no transcript"
            out.append(f"-- {r.label} {r.t0:.2f}-{r.t1:.2f} {what}")
        else:
            out.append(f"-- image {r.label} {r.dur:.2f}")
    if unused != "none":
        out += ["", "## Unused"]
        if d.unused:
            out.append("")
        for ln in d.unused:
            text = " ".join(w.text for w in ln.words)
            out.append(f"{'*' if ln.id in d.partly else ''}{ln.id} {text}")
    return "\n".join(out) + "\n"


@dataclass
class ParsedRow:
    """One row of the Cut section as written in the text file.

    kind: "speech" | "gap" | "nospeech" | "notranscript" | "image".
    Speech rows carry line ("A12"), letter ("A"), number (12), tokens (words as written, markers removed)
    and pauses keyed by position (0 = lead-in, k = before token k, len(tokens) = tail), in seconds.
    gap/image rows carry dur; nospeech/notranscript rows carry label (source letter), t0 and t1;
    image rows carry label (file name). lineno is the 1-based line in the text file.
    """
    kind: str
    lineno: int
    line: str | None = None
    letter: str | None = None
    number: int | None = None
    tokens: list = field(default_factory=list)
    pauses: dict = field(default_factory=dict)
    label: str | None = None
    t0: float | None = None
    t1: float | None = None
    dur: float | None = None


_HEADER_RE = re.compile(r"^<!--\s*montaj speech text v1\s*·\s*track\s+(\S+)\s*·\s*stamp\s+(\S+)\s*-->\s*$")
_SPEECH_RE = re.compile(r"^\*?([A-Z]+)(\d+)\s+(.*)$")
_MARKER_RE = re.compile(r"^\{(\d+(?:\.\d+)?)\}$")
_NUM = r"(\d+(?:\.\d+)?)"
_GAP_RE = re.compile(rf"^--\s+gap\s+{_NUM}$")
_NOSPEECH_RE = re.compile(rf"^--\s+([A-Z]+)\s+{_NUM}-{_NUM}\s+(no speech|no transcript)$")
_IMAGE_RE = re.compile(rf"^--\s+image\s+(\S.*?)\s+{_NUM}$")


def _parse_speech(m, n: int) -> ParsedRow:
    letter, number, rest = m.group(1), int(m.group(2)), m.group(3)
    tokens, pauses = [], {}
    for tok in rest.split():
        if "{" in tok:
            mm = _MARKER_RE.match(tok)
            if not mm:
                fail("bad_marker", f"Line {n}: bad pause marker {tok!r}; write {{seconds}} as its own word, e.g. {{0.50}}")
            if len(tokens) in pauses:
                fail("bad_marker", f"Line {n}: two pause markers in a row")
            pauses[len(tokens)] = float(mm.group(1))
        elif "}" in tok:
            fail("bad_marker", f"Line {n}: stray }} in {tok!r}")
        else:
            tokens.append(tok)
    if not tokens:
        fail("bad_row", f"Line {n}: row {letter}{number} has no words; delete the row instead")
    return ParsedRow("speech", n, f"{letter}{number}", letter, number, tokens, pauses)


def parse(text: str) -> tuple:
    """Parse the edited speech text into (header, rows). Rows are the ## Cut section only."""
    lines = text.splitlines()
    header = None
    for n, raw in enumerate(lines, 1):
        if raw.strip():
            m = _HEADER_RE.match(raw.strip())
            if m:
                header = {"track": m.group(1), "stamp": m.group(2)}
            break
    if header is None:
        fail("bad_header", "Line 1: the text must start with the <!-- montaj speech text v1 · track <id> · stamp <stamp> --> comment")
    rows, section = [], None
    for n, raw in enumerate(lines, 1):
        s = raw.strip()
        if s.startswith("## "):
            section = s[3:].strip().lower()
            continue
        if section != "cut" or not s:
            continue
        m = _SPEECH_RE.match(s)
        if m:
            rows.append(_parse_speech(m, n))
        elif s.startswith("--"):
            if (m := _GAP_RE.match(s)):
                rows.append(ParsedRow("gap", n, dur=float(m.group(1))))
            elif (m := _NOSPEECH_RE.match(s)):
                kind = "nospeech" if m.group(4) == "no speech" else "notranscript"
                rows.append(ParsedRow(kind, n, label=m.group(1), t0=float(m.group(2)), t1=float(m.group(3))))
            elif (m := _IMAGE_RE.match(s)):
                rows.append(ParsedRow("image", n, label=m.group(1), dur=float(m.group(2))))
            else:
                fail("bad_row", f"Line {n}: unrecognised row {s!r}")
        else:
            fail("bad_row", f"Line {n}: unrecognised row {s!r}; a speech row starts with a line id like A12")
    return header, rows
