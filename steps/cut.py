#!/usr/bin/env python3
"""Remove sections from a video between given timestamps, or output a trim spec for concat."""
import os, sys, json, argparse, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run, get_duration, ffprobe_value

EDGE_THRESHOLD = 0.05  # seconds — treat cuts within 50ms of file edges as edge cuts


def has_audio(path: str) -> bool:
    return ffprobe_value(path, "stream=codec_type", "a:0").strip() == "audio"


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


def build_filter(keeps: list, audio: bool) -> tuple:
    """Build (maps, filter_complex_str) to encode the given keep intervals."""
    n = len(keeps)
    if n == 1:
        s, e = keeps[0]
        if audio:
            fc = (f"[0:v]trim=start={s:.4f}:end={e:.4f},setpts=PTS-STARTPTS[vout];"
                  f"[0:a]atrim=start={s:.4f}:end={e:.4f},asetpts=PTS-STARTPTS[aout]")
            maps = ["-map", "[vout]", "-map", "[aout]"]
        else:
            fc = f"[0:v]trim=start={s:.4f}:end={e:.4f},setpts=PTS-STARTPTS[vout]"
            maps = ["-map", "[vout]"]
        return maps, fc

    # Multiple keeps: split → trim each → concat
    if audio:
        vs  = "".join(f"[vs{i}]" for i in range(n))
        as_ = "".join(f"[as{i}]" for i in range(n))
        parts = [f"[0:v]split={n}{vs}", f"[0:a]asplit={n}{as_}"]
        for i, (s, e) in enumerate(keeps):
            parts.append(f"[vs{i}]trim=start={s:.4f}:end={e:.4f},setpts=PTS-STARTPTS,fps=30[vc{i}]")
            parts.append(f"[as{i}]atrim=start={s:.4f}:end={e:.4f},asetpts=PTS-STARTPTS[ac{i}]")
        seg_in = "".join(f"[vc{i}][ac{i}]" for i in range(n))
        parts.append(f"{seg_in}concat=n={n}:v=1:a=1[vout][aout]")
        maps = ["-map", "[vout]", "-map", "[aout]"]
    else:
        vs = "".join(f"[vs{i}]" for i in range(n))
        parts = [f"[0:v]split={n}{vs}"]
        for i, (s, e) in enumerate(keeps):
            parts.append(f"[vs{i}]trim=start={s:.4f}:end={e:.4f},setpts=PTS-STARTPTS[vc{i}]")
        seg_in = "".join(f"[vc{i}]" for i in range(n))
        parts.append(f"{seg_in}concat=n={n}:v=1:a=0[vout]")
        maps = ["-map", "[vout]"]

    return maps, ";".join(parts)


def main():
    parser = argparse.ArgumentParser(
        description="Remove sections from a video between given timestamps")
    parser.add_argument("--input",  required=True,  help="Source video file")
    parser.add_argument("--start",  type=float,     help="Start of section to remove (seconds)")
    parser.add_argument("--end",    type=float,     help="End of section to remove (seconds)")
    parser.add_argument("--cuts",                   help='JSON array of [start,end] pairs, e.g. [[0,1],[5,6]]')
    parser.add_argument("--spec",   action="store_true", help="Write trim spec JSON instead of encoding")
    parser.add_argument("--out",                    help="Output file path")
    args = parser.parse_args()

    require_file(args.input)
    duration = get_duration(args.input)

    # Build cuts list from --cuts or --start/--end
    if args.cuts:
        try:
            cuts = json.loads(args.cuts)
        except json.JSONDecodeError as exc:
            fail("invalid_cuts", f"--cuts must be valid JSON: {exc}")
    elif args.start is not None and args.end is not None:
        cuts = [[args.start, args.end]]
    else:
        fail("missing_args", "Provide --cuts or both --start and --end")

    keeps = compute_keeps(duration, cuts)

    # ── Spec mode: write trim spec JSON ────────────────────────────────────────
    if args.spec:
        spec = {"input": os.path.abspath(args.input), "keeps": keeps}
        out  = args.out or f"{os.path.splitext(args.input)[0]}_cut_spec.json"
        with open(out, "w") as f:
            json.dump(spec, f, indent=2)
        print(json.dumps({"path": out}))
        return

    # ── Encode mode ────────────────────────────────────────────────────────────
    audio = has_audio(args.input)
    maps, fc = build_filter(keeps, audio)

    out     = args.out or f"{os.path.splitext(args.input)[0]}_cut.mp4"
    encode  = ["-c:v", "libx264", "-preset", "fast", "-crf", "18"]
    encode_a = ["-c:a", "aac"] if audio else ["-an"]

    fd, fc_path = tempfile.mkstemp(suffix=".txt", prefix="cut_fc_")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(fc)
        run(["ffmpeg", "-y", "-i", args.input, "-/filter_complex", fc_path,
             *maps, *encode, *encode_a, out])
    finally:
        try:
            os.unlink(fc_path)
        except Exception:
            pass

    check_output(out)
    print(out)


if __name__ == "__main__":
    main()
