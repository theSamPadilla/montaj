"""Whisper's broken stretches, transcribed again (§577, ucla clip B).

Over a long take with many retakes whisper keeps its TEXT in order but can lose its TIMES over a stretch: words
collapsed to no length, a phrase stretched over seconds of silence, the next sentence's words standing on the sound of
the one before (8 s off on the real file). No placement can mend that: a retake rule then removes the words that stand
on another sentence's sound, and that sentence goes with them. So, per source, before any placement:

1. `stretches` finds the broken stretches on layer 1 (lib/speech_energy.layer1):
   - a seed is ZERO_RUN or more words in a row each under ZERO_S long and all within ZERO_S of each other (collapsed
     to one instant), or SILENT_RUN or more words in a row with no voiced frame in their spans, together over
     SILENT_SPAN_S of the source;
   - a seed grows over the bad words beside it (under ZERO_S, no voiced frame, or STRETCH_S longer than their text:
     LETTER_S a letter plus WORD_BASE_S), so the stretch runs from the last good word before it to the first good
     word after it (the source's start or end when there is none);
   - its window is the time between those good words, and it is broken only when that window holds MIN_VOICED_S of
     voiced audio (layer 1's voiced runs; a made-up tail over the room has none, and is left to the tail rule).
2. `repair` transcribes a broken window again, with NEIGHBOURS good words each side, in ONE whisper run over its voiced
   runs (a trim spec with each as a keep, so its times come back on the source's clock), the same call cut uses for a
   clip with no transcript, and merges the words in without losing one (see `repair`). Every other word is left as
   whisper wrote it. Nothing is written beside the clip: the new words live in the cut's memory, and in a 0700 cache
   under the temp folder, keyed under the stamp and pruned after CACHE_DAYS, so the apply reads the plan's words; the
   refiner's stamp carries a digest of them, so a plan and an apply that read different words never match. A window
   whisper cannot transcribe again (no model, a failure, no words, or words that do not read as speech, as over
   music) leaves the stretch as it was, and the plan's answer names it.

3. `_extend`, once per repaired stretch: words still in silence after it (its kept words, and runs of two or more just
   before it) whose sound lies past the window, under a later saying's words (the first run's labels there are the
   wrong words, on sound, so no stretch shows), are looked for in one more whisper run over the voiced runs from the
   window's end, at most EXTEND_S on, up to an anchor (ANCHOR_WORDS heard where the first run put them), and merged
   the same way; the answer names it, found or not.

The cost is one whisper run per broken window (its voiced runs, a few seconds of audio each, and its neighbours'),
only where a stretch is broken, and at most one more per repaired stretch (its extension); a source with none costs
the search only.
"""
import hashlib
import json
import os
import tempfile
from dataclasses import replace

from lib.speech_lines import Word, norm

ZERO_S = 0.03            # a word this short is collapsed (whisper's zero-length words)
ZERO_RUN = 3             # ... and this many of them in a row seed a broken stretch
SILENT_RUN = 3           # this many words in a row with no voiced frame in their spans ...
SILENT_SPAN_S = 2.0      # ... spanning this much of the source, seed one too
STRETCH_S = 1.0          # a word this much longer than its text is stretched (a bad word beside a seed)
LETTER_S = 0.09          # (lib/speech_energy's: a word's expected length is LETTER_S a letter plus WORD_BASE_S)
WORD_BASE_S = 0.2
MIN_VOICED_S = 0.3       # a broken window holds this much voiced audio, or it is left alone
RUN_PAD_S = 0.1          # each voiced run is transcribed with this much of the room either side (whisper's context)
NEIGHBOURS = 3           # the merge reaches this many good words each side of a stretch (their times drift too)
MIN_MATCH = 2            # inside a stretch, a match of fewer words in a row is chance ('the'), not the same words
EXTEND_S = 20.0          # after a repair, a run left in silence is looked for this far past the repaired window ...
LOOKBACK = 12            # ... among the words this far before the repaired words, or the repair's own kept words
ANCHOR_WORDS = 3         # ... up to an anchor: this many words in a row the second run hears where the first put them
ANCHOR_S = 0.3           # ... (each within this of its first-run start)
CACHE_DAYS = 3           # a cached second run older than this is removed when the cache is written
VERSION = "speech-repair v5"
_STAMPED = ("ZERO_S", "ZERO_RUN", "SILENT_RUN", "SILENT_SPAN_S", "STRETCH_S", "MIN_VOICED_S", "RUN_PAD_S",
            "NEIGHBOURS", "MIN_MATCH", "EXTEND_S", "LOOKBACK", "ANCHOR_WORDS", "ANCHOR_S")
