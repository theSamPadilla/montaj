#!/usr/bin/env python3
"""place (§558): one overlay on the timeline in one call, at seconds or at a spoken phrase.

- `at`: seconds, or {phrase, take}. A phrase is found by lib/phrase_at.py (the speech track's sentences and the take
  rules cut uses); a clip of the speech track with no transcript is transcribed first, the transcript written
  beside the clip as cut writes it (lib/speech_units.transcribe_missing), never over a file.
- The overlay: a JSX file in the project folder, or a preset (montaj_assets/render/templates/presets) copied into
  the project's overlays/ under its own name, never over a different file (a `-2`, `-3`... name instead).
- The write: tracks only, through lib/project_lock.update_project_or_fail (under the project lock, which also
  checks a Studio sync clash). The tracks as read are compared under the lock (project_revisions.revision_of): any
  change since, a human edit or another step's, refuses `project_changed` and writes nothing. A new item goes on
  the given track, else the first overlay track free over its span, else a new track; `id` moves or updates that
  item alone, on its own track unless `track` names another.
- Self-check: the placed overlay measured once (look's sample_overlay --measure) at the middle of its span, for
  text off the frame and the safe areas (lib/look_check.py), plus a span past the footage.
Prints one short JSON: {id, start, end, track, take?, issues?}.
"""
import argparse, json, os, secrets, shutil, sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import look_check as lc, phrase_at, project_revisions, speech_units, sync_clash, write_places  # noqa: E402
from lib.common import fail, DEFAULT_WHISPER_MODEL  # noqa: E402
from lib.project_lock import update_project_or_fail  # noqa: E402
from lib.project_tracks import normalize_tracks  # noqa: E402
from steps.render import look as look_step  # noqa: E402
from steps.speech.transcribe import transcribe as transcribe_file  # noqa: E402

PRESETS_DIR = os.path.join(MONTAJ_ROOT, "montaj_assets", "render", "templates", "presets")
PRESETS = {"lower_third": "lower-third.jsx", "callout": "callout.jsx"}
DEFAULT_FOR_S = 3.0
STEP_LOCK_TIMEOUT = 30.0


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def parse_at(raw):
    """seconds (float), or {phrase, take}: (seconds or None, phrase or None, take)."""
    if raw is None:
        return None, None, None
    if isinstance(raw, (int, float)):
        return float(raw), None, None
    text = str(raw).strip()
    try:
        return float(text), None, None
    except ValueError:
        pass
    try:
        v = json.loads(text)
    except ValueError:
        fail("invalid_at", 'at is timeline seconds or {"phrase": "...", "take": "clean"}.')
    if isinstance(v, (int, float)):
        return float(v), None, None
    if not isinstance(v, dict) or not isinstance(v.get("phrase"), str) or not v["phrase"].strip():
        fail("invalid_at", 'at is timeline seconds or {"phrase": "...", "take": "clean"}.')
    take = v.get("take", "clean")
    if take not in phrase_at.TAKES:
        fail("invalid_at", f"take is one of {', '.join(phrase_at.TAKES)}.")
    return None, v["phrase"].strip(), take


def parse_props(raw):
    if raw is None or raw == "":
        return {}
    try:
        v = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        fail("invalid_props", "props is a JSON object.")
    if not isinstance(v, dict):
        fail("invalid_props", "props is a JSON object.")
    return v


def find_item(project, item_id):
    for ti, t in enumerate(project["tracks"]):
        for k, it in enumerate(t.get("items", [])):
            if it.get("id") == item_id:
                return ti, k, it
    return None


def _overlaps(items, s, e, skip=None):
    return [it for it in items if it is not skip and lc._num(it.get("start")) < e - 1e-3 and s < lc._num(it.get("end")) - 1e-3]


def choose_track(project, s, e, want=None, skip=None):
    """(track index or None for a new track, refusal text or None)."""
    tracks = project["tracks"]
    if want:
        for ti, t in enumerate(tracks):
            if t.get("id") == want:
                if ti == 0:
                    return None, "track is the footage track: overlays go on tracks[1+]"
                clash = _overlaps(t.get("items", []), s, e, skip)
                if clash:
                    return None, f"overlaps {clash[0].get('id')} on track {want}"
                return ti, None
        return None, f"no track {want}"
    for ti, t in enumerate(tracks):
        if ti == 0:
            continue
        items = t.get("items", [])
        if all(it.get("type") == "overlay" for it in items) and not _overlaps(items, s, e, skip):
            return ti, None
    return None, None


def preset_file(project_dir, preset):
    """The preset copied into the project's overlays/: its project-relative path. Never over a different file."""
    src = os.path.join(PRESETS_DIR, PRESETS[preset])
    with open(src, "rb") as f:
        body = f.read()
    stem, ext = os.path.splitext(PRESETS[preset])
    overlays = os.path.join(project_dir, "overlays")
    os.makedirs(overlays, exist_ok=True)
    n = 1
    while True:
        name = f"{stem}{ext}" if n == 1 else f"{stem}-{n}{ext}"
        dest = os.path.join(overlays, name)
        if os.path.isfile(dest):
            with open(dest, "rb") as f:
                if f.read() == body:
                    return f"overlays/{name}", False
        elif not os.path.lexists(dest):
            try:
                fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            except FileExistsError:
                n += 1
                continue
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            return f"overlays/{name}", True
        n += 1


