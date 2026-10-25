"""Whether sound is a voice (§577 cut voice): numpy only, on the source's own samples, one reading a 10 ms frame.

Layer 1 (lib/speech_energy) read sound by its level alone, so a click, a bump or handling noise over the line was
sound, and a whisper word written on one kept a lone island. This module reads, for each 10 ms frame (FRAME_S, the
envelope's), a WINDOW_S window centred on it (the channel whose low-passed window is louder):
- pitch strength: the largest autocorrelation at a lag of PITCH_LAG_S (40-400 Hz: a deep voice and creak too) over the
  window's own energy (unbiased for the overlap), on the window after a light low-pass (LOWPASS_HZ). Normalized by
  the lag-0 energy, a click or a smack (its energy in a few ms) reads near 0; normalized by the overlapping parts'
  energies, a click at a window's edge read as pitched as a voice;
- the level of the low-passed window (`low`), the part the pitch is read on;
- (`features` only, for measuring) spectral flatness against the spectrum's own envelope. It decides nothing.
A frame is VOICED when its pitch strength is PITCH_MIN or over and its low-passed level is at or over the voice line
(lib/speech_energy: the low-passed room plus PROTECT_OVER_ROOM_DB, the room read on the same low-passed level). So
the room's own hum (pitched, at the room's level) never counts, not even under a click, whose energy lies above the
low-pass. A pitched sound over the room is a voice however soft: being quiet is no evidence of noise.

The rule (Sam's, with the orchestrator's binding calls, 2026-10-25): sound is dropped as no voice only when it is CUT
OFF from voiced speech. Sound is joined to a voiced frame when it reaches it through CONTINUOUSLY audible frames (each
at or over the audible line, the room plus PROTECT_OVER_ROOM_DB: no frame dropping to the room between them); a
PIECE is a run of such frames, and a piece holding no voiced frame is no voice (`noise_frames`, `noise_word`). An "s",
an "f" or a plosive runs on into its vowel, so it stays joined by construction, whatever its spectrum (measured on a
real file, an "s" reads like a click); a click with a dip to the room before the next word is cut off and goes. A
piece holding a frame lib/speech_energy keeps as a word's own sound (`keep`: a soft word's burst, a word that is
speech by its own evidence) is never no voice.
"""
import math
import os
import subprocess
import tempfile
import wave

import numpy as np

VERSION = "voice v2"              # v2: lags to 40 Hz, an 80 ms window, joined by audible sound, the low-passed room
RATE = 16000
FRAME_S = 0.01                    # the envelope's frame (lib/speech_energy.FRAME_S)
WINDOW_S = 0.08                   # each frame's reading: this long a window, centred on it (two periods at 40 Hz)
PITCH_LAG_S = (0.0025, 0.025)     # the autocorrelation lags read: 400 to 40 Hz (a deep voice, creak)
LOWPASS_HZ = 1000.0               # the light low-pass before the autocorrelation
FLAT_BAND_HZ = (80.0, 4000.0)     # the band the flatness is read over (the fundamental and the formants)
SMOOTH_HZ = 800.0                 # ... against the spectrum's own envelope, smoothed this wide (two harmonics at 400 Hz)
FLAT_FLOOR_DB = 30.0              # ... over the bins whose envelope is within this of the loudest
PITCH_MIN = 0.5                   # a frame this pitched or more is voiced: the middle of the gap measured on the real
                                  # file (clicks 0.17-0.18, voice 0.7-0.9); on the replicas no click, smack, handling
                                  # noise, "s", "sh" or white noise frame reached it, over a hum or not
DECODE_TIMEOUT_S = 600
_LOWPASS_TAPS = 31
_SILENT_DB = -120.0
_CHUNK = 512                      # frames read at once (memory: _CHUNK x the window, never the whole source)

STAMPED = ("RATE", "WINDOW_S", "PITCH_LAG_S", "LOWPASS_HZ", "_LOWPASS_TAPS", "PITCH_MIN")
STAMP = VERSION + " " + " ".join(f"{k}={globals()[k]}" for k in STAMPED)


def _kernel():
    """The short windowed-sinc low-pass at LOWPASS_HZ (_LOWPASS_TAPS, unit gain)."""
    n = np.arange(_LOWPASS_TAPS) - (_LOWPASS_TAPS - 1) / 2
    fc = LOWPASS_HZ / RATE
    h = 2 * fc * np.sinc(2 * fc * n) * np.hamming(_LOWPASS_TAPS)
    return h / h.sum()


def _segment(x, a, b, scale):
    """x[a:b] as float64 times scale, zeros beyond x's ends."""
    out = np.zeros(b - a)
    lo, hi = max(0, a), min(len(x), b)
    if hi > lo:
        out[lo - a:hi - a] = np.asarray(x[lo:hi], dtype=np.float64) * scale
    return out


