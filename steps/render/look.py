#!/usr/bin/env python3
"""look (§558): one read-only check of a project, answered in a short JSON (lib/look_check.py has the rules).

On a carousel (projectType "carousel") it checks the slides instead (carousel_run below). Measures each overlay once (sample_overlay --measure, the existing Puppeteer path) at the middle of its span, at
most MAX_MEASURES overlays, MEASURE_WORKERS at a time, those on screen at the picked times first; with --image, one
contact_sheet of at most IMAGE_TIMES of those times. The text answer checks the project's data and the overlays it
measured: it renders no frame. Writes nothing in project.json; the measure PNGs and the sheet go under
render/samples.
"""
import argparse, hashlib, json, os, re, shutil, signal, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import look_check as lc, slide_check, slide_text  # noqa: E402
from lib.common import fail  # noqa: E402
from lib.project_tracks import normalize_tracks  # noqa: E402

SAMPLE_OVERLAY_PY = os.path.join(MONTAJ_ROOT, "steps", "render", "sample_overlay.py")
CONTACT_SHEET_PY = os.path.join(MONTAJ_ROOT, "steps", "render", "contact_sheet.py")
SHEET_COLS = 3
SHEET_TILE = 360        # px: phone-size tiles, captions readable
IMAGE_TIMES = 8
MEASURE_WORKERS = 3
MEASURE_TIMEOUT_S = 90
SHEET_TIMEOUT_S = 300


def _fps(project):
    try:
        f = int(round(float((project.get("settings") or {}).get("fps") or 30)))
    except (TypeError, ValueError):
        f = 30
    return f if f > 0 else 30


