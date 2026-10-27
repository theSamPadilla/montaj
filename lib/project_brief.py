"""The project brief (PL89, Sam 2026-10-26): what the AI needs for its first decisions on a pending project, in one read.

Measured on kung fu run 3: the AI spent 18 turns and 37 calls (82 KB, 10 images, 774K tokens of cache reads) finding
what this answers at once: which sources are talking heads and which b-roll, every take's words with their times, which
takes say which script line, where the b-roll's moments are, the workflow's steps and the profile's style. A turn
re-reads the whole context, so this is complete on purpose: nothing the first decisions need is left for another call.

`brief(project, project_dir)` -> {"text", "sheets": [png], "skills": [skill names the steps use], "stamp"}. Cached in
render/brief/ under a stamp of everything it reads, so a second read is free. Line ids are speech_lines' (A1, B2...),
the ids cut's plan uses.
"""
import hashlib
import json
import os
import re
import subprocess

from lib import shots as shots_lib
from lib.common import ffprobe_bin, ff_path
from lib.speech_lines import load_words, norm, refine, sidecar_for, split_lines
from lib.speech_units import hardly_speech, made_up

BRIEF_VERSION = 2
LONG_BROLL_S = 20.0          # b-roll at least this long gets its shots listed and a sheet
PROFILE_SECTIONS = ("Titles & overlays", "Format")
LOOKED = ("probe", "snapshot")   # steps whose answer the brief already holds   # the style profile's sections that bear on the edit
_HDR = ("arib-std-b67", "smpte2084")


def _probe(path):
    """(fps, transfer) of the first video stream, or (None, None)."""
    try:
        r = subprocess.run([ffprobe_bin(), "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=avg_frame_rate,color_transfer", "-of", "json", ff_path(path)],
                           capture_output=True, text=True, timeout=30)
        s = (json.loads(r.stdout).get("streams") or [{}])[0]
        a, b = (s.get("avg_frame_rate") or "0/1").split("/")
        fps = float(a) / float(b) if float(b) else None
        return (round(fps, 2) if fps else None), s.get("color_transfer")
    except (OSError, ValueError, subprocess.SubprocessError, ZeroDivisionError):
        return None, None


def _silences(path):
    from lib.speech_pauses import silences
    return silences(path)


def _stat(path):
    try:
        st = os.stat(path)
        return [st.st_size, int(st.st_mtime)]
    except OSError:
        return None


def _abs(path, project_dir):
    return path if not path or os.path.isabs(path) else os.path.join(project_dir, path)


def _sources(project, project_dir):
    out = []
    for s in project.get("sources") or []:
        if isinstance(s, dict) and s.get("src"):
            s = dict(s)
            s["src"] = _abs(s["src"], project_dir)
            if s.get("proxySrc"):
                s["proxySrc"] = _abs(s["proxySrc"], project_dir)
            out.append(s)
    return out


def _stamp(project, project_dir, montaj_root):
    """Everything the brief reads: the prompt, workflow, profile, timeline's size, and each source and sidecar's size
    and mtime."""
    parts = {"v": BRIEF_VERSION, "prompt": project.get("editingPrompt"), "workflow": project.get("workflow"),
             "profile": project.get("profileSnapshot"), "status": project.get("status"),
             "items": sum(len(t.get("items") or []) for t in project.get("tracks") or [] if isinstance(t, dict))}
    for s in _sources(project, project_dir):
        sc = sidecar_for(s)
        parts[s["id"] if s.get("id") else s["src"]] = [s["src"], _stat(s["src"]), sc and _stat(sc),
                                                       _stat(shots_lib.sidecar_path(s["src"]))]
    from lib.workflow import resolve_workflow_path
    wf = resolve_workflow_path(project.get("workflow"), montaj_root) if project.get("workflow") else None
    parts["wf"] = [wf, wf and _stat(wf)]
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:16]