def _local_flatness(p, smooth):
    """The spectral flatness of each row of power spectra p against its own envelope (p over p smoothed by `smooth`),
    over the bins whose envelope is within FLAT_FLOOR_DB of the row's loudest: about 0.56 for any noise, whatever its
    band (a click's, a bump's, a fricative's), and low for a spectrum of harmonics (each harmonic a peak, a valley
    between)."""
    env = np.apply_along_axis(lambda r: np.convolve(r, smooth, mode="same"), 1, p) + 1e-30
    ratio = p / env + 1e-12
    live = env >= env.max(axis=1, keepdims=True) * 10 ** (-FLAT_FLOOR_DB / 10)
    lg = np.where(live, np.log(ratio), 0.0)
    cnt = np.maximum(1, live.sum(axis=1))
    am = np.where(live, ratio, 0.0).sum(axis=1) / cnt
    return np.exp(lg.sum(axis=1) / cnt) / am


def features(x, n_frames=None, flatness=True, scale=1.0):
    """(pitch strength, flatness, energy, low energy, low frame energy) per FRAME_S frame of mono samples x (float, or
    int16 with `scale`) at RATE, each read on its WINDOW_S window (low: the mean square of the window after the
    low-pass, the part the pitch is read on; low frame: the same over the frame's own 10 ms, as the envelope reads,
    so the low-passed room is read at the envelope's resolution). Read _CHUNK frames at a time, so no copy of the
    whole source is made. Frames with no energy read pitch 0 and flatness 1. flatness False: not read (all 1), as the
    rule needs none."""
    hop = int(round(RATE * FRAME_S))
    n_frames = len(x) // hop if n_frames is None else n_frames
    half = int(round(RATE * WINDOW_S / 2))
    win = 2 * half
    lo_lag, hi_lag = (int(round(RATE * s)) for s in PITCH_LAG_S)
    lags = np.arange(lo_lag, hi_lag + 1)
    nfft = 1 << int(math.ceil(math.log2(2 * win)))
    freqs = np.fft.rfftfreq(nfft, 1 / RATE)
    band = (freqs >= FLAT_BAND_HZ[0]) & (freqs <= FLAT_BAND_HZ[1])
    hann = np.hanning(win)
    bins = max(3, int(round(SMOOTH_HZ / (RATE / nfft))) | 1)
    smooth = np.hanning(bins + 2)[1:-1]
    smooth /= smooth.sum()
    h, m = _kernel(), _LOWPASS_TAPS // 2
    pitch, flat, energy, low, low10 = (np.zeros(n_frames) for _ in range(5))
    for c0 in range(0, n_frames, _CHUNK):
        ks = np.arange(c0, min(n_frames, c0 + _CHUNK))
        s0 = c0 * hop + hop // 2 - half                         # the first window's first sample
        s1 = (ks[-1]) * hop + hop // 2 + half                    # the last window's end
        seg = _segment(x, s0 - m, s1 + m, scale)
        segl = np.convolve(seg, h, mode="same")[m:m + s1 - s0]  # the low-pass, as over the whole source
        seg = seg[m:m + s1 - s0]
        idx = (ks - c0)[:, None] * hop + np.arange(win)[None, :]
        w = seg[idx]
        e = (w ** 2).mean(axis=1)
        energy[ks] = e
        if flatness:
            p = np.abs(np.fft.rfft(w * hann, nfft)) ** 2
            flat[ks] = _local_flatness(p[:, band], smooth)
        else:
            flat[ks] = 1.0
        low10[ks] = (segl[((ks - c0) * hop + half - hop // 2)[:, None] + np.arange(hop)[None, :]] ** 2).mean(axis=1)
        wl = segl[idx]
        wl = wl - wl.mean(axis=1, keepdims=True)
        low[ks] = (wl ** 2).mean(axis=1)
        r = np.fft.irfft(np.abs(np.fft.rfft(wl, nfft)) ** 2, nfft)[:, :hi_lag + 1]
        # normalized by the window's own energy (lag 0), unbiased for the overlap: a click or a smack, whose energy
        # sits in a few ms, reads near 0 at every lag (normalized by the overlapping parts' energies instead, a click
        # at a window's edge read as pitched as a voice)
        norm = r[:, :1] * (win - lags) / win + 1e-20
        pitch[ks] = np.max(r[:, lags] / norm, axis=1)
        dead = e <= 1e-14
        pitch[ks[dead]], flat[ks[dead]] = 0.0, 1.0
    return pitch, flat, energy, low, low10


def like(pitch, flat=None):
    """Voice-like by its spectrum alone (no level): pitched (see the module docstring; flat decides nothing)."""
    return np.asarray(pitch) >= PITCH_MIN


def low_db(low):
    """dB of low energies (features' fourth reading)."""
    return 10 * np.log10(np.maximum(np.asarray(low, dtype=np.float64), 1e-12))


class Reading:
    """lib/voice's reading of a source, per envelope frame: pitched (bool: pitch strength PITCH_MIN or over), low (dB
    of the low-passed window) and low10 (dB of the low-passed frame's own 10 ms: the low-passed room is read on it)."""

    def __init__(self, pitched, low, low10=None):
        self.pitched = np.asarray(pitched, dtype=bool)
        self.low = np.asarray(low, dtype=np.float64)
        self.low10 = self.low if low10 is None else np.asarray(low10, dtype=np.float64)

    def __len__(self):
        return len(self.low)


def reading(pitch, low, low10=None):
    """A Reading from features' pitch, low energy and low frame energy."""
    return Reading(like(pitch), low_db(low), None if low10 is None else low_db(low10))


def samples(media):
    """[channels] int16 sample arrays (scale 1/32768) of the first audio stream of `media` at RATE, or None when it
    cannot be read (lib/speech_energy.envelope has read it already, and says why when it cannot)."""
    from lib.common import ff_path, ffmpeg_bin, run
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        try:
            r = run([ffmpeg_bin(), "-v", "error", "-y", "-i", ff_path(media), "-map", "0:a:0", "-ar", str(RATE),
                     "-c:a", "pcm_s16le", wav_path], timeout=DECODE_TIMEOUT_S, check=False)
        except subprocess.TimeoutExpired:
            return None
        if r.returncode != 0:
            return None
        with wave.open(wav_path, "rb") as w:
            ch = max(1, w.getnchannels())
            data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")    # 2 bytes a sample, as the envelope
    finally:
        if os.path.exists(wav_path):
            os.unlink(wav_path)
    n = len(data) // ch
    return [data[c:n * ch:ch] for c in range(ch)]


SCALE = 1.0 / 32768.0


def flags(media, n_frames):
    """lib/voice's Reading of `media` over n_frames envelope frames, each frame read on the channel whose low-passed
    window is louder; None when the audio cannot be read (the voice check is then off, and layer 1 reads by level
    alone as before)."""
    chans = samples(media)
    if not chans:
        return None
    best = None
    for x in chans:
        p, _, _, lo, l10 = features(x, n_frames, flatness=False, scale=SCALE)
        if best is None:
            best = (p, lo, l10)
        else:
            louder = lo > best[1]
            best = (np.where(louder, p, best[0]), np.maximum(lo, best[1]), np.maximum(l10, best[2]))
    return reading(*best)


# ── the rule, on layer 1's frames ───────────────────────────────────────────────────────────────────────────


def voiced(spectral, line):
    """bytearray: 1 for each pitched frame whose low-passed level is at or over `line` (spectral: a Reading); None
    when spectral is None (no check)."""
    if spectral is None:
        return None
    return bytearray((spectral.pitched & (spectral.low >= line)).astype(np.uint8).tobytes())


def pieces(env, line, keep=()):
    """[(first, end)) frames of each run of continuously audible frames: at or over `line`, or in `keep`."""
    out, k, n = [], 0, len(env)
    while k < n:
        if env[k] < line and k not in keep:
            k += 1
            continue
        m = k
        while m < n and (env[m] >= line or m in keep):
            m += 1
        out.append((k, m))
        k = m
    return out


def _no_voice(voice, keep, a, b):
    return not any(voice[a:b]) and not any(f in keep for f in range(a, b))


def noise_frames(env, line, voice, keep=()):
    """The frames of each piece (`pieces` at `line`, the audible line) that holds no voiced frame and no frame of
    `keep`: sound cut off from any voice. Empty when voice is None."""
    out = set()
    if voice is None:
        return out
    for a, b in pieces(env, line, keep):
        if _no_voice(voice, keep, a, b):
            out.update(range(a, b))
    return out


def joined(env, voice, line, a, b, keep=()):
    """Whether frames [a, b) (sound) reach a voiced frame through continuously audible frames (at or over `line`, or
    in keep): the pieces they lie in hold a voiced frame or a frame of keep. True when voice is None (no check)."""
    if voice is None:
        return True
    n = len(env)
    lo, hi = a, b
    while lo - 1 >= 0 and (env[lo - 1] >= line or lo - 1 in keep):
        lo -= 1
    while hi < n and (env[hi] >= line or hi in keep):
        hi += 1
    return not _no_voice(voice, keep, lo, hi)


def noise_word(env, voice, line, a, b, keep=()):
    """Whether a word whose whisper span is frames [a, b) is sound of no voice: its span holds audible sound (a frame
    at or over `line`), and every piece meeting its span (each piece whole, beyond the span too) holds no voiced
    frame and no frame of keep. Never a word with no sound (that is inaudible, as before), never one when voice is
    None."""
    if voice is None:
        return False
    hit = [f for f in range(a, b) if env[f] >= line]
    if not hit:
        return False
    return all(_no_voice(voice, keep, p0, p1) for p0, p1 in pieces(env, line, keep) if p0 < b and p1 > a
               and any(p0 <= f < p1 for f in hit))
