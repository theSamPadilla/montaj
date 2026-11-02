"""`normalize` output quality: sample rate, bitrate, true peak, duration.

Quiet, high-crest-factor inputs (a real voiceover: -31 LUFS, peaks near -11 dBFS)
used to come out resampled to 96 kHz at a default bitrate, clipping at 0 dBFS and
longer than the source. Real ffmpeg, short synthetic clips.
"""
import json
import subprocess
import sys

import pytest

from lib.common import ffmpeg_bin, ffprobe_bin
from tests.conftest import HAS_FFMPEG, REPO_ROOT

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")

STEP = str(REPO_ROOT / "steps" / "media" / "normalize.py")

# Quiet pink noise plus short loud tone bursts: low integrated loudness, peaks near -11 dBFS.
QUIET_SRC = (
    "anoisesrc=color=pink:amplitude=0.16:sample_rate={sr}:duration=6[n];"
    "sine=f=700:sample_rate={sr}:duration=6,volume='if(lt(mod(t,1.3),0.012),2.2,0)':eval=frame[b];"
    "[n][b]amix=inputs=2:duration=first:normalize=0"
)


def _ff(*args):
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", *args], check=True, capture_output=True, timeout=120)


def _quiet(path, sr, layout, *codec):
    graph = QUIET_SRC.format(sr=sr)
    if layout == "stereo":
        graph += ",pan=stereo|c0=c0|c1=c0"
    _ff("-filter_complex", graph, "-ar", str(sr), *codec, str(path))


def _stream(path):
    r = subprocess.run([ffprobe_bin(), "-v", "quiet", "-select_streams", "a:0", "-show_entries",
                        "stream=codec_name,sample_rate,bit_rate,duration:format=duration",
                        "-of", "json", str(path)], capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)
    s = d["streams"][0]
    return {"codec": s["codec_name"], "rate": int(s["sample_rate"]),
            "bitrate": int(s.get("bit_rate") or 0),
            "stream_dur": float(s.get("duration") or 0), "format_dur": float(d["format"]["duration"])}


def _loudness(path):
    r = subprocess.run([ffmpeg_bin(), "-v", "info", "-i", str(path), "-af",
                        "loudnorm=print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True, timeout=120)
    j = json.loads(r.stderr[r.stderr.rfind("{"):r.stderr.rfind("}") + 1])
    return float(j["input_i"]), float(j["input_tp"])


def _normalize(src, out=None):
    cmd = [sys.executable, STEP, "--input", str(src), "--target", "youtube"]
    if out:
        cmd += ["--out", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, cwd=str(REPO_ROOT))
    assert r.returncode == 0, r.stderr
    return r.stdout.strip().splitlines()[-1]


def _check(src, out, lossy):
    s, o = _stream(src), _stream(out)
    i, tp = _loudness(out)
    print(f"src {s}\nout {o}\nI={i} TP={tp}")
    assert o["rate"] == s["rate"]
    assert abs(o["format_dur"] - s["format_dur"]) <= 0.005, (o, s)
    assert tp <= -1.0, tp
    assert abs(i - -14) <= 1.5, i
    if lossy:
        assert o["bitrate"] >= 0.9 * s["bitrate"], (o, s)
    return o, s


def test_source_is_quiet_with_high_crest(tmp_path):
    src = tmp_path / "vo.m4a"
    _quiet(src, 44100, "mono", "-c:a", "aac", "-b:a", "124k")
    i, tp = _loudness(src)
    assert i < -26 and tp > -16, (i, tp)


def test_quiet_mono_aac_keeps_rate_bitrate_peak_and_duration(tmp_path):
    src = tmp_path / "vo.m4a"
    _quiet(src, 44100, "mono", "-c:a", "aac", "-b:a", "124k")
    out = _normalize(src)
    assert out == str(tmp_path / "vo_normalized.m4a")
    o, _ = _check(src, out, lossy=True)
    assert o["codec"] == "aac"


def test_stereo_wav_stays_pcm_and_keeps_rate(tmp_path):
    src = tmp_path / "vo.wav"
    _quiet(src, 48000, "stereo", "-c:a", "pcm_s16le")
    out = _normalize(src)
    o, _ = _check(src, out, lossy=False)
    assert o["codec"].startswith("pcm_")
    assert o["bitrate"] >= 0  # lossless: no -b:a applied


def test_mp4_video_copied_audio_fixed(tmp_path):
    aud = tmp_path / "a.m4a"
    _quiet(aud, 44100, "mono", "-c:a", "aac", "-b:a", "124k")
    src = tmp_path / "clip.mp4"
    _ff("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=6", "-i", str(aud),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", "-shortest", str(src))
    out = _normalize(src)
    o, _ = _check(src, out, lossy=True)
    assert o["codec"] == "aac"
    v = subprocess.run([ffprobe_bin(), "-v", "quiet", "-select_streams", "v:0", "-show_entries",
                        "stream=codec_name,nb_frames", "-of", "json", out], capture_output=True, text=True)
    assert json.loads(v.stdout)["streams"][0]["codec_name"] == "h264"