def _run_group(cmd, timeout):
    """(returncode, stdout, stderr) of `cmd` in its own process group; on a timeout the whole group (the wrapper,
    node, Chromium) is ended, SIGTERM then SIGKILL (Windows: taskkill of the tree), and None is returned."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out, err
    except subprocess.TimeoutExpired:
        if os.name == "nt":   # no process groups: end the tree by its root
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            proc.communicate()
            return None
        for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
            try:
                os.killpg(proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                break
            try:
                proc.wait(timeout=wait)
                break
            except subprocess.TimeoutExpired:
                continue
        proc.communicate()
        return None


def measure(item, path, frame, duration, fps, width, height, out):
    """sample_overlay --measure for one overlay frame: its measurements, or None with why."""
    cmd = [sys.executable, SAMPLE_OVERLAY_PY, "--overlay", path, "--frame", str(frame), "--duration", str(duration),
           "--fps", str(fps), "--width", str(width), "--height", str(height),
           "--props", json.dumps(item.get("props") or {}), "--measure", "--out", out]
    for font in item.get("googleFonts") or []:
        if isinstance(font, str) and font:
            cmd += ["--google-fonts", font]
    r = _run_group(cmd, MEASURE_TIMEOUT_S)
    if r is None:
        return None, "measure timed out"
    code, stdout, stderr = r
    if code != 0:
        try:
            err = json.loads(stderr.strip().splitlines()[-1])
            return None, str(err.get("message") or err.get("error") or "measure failed")[:120]
        except (ValueError, IndexError):
            return None, "measure failed"
    try:
        return json.loads(stdout.strip().splitlines()[-1]).get("measurements") or {}, None
    except (ValueError, IndexError, AttributeError):
        return None, "measure answered no JSON"


MEASURE_LANES = 3        # PL89g: browsers side by side in one measure_many call


def measure_many(entries):
    """PL89g: every overlay of a pass in one sample_overlay --jobs call (one process, MEASURE_LANES browsers, a page each)
    instead of a process and a Chromium per overlay. `entries`: [{item, path, frame, duration, fps, width, height,
    out}]. [(measurements, None) | (None, why)] in order, or None when the call itself failed (look then measures them
    one by one)."""
    if not entries:
        return []
    jobs = [{"component": e["path"], "props": e["item"].get("props") or {}, "frame": e["frame"], "fps": e["fps"],
             "width": e["width"], "height": e["height"], "duration": e["duration"], "out": e["out"],
             "googleFonts": [f for f in e["item"].get("googleFonts") or [] if isinstance(f, str) and f]} for e in entries]
    jobs_path = os.path.join(os.path.dirname(entries[0]["out"]), "look-jobs.json")
    with open(jobs_path, "w", encoding="utf-8") as f:
        json.dump(jobs, f)
    rounds = -(-len(jobs) // MEASURE_LANES)
    r = _run_group([sys.executable, SAMPLE_OVERLAY_PY, "--jobs", jobs_path, "--lanes", str(MEASURE_LANES)],
                   MEASURE_TIMEOUT_S * rounds)
    if r is None or r[0] != 0:
        return None
    try:
        results = json.loads(r[1].strip().splitlines()[-1])["results"]
    except (ValueError, IndexError, KeyError, TypeError):
        return None
    if not isinstance(results, list) or len(results) != len(entries):
        return None
    out = []
    for res in results:
        if isinstance(res, dict) and "measurements" in res:
            out.append((res["measurements"] or {}, None))
        else:
            out.append((None, str((res or {}).get("message") or (res or {}).get("error") or "measure failed")[:120]))
    return out


BACKDROP_TIMEOUT_S = 60   # PL89g: per time, for the pictures behind the measured overlays


def backdrops(project_path, project, entries):
    """PL89g: the picture under each measured overlay at its measured time, at the design size: {label: png}. One
    sample_frames call per track the overlays sit on (lc.backdrop_project: the tracks below it, no captions), from the
    proxies; a later pass whose tracks below did not change reads them from the frame cache. A track that fails is left
    out (its labels go unchecked), never an issue."""
    from lib.common import node_child_env
    from steps.render.sample_frame import SAMPLE_FRAME_JS
    project_dir = os.path.dirname(project_path)
    width, height = lc.design_size(project)
    out = {}
    by_track = {}
    for e in entries:
        by_track.setdefault(e["ti"], []).append(e)
    for ti, group in by_track.items():
        folder = os.path.join(project_dir, "render", "samples", "look", f"backdrop-{ti}")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "project.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(lc.backdrop_project(project, ti), f)
        cmd = ["node", SAMPLE_FRAME_JS, "--mode", "frame", "--project", path, "--prefer-proxy", "--no-captions",
               "--max-short-edge", str(min(width, height)), "--project-dir", project_dir]
        for e in group:
            cmd += ["--at", str(e["mid"])]
        # one time takes the single-frame form (--out), which node insists on
        cmd += ["--out", os.path.join(folder, "f_0000.png")] if len(group) == 1 else ["--frames-dir", folder]
        r = _run_group_env(cmd, BACKDROP_TIMEOUT_S * len(group), node_child_env())
        if r is None or r[0] != 0:
            continue   # a picture that cannot be had leaves its labels unchecked
        pngs = [ln.strip() for ln in r[1].splitlines() if ln.strip().endswith(".png")]
        if len(pngs) == len(group):
            out.update({e["label"]: p for e, p in zip(group, pngs)})
    return out


def overlays_to_measure(project, project_dir, times):
    """[(track index, item, path)] of overlays to measure: those on screen at a looked-at time first, then the rest,
    in time order; at most MAX_MEASURES. The count of the rest is returned too."""
    found = []
    for ti, row in enumerate(lc.drawn_tracks(project)):
        if ti == 0:
            continue
        for it in row:
            if it.get("type") != "overlay" or lc._num(it.get("end")) <= lc._num(it.get("start")):
                continue
            p = lc.overlay_path(it, project_dir)
            if p and os.path.isfile(p):
                seen = any(lc._num(it.get("start")) <= x <= lc._num(it.get("end")) for x in times)
                found.append((0 if seen else 1, lc._num(it.get("start")), ti, it, p))
    found.sort(key=lambda x: (x[0], x[1]))
    keep = found[:lc.MAX_MEASURES]
    return [(ti, it, p) for _, _, ti, it, p in keep], len(found) - len(keep)


def sheet(project_path, project_dir, times):
    """One contact sheet of the times, SHEET_COLS tiles of SHEET_TILE px across: its path, or None with why."""
    cols = min(SHEET_COLS, max(1, len(times)))
    digest = hashlib.sha1(json.dumps(times).encode()).hexdigest()[:8]
    out = os.path.join(project_dir, "render", "samples", f"look-{digest}.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cmd = [sys.executable, CONTACT_SHEET_PY, "--project", project_path, "--cols", str(cols),
           "--tile-width", str(SHEET_TILE), "--out", out]
    for t in times:
        cmd += ["--at", str(t)]
    r = _run_group(cmd, SHEET_TIMEOUT_S)
    if r is None:
        return None, "the contact sheet timed out"
    if r[0] != 0:
        return None, "the contact sheet failed"
    return out, None


def run(project_path, at=None, image=False, detail=False, measure_fn=None, sheet_fn=sheet, clock=time.monotonic,
        render_fn=None, backdrops_fn=None):
    t0 = clock()
    project_dir = os.path.dirname(project_path)
    try:
        with open(project_path, encoding="utf-8") as f:
            raw = json.load(f)
        project = normalize_tracks(raw)
    except (OSError, ValueError):
        fail("not_found", f"Project not readable: {project_path}")
    if isinstance(raw, dict) and raw.get("projectType") == "carousel":
        return carousel_run(project_path, raw, at=at, image=image, detail=detail, measure_fn=measure_fn or measure,
                            render_fn=render_fn or render_slides, clock=clock)
    width, height = lc.design_size(project)
    fps = _fps(project)
    times = lc.pick_times(project, at, cap=IMAGE_TIMES if image else lc.MAX_TIMES)
    issues = lc.data_issues(project, project_dir)
    issues += lc.caption_ink_issues(project, project_dir)   # captions over a card whose ink was not checked
    issues += lc.still_holds(project, project_dir)   # PL89: a stretch over 4 s with no beat and nothing moving
    to_measure, unmeasured = overlays_to_measure(project, project_dir, times)
    samples = os.path.join(project_dir, "render", "samples", "look")
    os.makedirs(samples, exist_ok=True)

    def prep(entry):
        ti, it, path = entry
        s, e = lc._num(it.get("start")), lc._num(it.get("end"))
        mid = (s + e) / 2
        frame, duration = int(round((mid - s) * fps)), max(1, int(round((e - s) * fps)))
        label = lc._label(it, ti)
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)[:40]
        return {"ti": ti, "item": it, "path": path, "label": label, "s": s, "e": e, "mid": mid, "frame": frame,
                "duration": duration, "fps": fps, "width": width, "height": height,
                "out": os.path.join(samples, f"{safe}-f{frame}.png")}

    entries = [prep(x) for x in to_measure]
    # PL89g: the pictures behind the overlays (for their labels' contrast), sampled while the overlays are measured. A
    # caller's own measure_fn (tests) checks contrast only with its own backdrops_fn.
    pictures_fn = backdrops_fn or (backdrops if measure_fn is None else None)
    picture_pool = ThreadPoolExecutor(max_workers=1) if pictures_fn and entries else None
    pictures = picture_pool.submit(pictures_fn, project_path, project, entries) if picture_pool else None
    # PL89g: the whole pass in one call; a caller's own measure_fn (tests, or a failed call) measures one at a time
    got = measure_many(entries) if measure_fn is None else None
    if got is None:
        one_fn = measure_fn or measure

        def one(x):
            return one_fn(x["item"], x["path"], x["frame"], x["duration"], fps, width, height, x["out"])
        with ThreadPoolExecutor(max_workers=MEASURE_WORKERS) as pool:
            got = list(pool.map(one, entries))
    results = [(x["ti"], x["item"], x["label"], x["s"], x["e"], x["mid"], m, why) for x, (m, why) in zip(entries, got)]
    try:
        behind = pictures.result() if pictures else {}
    except Exception:  # noqa: BLE001 — no pictures: the labels' contrast goes unchecked
        behind = {}
    finally:
        if picture_pool:
            picture_pool.shutdown(wait=False)
    placed, checked, notes = [], [], []
    for ti, it, label, s, e, mid, m, why in results:
        if m is None:
            issues.append({"t": lc.r2(mid), "id": label, "text": why})
            continue
        bands = lc.caption_bands(project, s, e, width, height)
        issues += lc.measured_issues(it, m, width, height, mid, label, bands)
        issues += lc.type_floor_issues(it, m, width, height, mid, label)   # PL89b
        issues += lc.mark_cover_issues(project, project_dir, it, m, width, height, mid, label)   # PL89e
        issues += lc.contrast_issues(it, m, width, height, mid, label, behind.get(label))   # PL89g
        placed.append((label, s, e, [lc.glyphs_of(b) for _, b, _, _ in lc.text_boxes(m, it, width, height)]))   # the text's own extent
        checked.append(label)
        if it.get("keyframes"):
            notes.append(f"{label}: keyframed geometry read at its base values")
    issues += lc.text_overlaps(placed)
    issues += lc.top_slot_issues(placed, width, height)   # PL89d: keywords stacked in one top slot
    issues += lc.unread_marks_issues(project, project_dir)   # round 9: a beat marked, never labelled
    # PL89b: every overlay's motion, from its code (no render): none, no exit, or linear only
    for ti, row in enumerate(lc.drawn_tracks(project)):
        if ti == 0:
            continue
        for it in row:
            if it.get("type") == "overlay":
                issues += lc.motion_issues(it, project_dir, lc._label(it, ti))
    extra = {"overlays": len(checked)}
    if unmeasured:
        extra["unmeasured"] = unmeasured
    if image and times:
        path, why = sheet_fn(project_path, project_dir, times)
        if path:
            extra["sheet"] = path
            extra["times"] = times
        else:
            issues.append({"t": 0.0, "id": "sheet", "text": why})
    out = lc.answer(issues, extra=extra)
    if detail:
        out.update({"issues": [f'{i["t"]}s {i["id"]}: {i["text"]}' for i in sorted(issues, key=lambda x: (x["t"], x["id"]))],
                    "times": times, "items": checked, "notes": notes, "wallMs": int((clock() - t0) * 1000)})
        out.pop("more", None)
    return out


# ── carousels ─────────────────────────────────────────────────────────────────────────────────────────────────────

CAROUSEL_RENDER_JS = os.path.join(MONTAJ_ROOT, "montaj_assets", "render", "render-carousel.js")
CAROUSEL_RENDER_TIMEOUT_S = 300
MAX_SLIDES = 12         # slides looked at (and tiles in the composite) per call
MAX_SLIDE_MEASURES = 20
COMPOSITE_W = 768
COMPOSITE_GUTTER = 4
COMPOSITE_LABEL_H = 18


def render_slides(project_path, numbers, out_dir):
    """Render the slides `numbers` (1-based) as the app's export does (render-carousel.js, 1x): ([(n, png)], [why])."""
    from cli.deps import render_runtime_dir
    from lib.common import node_child_env
    runtime = render_runtime_dir()
    cmd = ["node", os.path.join(runtime, "render-carousel.js"), "--project-json", project_path, "--out", out_dir,
           "--scale", "1", "--only", ",".join(str(n) for n in numbers)]
    r = _run_group_env(cmd, CAROUSEL_RENDER_TIMEOUT_S, node_child_env())
    if r is None:
        return [], ["the slides timed out"]
    made, why = [], []
    try:
        with open(os.path.join(out_dir, "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError):
        return [], ["the slides could not be rendered"]
    for s in manifest.get("slides") or []:
        p = os.path.join(out_dir, str(s.get("file")))
        if os.path.isfile(p):
            made.append((int(s["index"]), p))
    for f in manifest.get("failures") or []:
        why.append(f'slide {f.get("index")}: could not be rendered')
    return made, why


def _run_group_env(cmd, timeout, env):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True, env=env)
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out, err
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        proc.communicate()
        return None


def composite(pngs, out):
    """One grid of the slide images, COMPOSITE_W px wide in all, each tile labelled with its slide number."""
    from PIL import Image, ImageDraw
    n = len(pngs)
    cols = n if n <= 3 else 3 if n <= 6 else 4
    tile_w = (COMPOSITE_W - COMPOSITE_GUTTER * (cols + 1)) // cols
    tiles = []
    for num, p in pngs:
        with Image.open(p) as im:
            im = im.convert("RGB")
            tiles.append((num, im.resize((tile_w, max(1, round(im.height * tile_w / im.width))), Image.LANCZOS)))
    tile_h = max(t.height for _, t in tiles)
    rows = (n + cols - 1) // cols
    sheet_h = COMPOSITE_GUTTER + rows * (tile_h + COMPOSITE_LABEL_H + COMPOSITE_GUTTER)
    canvas = Image.new("RGB", (COMPOSITE_W, sheet_h), (24, 24, 24))
    draw = ImageDraw.Draw(canvas)
    for k, (num, t) in enumerate(tiles):
        r, c = divmod(k, cols)
        x = COMPOSITE_GUTTER + c * (tile_w + COMPOSITE_GUTTER) + (COMPOSITE_W - COMPOSITE_GUTTER - cols * (tile_w + COMPOSITE_GUTTER)) // 2
        y = COMPOSITE_GUTTER + r * (tile_h + COMPOSITE_LABEL_H + COMPOSITE_GUTTER)
        canvas.paste(t, (x, y))
        draw.text((x + 2, y + tile_h + 3), str(num), fill=(235, 235, 235))
    canvas.save(out)


def _slide_numbers(at, total):
    """The slides to look at: 1-based `at` numbers (sorted, no repeats), else every slide, at most MAX_SLIDES."""
    if not at:
        return list(range(1, min(total, MAX_SLIDES) + 1))
    nums = []
    for a in at:
        if float(a) != int(a) or not 1 <= int(a) <= total:
            fail("invalid_params", f"There is no slide {a:g}: this carousel has {total}.")
        if int(a) not in nums:
            nums.append(int(a))
    if len(nums) > MAX_SLIDES:
        fail("invalid_params", f"Look at {MAX_SLIDES} slides at most.")
    return sorted(nums)


def _text_overlays(slide):
    return [el for el in slide.get("elements") or []
            if isinstance(el, dict) and el.get("type") == "overlay" and isinstance(el.get("overlay"), dict)
            and isinstance(el["overlay"].get("props"), dict) and isinstance(el["overlay"].get("template"), str)]


def _quote(el):
    text = str(el["overlay"]["props"].get("text") or "")
    return f' "{text[:24]}"' if text else ""


def carousel_run(project_path, project, *, at, image, detail, measure_fn, render_fn, clock):
    """look on a carousel: each slide's text overlays measured once at their own box, checked for text off the slide,
    cut off or spilling out of its box, crossing other text, a slide with no image and a headline hard to read on its
    image. With image, one composite of the slides."""
    t0 = clock()
    project_dir = os.path.dirname(project_path)
    slides = [s for s in project.get("slides") or [] if isinstance(s, dict)]
    if not slides:
        fail("no_slides", "This carousel has no slides.")
    width, height = slide_check.slide_size(project)
    numbers = _slide_numbers(at, len(slides))
    samples = os.path.join(project_dir, "render", "samples")
    work = os.path.join(samples, "look")
    os.makedirs(work, exist_ok=True)
    issues = []

    def add(n, text):
        issues.append({"t": n, "id": "", "text": text})

    todo = []
    for n in numbers:
        s = slides[n - 1]
        if not any(isinstance(el, dict) and el.get("type") == "image" for el in s.get("elements") or []):
            add(n, "no image")
        for k, el in enumerate(_text_overlays(s)):
            try:
                float(el["x"]), float(el["y"]), float(el["w"]), float(el["h"])
            except (KeyError, TypeError, ValueError):
                continue
            if slide_check.box_ints(el) is None:
                continue
            todo.append((n, s, el, k))
    skipped = max(0, len(todo) - MAX_SLIDE_MEASURES)
    todo = todo[:MAX_SLIDE_MEASURES]

    def one(entry):
        n, s, el, k = entry
        m, why = slide_check.measure_element(measure_fn, el, os.path.join(work, slide_check.sample_name(n, el, k)))
        return n, s, el, m, why

    with ThreadPoolExecutor(max_workers=MEASURE_WORKERS) as pool:
        results = list(pool.map(one, todo))
    placed, checked = {}, 0
    for n, s, el, m, why in results:
        if m is None:
            add(n, f"text{_quote(el)}: {why}")
            continue
        checked += 1
        w, h = int(el["w"]), int(el["h"])
        ex, ey = float(el["x"]), float(el["y"])
        kinds = set()
        for text, b, outside, clipped in slide_check.text_in_box(m, w, h):
            quote = f' "{text}"' if text else ""
            on = {"x": ex + b["x"], "y": ey + b["y"], "w": b["w"], "h": b["h"]}
            placed.setdefault(n, []).append((_quote(el).strip(), on))
            if (on["x"] < -slide_check.OFF_PX or on["y"] < -slide_check.OFF_PX or on["x"] + on["w"] > width + slide_check.OFF_PX
                    or on["y"] + on["h"] > height + slide_check.OFF_PX):
                if "off" not in kinds:
                    kinds.add("off")
                    add(n, f"text{quote} runs off the slide")
            elif outside:
                if "box" not in kinds:
                    kinds.add("box")
                    add(n, f"text{quote} spills out of its box")
            elif clipped and "clip" not in kinds:
                kinds.add("clip")
                add(n, f"text{quote} is cut off by its box")
        if slide_text._is_headline(el) and slide_check.hard_to_read(s, el, project_dir):
            add(n, f"the headline{_quote(el)} is hard to read on its image")
    for n, boxes in placed.items():
        seen = set()
        for i, (la, a) in enumerate(boxes):
            for lb, b in boxes[i + 1:]:
                if lc._cross(a, b) and (la, lb) not in seen:
                    seen.add((la, lb))
                    add(n, f"text {la} overlaps {lb}")

    extra = {"slides": len(numbers), "overlays": checked}
    if skipped:
        extra["unmeasured"] = skipped
    if image:
        out = os.path.join(samples, f"look-slides-{hashlib.sha1(json.dumps([numbers, slides], sort_keys=True).encode()).hexdigest()[:8]}.png")
        # outside the project: concurrent looks never share it, a link in the project cannot redirect it, and the
        # manifest render-carousel writes never reaches the project's watcher
        render_dir = tempfile.mkdtemp(prefix="montaj-look-slides-")
        try:
            made, why = render_fn(project_path, numbers, render_dir)
            if made:
                for f in os.listdir(samples):
                    if f.startswith("look-slides-") and f.endswith(".png"):
                        os.remove(os.path.join(samples, f))
                composite(sorted(made), out)
                extra["sheet"] = out
            for w_ in why:
                issues.append({"t": int(re.match(r"slide (\d+)", w_).group(1)) if re.match(r"slide (\d+)", w_) else 0, "id": "",
                               "text": re.sub(r"^slide \d+: ", "", w_)})
            if not made and not why:
                add(0, "no slide could be rendered")
        finally:
            shutil.rmtree(render_dir, ignore_errors=True)
    answer = lc.answer(issues, extra=extra, cap=300,   # a carousel keeps its short answer (PL89g widened the video's)
                       line=lambda i: (f'slide {i["t"]}: ' if i["t"] else "") + i["text"])
    if detail:
        answer.update({"issues": [(f'slide {i["t"]}: ' if i["t"] else "") + i["text"] for i in sorted(issues, key=lambda x: x["t"])],
                       "shown": numbers, "wallMs": int((clock() - t0) * 1000)})
        answer.pop("more", None)
    return answer


def main():
    parser = argparse.ArgumentParser(description="Check a project in one call")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--at", type=float, action="append", default=None, help="Look at this timeline second")
    parser.add_argument("--image", action="store_true", help="Also make one contact sheet of the times")
    parser.add_argument("--detail", action="store_true", help="Also answer every fact")
    args = parser.parse_args()
    project_path = os.path.abspath(args.project)
    if not os.path.isfile(project_path):
        fail("not_found", f"Project not found: {project_path}")
    print(json.dumps(run(project_path, at=args.at, image=args.image, detail=args.detail)))


if __name__ == "__main__":
    main()
