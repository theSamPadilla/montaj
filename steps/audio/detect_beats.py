#!/usr/bin/env python3
"""Measure a music bed's tempo, beat grid, first downbeat and energy sections.

Pure analysis: one ffmpeg decode (split into low / mid / high bands) plus
stdlib Python. No encode, no network, no model, no numpy.

Pipeline (method "bandflux-autocorr-v1"):
  1. decode to 22050 Hz mono, band-split in the same ffmpeg call
  2. per-hop band energy (hop 256 samples, 11.6 ms)
  3. onset envelope: summed half-wave-rectified log-energy flux, local mean removed
  4. tempo: autocorrelation comb over [min_bpm, max_bpm] with a log-Gaussian
     prior centred on --bpm-hint (else 120); the hint picks the octave
  5. phase: best comb alignment at quarter-frame resolution
  6. refinement: snap grid beats to envelope peaks, least-squares refit (x3)
  7. downbeat from an energy change, else from low-band accents, else the
     first beat; the deciding cue is reported as downbeat_source
  8. per-bar loudness sections (high / mid / low / silent) and drop /
     breakdown events

Times are seconds in the input file. Bar and event indices are 0-based from
the downbeat; beats before the downbeat are a pickup.
"""
import argparse, array, json, math, operator, os, subprocess, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import ffmpeg_error_tail, fail, require_file, ffmpeg_bin, ffprobe_value

METHOD = "bandflux-autocorr-v1"
SR = 22050
HOP = 256
FR = SR / HOP                 # onset frames per second (~86.13)
BANDS = 3
# Energies are computed on float PCM scaled to the int16 range, so the
# log floor (1e-3) and dB references match the prototype's tuning.
PCM_SCALE = 32768.0
FULL_SCALE_POWER = PCM_SCALE * PCM_SCALE
MIN_DURATION = 4.0
PRIOR_SIGMA_OCTAVES = 0.9
DEFAULT_PRIOR_BPM = 120.0
SNAP_WINDOW_S = 0.040
REFINE_ITERS = 3
MIN_SNAPS = 8
NO_PULSE_THRESHOLD = 0.3
DRIFT_MS = 25.0
SILENT_DB = -60.0
ENERGY_JUMP_DB = 6.0
ACCENT_MIN_CONFIDENCE = 0.2


# ── decode ────────────────────────────────────────────────────────────────────

