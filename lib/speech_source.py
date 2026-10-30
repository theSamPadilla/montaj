"""Where a cut's speech is (§558): a video track, an audio lane, or the project's voiceover.

`cut` and its apply work on one speech TRACK. An audio lane or the voiceover is lifted into a track of its own for
the cut (`lift`); the speech machinery (the mechanical pass, the plan, speech_edit's build and carry) runs on that
unchanged, and the result is lowered back (`Lift.lower`) before it is validated and written: a lane's items cut in
place on `audio.tracks`, a voiceover's kept spans as `voiceover` items there. `voiceover.src` itself is left as it
is: nothing plays it (the render and the editor play `audio.tracks`), and the vo_* steps read it.

A source key is a video track's id, "audio:lane-<n>" (the `audio.tracks` items of integer lane n), "audio:<type>"
(items with no lane, of that type: "voiceover", "music", ... or "audio" for none), or "voiceover" (the file at
`voiceover.src`, while no audio item plays it). A lifted track's id is LIFT_PREFIX + its key.
"""
import copy
import os
from dataclasses import dataclass, field

from lib.common import fail, get_duration
from lib.project_tracks import normalize_tracks
from lib.speech_lines import sidecar_for
from lib.speech_units import media_items, resolve_path, resolved_item

LIFT_PREFIX = "speech:"
VOICEOVER = "voiceover"
# The fades a cut piece of narration gets at an edge the cut made (the Engineering Explainer's join fades), so the
# join never clicks. An edge the cut did not move keeps the fade it had.
JOIN_FADE_IN, JOIN_FADE_OUT = 0.008, 0.012
# Items of one audio source may overlap by a crossfade at most; more is two voices at once.
MAX_OVERLAP_S = 0.5
_EPS = 1e-6


def audio_key(entry):
    lane = entry.get("lane")
    if isinstance(lane, int) and not isinstance(lane, bool):
        return f"audio:lane-{lane}"
    return f"audio:{entry.get('type') or 'audio'}"


def is_lifted(track_id):
    return isinstance(track_id, str) and track_id.startswith(LIFT_PREFIX)


def key_of(track_id):
    """The source key a plan's track id names (a lifted track's, or the video track itself)."""
    return track_id[len(LIFT_PREFIX):] if is_lifted(track_id) else track_id


def _audio(project):
    audio = project.get("audio")
    tracks = audio.get("tracks") if isinstance(audio, dict) else None
    return tracks if isinstance(tracks, list) else []


def _voiceover_src(project):
    vo = project.get("voiceover")
    src = vo.get("src") if isinstance(vo, dict) else None
    return src if isinstance(src, str) and src else None


def _same_file(a, b, project_dir):
    return os.path.realpath(resolve_path(a, project_dir)) == os.path.realpath(resolve_path(b, project_dir))


def candidates(project, project_dir):
    """[(key, kind, entries)]: every video track, every audio group in the order it first appears, then the
    voiceover while no audio item plays its file (one that does is that item's group)."""
    out = [(t["id"], "video", media_items(t)) for t in normalize_tracks(copy.deepcopy(project)).get("tracks", [])]
    groups = {}
    for e in _audio(project):
        if isinstance(e, dict) and isinstance(e.get("src"), str) and e["src"]:
            groups.setdefault(audio_key(e), []).append(e)
    out += [(k, "audio", es) for k, es in groups.items()]
    vo = _voiceover_src(project)
    if vo and not any(_same_file(e["src"], vo, project_dir) for es in groups.values() for e in es):
        out.append((VOICEOVER, VOICEOVER, [{"src": vo}]))
    return out


def _transcribed_seconds(entries, project_dir):
    total = 0.0
    for e in entries:
        if not sidecar_for(resolved_item(e, project_dir)):
            continue
        if e.get("outPoint") is not None:
            total += max(0.0, float(e["outPoint"]) - float(e.get("inPoint") or 0))
        elif e.get("end") is not None and float(e["end"]) > float(e.get("start") or 0):
            total += float(e["end"]) - float(e.get("start") or 0)
        else:
            total += float(e.get("sourceDuration") or 0)      # a placeholder (end at its start) plays its whole file
    return total


def _seconds(entries):
    return sum(max(0.0, float(e.get("end") or 0) - float(e.get("start") or 0)) for e in entries)


