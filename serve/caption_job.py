"""Helpers for the caption-generation route: derive the materialize_cut spec
from a project's primary track.

Supports single- AND multi-source timelines. A multi-source timeline (a normal
reaction/compilation cut where tracks[0] concatenates several source files) is
materialised into one composed mp4 by the same per-segment seek + concat graph
the single-source path already uses — captions then transcribe that output, so
the word timings land 1:1 on the final video timeline."""


def extract_segments(project: dict) -> list[dict]:
    """Return the primary-track video segments as ``[{"src", "in", "out"}, ...]``,
    ordered by clip ``start`` — the concatenation order that defines the output
    timeline. Each segment is one clip's source window, in source time.

    Works for single- and multi-source timelines; only tracks[0] *video* clips
    are considered (overlays in tracks[1+] are visual and ignored, audio clips
    are skipped). Raises ``ValueError`` with a stable code-prefixed message when
    the timeline is unusable.
    """
    track0 = (project.get("tracks") or [[]])[0]
    clips = sorted(
        [c for c in track0 if c.get("type") == "video"],
        key=lambda c: c.get("start", 0.0),
    )
    if not clips:
        raise ValueError("no_clips: primary track has no video clips")
    segments = []
    for c in clips:
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
    """
    segments = extract_segments(project)
    sources = {s["src"] for s in segments}
    if len(sources) == 1:
        return {
            "input": segments[0]["src"],
            "keeps": [[s["in"], s["out"]] for s in segments],
        }
    return {"segments": segments}
