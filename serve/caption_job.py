"""Helpers for the caption-generation route: derive the AUDIBLE TIMELINE MIX
spec from a project.

Captions are a transcript of what a viewer HEARS, so the caption job has to
transcribe the same thing the preview scrubber plays and the renderer encodes:

  * every ``video`` item on every ENABLED visual track — ``tracks[1..]``
    included, not just the primary footage track — unless the item or its
    track is muted, and
  * every ``project["audio"]["tracks"]`` entry (voiceover, music, sfx) unless
    it is muted,

each laid down at its OWN timeline position, with silence in the gaps.

That last part is what makes the resulting word timings usable. The old
implementation concatenated the primary track's clips into one MP4, so output
time equalled the SUM of clip lengths — every gap on the timeline shifted every
later word earlier. A positioned mix is project-time second for second, so a
word at 12.4s in the transcript is a word at 12.4s on the timeline.

Mute is the ONLY audibility gate that matters here, and it is read at caption
time only — nothing is written back to the project and nothing remembers a
decision after the job. Unmuting a track later simply means the next caption
run sees it.

WHAT THIS DELIBERATELY DOES NOT MODEL
-------------------------------------
* **Fades and ducking.** ``fadeIn``/``fadeOut``/``ducking`` shape a mix for
  the ear; they only attenuate the head or tail of material that is included
  either way. Transcription wants intelligibility, so the envelope is skipped
  and the flat ``volume`` is applied.
* **``loop``.** ``VisualItem.loop`` is a preview-only field — the renderer
  never repeats a video item's audio (``montaj_assets/render/encode-segment.js``
  loops IMAGES only), so neither does this.
* **``normalizedSrc`` / ``proxySrc`` caches.** Both exist for PICTURE: the
  normalized cache is an SDR colour conversion (the old video cut needed it so
  ffmpeg's concat never mixed HDR and SDR inputs), and the proxy is a 720p
  editing copy whose 96k Opus audio would degrade transcription input. An
  audio mix has neither problem, so every segment reads the ORIGINAL ``src``
  and the raw, un-rebased ``inPoint`` that goes with it.
"""

from lib.project_tracks import normalize_tracks


def effective_item_audio(track: dict, item: dict) -> tuple[float, bool]:
    """Fold a track's volume/mute into one of its items'.

    Volume MULTIPLIES (a clip an editor already turned down stays
    proportionally quieter under a track pulled down too); mute is either/or.
    Mirrors ``effectiveItemAudio`` in ``montaj_assets/render/project-tracks.js``
    and in ``montaj_assets/editor/src/video/timeline/timeline-model.ts`` — the
    three must agree or captions, preview and render disagree about what is
    audible.
    """
    track = track or {}
    item = item or {}
    volume = _num(track.get("volume"), 1.0) * _num(item.get("volume"), 1.0)
    muted = track.get("muted") is True or item.get("muted") is True
    return volume, muted


def _num(value, default: float) -> float:
    """``float(value)`` when it is a finite number, else ``default``. Keeps a
    ``None``/``"1.0"``/NaN in a hand-edited project from poisoning the spec."""
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if out != out or out in (float("inf"), float("-inf")):
        return default
    return out


def _segment(src, start: float, end: float, in_pt: float, volume: float, speed: float):
    """One positioned audio segment, or ``None`` when it contributes nothing.

    ``end - start`` (the span the item actually occupies on the timeline) is
    authoritative for length, not the stored ``outPoint``: a stale ``outPoint``
    left behind by a trim would silence the segment early. Render reads the
    timeline span the same way (``encode-segment.js`` seeks by ``inPoint`` and
    trims by the SEGMENT's duration), and so does the preview's ``audioWindow``
    (``timeline-core/src/audio.js``, "derived, not stored").

    A segment starting before the origin is clipped rather than dropped: the
    part of it that lands on the timeline is kept, with its in-point moved
    forward by the amount that fell off the front.
    """
    if not src or not isinstance(src, str):
        return None
    if volume <= 0:
        return None
    if end <= start:
        return None
    if start < 0:
        in_pt += (-start) * speed
        start = 0.0
        if end <= 0:
            return None
    in_pt = max(0.0, in_pt)
    out_pt = in_pt + (end - start) * speed
    if out_pt <= in_pt:
        return None
    seg = {
        "src": src,
        "in": round(in_pt, 4),
        "out": round(out_pt, 4),
        "start": round(start, 4),
        "volume": round(volume, 4),
    }
    if speed != 1.0:
        seg["speed"] = round(speed, 4)
    return seg


