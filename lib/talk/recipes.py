"""Named facial expressions to ARKit key weights, from recipes.json.
Names: "smile", "smile@0.6" (strength, clipped to 0..1.5), "smirk.R" (mirrored).
In code: load(), parse_name(name), weights(name, data, head_reach=None), mood(name, data), meta(name, data). Deterministic."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
MIN_W = 0.001


def load(path=None):
    with open(path or os.path.join(HERE, "recipes.json")) as f:
        return json.load(f)


def parse_name(name):
    mirror = False
    if name.endswith(".R"):
        mirror, name = True, name[:-2]
    s = 1.0
    if "@" in name:
        name, v = name.rsplit("@", 1)
        if v.endswith(".R"):  # smirk.R@0.5: the mirror suffix may come before or after the strength
            mirror, v = True, v[:-2]
        s = float(v)
    if name.endswith(".R"):
        mirror, name = True, name[:-2]
    return name, min(max(s, 0.0), 1.5), mirror


def _swap(k):
    return k.replace("Left", "\0").replace("Right", "Left").replace("\0", "Right")


def weights(name, data, head_reach=None):
    rec, s, mirror = parse_name(name)
    if rec not in data["recipes"]:
        raise KeyError(f"unknown recipe {rec!r}; known: {', '.join(sorted(data['recipes']))}")
    fl = data.get("floor", {})
    prefixes = tuple(fl.get("prefixes", ()))
    fmin = fl.get("min", 0.0)
    ref = data.get("reference_reach_mm", {})
    out = {}
    for k, w in data["recipes"][rec]["w"].items():
        if s <= 0:
            continue
        scale = fmin + (1 - fmin) * s if prefixes and k.startswith(prefixes) else s
        v = w * scale
        if mirror:
            k = _swap(k)
        if head_reach is not None:
            r, h = ref.get(k), head_reach.get(k)
            if r and h and r > 0 and h > 0:
                v *= r / h
        v = min(max(v, 0.0), 1.0)
        if v >= MIN_W:
            out[k] = v
    return out


def mood(name, data):
    m = data["moods"]
    if name not in m:
        raise KeyError(f"unknown mood {name!r}; known: {', '.join(sorted(m))}")
    x = m[name]
    return x.get("recipe"), x.get("strength", 0.0), x.get("motion", 1.0)


def meta(name, data):
    rec, _, _ = parse_name(name)
    if rec not in data["recipes"]:
        raise KeyError(f"unknown recipe {rec!r}; known: {', '.join(sorted(data['recipes']))}")
    r = data["recipes"][rec]
    return {"in": r["in"], "out": r["out"], "speech": r.get("speech", "keep")}