def choose(project, project_dir, asked=None):
    """The source key to cut. `asked`: None or "auto", a video track id, an audio key, or "voiceover".

    auto: the source with the most seconds of transcribed media (a video track wins a tie, so a project cut before
    sources existed picks the same track). With nothing transcribed yet: the voiceover, else the longest audio group
    of `voiceover` items, else the first video track (as before)."""
    cands = candidates(project, project_dir)
    if asked not in (None, "", "auto"):
        for key, kind, entries in cands:
            if key == asked:
                return key
        if asked == VOICEOVER:
            vo = _voiceover_src(project)
            playing = [(any(e.get("type") == VOICEOVER for e in entries), _seconds(entries), key)
                       for key, kind, entries in cands
                       if vo and kind == "audio" and any(_same_file(e["src"], vo, project_dir) for e in entries)]
            if playing:
                return max(playing)[2]      # the voiceover is already on the timeline: cut it there
        if has_source(project, project_dir, asked):
            return asked                    # a type key whose row the editor has since stamped as a lane
        fail("invalid_params", f"speech must be auto or one of: {', '.join(k for k, _, _ in cands) or 'nothing'}")
    best, best_s = None, 0.0
    for key, kind, entries in cands:
        s = _transcribed_seconds(entries, project_dir)
        if s > best_s + _EPS:
            best, best_s = key, s
    if best is not None:
        return best
    for key, kind, _ in cands:
        if kind == VOICEOVER:
            return key
    vo = _voiceover_src(project)
    playing = [(_seconds(entries), key) for key, kind, entries in cands
               if vo and kind == "audio" and any(_same_file(e["src"], vo, project_dir) for e in entries)]
    if playing:
        return max(playing)[1]
    video = [key for key, kind, entries in cands if kind == "video" and entries]
    if video:
        return video[0]
    narration = [(_seconds(entries), key) for key, kind, entries in cands
                 if kind == "audio" and any(e.get("type") == VOICEOVER for e in entries)]
    if narration:
        return max(narration)[1]
    video = [key for key, kind, _ in cands if kind == "video"]
    if not video:
        fail("no_tracks", "The project has no tracks to cut")
    return video[0]


@dataclass
class Lift:
    """A source lifted into a speech track. `track_id` is the track the cut works on; `lower(project)` gives the
    project with that track put back where it came from (identity for a video track)."""
    key: str
    track_id: str
    kind: str
    stash: dict = field(default_factory=dict)    # lifted item id -> the audio entry it was (a voiceover's: its file)
    at: int = 0                                   # where the group's first entry stood in audio.tracks

    def lower(self, project):
        if self.kind == "video":
            return project
        out = copy.deepcopy(project)
        tracks = out.get("tracks", [])
        k = next((i for i, t in enumerate(tracks) if t.get("id") == self.track_id), None)
        if k is None:
            raise ValueError(f"lower: the lifted track {self.track_id} is gone")   # never drop the narration silently
        lifted = tracks.pop(k)
        items = [it for it in sorted(lifted.get("items", []), key=lambda x: float(x.get("start", 0)))
                 if it.get("src") and float(it.get("end", 0)) > float(it.get("start", 0))]
        first, last = {}, {}
        for it in items:
            o = id(self._origin_of(it["id"], it))
            first.setdefault(o, it["id"])
            last[o] = it["id"]
        entries = [self._entry(it, outer_in=first.get(id(self._origin_of(it["id"], it))) == it["id"],
                               outer_out=last.get(id(self._origin_of(it["id"], it))) == it["id"]) for it in items]
        if not isinstance(out.get("audio"), dict):
            out["audio"] = {}
        rest = list(out["audio"].get("tracks") or [])
        at = min(self.at, len(rest))
        out["audio"]["tracks"] = rest[:at] + entries + rest[at:]
        return out

    def _origin_of(self, item_id, it=None):
        """The stashed entry a piece was cut from: its own id, or the longest one it extends (`<id>-seg-..`); for a
        piece with neither (an `sp-..` run), the entry of its file whose window holds most of it, else the first."""
        if item_id in self.stash:
            return self.stash[item_id]
        best = max((k for k in self.stash if str(item_id).startswith(f"{k}-")), key=len, default=None)
        if best is not None:
            return self.stash[best]
        if it is not None:
            def overlap(e):
                return min(float(it["outPoint"]), e["_out"]) - max(float(it["inPoint"]), e["_in"])
            same = [e for e in self.stash.values() if e.get("src") == it.get("src")]
            if same:
                return max(same, key=overlap)
        return next(iter(self.stash.values()), None)

    def _entry(self, it, outer_in=True, outer_out=True):
        orig = self._origin_of(it["id"], it) or {}
        entry = {k: copy.deepcopy(v) for k, v in orig.items()
                 if k not in ("id", "start", "end", "inPoint", "outPoint", "fadeIn", "fadeOut", "_in", "_out")}
        entry.update({"id": it["id"], "src": orig.get("src", it["src"]), "start": it["start"], "end": it["end"],
                      "inPoint": it["inPoint"], "outPoint": it["outPoint"]})
        o_in, o_out = orig.get("_in", orig.get("inPoint")), orig.get("_out", orig.get("outPoint"))
        moved_in = o_in is None or abs(float(it["inPoint"]) - float(o_in)) > _EPS
        moved_out = o_out is None or abs(float(it["outPoint"]) - float(o_out)) > _EPS
        fade_in, fade_out = orig.get("fadeIn"), orig.get("fadeOut")
        if moved_in:
            fade_in = max(float(fade_in or 0), JOIN_FADE_IN) if outer_in else JOIN_FADE_IN
        if moved_out:
            fade_out = max(float(fade_out or 0), JOIN_FADE_OUT) if outer_out else JOIN_FADE_OUT
        if fade_in:
            entry["fadeIn"] = fade_in
        if fade_out:
            entry["fadeOut"] = fade_out
        return entry


