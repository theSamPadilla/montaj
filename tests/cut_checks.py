"""The cut checks (§558 cut v5), run on every applied result in the unit tests and the drift fuzz.

They mirror the controller's acceptance tools: flat.py v2 (/Users/Shared/s558/flat.py, 2026-10-24) exactly, and
compare's lost-word and island columns:
- FLAT, on the JOINED timeline (the speech items in timeline order, runs going on across cuts): each item's 10 ms RMS
  frames of its source (the engine's own envelope, lib/speech_energy.envelope: the louder channel of each frame),
  "flat" when under the source's speech level (waveform_trim.speech_level: the gated 95th percentile) less 30 dB, or
  every frame of a source at or under -100 dB; one difference from flat.py: a frame of a soft word's burst (the
  engine's, recomputed here) is sound (review B L-B2: frame by frame, never a whole run). No flat run longer than
  max-pause, and at most LEAD_S of flat before the video's first sound and after its last (a burst included). No
  run exemption: a silence kept whole for an overlay (D2, `held`) and a
  clip kept whole (b-roll, `whole`) are each reported in a column of their own, never hidden;
- LOST: every word the person keeps (a test names its sound) whose peak is at or over LOUD_DB (absolute, as
  compare's guard) plays every one of its loud frames (those at or over LOUD_DB);
- ISLANDS: no kept item under ISLAND_S unless an answer warns of as many short pieces;
- WORDLESS: no kept piece standing alone on the timeline (a cut on each side) holding no word and under ISLAND_S of
  sound (L-B4);
- AUDIO: every music or audio track of the project before the cut is still there after it.
The flat runs are waveform_trim.flat_runs, the same function layer 1 reads its silences with.
"""
import json
import math
import os
import re

from lib import speech_energy
from steps.audio.waveform_trim import flat_runs, speech_level

MAX_PAUSE = 0.45
LEAD_S = 0.1
LOUD_DB = -46.0
ISLAND_S = 0.35
_FRAMES = {}


def frames_db(path):
    """(frames, speech level) of `path`: the engine's 10 ms RMS reading (the louder channel) and its gated level."""
    key = (os.path.abspath(path), os.path.getmtime(path))
    if key not in _FRAMES:
        env = speech_energy.envelope(path)
        _FRAMES[key] = (env, speech_level(env) if env else -120.0)
    return _FRAMES[key]


def flat_of(db, ref, sound=()):
    """flat.py v2's flat frames: under ref - 30, or every frame when the source is at or under -100 dB; but a frame of
    a soft word's burst (`sound`, the engine's) is sound (L-B2: counted frame by frame, never a whole run exempt)."""
    return [True] * len(db) if ref <= -100 else [v < ref - 30 and k not in sound for k, v in enumerate(db)]


def burst_frames(d, project=None, max_pause=MAX_PAUSE):
    """{media basename: set of frame indexes}: the soft words' bursts, as lib/speech_energy reads them on each
    source's own transcript (the frames it keeps as a word's sound under the line)."""
    from lib.speech_lines import load_words
    project = project or _project(d)
    out = {}
    for it in _items(project):
        f = os.path.basename(it["src"])
        if f in out:
            continue
        side = os.path.splitext(_media(d, it))[0] + ".json"
        if not os.path.isfile(side):
            out[f] = set()
            continue
        ref = speech_energy.Refiner(max_pause)
        ref(f, _media(d, it), load_words(side))
        out[f] = set(ref.layers[f].attached)
    return out


def _project(d):
    return json.loads((d / "project.json").read_text()) if not isinstance(d, dict) else d


def _items(project):
    """flat.py's items: the first track's video and audio items."""
    return [it for tr in project["tracks"][:1] for it in tr["items"] if it.get("type") in (None, "video", "audio")]


def _media(d, it):
    return os.path.join(str(d), os.path.basename(it["src"]))


def raw_runs(d, max_pause=MAX_PAUSE):
    """flat.py v2's own (raw) flat runs over max-pause on the joined timeline, no burst counted as sound, less any run
    that holds a played word peaking at LOUD_DB or more (the controller's annotation): what the raw check flags."""
    from lib import speech_text
    project = _project(d)
    rep = flat_report(d, max_pause, sound={})
    if not rep["runs"]:
        return []
    der = speech_text.derive(project, str(d), project["tracks"][0]["id"], refiner=speech_energy.Refiner(max_pause))
    items = {it["id"]: it for it in _items(project)}
    loud = []                                    # (timeline start, end) of played words peaking at the guard or over
    for r in der.cut:
        if r.kind != "speech":
            continue
        it = items.get(r.item_ids[0])
        if it is None:
            continue
        db, _ = frames_db(_media(d, it))
        for w in r.words:
            pk = max(db[int(w.start * 100):max(int(w.start * 100) + 1, int(math.ceil(w.end * 100)))], default=-120.0)
            if pk >= LOUD_DB:
                t0 = float(it["start"]) + w.start - float(it["inPoint"])
                loud.append((t0, t0 + w.end - w.start))
    return [r for r in rep["runs"] if not any(a < r["timeline"] + r["len"] and b > r["timeline"] for a, b in loud)]


