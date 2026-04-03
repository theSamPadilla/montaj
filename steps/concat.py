#!/usr/bin/env python3
"""Concatenate video files or trim specs. Auto-detects HEVC and normalizes to H.264 CRF 18."""
import os, sys, argparse, tempfile, shutil

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run, get_codec
from trim_spec import is_trim_spec, load as load_spec


def build_trim_concat_filter(specs: list) -> tuple:
    """
    Build filter_complex that applies keeps from each trim spec and concatenates all clips.
    Returns (input_flags, filter_string).
    input_flags: ["-i", path, "-i", path, ...] for each spec
    filter_string: the full filter_complex string
    """
    input_flags = []
    filter_parts = []
    clip_out_labels = []

    for clip_idx, spec in enumerate(specs):
        input_flags += ["-i", spec["input"]]
        keeps = spec["keeps"]
        n = len(keeps)

        if n == 1:
            s, e = keeps[0]
            filter_parts.append(
                f"[{clip_idx}:v]trim=start={s:.4f}:end={e:.4f},setpts=PTS-STARTPTS,fps=30[v{clip_idx}]"
            )
            filter_parts.append(
                f"[{clip_idx}:a]atrim=start={s:.4f}:end={e:.4f},asetpts=PTS-STARTPTS[a{clip_idx}]"
            )
        else:
            vs = "".join(f"[vs{clip_idx}_{i}]" for i in range(n))
            as_ = "".join(f"[as{clip_idx}_{i}]" for i in range(n))
            filter_parts.append(f"[{clip_idx}:v]split={n}{vs}")
            filter_parts.append(f"[{clip_idx}:a]asplit={n}{as_}")
            for i, (s, e) in enumerate(keeps):
                filter_parts.append(
                    f"[vs{clip_idx}_{i}]trim=start={s:.4f}:end={e:.4f},"
                    f"setpts=PTS-STARTPTS,fps=30[vc{clip_idx}_{i}]"
                )
                filter_parts.append(
                    f"[as{clip_idx}_{i}]atrim=start={s:.4f}:end={e:.4f},"
                    f"asetpts=PTS-STARTPTS[ac{clip_idx}_{i}]"
                )
            seg_in = "".join(f"[vc{clip_idx}_{i}][ac{clip_idx}_{i}]" for i in range(n))
            filter_parts.append(
                f"{seg_in}concat=n={n}:v=1:a=1[v{clip_idx}][a{clip_idx}]"
            )
        clip_out_labels.append((f"[v{clip_idx}]", f"[a{clip_idx}]"))

    n_clips = len(specs)
    if n_clips == 1:
        filter_parts.append(f"[v0]null[vout]")
        filter_parts.append(f"[a0]anull[aout_raw]")
    else:
        all_in = "".join(f"{v}{a}" for v, a in clip_out_labels)
        filter_parts.append(f"{all_in}concat=n={n_clips}:v=1:a=1[vout][aout_raw]")
    filter_parts.append("[aout_raw]aresample=async=1000[aout]")

    return input_flags, ";".join(filter_parts)


def main():
    parser = argparse.ArgumentParser(description="Concatenate video files into one")
    parser.add_argument("--inputs", nargs="+", required=True, help="Input video files in order")
    parser.add_argument("--out", help="Output file path")
    args = parser.parse_args()

    if not args.out:
        base = os.path.splitext(os.path.basename(args.inputs[0]))[0]
        args.out = os.path.join(os.path.dirname(args.inputs[0]), f"{base}_concat.mp4")

    all_are_specs = all(is_trim_spec(f) for f in args.inputs)
    all_are_videos = not any(is_trim_spec(f) for f in args.inputs)

    if not all_are_specs and not all_are_videos:
        fail("invalid_input", "Cannot mix trim spec JSON files and video files in --inputs")

    if all_are_specs:
        specs = [load_spec(f) for f in args.inputs]
        input_flags, filter_str = build_trim_concat_filter(specs)
        encode_flags = [
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
        ]
        fd, fc_path = tempfile.mkstemp(suffix=".txt", prefix="concat_fc_")
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
        return
    # (existing code continues below for video files)

    is_hevc = False
    for f in args.inputs:
        require_file(f)
        codec = get_codec(f)
        if codec.startswith("hevc") or codec.startswith("h265"):
            is_hevc = True

    work = tempfile.mkdtemp(prefix="concat_")
    try:
        filelist = os.path.join(work, "filelist.txt")

        if is_hevc:
            # Normalize each clip to H.264 individually
            # DO NOT re-encode to HEVC/H.265 — produces glitches
            with open(filelist, "w") as fl:
                for i, f in enumerate(args.inputs):
                    norm = os.path.join(work, f"{i:03d}.mp4")
                    run(["ffmpeg", "-y", "-i", f,
                         "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                         "-fps_mode", "cfr", "-r", "30",
                         "-c:a", "aac", "-b:a", "192k",
                         "-af", "aresample=async=1", norm])
                    fl.write(f"file '{norm}'\n")
        else:
            with open(filelist, "w") as fl:
                for f in args.inputs:
                    fl.write(f"file '{os.path.realpath(f)}'\n")

        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", filelist, "-c", "copy", args.out])
    finally:
        shutil.rmtree(work, ignore_errors=True)

    check_output(args.out)
    print(args.out)

if __name__ == "__main__":
    main()
