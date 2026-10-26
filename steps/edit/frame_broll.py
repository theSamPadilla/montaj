#!/usr/bin/env python3
"""frame_broll (PL89): a landscape clip on a vertical timeline (b-roll), framed in one call.

- `track`: the moving subject is found across the clip's range (lib/subject_track.py: background subtraction, numpy
  only, on frames ffmpeg decodes small) and the item gets a full-height crop of the canvas's shape whose left edge
  is keyframed to follow it (`sourceCrop` plus a `cropX` track, item seconds).
- `card`: the whole frame, scaled into the upper middle of the canvas (above the captions), under a footage-card
  overlay (montaj_assets/render/templates/presets/footage-card.jsx): paper round it, corner brackets on the
  tracked subject (or the footage's corners) and `Footage: <source>` under it.
- `auto` (the default): `track` when one subject is found in most of the range, else `card`, saying why.
- A clip already as tall as the canvas needs nothing, and nothing is written.
- The write: tracks only, through lib/project_lock.update_project_or_fail, refused (`project_changed`) when the
  tracks changed since the step read them; a version of the project first, as place's update takes one.
- The answer: one short JSON, with `path`, a sheet of the item's range on the timeline as it now looks.
"""
import argparse, contextlib, copy, io, json, os, re, subprocess, sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import look_check as lc, project_revisions, subject_track, sync_clash  # noqa: E402
from lib.common import fail, ffmpeg_bin, ffprobe_value, ff_seconds, ff_input, get_duration  # noqa: E402
from lib.project_lock import update_project_or_fail  # noqa: E402
from lib.project_tracks import normalize_tracks  # noqa: E402
from lib.project_versions import commit_version, is_own_repo  # noqa: E402
import steps.edit.place as place  # noqa: E402

ANALYSIS_W = 192          # px wide the frames are read at
TRACK_FPS = 6             # frames a second read over the item's range
BG_FPS = 2                # and over the wider window the background comes from
BG_MARGIN_S = 6.0         # seconds of the source either side of the range in that window
CARD_SCALE = 0.88         # the card's footage width, a share of the canvas
CARD_CENTER_Y = 0.36      # its centre, a share of the canvas height (above the captions at 56-76%)
SHEET_TIMES = 4
KEY_TOLERANCE = 0.006     # a crop key is dropped when the line between its neighbours is this close to it
UNDER_CAPTIONS = 0.5      # the share of the frames with the subject that put it under the captions, for auto to card
DEFAULT_CAPTION_BAND = (0.56, 0.76)   # where montaj's captions draw on a tall frame, every style (look_check.CAPTION_BAND)
VERSION_MESSAGE = "version: before frame_broll"
STEP_LOCK_TIMEOUT = 30.0
DEFAULT_MATTE = "#F5F3EB"   # a warm cream, when a profile asks for mattes but names no colour
MAX_ITEMS = 12          # items in one call
MAX_PARALLEL = 4        # clips read and tracked at once
MAX_SHEET_TIMES = 12    # times on the sheet of a list
DONE = ". Done: this clip is framed; run frame_broll with another mode to change it, not an edit by hand."


def read_tracks(project_path):
    """The project as read, and its tracks' revision."""
    with open(project_path, encoding="utf-8") as f:
        doc = json.load(f)
    return doc, project_revisions.revision_of(doc.get("tracks"))


