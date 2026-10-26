"""Spell caption words from the person's script: lay the script's words onto the transcript's timings.

`align(heard, script) -> (words, corrected)`. `heard` is the transcript's words in order ({"word", "start", "end", ...}),
`script` the text the person wrote. The two are aligned word by word on a loose key (case, punctuation and accents
aside), and the timings always come from `heard`:
- a word in both takes the script's spelling (its case and punctuation): not counted as a correction;
- a run of heard words the transcriber got wrong ("uni 3", "dense", "dance") takes the script's words when the two read
  or sound alike (their letters, numbers read as words, at least MATCH_RATIO alike, or their consonant skeletons at least
  SOUND_RATIO; each side at most RUN_WORDS words): the script's words share the run's time, one to one when the counts
  agree, else in proportion to their length. Sound alone judges one word against one word. Never an inflection (one a
  prefix of the other: "protect" stays when the script says "protecting") or a run with an apostrophe in it ("it is"
  stays when the script says "it's"): the speaker said those;
- a heard word said twice where the script has it once ("a a") is one word over both timings;
- any other heard word stays as heard (the speaker said it), and script words never said are not added.
`corrected` counts the words whose spelling changed beyond case and punctuation (and the stutters merged).
Pure: never mutates `heard`.
"""
import copy
import json
import re
import unicodedata
from difflib import SequenceMatcher

