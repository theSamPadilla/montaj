#!/usr/bin/env python3
"""Materialise a trim spec (or raw video with cuts) into an encoded H.264 clip.

Three input modes:
  trim spec JSON          → use keeps directly
  raw video + inpoint/outpoint → single-keep window
  raw video + --cuts      → invert cuts into keeps
Modes 2 and 3 can be combined: --inpoint/--outpoint clips the window, then --cuts removes ranges within it.

Batch mode (--inputs): materialise multiple clips with capped concurrency (default: 2 workers).
Each encode is a full libx264 pass — running too many in parallel exhausts memory on 4K footage.
"""
import json, os, sys, argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, get_duration, ffmpeg_bin, filter_script
from trim_spec import is_trim_spec, is_cut_spec, load as load_spec, merge as merge_keeps
from normalize import SEEK_PREROLL_S


EDGE_THRESHOLD = 0.05  # seconds — cuts within 50ms of edges are treated as edge cuts
DEFAULT_WORKERS = 2    # max concurrent encodes — each libx264 pass is memory-heavy at 4K


def _spec_segments(spec: dict) -> list:
    """Normalise a cut spec to an ordered ``[(src, start, end), ...]`` list.

    Single-source ``{"input", "keeps"}`` → every segment reuses the same src.
    Multi-source  ``{"segments": [{"src", "in", "out"}, ...]}`` → each segment
    carries its own src. The downstream filter graph is identical either way —
    it concatenates by input index and is agnostic to which file each came from.
    """
    if "segments" in spec:
        return [(s["src"], float(s["in"]), float(s["out"])) for s in spec["segments"]]
    source = spec["input"]
    return [(source, float(s), float(e)) for s, e in spec["keeps"]]


def _default_out(base: str, audio_only: bool) -> str:
    return f"{base}_cut.wav" if audio_only else f"{base}_cut.mp4"


