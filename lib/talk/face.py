#!/usr/bin/env python3
"""Audio, word timing and moods to a clip for the 68-key face: {duration, morphs, bones}.

  build(wav, whisper, lang, moods, gain=1.0, cmudict=None, sigma=70, phrased=True, head=None, expressive=1.0, recipe_data=None)
  returns (clip, report). `cmudict` is a path to a CMU dictionary (plain or .gz); None reads the one bundled with Montaj.

moods is a list of lines and beats, in any order:
  {"from": s, "to": s, "mood": "amused"}        a mood per line: a named expression (recipes.json "moods") held at a strength and
                                                 cross-faded at line changes. An unknown name raises, listing the known ones.
  {"at": s, "beat": "wince@0.8.R", "hold": .5}  a one-shot named expression (recipes.json "recipes"; "@strength" and ".R", mirrored,
                                                 optional): smoothstep in over the recipe's "in" to full at `at`, held `hold` s (default
                                                 .5), smoothstep out over its "out". A speech "drop" recipe yields its mouth and jaw keys
                                                 to loud speech (x (1 - loudness)), a "keep" one partly (x (1 - .6 loudness)), so speech
                                                 owns the mouth. Beats add to moods; sums clip to [0, 1].
The AI picks the moods and beats; everything else is computed from the audio. Above the mouth reads no words (prosody.py), so it holds
in any language; only the visemes need a language's rules.

head: the head's GLB, or the app's model.json. Gestures ask for millimetres and the head's own reach per key (reach.py) gives the weight, so ICT and GNM move
  the same distance; moods and beats scale the same way (recipes.weights). Without it, recipes.json's reference_reach_mm (C2, ICT).
expressive: one knob over the gesture layer: brow flashes, brows down, held lifts, squint and wide pulses, speech's lift of a smile,
  nods, phrase-end drops and tilts, look-aways with the head following, the breath's parted lips. 0 turns that layer off; moods, beats,
  blinks, today's carriage, sway, pitch lift and saccades stay.

Same audio, words, moods and arguments give the same bytes. Two random streams, both seeded from the audio's own hash: rng (seed) makes
the draws that place the blinks, the carriage and the sway; rng2 (seed + 1) makes every gesture choice.
The report holds: gestures [{t, kind, mm | deg | gain}] (mm on the face, degrees for head and eyes, the smile's gain),
beats, liveliness and contours per prosody phrase, prosodyPhrases, head (the GLB or "reference") and expressive. Nothing here reads video.
"""
import hashlib, json
import numpy as np
from . import prosody, reach, recipes
from .align import (FR, HOP, SR, VIS, WIN, features, load_cmudict, phones_of, pt_g2p, read_wav, route_b, route_b_phrased,
                    rules_g2p, whisper_words)

DT = 1 / 100  # the internal curves' rate
KEY_RATE = 48  # keys a second before thinning

# What each viseme asks of the mouth: its viseme key and the jaw's opening. Vowels' jaws scale with loudness below.
TARGET = {'PP': ('viseme_PP', 1.0, 0.0), 'FF': ('viseme_FF', .95, .05), 'TH': ('viseme_TH', .8, .1), 'DD': ('viseme_DD', .75, .12), 'kk': ('viseme_kk', .65, .16),
          'CH': ('viseme_CH', .85, .08), 'SS': ('viseme_SS', .85, .05), 'nn': ('viseme_nn', .7, .1), 'RR': ('viseme_RR', .7, .12),
          'aa': ('viseme_aa', .8, .5), 'E': ('viseme_E', .8, .28), 'I': ('viseme_I', .8, .14), 'O': ('viseme_O', .85, .32), 'U': ('viseme_U', .95, .12)}
# Rounding the visemes alone leave too weak on these heads, in key units.
ROUND = {'U': {'mouthPucker': .55, 'mouthFunnel': .25}, 'O': {'mouthFunnel': .45, 'mouthPucker': .12}}
# How hard each class holds its shape against its neighbours, and how far that reaches (s): Cohen and Massaro's dominance. Tighter than the first pass: on a voice at 5 syllables a second its wider reach averaged every shape down to about half, and the mouth hardly moved.
DOM = {'PP': (9., .04), 'FF': (7., .04), 'TH': (4., .035), 'DD': (3., .03), 'kk': (2., .035), 'CH': (4., .04), 'SS': (4., .04), 'nn': (2.5, .035), 'RR': (3., .04),
       'aa': (6., .055), 'E': (6., .05), 'I': (6., .05), 'O': (6.5, .06), 'U': (6.5, .06), 'sil': (.9, .07)}
LEAD = .03  # the lips reach a shape a little before its sound
TONGUE_HOLD = .7
TONGUE_TIP = {'DD', 'nn', 'TH'}
TONGUE_LIFT = {'DD': .4, 'nn': .45, 'TH': .45}  # tongueOut's peak per tip class: about 5 to 6 mm up on C2 and C3, nothing through the teeth
TONGUE_RISE, TONGUE_FALL, TONGUE_GAP = .06, .07, .1  # s

LOOKS = ('eyeLookOutLeft', 'eyeLookInRight', 'eyeLookInLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight')


