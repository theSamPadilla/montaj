"""Helpers for the caption-generation route: derive the materialize_cut spec
from a project's primary track.

Supports single- AND multi-source timelines. A multi-source timeline (a normal
reaction/compilation cut where tracks[0] concatenates several source files) is
materialised into one composed mp4 by the same per-segment seek + concat graph
the single-source path already uses — captions then transcribe that output, so
the word timings land 1:1 on the final video timeline.

When every tracks[0] video clip carries a ``normalizedSrc`` cache (an SDR
bt709 pre-encoded window anchored at ``normalizedInPoint``), ``extract_segments``
rebases the in/out points into cache time so the ffmpeg concat never mixes raw
HDR originals with SDR caches. This is ALL-OR-NOTHING: if any clip lacks a
``normalizedSrc`` the function falls back to the original ``src`` for all clips.

For multi-source specs ``build_cut_spec`` also emits an optional ``"scale"``
key — a ``[W, H]`` pair of even ints with the long side capped at 640 —
derived from ``project.settings.resolution`` when present. Downstream
``materialize_cut`` uses this to normalise input dimensions before concat."""

from lib.project_tracks import track_items


def extract_segments(project: dict) -> list[dict]:
    """Return the primary-track video segments as ``[{"src", "in", "out"}, ...]``,
    ordered by clip ``start`` — the concatenation order that defines the output
    timeline. Each segment is one clip's source window, in source time (or in
    cache time when ``normalizedSrc`` caches are used).

    Cache selection is ALL-OR-NOTHING: switches to ``normalizedSrc`` only when
    every video clip in tracks[0] has one. In cache mode each clip's in/out is
    rebased by ``normalizedInPoint ?? inPoint`` so that time 0 is the cache
    origin. Tiny negative values (float rounding when inPoint == normalizedInPoint)
    are clamped to 0.0.

    Works for single- and multi-source timelines; only tracks[0] *video* clips
    are considered (overlays in tracks[1+] are visual and ignored, audio clips
    are skipped). Raises ``ValueError`` with a stable code-prefixed message when
    the timeline is unusable.
    """
    items = track_items(project)
    track0 = items[0] if items else []
    clips = sorted(
        [c for c in track0 if c.get("type") == "video"],
        key=lambda c: c.get("start", 0.0),
    )
    if not clips:
        raise ValueError("no_clips: primary track has no video clips")

    use_cache = bool(clips) and all(c.get("normalizedSrc") for c in clips)

    segments = []
    for c in clips:
        if use_cache:
            src = c.get("normalizedSrc")
            origin = c.get("normalizedInPoint")
            if origin is None:
                origin = c.get("inPoint", 0.0)
            origin = float(origin)
            in_pt = float(c.get("inPoint", 0.0)) - origin
            out_pt = float(c.get("outPoint", c.get("end", 0.0) - c.get("start", 0.0) + c.get("inPoint", 0.0))) - origin
            in_pt = max(0.0, in_pt)
        else:
            src = c.get("src")
            in_pt = float(c.get("inPoint", 0.0))
            out_pt = float(c.get("outPoint", c.get("end", 0.0) - c.get("start", 0.0) + in_pt))
        if src and out_pt > in_pt:
            segments.append({"src": src, "in": round(in_pt, 4), "out": round(out_pt, 4)})
    if not segments:
        raise ValueError("empty_keeps: clips produced no positive-length keep ranges")
    return segments


def build_cut_spec(project: dict) -> dict:
    """Build the materialize_cut input spec for the caption cut.

    Single-source timelines keep the legacy ``{"input", "keeps"}`` trim-spec
    shape — byte-identical to the previous behaviour, so single-source
    captioning is unchanged downstream. Multi-source timelines (>1 distinct
    ``src``) produce ``{"segments": [{"src", "in", "out"}, ...]}``, which
    materialize_cut composes into one mp4 via the same seek + concat graph.

    When clips carry ``normalizedSrc`` caches (see ``extract_segments``), the
    segment src paths and in/out values are already rebased into cache time.

    For multi-source specs an optional ``"scale": [W, H]`` key is included when
    ``project.settings.resolution`` is a valid ``[w, h]`` pair. The long side is
    capped at 640 and both dimensions are floored to even integers ≥ 2. Downstream
    materialize_cut uses this to scale and pad each input to a uniform size before
    the concat filter.
    """
    segments = extract_segments(project)
    sources = {s["src"] for s in segments}
    if len(sources) == 1:
        return {
            "input": segments[0]["src"],
            "keeps": [[s["in"], s["out"]] for s in segments],
        }
    spec: dict = {"segments": segments}
    res = (project.get("settings") or {}).get("resolution")
    if (
        isinstance(res, (list, tuple))
        and len(res) == 2
        and res[0] and res[1]
        and float(res[0]) > 0
        and float(res[1]) > 0
    ):
        w, h = float(res[0]), float(res[1])
        longest = max(w, h)
        factor = longest / 640.0 if longest > 640.0 else 1.0

        def _even(x: float) -> int:
            v = int(x / factor)
            v -= v % 2
            return max(2, v)

        spec["scale"] = [_even(w), _even(h)]
    return spec