def _timeline(d, project, held=None, whole=(), max_pause=MAX_PAUSE, sound=None):
    """The joined timeline: [(media basename, source frame, flat, exempt)] per frame of every speech item in timeline
    order. exempt: "held" for a frame inside a silence kept for an overlay ({media: [(start, end)]}), "whole" for a
    frame of an item kept whole (b-roll: item ids), else None."""
    out = []
    held = held or {}
    sound = burst_frames(d, project, max_pause) if sound is None else sound
    for it in sorted(_items(project), key=lambda it: float(it["start"])):
        f = os.path.basename(it["src"])
        db, ref = frames_db(_media(d, it))
        flat = flat_of(db, ref, sound.get(f, ()))
        a, b = float(it["inPoint"]), float(it["outPoint"])
        lo, hi = int(a * 100), int(b * 100)
        for k in range(lo, min(hi, len(db))):
            ex = "whole" if it.get("id") in whole else (
                "held" if any(s0 - 1e-6 <= k / 100 and (k + 1) / 100 <= s1 + 1e-6 for s0, s1 in held.get(f, ())) else None)
            out.append((f, k, flat[k], ex, float(it["start"]) + (k - lo) / 100))
    return out


def flat_report(d, max_pause=MAX_PAUSE, held=None, whole=(), sound=None):
    """flat.py v2's numbers on the JOINED timeline of the project at d: {"lead_s", "tail_s", "longest_flat",
    "over_max_pause", "runs", "held_runs", "whole_runs"}. A run over max-pause holding a frame of a held silence (D2)
    or of a whole-kept clip goes to its own column."""
    project = _project(d)
    tl = _timeline(d, project, held, whole, max_pause, sound)
    flags = [x[2] for x in tl]
    runs, held_runs, whole_runs, longest = [], [], [], 0.0
    for i, j in flat_runs([0.0 if f else 1.0 for f in flags], 0.5):
        L = (j - i) / 100
        longest = max(longest, L)
        if L > max_pause + 1e-9:
            row = {"file": tl[i][0][:14], "timeline": round(tl[i][4], 2), "src": round(tl[i][1] / 100, 2),
                   "len": round(L, 2)}
            kinds = {x[3] for x in tl[i:j]}
            (whole_runs if "whole" in kinds else held_runs if "held" in kinds else runs).append(row)
    lead = next((k for k, v in enumerate(flags) if not v), len(flags)) / 100
    tail = next((k for k, v in enumerate(reversed(flags)) if not v), len(flags)) / 100
    return {"lead_s": lead, "tail_s": tail, "longest_flat": round(longest, 2), "over_max_pause": len(runs),
            "runs": runs, "held_runs": held_runs, "whole_runs": whole_runs}


def wordless(d, max_pause=MAX_PAUSE):
    """Kept pieces standing alone on the timeline (L-B4) that hold no word (none of the source's words has its middle
    in it, by derive's reading) and under ISLAND_S of sound (frames not flat)."""
    from lib import speech_text
    project = _project(d)
    der = speech_text.derive(project, str(d), project["tracks"][0]["id"], refiner=speech_energy.Refiner(max_pause))
    worded = {r.item_ids[0] for r in der.cut if r.kind == "speech" and r.words}
    # the played words' whisper spans (their transcript's own times): sound inside one may be that word's (drift),
    # so it is no lone piece (the engine's rule too)
    from lib.speech_lines import load_words
    spans, raw = {}, {}
    for r in der.cut:
        if r.kind == "speech":
            src = next(s for s, lt in der.letters.items() if lt == r.line.rstrip("0123456789"))
            if src not in raw:
                side = os.path.splitext(src)[0] + ".json"
                raw[src] = {w.idx: w for w in load_words(side)} if os.path.isfile(side) else {}
            for w in r.words:
                x = raw[src].get(w.idx)
                if x is not None:
                    spans.setdefault(os.path.basename(src), []).append((x.start, x.end))
    out = []
    sound = burst_frames(d, project, max_pause)
    for it in _items(project):
        if it.get("id") in worded:
            continue
        db, ref = frames_db(_media(d, it))
        flat = flat_of(db, ref, sound.get(os.path.basename(it["src"]), ()))
        a, b = float(it["inPoint"]), float(it["outPoint"])
        snd = [k for k in range(int(a * 100), min(int(b * 100), len(db))) if not flat[k]]
        sound = len(snd) / 100
        mine = spans.get(os.path.basename(it["src"]), [])
        if sound < ISLAND_S - 1e-9 and not any(db[k] >= LOUD_DB and s0 - 1e-6 <= (k + 0.5) / 100 <= s1 + 1e-6
                                               for k in snd for s0, s1 in mine):
            out.append((round(a, 3), round(b, 3), sound))
    return out


