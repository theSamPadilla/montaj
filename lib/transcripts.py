"""The one transcript reader (PL89 run 5, Sam 2026-10-26): every talking-head source's lines, refined on its measured
silences, with the ids cut's plan and the brief use (A1, D7...), and what plays on the timeline now in timeline seconds.

`talking_heads(project, project_dir)` -> [(source, letter, [Line])]: the sources whose transcript reads as speech
(cut's own test: lib/speech_units hardly_speech and made_up over the whole source), lettered in the sources' order.
Each source's refined lines are cached in render/transcripts/ under a stamp of its file and sidecar, so only a changed
transcript is measured again.
`on_timeline(project, project_dir, heads)` -> [{item, track, start, end, src, lines, words}]: each unmuted timeline
item's words (a word belongs to an item when its midpoint lies in [inPoint, outPoint), at start + (t - inPoint) / speed,
as lib/speech_words_at maps them), in timeline order.
"""
import hashlib
import json
import os
import re

from lib.speech_lines import Line, Word, load_words, refine, sidecar_for, split_lines
from lib.speech_units import hardly_speech, made_up

VERSION = 1


def _silences(path):
    from lib.speech_pauses import silences
    return silences(path)


def _abs(path, project_dir):
    return path if not path or os.path.isabs(path) else os.path.join(project_dir, path)


def _stat(path):
    try:
        st = os.stat(path)
        return [st.st_size, int(st.st_mtime)]
    except OSError:
        return None


def sources(project, project_dir):
    """The project's sources with absolute src and proxySrc."""
    out = []
    for s in project.get("sources") or []:
        if isinstance(s, dict) and s.get("src"):
            s = dict(s)
            s["src"] = _abs(s["src"], project_dir)
            if s.get("proxySrc"):
                s["proxySrc"] = _abs(s["proxySrc"], project_dir)
            out.append(s)
    return out


def is_speech(source, words):
    """Whether a source's transcript reads as speech over the whole source (cut's test)."""
    if not words:
        return False
    raw = [{"text": w.text, "start": w.start, "end": w.end} for w in words]
    span = float(source.get("sourceDuration") or 0) or words[-1].end
    return not hardly_speech(raw, span) and not made_up(raw)


def _cache_path(project_dir, source):
    key = re.sub(r"[^A-Za-z0-9_.-]", "_", str(source.get("id") or os.path.basename(source["src"])))
    return os.path.join(project_dir, "render", "transcripts", f"{key}.json")


def _refined(project_dir, source, sidecar, words, silences_fn):
    """The source's refined words, from the cache when its file and sidecar are unchanged."""
    media = source.get("proxySrc") or source["src"]
    stamp = hashlib.sha1(json.dumps([VERSION, source["src"], _stat(source["src"]), sidecar, _stat(sidecar), media,
                                     _stat(media)]).encode()).hexdigest()[:16]
    path = _cache_path(project_dir, source)
    try:
        with open(path, encoding="utf-8") as f:
            got = json.load(f)
        if got.get("stamp") == stamp:
            return [Word(*w) for w in got["words"]]
    except (OSError, ValueError, TypeError):
        pass
    refined, _ = refine(words, silences_fn(media))
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"stamp": stamp, "words": [[w.idx, w.text, w.norm, w.start, w.end] for w in refined]}, f)
        os.replace(tmp, path)
    except OSError:
        pass
    return refined


def talking_heads(project, project_dir, silences_fn=None):
    """[(source, letter, [Line])] of the talking-head sources, lettered A, B... in the sources' order."""
    silences_fn = silences_fn or _silences
    heads = []
    for s in sources(project, project_dir):
        sc = sidecar_for(s)
        words = load_words(sc) if sc else []
        if not is_speech(s, words):
            continue
        letter = chr(ord("A") + len(heads)) if len(heads) < 26 else f"S{len(heads)}"
        heads.append((s, letter, split_lines(letter, _refined(project_dir, s, sc, words, silences_fn))))
    return heads


def _speed(item):
    try:
        v = float(item.get("speed") or 1.0)
        return v if v > 0 else 1.0
    except (TypeError, ValueError):
        return 1.0


def on_timeline(project, project_dir, heads):
    """Each unmuted timeline item that plays a talking head's words: {item, track, start, end, src, lines, words}, the
    words [text, start, end] in timeline seconds, ordered by start."""
    by_src = {os.path.realpath(s["src"]): lns for s, _, lns in heads}
    out = []
    for t in project.get("tracks") or []:
        if not isinstance(t, dict) or t.get("muted") or t.get("enabled") is False:
            continue
        for it in t.get("items") or []:
            if not isinstance(it, dict) or it.get("muted") or not it.get("src"):
                continue
            lns = by_src.get(os.path.realpath(_abs(it["src"], project_dir)))
            if not lns:
                continue
            start, end = float(it.get("start") or 0), float(it.get("end") or 0)
            a = float(it.get("inPoint") or 0)
            b = float(it["outPoint"]) if it.get("outPoint") is not None else a + (end - start) * _speed(it)
            sp = _speed(it)
            words, ids = [], []
            for ln in lns:
                for w in ln.words:
                    if a <= (w.start + w.end) / 2 < b:
                        t0 = min(end, start + (w.start - a) / sp)
                        t1 = min(end, start + (w.end - a) / sp)
                        words.append([w.text, round(t0, 3), round(t1, 3)])
                        if ln.id not in ids:
                            ids.append(ln.id)
            if words:
                out.append({"item": it.get("id"), "track": t.get("id"), "start": start, "end": end,
                            "src": it["src"], "lines": ids, "words": words})
    return sorted(out, key=lambda x: (x["start"], str(x["track"])))


def as_text(project, project_dir, heads, letters=None):
    """The talking heads' lines as text (only `letters` when given), and the sources with no speech named once."""
    out = []
    for s, letter, lns in heads:
        if letters is not None and letter not in letters:
            continue
        out.append(f"**{letter} = {os.path.basename(s['src'])}** ({s.get('id', '')})")
        out += [f"- {ln.id} {ln.words[0].start:.1f}-{ln.words[-1].end:.1f} {' '.join(w.text for w in ln.words)}" for ln in lns]
        out.append("")
    if letters is None:
        quiet = [s for s in sources(project, project_dir) if not any(s["src"] == h[0]["src"] for h in heads)]
        if quiet:
            out.append("No speech (b-roll): " + ", ".join(f"{s.get('id', '')} {os.path.basename(s['src'])}" for s in quiet) + ".")
    return "\n".join(out).rstrip() + "\n"


def timeline_text(entries):
    """The timeline's spoken lines: `- start-end item (line ids, track): words`, in timeline seconds."""
    if not entries:
        return "Nothing on the timeline plays a talking head's words.\n"
    return "\n".join(f"- {x['start']:.1f}-{x['end']:.1f} {x['item']} ({', '.join(x['lines'])}, {x['track']}): "
                     f"{' '.join(w[0] for w in x['words'])}" for x in entries) + "\n"
