"""Prosody from the audio alone, in any language. Phrases, syllable peaks with a prominence score (loudness, pitch,
length), the prominent ones that carry a gesture, a liveliness per phrase and a pitch contour per phrase end. Reads no words.
Deterministic: no randomness here."""
import numpy as np
from .align import FR, HOP, SR, WIN, audio_pauses, features


def pitch(x, n):
    """Pitch in semitones from the speaker's median, 0 where unvoiced. Same algorithm as face.f0_track."""
    f = np.zeros(n)
    for i in range(n):
        s = x[i * HOP:i * HOP + WIN]
        if len(s) < WIN: continue
        s = s - s.mean()
        r = np.fft.irfft(np.abs(np.fft.rfft(s, 1024)) ** 2)
        if r[0] < 1e-8: continue
        lag = 40 + int(np.argmax(r[40:267]))
        if r[lag] / r[0] > .45: f[i] = SR / lag
    # A three-frame median, then semitones from the speaker's own middle.
    m = f.copy()
    for i in range(1, n - 1):
        m[i] = sorted(f[i - 1:i + 2])[1]
    v = m[m > 0]
    if not len(v): return np.zeros(n)
    st = np.zeros(n); mid = np.median(v)
    st[m > 0] = 12 * np.log2(m[m > 0] / mid)
    return st


def _z(a):
    a = np.asarray(a, dtype=float)
    return (a - a.mean()) / (a.std() + 1e-6)


def _phrases(F, min_gap=.16, min_len=.2):
    T = len(F['e']) * FR; out = []; t = 0.
    for a, b in audio_pauses(F, min_s=min_gap) + [(T, T)]:
        if a - t >= min_len: out.append((float(t), float(a)))
        t = b
    return out


def _prominence(y, i):
    """Height of a peak above the lower of the valleys on each side (to the next higher sample, or the edge)."""
    lo = []
    for rng in (range(i - 1, -1, -1), range(i + 1, len(y))):
        m = y[i]
        for k in rng:
            if y[k] > y[i]: break
            m = min(m, y[k])
        lo.append(m)
    return y[i] - min(lo)


def analyse(x):
    F = features(x); e = F['e']; v = F['v']; N = len(e); st = pitch(x, N)
    ph = _phrases(F)
    sm = np.convolve(np.pad(e, 1, mode='edge'), np.ones(3) / 3, mode='valid')  # about 30 ms
    inph = np.zeros(N, dtype=bool)
    for a, b in ph: inph[int(round(a / FR)):int(round(b / FR))] = True
    cand = []  # local maxima; a flat top (a clipped loudness) counts once, in its middle
    for i in range(1, N - 1):
        if sm[i] <= sm[i - 1]: continue
        j = i
        while j < N - 1 and sm[j + 1] == sm[i]: j += 1
        if j < N - 1 and sm[j + 1] > sm[i]: continue
        k = (i + j) // 2
        if inph[k] and v[k] > .3: cand.append(k)
    kept = []
    for i in sorted(cand, key=lambda i: (-sm[i], i)):
        if all(abs(i - k) * FR >= .1 for k in kept): kept.append(i)
    kept = sorted(k for k in kept if _prominence(sm, k) >= .08)
    peaks = []
    for i in kept:
        h = sm[i] / 2; a = i; b = i
        while a > 0 and sm[a - 1] >= h: a -= 1
        while b < N - 1 and sm[b + 1] >= h: b += 1
        peaks.append({'t': float(i * FR + WIN / SR / 2), 'loud': float(e[i]), 'pitch': float(st[i]), 'length': float((b - a + 1) * FR)})
    if peaks:
        sc = .5 * _z([p['loud'] for p in peaks]) + .4 * _z([p['pitch'] for p in peaks]) + .35 * _z([p['length'] for p in peaks])
        for p, s in zip(peaks, sc): p['score'] = float(s)
    prominent = []
    for p in sorted(peaks, key=lambda p: (-p['score'], p['t'])):
        if p['score'] < .2: break
        if all(abs(p['t'] - q['t']) >= .55 for q in prominent): prominent.append({'t': p['t'], 'p': float(min(p['score'], 2.))})
    prominent.sort(key=lambda q: q['t'])

    loud, rng, contour = [], [], []
    for a, b in ph:
        i0, i1 = int(round(a / FR)), int(round(b / FR)); vo = v[i0:i1] > .3
        loud.append(e[i0:i1][vo].mean() if vo.any() else 0.)
        s = st[i0:i1]; s = s[s != 0]
        rng.append(np.percentile(s, 90) - np.percentile(s, 10) if len(s) else 0.)
        j0 = max(i0, i1 - int(round(.35 / FR))); s = st[j0:i1]; idx = np.nonzero(s != 0)[0]
        if len(idx) < 5: contour.append({'kind': 'level', 'slope': 0.}); continue
        slope = float(np.polyfit((j0 + idx) * FR, s[idx], 1)[0])
        contour.append({'kind': 'rise' if slope > 4 else 'fall' if slope < -4 else 'level', 'slope': slope})
    if len(ph) > 1: live = 1 + .2 * (_z(loud) + _z(rng)) / 2
    else: live = np.ones(len(ph))
    return {'phrases': ph, 'peaks': peaks, 'prominent': prominent,
            'liveliness': [float(np.clip(u, .6, 1.4)) for u in live], 'contour': contour}
