"""Shots of a long source, labelled once (Sam, 2026-10-26): find where the picture changes, keep the shot list and the
agent's labels in a sidecar beside the file, and draw one sheet with a tile per shot.

- Detection (`detect`): ffmpeg's scene score on a small, 10 fps decode (cheap on a 4K 120 fps screen recording: 74 s
  in about 25 s), a cut where the score passes CUT_SCORE, no shot shorter than MIN_SHOT_S, then the shortest shots
  merged into a neighbour until there are at most MAX_SHOTS (`cap_shots`). Each shot's `motion` is its mean scene
  score inside (the cut frames left out): a shot where something happens scores higher than a held one.
- The sidecar (`<stem>.shots.json` beside the file): {version, source, size, mtime, shots: [{n, start, end, motion,
  label?}]}. It belongs to that version of the file: a different size or mtime means it is detected again. Written
  atomically. Labels are kept when shots are detected again, on every shot whose span is still there (within
  KEEP_LABEL_S); `label` sets them by number and an empty string removes one.
- `project_shots`: every source and timeline video of a project whose file has a sidecar, by its id.
"""
import json
import os
import re
import tempfile

from lib.common import ff_input, ffmpeg_bin, get_duration, run

VERSION = 1
CUT_SCORE = 0.15
MIN_SHOT_S = 0.6
MAX_SHOTS = 36
SCAN_FPS = 10
SCAN_WIDTH = 256
KEEP_LABEL_S = 0.25
TILE_WIDTH = 320
LABEL_PX = 30
COLS = 6

_SCORE_RE = re.compile(r"pts_time:([0-9.]+)\s*\n\s*lavfi\.scene_score=([0-9.]+)")


class ShotsError(Exception):
    pass


def frame_scores(path, timeout=1800):
    """[(time, scene score)] over the whole file, on a SCAN_FPS, SCAN_WIDTH decode."""
    with tempfile.TemporaryDirectory() as work:
        out = os.path.join(work, "scores.txt")
        run([ffmpeg_bin(), "-nostdin", "-v", "error", "-i", ff_input(path), "-an",
             "-vf", f"fps={SCAN_FPS},scale={SCAN_WIDTH}:-2,select='gte(scene,0)',metadata=print:file={out}",
             "-f", "null", "-"], timeout=timeout)
        with open(out, encoding="utf-8", errors="replace") as f:
            text = f.read()
    return [(float(a), float(b)) for a, b in _SCORE_RE.findall(text)]


def cap_shots(shots, limit=MAX_SHOTS):
    """`shots` ({start, end, motion}) merged, the shortest into its shorter neighbour, until there are at most
    `limit`; numbered from 1. A merged shot's motion is the time-weighted mean of the two."""
    out = [dict(s) for s in shots]
    while len(out) > max(1, limit):
        i = min(range(len(out)), key=lambda k: out[k]["end"] - out[k]["start"])
        if i == 0:
            j = 1
        elif i == len(out) - 1:
            j = i - 1
        else:
            left, right = out[i - 1], out[i + 1]
            j = i - 1 if (left["end"] - left["start"]) <= (right["end"] - right["start"]) else i + 1
        a, b = sorted((i, j))
        da, db = out[a]["end"] - out[a]["start"], out[b]["end"] - out[b]["start"]
        motion = (out[a]["motion"] * da + out[b]["motion"] * db) / max(da + db, 1e-9)
        out[a:b + 1] = [{"start": out[a]["start"], "end": out[b]["end"], "motion": motion}]
    for n, s in enumerate(out, 1):
        s["n"] = n
    return out


def detect(path, duration=None):
    """The shots of the file at `path`: [{n, start, end, motion}] (seconds, 3 decimals; motion 3 decimals)."""
    duration = duration if duration is not None else get_duration(path)
    scores = frame_scores(path)
    cuts, prev = [], 0.0
    for t, s in scores:
        if s > CUT_SCORE and t - prev >= MIN_SHOT_S and duration - t >= MIN_SHOT_S:
            cuts.append(t)
            prev = t
    edges = [0.0] + cuts + [duration]
    raw = []
    for a, b in zip(edges, edges[1:]):
        inner = [s for t, s in scores if a + 1.5 / SCAN_FPS < t < b - 0.5 / SCAN_FPS]
        raw.append({"start": a, "end": b, "motion": sum(inner) / len(inner) if inner else 0.0})
    return [{"n": s["n"], "start": round(s["start"], 3), "end": round(s["end"], 3), "motion": round(s["motion"], 3)}
            for s in cap_shots(raw)]


def sidecar_path(path):
    return os.path.splitext(path)[0] + ".shots.json"


