#!/usr/bin/env python3
"""push_in (PL89): a slow push on the talking-head clips, in one call.

- The clips: every video on the main track (the first; b-roll and overlays sit above it), or the `items` given.
- Each gets `scale` keyed from its start zoom to start + `zoom` across its whole length, linear, and `offsetY` keyed so
  the point `anchor` down the frame (the face, by default 35%) stays where it was. Consecutive clips alternate their
  start zoom (1.00, then 1.04), so the cut between two of them reads as a change of framing.
- style alternate (PL89i, Claude alone's kung fu edit): each clip its own ramp, in then out, clip to clip (1.00 to
  1 + zoom, then 1 + 1.5 zoom down to 1 + 0.5 zoom), so every cut lands on a new scale and the frame drifts.
- style punch (Sam, 2026-10-26): light zoom-in cuts on the head, a mix of shots at 1.0 and slightly zoomed, timed with
  words: the framing changes at every cut (1.0, then 1 + zoom held, 0.08 by default and 0.1 at most), and a clip of
  PUNCH_LONG s or more changes it once more inside, at the start of a word (`hold` keys: a cut in the shot, never a
  zoom, never mid-word): in on a key word (after a pause, a number, a name, a long word), out at a sentence start.
  The answer's `punches` say where each punch-in landed and on which word. A clip at 1.0 throughout has no framing keys.
- anchor face: the point that stays put is each clip's head (the body pose model's face landmarks, sampled through the
  clip), keyed on offsetX too; follow keys it along the head's smoothed path. A clip with no face found keeps the
  default anchor and is named in `noFace`.
- A clip a person framed (a scale or offset of its own, or keys on scale, scaleX, scaleY, offsetX or offsetY) is left
  alone and named in `kept`; one push_in pushed before (its two-key shape) is pushed again, so a second run is the same.
- The write: tracks only, through lib/project_lock.update_project_or_fail, refused (`project_changed`) when the
  tracks changed since the step read them; a version of the project first.
Prints one short JSON: {pushed, kept?, noFace?, punches?}.
"""
import argparse, copy, json, os, sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import look_check as lc, project_revisions  # noqa: E402
from lib.common import fail  # noqa: E402
from lib.project_lock import update_project_or_fail  # noqa: E402
from lib.project_tracks import normalize_tracks  # noqa: E402
from lib.project_versions import commit_version, is_own_repo  # noqa: E402

DEFAULT_ZOOM = 0.07      # Claude alone's 1.00 to 1.07
ALT_START = 1.04         # every other clip starts here, so a cut between two of them changes the framing
ALTERNATE_ZOOM = 0.09    # style alternate: Claude alone's kung fu ramps (1.00 to 1.09, 1.10 to 1.00, ...)
DEFAULT_ANCHOR = 0.35    # the share of the frame's height that stays put: a talking head's face
PUNCH_ZOOM = 0.08        # style punch: Sam's "a little bit, like 10% maybe max"
PUNCH_MAX = 0.1
PUNCH_LONG = 3.0         # a clip this long (s) changes its framing once more inside, on a word
PUNCH_MARGIN = 1.0       # ... never this close (s) to its ends
PAUSE_S = 0.25           # a word after a gap this long is spoken with weight
SMALL_WORDS = frozenset("""a an the and or but so if then than that this these those it its it's i i'm i've you your
we our they their he she his her him them me my to of in on at by for with from as is are was were be been am do does
did have has had not no just like um uh oh okay yeah well there here what which who how when where why can could would
will should really very also too up out about into over get got""".split())
NUMBER_WORDS = frozenset("""two three four five six seven eight nine ten eleven twelve fifteen twenty thirty forty fifty
sixty seventy eighty ninety hundred thousand million billion half double twice""".split())
STYLES = ("push", "alternate", "punch")
FACE_ANCHORS = ("face", "follow")
FACE_FPS = 2.0           # head samples a second through a clip
FACE_MAX_SAMPLES = 24
FACE_LANDMARKS = range(11)   # the body model's nose, eyes, ears and mouth
FACE_VISIBLE = 0.5
FOLLOW_SMOOTH = 5        # follow: the moving average (in samples) over the head's path
FOLLOW_TOLERANCE = 0.004 # follow: a key the line between its neighbours is within this share of is dropped
FRAMING = ("scale", "scaleX", "scaleY", "offsetX", "offsetY")
VERSION_MESSAGE = "version: before push_in"
STEP_LOCK_TIMEOUT = 30.0


