#!/usr/bin/env python3
"""Map virtual-timeline timestamps to original-file timestamps (and inverse)."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail


def total_virtual_duration(keeps):
    return sum(e - s for s, e in keeps)


def virtual_to_original(keeps, v_time):
    """Map a virtual timestamp to the corresponding original-file timestamp."""
    cursor = 0.0
    for s, e in keeps:
        seg_dur = e - s
        if cursor + seg_dur >= v_time:
            return s + (v_time - cursor)
        cursor += seg_dur
    return None  # past end


def original_to_virtual(keeps, o_time):
    """Map an original-file timestamp to the corresponding virtual timestamp."""
    cursor = 0.0
    for s, e in keeps:
        if s <= o_time <= e:
            return cursor + (o_time - s)
        cursor += e - s
    return None  # not within any segment


def find_segment_index(keeps, o_time):
    """Return the index of the keep segment containing original timestamp o_time."""
    for i, (s, e) in enumerate(keeps):
        if s <= o_time <= e:
            return i
    return None


def resolve_timestamps(keeps, timestamps, inverse, verbose=False):
    total_dur = total_virtual_duration(keeps)
    results = []
    for t in timestamps:
        if inverse:
            result = original_to_virtual(keeps, t)
            if result is None:
                print(f"warning: original timestamp {t} not within any keep segment", file=sys.stderr)
            results.append((t, result, None))
        else:
            if t > total_dur:
                print(f"warning: virtual timestamp {t} exceeds total duration {total_dur:.3f}s, clamping", file=sys.stderr)
                t = total_dur
            result = virtual_to_original(keeps, t)
            if result is None:
                result = keeps[-1][1]
            seg_idx = find_segment_index(keeps, result) if verbose else None
            results.append((t, result, seg_idx))
    return results


def main():
    parser = argparse.ArgumentParser(
        description="Map virtual-timeline timestamps to original-file timestamps"
    )
    parser.add_argument("--input", required=True, help="Trim spec JSON file")
    # CLI: positional timestamps; HTTP API: --times flag (emits JSON)
    parser.add_argument("times_pos", nargs="*", type=float, metavar="TIME",
                        help="Timestamps to map (positional, CLI use)")
    parser.add_argument("--times",
                        help="Timestamps as JSON array, e.g. '[47.32, 53.23]' (HTTP API use, outputs JSON)")
    parser.add_argument("--inverse", action="store_true",
                        help="Map original-file timestamps to virtual timestamps instead")
    parser.add_argument("--verbose", action="store_true",
                        help="Show which keep segment each timestamp falls in")
    args = parser.parse_intermixed_args()

    if not os.path.isfile(args.input):
        fail("file_not_found", f"Spec file not found: {args.input}")

    try:
        spec = json.loads(open(args.input).read())
    except Exception as e:
        fail("invalid_spec", f"Could not parse spec JSON: {e}")

    if "keeps" not in spec:
        fail("invalid_spec", "Spec must have a 'keeps' field")

    keeps = spec["keeps"]

    use_flag_form = bool(args.times)
    if use_flag_form:
        try:
            timestamps = json.loads(args.times)
        except Exception as e:
            fail("invalid_params", f"Could not parse --times JSON: {e}")
    else:
        timestamps = args.times_pos

    if not timestamps:
        fail("no_input", "Provide at least one timestamp")

    results = resolve_timestamps(keeps, timestamps, args.inverse, verbose=args.verbose)

    if use_flag_form:
        # JSON output for HTTP API
        print(json.dumps({"results": [round(r, 3) if r is not None else None for _, r, _ in results]}))
    else:
        # Per-line output for CLI
        for t, r, seg_idx in results:
            if r is None:
                print("null")
            elif args.verbose and seg_idx is not None:
                s, e = keeps[seg_idx]
                print(f"{t} → {r:.3f}  (keep {seg_idx}: [{s:.3f}, {e:.3f}])")
            else:
                print(f"{r:.3f}")


if __name__ == "__main__":
    main()
