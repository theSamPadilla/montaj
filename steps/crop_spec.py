#!/usr/bin/env python3
"""Crop a trim spec to one or more virtual-timeline windows."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail


def virtual_to_segments(keeps, v_start, v_end):
    """Return original-file keep segments for virtual window [v_start, v_end]."""
    result = []
    cursor = 0.0
    for s, e in keeps:
        seg_dur = e - s
        seg_v_start = cursor
        seg_v_end = cursor + seg_dur
        if seg_v_end <= v_start or seg_v_start >= v_end:
            cursor = seg_v_end
            continue
        clip_v_start = max(seg_v_start, v_start)
        clip_v_end   = min(seg_v_end, v_end)
        orig_start   = s + (clip_v_start - seg_v_start)
        orig_end     = s + (clip_v_end   - seg_v_start)
        result.append([orig_start, orig_end])
        cursor = seg_v_end
    return result


def parse_window(s):
    """Parse 'start:end' or 'start:end' where end may be 'end'. Returns (float, float|None)."""
    parts = s.split(":")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"Invalid window '{s}': expected start:end")
    start_s, end_s = parts
    try:
        start = float(start_s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"Invalid start in window '{s}'")
    if end_s.lower() == "end":
        end = None
    else:
        try:
            end = float(end_s)
        except ValueError:
            raise argparse.ArgumentTypeError(f"Invalid end in window '{s}'")
    return (start, end)


def total_virtual_duration(keeps):
    return sum(e - s for s, e in keeps)


def crop(spec, windows):
    """Apply a list of (v_start, v_end|None) windows to spec. Returns new keeps list."""
    keeps = spec["keeps"]
    total_dur = total_virtual_duration(keeps)

    all_keeps = []
    for v_start, v_end in windows:
        if v_end is None:
            v_end = total_dur
        v_end = min(v_end, total_dur)  # clamp silently
        segs = virtual_to_segments(keeps, v_start, v_end)
        # Drop floating-point artifacts
        segs = [[s, e] for s, e in segs if e - s >= 0.01]
        all_keeps.extend(segs)

    return all_keeps


def main():
    parser = argparse.ArgumentParser(description="Crop a trim spec to virtual-timeline windows")
    parser.add_argument("--input", required=True, help="Trim spec JSON file")
    # CLI form: --keep start:end (repeatable, human-friendly)
    parser.add_argument("--keep", action="append", metavar="START:END", type=parse_window,
                        help="Virtual-timeline window to keep, e.g. 8.5:14.8 or 40.28:end. Repeatable.")
    # HTTP API form: --keeps '[[0,2.4],[13.84,18.33]]' (JSON array of [start,end] pairs)
    parser.add_argument("--keeps", metavar="JSON",
                        help="Windows as a JSON array of [start,end] pairs (HTTP API use)")
    parser.add_argument("--out", help="Output path (default: <stem>_cropped.json)")
    args = parser.parse_args()

    if not args.keep and not args.keeps:
        parser.error("one of --keep or --keeps is required")

    if not os.path.isfile(args.input):
        fail("file_not_found", f"Spec file not found: {args.input}")

    try:
        spec = json.loads(open(args.input).read())
    except Exception as e:
        fail("invalid_spec", f"Could not parse spec JSON: {e}")

    if "keeps" not in spec or "input" not in spec:
        fail("invalid_spec", "Spec must have 'input' and 'keeps' fields")

    if args.keeps:
        try:
            raw = json.loads(args.keeps)
            windows = [(w[0], w[1] if w[1] is not None else None) for w in raw]
        except Exception as e:
            fail("invalid_params", f"Could not parse --keeps JSON: {e}")
    else:
        windows = args.keep

    new_keeps = crop(spec, windows)

    out_path = args.out or os.path.join(
        os.path.dirname(args.input),
        os.path.splitext(os.path.basename(args.input))[0] + "_cropped.json"
    )

    result = {"input": spec["input"], "keeps": new_keeps}
    with open(out_path, "w") as f:
        json.dump(result, f)

    total = sum(e - s for s, e in new_keeps)
    print(f"total duration after crop: {total:.3f}s", file=sys.stderr)
    print(out_path)


if __name__ == "__main__":
    main()
