"""A 3D item's clock (§657): which second of its scene an item plays at item time t.

`props.inPoint` alone is scene second `inPoint + t`. After a cut inside the item, `props.timeMap` says it exactly:
[[item time, scene second, length]] pieces, sorted, the first at item time 0, each playing its scene seconds at the
speed of the clock. A scene second the cut removed is in no piece, and the item time before a piece starts a jump.
`inPoint` stays the scene second at item time 0, for every reader that knows no map. The stage (library/model3d)
evaluates the same function: item time to scene second, the last piece running on past its end.
"""

_EPS = 1e-9


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def time_map(props):
    """The pieces [(item time, scene second, length)] of a well-formed `props.timeMap`, else None."""
    raw = (props or {}).get("timeMap")
    if not isinstance(raw, list) or not raw:
        return None
    out = []
    for p in raw:
        if not (isinstance(p, (list, tuple)) and len(p) == 3 and all(_num(x) for x in p) and p[2] > 0 and p[0] >= 0 and p[1] >= 0):
            return None
        if out and p[0] < out[-1][0] + out[-1][2] - 1e-6:
            return None
        out.append((float(p[0]), float(p[1]), float(p[2])))
    return out if out[0][0] <= 1e-6 else None


def scene_at(props, t):
    """The scene second an item plays at item time `t` (before the first piece or in a gap: the nearest piece before,
    run on)."""
    pieces = time_map(props)
    if pieces is None:
        return (props or {}).get("inPoint", 0) + t if _num((props or {}).get("inPoint")) else t
    best = pieces[0]
    for p in pieces:
        if p[0] <= t + _EPS:
            best = p
    return best[1] + (t - best[0])


def pieces_between(props, x0, x1):
    """[(scene from, scene to, item time offset from x0)]: the scene seconds item time [x0, x1] plays, split where the
    clock jumps. A span in a gap between pieces plays nothing and is left out."""
    pieces = time_map(props)
    if pieces is None:
        base = (props or {}).get("inPoint", 0) if _num((props or {}).get("inPoint")) else 0.0
        return [(base + x0, base + x1, 0.0)]
    out = []
    last = len(pieces) - 1
    for i, (t, s, n) in enumerate(pieces):
        end = t + n if i < last else max(t + n, x1)     # the last piece runs on
        lo, hi = max(x0, t), min(x1, end)
        if hi - lo > _EPS:
            out.append((s + (lo - t), s + (hi - t), lo - x0))
    return out


def pieces_of(mapping):
    """The `timeMap` for a list of [scene from, scene to, item time] entries, runs that play on joined into one."""
    out = []
    for s0, s1, t in mapping:
        n = s1 - s0
        if n <= _EPS:
            continue
        if out and abs(out[-1][0] + out[-1][2] - t) < 1e-6 and abs(out[-1][1] + out[-1][2] - s0) < 1e-6:
            out[-1][2] += n
        else:
            out.append([t, s0, n])
    return [[round(t, 6), round(s, 6), round(n, 6)] for t, s, n in out]


def item_at(props, x):
    """The item time at which scene second `x` plays: the inverse of `scene_at`. Without a map `x - inPoint`; with one
    the first piece playing `x`, else (a second the cut removed) the item time of the piece that follows it, or None
    past the last."""
    pieces = time_map(props)
    if pieces is None:
        base = props.get("inPoint", 0) if _num((props or {}).get("inPoint")) else 0.0
        return x - base
    for t, s, n in pieces:
        if s - _EPS <= x < s + n:
            return t + (x - s)
    after = [t for t, s, _ in pieces if s > x]
    return min(after) if after else None
