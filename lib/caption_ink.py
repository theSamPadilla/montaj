"""caption_ink: the ink a caption draws, set from the backdrop under it (the caption_ink step, generate_captions).

Over a full-screen light card (a 3D scene's paper backdrop, a JSX paper card, both `opaque: true`) white captions with
a black outline barely read. The project data says what to draw, so the editor preview, sample_frame and the export
all draw the same thing: `captions.segments[i].ink` is "dark" or "light", and `inkAuto` ({card, ink, backdrop}: the card
measured under the caption, the ink written for it and the band's luminance) records what this module wrote. An `ink` is this module's only when
`inkAuto` is there and names the same ink; any other combination is a person's choice: never changed.

- `card_under`: the full-frame opaque overlay on top at a time.
- `band` / `luminance`: the caption's rows of the frame, and the mean relative luminance of a render over them.
- `plan`: what each caption should say, from a render of the backdrop (the frame without the captions).
- `needs_pass`: whether the step has anything to do (a card to measure, or ink of ours to clear).
- `update`: plan + the guarded write of `captions` only.
"""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

from lib import look_check as lc
from lib import project_revisions
from lib.proc import detached_kwargs, kill_tree
from lib.project_lock import update_project

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SAMPLE_FRAME_PY = os.path.join(MONTAJ_ROOT, "steps", "render", "sample_frame.py")

# plate and subtitle draw on their own box: the step does nothing for them (and clears nothing).
INK_STYLES = ("accent", "clean", "highlight-box", "karaoke", "outline", "pop", "word-by-word")
# A backdrop is light when the mean relative luminance of the caption band is at least this. Paper #efece4 is about
# 0.83, so it draws dark; #a6a49e (about 0.37) and footage stay white.
LIGHT_L = 0.5
RENDER_WORKERS = 3
RENDER_TIMEOUT_S = 90
# The step's own wall clock for the frames: one not started by then counts as failed, so the caller's timeout (serve's
# 300 s) never has to kill it.
DEADLINE_S = 240
LOCK_TIMEOUT = 30.0
_LUM = (0.2126, 0.7152, 0.0722)   # Rec.709


class InkProjectChanged(Exception):
    """A caption the plan changes was edited on disk since it was read."""


def _is_translation(seg):
    return bool(seg.get("lang")) and isinstance(seg.get("translationOf"), list)


def _ink_style(project, seg):
    """The style the caption draws in: its own, else the track's, else the renderer's default."""
    caps = project.get("captions") if isinstance(project.get("captions"), dict) else {}
    style = seg.get("style") if seg.get("style") in lc.CAPTION_DEFAULT_SIZE else caps.get("style")
    return style if style in lc.CAPTION_DEFAULT_SIZE else lc.RENDER_DEFAULT_STYLE


def inkable(project, seg):
    """True for a caption the step manages: not a translation, in a style that draws on the backdrop."""
    return not _is_translation(seg) and _ink_style(project, seg) in INK_STYLES


def _mid(seg):
    return (lc._num(seg.get("start")) + lc._num(seg.get("end"))) / 2


def _key(seg, index):
    """("id", id) for a segment with an id, else ("i", index in the raw list): typed, so an id is never read as an
    index."""
    sid = seg.get("id")
    return ("id", sid) if sid and isinstance(sid, (str, int)) else ("i", index)


def ours(seg):
    """True for an ink this module wrote: `inkAuto` there and naming the ink the segment still has. Ink with no
    inkAuto, ink that differs from it (edited) and inkAuto with no ink (removed) are a person's choice."""
    auto = seg.get("inkAuto")
    return isinstance(auto, dict) and seg.get("ink") in ("dark", "light") and auto.get("ink") == seg.get("ink")


def _raw_segments(project):
    caps = project.get("captions")
    segs = caps.get("segments") if isinstance(caps, dict) else None
    return segs if isinstance(segs, list) else []


def needs_pass(project):
    """True when the step has something to do: a caption, and a card to measure or ink of ours to clear."""
    segs = lc.caption_segments(project)
    return bool(segs) and bool(cards(project) or any(ours(s) for s in segs))


def cards(project):
    """[(item, label)] of every overlay drawn over the whole frame opaquely, on a drawn track."""
    out = []
    for ti, row in enumerate(lc.drawn_tracks(project)):
        out += [(it, lc._label(it, ti)) for it in row if it.get("type") == "overlay" and lc._full_frame(it)]
    return out


