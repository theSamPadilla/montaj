"""Helpers for the caption-generation route: derive the cut keeps from a project's
primary track and guard the single-source assumption."""


def extract_keeps(project: dict) -> tuple[str, list[list[float]]]:
    """Return (source_path, keeps) for the primary-track video clips.

    keeps are [inPoint, outPoint] pairs in source time, ordered by clip start —
    the concatenation order that defines the output timeline. Raises ValueError
    with a stable code-prefixed message when the assumption breaks.
    """
    track0 = (project.get("tracks") or [[]])[0]
    clips = sorted(
        [c for c in track0 if c.get("type") == "video"],
        key=lambda c: c.get("start", 0.0),
    )
    if not clips:
        raise ValueError("no_clips: primary track has no video clips")
    sources = {c.get("src") for c in clips}
    if len(sources) != 1:
        raise ValueError(
            "multi_source: caption generation supports a single source clip only "
            f"(found {len(sources)} distinct sources)"
        )
    source = clips[0]["src"]
    keeps = []
    for c in clips:
        in_pt = float(c.get("inPoint", 0.0))
        out_pt = float(c.get("outPoint", c.get("end", 0.0) - c.get("start", 0.0) + in_pt))
        if out_pt > in_pt:
            keeps.append([round(in_pt, 4), round(out_pt, 4)])
    if not keeps:
        raise ValueError("empty_keeps: clips produced no positive-length keep ranges")
    return source, keeps
