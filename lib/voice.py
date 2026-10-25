"""Whether sound is a voice (§577 cut voice): numpy only, on the source's own samples, one reading a 10 ms frame.

Layer 1 (lib/speech_energy) read sound by its level alone, so a click, a bump or handling noise over the line was
sound, and a whisper word written on one kept a lone island. This module reads, for each 10 ms frame (FRAME_S, the
envelope's), a WINDOW_S window centred on it (the channel whose low-passed window is louder):
- pitch strength: the largest autocorrelation at a lag of PITCH_LAG_S (80-400 Hz) over the window's own energy
  (unbiased for the overlap), on the window after a light low-pass (LOWPASS_HZ). Normalized by the lag-0 energy, a
  click or a smack (its energy in a few ms) reads near 0; normalized by the overlapping parts' energies, a click at a
  window's edge read as pitched as a voice;
- (`features` only, for measuring) spectral flatness against the spectrum's own envelope. It decides nothing: on the
  synthetic replicas it separated no class that pitch did not, and as a second test it could only make more sound
  read as no voice.
A frame is VOICED when its pitch strength is PITCH_MIN or over and its low-passed part (the part the pitch is read on)
is at or over the voice line, the room plus lib/speech_energy.PROTECT_OVER_ROOM_DB (the lowest a soft word's burst
reaches). So the room's own hum (pitched, at the room's level: the room is the 10th-percentile quiet frame) never
counts, not even under a click, whose energy lies above the low-pass (gated by the whole frame's level instead, a
click over a hum read the hum's pitch at the click's level). A pitched sound over the room is a voice however soft:
being quiet is no evidence of noise. One voiced frame is enough: sound is read as no voice only when EVERY frame of it
says so (the guard's "all frames non-voice"), so a chance pitched frame of noise keeps that noise, never the other
way round.

The rule (Sam's, with the orchestrator's binding note, 2026-10-25): sound counts as speech when it is over the line
AND a voice, but sound is dropped as no voice only when it is CUT OFF from voiced speech: a run of frames over its line
(a quiet gap under the line on both sides) holding no voiced frame, with no voiced frame within VOICE_REACH_S of either
of its edges. Sound attached to a voiced word (an "s", an "f", a "t", a soft unpitched syllable) is never touched,
whatever its spectrum: measured on a real file, an "s" inside a word reads like a click (flatness 0.2-0.5), and only
its attachment tells them apart. So a soft word or a sibilant survives by construction, not by a threshold.
"""
import math
import os
import subprocess
import tempfile
import wave

import numpy as np

RATE = 16000
FRAME_S = 0.01                    # the envelope's frame (lib/speech_energy.FRAME_S)
WINDOW_S = 0.05                   # each frame's reading: this long a window, centred on the frame
PITCH_LAG_S = (0.0025, 0.0125)    # the autocorrelation lags read: 400 to 80 Hz
LOWPASS_HZ = 1000.0               # the light low-pass before the autocorrelation
FLAT_BAND_HZ = (80.0, 4000.0)     # the band the flatness is read over (the fundamental and the formants)
SMOOTH_HZ = 800.0                 # ... against the spectrum's own envelope, smoothed this wide (two harmonics at 400 Hz)
FLAT_FLOOR_DB = 30.0              # ... over the bins whose envelope is within this of the loudest
PITCH_MIN = 0.5                   # a frame this pitched or more is voiced: the middle of the gap measured on the real
                                  # file (clicks 0.17-0.18, voice 0.7-0.9); on the replicas no click, smack, handling
                                  # noise, "s", "sh" or white noise frame reached it, over a hum or not
VOICE_REACH_S = 0.15              # sound with a voiced frame this near either edge is attached to the voice
DECODE_TIMEOUT_S = 600
_LOWPASS_TAPS = 31
_SILENT_DB = -120.0
_CHUNK = 2048                     # frames read at once (memory: _CHUNK x the window)