def card_under(project, t):
    """The topmost full-frame item on screen at `t` when it is an opaque overlay (a card), else None. Footage drawn
    full-frame above a card hides it; an opaque overlay is above the footage by construction."""
    rows = lc.drawn_tracks(project)
    pos = lc.layer_positions(rows)
    best = None   # (layer position, index in its track, item, label)
    for ti, row in enumerate(rows):
        for k, it in enumerate(row):
            if not lc._full_frame(it):
                continue
            if not (lc._num(it.get("start")) <= t < lc._num(it.get("end"))):
                continue
            rank = (pos[ti], k)
            if best is None or rank > best[0]:
                best = (rank, it, lc._label(it, ti))
    if best is None or best[1].get("type") != "overlay":
        return None
    out = dict(best[1])
    out["id"] = best[2]
    return out


def band(project, seg, width, height):
    """(x0, y0, x1, y1) px of the rows the caption draws in, within the frame; None when it has no band."""
    s, e = lc._num(seg.get("start")), lc._num(seg.get("end"))
    rows = [r for r in lc.caption_bands(project, s, e, width, height) if abs(r[2] - s) < 1e-6 and abs(r[3] - e) < 1e-6]
    if not rows:
        return None
    top, bottom = max(0.0, rows[0][0]), min(float(height), rows[0][1])
    if bottom - top < 1:
        return None
    return 0, int(top), int(width), int(round(bottom))


def _linear_table():
    out = []
    for v in range(256):
        c = v / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


def luminance(png_path, box, frame=None):
    """Mean relative luminance (0..1) of `box` (x0, y0, x1, y1, in `frame` = (w, h) px when given, else the image's)."""
    from PIL import Image
    with Image.open(png_path) as im:
        im = im.convert("RGB")
        sx = im.width / frame[0] if frame else 1.0
        sy = im.height / frame[1] if frame else 1.0
        x0, x1 = sorted((int(round(box[0] * sx)), int(round(box[2] * sx))))
        y0, y1 = sorted((int(round(box[1] * sy)), int(round(box[3] * sy))))
        x0, y0 = max(0, min(x0, im.width - 1)), max(0, min(y0, im.height - 1))
        x1, y1 = max(x0 + 1, min(x1, im.width)), max(y0 + 1, min(y1, im.height))
        hist = im.crop((x0, y0, x1, y1)).histogram()
    table, total = _linear_table(), (x1 - x0) * (y1 - y0)
    return sum(w * sum(h * lin for h, lin in zip(hist[c * 256:(c + 1) * 256], table))
               for c, w in enumerate(_LUM)) / total


def _run_group(cmd, timeout):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **detached_kwargs())
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out, err
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        proc.communicate()
        return None


def frame_renderer(project_path, out_dir, deadline=None):
    """render_fn(t) -> the path of the project's frame at `t` without the captions (sample_frame --no-captions), written
    into `out_dir`. A frame is given RENDER_TIMEOUT_S, or what is left until `deadline` (time.monotonic) when sooner."""
    def render(t):
        timeout = RENDER_TIMEOUT_S
        if deadline is not None:
            timeout = min(timeout, deadline - time.monotonic())
            if timeout <= 0:
                raise RuntimeError("out of time")
        out = os.path.join(out_dir, f"ink-{t:.3f}s.png")
        r = _run_group([sys.executable, SAMPLE_FRAME_PY, "--project", project_path, "--at", f"{t:.3f}",
                        "--no-captions", "--out", out], timeout)
        if r is None:
            raise RuntimeError("timed out")
        if r[0] != 0 or not os.path.isfile(out):
            raise RuntimeError("sample_frame failed")
        return out
    return render


def plan(project, render_fn, width, height, deadline=None):
    """(changes, counts, warnings). changes: {segment key: {"ink", "inkAuto": {"card", "ink", "backdrop"}} or None to clear}, keyed
    by `_key` over the raw segment list. render_fn(t) -> a PNG path of the backdrop at `t`; one render per distinct
    caption middle, three at a time. A frame not started by `deadline` (time.monotonic) counts as failed."""
    counts = {"dark": 0, "light": 0, "cleared": 0, "kept": 0}
    changes, warnings, todo = {}, [], []   # todo: (key, mid, box, card id)
    for i, seg in enumerate(_raw_segments(project)):
        if not isinstance(seg, dict) or not inkable(project, seg):
            continue
        if not ours(seg) and (seg.get("ink") or "inkAuto" in seg):
            counts["kept"] += 1
            continue
        mid = _mid(seg)
        card = card_under(project, mid)
        if card is None:
            if ours(seg):
                changes[_key(seg, i)] = None
                counts["cleared"] += 1
            continue
        box = band(project, seg, width, height)
        if box is None:
            warnings.append(f"no caption band at {lc.r2(mid)}s")
            continue
        todo.append((_key(seg, i), mid, box, card["id"]))
    times = sorted({round(t[1], 3) for t in todo})
    pngs, failed = {}, {}

    def one(t):
        if deadline is not None and time.monotonic() >= deadline:
            return t, None, "out of time"
        try:
            return t, render_fn(t), None
        except Exception as e:  # noqa: BLE001 — a failed frame leaves its captions as they are
            return t, None, str(e)[:80]
    with ThreadPoolExecutor(max_workers=RENDER_WORKERS) as pool:
        for t, png, why in pool.map(one, times):
            if png:
                pngs[t] = png
            else:
                failed[t] = why
    for t in times:
        if t in failed:
            warnings.append(f"frame at {t}s not rendered ({failed[t] or 'no image'}): its captions are unchanged")
    for key, mid, box, card_id in todo:
        png = pngs.get(round(mid, 3))
        if png is None:
            continue
        try:
            lum = luminance(png, box, (width, height))
        except Exception as e:  # noqa: BLE001
            warnings.append(f"frame at {lc.r2(mid)}s unreadable ({str(e)[:60]})")
            continue
        ink = "dark" if lum >= LIGHT_L else "light"
        changes[key] = {"ink": ink, "inkAuto": {"card": card_id, "ink": ink, "backdrop": round(lum, 3)}}
        counts[ink] += 1
    return changes, counts, warnings