def overlay_src(project_dir, path):
    """A JSX file in the project folder as the item's src (./ relative), or a refusal."""
    p = path if os.path.isabs(path) else os.path.join(project_dir, path)
    if not os.path.isfile(p):
        fail("overlay_not_found", f"No overlay file at {path}. Write it with write_project_overlay first.")
    if not write_places.within(write_places.real(p), write_places.real(project_dir)):
        fail("overlay_outside_project", "The overlay file must be in the project folder.")
    rel = os.path.relpath(os.path.realpath(p), os.path.realpath(project_dir)).replace(os.sep, "/")
    return "./" + rel


def _new_id(project):
    taken = {it.get("id") for t in project["tracks"] for it in t.get("items", [])}
    while True:
        cand = f"ov-{secrets.token_hex(3)}"
        if cand not in taken:
            return cand


def resolve_time(project, project_path, project_dir, at_s, phrase, take, language, model, transcribe):
    """(start seconds, the take used or None, issues, detail)."""
    if phrase is None:
        return at_s, None, [], {}
    track_id = speech_units.speech_track_id(project, project_dir)
    _, _, warnings = speech_units.transcribe_missing(project, track_id, project_path, project_dir, model, language, transcribe)
    try:
        found = phrase_at.find(project, project_dir, phrase, take, language, track_id)
    except phrase_at.PhraseNotFound as e:
        fail("phrase_not_found", str(e))
    issues = [{"t": lc.r2(found.start), "id": "phrase", "text": found.fallback}] if found.fallback else []
    issues += [{"t": 0.0, "id": "speech", "text": w} for w in (warnings + found.warnings)[:3]]
    return found.start, found.take, issues, {"said": found.text, "sayings": found.said}