def gray_frames(src, start, end, fps):
    """Frames (n, h, w) of `src` from `start` to `end` seconds, grey, ANALYSIS_W wide."""
    import numpy as np
    cmd = [ffmpeg_bin(), "-v", "error", "-ss", ff_seconds(start), "-t", ff_seconds(max(0.1, end - start)),
           "-i", ff_input(src), "-vf", f"fps={fps},scale={ANALYSIS_W}:-2,format=gray", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    probe = [ffmpeg_bin(), "-v", "error", "-ss", ff_seconds(start), "-i", ff_input(src), "-frames:v", "1",
             "-vf", f"scale={ANALYSIS_W}:-2,format=gray", "-f", "rawvideo", "-"]
    h = len(subprocess.run(probe, capture_output=True, check=True).stdout) // ANALYSIS_W
    n = len(raw) // (ANALYSIS_W * h)
    return np.frombuffer(raw[: n * ANALYSIS_W * h], dtype=np.uint8).reshape(n, h, ANALYSIS_W)


def profile_matte(project):
    """The person's matte for wide footage, from their profile's "Titles & overlays" notes (profileSnapshot's
    styleProfilePath): {"paper": its colour (the line's first #hex, else DEFAULT_MATTE), "brackets": False when the line
    says no borders} for the first line there about mattes; None when the notes say nothing about mattes (or there are
    no notes)."""
    path = ((project or {}).get("profileSnapshot") or {}).get("styleProfilePath")
    if not isinstance(path, str) or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read(200_000)
    except OSError:
        return None
    section, inside = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            if inside:
                break
            inside = bool(re.search(r"titles?\b.*overlays?", line, re.I))
            continue
        if inside:
            section.append(line)
    line = next((l for l in section if re.search(r"\bmattes?\b", l, re.I)), None)
    if line is None:
        return None
    hexes = re.findall(r"#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b", line)
    return {"paper": hexes[0] if hexes else DEFAULT_MATTE,
            "brackets": not re.search(r"\bno (?:decorative )?(?:borders?|frames?|framing)\b|\bwithout (?:decorative )?borders?\b", line, re.I)}


def caption_band(project, start, end, width, height):
    """(top, bottom) as shares of the height where the captions draw over [start, end): the project's own style, or
    every style's band on a tall frame when it has no captions yet (they are usually added later)."""
    bands = lc.caption_bands(project, start, end, width, height)
    if bands:
        return min(b[0] for b in bands) / height, max(b[1] for b in bands) / height
    return DEFAULT_CAPTION_BAND


def under_captions(boxes, band, share=0.3):
    """The share of the subject's boxes [x, y, w, h] with over `share` of their height in the caption band."""
    hit = [max(0.0, min(y + h, band[1]) - max(y, band[0])) > share * h for _, y, _, h in boxes]
    return sum(hit) / len(hit) if hit else 0.0


def simplify(points, tol=KEY_TOLERANCE):
    """Keys [(t, v)] without those the straight line between their neighbours already gives (within tol)."""
    if len(points) <= 2:
        return points
    keep = [points[0]]
    for i in range(1, len(points) - 1):
        (t0, v0), (t1, v1), (t2, v2) = keep[-1], points[i], points[i + 1]
        line = v0 + (v2 - v0) * (t1 - t0) / (t2 - t0) if t2 > t0 else v0
        if abs(line - v1) > tol:
            keep.append(points[i])
    keep.append(points[-1])
    return keep


def default_sampler(project_path, times, out):
    """One labelled sheet of the timeline at `times` (sample_frame's renderer, in one process)."""
    import tempfile
    from lib.sheet import tile_sheet
    from steps.render.sample_frame import sample_frames
    with tempfile.TemporaryDirectory() as work:
        paths = sample_frames(project_path, times, work)
        tile_sheet(paths, times, len(times), 270, out, label_px=26)
    return out


class ItemRefused(Exception):
    """One item's refusal: fail() for a single item, a line of its own in a list."""
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def analyse(project, on_disk, project_path, item_id, mode, matte=None):
    """What framing `item_id` takes, computed from the project as read (nothing is written): a plan for write_plans,
    or {"id", "mode": "none", "why"} for a clip that needs nothing. Raises ItemRefused."""
    hit = place.find_item(project, item_id)
    if hit is None:
        raise ItemRefused("item_not_found", f"No item {item_id} on the timeline.")
    ti, _, item = hit
    if item.get("type") != "video" or ti == 0:
        raise ItemRefused("not_broll", f"{item_id} is not a video clip on an upper track (b-roll); the first track is the main footage.")
    sw, sh = lc._num(item.get("sourceWidth")), lc._num(item.get("sourceHeight"))
    src = item.get("proxySrc") if item.get("proxySrc") and os.path.isfile(item["proxySrc"]) else item.get("src")
    if not src or not os.path.isfile(src):
        raise ItemRefused("file_not_found", f"The clip's file is missing: {item.get('src')}")
    probed = None
    if not (sw > 0 and sh > 0):
        # the original's size (a proxy is smaller, with the same shape): a keyed video crop needs it on the item
        dims = ffprobe_value(item["src"] if os.path.isfile(item.get("src") or "") else src, "stream=width,height", "v:0")
        try:
            sw, sh = (float(v) for v in dims.split(",")[:2])
        except ValueError:
            raise ItemRefused("probe_failed", f"Could not read the clip's size: {dims!r}")
        probed = (int(sw), int(sh))
    W, H = lc.design_size(project)
    canvas = W / H
    if sw / sh <= canvas * 1.05:
        return {"id": item_id, "mode": "none", "why": "the clip is already as tall as the canvas; nothing to frame"}
    crop_w = round((sh * canvas) / sw, 4)

    start, end = lc._num(item.get("start")), lc._num(item.get("end"))
    t_in = lc._num(item.get("inPoint"))
    t_out = lc._num(item.get("outPoint")) if item.get("outPoint") is not None else t_in + (end - start)
    rate = (t_out - t_in) / (end - start) if end > start else 1.0
    duration = get_duration(src)
    frames = gray_frames(src, t_in, t_out, TRACK_FPS)
    bg = gray_frames(src, max(0.0, t_in - BG_MARGIN_S), min(duration, t_out + BG_MARGIN_S), BG_FPS)
    path = subject_track.track(frames, bg, crop_w)
    n = max(1, len(path["points"]))
    times = [min(t_in + k / TRACK_FPS, t_out) for k in range(len(path["points"]))]

    why = None
    band = caption_band(project, start, end, W, H)
    captions_now = bool(lc.caption_bands(project, start, end, W, H))
    # a full-height crop keeps the source's heights, so the subject's box is where it lands on screen
    boxes_found = [p["box"] for p in path["points"] if p["box"] is not None]
    # text off the subject (Sam): the captions crossing the followed subject in most of the clip makes auto card it
    crossed = under_captions(boxes_found, band, 0.05)
    seen = f"the subject is in {path['found']}/{n} frames"
    if mode == "auto":
        if matte:
            mode, why = "card", f"card: the profile asks for mattes for wide footage ({matte['paper']})"
        elif path["cluttered"] > 0.3 * n:
            mode, why = "card", "card: the camera moves, so there is no one subject to follow"
        elif path["found"] < 0.6 * n:
            mode, why = "card", "card: no moving subject was found in most of the clip"
        elif path["capture"] < 0.5:
            mode, why = "card", "card: what moves is wider than the crop"
        elif crossed > UNDER_CAPTIONS:
            mode = "card"
            why = ("card: a crop that follows the subject puts the captions across it; the card keeps it above them"
                   if captions_now else
                   f"card: {seen}, and the captions still to come would cross it in {round(crossed * 100)}% of the clip;"
                   " the card keeps it above them")
        else:
            mode = "track"
            why = f"track: {seen} and the captions stay clear of it"
    elif mode == "track" and path["found"] == 0:
        raise ItemRefused("no_subject", "No moving subject in the clip to follow; use mode card.")
    else:
        why = f"{mode}: as asked"

    item_t = lambda st: round((st - t_in) / rate, 3) if rate > 0 else 0.0  # noqa: E731
    found = [(item_t(st), p) for st, p in zip(times, path["points"]) if p["box"] is not None]
    width_ratio = sw / sh
    card_h = CARD_SCALE * (W / H) / width_ratio            # the footage's height on screen, a share of the canvas
    box = [round((1 - CARD_SCALE) / 2, 4), round(CARD_CENTER_Y - card_h / 2, 4), CARD_SCALE, round(card_h, 4)]
    return {"id": item_id, "mode": mode, "why": why, "probed": probed, "crop_w": crop_w, "box": box, "start": start,
            "end": end, "W": W, "H": H, "track_keys": [(item_t(st), round(p["x"], 4)) for st, p in zip(times, path["points"])] if mode == "track" else None,
            "found_boxes": found, "found": path["found"], "n": n, "crossed": crossed}


def run(project_path, item_id, *, mode="auto", source=None, detail=False, sampler=None):
    """Frame one b-roll item (`item_id` a string: the answer as it always was) or several (a list: {"items": [one
    answer each, in the order given], "path"} from one write and one sheet)."""
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    sampler = sampler or default_sampler
    if mode not in ("auto", "track", "card"):
        fail("invalid_params", "mode is auto, track or card.")
    single = isinstance(item_id, str)
    ids = [item_id] if single else list(dict.fromkeys(str(i) for i in item_id))
    if not ids:
        fail("invalid_params", "item is one item id or a list of them.")
    if len(ids) > MAX_ITEMS:
        fail("invalid_params", f"At most {MAX_ITEMS} items in one call.")
    on_disk, read_rev = read_tracks(project_path)
    project = normalize_tracks(copy.deepcopy(on_disk))

    matte = profile_matte(on_disk)

    def one(i):
        try:
            return analyse(project, on_disk, project_path, i, mode, matte)
        except ItemRefused as e:
            return {"id": i, "error": e.code, "message": e.message}
    if len(ids) == 1:
        plans = [one(ids[0])]
    else:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL, len(ids))) as pool:
            plans = list(pool.map(one, ids))
    if single and "error" in plans[0]:
        fail(plans[0]["error"], plans[0]["message"])
    todo = [pl for pl in plans if pl.get("mode") in ("track", "card")]
    if single and not todo:
        return {k: plans[0][k] for k in ("id", "mode", "why")}

    credit = f"Footage: {source.strip()}" if source and source.strip() else ""
    made, preset_src = False, None
    if any(pl["mode"] == "card" for pl in todo):
        def sync_check(rel):
            try:
                sync_clash.check_step_write(on_disk.get("id"), (), [rel])
            except sync_clash.SyncConflict as e:
                sync_clash.exit_refused(e.body)
        referenced = {it.get("src") for t in project["tracks"] for it in t.get("items", []) if isinstance(it.get("src"), str)}
        rel, made = place.preset_file(project_dir, "footage_card", referenced, sync_check)
        preset_src = "./" + rel

    written, version = {}, None

    def apply(fresh):
        nonlocal version
        if project_revisions.revision_of(fresh.get("tracks")) != read_rev:
            fail("project_changed", "The tracks changed since frame_broll read them (an edit in the editor or another "
                                    "step). Run frame_broll again.")
        doc = normalize_tracks(fresh)
        for pl in todo:
            it = place.find_item(doc, pl["id"])[2]
            keyframes = [k for k in (it.get("keyframes") or []) if not str(k.get("prop", "")).startswith("crop")]
            for k in ("sourceCrop", "scale", "offsetX", "offsetY"):
                it.pop(k, None)
            if pl["probed"]:
                it["sourceWidth"], it["sourceHeight"] = pl["probed"]
            if pl["mode"] == "track":
                keys = simplify(pl["track_keys"])
                it["sourceCrop"] = {"x": keys[0][1], "y": 0, "w": pl["crop_w"], "h": 1}
                keyframes.append({"prop": "cropX", "points": [{"t": t, "value": v} for t, v in keys]})
                written[pl["id"]] = {"keys": len(keys)}
            else:
                it["scale"] = CARD_SCALE
                it["offsetX"] = 0
                it["offsetY"] = round((CARD_CENTER_Y - 0.5) * 100, 3)
                subject = [[t, *[round(v, 4) for v in p["box"]]] for t, p in pl["found_boxes"]]
                start, end = pl["start"], pl["end"]
                card = {"id": place._new_id(doc), "type": "overlay", "src": preset_src, "start": start, "end": end,
                        "props": {"box": ",".join(str(v) for v in pl["box"]), "credit": credit,
                                  "subject": json.dumps(simplify_boxes(subject)) if subject else "",
                                  "canvasW": str(pl["W"]), "canvasH": str(pl["H"]),
                                  **({"paper": matte["paper"]} if matte else {}),
                                  **({"brackets": "off"} if matte and not matte["brackets"] else {})}}
                dest, refusal = place.choose_track(doc, start, end)
                if refusal:
                    fail("track_busy", f"No overlay track is free for the card of {pl['id']}: {refusal}.")
                tracks = doc["tracks"]
                if dest is None:
                    from lib import project_tracks
                    tracks.append({"id": project_tracks._new_track_id({t.get("id") for t in tracks}), "items": []})
                    dest = len(tracks) - 1
                tracks[dest]["items"] = sorted(tracks[dest]["items"] + [card], key=lambda x: lc._num(x.get("start")))
                written[pl["id"]] = {"card": card["id"]}
            if keyframes:
                it["keyframes"] = keyframes
            else:
                it.pop("keyframes", None)
        version = commit_version(project_dir, VERSION_MESSAGE)
        fresh["tracks"] = doc["tracks"]
        return fresh

    if todo:
        try:
            update_project_or_fail(project_path, apply, fail, timeout=STEP_LOCK_TIMEOUT)
        except BaseException:
            if made:
                try:
                    os.unlink(os.path.join(project_dir, preset_src[2:]))
                except OSError:
                    pass
            raise

    # One sheet: SHEET_TIMES over one clip, else two times in each framed clip (at most MAX_SHEET_TIMES).
    if single:
        span = todo[0]["end"] - todo[0]["start"]
        sheet_times = [round(todo[0]["start"] + span * (k + 0.5) / SHEET_TIMES, 2) for k in range(SHEET_TIMES)]
    else:
        sheet_times = sorted({round(pl["start"] + (pl["end"] - pl["start"]) * f, 2) for pl in todo for f in (0.3, 0.7)})[:MAX_SHEET_TIMES]
    samples = os.path.join(project_dir, "render", "samples")
    sheet, sheet_error = None, None
    if sheet_times:
        os.makedirs(samples, exist_ok=True)
        name = ids[0] if single else f"{ids[0]}-and-{len(ids) - 1}"
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(name))[:40]
        # the project is written by now: a sheet that cannot be made is said, never a failure of the step
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err):
                sheet = sampler(project_path, sheet_times, os.path.join(samples, f"frame_broll-{safe}.png"))
        except (SystemExit, Exception) as e:  # noqa: BLE001  (fail() exits; a renderer can raise anything)
            said = err.getvalue().strip().splitlines()
            sheet_error = (said[-1] if said else str(e) or type(e).__name__)[-300:]

    def answer(pl):
        if "error" in pl or pl["mode"] == "none":
            return {k: pl[k] for k in ("id", "error", "message", "mode", "why") if k in pl}
        out = {"id": pl["id"], "mode": pl["mode"], "why": pl["why"] + DONE}
        if pl["mode"] == "track":
            out["keys"] = written[pl["id"]]["keys"]
            out["found"] = f"{pl['found']}/{pl['n']} frames"
            if pl["crossed"] > UNDER_CAPTIONS:
                out["issues"] = [f"the captions cross the subject in {round(pl['crossed'] * 100)}% of the clip: card keeps it clear of them"]
        else:
            out["card"] = written[pl["id"]]["card"]
            if not credit:
                out["note"] = "no credit: pass source for a 'Footage: <source>' line"
        if detail:
            out["crop_w"], out["box"] = pl["crop_w"], pl["box"]
        return out
    if single:
        out = answer(todo[0])
    else:
        out = {"items": [answer(pl) for pl in plans]}
    if todo and not version and not is_own_repo(project_dir):
        out["version"] = False
    if sheet:
        out["sheet"] = out["path"] = sheet
    elif sheet_times:
        out["sheet_error"] = sheet_error
    return out


