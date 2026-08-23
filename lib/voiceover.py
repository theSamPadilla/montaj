#!/usr/bin/env python3
"""Multi-take narration concat — joins N voiceover takes into one audio file.

B-roll narration is recorded as several takes, one per script section, but
`voiceover.src` is a single path and every `vo_*` step in the broll workflow
resolves it as a scalar. This module joins the takes so that stays true.

Lives in lib/ rather than reusing steps/transform/materialize_cut.py's
multi-source concat because lib/ is the primitive layer that steps wrap:
`steps/transform/` is not an importable package (no __init__.py) and nothing
in lib/ or project/ imports from steps/.

Takes are joined butt-to-butt with no inserted padding. Each take carries its
own leading and trailing room-tone, which is what the `waveform_trim` pass in
the broll workflow keys on to find section boundaries; inserting extra silence
would only widen gaps that pass then removes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import ffmpeg_bin, ffprobe_bin, fail, run


def _has_audio(path: str) -> bool:
    """True when `path` carries at least one audio stream.

    Deliberately not `common.ffprobe_value`, which runs with check=True: a
    file ffprobe cannot parse at all (script notes dropped into the voiceover
    zone by mistake) would raise instead of reporting no audio. Treating an
    unreadable file as "no audio" earns it the same legible error as a silent
    video, which is what it is from the caller's point of view.
    """
    r = run([ffprobe_bin(), "-v", "quiet", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
            timeout=30, check=False)
    return r.returncode == 0 and bool(r.stdout.strip())


def concat_takes(paths: list, out_path: str) -> str:
    """Concatenate the audio of `paths`, in order, into `out_path`.

    Sources may be audio or video files; only the audio track is read. Output
    is 48kHz stereo pcm_s16le, matching what `materialize_cut --audio` emits so
    the downstream clean-cut chain sees a familiar format.

    Returns `out_path`. Raises ValueError on an empty list; calls fail() if a
    take carries no audio, if the output would overwrite one of its own inputs,
    or if ffmpeg errors.
    """
    if not paths:
        raise ValueError("concat_takes requires at least one input path")

    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    # Both preconditions below are things ffmpeg does catch, but only by
    # dumping a filtergraph error that names no file the caller recognizes.
    # Checking here buys a message that says which take is the problem.
    silent = [p for p in paths if not _has_audio(p)]
    if silent:
        fail("no_audio_stream",
             "Voiceover take has no audio track: " + ", ".join(silent))

    out_real = os.path.realpath(out_path)
    if any(os.path.realpath(p) == out_real for p in paths):
        fail("invalid_argument",
             f"Voiceover concat output would overwrite one of its own takes: {out_path}")

    cmd = [ffmpeg_bin(), "-y"]
    for p in paths:
        cmd += ["-i", p]

    # Conform every take before concat: differing sample rates or channel
    # counts across takes make the concat filter refuse the graph outright.
    chains = "".join(
        f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp[a{i}];"
        for i in range(len(paths))
    )
    joined = "".join(f"[a{i}]" for i in range(len(paths)))
    filter_complex = f"{chains}{joined}concat=n={len(paths)}:v=0:a=1[aout]"

    cmd += [
        "-filter_complex", filter_complex,
        "-map", "[aout]",
        "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le",
        out_path,
    ]

    result = run(cmd, timeout=600, check=False)
    if result.returncode != 0:
        # Last few lines, not last N characters: ffmpeg's stderr opens with
        # stream dumps, so a character slice reliably cuts mid-word and hides
        # the actual error at the bottom.
        tail = "\n".join((result.stderr or "").strip().splitlines()[-3:])
        fail("ffmpeg_error", f"Voiceover concat failed: {tail[-500:]}")

    return out_path
