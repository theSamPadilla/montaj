"""Counter-strip clips for frame-exact cut tests (FQ54).

Each frame carries its own index as a binary strip of black/white 16x16
blocks, read back by sampling block-centre pixels (no OCR), so a test can
assert the exact source frame indices a cut or seek returns.
"""
import subprocess
from pathlib import Path

from lib.common import ffmpeg_bin

BLOCK = 16
BITS = 9                          # frame indices 0..511
W, H = BLOCK * (BITS + 1), BLOCK  # +1: an always-white sanity block


def _frame(i: int) -> bytes:
    row = bytearray()
    for b in range(BITS + 1):
        on = b == BITS or (i >> b) & 1
        row += (b"\xff" if on else b"\x00") * BLOCK
    return bytes(row) * H


def make_counter_clip(path: Path, rate: str, n_frames: int) -> None:
    """All-intra H.264 (so any miss is timestamps, not GOP) at `rate` (an
    ffmpeg rate such as "30" or "30000/1001") plus a tone track."""
    subprocess.run([
        ffmpeg_bin(), "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", rate, "-i", "-",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-c:v", "libx264", "-crf", "10", "-g", "1", "-bf", "0", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000", "-shortest", str(path),
    ], input=b"".join(_frame(i) for i in range(n_frames)), check=True, capture_output=True,
        timeout=60)


def indices(path: Path) -> list:
    """Each decoded frame's counter value, in order, read from block-centre
    pixels. Decoded at constant rate, so a stream that starts late shows its
    first frame repeated."""
    raw = subprocess.run([ffmpeg_bin(), "-v", "error", "-nostdin", "-i", str(path),
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, check=True, timeout=60).stdout
    size = W * H
    out = []
    for f in range(len(raw) // size):
        row = raw[f * size + (H // 2) * W:f * size + (H // 2 + 1) * W]
        px = [row[b * BLOCK + BLOCK // 2] for b in range(BITS + 1)]
        assert px[BITS] > 200, f"{path.name} frame {f}: sanity block is dark ({px})"
        assert all(c < 60 or c > 195 for c in px), f"{path.name} frame {f}: ambiguous bit {px}"
        out.append(sum(1 << b for b in range(BITS) if px[b] >= 128))
    return out