def read_tracks(project_path):
    """The project as read, and its tracks' revision."""
    with open(project_path, encoding="utf-8") as f:
        doc = json.load(f)
    return doc, project_revisions.revision_of(doc.get("tracks"))


def push_tracks(dur, s0, s1, anchor):
    """The scale and offset tracks of one push from s0 to s1 over [0, dur] (item seconds). `anchor` is the share of the
    height that stays put, or [(t, x, y)]: the point that stays put, keyed (one point holds it for the whole clip)."""
    s0, s1 = round(s0, 4), round(s1, 4)
    off = lambda a, s: round((0.5 - a) * 100 * (s - 1), 4) + 0.0  # noqa: E731  keeps `a` where it was on screen
    scale = {"prop": "scale", "points": [{"t": 0, "value": s0}, {"t": dur, "value": s1}]}
    if not isinstance(anchor, list):
        return [scale, {"prop": "offsetY", "points": [{"t": 0, "value": off(anchor, s0)}, {"t": dur, "value": off(anchor, s1)}]}]
    at = anchor if len(anchor) > 1 else [(0, *anchor[0][1:]), (dur, *anchor[0][1:])]
    s_at = lambda t: s0 + (s1 - s0) * (t / dur if dur > 0 else 0)  # noqa: E731
    keys = lambda i: [{"t": round(t, 3), "value": off(p[i], s_at(t))} for t, *p in at]  # noqa: E731
    tracks = [scale]
    if any(abs(x - 0.5) > 1e-9 for _, x, _ in at):
        tracks.append({"prop": "offsetX", "points": keys(0)})
    tracks.append({"prop": "offsetY", "points": keys(1)})
    return tracks


def ramp(k, n, style, zoom):
    """The k-th pushed clip's (start, end) scale, of n."""
    if style == "alternate":
        return (1.0, 1 + zoom) if (k % 2 == 0 or n == 1) else (1 + 1.5 * zoom, 1 + 0.5 * zoom)
    if style == "punch":
        return (1.0, 1.0) if (k % 2 == 0 or n == 1) else (1 + zoom, 1 + zoom)
    s0 = 1.0 if (k % 2 == 0 or n == 1) else ALT_START
    return s0, s0 + zoom


def to_canvas(u, v, item, canvas):
    """A point at (u, v) shares of the source frame, in shares of the canvas the item fills: through its sourceCrop,
    else the centre of the source the canvas's shape covers."""
    crop = item.get("sourceCrop")
    if not isinstance(crop, dict):
        sw, sh = lc._num(item.get("sourceWidth")), lc._num(item.get("sourceHeight"))
        aspect = canvas[0] / canvas[1]
        if sw > 0 and sh > 0 and abs(sw / sh - aspect) > 1e-3:
            w = min(1.0, aspect * sh / sw)
            h = min(1.0, sw / (aspect * sh))
            crop = {"x": (1 - w) / 2, "y": (1 - h) / 2, "w": w, "h": h}
        else:
            return u, v
    cw, ch = lc._num(crop.get("w")) or 1.0, lc._num(crop.get("h")) or 1.0
    return (u - lc._num(crop.get("x"))) / cw, (v - lc._num(crop.get("y"))) / ch


_pose = {}


