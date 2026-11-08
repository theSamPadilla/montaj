"""Audio and word timing to timed phones: frame features, then a segmental DP (route B) that places each word's phones against the audio,
between the line's own pauses. English by CMUdict (rules for unknown words), Portuguese by rules. Deterministic: no randomness here."""
import gzip, json, os, re, wave
import numpy as np

HOP = 160; WIN = 400; SR = 16000; FR = HOP / SR

VOWELS = {'aa','ae','ah','ax','ay','aw','eh','ey','ih','iy','ao','ow','oy','uh','uw','er'}
VIS = {'p':'PP','b':'PP','m':'PP','f':'FF','v':'FF','th':'TH','dh':'TH','t':'DD','d':'DD','k':'kk','g':'kk','ng':'kk','hh':'kk',
       'ch':'CH','jh':'CH','sh':'CH','zh':'CH','s':'SS','z':'SS','n':'nn','l':'nn','r':'RR','er':'RR','aa':'aa','ae':'aa','ah':'aa',
       'ax':'aa','ay':'aa','aw':'aa','eh':'E','ey':'E','ih':'I','iy':'I','y':'I','ao':'O','ow':'O','oy':'O','uh':'U','uw':'U','w':'U',
       'pau':'sil','ssil':'sil','sil':'sil'}

def klass(p):
    if p in ('pau','ssil','sil'): return 'sil'
    if p in VOWELS: return 'vowel'
    if p in ('m','n','ng','l','r','w','y'): return 'son'
    if p in ('v','z','dh','zh','jh'): return 'vfric'
    if p in ('f','s','sh','th','ch'): return 'fric'
    if p == 'hh': return 'hh'
    return 'stop'

# Emission: mean and spread of (energy 0..1, high-band share 0..1, voicing 0..1). Hand-set from phonetics, not trained.
EMIT = {'sil':((.04,.12),(.3,.5),(.2,.4)),'vowel':((.85,.2),(.04,.12),(.85,.25)),'son':((.62,.22),(.05,.14),(.8,.25)),
        'vfric':((.5,.22),(.3,.3),(.55,.3)),'fric':((.42,.25),(.62,.28),(.2,.25)),'hh':((.3,.2),(.3,.3),(.2,.3)),'stop':((.16,.2),(.3,.5),(.25,.4))}
DUR = {'sil':(12,12),'vowel':(9,4.5),'son':(6,3),'vfric':(7,3),'fric':(9,4),'hh':(5,3),'stop':(8,3.5)}

def read_wav(path):
    with wave.open(path) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768

def features(x):
    n = max(1, (len(x) - WIN) // HOP + 1)
    h = np.hanning(WIN)
    db, hf, vo, lo = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n)
    f = np.fft.rfftfreq(512, 1 / SR)
    b_hi, b_lo = f >= 3000, f < 800
    for i in range(n):
        s = x[i * HOP:i * HOP + WIN]
        if len(s) < WIN: s = np.pad(s, (0, WIN - len(s)))
        s = s - s.mean()
        P = np.abs(np.fft.rfft(s * h, 512)) ** 2
        t = P.sum() + 1e-12
        db[i] = 10 * np.log10(np.mean(s ** 2) + 1e-10)
        hf[i] = P[b_hi].sum() / t; lo[i] = P[b_lo].sum() / t
        r = np.fft.irfft(np.abs(np.fft.rfft(s, 1024)) ** 2)
        vo[i] = max(0., r[40:267].max() / (r[0] + 1e-12))
    floor, level = np.percentile(db, 5), np.percentile(db, 97)
    e = np.clip((db - floor) / max(level - floor, 6), 0, 1)
    return {'e': e, 'hf': hf, 'v': vo, 'lo': lo, 'db': db}

def emission(F):
    out = {}
    for k, ((a, sa), (b, sb), (c, sc)) in EMIT.items():
        s = -.5 * ((F['e'] - a) / sa) ** 2 - .5 * ((F['hf'] - b) / sb) ** 2 - .5 * ((F['v'] - c) / sc) ** 2
        out[k] = np.concatenate([[0.], np.cumsum(s)])
    return out

# ---- words and phones
CMUDICT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cmudict.dict.gz')

def load_cmudict(path=None):
    """The CMU pronouncing dictionary as {word: [phones]}. path: a plain or .gz file; None reads the one shipped in this folder."""
    path = str(path or CMUDICT)
    opener = gzip.open if path.endswith('.gz') else open
    d = {}
    with opener(path, 'rt', encoding='utf8', errors='ignore') as fh:
        for line in fh:
            line = line.split('#')[0].strip()
            if not line: continue
            w, *ph = line.split()
            if '(' in w: continue
            d[w.lower()] = [re.sub(r'\d', '', p).lower() for p in ph]
    return d

