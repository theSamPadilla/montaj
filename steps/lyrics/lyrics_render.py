#!/usr/bin/env python3
"""Render a lyrics video by burning caption track text onto a background using ffmpeg drawtext.

Takes a caption track JSON (from lyrics_sync / caption) and an audio file, and produces
an MP4 with word-by-word accumulated text overlaid on a solid-color or video background.
"""
import json, os, sys, argparse, subprocess
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, run_ffmpeg, get_duration

try:
    import static_ffmpeg
    static_ffmpeg.add_paths()
except ImportError:
    pass  # Not installed; rely on system ffmpeg

# ---------------------------------------------------------------------------
# Font detection
# ---------------------------------------------------------------------------

_FONT_CANDIDATES = [
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
]


def _find_fontfile():
    for path in _FONT_CANDIDATES:
        if os.path.isfile(path):
            return path
    return None


# ---------------------------------------------------------------------------
# Smart color detection
# ---------------------------------------------------------------------------

def _detect_text_color(video_path: str) -> str:
    """Sample video frames, compute average luminance, return 'black' or 'white'.

    Bright backgrounds (avg luminance > 128) → 'black' text.
    Dark backgrounds → 'white' text.
    Falls back to 'white' on any error.
    """
    try:
        # Get duration
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", video_path],
            capture_output=True, text=True, timeout=10,
        )
        dur = float(probe.stdout.strip() or "10")

        # Sample 5 frames evenly, scale to 16×16 grayscale → fast luminance estimate
        total, count = 0, 0
        for i in range(5):
            seek = dur * (i + 0.5) / 5
            res = subprocess.run(
                ["ffmpeg", "-ss", str(seek), "-i", video_path,
                 "-vf", "scale=16:16", "-frames:v", "1",
                 "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
                capture_output=True, timeout=10,
            )
            if res.returncode == 0 and res.stdout:
                total += sum(res.stdout) / len(res.stdout)
                count += 1

        if count == 0:
            return "white"
        avg = total / count          # 0–255
        return "black" if avg > 128 else "white"
    except Exception:
        return "white"


# ---------------------------------------------------------------------------
# Text escaping
# ---------------------------------------------------------------------------

def _escape_drawtext(text: str) -> str:
    """Escape text for use inside a single-quoted drawtext filter text= value.

    Single-quote wrapping is required to protect commas (filter chain separator)
    and other special characters. Apostrophes (U+0027) are replaced with the
    Unicode RIGHT SINGLE QUOTATION MARK (U+2019) which is visually identical
    but is not a quoting character in ffmpeg's filter parser — avoids the
    broken '\'' trick which silently drops drawtext filters in some ffmpeg builds.

    NOTE: Do not put newline characters in text — use _make_line_filters instead.
    """
    text = text.replace("\\", "\\\\")   # backslashes first
    text = text.replace(":", "\\:")     # colons
    text = text.replace("'", "\u2019")  # apostrophe → RIGHT SINGLE QUOTATION MARK
    return text


# ---------------------------------------------------------------------------
# Layout helpers
# ---------------------------------------------------------------------------

def _compute_wrap_points(words: list, n_lines: int) -> list:
    """Return sorted word indices for n_lines-1 line breaks (equal char distribution)."""
    if n_lines <= 1 or not words:
        return []
    full = " ".join(w["word"] for w in words)
    target = len(full) / n_lines
    wrap_points = []
    current_len = 0
    for i, w in enumerate(words[:-1]):
        current_len += len(w["word"]) + 1
        if len(wrap_points) < n_lines - 1 and current_len >= target * (len(wrap_points) + 1):
            wrap_points.append(i + 1)
    return wrap_points


def _segment_layout(words: list, base_fontsize: int, width: int,
                    char_ratio: float = 0.55, min_fs: int = 40) -> tuple:
    """Return (effective_fontsize, wrap_points) fitting the full phrase within width."""
    full = " ".join(w["word"] for w in words)
    n = len(full)
    avail = width * 0.90
    for n_lines in range(1, 4):
        chars_per = n / n_lines
        fs = int(avail / (chars_per * char_ratio)) if chars_per > 0 else base_fontsize
        fs = min(base_fontsize, fs)
        if fs >= min_fs:
            return fs, _compute_wrap_points(words, n_lines)
    chars_per = n / 3
    fs = max(min_fs, min(base_fontsize, int(avail / (chars_per * char_ratio))))
    return fs, _compute_wrap_points(words, 3)


def _lines_fontsize(lines: list, base_fontsize: int, width: int,
                    char_ratio: float = 0.55) -> int:
    """Return the largest fontsize ≤ base_fontsize where every line fits within width."""
    if not lines:
        return base_fontsize
    max_chars = max(len(line) for line in lines)
    avail = width * 0.88
    fs = int(avail / (max_chars * char_ratio)) if max_chars > 0 else base_fontsize
    return max(24, min(base_fontsize, fs))


def _make_accumulated_lines(words: list, up_to_idx: int, wrap_points: set) -> list:
    """Return list of line strings for words[0..up_to_idx] split at wrap_points."""
    lines, current = [], []
    for i in range(up_to_idx + 1):
        if i in wrap_points and current:
            lines.append(" ".join(current))
            current = []
        current.append(words[i]["word"])
    if current:
        lines.append(" ".join(current))
    return lines


# ---------------------------------------------------------------------------
# Core filter builder
# ---------------------------------------------------------------------------

def _contrast_color(color: str) -> str:
    """Return white or black, whichever contrasts with the given color."""
    dark = {"black", "#000000", "#111111", "#222222", "#333333", "#444444"}
    return "white" if color.lower() in dark else "black"


def _make_line_filters(lines, t_start, t_end, fontsize, color, x_expr,
                       position, height, lh, fontfile, box):
    """Generate one drawtext filter per line, vertically centered as a block.

    Each line is a separate filter — avoids ffmpeg's unreliable \\n escape handling.
    lh is the line-height in pixels (fontsize * line_height_factor).
    A contrasting border is always added so text is legible on both light and dark areas.
    """
    n = len(lines)
    total_h = n * lh

    if position == "center":
        block_top = (height - total_h) // 2
    elif position == "top-left":
        block_top = int(height * 0.08)
    else:  # bottom-left
        block_top = int(height * 0.82) - total_h

    border_color = _contrast_color(color)
    filters = []
    for k, line_text in enumerate(lines):
        y_val = block_top + k * lh
        escaped = _escape_drawtext(line_text)
        options = [
            f"text='{escaped}'",
            f"enable='between(t,{t_start},{t_end})'",
            f"x={x_expr}",
            f"y={y_val}",
            f"fontsize={fontsize}",
            f"fontcolor={color}",
            # Fully-opaque contrasting border so text is legible on any background
            # (including dark sprocket-hole areas of film-strip footage)
            f"borderw=4",
            f"bordercolor={border_color}",
            "shadowx=2",
            "shadowy=2",
            "shadowcolor=black@0.9",
        ]
        if box:
            options += ["box=1", "boxcolor=black@0.45", "boxborderw=14"]
        if fontfile:
            options.insert(0, f"fontfile='{fontfile}'")
        filters.append("drawtext=" + ":".join(options))
    return filters


def build_drawtext_filters(segments, fontsize, color, position="center", fontfile=None,
                           audio_in_point=0.0, width=720, height=1280, box=False,
                           accumulate=False, window_size=1, words_per_line=None,
                           line_height_factor=1.25):
    """Build a flat list of ffmpeg drawtext filter strings from caption segments.

    Rendering modes (in priority order):
      words_per_line=N   Show all words of each segment at once, N words per line.
                         No per-word animation — entire segment text is static.
      accumulate=True    Accumulate words left-to-right; auto-wrap to 2-3 lines.
      window_size=N      Sliding window: show last N words, one per line (N=2 default).
      default            Single word at a time.

    Multi-line text uses one drawtext filter per line (avoids \\n escape issues).
    """
    lh = int(fontsize * line_height_factor)

    # x expression: center horizontally on each line using its own text width
    x_expr = "(w-tw)/2" if position == "center" else str(int(width * 0.08))

    filters = []
    for seg_idx, seg in enumerate(segments):
        words = seg.get("words", [])
        if not words:
            continue

        if words_per_line is not None:
            # --- Static mode: show the entire segment at once, N words per line ---
            t_start = seg["start"] - audio_in_point
            # Clamp t_end to next segment's start to prevent simultaneous display
            # when caption timestamps overlap by a few hundred milliseconds
            next_seg_start = segments[seg_idx + 1]["start"] if seg_idx + 1 < len(segments) else None
            raw_end = min(seg["end"], next_seg_start) if next_seg_start else seg["end"]
            t_end   = raw_end - audio_in_point
            lines = [
                " ".join(w["word"] for w in words[i : i + words_per_line])
                for i in range(0, len(words), words_per_line)
            ]
            # Auto-size so the longest line fits the frame without clipping
            seg_fs = _lines_fontsize(lines, fontsize, width)
            seg_lh = int(seg_fs * line_height_factor)
            filters.extend(_make_line_filters(
                lines, t_start, t_end, seg_fs, color, x_expr,
                position, height, seg_lh, fontfile, box,
            ))

        elif accumulate or window_size > 1:
            # --- Per-word animation with multi-line text ---
            seg_fontsize, wrap_points = _segment_layout(words, fontsize, width)
            wrap_set = set(wrap_points)

            for i, word in enumerate(words):
                t_start = word["start"] - audio_in_point
                t_end   = (words[i + 1]["start"] if i + 1 < len(words) else seg["end"]) - audio_in_point

                if accumulate:
                    lines = _make_accumulated_lines(words, i, wrap_set)
                else:
                    start_w = max(0, i - window_size + 1)
                    lines = [w["word"] for w in words[start_w : i + 1]]

                filters.extend(_make_line_filters(
                    lines, t_start, t_end, seg_fontsize, color, x_expr,
                    position, height, lh, fontfile, box,
                ))

        else:
            # --- Single word at a time ---
            for i, word in enumerate(words):
                t_start = word["start"] - audio_in_point
                t_end   = (words[i + 1]["start"] if i + 1 < len(words) else seg["end"]) - audio_in_point
                filters.extend(_make_line_filters(
                    [word["word"]], t_start, t_end, fontsize, color, x_expr,
                    position, height, lh, fontfile, box,
                ))

    return filters


# ---------------------------------------------------------------------------
# Position mapping (kept for x_expr reference; y is now computed internally)
# ---------------------------------------------------------------------------

_POSITIONS = {
    "center":      ("(w-tw)/2",  "(h-th)/2"),
    "top-left":    ("w*0.08",    "h*0.08"),
    "bottom-left": ("w*0.08",    "h*0.82"),
}


# ---------------------------------------------------------------------------
# main()
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Render a lyrics video with word-by-word accumulated captions.")
    parser.add_argument("--captions",     required=True,
                        help="Caption track JSON from lyrics_sync / caption step")
    parser.add_argument("--audio",        required=True,
                        help="Song audio file")
    parser.add_argument("--input",        default=None,
                        help="Background video to loop. If omitted, uses a solid color.")
    parser.add_argument("--bg-color",     default="black",
                        help="Background color when --input is omitted (default: black)")
    parser.add_argument("--width",        type=int, default=720,
                        help="Output width in pixels (default: 720)")
    parser.add_argument("--height",       type=int, default=1280,
                        help="Output height in pixels (default: 1280)")
    parser.add_argument("--fps",          type=int, default=30,
                        help="Output frame rate (default: 30)")
    parser.add_argument("--fontsize",     type=int, default=72,
                        help="Caption font size (default: 72)")
    parser.add_argument("--color",        default="auto",
                        help="Caption text color, or 'auto' to detect from video (default: auto)")
    parser.add_argument("--position",     default="center",
                        choices=list(_POSITIONS.keys()),
                        help="Caption position (default: center)")
    parser.add_argument("--duration",     type=float, default=None,
                        help="Output duration in seconds (overrides full audio duration)")
    parser.add_argument("--preview-duration", type=float, default=None,
                        help="Only render this many seconds (overrides --duration)")
    parser.add_argument("--box",          action="store_true",
                        help="Draw a semi-transparent box behind caption text")
    parser.add_argument("--accumulate",   action="store_true",
                        help="Accumulate all words so far; default is word-by-word")
    parser.add_argument("--window-size",  type=int, default=1,
                        help="Sliding window: show last N words, one per line (default: 1)")
    parser.add_argument("--words-per-line", type=int, default=3,
                        help="Show full segment at once, N words per line (default: 3)")
    parser.add_argument("--audio-inpoint", type=float, default=None,
                        help="Seek position in the audio file (seconds). Overrides audioInPoint in captions JSON for the ffmpeg seek.")
    parser.add_argument("--out",          default=None,
                        help="Output path (default: <captions_basename>_render.mp4)")
    args = parser.parse_args()

    # Validate inputs
    require_file(args.captions)
    require_file(args.audio)
    if args.input is not None:
        require_file(args.input)

    # Load captions
    try:
        data = json.loads(Path(args.captions).read_text())
    except Exception as e:
        fail("invalid_captions", f"Could not parse captions JSON: {e}")

    segments = data.get("segments", [])
    audio_in_point = float(data.get("audioInPoint", 0.0))
    # audio_seek: where to start reading the audio file (separate from timestamp offset)
    audio_seek = args.audio_inpoint if args.audio_inpoint is not None else audio_in_point

    # Determine duration
    if args.preview_duration is not None:
        duration = args.preview_duration
    elif args.duration is not None:
        duration = args.duration
    else:
        try:
            duration = get_duration(args.audio)
        except Exception as e:
            fail("probe_error", f"Could not probe audio duration: {e}")

    # Output path
    if args.out:
        out = args.out
    else:
        stem = Path(args.captions).stem
        out = str(Path(args.captions).parent / f"{stem}_render.mp4")

    # Font detection
    fontfile = _find_fontfile()

    # Smart color detection
    # For variable backgrounds (film strips, mixed footage), white+black-border is
    # more reliable than auto-detected dark text which vanishes on dark areas.
    if args.color == "auto":
        color = "white"
    else:
        color = args.color

    # Build drawtext filters
    drawtext_filters = build_drawtext_filters(
        segments,
        fontsize=args.fontsize,
        color=color,
        position=args.position,
        fontfile=fontfile,
        audio_in_point=audio_in_point,
        width=args.width,
        height=args.height,
        box=args.box,
        accumulate=args.accumulate,
        window_size=args.window_size,
        words_per_line=args.words_per_line,
    )

    # Build vf chain
    if args.input:
        scale_filter = (f"scale={args.width}:{args.height}"
                        f":force_original_aspect_ratio=decrease"
                        f",pad={args.width}:{args.height}:(ow-iw)/2:(oh-ih)/2")
    else:
        scale_filter = None

    vf_parts = []
    if scale_filter:
        vf_parts.append(scale_filter)
    vf_parts.extend(drawtext_filters)
    vf_chain = ",".join(vf_parts) if vf_parts else "null"

    # Build ffmpeg args
    if args.input:
        ffmpeg_args = [
            "-y",
            "-stream_loop", "-1",
            "-i", args.input,
            "-ss", str(audio_seek),
            "-i", args.audio,
            "-t", str(duration),
            "-vf", vf_chain,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k",
            "-map", "0:v", "-map", "1:a",
            "-shortest",
            out,
        ]
    else:
        lavfi_src = f"color=c={args.bg_color}:s={args.width}x{args.height}:r={args.fps}"
        ffmpeg_args = [
            "-y",
            "-f", "lavfi", "-i", lavfi_src,
            "-ss", str(audio_seek),
            "-i", args.audio,
            "-t", str(duration),
            "-vf", vf_chain,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k",
            "-map", "0:v", "-map", "1:a",
            "-shortest",
            out,
        ]

    run_ffmpeg(ffmpeg_args)
    check_output(out)
    print(out)


if __name__ == "__main__":
    main()