def find_head(item, project, project_path):
    """The head through a clip: [(item seconds, x, y) or None], in shares of the canvas (None where no face is seen).
    The body pose model's face landmarks, sampled FACE_FPS a second; [] when the model or the clip cannot be read."""
    import subprocess
    try:
        import numpy as np
        from lib.pose import body as body_lib, weights
        from lib.pose.video import video_info
        from lib.frame_sampling import input_args
        from lib.common import ffmpeg_bin
    except ImportError:
        return []
    src = item.get("proxySrc") if item.get("proxySrc") and os.path.isfile(item["proxySrc"]) else item.get("src")
    if not src or not os.path.isfile(src):
        return []
    start, end = lc._num(item.get("start")), lc._num(item.get("end"))
    t_in = lc._num(item.get("inPoint"))
    t_out = lc._num(item.get("outPoint")) if item.get("outPoint") is not None else t_in + (end - start)
    rate = (t_out - t_in) / (end - start) if end > start else 1.0
    fps = min(FACE_FPS, FACE_MAX_SAMPLES / max(t_out - t_in, 1e-3))
    try:
        if "models" not in _pose:
            _pose["models"] = body_lib.onnx_models(*weights.body_models())
        info = video_info(src)
        w = 360
        h = max(2, int(round(w * info.height / info.width / 2)) * 2)
        args, _ = input_args(src, fps, info.rate, info.color_transfer, after=f"scale={w}:{h}")
        r = subprocess.run([ffmpeg_bin(), "-v", "error", "-nostdin", "-ss", f"{t_in:.3f}", "-t", f"{t_out - t_in:.3f}",
                            *args, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, timeout=120)
    except (Exception, SystemExit):    # no pose model on this machine, or the clip does not decode: no face
        return []
    tracker = body_lib.PoseTracker(*_pose["models"])
    size = w * h * 3
    W, H = lc.design_size(project)
    out = []
    for k in range(len(r.stdout) // size):
        frame = np.frombuffer(r.stdout[k * size:(k + 1) * size], np.uint8).reshape(h, w, 3)
        people = tracker(frame)
        t = round(min(k / fps, t_out - t_in) / rate, 3)
        seen = [i for i in FACE_LANDMARKS if people and people[0].visibility[i] >= FACE_VISIBLE]
        if not seen:
            out.append(None)
            continue
        lm = people[0].landmarks
        u = float(np.mean([lm[i][0] for i in seen])) / w
        v = float(np.mean([lm[i][1] for i in seen])) / h
        out.append((t, *to_canvas(u, v, item, (W, H))))
    return out


def head_anchor(samples, dur, follow):
    """The anchor `push_tracks` takes from a clip's head samples, or None when no face was seen. face: the median place,
    held; follow: the path, smoothed, its ends at 0 and dur, keys a straight line passes near dropped."""
    seen = [(t, min(max(x, 0.0), 1.0), min(max(y, 0.0), 1.0)) for t, x, y in (s for s in samples if s)]
    if not seen:
        return None
    med = lambda vals: sorted(vals)[len(vals) // 2] if len(vals) % 2 else sum(sorted(vals)[len(vals) // 2 - 1:len(vals) // 2 + 1]) / 2  # noqa: E731
    if not follow or len(seen) < 3:
        return [(0, round(med([x for _, x, _ in seen]), 4), round(med([y for _, _, y in seen]), 4))]
    half = FOLLOW_SMOOTH // 2
    smooth = []
    for i, (t, _, _) in enumerate(seen):
        win = seen[max(0, i - half):i + half + 1]
        smooth.append((t, sum(p[1] for p in win) / len(win), sum(p[2] for p in win) / len(win)))
    smooth = [(0.0, *smooth[0][1:])] + [p for p in smooth if 0 < p[0] < dur] + [(dur, *smooth[-1][1:])]
    keep = [smooth[0]]
    for i in range(1, len(smooth) - 1):
        a, b, c = keep[-1], smooth[i], smooth[i + 1]
        f = (b[0] - a[0]) / (c[0] - a[0]) if c[0] > a[0] else 0
        if max(abs(a[j] + (c[j] - a[j]) * f - b[j]) for j in (1, 2)) > FOLLOW_TOLERANCE:
            keep.append(b)
    keep.append(smooth[-1])
    return [(t, round(x, 4), round(y, 4)) for t, x, y in keep]


def clip_words(item, project_dir):
    """The clip's spoken words, [(start, end, text)] in item seconds, from its transcript beside the source (the cut
    leaves one); [] without one."""
    from lib.speech_lines import load_words, sidecar_for
    try:
        sidecar = sidecar_for(item)
        rows = load_words(sidecar) if sidecar else []
    except (OSError, ValueError, KeyError):
        return []
    a = lc._num(item.get("inPoint"))
    b = lc._num(item.get("outPoint")) if item.get("outPoint") is not None else a + lc._num(item.get("end")) - lc._num(item.get("start"))
    span = lc._num(item.get("end")) - lc._num(item.get("start"))
    rate = (b - a) / span if span > 0 else 1.0
    return [((w.start - a) / rate, (w.end - a) / rate, w.text.strip()) for w in rows if a <= (w.start + w.end) / 2 < b]


def bare(text):
    return text.strip(".,!?;:\"'()[]\u2019\u201d\u201c").lower()


def punch_moment(rows, dur, zoomed):
    """Where a clip of `dur` s changes its framing inside, and on which word: (t, word) at a word's start, PUNCH_MARGIN
    clear of both ends, or None. In (`zoomed` False): the weightiest word, after a pause, a number, a name or a long
    word, never a small word. Out: a sentence start, else the same."""
    if dur < PUNCH_LONG:
        return None
    best = None
    for k, (t, _, text) in enumerate(rows):
        if not (PUNCH_MARGIN <= t <= dur - PUNCH_MARGIN):
            continue
        w = bare(text)
        prev = rows[k - 1] if k else None
        starts = prev is None or prev[2].rstrip("\"')]\u201d\u2019").endswith((".", "?", "!"))
        score = 0
        if w and w not in SMALL_WORDS:
            score += 1 + (len(w) >= 7) + 3 * (w in NUMBER_WORDS or any(c.isdigit() for c in w))
            score += 2 * (text[:1].isupper() and not starts)
        if zoomed and starts:
            score += 3
        if score and prev is not None and t - prev[1] >= PAUSE_S:
            score += 2
        if score and (best is None or score > best[0]):
            best = (score, round(t, 3), text.strip(".,!?;:\"'"))
    return best[1:] if best else None


def punch_tracks(dur, s0, toggle, anchor):
    """A punch's scale and offset tracks: s0 held, then (t, s) from t to the end when it changes inside; [] when it
    stays at 1.0. `hold` keys: the framing changes on the frame, never zooms."""
    levels = [(0, s0)] + ([(toggle[0], toggle[1])] if toggle else [])
    if all(v == 1.0 for _, v in levels):
        return []
    ax, ay = (0.5, anchor) if not isinstance(anchor, list) else anchor[0][1:]
    off = lambda a, v: round((0.5 - a) * 100 * (v - 1), 4) + 0.0  # noqa: E731

    def keys(value):
        pts = [{"t": round(t, 3), "value": value(v)} for t, v in levels] + [{"t": dur, "value": value(levels[-1][1])}]
        if toggle:
            pts[0]["easing"] = "hold"
        return pts
    tracks = [{"prop": "scale", "points": keys(lambda v: round(v, 4))}]
    if abs(ax - 0.5) > 1e-9:
        tracks.append({"prop": "offsetX", "points": keys(lambda v: off(ax, v))})
    tracks.append({"prop": "offsetY", "points": keys(lambda v: off(ay, v))})
    return tracks


def ours(item):
    """True when the item's framing is a push_in's own: a two-key scale track, an offsetY track (and an offsetX one, on
    the face) and nothing else framing it."""
    if any(item.get(k) not in (None, 0, 1) for k in FRAMING if k != "scale") or item.get("scale") not in (None, 1):
        return False
    tracks = {t.get("prop"): t for t in (item.get("keyframes") or []) if t.get("prop") in FRAMING}
    if sorted(tracks) not in (["offsetY", "scale"], ["offsetX", "offsetY", "scale"]):
        return False
    pts = tracks["scale"].get("points") or []
    punched = len(pts) == 3 and pts[0].get("easing") == "hold" and pts[1].get("value") == pts[2].get("value")
    return (len(pts) == 2 or punched) and all(len(t.get("points") or []) >= 2 for t in tracks.values())


def framed_by_a_person(item):
    if ours(item):
        return False
    if item.get("scale") not in (None, 1) or any(item.get(k) not in (None, 0) for k in ("offsetX", "offsetY")):
        return True
    if any(item.get(k) not in (None, 1) for k in ("scaleX", "scaleY")):
        return True
    return any(t.get("prop") in FRAMING for t in (item.get("keyframes") or []))


def run(project_path, *, items=None, zoom=None, anchor=DEFAULT_ANCHOR, style="push", detail=False):
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    if style not in STYLES:
        fail("invalid_params", f"style is one of {', '.join(STYLES)}.")
    zoom = {"alternate": ALTERNATE_ZOOM, "punch": PUNCH_ZOOM}.get(style, DEFAULT_ZOOM) if zoom is None else zoom
    if not (0 < zoom <= 0.2):
        fail("invalid_params", "zoom is how much the clip grows across it, more than 0 and at most 0.2 (0.07 is 7%).")
    if style == "punch" and zoom > PUNCH_MAX:
        fail("invalid_params", "A punch is light: zoom at most 0.1 (10%).")
    if anchor not in FACE_ANCHORS:
        try:
            anchor = float(anchor)
        except (TypeError, ValueError):
            anchor = -1
        if not (0 <= anchor <= 1):
            fail("invalid_params", "anchor is a share of the frame's height (0 to 1), face or follow.")
    on_disk, read_rev = read_tracks(project_path)
    project = normalize_tracks(copy.deepcopy(on_disk))
    tracks = project["tracks"]
    if items:
        everything = {it.get("id"): it for t in tracks for it in t.get("items", [])}
        for i in items:
            if i not in everything:
                fail("item_not_found", f"No item {i} on the timeline.")
            if everything[i].get("type") != "video":
                fail("not_a_video", f"{i} is a {everything[i].get('type')} item; push_in pushes video clips.")
        targets = [i for t in tracks for i in [it.get("id") for it in t.get("items", [])] if i in set(items)]
    else:
        main = tracks[0]["items"] if tracks else []
        targets = [it.get("id") for it in sorted(main, key=lambda x: lc._num(x.get("start"))) if it.get("type") == "video"]

    result = {"pushed": [], "kept": [], "noFace": []}
    version = None
    # The plan is made from the project as read (the write is refused when the tracks change since): each clip's
    # ramp, and for punch its change inside on a word and the punch-ins' words.
    by_id = {it.get("id"): it for t in tracks for it in t.get("items", [])}
    plan, punches = {}, []
    level = 1.0
    for k, i in enumerate([i for i in targets if not framed_by_a_person(by_id[i])]):
        it = by_id[i]
        dur = round(lc._num(it.get("end")) - lc._num(it.get("start")), 3)
        if style != "punch":
            plan[i] = (*ramp(k, len(targets), style, zoom), None)
            continue
        rows = clip_words(it, project_dir)
        s0 = 1.0 if k == 0 else (1.0 if level > 1 else round(1 + zoom, 4))   # every cut changes the framing
        moment = punch_moment(rows, dur, s0 > 1)
        toggle = (moment[0], 1.0 if s0 > 1 else round(1 + zoom, 4), moment[1]) if moment else None
        plan[i] = (s0, s0, toggle)
        level = toggle[1] if toggle else s0
        at = lc._num(it.get("start"))
        if s0 > 1:
            first = next((w for t, _, w in rows if t >= -0.05), None)
            punches.append({"at": round(at, 3), **({"word": first.strip(".,!?;:\"'")} if first else {})})
        elif toggle:
            punches.append({"at": round(at + toggle[0], 3), "word": toggle[2]})
    on_face = {}
    if anchor in FACE_ANCHORS:   # the heads are found before the lock: the model reads the clips, which takes seconds
        for i, (s0, s1, toggle) in plan.items():
            if (s0, s1) == (1.0, 1.0) and not toggle:
                continue   # a clip held at 1.0 has nothing to anchor
            dur = round(lc._num(by_id[i].get("end")) - lc._num(by_id[i].get("start")), 3)
            on_face[i] = head_anchor(find_head(by_id[i], project, project_path), dur, anchor == "follow" and style != "punch")

    def apply(fresh):
        nonlocal version
        if project_revisions.revision_of(fresh.get("tracks")) != read_rev:
            fail("project_changed", "The tracks changed since push_in read them (an edit in the editor or another "
                                    "step). Run push_in again.")
        before = normalize_tracks(copy.deepcopy(fresh))["tracks"]
        doc = normalize_tracks(fresh)
        by_id = {it.get("id"): it for t in doc["tracks"] for it in t.get("items", [])}
        for v in result.values():
            v.clear()
        for i in targets:
            it = by_id[i]
            if framed_by_a_person(it):
                result["kept"].append(i)
                continue
            s0, s1, toggle = plan[i]
            dur = round(lc._num(it.get("end")) - lc._num(it.get("start")), 3)
            rest = [t for t in (it.get("keyframes") or []) if t.get("prop") not in FRAMING]
            it.pop("scale", None)
            it.pop("offsetY", None)
            result["pushed"].append(i)
            if (s0, s1) == (1.0, 1.0) and not toggle:   # punch: held at 1.0, no framing keys
                if rest:
                    it["keyframes"] = rest
                else:
                    it.pop("keyframes", None)
                continue
            point = anchor
            if anchor in FACE_ANCHORS:
                point = on_face.get(i) or DEFAULT_ANCHOR
                if point == DEFAULT_ANCHOR:
                    result["noFace"].append(i)
            it["keyframes"] = rest + (punch_tracks(dur, s0, toggle, point) if style == "punch" else push_tracks(dur, s0, s1, point))
        if doc["tracks"] == before:
            return None   # nothing changes: nothing is written and no version is taken
        version = commit_version(project_dir, VERSION_MESSAGE)
        fresh["tracks"] = doc["tracks"]
        return fresh

    update_project_or_fail(project_path, apply, fail, timeout=STEP_LOCK_TIMEOUT)
    out = {"pushed": len(result["pushed"])}
    if result["kept"]:
        out["kept"] = list(result["kept"])
    if result["noFace"]:
        out["noFace"] = list(result["noFace"])
    if punches:
        out["punches"] = punches
    if version is None and result["pushed"] and not is_own_repo(project_dir):
        out["version"] = False
    if detail:
        out["items"] = list(result["pushed"])
    return out


def main():
    parser = argparse.ArgumentParser(description="A slow push on the talking-head clips")
    parser.add_argument("--project", required=True, help="The project id, its folder, or its project.json")
    parser.add_argument("--items", default=None, help="Only these clips: a JSON list of item ids")
    parser.add_argument("--zoom", type=float, default=None, help="How much each clip grows across it (default 0.07; alternate 0.09)")
    parser.add_argument("--anchor", default=DEFAULT_ANCHOR, help="The share of the height that stays put (default 0.35), face or follow")
    parser.add_argument("--style", default="push", help="push (default), alternate (in, then out, clip to clip) or punch (every other clip held a little closer)")
    parser.add_argument("--detail", action="store_true", help="Also answer the pushed item ids")
    args = parser.parse_args()
    project_path = args.project
    if os.path.isdir(project_path):
        project_path = os.path.join(project_path, "project.json")
    if not os.path.isfile(project_path):
        fail("file_not_found", f"No project.json at {args.project}")
    items = None
    if args.items:
        try:
            items = json.loads(args.items)
        except ValueError:
            items = [args.items]
        if not isinstance(items, list) or not all(isinstance(i, str) for i in items):
            fail("invalid_params", "items is a JSON list of item ids.")
    print(json.dumps(run(project_path, items=items, zoom=args.zoom, anchor=args.anchor, style=args.style, detail=args.detail)))


if __name__ == "__main__":
    main()