def SHOULDER_TRACKS(bk, sv):
    """Both shoulders rise together: a turn about the body's forward axis, opposite on each side."""
    return {'mixamorig_LeftShoulder': [[round(float(x), 3), [0, round(float(v * SH_UP), 3), 0]] for x, v in zip(bk, sv)], 'mixamorig_RightShoulder': [[round(float(x), 3), [0, round(float(-v * SH_UP), 3), 0]] for x, v in zip(bk, sv)]}


SH_UP = -2.2  # this sign raises them on the stage, tested on a still


def ease(a, b, u):
    u = np.clip(u, 0, 1)
    return a + (b - a) * u * u * (3 - 2 * u)


def f0_track(x, n):
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


def smooth_env(y, attack, release, dt):
    out = np.zeros_like(y); v = float(y[0]) if len(y) else 0.
    ka, kr = 1 - np.exp(-dt / attack), 1 - np.exp(-dt / release)
    for i, u in enumerate(y):
        v += (u - v) * (ka if u > v else kr)
        out[i] = v
    return out


def smooth(y, tau, dt):
    """Forward and back, so nothing lags."""
    a = smooth_env(y, tau, tau, dt)
    return smooth_env(a[::-1], tau, tau, dt)[::-1]


def tongue_lift(segs, t):
    """tongueOut's curve on the times t (step DT) for the phones segs [{p, s, e}]: the tongue's own lift on T, D, N, L and TH.
    Each viseme key carries the jaw's opening with its bend, and on the built heads the two cancel: a full viseme_DD lifts the tip
    1.7 mm on C2 (ICT) and 4 mm on C3 (GNM) while the speech's jawOpen drops it 3 to 16 mm, so on those sounds it went down, never
    up, and read as static (Sam, 11-13). tongueOut is the one key that moves the tongue alone (12 to 13 mm up at full on both heads;
    on ICT forward too). Up over TONGUE_RISE before the contact, held through it, back over TONGUE_FALL after the release, so the tip
    reaches the ridge before the sound lets go; a dip under TONGUE_GAP s between two holds is filled (a closing), so it never flaps."""
    lift = np.zeros(len(t))
    for g in segs:
        v = VIS.get(g['p'], 'sil')
        if v in TONGUE_LIFT:
            a0, a1 = g['s'] - LEAD, max(g['e'] - LEAD, g['s'] - LEAD + .02)
            lift = np.maximum(lift, TONGUE_LIFT[v] * np.clip((t - (a0 - TONGUE_RISE)) / TONGUE_RISE, 0, 1) * np.clip(((a1 + TONGUE_FALL) - t) / TONGUE_FALL, 0, 1))
    n = int(round(TONGUE_GAP / 2 / DT)); win = np.lib.stride_tricks.sliding_window_view
    lift = win(np.pad(win(np.pad(lift, n, mode='edge'), 2 * n + 1).max(1), n, mode='edge'), 2 * n + 1).min(1)
    return smooth(lift, .012, DT)