EN_RULES = [('tch','ch'),('sch','sh'),('ch','ch'),('sh','sh'),('th','th'),('ph','f'),('ng','ng'),('ck','k'),('qu','k w'),('ee','iy'),('ea','iy'),('oo','uw'),('ou','aw'),('ow','ow'),('ai','ey'),('ay','ey'),('oa','ow'),('a','ae'),('b','b'),('c','k'),('d','d'),('e','eh'),('f','f'),('g','g'),('h','hh'),('i','ih'),('j','jh'),('k','k'),('l','l'),('m','m'),('n','n'),('o','aa'),('p','p'),('q','k'),('r','r'),('s','s'),('t','t'),('u','ah'),('v','v'),('w','w'),('x','k s'),('y','iy'),('z','z')]
def rules_g2p(w, table=EN_RULES):
    w = re.sub(r"[^a-z]", '', w.lower()); out = []; i = 0
    if w.endswith('e') and len(w) > 3: w = w[:-1]
    while i < len(w):
        for a, b in table:
            if w.startswith(a, i):
                out += b.split(); i += len(a); break
        else: i += 1
        if out and len(out) > 1 and out[-1] == out[-2]: out.pop()
    return out

def whisper_words(path):
    j = json.load(open(path))
    out = []
    for t in j['transcription']:
        w = t['text'].strip()
        if not re.sub(r"[^\w]", '', w, flags=re.U): continue
        out.append({'w': w, 'start': t['offsets']['from'] / 1000, 'end': t['offsets']['to'] / 1000})
    return out

def phones_of(words, g2p):
    return [dict(w, ph=g2p(re.sub(r"[^\w']", '', w['w'].lower(), flags=re.U)) or ['ah']) for w in words]

# ---- Route B: segmental DP across the phrase, word starts held near whisper's by a soft prior
DMIN = {'sil': 3, 'vowel': 4, 'son': 3, 'vfric': 3, 'fric': 4, 'hh': 2, 'stop': 3}
def audio_pauses(F, min_s=.12):
    """Runs of quiet in the audio: [(start s, end s)]."""
    e = F['e']; lo, hi = np.percentile(e, 20), np.percentile(e, 95); q = e < lo + .02 * (hi - lo); out = []; st = None
    for i, v in enumerate(q):
        if v and st is None: st = i
        if not v and st is not None:
            if (i - st) * FR >= min_s: out.append((st * FR, i * FR))
            st = None
    return out


def route_b_phrased(words, F, sigma=70, end_slack=.55):
    """Route B between the line's own pauses. A word ending in punctuation closes a phrase at the first audio pause it can reach, so a word can't slide past a pause into the next phrase and leave everything after it late.
    Whisper's words are gapless, so its end for such a word is about the end of the pause: the pause must start after the word does and be within end_slack of that end."""
    P = audio_pauses(F); cuts = []; used = -1; T = len(F['e']) * FR
    for i, w in enumerate(words[:-1]):
        if not re.search(r"[,.;:!?]$", w['w']): continue
        for k, (a, b) in enumerate(P):
            if k > used and a > w['start'] + .05 and b >= w['end'] - end_slack and a <= w['end'] + end_slack:
                cuts.append((i, a, b)); used = k; break
    segs = []; i0 = 0; t0 = 0.
    for i, a, b in cuts + [(len(words) - 1, T, T)]:
        ch = words[i0:i + 1]
        if ch:
            f0, f1 = int(round(t0 / FR)), int(round(a / FR)); Fs = {k: v[f0:f1] for k, v in F.items()}
            q = route_b([dict(w, start=max(0., w['start'] - t0)) for w in ch], Fs, sigma=sigma)
            segs += [dict(g, s=g['s'] + t0, e=g['e'] + t0) for g in q]
        if b > a: segs.append({'p': 'sil', 's': a, 'e': b})
        i0 = i + 1; t0 = b
    return segs