STAMP = VERSION + " " + " ".join(f"{k}={globals()[k]}" for k in _STAMPED)
_EPS = 1e-6


def _letters(text):
    return sum(1 for c in text if c.isalnum())


def _voiced(lay, w):
    """Whether word w's whisper span holds a voiced frame of layer 1."""
    if not lay.env:
        return False
    frame = 0.01
    a = max(0, int(w.start / frame + 1e-9))
    b = min(len(lay.flat), max(a + 1, int(-(-w.end // frame))))
    return any(not lay.flat[k] for k in range(a, b))


def _bad(lay, w):
    dur = w.end - w.start
    return (dur < ZERO_S - _EPS or not _voiced(lay, w)
            or dur > LETTER_S * _letters(w.text) + WORD_BASE_S + STRETCH_S + _EPS)


def stretches(words, lay):
    """[(first word, end word, window start, window end)] of the broken stretches of a source (see the module
    docstring), in order."""
    n = len(words)
    if not n or not lay.env:
        return []
    zero = [w.end - w.start < ZERO_S - _EPS for w in words]
    silent = [not _voiced(lay, w) for w in words]
    seeds = []
    for flags, need in ((zero, ZERO_RUN), (silent, SILENT_RUN)):
        i = 0
        while i < n:
            if not flags[i]:
                i += 1
                continue
            j = i
            while j < n and flags[j]:
                j += 1
            if flags is zero:
                # collapsed: the run's words all at one instant (short tokens said in a row, '1 2 3', are not)
                q = i
                while q + need <= j:
                    if words[q + need - 1].end - words[q].start < ZERO_S - _EPS:
                        seeds.append((i, j))
                        break
                    q += 1
            elif j - i >= need and words[j - 1].end - words[i].start >= SILENT_SPAN_S - _EPS:
                seeds.append((i, j))
            i = j
    out = []
    for i, j in sorted(seeds):
        while i > 0 and _bad(lay, words[i - 1]):
            i -= 1
        while j < n and _bad(lay, words[j]):
            j += 1
        if out and i <= out[-1][1]:
            i = out.pop()[0]
        out.append((i, j))
    res = []
    for i, j in out:
        t0 = words[i - 1].end if i > 0 else 0.0
        t1 = words[j].start if j < n else lay.end
        runs = _runs(lay, t0, t1)
        if sum(b - a for a, b in runs) >= MIN_VOICED_S - _EPS:
            res.append((i, j, t0, t1))
    return res


def _runs(lay, t0, t1):
    """Layer 1's voiced runs clipped to [t0, t1]."""
    return [(max(a, t0), min(b, t1)) for a, b in lay.voiced if min(b, t1) - max(a, t0) > _EPS]


def _cache_key(media, keeps, tag):
    try:
        st = os.stat(media)
        ident = f"{os.path.abspath(media)}|{st.st_size}|{st.st_mtime_ns}"
    except OSError:
        ident = os.path.abspath(media)
    spans = ",".join(f"{a:.3f}-{b:.3f}" for a, b in keeps)
    return hashlib.sha256(f"{ident}|{spans}|{tag}|{STAMP}".encode()).hexdigest()[:32]


def _cache_folder():
    """This user's cache folder under the temp folder, made 0700 and refused when it is not a real folder of theirs
    (a link or another user's), keyed under the stamp. None when there is none to use."""
    uid = os.getuid() if hasattr(os, "getuid") else 0
    root = os.path.join(tempfile.gettempdir(), f"montaj-cut-repair-{uid}")
    folder = os.path.join(root, hashlib.sha256(STAMP.encode()).hexdigest()[:12])
    try:
        for d in (root, folder):
            os.makedirs(d, mode=0o700, exist_ok=True)
            st = os.lstat(d)
            if not os.path.isdir(d) or os.path.islink(d) or (hasattr(os, "getuid") and st.st_uid != uid):
                return None
            os.chmod(d, 0o700)
    except OSError:
        return None
    return folder


def _valid(got):
    """A second run's words: a list of (text, start, end), text a str and the times numbers; else None."""
    if not isinstance(got, list):
        return None
    out = []
    for x in got:
        if not (isinstance(x, (list, tuple)) and len(x) == 3 and isinstance(x[0], str)
                and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in x[1:])):
            return None
        out.append((x[0], float(x[1]), float(x[2])))
    return out


def _prune(folder):
    import time
    cutoff = time.time() - CACHE_DAYS * 86400
    try:
        for name in os.listdir(folder):
            path = os.path.join(folder, name)
            if name.endswith(".json") and os.path.getmtime(path) < cutoff:
                os.unlink(path)
    except OSError:
        pass


def _cached(media, keeps, tag, run):
    """run(media, keeps) -> [(text, start, end)] or None (one whisper run for the window's voiced runs), cached so
    the apply reads the plan's words (the stamp still tells them apart: lib/speech_energy.Refiner.stamp)."""
    folder = _cache_folder()
    path = os.path.join(folder, _cache_key(media, keeps, tag) + ".json") if folder else None
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                got = _valid(json.load(f))
            if got is not None:
                return got
        except (OSError, ValueError):
            pass
    try:
        got = _valid(run(media, keeps))
    except Exception as e:                   # noqa: BLE001 (a failed second run leaves the stretch as written)
        try:
            run.last_error = f"{type(e).__name__}: {e}"[:200]
        except AttributeError:
            pass
        return None
    if got and path:
        try:
            _prune(folder)
            fd, tmp = tempfile.mkstemp(dir=folder, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump([list(x) for x in got], f)
            os.replace(tmp, path)
        except OSError:
            pass
    return got


def _speech_like(new, lay):
    """The second run's words read as speech: not made up (lib/speech_units.made_up: too long, or too many of no
    length, as over music), and most of them on voiced frames."""
    from lib.speech_units import made_up
    if made_up([{"text": t, "start": s, "end": e} for t, s, e in new]):
        return False
    on = sum(1 for t, s, e in new if _voiced(lay, Word(0, t, norm(t), s, max(e, s + 0.01))))
    return on >= 0.5 * len(new)


def _no_lone_matches(ops):
    """The aligner's opcodes with a match of under MIN_MATCH words read as no match (§577, ucla B88: 'the' of one
    sentence matched 'the' of another, so the first run's words were kept in the middle of the new sentence, and a
    neighbour's chance match made the new words before it look like that neighbour heard twice), joined with the
    blocks beside it."""
    out = []
    for op, a0, a1, b0, b1 in ops:
        if op == "equal" and a1 - a0 < MIN_MATCH:
            op = "replace"
        if out and op != "equal" and out[-1][0] != "equal":
            p = out.pop()
            out.append(("replace", p[1], a1, p[3], b1))
        else:
            out.append((op, a0, a1, b0, b1))
    return out


def _merge(old, fresh, left_n, right0, mark, adds=True):
    """(merged, matched, added, kept): first-run words `old` merged with the second run's `fresh` (see `repair`);
    old positions under left_n are the left neighbours, from right0 the right ones; a kept first-run-only word gets
    idx `mark`. adds False: no word only the second run heard is added (the extension only re-times first-run words:
    a whisper loop in its second run would add a copy of words said once, a false sure retake, review B3)."""
    from difflib import SequenceMatcher
    nb = set(range(0, left_n)) | set(range(right0, len(old)))          # positions of the neighbours in `old`
    segs = []
    sm = SequenceMatcher(None, [w.norm for w in old], [w.norm for w in fresh], autojunk=False)
    n_match = n_add = n_keep = 0
    for op, a0, a1, b0, b1 in _no_lone_matches(sm.get_opcodes()):
        if op == "equal":
            segs.append(("equal", [replace(fresh[b], text=old[a].text) for a, b in zip(range(a0, a1),
                                                                                     range(b0, b1))],
                         [old[a].norm for a in range(a0, a1)], a0 >= right0))
            n_match += a1 - a0
            continue
        # a word only the second run heard among the neighbours (or past them) is a neighbour heard twice: never
        # added; the neighbours only take new times
        if a1 > a0:
            among = all(a in nb for a in range(a0, a1))
        else:
            among = (a0 == 0 and left_n > 0) or (a0 == len(old) and right0 < len(old)) or (a0 - 1 in nb and a0 in nb)
        add = [] if among or not adds else fresh[b0:b1]
        # a neighbour the second run did not hear keeps its place and its time
        left = [old[a] for a in range(a0, a1) if a < left_n]
        right = [old[a] for a in range(a0, a1) if a >= right0]
        keep = [replace(old[a], idx=mark) for a in range(a0, a1) if left_n <= a < right0]
        n_add += len(add)
        n_keep += len(keep)
        for kind_, ws, tail in (("nb", left, False), ("other", add, False), ("kept", keep, False),
                                ("nb", right, True)):
            if ws:
                segs.append((kind_, ws, [w.norm for w in ws] if kind_ == "kept" else [], tail))
    # whisper's loop: a kept block that repeats the matched words right before it goes before that copy (the one
    # with no sound is then the earlier saying, and a retake rule keeps the real one)
    q = 1
    while q < len(segs):
        kind_, ws, ns, _ = segs[q]
        pk, pws, pns, ptail = segs[q - 1]
        if kind_ == "kept" and pk == "equal" and len(ns) <= len(pns) and pns[len(pns) - len(ns):] == ns:
            cut_at = len(pws) - len(ns)
            segs[q - 1:q + 1] = [("equal", pws[:cut_at], pns[:cut_at], ptail), ("loop", ws, ns, False),
                                 ("equal", pws[cut_at:], pns[cut_at:], ptail)]
            q += 2
        q += 1
    # every other word only the first run wrote goes after all the new words, before the right neighbours: its
    # sound is not in the window (whisper's times run early over a broken stretch), and its first-run place
    # inside the new sentence is no place (§577, ucla B88: 'to even walk around the actual' with 'even walk
    # around' collapsed to no length on one instant)
    n_tail = 0
    while n_tail < len(segs) and segs[len(segs) - 1 - n_tail][3]:
        n_tail += 1
    body, tail = segs[:len(segs) - n_tail], segs[len(segs) - n_tail:]
    segs = [x for x in body if x[0] != "kept"] + [x for x in body if x[0] == "kept"] + tail
    return [w for _, ws, _, _ in segs for w in ws], n_match, n_add, n_keep


def repair(words, lay, media, retranscribe, tag=""):
    """(words, report): each broken stretch, with NEIGHBOURS good words each side, merged with whisper's words for its
    window's voiced runs, all of a window's runs in one whisper run (retranscribe(media, keeps) -> [(text, start,
    end)] on the source's clock, or None), every word numbered again in order. The merge never loses a word: the two
    texts are aligned word for word (lib's norm); a matched word takes the new word's time; a word only the second run
    heard is added (never beside a neighbour: those only take new times); a word only the first run wrote is kept,
    after all the stretch's new words (whisper's times run early over a broken stretch: its sound lies later, and its
    place among the new words is no place), or before the matched words it repeats (whisper's loop: the copy with no
    sound is the earlier saying, so a retake rule keeps the real one). report: [{"words": (first, end) old indexes, "window": (t0, t1), "runs": n, "new": n,
    "matched": n, "added": n, "kept": n}], with "error" for a window whose second run failed or heard no speech (its
    words are left as they were). A kept first-run-only word's new index is in its own stretch's "phantom"."""
    from difflib import SequenceMatcher
    found = stretches(words, lay)
    if not found or retranscribe is None:
        return list(words), []
    n_all = len(words)
    out, report, k = [], [], 0
    for i, j, t0, t1 in found:
        # the neighbours: up to NEIGHBOURS good words each side, never into the stretch before or after
        i2 = max(k, i - NEIGHBOURS)
        nxt = next((x[0] for x in found if x[0] >= j), n_all)
        j2 = min(nxt, j + NEIGHBOURS)
        w0 = words[i2].start if i2 < i else t0
        w1 = words[j2 - 1].end if j2 > j else t1
        runs = _runs(lay, min(w0, t0), max(w1, t1))
        keeps = [(round(max(min(w0, t0), a - RUN_PAD_S), 3), round(min(max(w1, t1), b + RUN_PAD_S), 3))
                 for a, b in runs]
        merged_keeps = []
        for a, b in keeps:
            if merged_keeps and a <= merged_keeps[-1][1] + _EPS:
                merged_keeps[-1] = (merged_keeps[-1][0], max(merged_keeps[-1][1], b))
            else:
                merged_keeps.append((a, b))
        entry = {"words": (i, j), "window": (round(t0, 2), round(t1, 2)), "runs": len(merged_keeps)}
        got = _cached(media, merged_keeps, tag, retranscribe) if merged_keeps else None
        new = [(t, s, max(s, e)) for t, s, e in (got or []) if norm(t)
               and any(a - _EPS <= (s + e) / 2 <= b + _EPS for a, b in merged_keeps)]
        entry["new"] = len(new)
        if not new or not _speech_like(new, lay):
            entry["error"] = (getattr(retranscribe, "last_error", None) or "no words") if not new \
                else "it does not read as speech (music?)"
            report.append(entry)
            continue
        old = words[i2:j2]
        fresh = [Word(-1, t.strip(), norm(t), round(s, 3), round(e, 3)) for t, s, e in new]
        merged, n_match, n_add, n_keep = _merge(old, fresh, i - i2, j - i2, -2 - len(report))
        at = len(out) + (i2 - k)
        entry["at"] = (at, at + len(merged))
        entry.update(matched=n_match, added=n_add, kept=n_keep)
        report.append(entry)
        out += words[k:i2] + merged
        k = j2
    out += words[k:]
    if not any("error" not in r for r in report):
        return list(words), report
    # in order, and numbered again (a word the merge placed takes no time before the word before it)
    fixed, prev = [], 0.0
    for r in report:
        r["phantom"] = []
    for n, w in enumerate(out):
        s = max(w.start, prev) if w.idx < 0 else w.start
        if w.idx <= -2:                      # a kept first-run-only word of stretch report[-idx - 2]
            report[-w.idx - 2]["phantom"].append(n)
        fixed.append(replace(w, idx=n, start=round(s, 3), end=round(max(s, w.end), 3)))
        prev = max(prev, fixed[-1].end)
    return _extend(fixed, report, lay, media, retranscribe, tag), report


def _keeps_of(lay, t0, t1):
    keeps = []
    for a, b in _runs(lay, t0, t1):
        a, b = round(max(t0, a - RUN_PAD_S), 3), round(min(t1, b + RUN_PAD_S), 3)
        if keeps and a <= keeps[-1][1] + _EPS:
            keeps[-1] = (keeps[-1][0], max(keeps[-1][1], b))
        else:
            keeps.append((a, b))
    return keeps


def _extend(words, report, lay, media, retranscribe, tag):
    """§577 (ucla B, real3 v9): after a repair, words can still sit in silence while their sound is past the repaired
    window, under a later saying's words (the first run's labels there are the WRONG words, on sound, so no stretch
    shows). Per repaired stretch, once: its kept words and the words up to LOOKBACK before it that sit in silence, in
    runs of two or more, are looked for in ONE more whisper run over the voiced runs from the window's end, at most
    EXTEND_S on (never into the next repaired window). When the second run hears two or more of them in a row, and
    then an ANCHOR (ANCHOR_WORDS in a row heard where the first run put them, within ANCHOR_S), every word up to the
    anchor is merged as a stretch is (lossless, MIN_MATCH, phantoms; but no word only the second run heard is added: it
    only re-times first-run words, review B3), and the silent runs take their real sound. With
    no such anchor (the first run's times off by seconds over the whole window: ucla B), the whole window is merged
    when the second run hears ANCHOR_WORDS more of the first run's words after the silent ones, in order (its new
    words after the last match left out). Else nothing moves. The report's "extension" names each one: {"from", "to", and "moved", "matched", "added", "kept"
    or "error"}."""
    from difflib import SequenceMatcher
    starts = sorted(r["window"][0] for r in report)
    changes, taken = [], set()
    for ri, r in enumerate(report):
        if "error" in r or "at" not in r:
            continue
        f0t = r["window"][1]
        f1t = min([t for t in starts if t > f0t + _EPS] + [f0t + EXTEND_S, lay.end])
        keeps = _keeps_of(lay, f0t, f1t)
        a0, a1 = r["at"]
        phantom = set(r.get("phantom", ()))
        silent = [n for n in range(max(0, a0 - LOOKBACK), min(a1, len(words)))
                  if n in phantom or not _voiced(lay, words[n])]
        cand, run_ = [], []
        for n in silent + [None]:
            if run_ and (n is None or n != run_[-1] + 1):
                if len(run_) >= 2:
                    cand += run_
                run_ = []
            if n is not None:
                run_.append(n)
        # every word the first run (or the repair) put past the window's end, in order: the repair's own right
        # neighbours and the words it placed there too
        cset = set(cand)
        oldf = [n for n in range(max(0, a0 - LOOKBACK), len(words))
                if n not in cset and f0t - _EPS <= words[n].start < f1t]
        if not cand or not keeps or not oldf:
            continue
        ext = r["extension"] = {"from": round(f0t, 2), "to": round(f1t, 2)}
        got = _cached(media, keeps, tag, retranscribe)
        new = [(t, s, max(s, e)) for t, s, e in (got or []) if norm(t)
               and any(a - _EPS <= (s + e) / 2 <= b + _EPS for a, b in keeps)]
        if not new or not _speech_like(new, lay):
            ext["error"] = (getattr(retranscribe, "last_error", None) or "no words") if not new \
                else "it does not read as speech (music?)"
            continue
        # in the order the words stand (the repair's order), the silent runs among them
        order = sorted(set(cand) | set(oldf))
        old = [words[n] for n in order]
        is_c = [n in cset for n in order]
        fresh = [Word(-1, t.strip(), norm(t), round(s, 3), round(e, 3)) for t, s, e in new]
        ops = _no_lone_matches(SequenceMatcher(None, [w.norm for w in old], [w.norm for w in fresh],
                                               autojunk=False).get_opcodes())
        pairs = [(x, y) for op, x0, x1, y0, y1 in ops if op == "equal" for x, y in zip(range(x0, x1), range(y0, y1))]
        heard = [p_ for p_ in pairs if is_c[p_[0]]]
        anchor, streak = None, []
        for x, y in pairs:
            ok = bool(heard) and x > heard[0][0] and not is_c[x] and abs(old[x].start - fresh[y].start) <= ANCHOR_S
            if ok and streak and (x, y) == (streak[-1][0] + 1, streak[-1][1] + 1):
                streak.append((x, y))
            else:
                streak = [(x, y)] if ok else []
            if len(streak) >= ANCHOR_WORDS:
                anchor = streak[0]
                break
        if not heard:
            ext["error"] = "the words left in silence are not heard there"
            continue
        if anchor is None:
            # no word heard where the first run put it (whisper's times are off by seconds over the whole window,
            # ucla B): the whole window, when the second run hears ANCHOR_WORDS more of the first run's words after
            # the silent ones, in order; its new words after the last match are left out (they may be the words
            # past the window, heard twice)
            after = [p_ for p_ in pairs if p_[0] > heard[0][0] and not is_c[p_[0]]]
            if len(after) < ANCHOR_WORDS:
                ext["error"] = f"no anchor within {EXTEND_S:g} s"
                continue
            anchor = (len(order), pairs[-1][1] + 1)
            ext["anchor"] = "window"
        else:
            ext["anchor"] = "words"
        region = order[:anchor[0]]
        if set(region) & taken:
            ext["error"] = "overlaps another extension"
            continue
        taken |= set(region)
        merged, m, ad, kp = _merge(old[:anchor[0]], fresh[:anchor[1]], 0, anchor[0], -2 - ri, adds=False)
        ext.update(moved=len(cand), matched=m, added=ad, kept=kp)
        # the merged words go where the first word past the window stood (the silent runs move there)
        past = [n for n in region if n not in cset]
        changes.append((region, merged, min(past) if past else order[min(anchor[0], len(order) - 1)]))
    if not changes:
        return words
    drop, at = set(), {}
    for region, merged, where in changes:
        drop |= set(region)
        at[where] = merged
    out = []
    for n, w in enumerate(words):
        if n in at:
            out += at[n]
        if n not in drop:
            out.append(w)
    # in order, numbered again, and each stretch's phantoms named again in the new numbering
    old_ph = {n: ri for ri, r in enumerate(report) for n in r.get("phantom", ())}
    for r in report:
        r["phantom"] = []
    fixed, prev = [], 0.0
    for n, w in enumerate(out):
        s = max(w.start, prev) if w.idx < 0 else w.start
        if w.idx <= -2:
            report[-w.idx - 2]["phantom"].append(n)
        elif w.idx >= 0 and w.idx in old_ph:
            report[old_ph[w.idx]]["phantom"].append(n)
        fixed.append(replace(w, idx=n, start=round(s, 3), end=round(max(s, w.end), 3)))
        prev = max(prev, fixed[-1].end)
    return fixed