def simplify_boxes(subject, tol=0.01):
    """The subject's keys [t, x, y, w, h] without those its neighbours already give (each value within tol)."""
    if len(subject) <= 2:
        return subject
    keep = [subject[0]]
    for i in range(1, len(subject) - 1):
        a, b, c = keep[-1], subject[i], subject[i + 1]
        f = (b[0] - a[0]) / (c[0] - a[0]) if c[0] > a[0] else 0
        if any(abs(a[j] + (c[j] - a[j]) * f - b[j]) > tol for j in range(1, 5)):
            keep.append(b)
    keep.append(subject[-1])
    return keep


def build_parser():
    parser = argparse.ArgumentParser(description="Frame a landscape clip on a vertical timeline: follow its subject, or inset it as a card")
    parser.add_argument("--project", required=True, help="The project id, its folder, or its project.json")
    parser.add_argument("--item", required=True, action="append", help="The b-roll clip's item id; repeat it for several")
    parser.add_argument("--mode", default="auto", choices=["auto", "track", "card"], help="auto (default), track or card")
    parser.add_argument("--source", default=None, help="Where the footage is from, for the card's credit line")
    parser.add_argument("--detail", action="store_true", help="Also answer the crop width and the card's box")
    return parser


def main():
    args = build_parser().parse_args()
    project_path = args.project
    if os.path.isdir(project_path):
        project_path = os.path.join(project_path, "project.json")
    if not os.path.isfile(project_path):
        fail("file_not_found", f"No project.json at {args.project}")
    items = args.item[0] if len(args.item) == 1 else args.item
    print(json.dumps(run(project_path, items, mode=args.mode, source=args.source, detail=args.detail)))


if __name__ == "__main__":
    main()
