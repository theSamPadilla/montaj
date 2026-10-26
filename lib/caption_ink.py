"""caption_ink: the ink a caption draws, set from the backdrop under it (the caption_ink step, generate_captions).

Over a full-screen light card white captions with a black outline barely read. A card is the graphics that cover the
caption's band: an `opaque: true` overlay, a 3D scene whose backdrop is not transparent, or any other full-canvas overlay
whose own pixels cover the band (frame_broll's paper matte round a window). Footage drawn above it, over the band, ends it. The project data says what to draw, so the editor preview, sample_frame and the export
all draw the same thing: `captions.segments[i].ink` is "dark" or "light", and `inkAuto` ({card, ink, backdrop}: the card
measured under the caption, the ink written for it and the band's luminance) records what this module wrote. An `ink` is this module's only when
`inkAuto` is there and names the same ink; any other combination is a person's choice: never changed.

- `find_card` / `card_under`: the card under a caption's band at a time (`card_under` from the project data alone).
- `band` / `luminance`: the caption's rows of the frame, and the mean relative luminance of a render over them.
- `plan`: what each caption should say, from a render of the backdrop (the frame without the captions).
- `needs_pass`: whether the step has anything to do (an overlay that may be a card, or ink of ours to clear).
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
SAMPLE_OVERLAY_PY = os.path.join(MONTAJ_ROOT, "steps", "render", "sample_overlay.py")

# plate and subtitle draw on their own box: the step does nothing for them (and clears nothing).
INK_STYLES = ("accent", "clean", "highlight-box", "karaoke", "outline", "pop", "word-by-word")
# A backdrop is light when the mean relative luminance of the caption band is at least this. Paper #efece4 is about
# 0.83, so it draws dark; #a6a49e (about 0.37) and footage stay white.
LIGHT_L = 0.5
# An overlay covers the caption band when at least COVER_SHARE of the band's pixels have alpha >= COVER_ALPHA / 255.
COVER_ALPHA = 230
COVER_SHARE = 0.9
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
    """True when the step has something to do: a caption, and an overlay that may be a card or ink of ours to clear."""
    segs = lc.caption_segments(project)
    return bool(segs) and bool(cards(project) or any(ours(s) for s in segs))


def _canvas_placed(item):
    """timeline-core isFullCanvasPlacement: scale 1, no offset, no rotation, no keyframes but opacity's."""
    for k in ("scale", "scaleX", "scaleY"):
        if abs(lc._num(item.get(k, 1), 1) - 1) > 0.001:
            return False
    if any(abs(lc._num(item.get(k))) > 0.001 for k in ("offsetX", "offsetY", "rotation")):
        return False
    return not any(isinstance(k, dict) and k.get("prop") != "opacity" for k in item.get("keyframes") or [])


def _candidate(item):
    """An overlay that can be a card: over the whole canvas at a static opacity of 1."""
    return (item.get("type") == "overlay" and lc._num(item.get("opacity", 1), 1) >= 0.999 and _canvas_placed(item)
            and lc._num(item.get("end")) > lc._num(item.get("start")))


def cards(project):
    """[(item, label)] of every overlay that may be a card: drawn over the whole canvas, on a drawn track."""
    out = []
    for ti, row in enumerate(lc.drawn_tracks(project)):
        out += [(it, lc._label(it, ti)) for it in row if _candidate(it)]
    return out


def _stack(project, t):
    """[(item, label)] on screen at `t`, top to bottom: the candidate overlays and the footage (video, image)."""
    rows = lc.drawn_tracks(project)
    pos = lc.layer_positions(rows)
    found = []
    for ti, row in enumerate(rows):
        for k, it in enumerate(row):
            if not (lc._num(it.get("start")) <= t < lc._num(it.get("end"))):
                continue
            if _candidate(it) or it.get("type") in lc.VISUAL:
                found.append(((pos[ti], k), it, lc._label(it, ti)))
    found.sort(key=lambda f: f[0], reverse=True)
    return [(it, label) for _, it, label in found]


def on_screen(project, t):
    """The labels of the overlays that may be cards, on screen at `t`."""
    return [label for it, label in _stack(project, t) if it.get("type") == "overlay"]


