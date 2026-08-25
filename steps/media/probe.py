#!/usr/bin/env python3
"""Probe video file and output JSON metadata."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, require_cmd, run, ffprobe_bin
from normalize import probe_video

def main():
    parser = argparse.ArgumentParser(description="Extract metadata from a video file")
    parser.add_argument("--input", required=True, help="Video file to probe")
    args = parser.parse_args()

    require_cmd(ffprobe_bin())
    require_file(args.input)

    r = run([ffprobe_bin(), "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", args.input])
    data = json.loads(r.stdout)

    # Single source of truth for rotation/display dims (lib/normalize.probe_video).
    # It's whole-file, v:0-only — describes the FIRST video stream only. Applying
    # its values to any additional video stream would be wrong, so those (a
    # non-real montaj case) fall back to rotation 0 / display == coded below.
    rotation_info = probe_video(args.input)

    result = {
        "duration": round(float(data["format"]["duration"]), 2),
        "size_bytes": int(data["format"]["size"]),
        "format": data["format"]["format_name"],
        "streams": []
    }
    first_video_seen = False
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

        if s.get("codec_type") == "video":
            if not first_video_seen and rotation_info is not None:
                stream["rotation"] = rotation_info["rotation"]
                stream["display_width"] = rotation_info["display_width"]
                stream["display_height"] = rotation_info["display_height"]
            else:
                # probe_video() failed, or this is a 2nd+ video stream that
                # probe_video() doesn't describe — assume no rotation.
                stream["rotation"] = 0
                stream["display_width"] = stream["width"]
                stream["display_height"] = stream["height"]
            first_video_seen = True

        result["streams"].append(stream)

    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