# A run the transcriber got wrong is at most this many words on each side, and must read this much alike.
RUN_WORDS = 4
MATCH_RATIO = 0.8
# Or sound this much alike (their consonant skeletons): "dance" for "dents".
SOUND_RATIO = 0.8
# A stretch where the two disagree is searched for a mishearing only up to this many (heard x script) words.
MAX_PAIRS = 1600
# Shorter than this on both sides is too little to judge by letters ("a" against "at").
MIN_LETTERS = 3

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
         "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def _key(word) -> str:
    """The word without case, accents, punctuation or apostrophes: what two spellings of one word share."""
    s = unicodedata.normalize("NFKD", str(word)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", s)


def _spoken(key: str) -> str:
    """A key with its numbers read as words (for the fuzzy match only): "uni3" reads as "unithree"."""
    def say(m):
        n = int(m.group())
        if n < 20:
            return _ONES[n]
        if n < 100:
            return _TENS[n // 10] + (_ONES[n % 10] if n % 10 else "")
        return m.group()
    return re.sub(r"\d+", say, key)


def _tokens(script):
    """The script's words as written (split on white space; a word with no letter or digit is dropped)."""
    return [t for t in str(script or "").split() if _key(t)]


def _skeleton(key: str) -> str:
    """How a key sounds, roughly: its first letter, then its consonants (c as s before e, i or y, else k; h, w and y
    dropped), doubles collapsed. "dance" and "dense" are both "dns", "dents" is "dnts"."""
    if not key:
        return ""
    k = re.sub(r"c(?=[eiy])", "s", key)
    k = k.replace("ph", "f").replace("ck", "k").replace("q", "k").replace("x", "ks").replace("c", "k")
    body = re.sub(r"[aeiouhwy]", "", k[1:])
    return re.sub(r"(.)\1+", r"\1", k[0] + body)


def _alike(a: str, b: str, sound: bool = True) -> float:
    """How alike two runs read (0..1), 0 for what is not a mishearing: too short to judge, one a prefix of the other (an
    inflection the speaker said: "protect" for "protecting", "car" for "cars"), or letters and sound both apart."""
    if a == b:
        return 1.0   # one word written as two, or two as one: "kung fu" for "kung-fu"
    if min(len(a), len(b)) < MIN_LETTERS or a.startswith(b) or b.startswith(a):
        return 0.0
    letters = SequenceMatcher(None, a, b, autojunk=False).ratio()
    if letters >= MATCH_RATIO:
        return letters
    if not sound:   # sound alone judges one word against one word only
        return 0.0
    sa, sb = _skeleton(a), _skeleton(b)
    if min(len(sa), len(sb)) >= MIN_LETTERS and SequenceMatcher(None, sa, sb, autojunk=False).ratio() >= SOUND_RATIO:
        return MATCH_RATIO
    return 0.0


def _lay(heard_run, script_run):
    """The script words over the heard run's time: one to one when the counts agree, else in proportion to length."""
    if len(heard_run) == len(script_run):
        out = []
        for h, s in zip(heard_run, script_run):
            w = copy.deepcopy(h)
            w["word"] = s
            out.append(w)
        return out
    start, end = heard_run[0]["start"], heard_run[-1]["end"]
    lengths = [max(1, len(_key(s))) for s in script_run]
    total = sum(lengths)
    out, t = [], start
    for i, (s, n) in enumerate(zip(script_run, lengths)):
        w = copy.deepcopy(heard_run[0])
        w["word"] = s
        w["start"] = t
        t = end if i == len(script_run) - 1 else round(start + (end - start) * sum(lengths[:i + 1]) / total, 3)
        w["end"] = t
        out.append(w)
    return out


_TRAIL = re.compile(r"[^\w]+$")


def _as_heard(heard_run, script_run):
    """The heard words as heard; a heard word that is an inflection of exactly one script word in the stretch
    ("protect" for "protecting.") takes that word's closing punctuation, so a sentence still ends there."""
    out = [copy.deepcopy(w) for w in heard_run]
    for w in out:
        hk = _key(w["word"])
        kin = [t for t in script_run if hk and _key(t) and _key(t) != hk and (_key(t).startswith(hk) or hk.startswith(_key(t)))]
        trail = _TRAIL.search(kin[0]) if len(kin) == 1 else None
        if trail and not _TRAIL.search(w["word"]):
            w["word"] = w["word"] + trail.group()
    return out


def _replace(heard_run, script_run):
    """(words, corrected) for a stretch where the two disagree: the best-matching pair of runs (each at most RUN_WORDS
    words) is replaced when it reads alike, and the stretches either side of it are looked at again; the rest of the
    heard words stay as heard."""
    if not heard_run:
        return [], 0
    if len(heard_run) * len(script_run) > MAX_PAIRS:   # a long stretch the script does not hold: as heard
        return [copy.deepcopy(w) for w in heard_run], 0
    best = None
    for a in range(len(heard_run)):
        for b in range(a + 1, min(len(heard_run), a + RUN_WORDS) + 1):
            hk = _spoken("".join(_key(w["word"]) for w in heard_run[a:b]))
            for c in range(len(script_run)):
                for d in range(c + 1, min(len(script_run), c + RUN_WORDS) + 1):
                    if any("'" in x or "\u2019" in x for x in [w["word"] for w in heard_run[a:b]] + script_run[c:d]):
                        continue   # "it is" for "it's", "kid" for "kid's": the speaker's own words, not a mishearing
                    sk = _spoken("".join(_key(s) for s in script_run[c:d]))
                    r = _alike(hk, sk, sound=(b - a == 1 and d - c == 1))
                    if r >= MATCH_RATIO and (best is None or r > best[0]):
                        best = (r, a, b, c, d)
    if best is None:
        return _as_heard(heard_run, script_run), 0
    _, a, b, c, d = best
    left, nl = _replace(heard_run[:a], script_run[:c])
    right, nr = _replace(heard_run[b:], script_run[d:])
    return left + _lay(heard_run[a:b], script_run[c:d]) + right, nl + (d - c) + nr


def align(heard, script):
    """(words, corrected): `heard` spelled from `script` (see the module doc). No script, or no words, changes nothing."""
    tokens = _tokens(script)
    if not tokens or not heard:
        return heard, 0
    hk = [_key(w.get("word", "")) for w in heard]
    sk = [_key(t) for t in tokens]
    out, corrected = [], 0
    starts_at = None   # a stutter before the word it repeats: that word starts at the first saying

    def put(w):
        nonlocal starts_at
        if starts_at is not None:
            w["start"], starts_at = starts_at, None
        out.append(w)

    for op, i1, i2, j1, j2 in SequenceMatcher(None, hk, sk, autojunk=False).get_opcodes():
        if op == "equal":
            for h, s in zip(heard[i1:i2], tokens[j1:j2]):
                w = copy.deepcopy(h)
                w["word"] = s
                put(w)
        elif op == "replace":
            words, n = _replace(heard[i1:i2], tokens[j1:j2])
            for w in words:
                put(w)
            corrected += n
        elif op == "delete":
            for i in range(i1, i2):
                h = heard[i]
                if out and starts_at is None and _key(out[-1]["word"]) == hk[i]:   # said twice: the first saying runs on
                    out[-1]["end"] = h["end"]
                    corrected += 1
                elif i == i2 - 1 and i2 < len(heard) and hk[i2] == hk[i]:          # said twice: the next saying starts here
                    starts_at = h["start"] if starts_at is None else starts_at
                    corrected += 1
                else:
                    put(copy.deepcopy(h))
        # "insert": script words never said are not added
    return out, corrected


def script_of(project) -> str:
    """The script a caption run spells from when none is passed: the project's editing prompt (what the person asked
    for, which holds the script when they gave one), with its <section> and <stage direction> tags left out. Its
    instructions do not get into the captions: only heard words that read or sound like a script word change."""
    prompt = project.get("editingPrompt")
    return re.sub(r"<[^>]*>", " ", prompt) if isinstance(prompt, str) else ""


def spell_from_script(words_json_path, script) -> int:
    """Rewrite the transcript's words (whisper's `transcription`, one entry per word) in the script's spelling, on the
    same timings (lib/caption_script.align). Returns how many words changed beyond case and punctuation."""
    with open(words_json_path, encoding="utf-8", errors="replace") as f:
        doc = json.load(f)
    entries = [e for e in (doc.get("transcription") or []) if isinstance(e, dict) and str(e.get("text", "")).strip()]
    heard = [{"word": e["text"].strip(), "start": (e.get("offsets") or {}).get("from", 0) / 1000.0,
              "end": (e.get("offsets") or {}).get("to", 0) / 1000.0} for e in entries]
    words, corrected = align(heard, script)
    doc["transcription"] = [{"text": " " + w["word"], "offsets": {"from": round(w["start"] * 1000), "to": round(w["end"] * 1000)}}
                            for w in words]
    with open(words_json_path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    return corrected