def decode_bands(path, timeout=600):
    """Decode the first audio stream to three band-limited mono signals."""
    fc = ("[0:a:0]aresample=%d,aformat=channel_layouts=mono,asplit=3[a][b][c];"
          "[a]lowpass=f=150,lowpass=f=150[l];"
          "[b]highpass=f=150,lowpass=f=4000[m];"
          "[c]highpass=f=4000[h];[l][m][h]amerge=inputs=3[o]") % SR
    cmd = [ffmpeg_bin(), "-nostdin", "-v", "error", "-i", path, "-vn",
           "-filter_complex", fc, "-map", "[o]",
           "-f", "f32le", "-acodec", "pcm_f32le", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        fail("timeout", f"ffmpeg decode timed out after {timeout}s: {path}")
    if r.returncode != 0:
        fail("unexpected_error", f"ffmpeg decode failed: {ffmpeg_error_tail(r.stderr)}")
    a = array.array("f")
    raw = r.stdout
    a.frombytes(raw[: len(raw) - len(raw) % (4 * BANDS)])
    if sys.byteorder == "big":
        a.byteswap()
    return [a[i::BANDS] for i in range(BANDS)]


# ── envelope ─────────────────────────────────────────────────────────────────

def energies(sig, scale=PCM_SCALE):
    """Mean power per HOP-sample frame, in int16-scaled units."""
    k = scale * scale / HOP
    mul = operator.mul
    return [sum(map(mul, c, c)) * k
            for c in (sig[i:i + HOP] for i in range(0, len(sig) - HOP + 1, HOP))]


def log_flux(e):
    """Half-wave-rectified first difference of log10(1e-3 + E)."""
    lg = [math.log10(1e-3 + x) for x in e]
    return [0.0] + [max(0.0, lg[i] - lg[i - 1]) for i in range(1, len(lg))]


def onset_env(bands_e):
    """Sum of band fluxes minus a centred +-0.25 s moving mean, clamped at 0."""
    n = min(len(e) for e in bands_e)
    o = [0.0] * n
    for e in bands_e:
        f = log_flux(e[:n])
        for i in range(n):
            o[i] += f[i]
    w = int(FR * 0.25)
    pref = [0.0]
    for x in o:
        pref.append(pref[-1] + x)
    res = []
    for i in range(n):
        lo, hi = max(0, i - w), min(n, i + w + 1)
        res.append(max(0.0, o[i] - (pref[hi] - pref[lo]) / (hi - lo)))
    return res


def sample(o, t):
    """Envelope value near fractional frame t: max over frames int(t)-1..int(t)+2."""
    i = int(math.floor(t))
    best = 0.0
    for j in (i - 1, i, i + 1, i + 2):
        if 0 <= j < len(o) and o[j] > best:
            best = o[j]
    return best


def db(power):
    return 10 * math.log10(1e-12 + power / FULL_SCALE_POWER)


# ── tempo, phase, refinement ────────────────────────────────────────────────

def tempo(o, min_bpm, max_bpm, hint=None):
    """Best BPM on a 0.1 grid: comb of ACF at 1,2,4 x lag, times an octave prior."""
    n = len(o)
    mean = sum(o) / n
    x = [v - mean for v in o]
    mul = operator.mul
    ac = {}

    def acf_int(L):
        if L not in ac:
            ac[L] = (sum(map(mul, x[:n - L], x[L:])) / (n - L)) if 0 < L < n else 0.0
        return ac[L]

    def acf(lag):
        l0 = int(lag)
        f = lag - l0
        return acf_int(l0) * (1 - f) + acf_int(l0 + 1) * f

    center = hint or DEFAULT_PRIOR_BPM
    best = None
    for tenth in range(int(round(min_bpm * 10)), int(round(max_bpm * 10)) + 1):
        bpm = tenth / 10
        lag = FR * 60 / bpm
        s = sum(acf(lag * k) / k for k in (1, 2, 4) if lag * k < n - 1)
        prior = math.exp(-0.5 * (math.log2(bpm / center) / PRIOR_SIGMA_OCTAVES) ** 2)
        score = s * prior
        if best is None or score > best[0]:
            best = (score, bpm)
    coarse = best[1]

    # Fine stage: +-0.2 BPM at 0.005, scored on the ACF at power-of-two beat
    # multiples up to half the file. Long lags pin the period far more tightly
    # than one beat does, so a long bed does not drift off a 0.1 BPM grid
    # before refinement (whose snap window is only +-40 ms).
    best = None
    for step in range(-40, 41):
        bpm = coarse + step * 0.005
        if not (min_bpm <= bpm <= max_bpm):
            continue
        lag = FR * 60 / bpm
        s, k = 0.0, 1
        while lag * k < n / 2:
            s += acf(lag * k)
            k *= 2
        if best is None or s > best[0]:
            best = (s, bpm)
    return best[1] if best is not None else coarse


def phase(o, period):
    """Offset in [0, period) (quarter frames) maximising the grid's envelope sum."""
    best_s, best_p = -1.0, 0.0
    for q in range(int(period * 4)):
        p = q / 4
        s = 0.0
        t = p
        while t < len(o) - 2:
            s += sample(o, t)
            t += period
        if s > best_s:
            best_s, best_p = s, p
    return best_p


def refine(o, ph, period, min_bpm, max_bpm):
    """Snap grid beats to envelope peaks and least-squares refit a + k*P.

    Returns (phase, period, residuals_in_frames). A refit is kept only with at
    least MIN_SNAPS snaps and a period that stays in range and within 5%.
    """
    thr = sorted(o)[int(len(o) * 0.9)]
    w = int(FR * SNAP_WINDOW_S)
    resid = []
    for _ in range(REFINE_ITERS):
        pts = []
        k, t = 0, ph
        while t < len(o) - 1:
            lo, hi = max(0, int(t) - w), min(len(o), int(t) + w + 1)
            if hi > lo:
                j = max(range(lo, hi), key=lambda q: o[q])
                if o[j] > thr:
                    pts.append((k, j))
            k += 1
            t += period
        if len(pts) < MIN_SNAPS:
            break
        n_ = len(pts)
        sk = sum(p[0] for p in pts)
        sj = sum(p[1] for p in pts)
        skk = sum(p[0] * p[0] for p in pts)
        skj = sum(p[0] * p[1] for p in pts)
        den = n_ * skk - sk * sk
        if den == 0:
            break
        P = (n_ * skj - sk * sj) / den
        a = (sj - P * sk) / n_
        if P <= 0 or not (min_bpm <= 60 * FR / P <= max_bpm) or abs(P - period) > 0.05 * period:
            break
        ph, period = a, P
        resid = [j - (a + k * P) for k, j in pts]
    return ph, period, resid


# ── downbeat ─────────────────────────────────────────────────────────────────

def window_power(full, a, b):
    a, b = max(0, int(a)), min(len(full), int(b))
    if b <= a:
        return 0.0
    return sum(full[a:b]) / (b - a)


def energy_change_phase(full, beats, bpb, n_frames):
    """Bar phase voted by >= 6 dB jumps between consecutive 2-beat windows.

    Returns (phase, confidence) or None. Windows that run past the audio or
    are silent do not vote; within a run of adjacent jumping beats only the
    largest jump votes (a straddling window also jumps, one beat late).
    """
    jumps = []  # (j, |delta dB|)
    for j in range(2, len(beats) - 2):
        if beats[j + 2] > n_frames:
            break
        a = db(window_power(full, beats[j - 2], beats[j]))
        b = db(window_power(full, beats[j], beats[j + 2]))
        if a < SILENT_DB or b < SILENT_DB:
            continue
        if abs(b - a) >= ENERGY_JUMP_DB:
            jumps.append((j, abs(b - a)))
    votes = [0] * bpb
    i = 0
    while i < len(jumps):
        run = [jumps[i]]
        while i + 1 < len(jumps) and jumps[i + 1][0] == run[-1][0] + 1:
            i += 1
            run.append(jumps[i])
        votes[max(run, key=lambda r: r[1])[0] % bpb] += 1
        i += 1
    total = sum(votes)
    if total == 0:
        return None
    order = sorted(range(bpb), key=lambda k: -votes[k])
    win = order[0]
    if votes[win] * 3 < total * 2:          # clear majority: at least 2/3 of votes
        return None
    second = votes[order[1]] if bpb > 1 else 0
    conf = (votes[win] - second) / total * min(1.0, votes[win] / 2)
    return win, conf


def accent_phase(lowflux, o, beats, bpb):
    """Bar phase whose beats carry the most low-band flux (+0.5 x onset)."""
    cand = []
    for k in range(bpb):
        idx = range(k, len(beats), bpb)
        s = sum(sample(lowflux, beats[i]) for i in idx)
        s2 = sum(sample(o, beats[i]) for i in idx)
        cand.append((s + 0.5 * s2, k))
    cand.sort(reverse=True)
    best = cand[0][0]
    second = cand[1][0] if len(cand) > 1 else 0.0
    conf = (best - second) / best if best > 0 else 0.0
    return cand[0][1], conf


# ── sections ─────────────────────────────────────────────────────────────────

def label_bars(bar_db):
    """Label each bar high / mid / low / silent against the 80th-percentile bar."""
    audible = sorted(v for v in bar_db if v >= SILENT_DB)
    if not audible:
        return ["silent"] * len(bar_db)
    ref = audible[min(len(audible) - 1, int(len(audible) * 0.8))]
    out = []
    for v in bar_db:
        if v < SILENT_DB:
            out.append("silent")
        elif v >= ref - 3:
            out.append("high")
        elif v < ref - 9:
            out.append("low")
        else:
            out.append("mid")
    return out


def smooth_labels(labels):
    """Absorb single-bar islands whose two neighbours agree."""
    out = list(labels)
    for i in range(1, len(out) - 1):
        if out[i - 1] == out[i + 1] != out[i]:
            out[i] = out[i - 1]
    return out


def runs(labels):
    """[(label, start_index, end_index_exclusive), ...] of equal-label runs."""
    res = []
    for i, lab in enumerate(labels):
        if res and res[-1][0] == lab:
            res[-1] = (lab, res[-1][1], i + 1)
        else:
            res.append((lab, i, i + 1))
    return res


def events_from_runs(rs):
    """drop / breakdown / intro / outro events from labelled runs (bar indices)."""
    ev = []
    for i, (lab, b0, b1) in enumerate(rs):
        prev = rs[i - 1][0] if i > 0 else None
        last = i == len(rs) - 1
        if lab == "high" and prev in ("low", "mid"):
            ev.append(("drop", b0))
        elif lab == "low":
            if prev is None:
                ev.append(("intro", b0))
            elif last:
                ev.append(("outro", b0))
            elif prev in ("high", "mid"):
                ev.append(("breakdown", b0))
    return ev


# ── analysis ─────────────────────────────────────────────────────────────────

def analyze(path, bpm_hint=None, bpb=4, min_bpm=60.0, max_bpm=200.0):
    bands = decode_bands(path)
    n_samples = len(bands[0]) if bands else 0
    duration = n_samples / SR
    if n_samples == 0:
        fail("no_audio", f"No decodable audio samples in {path}")
    if duration < MIN_DURATION:
        fail("too_short", f"Audio is {duration:.2f}s; detect_beats needs at least {MIN_DURATION:.0f}s")

    be = [energies(b) for b in bands]
    n = min(len(e) for e in be)
    be = [e[:n] for e in be]
    o = onset_env(be)
    full = [be[0][i] + be[1][i] + be[2][i] for i in range(n)]
    peak = max(full) if full else 0.0
    audible = [i for i, v in enumerate(full) if peak > 0 and v > peak * 1e-3]
    first_aud = audible[0] if audible else 0
    last_aud = audible[-1] if audible else n - 1

    bpm = tempo(o, min_bpm, max_bpm, bpm_hint)
    period = FR * 60 / bpm
    ph = phase(o, period)
    ph, period, resid = refine(o, ph, period, min_bpm, max_bpm)
    bpm = 60 * FR / period

    # Grid beats (frames) from the first audible beat to the last audible frame.
    a0 = ph % period
    start_k = max(0, math.ceil((first_aud - period / 4 - a0) / period))
    beats = []
    t = a0 + start_k * period
    while t <= last_aud:
        beats.append(t)
        t += period
    if not beats:
        beats = [a0 + start_k * period]

    # Confidence: on-beat vs the sixteenth positions (P/4, 3P/4).
    on = sum(sample(o, b) for b in beats) / len(beats)
    off = sum(sample(o, b + period * f) for b in beats for f in (0.25, 0.75)) / (2 * len(beats))
    bpm_conf = max(0.0, min(1.0, (on - off) / (on + off))) if on + off > 0 else 0.0

    stability_ms = (math.sqrt(sum(r * r for r in resid) / len(resid)) / FR * 1000) if resid else None

    # Downbeat.
    ec = energy_change_phase(full, beats, bpb, n) if len(beats) >= 4 else None
    lowflux = log_flux(be[0])
    if ec is not None:
        k, d_conf = ec
        d_source = "energy_change"
    elif len(beats) >= bpb:
        k, d_conf = accent_phase(lowflux, o, beats, bpb)
        d_source = "accent"
        if d_conf < ACCENT_MIN_CONFIDENCE:
            k, d_source = 0, "first_beat"
    else:
        k, d_conf, d_source = 0, 0.0, "first_beat"
    k = min(k, len(beats) - 1)
    bar_frames = [beats[i] for i in range(k, len(beats), bpb)]
    bar_len = period * bpb

    # Sections: full bars from the downbeat; the pre-downbeat span joins the
    # first section, a trailing partial bar joins the last.
    full_bars = [b for b in bar_frames if b + bar_len <= n + 1e-6]
    bar_db = [db(window_power(full, b, b + bar_len)) for b in full_bars]
    labels = smooth_labels(label_bars(bar_db))
    rs = runs(labels)

    def ts(frame):
        # +HOP/2 samples: flux frames report ~half a hop early (measured).
        return round((frame + 0.5) / FR, 3)

    sections = []
    for i, (lab, b0, b1) in enumerate(rs):
        start = 0.0 if i == 0 else ts(full_bars[b0])
        end = round(duration, 3) if i == len(rs) - 1 else ts(full_bars[b1])
        powers = [window_power(full, full_bars[j], full_bars[j] + bar_len) for j in range(b0, b1)]
        sections.append({
            "start": start, "end": end, "bar_start": b0, "bar_end": b1,
            "energy": lab, "loudness_db": round(db(sum(powers) / len(powers)), 1),
        })
    events = [{"type": typ, "t": 0.0 if typ == "intro" else ts(full_bars[b]), "bar": b}
              for typ, b in events_from_runs(rs)]

    warning = None
    if bpm_conf < NO_PULSE_THRESHOLD:
        warning = "no_clear_pulse"
    elif stability_ms is not None and stability_ms > DRIFT_MS:
        warning = "tempo_drift"

    return {
        "input": os.path.abspath(path),
        "duration": round(duration, 3),
        "method": METHOD,
        "bpm": round(bpm, 2),
        "bpm_confidence": round(bpm_conf, 3),
        "bpm_hint": bpm_hint,
        "beat_period": round(period / FR, 4),
        "first_beat": ts(beats[0]),
        "beats": [ts(b) for b in beats],
        "beats_per_bar": bpb,
        "downbeat": ts(bar_frames[0]),
        "downbeat_confidence": round(d_conf, 3),
        "downbeat_source": d_source,
        "bar_length": round(bar_len / FR, 4),
        "bars": [ts(b) for b in bar_frames],
        "sections": sections,
        "events": events,
        "tempo_stability_ms": round(stability_ms, 1) if stability_ms is not None else None,
        "warning": warning,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Measure tempo, beat grid, first downbeat and energy sections of a music bed")
    parser.add_argument("--input", required=True, help="Audio or video file with an audio stream")
    parser.add_argument("--bpm-hint", type=float, default=None,
                        help="BPM you requested or expect. Picks the octave (double/half time); "
                             "a hint a few percent off does not move the measured tempo.")
    parser.add_argument("--beats-per-bar", type=int, default=4, help="Beats per bar (default: 4)")
    parser.add_argument("--min-bpm", type=float, default=60.0, help="Lowest tempo considered (default: 60)")
    parser.add_argument("--max-bpm", type=float, default=200.0, help="Highest tempo considered (default: 200)")
    parser.add_argument("--out", help="Write the JSON here and print {\"path\": \"<abs path>\"} instead")
    args = parser.parse_args()

    if args.beats_per_bar < 1:
        fail("invalid_args", "--beats-per-bar must be at least 1")
    if not (0 < args.min_bpm < args.max_bpm):
        fail("invalid_args", "--min-bpm must be positive and below --max-bpm")
    if args.bpm_hint is not None and args.bpm_hint <= 0:
        fail("invalid_args", "--bpm-hint must be positive")

    require_file(args.input)
    if not ffprobe_value(args.input, "stream=index", "a"):
        fail("no_audio", f"No audio stream in {args.input}")

    result = analyze(args.input, args.bpm_hint, args.beats_per_bar, args.min_bpm, args.max_bpm)

    if args.out:
        out_path = os.path.abspath(args.out)
        out_dir = os.path.dirname(out_path)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(result, f)
        print(json.dumps({"path": out_path}))
    else:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
