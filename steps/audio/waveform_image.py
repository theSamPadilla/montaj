#!/usr/bin/env python3
"""Generate waveform PNG images from a video or audio file.

Subdivides the input into chunks of at most --chunk-duration seconds and
writes one PNG per chunk using ffmpeg's showwavespic filter. Outputs a JSON
array of {path, start, end} entries — one per chunk.

Images go into a subdir named <stem>_waveforms/ alongside the input file,
keeping the source directory clean.
"""
import json, math, os, sys, argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, get_duration


def process_one(input_path: str, chunk_duration: float, out_dir: str | None) -> list:
    require_file(input_path)
    duration = get_duration(input_path)

    stem = os.path.splitext(os.path.basename(input_path))[0]
    target_dir = out_dir or os.path.join(os.path.dirname(os.path.abspath(input_path)), f"{stem}_waveforms")
    os.makedirs(target_dir, exist_ok=True)

    n_chunks = max(1, math.ceil(duration / chunk_duration))
    chunks = []

    for i in range(n_chunks):
        start = i * chunk_duration
        end   = min(duration, start + chunk_duration)
        actual_dur = end - start

        out_path = os.path.join(target_dir, f"chunk_{i:02d}.png")

        run(["ffmpeg", "-y",
             "-ss", str(start), "-t", str(actual_dur),
             "-i", input_path,
             "-filter_complex", "[0:a]showwavespic=s=1920x240:colors=white[v]",
             "-map", "[v]",
             "-frames:v", "1",
             out_path])

        check_output(out_path)
        chunks.append({"path": out_path, "start": round(start, 3), "end": round(end, 3)})

    return chunks


def main():
    parser = argparse.ArgumentParser(description="Generate waveform PNG images subdivided into chunks")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--input",          help="Single source video or audio file")
    group.add_argument("--inputs",         nargs="+", metavar="FILE", help="Multiple source files (processed in parallel)")
    parser.add_argument("--chunk-duration", type=float, default=10.0,
                        help="Max seconds per waveform image (default: 10)")
    parser.add_argument("--out-dir",        help="Output directory for PNG files (default: <stem>_waveforms/ alongside input)")
    parser.add_argument("-P", "--parallel", type=int, default=0,
                        help="Max parallel workers for --inputs (default: number of inputs)")
    args = parser.parse_args()

    if args.chunk_duration <= 0:
        fail("invalid_param", "--chunk-duration must be greater than 0")

    if args.input:
        result = process_one(args.input, args.chunk_duration, args.out_dir)
        print(json.dumps(result))
    else:
        workers = args.parallel or len(args.inputs)
        results: dict[int, list] = {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(process_one, path, args.chunk_duration, args.out_dir): i
                for i, path in enumerate(args.inputs)
            }
            for future in as_completed(futures):
                idx = futures[future]
                results[idx] = future.result()
        print(json.dumps([results[i] for i in range(len(args.inputs))]))


if __name__ == "__main__":
    main()