def _window(e, project_dir):
    """(start, end, inPoint, outPoint) of an audio entry: no `end` plays to `outPoint`, else to the file's end."""
    start = float(e.get("start") or 0)
    in_p = max(0.0, float(e.get("inPoint") or 0))
    caps = [float(get_duration(resolve_path(e["src"], project_dir)))]
    if e.get("outPoint") is not None and float(e["outPoint"]) > in_p:
        caps.append(float(e["outPoint"]))
    if e.get("end") is not None and float(e["end"]) > start:
        caps.append(in_p + float(e["end"]) - start)
    out_p = min(caps)
    return start, start + (out_p - in_p), in_p, out_p


def _key_matcher(audio, key):
    """Which `audio.tracks` entries `key` names. An "audio:<type>" key also finds its items once the editor has
    written their packed row down as a lane: the editor gives lane-less audio a row per kind and stamps it as `lane`
    on the person's next edit, so a cut planned before that edit still applies after it. Every item of that type
    is taken, on however many rows packing gave it (narration whose takes overlap by a crossfade packs onto two);
    lift's own overlap check still refuses two voices at once."""
    def plain(e):
        return audio_key(e) == key
    if not key.startswith("audio:") or key.startswith("audio:lane-"):
        return plain
    kind = key[len("audio:"):]
    usable = [e for e in audio if isinstance(e, dict) and isinstance(e.get("src"), str) and e["src"]]
    if any(plain(e) for e in usable):
        return plain
    return lambda e: (e.get("type") or "audio") == kind


def has_source(project, project_dir, key):
    """Whether `key` still names something on the project: a candidate, or a type key whose row was stamped."""
    if any(k == key for k, _, _ in candidates(project, project_dir)):
        return True
    if not (isinstance(key, str) and key.startswith("audio:")):
        return False
    match = _key_matcher(_audio(project), key)
    return any(isinstance(e, dict) and isinstance(e.get("src"), str) and e["src"] and match(e) for e in _audio(project))


def lift(project, key, project_dir):
    """(the project with `key`'s source as a speech track, Lift). A video key is the project itself."""
    lifted = normalize_tracks(copy.deepcopy(project))
    if not (key == VOICEOVER or str(key).startswith("audio:")):
        return lifted, Lift(key=key, track_id=key, kind="video")
    lift_ = Lift(key=key, track_id=LIFT_PREFIX + key, kind="audio" if key != VOICEOVER else VOICEOVER)
    items = []
    used = {it.get("id") for t in lifted.get("tracks", []) for it in t.get("items", [])}
    used |= {e.get("id") for e in _audio(lifted) if isinstance(e, dict)}
    if key == VOICEOVER:
        src = _voiceover_src(lifted)
        dur = float(get_duration(resolve_path(src, project_dir)))
        vid, n = "vo", 0
        while vid in used:
            n += 1
            vid = f"vo-{n}"
        items.append({"id": vid, "type": "audio", "src": src, "start": 0.0, "end": dur, "inPoint": 0.0,
                      "outPoint": dur, "sourceDuration": dur})
        lift_.stash[vid] = {"type": VOICEOVER, "src": src, "volume": 1, "_in": 0.0, "_out": dur}
        lift_.at = len(_audio(lifted))
    else:
        audio = _audio(lifted)
        match = _key_matcher(audio, key)
        keep, taken = [], []
        for i, e in enumerate(audio):
            if isinstance(e, dict) and isinstance(e.get("src"), str) and e["src"] and match(e):
                if not taken:
                    lift_.at = len(keep)
                taken.append(e)
            else:
                keep.append(e)
        if not taken:
            fail("invalid_params", f"speech {key}: no such audio on the project")
        n = 0
        for e in taken:
            iid = e.get("id")
            if not iid:
                while f"aud-{n}" in used:
                    n += 1
                iid = f"aud-{n}"
                used.add(iid)
            start, end, in_p, out_p = _window(e, project_dir)
            items.append({"id": iid, "type": "audio", "src": e["src"], "start": start, "end": end, "inPoint": in_p,
                          "outPoint": out_p})
            lift_.stash[iid] = {**e, "_in": in_p, "_out": out_p}
        spans = sorted((it["start"], it["end"], it["id"]) for it in items)
        for (a0, a1, ida), (b0, b1, idb) in zip(spans, spans[1:]):
            if b0 < a1 - MAX_OVERLAP_S:
                # two voices at once would be read as one speaker's takes of each other
                fail("invalid_params", f"speech {key}: {ida} and {idb} play at the same time. Give each voice its own "
                                       "lane (audio:lane-<n>) and cut them one at a time.")
        lifted["audio"]["tracks"] = keep
    lifted.setdefault("tracks", []).append({"id": lift_.track_id, "items": items})
    return lifted, lift_