def _stamp(path):
    st = os.stat(path)
    return st.st_size, round(st.st_mtime, 3)


def read_sidecar(path):
    """The sidecar's shots when it belongs to this version of the file, else None."""
    try:
        with open(sidecar_path(path), encoding="utf-8") as f:
            doc = json.load(f)
        size, mtime = _stamp(path)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("size") != size or abs(float(doc.get("mtime", -1)) - mtime) > 0.01:
        return None
    shots = doc.get("shots")
    return shots if isinstance(shots, list) else None


def write_sidecar(path, shots):
    size, mtime = _stamp(path)
    doc = {"version": VERSION, "source": os.path.basename(path), "size": size, "mtime": mtime, "shots": shots}
    target = sidecar_path(path)
    fd, tmp = tempfile.mkstemp(prefix=".shots-", suffix=".json", dir=os.path.dirname(target) or ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1, ensure_ascii=False)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _carry_labels(old, new):
    """Each new shot takes the label of an old shot with the same span (within KEEP_LABEL_S)."""
    for s in new:
        for o in old or []:
            if o.get("label") and abs(o["start"] - s["start"]) <= KEEP_LABEL_S and abs(o["end"] - s["end"]) <= KEEP_LABEL_S:
                s["label"] = o["label"]
                break
    return new


def shots_for(path, redetect=False, scan_path=None):
    """{"shots": [...]} for the file at `path`: from its sidecar, else detected (on `scan_path`, an editing proxy of
    the same timing, when given) and kept in the sidecar. `redetect` detects again, keeping the labels."""
    stored = read_sidecar(path)
    if stored is not None and not redetect:
        return {"shots": stored, "detected": False}
    old = stored
    if old is None:   # an older version's labels are not this file's
        old = []
    found = _carry_labels(old, detect(scan_path or path, get_duration(path)))
    write_sidecar(path, found)
    return {"shots": found, "detected": True}


def label(path, labels):
    """Set labels by shot number ({"7": "mannequin pulled out"}; "" removes one) in the file's sidecar. Raises
    ShotsError for a file with no shots yet or a number with no shot."""
    shots = read_sidecar(path)
    if shots is None:
        raise ShotsError("this file has no shots yet: run shots without labels first")
    by_n = {s.get("n"): s for s in shots}
    for key, text in (labels or {}).items():
        try:
            n = int(key)
        except (TypeError, ValueError):
            raise ShotsError(f"label key {key!r} is not a shot number")
        if n not in by_n:
            raise ShotsError(f"no shot {n}: shots run 1 to {len(shots)}")
        text = " ".join(str(text if text is not None else "").split())[:120]
        if text:
            by_n[n]["label"] = text
        else:
            by_n[n].pop("label", None)
    write_sidecar(path, shots)
    return {"shots": shots}


def sheet(path, shots, out, scan_path=None):
    """One sheet of `path` (or `scan_path`, same timing): a tile per shot at its middle, labelled "n  start-end"."""
    from concurrent.futures import ThreadPoolExecutor
    from lib.sheet import look_sheet
    src = scan_path or path
    with tempfile.TemporaryDirectory() as work:
        paths = [os.path.join(work, f"s_{s['n']:03d}.png") for s in shots]

        def grab(i):
            s = shots[i]
            t = (s["start"] + s["end"]) / 2
            run([ffmpeg_bin(), "-nostdin", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", ff_input(src),
                 "-frames:v", "1", "-vf", f"scale={TILE_WIDTH * 2}:-2", paths[i]])

        with ThreadPoolExecutor(4) as pool:
            list(pool.map(grab, range(len(shots))))
        labels = [f"{s['n']}  {s['start']:.1f}-{s['end']:.1f}" for s in shots]
        look_sheet(paths, labels, out)
    return out


def project_shots(project):
    """{id: {"src", "shots"}} for every source and timeline video of `project` whose file has a sidecar (a source's id
    first; a timeline item's id when no source holds its file)."""
    out, seen = {}, set()
    entries = [s for s in (project.get("sources") or []) if isinstance(s, dict)]
    for t in project.get("tracks") or []:
        items = t.get("items") if isinstance(t, dict) else t
        entries += [it for it in (items or []) if isinstance(it, dict) and it.get("type") == "video"]
    for e in entries:
        src = e.get("src")
        if not isinstance(src, str) or not src or src in seen or not isinstance(e.get("id"), str):
            continue
        seen.add(src)
        shots = read_sidecar(src) if os.path.isfile(src) else None
        if shots:
            out[e["id"]] = {"src": src, "shots": shots}
    return out