STAMPED = ("WINDOW_S", "PITCH_LAG_S", "LOWPASS_HZ", "PITCH_MIN", "VOICE_REACH_S")
STAMP = "voice " + " ".join(f"{k}={globals()[k]}" for k in STAMPED)


def _lowpass(x):
    """x through a short windowed-sinc low-pass at LOWPASS_HZ (same length, no delay)."""
    n = np.arange(_LOWPASS_TAPS) - (_LOWPASS_TAPS - 1) / 2
    fc = LOWPASS_HZ / RATE
    h = 2 * fc * np.sinc(2 * fc * n) * np.hamming(_LOWPASS_TAPS)
    return np.convolve(x, (h / h.sum()).astype(x.dtype), mode="same")


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


def _windows(pad, centres, half):
    """[len(centres), 2 * half] windows around each centre of a signal padded with `half` zeros each side."""
    return pad[centres[:, None] + np.arange(2 * half)[None, :]]


def features(x, n_frames=None, flatness=True):
    """(pitch strength, flatness, energy, low energy) per FRAME_S frame of mono float samples x at RATE, each read on
    its WINDOW_S window (low: the mean square of the window after the low-pass, the part the pitch is read on). Frames
    with no energy read pitch 0 and flatness 1. flatness False: not read (all 1), as the rule needs none."""
    x = np.asarray(x, dtype=np.float32)             # float32: an hour of a channel is 230 MB, not 460
    hop = int(round(RATE * FRAME_S))
    n_frames = len(x) // hop if n_frames is None else n_frames
    half = int(round(RATE * WINDOW_S / 2))
    win = 2 * half
    lo_lag, hi_lag = (int(round(RATE * s)) for s in PITCH_LAG_S)
    nfft = 1 << int(math.ceil(math.log2(2 * win)))
    freqs = np.fft.rfftfreq(nfft, 1 / RATE)
    band = (freqs >= FLAT_BAND_HZ[0]) & (freqs <= FLAT_BAND_HZ[1])
    hann = np.hanning(win)
    bins = max(3, int(round(SMOOTH_HZ / (RATE / nfft))) | 1)
    smooth = np.hanning(bins + 2)[1:-1]
    smooth /= smooth.sum()
    xl = _lowpass(x) if len(x) else x
    z = np.zeros(half, dtype=np.float32)
    xp, xlp = np.concatenate([z, x, z]), np.concatenate([z, xl, z])
    pitch, flat, energy, low = (np.zeros(n_frames) for _ in range(4))
    for c0 in range(0, n_frames, _CHUNK):
        ks = np.arange(c0, min(n_frames, c0 + _CHUNK))
        centres = ks * hop + hop // 2
        w = _windows(xp, centres, half)
        w = w.astype(np.float64)
        e = (w ** 2).mean(axis=1)
        energy[ks] = e
        if flatness:
            p = np.abs(np.fft.rfft(w * hann, nfft)) ** 2
            flat[ks] = _local_flatness(p[:, band], smooth)
        else:
            flat[ks] = 1.0
        wl = _windows(xlp, centres, half)
        wl = wl.astype(np.float64)
        wl = wl - wl.mean(axis=1, keepdims=True)
        low[ks] = (wl ** 2).mean(axis=1)
        r = np.fft.irfft(np.abs(np.fft.rfft(wl, nfft)) ** 2, nfft)[:, :hi_lag + 1]
        lags = np.arange(lo_lag, hi_lag + 1)
        # normalized by the window's own energy (lag 0), unbiased for the overlap: a click or a smack, whose energy
        # sits in a few ms, reads near 0 at every lag (normalized by the overlapping parts' energies instead, a click
        # at a window's edge read as pitched as a voice)
        norm = r[:, :1] * (win - lags) / win + 1e-20
        pitch[ks] = np.max(r[:, lags] / norm, axis=1)
        dead = e <= 1e-14
        pitch[ks[dead]], flat[ks[dead]] = 0.0, 1.0
    return pitch, flat, energy, low


