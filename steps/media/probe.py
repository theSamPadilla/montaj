#!/usr/bin/env python3
"""Probe video file and output JSON metadata."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, require_cmd, run

def main():
    parser = argparse.ArgumentParser(description="Extract metadata from a video file")
    parser.add_argument("--input", required=True, help="Video file to probe")
    args = parser.parse_args()

    require_cmd("ffprobe")
    require_file(args.input)

    r = run(["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", args.input])
    data = json.loads(r.stdout)

    result = {
        "duration": round(float(data["format"]["duration"]), 2),
        "size_bytes": int(data["format"]["size"]),
        "format": data["format"]["format_name"],
        "streams": []
    }
    for s in data.get("streams", []):
        stream = {
            "type": s.get("codec_type"),
            "codec": s.get("codec_name"),
            "width": s.get("width"),
            "height": s.get("height"),
            "channels": s.get("channels"),
            "sample_rate": s.get("sample_rate"),
        }
        fps_str = s.get("r_frame_rate", "")
        if "/" in fps_str:
            num, den = fps_str.split("/")
            if int(den) > 0:
                stream["fps"] = round(int(num) / int(den), 2)
        result["streams"].append(stream)

    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
