#!/usr/bin/env python3
"""Apply trim spec cuts to a single clip — materializes a trim spec into an encoded video file."""
import os, sys, tempfile, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run
from trim_spec import is_trim_spec, load as load_spec


def build_trim_filter(spec: dict) -> tuple:
    """
    Build filter_complex for a single trim spec.
    Returns (input_flags, filter_string).
    """
    input_flags = ["-i", spec["input"]]
    filter_parts = []
    keeps = spec["keeps"]
    n = len(keeps)

    if n == 1:
        s, e = keeps[0]
        filter_parts.append(
            f"[0:v]trim=start={s:.4f}:end={e:.4f},setpts=PTS-STARTPTS,fps=30[vout]"
        )
        filter_parts.append(
            f"[0:a]atrim=start={s:.4f}:end={e:.4f},asetpts=PTS-STARTPTS[aout_raw]"
        )
    else:
        vs  = "".join(f"[vs{i}]" for i in range(n))
        as_ = "".join(f"[as{i}]" for i in range(n))
        filter_parts.append(f"[0:v]split={n}{vs}")
        filter_parts.append(f"[0:a]asplit={n}{as_}")
        for i, (s, e) in enumerate(keeps):
            filter_parts.append(
                f"[vs{i}]trim=start={s:.4f}:end={e:.4f},"
                f"setpts=PTS-STARTPTS,fps=30[vc{i}]"
            )
            filter_parts.append(
                f"[as{i}]atrim=start={s:.4f}:end={e:.4f},"
                f"asetpts=PTS-STARTPTS[ac{i}]"
            )
        seg_in = "".join(f"[vc{i}][ac{i}]" for i in range(n))
        filter_parts.append(f"{seg_in}concat=n={n}:v=1:a=1[vout][aout_raw]")

    filter_parts.append("[aout_raw]aresample=async=1000[aout]")
    return input_flags, ";".join(filter_parts)


def main():
    parser = argparse.ArgumentParser(description="Apply trim spec cuts to a single video clip")
    parser.add_argument("--input", required=True, help="Trim spec JSON or raw video file")
    parser.add_argument("--out", help="Output file path (default: {stem}_cut.mp4 next to source)")
    args = parser.parse_args()

    require_file(args.input)

    if not is_trim_spec(args.input):
        # Raw video with no cuts — pass through unchanged
        print(args.input)
        return

    spec = load_spec(args.input)
    require_file(spec["input"])

    if not args.out:
        base = os.path.splitext(os.path.basename(spec["input"]))[0]
        args.out = os.path.join(os.path.dirname(spec["input"]), f"{base}_cut.mp4")

    input_flags, filter_str = build_trim_filter(spec)
    encode_flags = [
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
    ]

    fd, fc_path = tempfile.mkstemp(suffix=".txt", prefix="apply_cuts_fc_")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(filter_str)
        run([
            "ffmpeg", "-y", *input_flags,
            "-/filter_complex", fc_path,
            "-map", "[vout]", "-map", "[aout]",
            *encode_flags, args.out,
        ])
    finally:
        if os.path.exists(fc_path):
            os.unlink(fc_path)

    check_output(args.out)
    print(args.out)


if __name__ == "__main__":
    main()
