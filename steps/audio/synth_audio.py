#!/usr/bin/env python3
"""Synthesize a WAV from a cue list: generic voices at exact times.

Mechanics only -- no arrangement, key or mixing rules. Stdlib only.
Cues file: {"duration"?: s, "seed"?: int, "cues": [{"t": s, "voice": name,
"dur"?: s, "note"?: midi, "freq"?: hz, "gain"?: 0..2, "pan"?: -1..1}]}.
Output: 48 kHz stereo 16-bit WAV, peak limited to --peak-db (default -1 dBFS),
a 20 ms fade on the tail.
"""
import argparse, json, math, os, random, struct, sys, wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file  # noqa: E402

SR = 48000
TAIL = 0.5
DEFAULT_DUR = {"kick": 0.45, "snare": 0.25, "hat": 0.06, "bass": 0.5, "sub": 0.5, "pad": 2.0,
               "pluck": 0.4, "whoosh": 0.35, "hit": 0.3, "click": 0.04, "riser": 2.0}
DEFAULT_HZ = {"bass": 55.0, "sub": 55.0, "pad": 220.0, "pluck": 440.0, "click": 1800.0, "riser": 200.0}
TAU = 2 * math.pi


def _is_number(v):
    """True for a finite, real number -- excludes bool (a bool IS an int in
    Python) and numeric strings ("60" is not a number here, only 60 is)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


# name -> (field, low, high); every cue field with a numeric range, checked
# the same way. "t" and "dur" are handled separately: "t" is required and
# "dur" defaults per-voice when absent.
_CUE_RANGES = {
    "note": (0, 127),
    "freq": (1, 20000),
    "gain": (0, 2),
    "pan": (-1, 1),
}


def _validate_cues(spec):
    """Reject a malformed cue list up front with a clear invalid_argument,
    instead of letting a bad value surface later as a cryptic TypeError/
    ValueError or a silently wrong render. Caps the reported total at 600s."""
    cues = spec.get("cues")
    if not isinstance(cues, list) or not cues:
        fail("invalid_argument", "cues must be a non-empty list")
    duration = spec.get("duration")
    if duration is not None and (not _is_number(duration) or not (0 < duration <= 600)):
        fail("invalid_argument", f"duration must be a number in (0, 600], got {duration!r}")
    for i, c in enumerate(cues):
        if not isinstance(c, dict):
            fail("invalid_argument", f"cues[{i}] must be an object")
        t = c.get("t")
        if "t" not in c or not _is_number(t) or not (0 <= t <= 600):
            fail("invalid_argument", f"cues[{i}].t must be a number in [0, 600], got {t!r}")
        if "dur" in c and (not _is_number(c["dur"]) or not (0.001 <= c["dur"] <= 600)):
            fail("invalid_argument", f"cues[{i}].dur must be a number in [0.001, 600], got {c['dur']!r}")
        for field, (lo, hi) in _CUE_RANGES.items():
            if field in c and (not _is_number(c[field]) or not (lo <= c[field] <= hi)):
                fail("invalid_argument", f"cues[{i}].{field} must be a number in [{lo}, {hi}], got {c[field]!r}")
    return cues


def midi_hz(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def ar(i, n, attack, release):
    a = max(1, int(attack * SR)); r = max(1, int(release * SR))
    if i < a:
        return i / a
    if i > n - r:
        return max(0.0, (n - i) / r)
    return 1.0


def voice(name, dur, hz, rnd):
    n = max(1, int(dur * SR)); out = [0.0] * n
    if name == "kick":
        ph = 0.0
        for i in range(n):
            t = i / SR; ph += TAU * (50 + 100 * math.exp(-t * 30)) / SR
            out[i] = math.sin(ph) * math.exp(-t * 8)
    elif name == "snare":
        for i in range(n):
            t = i / SR
            out[i] = (0.6 * (rnd.random() * 2 - 1) + 0.4 * math.sin(TAU * 190 * t)) * math.exp(-t * 18)
    elif name == "hat":
        prev = 0.0
        for i in range(n):
            x = rnd.random() * 2 - 1; out[i] = (x - prev) * 0.5 * math.exp(-(i / SR) * 60); prev = x
    elif name in ("bass", "sub"):
        for i in range(n):
            t = i / SR; s = math.sin(TAU * hz * t)
            if name == "bass":
                s = 0.8 * s + 0.2 * math.sin(2 * TAU * hz * t)
            out[i] = s * ar(i, n, 0.005, 0.03)
    elif name == "pad":
        att = min(0.4, dur / 3)
        for i in range(n):
            t = i / SR
            s = sum(math.sin(TAU * hz * d * t) for d in (1.0, 1.004, 0.996, 2.0)) / 4
            out[i] = s * ar(i, n, att, att * 1.5)
    elif name == "pluck":
        for i in range(n):
            t = i / SR
            out[i] = (math.sin(TAU * hz * t) + 0.3 * math.sin(2 * TAU * hz * t)) * math.exp(-t * 6) * ar(i, n, 0.002, 0.01)
    elif name == "whoosh":
        lp = 0.0
        for i in range(n):
            p = i / n; lp += (0.02 + 0.25 * p) * ((rnd.random() * 2 - 1) - lp)
            out[i] = lp * math.sin(math.pi * p) ** 2 * 2.5
    elif name == "riser":
        ph = 0.0; lp = 0.0
        for i in range(n):
            p = i / n; ph += TAU * hz * (1 + 3 * p * p) / SR
            lp += (0.02 + 0.3 * p) * ((rnd.random() * 2 - 1) - lp)
            out[i] = (0.5 * math.sin(ph) + 0.8 * lp) * p * ar(i, n, 0.01, 0.02)
    elif name == "hit":
        ph = 0.0
        for i in range(n):
            t = i / SR; ph += TAU * (80 + 220 * math.exp(-t * 25)) / SR
            out[i] = (0.8 * math.sin(ph) + 0.5 * (rnd.random() * 2 - 1) * math.exp(-t * 40)) * math.exp(-t * 10)
    elif name == "click":
        for i in range(n):
            t = i / SR; out[i] = math.sin(TAU * hz * t) * math.exp(-t * 120)
    return out


def synth(spec, peak_db=-1.0):
    cues = _validate_cues(spec)
    rnd = random.Random(spec.get("seed", 1))
    for c in cues:
        if c.get("voice") not in DEFAULT_DUR:
            fail("invalid_argument", f"unknown voice {c.get('voice')!r}; expected one of {sorted(DEFAULT_DUR)}")
    ends = [float(c["t"]) + float(c.get("dur", DEFAULT_DUR[c["voice"]])) for c in cues]
    total = float(spec.get("duration") or (max(ends) + TAIL))
    total = min(total, 600.0)
    n = int(round(total * SR))
    left = [0.0] * n; right = [0.0] * n
    for c in sorted(cues, key=lambda c: float(c["t"])):
        name = c["voice"]; dur = float(c.get("dur", DEFAULT_DUR[name]))
        hz = float(c["freq"]) if "freq" in c else midi_hz(c["note"]) if "note" in c else DEFAULT_HZ.get(name, 220.0)
        gain = float(c.get("gain", 1.0)); pan = max(-1.0, min(1.0, float(c.get("pan", 0.0))))
        gl = gain * math.cos((pan + 1) * math.pi / 4); gr = gain * math.sin((pan + 1) * math.pi / 4)
        start = int(round(float(c["t"]) * SR))
        for k, s in enumerate(voice(name, dur, hz, rnd)):
            j = start + k
            if j >= n:
                break
            left[j] += s * gl; right[j] += s * gr
    fade = min(n, int(0.02 * SR))
    for k in range(fade):
        g = k / fade; left[n - 1 - k] *= g; right[n - 1 - k] *= g
    peak = max(max(map(abs, left)), max(map(abs, right)), 1e-9)
    ceiling = 10 ** (peak_db / 20)
    scale = min(1.0, ceiling / peak)
    return left, right, scale, total, 20 * math.log10(peak * scale)


def write_wav(path, left, right, scale):
    frames = bytearray()
    for a, b in zip(left, right):
        frames += struct.pack("<hh", int(max(-1, min(1, a * scale)) * 32767), int(max(-1, min(1, b * scale)) * 32767))
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(bytes(frames))


def main():
    ap = argparse.ArgumentParser(description="Synthesize a WAV from a cue list of generic voices")
    ap.add_argument("--cues", required=True, help="Path to the cues JSON file")
    ap.add_argument("--out", required=True, help="Output WAV path")
    ap.add_argument("--peak-db", type=float, default=-1.0, help="Peak ceiling in dBFS (default -1)")
    args = ap.parse_args()
    require_file(args.cues)
    with open(args.cues) as f:
        spec = json.load(f)
    left, right, scale, total, peak_db = synth(spec, args.peak_db)
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_wav(out, left, right, scale)
    print(json.dumps({"path": out, "duration": round(total, 4), "peak_db": round(peak_db, 2)}))


if __name__ == "__main__":
    main()