def lost_words(d, kept):
    """The words of `kept` [(media name, t0, t1)] (the sound of each word the person keeps, in source seconds) of
    which a loud frame (LOUD_DB or more, wholly inside [t0, t1]) does not play."""
    project = _project(d)
    iv = {}
    for it in _items(project):
        iv.setdefault(os.path.basename(it["src"]), []).append((float(it["inPoint"]), float(it["outPoint"])))
    out = []
    for name, t0, t1 in kept:
        f = next((x for x in iv if os.path.splitext(x)[0] == os.path.splitext(name)[0]), None)
        path = os.path.join(str(d), f) if f else None
        if path is None:
            first = _items(project)
            path = os.path.join(str(d), os.path.splitext(name)[0] + os.path.splitext(first[0]["src"])[1])
        db, _ = frames_db(path)
        db = list(db)
        k0, k1 = int(math.ceil(t0 * 100 - 1e-6)), int(math.floor(t1 * 100 + 1e-6))
        loud = [k for k in range(k0, min(k1, len(db))) if db[k] >= LOUD_DB]
        if not loud:
            continue
        spans = iv.get(f, [])
        missing = [k for k in loud if not any(a - 1e-6 <= k / 100 and (k + 1) / 100 <= b + 1e-6 for a, b in spans)]
        if missing:
            out.append((name, t0, t1, round(missing[0] / 100, 2), len(missing)))
    return out


def islands(d, answers=()):
    """Kept items under ISLAND_S beyond the short pieces the answers warn of."""
    project = _project(d)
    short = [(float(it["inPoint"]), float(it["outPoint"])) for it in _items(project)
             if float(it["outPoint"]) - float(it["inPoint"]) < ISLAND_S - 1e-6]
    warned = 0
    for ans in answers:
        for w in ans.get("warnings", []) if ans else []:
            m = re.match(r"kept (\d+) short piece", w)
            if m:
                warned += int(m.group(1))
    return short[warned:] if len(short) > warned else []


def audio_ids(project):
    """The ids of every music or audio track of a project: top-level audio tracks and audio items off the speech
    track."""
    out = [t.get("id") for t in ((project.get("audio") or {}).get("tracks") or [])]
    for tr in project.get("tracks", [])[1:]:
        out += [it.get("id") for it in tr.get("items", []) if it.get("type") == "audio"]
    return out


def check(d, before=None, kept=(), answers=(), max_pause=MAX_PAUSE, held=None, whole=()):
    """Every check on the applied project at d; returns the failures ({} when it passes). before: the project
    before the cut (for the audio check); kept: the person's kept words' sound (see lost_words); held: {media
    basename: [(start, end)]} silences kept for an overlay (D2); whole: item ids of clips kept whole. Runs in held or
    whole stretches are reported under "held" and "whole", which are not failures."""
    fails = {}
    rep = flat_report(d, max_pause, held, whole)
    if rep["over_max_pause"]:
        fails["flat"] = rep["runs"]
    if rep["lead_s"] > LEAD_S + 1e-9 or rep["tail_s"] > LEAD_S + 1e-9:
        fails["edges"] = (rep["lead_s"], rep["tail_s"])
    lost = lost_words(d, kept)
    if lost:
        fails["lost"] = lost
    isl = islands(d, answers)
    if isl:
        fails["islands"] = isl
    alone = wordless(d, max_pause)
    if alone:
        fails["wordless"] = alone
    if before is not None:
        after = audio_ids(_project(d))
        gone = [i for i in audio_ids(before) if i not in after]
        if gone:
            fails["audio"] = gone
    return fails


def exempt_report(d, max_pause=MAX_PAUSE, held=None, whole=()):
    """The exempt columns on their own: {"held": runs, "whole": runs}."""
    rep = flat_report(d, max_pause, held, whole)
    return {"held": rep["held_runs"], "whole": rep["whole_runs"]}