def _scene_backdrop(project_dir, item, warn):
    """The style of the backdrop a 3D item's scene draws ("studio", "color", ...; "" when it has none): its
    models/scenes/<id>/active.json (the project's own scene is models/active.json), else a scene.json beside it. None
    when the scene cannot be read (a warning is given)."""
    sid = (item.get("props") or {}).get("scene") if isinstance(item.get("props"), dict) else None
    base = os.path.join(project_dir, "models", "scenes", sid) if isinstance(sid, str) and sid else os.path.join(project_dir, "models")
    for name, nested in (("active.json", True), ("scene.json", False)):
        try:
            with open(os.path.join(base, name), encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError):
            continue
        scene = doc.get("scene") if nested and isinstance(doc, dict) else doc
        if isinstance(scene, dict):
            back = scene.get("backdrop")
            return str(back.get("style") or "") if isinstance(back, dict) else ""
    warn(f"3D scene of {item.get('id') or 'a 3D item'} not readable: its captions are not checked against it")
    return None


def _data_cover(item, project_dir, warn):
    """True/False when the project data says whether an overlay covers the frame: opaque, or a 3D scene (whose backdrop
    is not transparent). None for any other overlay: only its pixels can say."""
    if item.get("opaque") is True:
        return True
    if item.get("src") == "engine:scene3d":
        if not project_dir:
            return False
        style = _scene_backdrop(project_dir, item, warn)
        return style is not None and style != "transparent"
    return None


def _footage_hits(item, box, size):
    """True when a video or image's box on the frame (its scale and offset) meets `box`."""
    pb = lc.placed_box({"x": 0, "y": 0, "w": size[0], "h": size[1]}, item, size[0], size[1])
    return pb["x"] < box[2] and pb["x"] + pb["w"] > box[0] and pb["y"] < box[3] and pb["y"] + pb["h"] > box[1]


class Unmeasured(Exception):
    """An overlay that had to be rendered to say whether it covers the band could not be."""


def alpha_cover(png_path, box, frame=None):
    """Share (0..1) of `box` (as luminance takes it) whose pixels are at least 90% opaque."""
    from PIL import Image
    with Image.open(png_path) as im:
        im = im.convert("RGBA")
        sx = im.width / frame[0] if frame else 1.0
        sy = im.height / frame[1] if frame else 1.0
        x0, x1 = sorted((int(round(box[0] * sx)), int(round(box[2] * sx))))
        y0, y1 = sorted((int(round(box[1] * sy)), int(round(box[3] * sy))))
        x0, y0 = max(0, min(x0, im.width - 1)), max(0, min(y0, im.height - 1))
        x1, y1 = max(x0 + 1, min(x1, im.width)), max(y0 + 1, min(y1, im.height))
        hist = im.crop((x0, y0, x1, y1)).getchannel("A").histogram()
    return sum(hist[COVER_ALPHA:]) / ((x1 - x0) * (y1 - y0))


def _frame_of(item, t, fps):
    return int(round((t - lc._num(item.get("start"))) * fps))


def find_card(project, t, box, size, project_dir=None, measured=None, need=None, warn=None):
    """The card under `box` (the caption's band) at `t`, or None. Walks the items on screen from the top: footage whose
    box meets the band ends it (the caption is over footage); the first overlay that covers the band is the card (a copy
    of the item with `id` = its label). An overlay the data cannot judge is judged by `measured`, {(label, frame): a PNG
    of the overlay alone, or None when it could not be rendered}; with no `measured` it covers nothing. A missing entry
    is added to `need` ({(label, frame): item}) and covers nothing there, else raises Unmeasured, as does a failed one."""
    warn = warn or (lambda _msg: None)
    fps = lc._num((project.get("settings") or {}).get("fps"), 30) or 30
    for item, label in _stack(project, t):
        if item.get("type") != "overlay":
            if _footage_hits(item, box, size):
                return None
            continue
        covers = _data_cover(item, project_dir, warn)
        if covers is None and measured is not None and not str(item.get("src") or "").startswith("engine:"):
            key = (label, _frame_of(item, t, fps))
            if key in measured:
                if measured[key] is None:
                    raise Unmeasured(label)
                covers = alpha_cover(measured[key], box, size) >= COVER_SHARE
            elif need is not None:
                need[key] = item
            else:
                raise Unmeasured(label)
        if covers:
            out = dict(item)
            out["id"] = label
            return out
    return None