def _script(prompt):
    """[("section", name) | ("line", text)] of the editing prompt's script: the part before a "-----" line, `<...>`
    lines as sections, the rest split into sentences."""
    script = re.split(r"\n-{3,}\s*\n", prompt or "", maxsplit=1)[0]
    out = []
    for raw in script.splitlines():
        raw = raw.strip()
        if not raw or re.match(r"(?i)^edit this video", raw):
            continue
        m = re.fullmatch(r"<(.+)>", raw)
        if m:
            out.append(("section", m.group(1).strip()))
            continue
        out += [("line", s.strip()) for s in re.split(r"(?<=[.!?])\s+", raw) if s.strip()]
    return out


def _pairs(words):
    return {(a, b) for a, b in zip(words, words[1:])}


def _said_by(script_lines, takes):
    """{script line index: [transcript line ids]}: a transcript line goes to the script line it shares the most word
    pairs with (2 at least), and to any other it says a quarter of, so retakes, partial and reworded sayings land on
    their line."""
    sp = [_pairs([norm(t) for t in text.split() if norm(t)]) for text in script_lines]
    out = {i: [] for i in range(len(script_lines))}
    if not sp:
        return out
    for letter, lines in takes:
        for ln in lines:
            lp = _pairs([w.norm for w in ln.words])
            best = max(range(len(sp)), key=lambda i: (len(lp & sp[i]), -i))
            for i, pairs in enumerate(sp):
                n = len(lp & pairs)
                if (i == best and n >= 2) or (n >= 1 and n >= 0.25 * len(pairs)):
                    out[i].append(ln.id)
    return out


def _profile_text(project):
    snap = project.get("profileSnapshot") or {}
    pref = snap.get("preferences") or {}
    out = []
    bits = [f"captions `{pref['captionStyle']}`" if pref.get("captionStyle") else None,
            f"font {pref['fontFamily']}" if pref.get("fontFamily") else None,
            f"palette {', '.join(pref['palette'])}" if pref.get("palette") else None,
            *(f"{k} {pref[k]}" for k in ("primaryColor", "secondaryColor", "accentColor") if pref.get(k))]
    if pref.get("name") or any(bits):
        out.append(f"{pref.get('name') or snap.get('name') or 'Profile'}: " + ", ".join(b for b in bits if b) + ".")
    path = snap.get("styleProfilePath")
    try:
        text = open(path, encoding="utf-8").read() if path else ""
    except OSError:
        text = ""
    m = re.search(r"(?m)^style_summary:\s*(.+)$", text)
    if m:
        out.append(f"Style: {m.group(1).strip()}")
    for name in PROFILE_SECTIONS:
        m = re.search(rf"(?ms)^## {re.escape(name)}\s*\n(.*?)(?=^## |\Z)", text)
        if m and m.group(1).strip():
            out += ["", f"**{name}** (the profile's notes)", m.group(1).strip()]
    return out


def _status_line(project):
    items = sum(len(t.get("items") or []) for t in project.get("tracks") or [] if isinstance(t, dict))
    wf = project.get("workflow")
    head = f"Status {project.get('status') or 'unknown'}" + (f", workflow **{wf}**" if wf else "") + "."
    if items == 0:
        return head + " The timeline is empty: the sources below are the footage. Start with cut (Steps below): it builds the talking-head spine from the takes you pick."
    return head + f" The timeline holds {items} items laid by Montaj before you, not an edit: cut rebuilds the spine from the plan."