def run(project_path, *, at=None, for_s=None, until=None, overlay=None, preset=None, props=None, track=None,
        item_id=None, language="en", model=DEFAULT_WHISPER_MODEL, detail=False,
        measure_fn=look_step.measure, transcribe=None):
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    if transcribe is None:
        transcribe = transcribe_file
    if overlay and preset:
        fail("invalid_params", "Pass overlay or preset, not both.")
    if preset and preset not in PRESETS:
        fail("invalid_params", f"preset is one of {', '.join(PRESETS)}.")
    at_s, phrase, take = parse_at(at)
    extra_props = parse_props(props)
    on_disk = _load(project_path)
    read_rev = project_revisions.revision_of(on_disk.get("tracks"))
    project = normalize_tracks(on_disk)
    existing = find_item(project, item_id) if item_id else None
    if item_id and existing is None:
        fail("item_not_found", f"No item {item_id} on the timeline.")
    if existing and existing[2].get("type") != "overlay":
        fail("not_an_overlay", f"{item_id} is a {existing[2].get('type')} item, not an overlay.")
    if not existing and at is None:
        fail("invalid_params", "at is required to add an overlay.")
    if not existing and not overlay and not preset:
        fail("invalid_params", "Pass overlay (a JSX file in the project) or preset.")

    start, take_used, issues, more = (None, None, [], {})
    if at is not None:
        start, take_used, issues, more = resolve_time(project, project_path, project_dir, at_s, phrase, take, language, model, transcribe)
    old = existing[2] if existing else None
    if start is None:
        start = lc._num(old.get("start"))
    start = max(0.0, start)
    if until is not None:
        end = float(until)
    elif for_s is not None:
        end = start + float(for_s)
    elif old is not None:
        end = start + (lc._num(old.get("end")) - lc._num(old.get("start")))
    else:
        end = start + DEFAULT_FOR_S
    if end <= start:
        fail("invalid_span", "The overlay ends before it starts.")
    footage = lc.base_end(project)
    if footage > 0 and start >= footage:
        fail("invalid_span", f"{lc.r2(start)}s is past the end of the footage ({lc.r2(footage)}s).")
    if footage > 0 and end > footage + 1e-3:
        issues.append({"t": lc.r2(footage), "id": "span", "text": f"shortened to the footage end ({lc.r2(footage)}s)"})
        end = footage

    width, height = lc.design_size(project)
    src, made = None, False
    if preset:
        src_rel = PRESETS[preset]
        try:
            sync_clash.check_step_document(on_disk, on_disk, files=[f"overlays/{src_rel}"])
        except sync_clash.SyncConflict as e:
            sync_clash.exit_refused(e.body)
        rel, made = preset_file(project_dir, preset)
        src = "./" + rel
    elif overlay:
        src = overlay_src(project_dir, overlay)

    written = {}

    def apply(fresh):
        if project_revisions.revision_of(fresh.get("tracks")) != read_rev:
            fail("project_changed", "The tracks changed since place read them (an edit in the editor or another step). "
                                    "Run place again.")
        doc = normalize_tracks(fresh)
        tracks = doc["tracks"]
        if existing:
            hit = find_item(doc, item_id)
            ti, k, item = hit
            item = dict(item)
            skip = tracks[ti]["items"][k]
        else:
            ti, item, skip = None, {"id": _new_id(doc), "type": "overlay"}, None
        item["start"], item["end"] = round(start, 3), round(end, 3)
        if src:
            item["src"] = src
        new_props = dict(item.get("props") or {})
        new_props.update(extra_props)
        if preset:
            new_props.setdefault("canvasW", str(width))
            new_props.setdefault("canvasH", str(height))
        if new_props:
            item["props"] = new_props
        dest = ti
        if not existing or (track and track != tracks[ti].get("id")) or _overlaps(tracks[ti]["items"], start, end, skip):
            dest, refusal = choose_track(doc, start, end, track, skip)
            if refusal:
                fail("track_busy" if "overlaps" in refusal else "invalid_track", f"Not placed: {refusal}.")
        if existing and dest != ti:
            tracks[ti]["items"] = [it for it in tracks[ti]["items"] if it is not skip]
        if dest is None:
            taken = {t.get("id") for t in tracks}
            tid = next(f"ovl-{n}" for n in range(1, 1000) if f"ovl-{n}" not in taken)
            tracks.append({"id": tid, "items": []})
            dest = len(tracks) - 1
        items = [it for it in tracks[dest]["items"] if it is not skip]
        items.append(item)
        items.sort(key=lambda it: lc._num(it.get("start")))
        tracks[dest]["items"] = items
        written.update(item=item, track=tracks[dest]["id"])
        fresh["tracks"] = tracks
        return fresh

    try:
        update_project_or_fail(project_path, apply, fail, timeout=STEP_LOCK_TIMEOUT)
    except BaseException:
        if made:   # the preset file this call made is not left behind by a refused write
            try:
                os.unlink(os.path.join(project_dir, src[2:]))
            except OSError:
                pass
        raise

    item = written["item"]
    mid = (item["start"] + item["end"]) / 2
    fps = look_step._fps(project)
    path = lc.overlay_path(item, project_dir)
    samples = os.path.join(project_dir, "render", "samples", "look")
    os.makedirs(samples, exist_ok=True)
    frame, duration = int(round((mid - item["start"]) * fps)), max(1, int(round((item["end"] - item["start"]) * fps)))
    m, why = measure_fn(item, path, frame, duration, fps, width, height, os.path.join(samples, f"{item['id']}-f{frame}.png"))
    if m is None:
        issues.append({"t": lc.r2(mid), "id": item["id"], "text": why})
    else:
        issues += lc.measured_issues(item, m, width, height, mid, item["id"])
    out = {"id": item["id"], "start": item["start"], "end": item["end"], "track": written["track"]}
    if take_used:
        out["take"] = take_used
    if issues:
        short = lc.answer(issues, 0, 0, extra=out)
        out["issues"] = short["issues"]
        if short.get("more"):
            out["more"] = short["more"]
    if detail:
        out.update({"src": item.get("src"), **more,
                    "issues": [f'{i["t"]}s {i["id"]}: {i["text"]}' for i in issues],
                    "text": [t for t, _, _ in lc.text_boxes(m, item, width, height)] if m else []})
        out.pop("more", None)
    return out


def main():
    parser = argparse.ArgumentParser(description="Place one overlay at seconds or at a spoken phrase")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--at", default=None, help='Timeline seconds, or {"phrase": ..., "take": ...}')
    parser.add_argument("--for", dest="for_s", type=float, default=None, help="Seconds on screen")
    parser.add_argument("--until", type=float, default=None, help="Timeline seconds it ends at")
    parser.add_argument("--overlay", default=None, help="A JSX file in the project folder")
    parser.add_argument("--preset", default=None, help="lower_third or callout")
    parser.add_argument("--props", default=None, help="Props as a JSON object")
    parser.add_argument("--track", default=None, help="The overlay track id")
    parser.add_argument("--id", dest="item_id", default=None, help="Move or update this overlay item")
    parser.add_argument("--language", default="en", help="The speaker's language code")
    parser.add_argument("--detail", action="store_true", help="Also answer every fact")
    args = parser.parse_args()
    project_path = os.path.abspath(args.project)
    if not os.path.isfile(project_path):
        fail("not_found", f"Project not found: {project_path}")
    print(json.dumps(run(project_path, at=args.at, for_s=args.for_s, until=args.until, overlay=args.overlay,
                         preset=args.preset, props=args.props, track=args.track, item_id=args.item_id,
                         language=args.language or "en", detail=args.detail)))


if __name__ == "__main__":
    main()