def card_under(project, t, box=None, project_dir=None):
    """The card at `t` that the project data alone shows (an opaque overlay, or a 3D scene with a backdrop when
    `project_dir` can read it), or None. `box` is the band to cover; the whole frame without it."""
    size = lc.design_size(project)
    return find_card(project, t, box or (0, 0, size[0], size[1]), size, project_dir)


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


def overlay_renderer(project, project_dir, out_dir, deadline=None):
    """overlay_fn(item, frame) -> the path of a transparent PNG of the overlay rendered alone at `frame` (steps/render/
    sample_overlay.py, as look measures it but without --measure), at the project's design size and fps, over the
    item's own length. Same time limits as frame_renderer."""
    width, height = lc.design_size(project)
    fps = int(round(lc._num((project.get("settings") or {}).get("fps"), 30))) or 30

    def render(item, frame):
        path = lc.overlay_path(item, project_dir)
        if not path or not os.path.isfile(path):
            raise RuntimeError("overlay file missing")
        timeout = RENDER_TIMEOUT_S
        if deadline is not None:
            timeout = min(timeout, deadline - time.monotonic())
            if timeout <= 0:
                raise RuntimeError("out of time")
        out = os.path.join(out_dir, f"ink-overlay-{abs(hash((item.get('id'), frame)))}-{frame}.png")
        span = max(1, int(round((lc._num(item.get("end")) - lc._num(item.get("start"))) * fps)))
        cmd = [sys.executable, SAMPLE_OVERLAY_PY, "--overlay", path, "--frame", str(frame), "--duration", str(span),
               "--fps", str(fps), "--width", str(width), "--height", str(height),
               "--props", json.dumps(item.get("props") or {}), "--out", out]
        for font in item.get("googleFonts") or []:
            if isinstance(font, str) and font:
                cmd += ["--google-fonts", font]
        r = _run_group(cmd, timeout)
        if r is None:
            raise RuntimeError("timed out")
        if r[0] != 0 or not os.path.isfile(out):
            raise RuntimeError("sample_overlay failed")
        return out
    return render


def _pooled(fn, jobs, deadline):
    """{job key: result or None} for jobs [(key, args)], RENDER_WORKERS at a time, and {key: why} for the failed ones.
    A job not started by `deadline` (time.monotonic) fails."""
    def one(job):
        key, args = job
        if deadline is not None and time.monotonic() >= deadline:
            return key, None, "out of time"
        try:
            return key, fn(*args), None
        except Exception as e:  # noqa: BLE001 — a failed render leaves its captions as they are
            return key, None, str(e)[:80]
    done, failed = {}, {}
    with ThreadPoolExecutor(max_workers=RENDER_WORKERS) as pool:
        for key, out, why in pool.map(one, jobs):
            if out:
                done[key] = out
            else:
                done[key] = None
                failed[key] = why
    return done, failed