def build(project, project_dir, montaj_root, *, probe_fn=None, silences_fn=None, shots_fn=None, sheet_fn=None):
    """The brief's text, sheets and skills, computed (no cache)."""
    probe_fn = probe_fn or _probe
    silences_fn = silences_fn or _silences
    shots_fn = shots_fn or (lambda src, scan: shots_lib.shots_for(src, scan_path=scan)["shots"])
    sheet_fn = sheet_fn or (lambda src, shots, out, scan: shots_lib.sheet(src, shots, out, scan_path=scan))
    W = []
    W.append(f"# {project.get('name') or project.get('id') or 'Project'}")
    W.append(_status_line(project))
    W.append("This brief is everything the first decisions need, in full: no other read is needed to start.")
    W.append("")

    # sources and their roles (cut's own speech test)
    heads, rolls, rows = [], [], []
    for s in _sources(project, project_dir):
        sc = sidecar_for(s)
        words = load_words(sc) if sc else []
        dur = float(s.get("sourceDuration") or 0)
        raw = [{"text": w.text, "start": w.start, "end": w.end} for w in words]
        talk = bool(words) and not hardly_speech(raw, dur or (words[-1].end if words else 0)) and not made_up(raw)
        fps, trc = probe_fn(s["src"])
        pic = (f"{s['sourceWidth']}x{s['sourceHeight']}" if s.get("sourceWidth") else "")
        pic += " HDR" if trc in _HDR else ""
        if talk:
            letter = chr(ord("A") + len(heads)) if len(heads) < 26 else f"S{len(heads)}"
            media = s.get("proxySrc") or s["src"]
            refined, _ = refine(words, silences_fn(media))
            heads.append((s, letter, split_lines(letter, refined)))
            role = f"talking head {letter}"
        else:
            rolls.append(s)
            role = "b-roll" + (" (no speech)" if words else "")
        rows.append(f"| {s.get('id', '')} | {os.path.basename(s['src'])} | {role} | {dur:.1f} s | {fps or '?'} | {pic.strip()} |")
    W += ["## Sources", "| id | file | role | length | fps | picture |", "|---|---|---|---|---|---|", *rows, ""]

    # script -> takes
    script = _script(project.get("editingPrompt"))
    lines = [t for k, t in script if k == "line"]
    says = {}   # transcript line id -> the script lines it says (numbers from 1)
    if lines and heads:
        said = _said_by(lines, [(letter, lns) for _, letter, lns in heads])
        for i, ids in said.items():
            for lid in ids:
                says.setdefault(lid, []).append(i + 1)
        W += ["## Script → takes",
              "Each script line and the transcript lines (below) that say it, in recording order: retakes and partial "
              "sayings included, so the last one listed is usually the last full saying. \"not recorded as written\": "
              "find it in the transcripts by meaning. This is a pointer, not a choice: the takes are yours to pick.", ""]
        k = 0
        for kind, text in script:
            if kind == "section":
                W.append(f"**<{text}>**")
                continue
            ids = said[k]
            k += 1
            W.append(f"{k}. {text} → " + (", ".join(ids) if ids else "not recorded as written"))
        W.append("")

    # every take's words
    if heads:
        W += ["## Talking-head transcripts",
              "Every line of every take in recording order: its id, its seconds in that source, the words said. "
              "Retakes, false starts and asides are all here; lines break where the speaker paused. The words are "
              "Whisper's; a line that says a script line carries the script's words after ⟶, which are the ones to "
              "caption and spell by.", ""]
        for s, letter, lns in heads:
            W.append(f"**{letter} = {os.path.basename(s['src'])}** ({s.get('id', '')})")
            for ln in lns:
                row = f"- {ln.id} {ln.words[0].start:.1f}-{ln.words[-1].end:.1f} {' '.join(w.text for w in ln.words)}"
                for n in says.get(ln.id, []):   # the script's own words, so a name Whisper misheard is not retyped
                    row += f" ⟶ script {n}: \"{lines[n - 1]}\""
                W.append(row)
            W.append("")

    # b-roll shots
    sheets = []
    long_rolls = [s for s in rolls if float(s.get("sourceDuration") or 0) >= LONG_BROLL_S]
    if rolls:
        W.append("## B-roll")
        for s in rolls:
            dur = float(s.get("sourceDuration") or 0)
            if s not in long_rolls:
                W.append(f"**{s.get('id', '')} {os.path.basename(s['src'])}**, {dur:.1f} s: one shot.")
                continue
            scan = s.get("proxySrc") or s["src"]
            try:
                shots = shots_fn(s["src"], scan) or []
            except Exception:  # noqa: BLE001: no shots, the brief still answers
                shots = []
            if not shots:
                W.append(f"**{s.get('id', '')} {os.path.basename(s['src'])}**, {dur:.1f} s: its shots could not be found.")
                continue
            out = os.path.join(project_dir, "render", "brief", f"shots-{s.get('id') or len(sheets)}.png")
            try:
                os.makedirs(os.path.dirname(out), exist_ok=True)
                sheets.append(sheet_fn(s["src"], shots, out, scan))
                seen = " The sheet with this brief shows each shot at its middle, numbered."
            except Exception:  # noqa: BLE001
                seen = ""
            W.append(f"**{s.get('id', '')} {os.path.basename(s['src'])}**, {dur:.1f} s, {len(shots)} shots (seconds in "
                     f"the source).{seen}")
            W += [f"- {sh['n']}: {sh['start']:.1f}-{sh['end']:.1f}" + (f" {sh['label']}" if sh.get("label") else "")
                  for sh in shots]
            W.append(f"Add b-roll by shot: edit_timeline {{op: \"add\", item: {{source: \"{s.get('id', '')}\", shot: n, "
                     "start}}, which takes the shot's span; for a closer look at a moment, snapshot the clip.")
            bare = sum(1 for sh in shots if not sh.get("label"))
            if bare:
                W.append(f"{bare} of its shots have no label yet: name them once with `shots` (labels) and every later "
                         "read shows them.")
        W.append("")

    # steps
    skills = []
    try:
        from lib.workflow import read_workflow
        wf = read_workflow(project.get("workflow"), montaj_root) if project.get("workflow") else None
    except Exception:  # noqa: BLE001
        wf = None
    if wf and wf.get("steps"):
        W.append("## Steps, in order")
        looked = [str(st.get("uses") or "").split("/")[-1] for st in wf["steps"]]
        looked = [u for u in looked if u in LOOKED]
        if looked:   # what these steps show is above: run 3 spent six snapshots on it
            W.append(f"({' and '.join(dict.fromkeys(looked))}: this brief covers them with the sources, transcripts and "
                     "b-roll sheet above, so the first step is the one numbered 1.)")
        i = 0
        for st in wf["steps"]:
            uses = str(st.get("uses") or "").split("/")[-1]
            if uses and uses not in skills:
                skills.append(uses)
            if uses in LOOKED:
                continue
            i += 1
            note = st.get("note") or f"its guide is the {uses} skill in the Recipe below"
            params = st.get("params")
            W.append(f"{i}. **{st.get('id')}** ({uses})" + (f" with {json.dumps(params)}" if params else "") + f": {note}")
        W.append("")

    prof = _profile_text(project)
    if prof:
        W += ["## Profile", *prof, ""]
    return {"text": "\n".join(W).rstrip() + "\n", "sheets": sheets, "skills": skills}


def brief(project, project_dir, montaj_root, **fns):
    """`build`, cached in render/brief/brief.json under `_stamp` (a later read of an unchanged project is free)."""
    stamp = _stamp(project, project_dir, montaj_root)
    cache = os.path.join(project_dir, "render", "brief", "brief.json")
    try:
        with open(cache, encoding="utf-8") as f:
            got = json.load(f)
        if got.get("stamp") == stamp and all(os.path.isfile(p) for p in got.get("sheets") or []):
            return got
    except (OSError, ValueError):
        pass
    got = {**build(project, project_dir, montaj_root, **fns), "stamp": stamp}
    try:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        tmp = cache + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(got, f)
        os.replace(tmp, cache)
    except OSError:
        pass
    return got