def _visual_segments(project: dict) -> list[dict]:
    """Audible video-item audio across EVERY enabled visual track.

    ``enabled is not False`` is the test — ``enabled`` is absent by default, so
    an untouched project has every track on. Same rule as
    ``lib/project_tracks.enabled_track_items``, but the TRACK object is needed
    here (for its ``volume``/``muted``), not just its items.
    """
    tracks = normalize_tracks(project).get("tracks") if isinstance(project, dict) else None
    if not isinstance(tracks, list):
        return []

    segments = []
    for track in tracks:
        if not isinstance(track, dict) or track.get("enabled") is False:
            continue
        for item in track.get("items") or []:
            if not isinstance(item, dict) or item.get("type") != "video":
                continue
            volume, muted = effective_item_audio(track, item)
            if muted:
                continue
            speed = _num(item.get("speed"), 1.0)
            if speed <= 0:
                speed = 1.0
            seg = _segment(
                item.get("src"),
                _num(item.get("start"), 0.0),
                _num(item.get("end"), 0.0),
                _num(item.get("inPoint"), 0.0),
                volume,
                speed,
            )
            if seg:
                segments.append(seg)
    return segments


def _audio_track_segments(project: dict) -> list[dict]:
    """Audible ``project["audio"]["tracks"]`` entries — voiceover, music, sfx.

    On a voiceover-driven cut (the ``broll`` workflow mutes the footage track
    outright) these ARE the timeline's speech, and the old primary-track cut
    never saw them at all.
    """
    audio = (project or {}).get("audio") or {}
    tracks = audio.get("tracks")
    if not isinstance(tracks, list):
        return []

    segments = []
    for track in tracks:
        if not isinstance(track, dict) or track.get("muted") is True:
            continue
        seg = _segment(
            track.get("src"),
            _num(track.get("start"), 0.0),
            _num(track.get("end"), 0.0),
            _num(track.get("inPoint"), 0.0),
            _num(track.get("volume"), 1.0),
            1.0,
        )
        if seg:
            segments.append(seg)
    return segments


def build_audio_mix_spec(project: dict, sample_rate: int = 16000) -> dict:
    """Build the ``mix_timeline`` input spec for the caption transcript.

    Returns ``{"duration", "sampleRate", "segments": [...]}`` where every
    segment is ``{"src", "in", "out", "start", "volume"[, "speed"]}`` in
    seconds, ordered by ``start`` (then ``src``) so the spec — and the ffmpeg
    graph built from it — is deterministic for a given project.

    ``duration`` is the end of the last audible segment, which is all the
    transcript needs: trailing silence after the final sound carries no words.

    Raises ``ValueError`` with a stable code-prefixed message when the timeline
    has nothing audible to transcribe.
    """
    segments = _visual_segments(project) + _audio_track_segments(project)
    if not segments:
        raise ValueError(
            "no_audio: timeline has no audible clips or audio tracks — "
            "every video clip and audio track is muted, empty, or on a skipped track"
        )
    segments.sort(key=lambda s: (s["start"], s["src"]))

    duration = 0.0
    for seg in segments:
        span = (seg["out"] - seg["in"]) / seg.get("speed", 1.0)
        duration = max(duration, seg["start"] + span)

    return {
        "duration": round(duration, 4),
        "sampleRate": sample_rate,
        "segments": segments,
    }