def _captions_of(project):
    caps = project.get("captions")
    if not isinstance(caps, dict) or not isinstance(caps.get("segments"), list):
        raise InkProjectChanged("captions")
    return caps


def apply_changes(fresh, changes, read):
    """Write `changes` onto the fresh project's captions. `read` is {key: the whole segment as the plan read it}: a
    changed segment that is gone, is not the only one with its key, differs from what was read in any field, or lies
    under another card now raises InkProjectChanged, and nothing is written. Returns True when anything changed."""
    segments = _captions_of(fresh)["segments"]
    found = {}
    for key, change in changes.items():
        hits = [s for i, s in enumerate(segments) if isinstance(s, dict) and _key(s, i) == key]
        if len(hits) != 1 or hits[0] != read[key]:
            raise InkProjectChanged(key)
        card = (card_under(fresh, _mid(hits[0])) or {}).get("id")
        if card != (change["inkAuto"]["card"] if change else None):
            raise InkProjectChanged(key)
        found[key] = hits[0]
    changed = False
    for key, change in changes.items():
        seg = found[key]
        if change is None:
            for f in ("ink", "inkAuto"):
                changed |= seg.pop(f, None) is not None
        else:
            changed |= any(seg.get(f) != v for f, v in change.items())
            seg.update(change)
    return changed


def update(project_path, render_fn=None, timeout=LOCK_TIMEOUT):
    """Read the project, plan, and write `captions` only (under the project lock, onto the fresh captions).
    Returns the answer ({dark, light, cleared, kept, changed, warnings?}; `changed` is whether anything was written) or
    None when there is nothing to do (see needs_pass). Raises InkProjectChanged; lock errors (ProjectLockTimeout,
    ProjectReadOnly, SyncConflict) pass through."""
    project_path = os.path.abspath(project_path)
    with open(project_path, encoding="utf-8") as f:
        project = json.load(f)
    if not needs_pass(project):
        return None
    width, height = lc.design_size(project)
    caps = project["captions"]
    read_rev = project_revisions.revisions_of(project, ["captions"]) if project_revisions.engine_guard_enabled() else None
    read_rest = copy.deepcopy({k: v for k, v in caps.items() if k != "segments"})
    read = {_key(s, i): copy.deepcopy(s) for i, s in enumerate(caps["segments"]) if isinstance(s, dict)}
    samples = None
    deadline = None
    if render_fn is None:
        deadline = time.monotonic() + DEADLINE_S
        base = os.path.join(os.path.dirname(project_path), "render", "samples")
        os.makedirs(base, exist_ok=True)
        samples = tempfile.mkdtemp(prefix="caption-ink-", dir=base)   # this run's frames; another pass shares none
        render_fn = frame_renderer(project_path, samples, deadline)
    try:
        changes, counts, warnings = plan(project, render_fn, width, height, deadline)
    finally:
        if samples:
            shutil.rmtree(samples, ignore_errors=True)
    out = dict(counts)
    if warnings:
        out["warnings"] = warnings
    out["changed"] = False
    if not changes:
        return out

    def apply(fresh):
        fresh_caps = _captions_of(fresh)
        if read_rev is not None:   # §477: the captions field as read against now
            if project_revisions.stale_fields(fresh, ["captions"], read_rev)["stale"]:
                raise InkProjectChanged("captions")
        elif {k: v for k, v in fresh_caps.items() if k != "segments"} != read_rest:   # style, showLangs, ...
            raise InkProjectChanged("captions")
        if apply_changes(fresh, changes, read):
            out["changed"] = True
            return fresh
        return None
    update_project(project_path, apply, timeout=timeout)
    return out
