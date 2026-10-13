"""Caption word times fitted to the audio's pauses. Captions only, never cuts.

whisper's word times are unreliable around a pause. Measured on real talking-head
speech (7 clips, the app's large-v3-turbo):
  - the word after a pause starts within 2 frames of the audio onset in only 9 of 21
    pauses, and words are gapless, so a pause never shows as a gap;
  - whole words land inside silences: early ones at a clip's start ("But often at a
    cost" across 1.7 s of silence), late ones before a pause ("...become more |
    dexterous." with "dexterous." timed inside the pause that follows it).

So the pauses come from the audio (speech_pauses.silences, a threshold per source),
and between them are speech regions. Each word is given to one region and each
region's words are mapped linearly onto it: whisper's order and relative timing
are kept, both ends sit on the audio. With no pause found (music under the speech,
a noisy room) the words come back unchanged.

Which region a word belongs to:
  - the one holding most of the word's time; a zero-length word, the one its time
    falls in; a word wholly inside a pause, the speech after it;
  - except around a pause where a nearby word ends a phrase (punctuation) and starts
    before speech resumes: the pause falls after the last such word. whisper times a
    pause's last words late, inside the pause, and the punctuation says where the
    phrase ended. Checked against whisper run on each region alone: the first and
    last words agree in 18 of 22 regions with this rule, 11 of 22 without it, and
    two of the four left are the same words spelled differently.
  - regions never go backwards in word order.

Never whisper DTW for this: it is late on speech (median +0.16 s, measured).
"""
import re

MIN_PAUSE_S = 0.2     # shorter silences sit inside speech (stops, breaths)
MERGE_GAP_S = 0.1     # silences closer than this are one pause
NEAR_S = 0.3          # how far before a pause a phrase-final word is looked for
RESUME_MARGIN_S = 0.1  # a phrase-final word must start this long before speech resumes
_PHRASE_END = re.compile(r"[.,!?;:…][\"'”’)\]]*$")


def caption_pauses(silences, duration):
    """`silences` [(start, end)] in seconds -> pauses of at least MIN_PAUSE_S within
    [0, duration], merged when less than MERGE_GAP_S apart. Sorted."""
    merged = []
    for a, b in sorted((max(0.0, a), min(duration, b)) for a, b in silences):
        if b <= a:
            continue
        if merged and a - merged[-1][1] < MERGE_GAP_S:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged if b - a >= MIN_PAUSE_S]


def speech_regions(pauses, duration):
    """The stretches of [0, duration] between `pauses`."""
    out, t = [], 0.0
    for a, b in pauses:
        if a > t:
            out.append((t, a))
        t = max(t, b)
    if t < duration:
        out.append((t, duration))
    return out


def _has_text(text):
    return any(ch.isalnum() for ch in text or "")


def assign_regions(words, pauses, duration):
    """For `words` [{"text", "start", "end"}] in seconds, in order: the index into
    speech_regions(pauses, duration) each word belongs to (rules in the module doc)."""
    regions = speech_regions(pauses, duration)
    if not regions:
        return [0] * len(words)
    out = []
    for w in words:
        overlap = [max(0.0, min(w["end"], b) - max(w["start"], a)) for a, b in regions]
        mid = (w["start"] + w["end"]) / 2
        if max(overlap) > 0:
            r = overlap.index(max(overlap))
        else:
            r = next((i for i, (a, b) in enumerate(regions) if a <= mid <= b), None)
            if r is None:  # wholly inside a pause: the speech after it, else the last region
                r = next((i for i, (a, b) in enumerate(regions) if a >= mid), len(regions) - 1)
        out.append(r)
    for s0, s1 in pauses:
        after = next((i for i, (a, b) in enumerate(regions) if a >= s1 - 1e-6), None)
        if not after:  # no speech after it, or none before it
            continue
        near = [i for i, w in enumerate(words) if w["end"] > s0 - NEAR_S and w["start"] < s1]
        ends = [i for i in near if _PHRASE_END.search(words[i]["text"].strip())
                and words[i]["start"] <= s1 - RESUME_MARGIN_S]
        if not ends:
            continue
        for i in near:
            out[i] = after - 1 if i <= ends[-1] else after
    for i in range(1, len(out)):
        out[i] = max(out[i], out[i - 1])
    return out


def fit_words(words, pauses, duration):
    """`words` [{"text", "start", "end"}] in seconds -> new dicts with start/end fitted
    to the speech regions. Same count and order; never mutates the input."""
    out = [dict(w) for w in words]
    regions = speech_regions(pauses, duration)
    if not pauses or not regions or not words:
        return out
    assign = assign_regions(words, pauses, duration)
    for r, (a, b) in enumerate(regions):
        idx = [i for i, x in enumerate(assign) if x == r]
        if not idx:
            continue
        o0, o1 = words[idx[0]]["start"], words[idx[-1]]["end"]
        if o1 - o0 > 1e-6:
            scale = (b - a) / (o1 - o0)
            for i in idx:
                out[i]["start"] = a + (words[i]["start"] - o0) * scale
                out[i]["end"] = a + (words[i]["end"] - o0) * scale
        else:  # no span to map: share the region by letters
            weights = [max(1, sum(ch.isalnum() for ch in words[i]["text"])) for i in idx]
            t = a
            for i, wt in zip(idx, weights):
                out[i]["start"] = t
                t += (b - a) * wt / sum(weights)
                out[i]["end"] = t
    return out


def fit_transcription(entries, pauses, duration):
    """whisper.cpp `transcription` entries (offsets in ms) -> new entries with the
    offsets of every word fitted. Entries without letters or digits keep their place:
    they take the end of the word before them. Never mutates the input."""
    out = [dict(e, offsets=dict(e.get("offsets", {}))) for e in entries]
    idx = [i for i, e in enumerate(out)
           if _has_text(e.get("text")) and "from" in e["offsets"] and "to" in e["offsets"]]
    words = [{"text": out[i]["text"], "start": out[i]["offsets"]["from"] / 1000.0,
              "end": out[i]["offsets"]["to"] / 1000.0} for i in idx]
    fitted = fit_words(words, pauses, duration)
    for i, w in zip(idx, fitted):
        out[i]["offsets"]["from"] = int(round(w["start"] * 1000))
        out[i]["offsets"]["to"] = max(out[i]["offsets"]["from"], int(round(w["end"] * 1000)))
    last = 0
    for e in out:
        o = e["offsets"]
        if _has_text(e.get("text")) and "to" in o:
            last = o["to"]
        elif "from" in o and "to" in o:
            o["from"] = o["to"] = last
    return out