def plan(project, render_fn, width, height, deadline=None, overlay_fn=None, project_dir=None):
    """(changes, counts, warnings). changes: {segment key: {"ink", "inkAuto": {"card", "ink", "backdrop"}} or None to clear}, keyed
    by `_key` over the raw segment list. render_fn(t) -> a PNG path of the backdrop at `t`; one render per distinct
    caption middle, three at a time. overlay_fn(item, frame) -> a PNG path of one overlay rendered alone, for the
    overlays whose pixels say whether they cover a caption's band (find_card); without it only the data decides.
    `project_dir` is where 3D scene files are read. A frame not started by `deadline` (time.monotonic) counts as
    failed; a caption whose card could not be judged is left as it is."""
    counts = {"dark": 0, "light": 0, "cleared": 0, "kept": 0}
    changes, warnings, todo = {}, [], []   # todo: (key, mid, box, card id)
    size = (width, height)
    warns = {}   # a message once, in the order it came
    warn = lambda msg: warns.setdefault(msg, None)  # noqa: E731
    mine = []   # (key, seg, mid, box): captions to look under
    for i, seg in enumerate(_raw_segments(project)):
        if not isinstance(seg, dict) or not inkable(project, seg):
            continue
        if not ours(seg) and (seg.get("ink") or "inkAuto" in seg):
            counts["kept"] += 1
            continue
        mid = _mid(seg)
        box = band(project, seg, width, height)
        if box is None and any(it.get("type") == "overlay" for it, _ in _stack(project, mid)):
            warnings.append(f"no caption band at {lc.r2(mid)}s")
            continue
        mine.append((_key(seg, i), seg, mid, box))
    measured = None
    if overlay_fn is not None:
        need = {}
        for _, _, mid, box in mine:
            if box is not None:
                find_card(project, mid, box, size, project_dir, measured={}, need=need, warn=warn)
        samples, failed = _pooled(overlay_fn, [(k, (it, k[1])) for k, it in need.items()], deadline)
        measured = samples
        for k, why in failed.items():
            warn(f"overlay {k[0]} at frame {k[1]} not rendered ({why or 'no image'}): its captions are unchanged")
    for key, seg, mid, box in mine:
        try:
            card = find_card(project, mid, box, size, project_dir, measured, warn=warn) if box is not None else None
        except Unmeasured:
            continue
        if card is None:
            if ours(seg):
                changes[key] = None
                counts["cleared"] += 1
            continue
        todo.append((key, mid, box, card["id"]))
    times = sorted({round(t[1], 3) for t in todo})
    pngs, failed = _pooled(render_fn, [(t, (t,)) for t in times], deadline)
    pngs = {t: p for t, p in pngs.items() if p}
    warnings += list(warns)
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


def apply_changes(fresh, changes, read, project_dir=None):
    """Write `changes` onto the fresh project's captions. `read` is {key: the whole segment as the plan read it}: a
    changed segment that is gone, is not the only one with its key, or differs from what was read in any field raises
    InkProjectChanged, and nothing is written; so does one whose card is no longer on screen at the caption's middle, or
    that is to be cleared and lies under a card the data shows now (opaque, or a 3D scene: a card found by its pixels
    is not rendered again under the lock). Returns True when anything changed."""
    segments = _captions_of(fresh)["segments"]
    found = {}
    for key, change in changes.items():
        hits = [s for i, s in enumerate(segments) if isinstance(s, dict) and _key(s, i) == key]
        if len(hits) != 1 or hits[0] != read[key]:
            raise InkProjectChanged(key)
        mid = _mid(hits[0])
        if change is not None:
            if change["inkAuto"]["card"] not in on_screen(fresh, mid):
                raise InkProjectChanged(key)
        else:
            size = lc.design_size(fresh)
            box = band(fresh, hits[0], *size) or (0, 0, *size)
            if find_card(fresh, mid, box, size, project_dir) is not None:
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


def update(project_path, render_fn=None, timeout=LOCK_TIMEOUT, overlay_fn=None):
    """Read the project, plan, and write `captions` only (under the project lock, onto the fresh captions).
    Returns the answer ({dark, light, cleared, kept, changed, warnings?}; `changed` is whether anything was written) or
    None when there is nothing to do (see needs_pass). Raises InkProjectChanged; lock errors (ProjectLockTimeout,
    ProjectReadOnly, SyncConflict) pass through."""
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
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
        base = os.path.join(project_dir, "render", "samples")
        os.makedirs(base, exist_ok=True)
        samples = tempfile.mkdtemp(prefix="caption-ink-", dir=base)   # this run's frames; another pass shares none
        render_fn = frame_renderer(project_path, samples, deadline)
        overlay_fn = overlay_renderer(project, project_dir, samples, deadline)
    try:
        changes, counts, warnings = plan(project, render_fn, width, height, deadline, overlay_fn, project_dir)
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
        if apply_changes(fresh, changes, read, project_dir):
            out["changed"] = True
            return fresh
        return None
    update_project(project_path, apply, timeout=timeout)
    return out
