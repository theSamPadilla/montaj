#!/usr/bin/env python3
"""Emit min/max peak pairs for an audio waveform at a fixed samples-per-second
resolution, for driving a scrubbable waveform view in the editor timeline.

Decodes the first audio stream (-map 0:a:0) to mono PCM — peaks are a visual,
one channel by design — then downsamples it into min/max buckets. An optional
--start/--duration window limits decode to just part of the source file.

Total peak pairs are clamped to 500k per call: if the requested resolution
times the window duration would exceed that, the resolution is stepped down
through the bucketed values (800 -> 200 -> 50) and the actual value used is
reported in the output, never silently truncated.
"""
import json, math, os, sys, argparse, tempfile, wave
from array import array
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, get_duration, ffmpeg_bin

RESOLUTIONS = (50, 200, 800)      # bucketed samples-per-second values
MAX_PEAK_PAIRS = 500_000          # total-samples clamp per invocation
DECODE_SAMPLE_RATE = 44100


def choose_resolution(requested: int, window_duration: float) -> tuple:
    """Return (samples_per_second, pairs) honoring the MAX_PEAK_PAIRS clamp.

    Steps down through RESOLUTIONS (never up) until the total pairs fit the
    clamp. If even the lowest bucket doesn't fit (a pathologically long
    window), degrades further so the clamp always holds — the reported value
    stays truthful rather than silently overflowing.
    """
    for sps in sorted((r for r in RESOLUTIONS if r <= requested), reverse=True):
        pairs = max(1, math.ceil(window_duration * sps))
        if pairs <= MAX_PEAK_PAIRS:
            return sps, pairs
    degraded = MAX_PEAK_PAIRS / window_duration
    return round(degraded, 3), MAX_PEAK_PAIRS


def decode_mono_samples(input_path: str, start: float, duration: float, timeout: int) -> array:
    """Decode a source-time window of the first audio stream to mono int16 PCM."""
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        run([ffmpeg_bin(), "-y",
             "-ss", str(start), "-t", str(duration),
             "-i", input_path,
             "-map", "0:a:0", "-ac", "1", "-ar", str(DECODE_SAMPLE_RATE),
             "-c:a", "pcm_s16le",
             wav_path], timeout=timeout)
        check_output(wav_path)
        with wave.open(wav_path, "rb") as w:
            raw = w.readframes(w.getnframes())
        return array("h", raw)
    finally:
        if os.path.exists(wav_path):
            os.unlink(wav_path)


def compute_peaks(samples: array, pairs: int) -> list:
    """Interleaved [min, max, min, max, ...] — one pair per bucket, buckets
    split as evenly as possible across the decoded sample count."""
    total = len(samples)
    peaks = []
    for i in range(pairs):
        lo = (i * total) // pairs
        hi = max(lo + 1, ((i + 1) * total) // pairs)
        chunk = samples[lo:hi]
        if chunk:
            peaks.append(min(chunk))
            peaks.append(max(chunk))
        else:
            peaks.append(0)
            peaks.append(0)
    return peaks


def process_one(input_path: str, samples_per_second: int, start, duration, timeout: int) -> dict:
    require_file(input_path)
    total_duration = get_duration(input_path)

    window_start = max(0.0, start) if start is not None else 0.0
    if window_start >= total_duration:
        fail("invalid_window",
             f"--start ({window_start}) is at or beyond the file duration ({total_duration})")

    window_duration = duration if duration is not None else (total_duration - window_start)
    window_duration = min(window_duration, total_duration - window_start)
    if window_duration <= 0:
        fail("invalid_window", "--duration must select a positive window within the file")

    sps, pairs = choose_resolution(samples_per_second, window_duration)

    samples = decode_mono_samples(input_path, window_start, window_duration, timeout)
    if len(samples) == 0:
        fail("no_audio", f"No decodable audio samples in {input_path}")

    peaks = compute_peaks(samples, pairs)

    return {
        "samplesPerSecond": sps,
        "start": round(window_start, 3),
        "duration": round(window_duration, 3),
        "peaks": peaks,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Emit min/max audio peak pairs at a fixed samples-per-second resolution")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--input",  help="Single source video or audio file")
    group.add_argument("--inputs", nargs="+", metavar="FILE", help="Multiple source files (processed in parallel)")
    parser.add_argument("--samples-per-second", type=int, default=200, choices=list(RESOLUTIONS),
                        help="Peak-pair resolution per second: 50, 200, or 800 (default: 200). "
                             "Stepped down automatically (and reported in the output) if the total "
                             "pairs would exceed the 500k clamp.")
    parser.add_argument("--start",    type=float, default=None, help="Window start in seconds (default: 0)")
    parser.add_argument("--duration", type=float, default=None, help="Window duration in seconds (default: rest of the file)")
    parser.add_argument("--timeout",  type=int, default=300, help="ffmpeg decode timeout in seconds")
    parser.add_argument("-P", "--parallel", type=int, default=0,
                        help="Max parallel workers for --inputs (default: number of inputs)")
    args = parser.parse_args()

    if args.input:
        result = process_one(args.input, args.samples_per_second, args.start, args.duration, args.timeout)
        print(json.dumps(result))
    else:
        workers = args.parallel or len(args.inputs)
        results: dict[int, dict] = {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(process_one, path, args.samples_per_second, args.start, args.duration, args.timeout): i
                for i, path in enumerate(args.inputs)
            }
            for future in as_completed(futures):
                idx = futures[future]
                results[idx] = future.result()
        print(json.dumps([results[i] for i in range(len(args.inputs))]))


if __name__ == "__main__":
    main()
