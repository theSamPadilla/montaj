#!/usr/bin/env python3
"""Mix a timeline's audible audio into ONE file, in timeline time.

Input is a mix spec — every audible piece of a project's timeline, already
resolved to a source window and a position::

    {
      "duration": 37.8154,          # seconds of output (silence past the end is not written)
      "sampleRate": 16000,          # optional; --sample-rate wins when passed
      "segments": [
        {"src": "vo_01.wav", "in": 0.65, "out": 4.3,  "start": 0.0,  "volume": 1.0},
        {"src": "IMG_01.MOV","in": 2.0,  "out": 4.24, "start": 6.63, "volume": 0.8, "speed": 1.5}
      ]
    }

Each segment is seeked to ``in``, read for ``out - in`` SOURCE seconds,
optionally re-timed by ``speed`` (pitch-preserving ``atempo``, so a 1.5×
segment of 2.24 source seconds occupies 1.49 seconds of output), scaled by
``volume``, delayed to ``start``, and summed onto a silent bed of exactly
``duration`` seconds. Segments may overlap freely — that is the point; a
voiceover over live footage is two simultaneous segments.

Output time IS timeline time: gaps between segments come out as real silence
rather than being closed up, so a timestamp in the result is a timestamp on the
timeline. That is what makes this the right input for caption transcription
(``serve/caption_job.build_audio_mix_spec`` builds the spec; the caption route
and ``steps/transform/generate_captions.py`` both run this step), and it is why
this is NOT ``materialize_cut``, which CONCATENATES a single track's keeps and
whose output time is therefore the sum of the clip lengths.

Sources with no audio stream (a silent camera file, a still) are skipped with a
progress note rather than failing the mix. A spec whose segments are ALL
unusable fails — there is nothing to hand downstream.

Defaults are transcription-shaped: 16 kHz mono ``pcm_s16le``, which is
whisper.cpp's native input, so nothing has to re-decode the result.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import check_output, fail, ffmpeg_bin, ffprobe_bin, progress, require_file, run

# Max ffmpeg inputs in a single pass (the silent bed plus this many segments).
# A long b-roll cut can easily carry a couple of hundred audible pieces, and one
# ffmpeg process holding that many open demuxers is where memory and file
# descriptors start to bite. Past the cap the mix is done in batches whose
# outputs are themselves mixed — see `mix_segments`.
MAX_INPUTS = 48

# Generous: a long timeline re-decodes every source window once, and 4K HEVC
# containers are slow to open even when only their audio is read.
FFMPEG_TIMEOUT = 1800

DEFAULT_SAMPLE_RATE = 16000


def atempo_chain(speed: float) -> list[str]:
    """``atempo`` factors whose product is ``speed``.

    ffmpeg's ``atempo`` accepts 0.5–2.0 per instance, so anything outside that
    range is chained. Mirrors ``atempoChain`` in
    ``montaj_assets/render/encode-segment.js`` — the render path re-times clip
    audio exactly this way, and a transcript taken from a differently-re-timed
    mix would drift against the video it captions.
    """
    if speed == 1.0:
        return []
    factors = []
    r = speed
    while r > 2.0:
        factors.append(2.0)
        r /= 2.0
    while r < 0.5:
        factors.append(0.5)
        r *= 2.0
    factors.append(r)
    return [f"atempo={f:g}" for f in factors]


def has_audio_stream(path: str) -> bool:
    """Whether ``path`` carries at least one audio stream.

    Checked up front, once per distinct source: referencing ``[n:a]`` for an
    input that has no audio is a hard ffmpeg error, and one silent camera file
    on the timeline would otherwise take the whole mix down.

    A source that is silent is SKIPPED; a source that is MISSING is a hard
    failure (``require_file``, at the call site). Those are different problems:
    a still or a muted-at-capture camera file legitimately has nothing to
    contribute, while a src that has moved off disk means the transcript would
    quietly omit whatever was said in it.
    """
    r = subprocess.run(
        [ffprobe_bin(), "-v", "quiet", "-select_streams", "a:0",
         "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
        capture_output=True, text=True, timeout=60,
    )
    return r.returncode == 0 and "audio" in r.stdout


def _mix_pass(segments: list, duration: float, sample_rate: int, out_path: str):
    """One ffmpeg invocation: ``segments`` summed onto a silent bed.

    Input 0 is an ``anullsrc`` bed of exactly ``duration`` seconds. It fixes the
    output length (so a mix whose last segment ends early still runs to
    ``duration``) and guarantees ``amix`` a stream to work with even when a
    batch turns out to hold a single segment.

    ``amix`` runs with ``normalize=0`` — it SUMS rather than dividing by the
    input count, the same choice ``montaj_assets/render/mix-audio.js`` makes, so
    a lone voiceover under a 40-clip timeline is not attenuated to nothing by
    the 39 silent-at-that-moment inputs around it.
    """
    layout = "mono"
    inputs = ["-f", "lavfi", "-t", f"{duration:.4f}", "-i",
              f"anullsrc=r={sample_rate}:cl={layout}"]
    parts = []
    labels = ["[0:a]"]

    for i, seg in enumerate(segments):
        idx = i + 1
        span = seg["out"] - seg["in"]
        speed = float(seg.get("speed", 1.0))
        volume = float(seg.get("volume", 1.0))
        delay_ms = int(round(seg["start"] * 1000))

        inputs += ["-ss", f"{seg['in']:.4f}", "-t", f"{span:.4f}", "-i", seg["src"]]

        # atrim BEFORE asetpts, deliberately: it locks the sample range against
        # the input's own seek-based PTS, not the zero-based PTS asetpts
        # produces. Same ordering as encode-segment.js's audio chain.
        chain = [f"[{idx}:a:0]atrim=0:{span:.4f}", "asetpts=PTS-STARTPTS"]
        chain += atempo_chain(speed)
        if volume != 1.0:
            chain.append(f"volume={volume:g}")
        chain.append(
            f"aformat=sample_fmts=fltp:sample_rates={sample_rate}:channel_layouts={layout}"
        )
        if delay_ms > 0:
            chain.append(f"adelay={delay_ms}:all=1")
        parts.append(",".join(chain) + f"[s{i}]")
        labels.append(f"[s{i}]")

    parts.append(
        "".join(labels) + f"amix=inputs={len(labels)}:duration=longest:normalize=0[aout]"
    )

    # The graph goes to a file rather than argv: a few hundred segments is a
    # filter string well past what a command line should carry. Same technique
    # materialize_cut uses.
    fd, fc_path = tempfile.mkstemp(suffix=".txt", prefix="mix_timeline_fc_")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(";".join(parts))
        run([
            ffmpeg_bin(), "-y", *inputs,
            "-/filter_complex", fc_path,
            "-map", "[aout]",
            "-t", f"{duration:.4f}",
            "-ar", str(sample_rate), "-ac", "1",
            "-c:a", "pcm_s16le",
            out_path,
        ], timeout=FFMPEG_TIMEOUT)
    finally:
        if os.path.exists(fc_path):
            os.unlink(fc_path)


def mix_segments(segments: list, duration: float, sample_rate: int, out_path: str):
    """Mix ``segments`` into ``out_path``, batching past ``MAX_INPUTS``.

    Each batch is mixed to its own full-length intermediate WAV; those are then
    mixed together by the same code path (an intermediate is just a segment
    starting at 0 with the whole file as its window). Summing is associative, so
    batching cannot change the result — only the number of files open at once.
    """
    if len(segments) <= MAX_INPUTS:
        _mix_pass(segments, duration, sample_rate, out_path)
        return

    work_dir = os.path.dirname(os.path.abspath(out_path)) or "."
    batches = [segments[i:i + MAX_INPUTS] for i in range(0, len(segments), MAX_INPUTS)]
    progress(f"mixing {len(segments)} segments in {len(batches)} batches")
    temps = []
    try:
        for n, batch in enumerate(batches):
            tmp = os.path.join(work_dir, f"_mix_timeline_batch_{n}.wav")
            _mix_pass(batch, duration, sample_rate, tmp)
            temps.append(tmp)
        mix_segments(
            [{"src": t, "in": 0.0, "out": duration, "start": 0.0, "volume": 1.0} for t in temps],
            duration, sample_rate, out_path,
        )
    finally:
        for t in temps:
            try:
                os.unlink(t)
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser(
        description="Mix a timeline's audible audio into one file, in timeline time"
    )
    parser.add_argument("--input", required=True, help="Mix spec JSON")
    parser.add_argument("--out", help="Output audio path (default: {spec stem}_mix.wav)")
    parser.add_argument("--sample-rate", type=int, default=None,
                        help=f"Output sample rate (default: the spec's sampleRate, else {DEFAULT_SAMPLE_RATE})")
    args = parser.parse_args()

    require_file(args.input)
    try:
        with open(args.input, encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        fail("invalid_spec", f"Could not read mix spec {args.input}: {e}")

    segments = spec.get("segments")
    if not isinstance(segments, list) or not segments:
        fail("invalid_spec", "Mix spec has no 'segments'")

    duration = float(spec.get("duration") or 0.0)
    if duration <= 0:
        fail("invalid_spec", f"Mix spec 'duration' must be positive (got {duration})")

    sample_rate = args.sample_rate or int(spec.get("sampleRate") or DEFAULT_SAMPLE_RATE)

    out_path = args.out
    if not out_path:
        base = os.path.splitext(args.input)[0]
        out_path = f"{base}_mix.wav"

    # Probe once per distinct source, not once per segment: a cut routinely
    # takes a dozen windows out of the same file.
    audible = []
    probed = {}
    for seg in segments:
        src = seg.get("src")
        if not src:
            continue
        if src not in probed:
            require_file(src)
            probed[src] = has_audio_stream(src)
            if not probed[src]:
                progress(f"skipping (no audio stream): {os.path.basename(src)}")
        if probed[src]:
            audible.append(seg)

    if not audible:
        fail("no_audio", "No segment source has an audio stream — nothing to mix")

    progress(f"mixing {len(audible)} audible segments into {duration:.2f}s of timeline")
    mix_segments(audible, duration, sample_rate, out_path)
    check_output(out_path)
    print(out_path)


if __name__ == "__main__":
    main()
