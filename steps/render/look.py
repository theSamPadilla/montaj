#!/usr/bin/env python3
"""look (§558): one read-only check of a project, answered in a short JSON (lib/look_check.py has the rules).

Measures each overlay once (sample_overlay --measure, the existing Puppeteer path) at the middle of its span, at
most MAX_MEASURES overlays, MEASURE_WORKERS at a time, those on screen at the picked times first; with --image, one
contact_sheet of at most IMAGE_TIMES of those times. The text answer checks the project's data and the overlays it
measured: it renders no frame. Writes nothing in project.json; the measure PNGs and the sheet go under
render/samples.
"""
import argparse, hashlib, json, os, signal, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import look_check as lc  # noqa: E402
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


def run(project_path, at=None, image=False, detail=False, measure_fn=measure, sheet_fn=sheet, clock=time.monotonic):
    t0 = clock()
    project_dir = os.path.dirname(project_path)
    try:
        with open(project_path, encoding="utf-8") as f:
            project = normalize_tracks(json.load(f))
    except (OSError, ValueError):
        fail("not_found", f"Project not readable: {project_path}")
    width, height = lc.design_size(project)
    fps = _fps(project)
    times = lc.pick_times(project, at, cap=IMAGE_TIMES if image and not at else lc.MAX_TIMES)
    issues = lc.data_issues(project, project_dir)
    to_measure, unmeasured = overlays_to_measure(project, project_dir, times)
    samples = os.path.join(project_dir, "render", "samples", "look")
    os.makedirs(samples, exist_ok=True)

    def one(entry):
        ti, it, path = entry
        s, e = lc._num(it.get("start")), lc._num(it.get("end"))
        mid = (s + e) / 2
        frame, duration = int(round((mid - s) * fps)), max(1, int(round((e - s) * fps)))
        label = lc._label(it, ti)
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)[:40]
        m, why = measure_fn(it, path, frame, duration, fps, width, height, os.path.join(samples, f"{safe}-f{frame}.png"))
        return ti, it, label, s, e, mid, m, why

    with ThreadPoolExecutor(max_workers=MEASURE_WORKERS) as pool:
        results = list(pool.map(one, to_measure))
    placed, checked, notes = [], [], []
    for ti, it, label, s, e, mid, m, why in results:
        if m is None:
            issues.append({"t": lc.r2(mid), "id": label, "text": why})
            continue
        bands = lc.caption_bands(project, s, e, width, height)
        issues += lc.measured_issues(it, m, width, height, mid, label, bands)
        placed.append((label, s, e, [b for _, b, _, _ in lc.text_boxes(m, it, width, height)]))
        checked.append(label)
        if it.get("keyframes"):
            notes.append(f"{label}: keyframed geometry read at its base values")
    issues += lc.text_overlaps(placed)
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