def build_ffmpeg_args(spec: dict, audio_only: bool = False) -> tuple:
    """
    Build (input_args, filter_complex_string) using input-level seeking.

    Each kept segment gets its own -ss/-t/-i triple placed before the input flag.
    ffmpeg seeks at the container level — only the requested segment is decoded.
    Segments may come from the SAME source (single-source trim: the file is
    opened N times with different seek windows) or from DIFFERENT sources
    (multi-source reaction/compilation cut); either way the segments are
    normalised and concatenated, in order, in the filter graph.

    Every segment is conformed before concat: fps=30, setsar=1, format=yuv420p
    (video) and aformat sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp
    (audio).  This guarantees that inputs from different source files —
    potentially with different resolutions, SAR, pixel formats, or audio layouts
    — are compatible with ffmpeg's concat filter ("Input link parameters do not
    match" errors are eliminated).

    An optional ``scale`` key in the spec — a 2-element [W, H] list of even ints
    — scales each segment down (preserving aspect ratio, pillar/letterboxed) to
    the requested dimensions before concat.  Useful for caption-only cuts where
    small, uniform dimensions reduce transcode time without affecting audio quality.

    This avoids the trim/split filter pattern which forces a full file decode
    regardless of the requested segment position.

    Two-stage seek (PV48 T3, see lib/normalize.SEEK_PREROLL_S): a single
    input-level -ss straight to a segment's start can land inside an
    open-GOP source's leading-picture window and drop frames (PV48 T1). Each
    segment instead seeks (fast) to near = max(0, s - SEEK_PREROLL_S), and —
    when fine = s - near > 0 — trims the decode-only remainder back off at
    the head of its own filter chain: trim=start=fine:duration=(e-s) /
    atrim=start=fine:duration=(e-s), before setpts/asetpts rebases to 0. The
    `duration=` bound is load-bearing (PV48 review): the input's own -t
    can't be trusted as the window's end, because ffmpeg counts it from the
    first frame actually kept after `near`, not from `s` — on an open-GOP
    source where `near` itself lands in a leading-picture window, that first
    kept frame is later than `near`, and a window bounded only by -t runs
    past `e`. So input -t is now only a generous upper bound (fine + (e-s) +
    1s), and the trim/atrim filters do the exact cut. At fine == 0 (segment
    start within SEEK_PREROLL_S of 0, or exactly 0) no trim filter is added
    and the args match today's exactly — near == s there, so the input's own
    -t already counts from s and never drifts.
    """
    segs  = _spec_segments(spec)
    n     = len(segs)
    scale = spec.get("scale")  # None or [W, H]

    input_args = []
    fines = []  # per-segment decode-only remainder (seconds) left to trim
    durs  = []  # per-segment kept-window length (seconds), e - s
    for src, s, e in segs:
        near = max(0.0, s - SEEK_PREROLL_S)
        fine = s - near
        dur = e - s
        fines.append(fine)
        durs.append(dur)
        # Guard dur > 0: a trim `duration=0` means unlimited, not zero-length,
        # so a reversed/zero window (dur <= 0) falls back to today's -t form
        # rather than emitting a bound that means the opposite of what it says.
        if fine > 0 and dur > 0:
            t = fine + dur + 1
        else:
            t = fine + dur
        # 6 decimals (microseconds, ffmpeg's own -ss/-t resolution), not 4:
        # -ss is not just a bound, it is the origin `fine` is measured from.
        # ffmpeg shifts every frame by -round(near / timebase), so a 4-decimal
        # near that rounds UP by over half a tick drops the frame at s at the
        # trim: 149/30 cut from frame 150 (near "2.9667" vs 2.966667; k = 2 mod
        # 3 at 30 fps, measured FQ54). With fine == 0, -t is the exact end bound
        # and rounding up admitted one extra frame the same way.
        input_args += ["-ss", f"{near:.6f}", "-t", f"{t:.6f}", "-i", src]

    def _vchain(idx):
        parts = []
        if fines[idx] > 0:
            # 6 decimals here, as for -ss/-t above: a 4-decimal `duration=` can
            # round UP past a frame boundary for periodic fractions like
            # 8/30s ("0.2667" vs the true 0.266667), admitting one extra
            # frame at the trim's own cut point — measured, PV48 review.
            if durs[idx] > 0:
                parts.append(f"trim=start={fines[idx]:.6f}:duration={durs[idx]:.6f}")
            else:
                parts.append(f"trim=start={fines[idx]:.6f}")
        parts.append("setpts=PTS-STARTPTS")
        parts.append("fps=30")
        if scale:
            W, H = int(scale[0]), int(scale[1])
            parts.append(f"scale={W}:{H}:force_original_aspect_ratio=decrease")
            parts.append(f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2")
        parts.append("setsar=1")
        parts.append("format=yuv420p")
        return f"[{idx}:v]" + ",".join(parts) + f"[vc{idx}]"

    def _achain(idx):
        parts = []
        if fines[idx] > 0:
            # 6 decimals — see the matching comment in _vchain above.
            if durs[idx] > 0:
                parts.append(f"atrim=start={fines[idx]:.6f}:duration={durs[idx]:.6f}")
            else:
                parts.append(f"atrim=start={fines[idx]:.6f}")
        parts.append("asetpts=PTS-STARTPTS")
        parts.append("aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp")
        return f"[{idx}:a]" + ",".join(parts) + f"[ac{idx}]"

    filter_parts = []
    if n == 1:
        if not audio_only:
            filter_parts.append(_vchain(0).replace("[vc0]", "[vout]"))
        filter_parts.append(_achain(0).replace("[ac0]", "[aout_raw]"))
    else:
        for i in range(n):
            if not audio_only:
                filter_parts.append(_vchain(i))
            filter_parts.append(_achain(i))
        if audio_only:
            seg_in = "".join(f"[ac{i}]" for i in range(n))
            filter_parts.append(f"{seg_in}concat=n={n}:v=0:a=1[aout_raw]")
        else:
            seg_in = "".join(f"[vc{i}][ac{i}]" for i in range(n))
            filter_parts.append(f"{seg_in}concat=n={n}:v=1:a=1[vout][aout_raw]")

    filter_parts.append("[aout_raw]aresample=async=1000[aout]")
    return input_args, ";".join(filter_parts)


def compute_keeps(duration: float, cuts: list) -> list:
    """Given a list of (start, end) cut ranges, return the kept intervals."""
    cuts_sorted = sorted((max(0.0, float(s)), min(duration, float(e))) for s, e in cuts)
    keeps = []
    cursor = 0.0
    for s, e in cuts_sorted:
        if e <= s:
            continue
        if s > cursor + EDGE_THRESHOLD:
            keeps.append([cursor, s])
        cursor = max(cursor, e)
    if cursor < duration - EDGE_THRESHOLD:
        keeps.append([cursor, duration])
    if not keeps:
        fail("invalid_range", "Cuts cover the entire file — nothing would remain")
    return keeps


def _encode_one(spec: dict, out_path: str, audio_only: bool = False) -> str:
    """Encode a single cut spec (single- or multi-source). Returns out_path on
    success, raises on failure."""
    input_args, filter_str = build_ffmpeg_args(spec, audio_only=audio_only)
    if audio_only:
        ext = os.path.splitext(out_path)[1].lower()
        if ext == ".wav":
            encode_flags = ["-vn", "-c:a", "pcm_s16le"]
        else:
            encode_flags = ["-vn", "-c:a", "aac", "-b:a", "192k"]
    else:
        encode_flags = [
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
        ]
    map_flags = ["-map", "[aout]"] if audio_only else ["-map", "[vout]", "-map", "[aout]"]
    with filter_script(filter_str) as fc_path:
        run([
            ffmpeg_bin(), "-y", *input_args,
            "-/filter_complex", fc_path,
            *map_flags,
            *encode_flags, out_path,
        ])
    check_output(out_path)
    return out_path


def _resolve_input(path: str) -> tuple:
    """Return (source, keeps) for a trim spec or raw video path."""
    require_file(path)
    if is_trim_spec(path):
        spec = load_spec(path)
        require_file(spec["input"])
        return spec["input"], spec["keeps"]
    # Raw video with no cuts — full file as single keep
    duration = get_duration(path)
    return path, [[0.0, duration]]


def main():
    parser = argparse.ArgumentParser(
        description="Materialise a trim spec or raw video segment into an encoded H.264 clip"
    )
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--input",  help="Trim spec JSON or raw video file")
    input_group.add_argument("--inputs", nargs="+", help="Multiple trim specs or video files (batch mode)")

    parser.add_argument("--inpoint",  type=float, help="Keep from this source time (seconds). --input only.")
    parser.add_argument("--outpoint", type=float, help="Keep to this source time (seconds). --input only.")
    parser.add_argument("--cuts",                 help='JSON [[start,end],...] — ranges to remove. --input only.')
    parser.add_argument("--out",                  help="Output path (default: {stem}_cut.mp4, or {stem}_cut.wav with --audio). --input only.")
    parser.add_argument(
        "--workers", type=int, default=DEFAULT_WORKERS,
        help=f"Max concurrent encodes in batch mode (default: {DEFAULT_WORKERS}). "
             "Each libx264 pass is memory-heavy — do not raise above 3 for 4K footage.",
    )
    parser.add_argument("--audio", action="store_true",
                         help="Audio-only output. Emits .wav (pcm_s16le) or .m4a (aac) "
                              "depending on --out's extension; defaults to .wav.")
    args = parser.parse_args()

    # ── Single input ──────────────────────────────────────────────────────────
    if args.input:
        require_file(args.input)

        if is_cut_spec(args.input):
            spec = load_spec(args.input)
            if "segments" in spec:
                for seg in spec["segments"]:
                    require_file(seg["src"])
                ref_src = spec["segments"][0]["src"]
            else:
                require_file(spec["input"])
                ref_src = spec["input"]
        else:
            source   = args.input
            duration = get_duration(source)
            inpt     = args.inpoint  if args.inpoint  is not None else 0.0
            outpt    = args.outpoint if args.outpoint is not None else duration

            if outpt <= inpt:
                fail("invalid_range", f"--outpoint ({outpt}) must be greater than --inpoint ({inpt})")

            keeps = [[inpt, outpt]]

            if args.cuts:
                try:
                    cuts_list = json.loads(args.cuts)
                except json.JSONDecodeError as exc:
                    fail("invalid_cuts", f"--cuts must be valid JSON: {exc}")
                keeps = merge_keeps(keeps, cuts_list)
                if not keeps:
                    fail("invalid_range", "Cuts cover the entire window — nothing would remain")

            spec    = {"input": source, "keeps": keeps}
            ref_src = source

        if not args.out:
            base     = os.path.splitext(os.path.basename(ref_src))[0]
            args.out = os.path.join(os.path.dirname(ref_src), _default_out(base, args.audio))

        print(_encode_one(spec, args.out, audio_only=args.audio))

    # ── Batch input ───────────────────────────────────────────────────────────
    else:
        if args.inpoint is not None or args.outpoint is not None or args.cuts or args.out:
            fail("invalid_args", "--inpoint, --outpoint, --cuts, and --out are not valid with --inputs")

        jobs = []
        for path in args.inputs:
            source, keeps = _resolve_input(path)
            base     = os.path.splitext(os.path.basename(source))[0]
            out_path = os.path.join(os.path.dirname(source), _default_out(base, args.audio))
            jobs.append((source, keeps, out_path))

        results = [None] * len(jobs)
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(_encode_one, {"input": src, "keeps": keeps}, out, args.audio): i for i, (src, keeps, out) in enumerate(jobs)}
            for future in as_completed(futures):
                idx = futures[future]
                results[idx] = future.result()  # raises on encode failure

        print(json.dumps(results))


if __name__ == "__main__":
    main()
