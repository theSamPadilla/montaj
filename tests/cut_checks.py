"""The cut checks (§558 cut v5), run on every applied result in the unit tests and the drift fuzz.

They mirror the controller's acceptance tools: flat.py (/Users/Shared/s558/flat.py) exactly, and compare.py's
lost-word and island columns:
- FLAT: each speech item's 10 ms RMS frames of its source, decoded as flat.py decodes them (ffmpeg -ac 1, 16 kHz),
  "flat" when under the source's 95th-percentile frame less 30 dB. No flat run inside a kept item longer than
  max-pause, and at most LEAD_S of flat before the video's first sound and after its last. The one exemption, the
  orchestrator's (2026-10-24): a run holding an ATTACHED word's kept frames (lib/speech_energy._attached_frames:
  a word between kept words keeps its own sound down to 40 dB under the speech level) is not counted. Nothing else
  is exempt, and nothing has slack;
- LOST: every word the person keeps (a test names its sound) whose peak is at or over LOUD_DB (absolute, as
  compare's guard) plays every one of its loud frames (those at or over LOUD_DB);
- ISLANDS: no kept item under ISLAND_S unless an answer warns of as many short pieces;
- AUDIO: every music or audio track of the project before the cut is still there after it.
The flat runs are waveform_trim.flat_runs, the same function layer 1 reads its silences with.
"""
import json
import os
import re
import subprocess

import numpy as np

from lib.common import ffmpeg_bin
from steps.audio.waveform_trim import flat_runs

SR = 16000
MAX_PAUSE = 0.45
LEAD_S = 0.1
LOUD_DB = -46.0
ISLAND_S = 0.35
_FRAMES = {}


def frames_db(path):
    """flat.py's frames of `path`: 10 ms RMS of the mono mixdown, in dB, as float32 math."""
    key = (os.path.abspath(path), os.path.getmtime(path))
    if key not in _FRAMES:
        raw = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "s16le",
                              "-"], capture_output=True, check=True).stdout
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        w = SR // 100
        n = len(x) // w
        db = 20 * np.log10(np.sqrt((x[: n * w].reshape(n, w) ** 2).mean(axis=1) + 1e-12))
        _FRAMES[key] = (db, float(np.percentile(db, 95)))
    return _FRAMES[key]


def _project(d):
    return json.loads((d / "project.json").read_text()) if not isinstance(d, dict) else d


def _items(project):
    """flat.py's items: the first track's video and audio items."""
    return [it for tr in project["tracks"][:1] for it in tr["items"] if it.get("type") in (None, "video", "audio")]


def _media(d, it):
    return os.path.join(str(d), os.path.basename(it["src"]))


def attached_frames(d, project=None, max_pause=MAX_PAUSE):
    """{media basename: set of frame indexes}: the attached words' kept frames, as lib/speech_energy finds them on
    each source's own transcript (the exemption, see the module docstring)."""
    from lib import speech_energy
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


def flat_report(d, max_pause=MAX_PAUSE, exempt=None):
    """flat.py's numbers on the project at d: {"lead_s", "tail_s", "longest_flat", "over_max_pause", "runs"}. A run
    holding a frame of exempt[media basename] is not counted (attached words); None reads them (attached_frames)."""
    project = _project(d)
    exempt = attached_frames(d, project, max_pause) if exempt is None else exempt
    runs, longest, timeline = [], 0.0, []
    for it in _items(project):
        f = os.path.basename(it["src"])
        db, ref = frames_db(_media(d, it))
        a, b, st = float(it["inPoint"]), float(it["outPoint"]), float(it["start"])
        lo = int(a * 100)
        seg = db[lo:int(b * 100)]
        flat = seg < ref - 30
        mine = exempt.get(f, ())
        timeline.extend(flat.tolist())
        for i, j in flat_runs(seg.tolist(), ref - 30):
            if any(lo + k in mine for k in range(i, j)):
                continue
            L = (j - i) / 100
            longest = max(longest, L)
            if L > max_pause:
                runs.append({"file": f[:14], "timeline": round(st + i / 100, 2), "src": round(a + i / 100, 2),
                             "len": round(L, 2)})
    lead = next((k for k, v in enumerate(timeline) if not v), len(timeline)) / 100
    tail = next((k for k, v in enumerate(reversed(timeline)) if not v), len(timeline)) / 100
    return {"lead_s": lead, "tail_s": tail, "longest_flat": round(longest, 2), "over_max_pause": len(runs),
            "runs": runs}


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
        k0, k1 = int(np.ceil(t0 * 100 - 1e-6)), int(np.floor(t1 * 100 + 1e-6))
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


def check(d, before=None, kept=(), answers=(), max_pause=MAX_PAUSE):
    """Every check on the applied project at d; returns the failures ({} when it passes). before: the project
    before the cut (for the audio check); kept: the person's kept words' sound (see lost_words)."""
    fails = {}
    rep = flat_report(d, max_pause)
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
    if before is not None:
        after = audio_ids(_project(d))
        gone = [i for i in audio_ids(before) if i not in after]
        if gone:
            fails["audio"] = gone
    return fails