def route_b(words, F, sigma=70, wdur=5.0, dmin_on=True):
    C = emission(F); T = len(F['e'])
    seq = []  # (phone, klass, optional, word start time or None)
    seq.append(('sil','sil',True,None))
    for w in words:
        for k, p in enumerate(w['ph']):
            seq.append((p, klass(p), False, w['start'] if k == 0 else None))
        seq.append(('sil','sil',True,None))
    M = len(seq); DMAX = 45; INF = -1e15
    best = np.full((M + 1, T + 1), INF); back = np.zeros((M + 1, T + 1, 2), dtype=np.int32)
    # Enter the first or second node at frame 0.
    def preds(i):
        out = []
        j = i - 1
        while j >= 0:
            out.append(j)
            if not seq[j][2]: break
            j -= 1
        return out
    for i, (p, k, opt, ws) in enumerate(seq):
        mu, sd = DUR[k]; Ck = C[k]
        dmin = DMIN[k] if dmin_on else (2 if k != 'sil' else 3)
        for t in range(dmin, T + 1):
            lo = max(0, t - DMAX if k != 'sil' else t - 150)
            ds = np.arange(lo, t - dmin + 1)
            if not len(ds): continue
            seg = Ck[t] - Ck[ds]
            dur = -.5 * wdur * ((t - ds - mu) / sd) ** 2
            if ws is not None: dur = dur - .5 * ((ds - ws / FR) / sigma) ** 2
            prev = np.full(len(ds), INF); which = np.full(len(ds), -1)
            if all(seq[j][2] for j in range(i)):
                z = ds == 0
                prev[z] = 0; which[z] = -1
            for j in preds(i):
                v = best[j, ds]
                m = v > prev
                prev[m] = v[m]; which[m] = j
            sc = prev + seg + dur
            q = int(np.argmax(sc))
            if sc[q] > INF / 2:
                best[i, t] = sc[q]; back[i, t] = (which[q], ds[q])
    # The end: the last non-optional node or anything optional after it, at T.
    last = max(i for i in range(M) if not seq[i][2])
    ends = [i for i in range(last, M) if best[i, T] > INF / 2]
    i = max(ends, key=lambda q: best[q, T]); t = T
    out = []
    while i >= 0 and t > 0:
        j, s = back[i, t]
        out.append({'p': seq[i][0], 's': float(s * FR), 'e': float(t * FR)})
        i, t = int(j), int(s)
    out.reverse()
    return out

# ---- Portuguese (Brazilian), by rule: whisper's spelling, old or new, to the same phone names the rest of this file uses.
def pt_g2p(word):
    w = word.lower().replace("'", '')
    for a, b in (('ph', 'f'), ('th', 't'), ('cc', 'c'), ('ff', 'f'), ('pp', 'p'), ('tt', 't'), ('ll', 'l'), ('mm', 'm'), ('nn', 'n'), ('dd', 'd'), ('gg', 'g'), ('bb', 'b'), ('y', 'i')):
        w = w.replace(a, b)
    V = 'aáàâãeéêiíoóôõuú'; out = []; i = 0; n = len(w)
    nxt = lambda k: w[k] if k < n else ''
    vowel = {'a':'aa','á':'aa','à':'aa','â':'ah','ã':'ah','e':'eh','é':'eh','ê':'ey','i':'iy','í':'iy','o':'ow','ó':'ao','ô':'ow','õ':'ow','u':'uw','ú':'uw'}
    while i < n:
        c = w[i]; d = nxt(i + 1); two = w[i:i + 2]
        if w[i:i + 2] == 'ão': out += ['aw', 'uw']; i += 2; continue
        if two == 'lh': out += ['l', 'y']; i += 2; continue
        if two == 'nh': out += ['n', 'y']; i += 2; continue
        if two == 'ch': out.append('sh'); i += 2; continue
        if two == 'rr': out.append('hh'); i += 2; continue
        if two == 'ss': out.append('s'); i += 2; continue
        if two == 'qu' and nxt(i + 2) in ('e', 'i', 'é', 'ê', 'í'): out.append('k'); i += 2; continue
        if two == 'gu' and nxt(i + 2) in ('e', 'i', 'é', 'ê', 'í'): out.append('g'); i += 2; continue
        if c in vowel:
            # A word's last unstressed e and o close to i and u; a nasal coda colours the vowel and doesn't close the lips.
            last = i == n - 1 or (i == n - 2 and d == 's')
            if c == 'e' and last and n > 2: out.append('iy')
            elif c == 'o' and last and n > 2: out.append('uw')
            else: out.append(vowel[c])
            i += 1; continue
        if c in 'mn' and (d == '' or d not in V): i += 1; continue
        if c == 'l' and (d == '' or d not in V): out.append('uw'); i += 1; continue
        if c == 'h': i += 1; continue
        if c == 'ç': out.append('s')
        elif c == 'c': out.append('s' if d in ('e', 'i', 'é', 'ê', 'í') else 'k')
        elif c == 'g': out.append('zh' if d in ('e', 'i', 'é', 'ê', 'í') else 'g')
        elif c == 'j': out.append('zh')
        elif c == 'x': out.append('sh')
        elif c == 'z': out.append('s' if d == '' else 'z')
        elif c == 's': out.append('z' if (out and i > 0 and w[i - 1] in V and d in V and d != '') else 's')
        elif c == 'r': out.append('hh' if i == 0 or d == '' else 'r')
        elif c == 't': out.append('ch' if d in ('i', 'í') or (d == 'e' and i + 2 >= n) else 't')
        elif c == 'd': out.append('jh' if d in ('i', 'í') or (d == 'e' and i + 2 >= n) else 'd')
        elif c in 'bfklmnpvw': out.append({'w': 'w'}.get(c, c))
        i += 1
    return out or ['ah']