def thin(t, y, tol):
    """Ramer-Douglas-Peucker on one curve: [[t, v], ...]."""
    keep = np.zeros(len(t), dtype=bool); keep[0] = keep[-1] = True; stack = [(0, len(t) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2: continue
        line = y[a] + (y[b] - y[a]) * (t[a + 1:b] - t[a]) / (t[b] - t[a]); d = np.abs(y[a + 1:b] - line)
        k = int(np.argmax(d))
        if d[k] > tol:
            k += a + 1; keep[k] = True; stack += [(a, k), (k, b)]
    return [[round(float(t[i]), 3), round(float(y[i]), 4)] for i in np.nonzero(keep)[0]]


def phrases_of(segs, gap=.16):
    """Runs of speech between the DP's pauses: [(start, end)]."""
    out = []; s = None; e = None
    for g in segs:
        if VIS.get(g['p'], 'sil') == 'sil' and g['e'] - g['s'] >= gap:
            if s is not None: out.append((s, e)); s = None
        elif VIS.get(g['p'], 'sil') != 'sil':
            if s is None: s = g['s']
            e = g['e']
    if s is not None: out.append((s, e))
    return out


def word_times(words, segs):
    """Each word's start and end from the DP's phones, in order."""
    out = []; i = 0; sp = [g for g in segs if VIS.get(g['p'], 'sil') != 'sil']
    for w in words:
        n = len(w['ph'])
        if i >= len(sp): break
        q = sp[i:i + n]; out.append({'w': w['w'], 's': q[0]['s'], 'e': q[-1]['e'], 'n': n}); i += n
    return out


def stresses(wt, F, st, min_gap=.55):
    """A prominence for each word (loudness, pitch, length per phone, against the rest), and the ones that carry a gesture."""
    if not wt: return []
    z = lambda a: (a - a.mean()) / (a.std() + 1e-6)
    e, p, d = [], [], []
    for w in wt:
        a, b = int(w['s'] / FR), max(int(w['s'] / FR) + 1, int(w['e'] / FR))
        e.append(F['e'][a:b].max()); s = st[a:b]; p.append(s[s != 0].max() if (s != 0).any() else -1); d.append((w['e'] - w['s']) / w['n'])
    pr = .5 * z(np.array(e)) + .4 * z(np.array(p)) + .35 * z(np.array(d))
    out = []
    for k in np.argsort(-pr):
        w = wt[k]
        if pr[k] < .2 or len(w['w']) <= 2: continue
        a, b = int(w['s'] / FR), max(int(w['s'] / FR) + 1, int(w['e'] / FR))
        at = (a + int(np.argmax(F['e'][a:b]))) * FR
        if all(abs(at - q['t']) >= min_gap for q in out):
            out.append({'t': float(at), 'p': float(min(pr[k], 2.)), 'w': w['w']})
    return sorted(out, key=lambda q: q['t'])


# gesture keys the gesture layer drives; one with no reach on a head silently does nothing (report: missingKeys)
GESTURE_KEYS = ('browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'browDownLeft', 'browDownRight', 'eyeSquintLeft', 'eyeSquintRight',
                'cheekSquintLeft', 'cheekSquintRight', 'eyeWideLeft', 'eyeWideRight', 'mouthLowerDownLeft', 'mouthLowerDownRight')


def build(wav, whisper, lang, moods, gain=1.0, cmudict=None, sigma=70, phrased=True, head=None, expressive=1.0, recipe_data=None, reach_mm=None):
    """moods: moods.json's list. head: a GLB or app model.json path for its reach, or None for the reference.
    expressive: the gesture layer's size, 0 for none. recipe_data: recipes.json's content, loaded when None. reach_mm: the head's reach
    (reach.reach), when the caller has it already; else it is read from `head`. Returns (clip, report)."""
    head_glb = head  # `head` becomes the head bone's curves below, as it always was
    RD = recipe_data if recipe_data is not None else recipes.load()
    lines = [m for m in moods if 'beat' not in m]; beats = [m for m in moods if 'beat' in m]
    moods_of = [recipes.mood(m['mood'], RD) for m in lines]  # an unknown name raises here, listing the known ones, before any work
    for b in beats: recipes.meta(b['beat'], RD)
    if reach_mm is None:
        reach_mm = reach.reach(head_glb) if head_glb else dict(RD['reference_reach_mm'])
    EX = max(0., float(expressive))
    wf = lambda key, mm: reach.weight_for(reach_mm, key, mm, cap=1)  # mm asked of this head to its weight
    x = read_wav(wav); F = features(x); N = len(F['e']); dur = len(x) / SR
    seed = int(hashlib.sha256(np.round(x * 32768).astype(np.int16).tobytes()).hexdigest()[:16], 16) % (2 ** 63)
    rng = np.random.default_rng(seed)
    if lang == 'pt': g2p = pt_g2p
    else:
        cmu = load_cmudict(cmudict)
        g2p = lambda w: cmu.get(w) or cmu.get(w.strip("'")) or rules_g2p(w)
    words = phones_of(whisper_words(whisper), g2p)
    segs = route_b_phrased(words, F, sigma=sigma) if phrased else route_b(words, F, sigma=sigma)
    st = f0_track(x, N)
    t = np.arange(0, dur + DT, DT); T = len(t)
    frame = lambda y: np.interp(t, np.arange(N) * FR + WIN / SR / 2, y)
    loud = smooth_env(frame(F['e']), .03, .09, DT)
    pitch = frame(st)
    # Prosody from the audio alone: phrases, prominent peaks {t, p}, liveliness and a contour per phrase. Its phrases are the
    # gestures' (the DP's below still carry the head and the blinks). Its pitch track is st, the same algorithm (test_prosody).
    rng2 = np.random.default_rng(seed + 1)  # every new choice draws here, so rng's draws, and the blinks, stay where they were
    P = prosody.analyse(x); pph = P['phrases']; prom = P['prominent']; LV = P['liveliness']
    ph_of = lambda tq: int(np.argmin([0 if a <= tq <= b else min(abs(tq - a), abs(tq - b)) for a, b in pph]))  # the phrase holding tq, else the nearest
    live = lambda tq: LV[ph_of(tq)] if pph else 1.
    ss = lambda a, b: ease(0., 1., (t - a) / max(b - a, 1e-3))  # 0 before a, 1 after b, smoothstep between
    bump = lambda a, b: np.where((t >= a) & (t <= b), .5 - .5 * np.cos(2 * np.pi * (t - a) / (b - a)), 0.)  # a raised cosine from a to b
    gest = []

    # ---- the mouth: dominance across the phones' targets
    Dsum = np.zeros(T); M = {}; jaw = np.zeros(T); closed = np.zeros(T)
    for g in segs:
        v = VIS.get(g['p'], 'sil'); a, tau = DOM[v]; d = g['e'] - g['s']
        tau = max(tau, .4 * d) if v in ('aa', 'E', 'I', 'O', 'U', 'sil') else tau
        c = (g['s'] + (.5 if v in ('aa', 'E', 'I', 'O', 'U', 'sil') else .35) * d) - LEAD
        D = a * np.exp(-(np.abs(t - c) / tau) ** 1.5)
        Dsum += D
        if v == 'sil': continue
        key, w, j = TARGET[v]
        M[key] = M.get(key, np.zeros(T)) + D * w
        for rk, rw in ROUND.get(v, {}).items(): M[rk] = M.get(rk, np.zeros(T)) + D * rw
        jaw += D * j
        if v in ('PP', 'U', 'O', 'FF'): closed += D * {'PP': 1., 'U': .85, 'O': .6, 'FF': .5}[v]
    Dsum += 1e-6
    morphs = {k: np.clip(smooth(v / Dsum, .01, DT) * gain, 0, 1) for k, v in M.items()}
    # The jaw follows the sound itself, on top of the phones: each syllable's loudness opens it, so it moves with the voice even where a phone sits a little off. The mouth leads the sound by LEAD.
    opening = smooth_env(np.interp(t + LEAD, t, frame(F['e'])), .025, .07, DT)
    jaw = np.clip(smooth(jaw / Dsum, .014, DT) * (.3 + .65 * opening) * gain + .05 * opening ** 2, 0, 1)
    closed = np.clip(closed / Dsum, 0, 1)
    morphs['jawOpen'] = jaw

    # ---- moods by line, ramped at each change
    ramp = .35
    # Each line's mood is a named expression at a strength (recipes.json), cross-faded the same way. Its smile keys are kept apart:
    # speech lifts them, and they give way on closed and rounded mouths as before. A smirk smiles on one side by its own keys.
    lev = {}; smL, smR = np.zeros(T), np.zeros(T); motion = np.ones(T)
    # A held mood takes no brow and lid floor: at a mood's low strength the floor held the lids a third shut all line long, and a
    # brow flash under narrowed lids read as sleepy, not raised (C2, 11-07). The floor stays for beats, which are brief and meant.
    RDm = {**RD, 'floor': {**RD.get('floor', {}), 'min': 0.}}
    for m, (rec, s, mo) in zip(lines, moods_of):
        s0, s1 = m['from'], m['to']
        w = np.clip((t - (s0 - ramp / 2)) / ramp, 0, 1) * np.clip(((s1 + ramp / 2) - t) / ramp, 0, 1)  # neighbours cross-fade: at a change they sum to one
        for k, v in (recipes.weights('%s@%r' % (rec, s), RDm, reach_mm) if rec else {}).items():
            if k == 'mouthSmileLeft': smL += w * v
            elif k == 'mouthSmileRight': smR += w * v
            else: lev[k] = lev.get(k, np.zeros(T)) + w * v
        motion += w * (mo - 1)
    # Speech lifts a held smile, x (1 + .35 pulse): after each peak of p >= .5 (rising from .2 s after it, full at .5 s, gone by .9 s)
    # and into the end of a phrase that falls or levels off (rising over its last .4 s, easing off over the .4 s after). The pulse is
    # times its phrase's liveliness and --expressive; a line with no smile stays without one.
    pulse = np.zeros(T); held = smL + smR
    for q in prom:
        if q['p'] < .5: continue
        c = q['t']; g = .35 * live(c) * EX
        pulse = np.maximum(pulse, g * np.where(t < c + .5, ss(c + .2, c + .5), 1 - ss(c + .5, c + .9)))
        if np.interp(c + .5, t, held) > 0: gest.append({'t': round(c + .5, 3), 'kind': 'smile', 'gain': round(float(g), 3)})
    for (a, b), cn, l in zip(pph, P['contour'], LV):
        if cn['kind'] not in ('fall', 'level'): continue
        g = .35 * l * EX
        pulse = np.maximum(pulse, g * np.where(t < b, ss(b - .4, b), 1 - ss(b, b + .4)))
        if np.interp(b, t, held) > 0: gest.append({'t': round(b, 3), 'kind': 'smile', 'gain': round(float(g), 3)})
    smL = smL * (1 + pulse); smR = smR * (1 + pulse)
    # Beats: in to full at `at`, held, out. Speech owns the mouth: a drop recipe's mouth and jaw keys yield all the way to loud
    # speech, a keep recipe's most of the way, so a laugh or a gasp never fights the visemes. Mouth here is any key named mouth* or jaw*.
    beat_rep = []
    for bt in beats:
        me = recipes.meta(bt['beat'], RD); W = recipes.weights(bt['beat'], RD, reach_mm)
        at = float(bt['at']); hd = float(bt.get('hold', .5))
        env = np.where(t < at, ss(at - me['in'], at), 1 - ss(at + hd, at + hd + me['out']))
        yld = 1 - (1. if me['speech'] == 'drop' else .6) * loud
        for k, v in W.items():
            y = env * v * (yld if k.startswith(('mouth', 'jaw')) else 1)
            if k == 'mouthSmileLeft': smL = smL + y
            elif k == 'mouthSmileRight': smR = smR + y
            else: lev[k] = lev.get(k, np.zeros(T)) + y
        beat_rep.append({'at': round(at, 3), 'beat': bt['beat'], 'hold': round(hd, 3), 'in': me['in'], 'out': me['out'], 'speech': me['speech'], 'keys': {k: round(v, 3) for k, v in sorted(W.items())}})
    for k, v in lev.items(): morphs[k] = morphs.get(k, np.zeros(T)) + v
    # A smile gives way on a closed or rounded mouth, so a p or an oo still reads; on m, b and p it gives way again below.
    give = 1 - .8 * smooth(closed, .02, DT)
    morphs['mouthSmileLeft'] = smL * give; morphs['mouthSmileRight'] = smR * give
    # corr_smile and corr_smile_jawOpen follow these on the stage (library/model3d/correctives.js).

    # ---- prosody gestures
    phrases = phrases_of(segs)
    wt = word_times(words, segs)
    marks = stresses(wt, F, st)
    # The stressed words still anchor the blinks and the shoulders below, but no longer move the brows or nod. Their brow side draw
    # is made and thrown away: rng's later draws (the carriage, the sway and the blinks) must land exactly where they did.
    for q in marks: rng.uniform(-.14, .14)
    # From the audio alone, each asked in mm of this head and times its phrase's liveliness and --expressive:
    # a brow flash on each peak of p >= .5, 3 to 6 mm by p, the outer brows 1.3 times that, each side 1 +- u (u from rng2 in +-.15).
    # Up from .15 s before the peak to .02 s before, held to .08 s after, then down over .35 s by (e^-4u - e^-4) / (1 - e^-4):
    # fast at first and easing out, landing on zero, so the fall reads as a release, not a slide. A low, loud peak (its pitch under
    # -1.5 st, loudness .7 or more) draws the brows down instead, 2.5 to 4 mm by p, with 1 mm of squint, and no flash.
    G = {}; flashes = []
    def put(key, mm, shape): G[key] = G.get(key, np.zeros(T)) + wf(key, mm) * shape
    pk_t = np.array([p['t'] for p in P['peaks']])
    for q in prom:
        if q['p'] < .5: continue
        c = q['t']; l = live(c) * EX; k = float(np.clip((q['p'] - .5) / 1.5, 0, 1))
        u = rng2.uniform(-.15, .15)  # drawn for every such peak, whichever way it goes
        pk = P['peaks'][int(np.argmin(np.abs(pk_t - c)))]
        fu = np.clip((t - (c + .08)) / .35, 0, 1)
        shape = np.where(t < c + .08, ss(c - .15, c - .02), (np.exp(-4 * fu) - np.exp(-4)) / (1 - np.exp(-4)))
        if pk['pitch'] < -1.5 and pk['loud'] >= .7:
            mm = (2.5 + 1.5 * k) * l
            put('browDownLeft', mm * (1 + u), shape); put('browDownRight', mm * (1 - u), shape)
            put('eyeSquintLeft', 1. * l, shape); put('eyeSquintRight', 1. * l, shape)
            gest.append({'t': round(c, 3), 'kind': 'down', 'mm': round(mm, 2)})
        else:
            mm = (3 + 3 * k) * l
            put('browInnerUp', mm, shape); put('browOuterUpLeft', 1.3 * mm * (1 + u), shape); put('browOuterUpRight', 1.3 * mm * (1 - u), shape)
            gest.append({'t': round(c, 3), 'kind': 'flash', 'mm': round(mm, 2)}); flashes.append((c, shape, l, k))
    # A phrase pitched over 2 st above the clip's voiced median holds the inner brows up 1.5 mm across it, .3 s ramps on its edges.
    vo = st[st != 0]; mid = float(np.median(vo)) if len(vo) else 0.
    for (a, b), l in zip(pph, LV):
        s = st[int(round(a / FR)):int(round(b / FR))]; s = s[s != 0]
        if len(s) and s.mean() - mid > 2:
            mm = 1.5 * l * EX; put('browInnerUp', mm, ss(a - .15, a + .15) * (1 - ss(b - .15, b + .15)))
            gest.append({'t': round(a, 3), 'kind': 'lift', 'mm': round(mm, 2)})
    # The lids on the strongest peaks (p >= 1): 1 mm of eyeSquint and 1.5 mm of cheekSquint, a .5 s pulse from .35 s after the peak,
    # and only where a smile is held: a smile reaching the eyes after the point is made. On the peak itself it narrowed the lids
    # under the brow flash, and the flash read as a frown (C2, 11-07).
    for q in prom:
        if q['p'] < 1. or np.interp(q['t'] + .5, t, smL + smR) <= 0: continue
        c = q['t']; l = live(c) * EX; sh = bump(c + .35, c + .85)
        for sd in ('Left', 'Right'): put('eyeSquint' + sd, 1. * l, sh); put('cheekSquint' + sd, 1.5 * l, sh)
        gest.append({'t': round(c, 3), 'kind': 'squint', 'mm': round(l, 2)})
    for k, v in G.items(): morphs[k] = morphs.get(k, np.zeros(T)) + v

    # ---- head: a new carriage for each phrase, a slow sway, the pitch's lift, and the nods
    yaw_t, roll_t = np.zeros(T), np.zeros(T)
    last = 0.
    for k, (a, b) in enumerate(phrases):
        y = rng.uniform(2., 5.5) * (-np.sign(last) if last else rng.choice([-1, 1])); last = y
        r = y * rng.uniform(-.25, .4) + rng.uniform(-.8, .8)
        i = t >= a - .25
        yaw_t[i] = y; roll_t[i] = r
    yaw = smooth(yaw_t, .17, DT); roll = smooth(roll_t, .2, DT)
    ph = rng.uniform(0, 6.28, 6)
    sway = lambda i, amp, hz: amp * np.sin(2 * np.pi * hz * t + ph[i])
    yaw = yaw + sway(0, .55, .31) + sway(1, .3, .67); roll = roll + sway(2, .35, .23)
    lift = -np.clip(smooth(np.where(pitch != 0, pitch, 0), .12, DT) * .32, -2.5, 2.5)
    # A nod on every prominent peak, down 1.5 to 4 degrees by p, shaped as the old one. A phrase that falls drops the head 1.5 degrees
    # over its last .4 s; one that rises tilts it 2 degrees (side from rng2) and lifts it 1. Each comes back in the pause after
    # (over the pause, .2 to .8 s; .5 s after the last phrase). Positive pitch is down, as the nods always were.
    gp, gr = np.zeros(T), np.zeros(T)
    for q in prom:
        c = q['t']; d = (1.5 + 2.5 * float(np.clip(q['p'] / 2, 0, 1))) * EX
        gp += d * np.where(t < c - .04, np.exp(-((t - c + .04) / .1) ** 2), np.exp(-((t - c + .04) / .26) ** 2))
        gest.append({'t': round(c, 3), 'kind': 'nod', 'deg': round(d * live(c), 2)})
    for i, ((a, b), cn, l) in enumerate(zip(pph, P['contour'], LV)):
        back = float(np.clip(pph[i + 1][0] - b, .2, .8)) if i + 1 < len(pph) else .5
        env = np.where(t < b, ss(b - .4, b), 1 - ss(b, b + back))
        if cn['kind'] == 'fall':
            gp += 1.5 * EX * env; gest.append({'t': round(b, 3), 'kind': 'drop', 'deg': round(1.5 * EX * l, 2)})
        elif cn['kind'] == 'rise':
            sd = float(rng2.choice([-1, 1])); gr += 2. * sd * EX * env; gp -= 1. * EX * env
            gest.append({'t': round(b, 3), 'kind': 'tilt', 'deg': round(2. * sd * EX * l, 2)})
    # Liveliness scales all of the head, the carriage, sway and pitch lift with the gestures, and so does the mood's motion: each
    # prosody phrase's own, switching halfway through the pause between two.
    if pph:
        gap = np.stack([np.where((t >= a) & (t <= b), 0., np.minimum(np.abs(t - a), np.abs(t - b))) for a, b in pph])
        Lt = smooth(np.array(LV)[np.argmin(gap, 0)], .15, DT)
    else: Lt = np.ones(T)
    if EX < 1: Lt = 1 + EX * (Lt - 1)  # expressive 0 holds the head at its mood's own motion, no phrase liveliness
    pitch_d = lift + gp + sway(3, .4, .29) + sway(4, .2, .71); roll = roll + gr
    mot = smooth(motion, .1, DT) * Lt
    head = np.stack([pitch_d * mot, roll * mot, yaw * mot], 1)

    # ---- blinks: about every 3 s, drawn to pauses and to the stressed words
    anchors = sorted([b for _, b in phrases] + [a - .05 for a, _ in phrases] + [q['t'] - .05 for q in marks])
    blink = np.zeros(T); bl_times = []; at = rng.uniform(.5, 1.4)
    while at < dur - .1:
        near = [a for a in anchors if abs(a - at) <= .6 and a > (bl_times[-1] + 1. if bl_times else .15)]
        c = min(near, key=lambda a: abs(a - at)) if near else at
        for c2 in ([c, c + .32] if rng.random() < .14 else [c]):
            bl_times.append(float(c2))
            u = np.where(t < c2, np.clip((t - (c2 - .075)) / .075, 0, 1), np.clip(1 - (t - (c2 + .03)) / .14, 0, 1))
            blink = np.maximum(blink, u * u * (3 - 2 * u) * .95)
        at = bl_times[-1] + rng.gamma(4., .75) + .5
    # A brow flash opens the eyes: .6 to 1.2 mm of eyeWide by its strength, on the flash's own shape, and any held squint gives way to
    # it, 70% at the flash's top. Raised brows over narrowed lids read as a frown (C2, 11-07). Not within .25 s of a blink: a lid
    # opening wide into a blink reads as a twitch.
    FE = np.zeros(T)
    for c, shape, l, k in flashes:
        FE = np.maximum(FE, shape)
        if any(c - .2 <= b <= c + .45 for b in bl_times): continue
        for sd in ('Left', 'Right'): morphs['eyeWide' + sd] = morphs.get('eyeWide' + sd, np.zeros(T)) + wf('eyeWide' + sd, (.6 + .6 * k) * l) * shape
        gest.append({'t': round(c, 3), 'kind': 'wide', 'mm': round((.6 + .6 * k) * l, 2)})
    for k_ in ('eyeSquintLeft', 'eyeSquintRight', 'cheekSquintLeft', 'cheekSquintRight'):
        if k_ in morphs: morphs[k_] = morphs[k_] * (1 - .7 * min(1., EX) * FE)

    # ---- gaze: the eyes hold the camera against the head, look away to start some phrases, and small saccades
    gx, gy = np.zeros(T), np.zeros(T)
    # About half the prosody phrases start with a look away, 6 to 12 degrees to a side (times liveliness and --expressive) and a
    # little up or down, from .12 s before the phrase, back by its first prominent peak at least .25 s in (sooner reads as a flick)
    # or by .8 s, whichever is sooner. Past 8 degrees the head turns 30% of the way, .1 s ahead of the eyes; the eyes' hold below
    # takes that turn back out of them, so the look still lands where it was aimed. Saccades as before. All draws from rng2.
    yf = np.zeros(T)
    for i, (a, b) in enumerate(pph):
        if rng2.random() >= .5: continue
        d = float(rng2.choice([-1, 1]) * rng2.uniform(6, 12)); e = rng2.uniform(-.04, .07)
        d *= LV[i] * EX; e *= LV[i] * EX
        a1 = min(a + .8, b)
        hit = [q['t'] for q in prom if a + .25 <= q['t'] <= b]
        if hit: a1 = min(a1, hit[0])
        j = (t >= a - .12) & (t < a1); gx[j] = d / 30; gy[j] = e  # one look unit is about 30 degrees of eye
        if abs(d) > 8: yf[(t >= a - .22) & (t < a1 - .1)] = .3 * d
        gest.append({'t': round(a, 3), 'kind': 'look', 'deg': round(d, 2), 'follow': bool(abs(d) > 8)})
    head[:, 2] += smooth(yf, .1, DT)
    at = rng2.uniform(.3, .9); mx, my = np.zeros(T), np.zeros(T)
    while at < dur:
        i = t >= at
        mx[i] = rng2.uniform(-.045, .045); my[i] = rng2.uniform(-.025, .025)
        at += rng2.uniform(.45, 1.5)
    gx = smooth(gx + mx, .012, DT); gy = smooth(gy + my, .012, DT)
    # One unit of a look key is about 30 degrees of eye: a head yaw of +z (the character's left) is held by looking to its right.
    hold = -head[:, 2] / 30
    lx = gx + hold
    own = {k: morphs.pop(k) for k in LOOKS if k in morphs}  # a mood's or beat's own look (sad looks down), added back on top
    # Elsewhere the lids close with a downward look and lift with an upward one, in the rig already.
    morphs['eyeLookOutLeft'] = np.maximum(lx, 0); morphs['eyeLookInRight'] = np.maximum(lx, 0)
    morphs['eyeLookInLeft'] = np.maximum(-lx, 0); morphs['eyeLookOutRight'] = np.maximum(-lx, 0)
    morphs['eyeLookUpLeft'] = np.maximum(gy, 0); morphs['eyeLookUpRight'] = np.maximum(gy, 0)
    morphs['eyeLookDownLeft'] = np.maximum(-gy, 0) * 1.0; morphs['eyeLookDownRight'] = np.maximum(-gy, 0) * 1.0
    for k, v in own.items(): morphs[k] = morphs[k] + v
    morphs['eyeBlinkLeft'] = np.maximum(morphs.get('eyeBlinkLeft', 0), blink); morphs['eyeBlinkRight'] = np.maximum(morphs.get('eyeBlinkRight', 0), blink)

    # ---- lips that truly close: on m, b and p the mouth shuts, whatever the neighbours ask. Blending alone reached about .6 on a fast voice, and a closure that never lands reads as out of sync.
    cl = np.zeros(T)
    for g in segs:
        if g['p'] in ('m', 'b', 'p'):  # bilabial
            c0 = (g['s'] + g['e']) / 2 - LEAD; hw = max(.04, (g['e'] - g['s']) / 2)
            cl = np.maximum(cl, np.exp(-(np.abs(t - c0) / hw) ** 4))
    for k in list(morphs):
        if (k.startswith('viseme_') and k != 'viseme_PP') or k in ('mouthPucker', 'mouthFunnel'): morphs[k] = morphs[k] * (1 - cl)
    morphs['viseme_PP'] = np.maximum(morphs.get('viseme_PP', np.zeros(T)), .98 * cl); morphs['jawOpen'] = morphs['jawOpen'] * (1 - .92 * cl)
    morphs['mouthSmileLeft'] = morphs['mouthSmileLeft'] * (1 - .85 * cl); morphs['mouthSmileRight'] = morphs['mouthSmileRight'] * (1 - .85 * cl)
    # Lip-parting keys from moods, beats and the breath give way on m, b and p like the visemes, or a p under a grin never shuts.
    for k in ('mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthLowerDownLeft', 'mouthLowerDownRight'):
        if k in morphs: morphs[k] = morphs[k] * (1 - cl)

    # ---- the tongue rides these keys (e1), baked at a fraction of full per key. Only the tip consonants get a short hold, so it shows on T, D, N, L, TH and flicks back; K, G, S, SH, R stay at their blended weight. It should be noticed only when it's missing.
    tall = np.zeros(T); hold = {}
    for g in segs:
        v = VIS.get(g['p'], 'sil')
        if v in TONGUE_TIP:
            d = g['e'] - g['s']; c0 = g['s'] + .6 * d - LEAD; hw = min(max(.03, .4 * d), .04); w = np.exp(-(np.abs(t - c0) / hw) ** 2); hold[v] = np.maximum(hold.get(v, np.zeros(T)), w); tall = np.maximum(tall, w)
    for v, w in hold.items():
        k = TARGET[v][0]; morphs[k] = np.maximum(morphs.get(k, np.zeros(T)), TONGUE_HOLD * smooth(w, .006, DT) * (1 - cl))
    for k in ('viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U'):
        if k in morphs: morphs[k] = morphs[k] * (1 - .35 * smooth(tall, .006, DT))
    # ---- the tongue's own lift (tongue_lift): gives way on m, b and p like the visemes.
    morphs['tongueOut'] = np.maximum(morphs.get('tongueOut', np.zeros(T)), tongue_lift(segs, t) * (1 - cl))

    # ---- a breath in through parted lips in each pause of .3 s or more before a phrase: mouthLowerDown up to .08 on the reference
    # head (asked as its mm, so every head parts the same), from up to .45 s before the phrase, closing as it starts. The jaw stays
    # the mouth's.
    for i, (a, b) in enumerate(pph):
        p0 = pph[i - 1][1] if i else 0.
        if a - p0 < .3: continue
        r0 = max(p0 + .05, a - .45); sh = ss(r0, r0 + .15) * (1 - ss(a - .08, a + .02))
        mm = .08 * RD['reference_reach_mm']['mouthLowerDownLeft'] * LV[i] * EX
        for k in ('mouthLowerDownLeft', 'mouthLowerDownRight'): morphs[k] = morphs.get(k, np.zeros(T)) + wf(k, mm) * sh
        gest.append({'t': round(a, 3), 'kind': 'breath', 'mm': round(mm, 2)})
    # ---- browDown and browInnerUp are never both over .15 at once: together they don't add, they fight (6.7 mm in 3D21). Where both
    # would be, the smaller comes down to .15. The inner brow is one key for both sides, so it's weighed against the larger side.
    if 'browInnerUp' in morphs and ('browDownLeft' in morphs or 'browDownRight' in morphs):
        z = np.zeros(T); bi = np.clip(morphs['browInnerUp'], 0, 1)
        bd = {k: np.clip(morphs.get(k, z), 0, 1) for k in ('browDownLeft', 'browDownRight')}
        bi = np.where((bi > .15) & (np.maximum(*bd.values()) > .15) & (bi < np.maximum(*bd.values())), .15, bi)
        morphs['browInnerUp'] = bi
        for k, v in bd.items():
            if k in morphs: morphs[k] = np.where((bi > .15) & (v > .15), .15, v)

    # ---- breath: a breath in during each pause before a phrase, out slowly across it, with the chest and shoulders. A small lift of the shoulders with stressed words. Added to what the body already plays.
    br = np.full(T, .25); pa = [(0., phrases[0][0])] + [(phrases[i][1], phrases[i + 1][0]) for i in range(len(phrases) - 1)] if phrases else []
    for (a_, b_), (s1, e1) in zip(pa, phrases):
        up = (t >= b_ - .35) & (t < s1 + .02); br[up] = np.maximum(.25, np.clip((t[up] - (b_ - .35)) / .3, 0, 1))
        dn = (t >= s1 + .02) & (t < e1 + .05); br[dn] = 1 - .85 * (t[dn] - s1) / max(e1 - s1, .1)
    br = smooth(br, .08, DT); sh = br.copy()
    for q in marks: sh += (.25 + .2 * q['p']) * np.exp(-((t - q['t']) / .16) ** 2)
    sh = smooth(sh, .03, DT)
    bk = np.arange(0, dur + 1e-6, .1); bv = np.interp(bk, t, br); sv = np.interp(bk, t, sh); dv = np.interp(bk, t, smooth(sh - br, .03, DT))
    body = {'chest': [[round(float(x), 3), [round(float(-1.5 * v), 3), 0, 0]] for x, v in zip(bk, bv)], 'mixamorig_Spine1': [[round(float(x), 3), [round(float(-.7 * v), 3), 0, 0]] for x, v in zip(bk, bv)]}
    body.update(SHOULDER_TRACKS(bk, sv))

    # ---- the clip
    tk = np.arange(0, dur + 1e-6, 1 / KEY_RATE)
    out = {'duration': round(float(dur), 3), 'morphs': {}, 'bones': {}}
    for k in sorted(morphs):
        y = np.clip(np.interp(tk, t, morphs[k]), 0, 1)
        if y.max() < .003: continue
        out['morphs'][k] = thin(tk, y, .004)
    hk = np.stack([np.interp(tk, t, head[:, i]) for i in range(3)], 1)
    keep = sorted(set(q[0] for i in range(3) for q in thin(tk, hk[:, i], .04)))
    idx = sorted(set(int(i) for i in np.clip(np.round(np.array(keep) * KEY_RATE).astype(int), 0, len(tk) - 1)))
    out['bones']['head'] = [[round(float(tk[i]), 3), [round(float(v) * .66, 3) for v in hk[i]]] for i in idx]
    out['bones']['neck'] = [[round(float(tk[i]), 3), [round(float(v) * .34, 3) for v in hk[i]]] for i in idx]
    out['bones'].update(body)
    rep = {'seed': seed, 'phones': len(segs), 'phrases': [[round(a, 3), round(b, 3)] for a, b in phrases], 'stresses': [{**q, 't': round(q['t'], 3), 'p': round(q['p'], 2)} for q in marks], 'blinks': [round(b, 3) for b in bl_times],
           'keysBytes': len(json.dumps(out)), 'segs': [{'p': g['p'], 's': round(g['s'], 3), 'e': round(g['e'], 3)} for g in segs]}
    rep.update({'gestures': sorted(gest, key=lambda g: (g['t'], g['kind'])) if EX > 0 else [], 'beats': beat_rep,
                'prosodyPhrases': [[round(a, 3), round(b, 3)] for a, b in pph], 'liveliness': [round(u, 3) for u in LV],
                'contours': [{'kind': c['kind'], 'slope': round(c['slope'], 2)} for c in P['contour']], 'head': head_glb or 'reference', 'expressive': EX,
                'missingKeys': sorted(k for k in GESTURE_KEYS if not reach_mm.get(k))})
    return out, rep