def like(pitch, flat=None):
    """Voice-like by its spectrum alone (no level): pitched (see the module docstring; flat decides nothing)."""
    return np.asarray(pitch) >= PITCH_MIN


def pitched_db(pitch, low):
    """Per frame, the level (dB) of the low-passed window when the frame is pitched (`like`), else _SILENT_DB: what
    `voiced` reads against the voice line. The level is the low-passed part's own, so a click over a hum (the click's
    energy above the low-pass, the hum's pitch under it) reads at the hum's level, never at the click's."""
    lv = 10 * np.log10(np.maximum(np.asarray(low, dtype=np.float64), 1e-12))
    return np.where(like(pitch), lv, _SILENT_DB)


def samples(media):
    """[channels][samples] float samples of the first audio stream of `media` at RATE, or None when it cannot be read
    (lib/speech_energy.envelope has read it already, and says why when it cannot)."""
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
            data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / np.float32(32768.0)
    finally:
        if os.path.exists(wav_path):
            os.unlink(wav_path)
    n = len(data) // ch
    return [data[c:n * ch:ch] for c in range(ch)]


def flags(media, n_frames):
    """[dB] per envelope frame of `media`: `pitched_db` (the low-passed level of a pitched frame, else -120), read on
    the louder channel of each window (by its low-passed energy); None when the audio cannot be read (the voice check
    is then off, and layer 1 reads by level alone as before)."""
    chans = samples(media)
    if not chans:
        return None
    best = None
    for x in chans:
        p, _, _, lo = features(x, n_frames, flatness=False)
        if best is None:
            best = (p, lo)
        else:
            louder = lo > best[1]
            best = (np.where(louder, p, best[0]), np.maximum(lo, best[1]))
    return [float(v) for v in pitched_db(*best)]


# ── the rule, on layer 1's frames ───────────────────────────────────────────────────────────────────────────


def voiced(spectral, line):
    """bytearray: 1 for each frame whose pitched part is at or over `line` (spectral: flags); None when spectral is
    None (no check)."""
    if spectral is None:
        return None
    return bytearray(1 if v >= line else 0 for v in spectral)


def reach():
    return int(round(VOICE_REACH_S / FRAME_S))


def cut_off(voice, a, b):
    """Whether frames [a, b) hold no voice-like frame, and none lies within VOICE_REACH_S of them: sound cut off
    from voiced speech. voice: `voiced`'s frames, or None (no check: never cut off)."""
    if voice is None:
        return False
    r = reach()
    return not any(voice[max(0, a - r):min(len(voice), b + r)])


def noise_frames(env, line, voice, sound=()):
    """The frames of each run at or over `line` (or in `sound`, frames read as sound though under it) that is cut off
    from voiced speech (`cut_off`): no voice. Empty when voice is None."""
    out = set()
    if voice is None:
        return out
    k, n = 0, len(env)
    while k < n:
        if env[k] < line and k not in sound:
            k += 1
            continue
        m = k
        while m < n and (env[m] >= line or m in sound):
            m += 1
        if cut_off(voice, k, m):
            out.update(range(k, m))
        k = m
    return out


def noise_word(env, voice, line, a, b):
    """Whether a word whose whisper span is frames [a, b) is sound of no voice: its span holds sound (a frame at or
    over `line`, the lowest a soft word's burst reaches), and every run of sound meeting its span (each run whole,
    beyond the span too) is cut off from voiced speech. Never a word with no sound (that is inaudible, as before),
    never one when voice is None."""
    if voice is None:
        return False
    hit = [f for f in range(a, b) if env[f] >= line]
    if not hit:
        return False
    n, seen = len(env), set()
    for f in hit:
        if f in seen:
            continue
        lo = hi = f
        while lo - 1 >= 0 and env[lo - 1] >= line:
            lo -= 1
        while hi + 1 < n and env[hi + 1] >= line:
            hi += 1
        seen.update(range(lo, hi + 1))
        if not cut_off(voice, lo, hi + 1):
            return False
    return True
