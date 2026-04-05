#!/usr/bin/env python3
"""Shared helpers for video-toolkit scripts. All scripts import from here."""
import json, os, shutil, subprocess, sys


def fail(code: str, message: str):
    """Print structured error to stderr and exit."""
    print(json.dumps({"error": code, "message": message}), file=sys.stderr)
    sys.exit(1)


def require_cmd(name: str):
    if shutil.which(name) is None:
        fail("missing_dependency", f"{name} not found. Run setup/install.sh")


def require_file(path: str):
    if not os.path.isfile(path):
        fail("file_not_found", f"File not found: {path}")


def check_output(path: str):
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        fail("empty_output", f"Output file is empty: {path}")


def run(cmd: list[str], timeout: int = 300, check: bool = True) -> subprocess.CompletedProcess:
    """Run a command without a shell, capture output."""
    r = subprocess.run(cmd, shell=False, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        fail("unexpected_error", f"Command failed: {' '.join(cmd)}\n{r.stderr[:500]}")
    return r


def run_ffmpeg(args: list[str], timeout: int = 300):
    """Run ffmpeg, suppress output."""
    return run(["ffmpeg"] + args, timeout=timeout)


def ffprobe_value(path: str, entries: str, stream_select: str = "") -> str:
    """Get a single value from ffprobe."""
    cmd = ["ffprobe", "-v", "quiet"]
    if stream_select:
        cmd += ["-select_streams", stream_select]
    cmd += ["-show_entries", entries, "-of", "csv=p=0", path]
    r = run(cmd)
    return r.stdout.strip()


def get_duration(path: str) -> float:
    return float(ffprobe_value(path, "format=duration"))


def get_codec(path: str) -> str:
    return ffprobe_value(path, "stream=codec_name", "v:0")


def api_call(url: str, method: str = "GET", headers: dict = None, data: str = None) -> str:
    """Make an API call via curl."""
    cmd = ["curl", "-s", "-f"]
    if method != "GET":
        cmd += ["-X", method]
    if headers:
        for k, v in headers.items():
            cmd += ["-H", f"{k}: {v}"]
    if data:
        cmd += ["-d", data]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        fail("api_error", f"API request failed: {url}")
    return r.stdout


def load_env(env_path: str = None):
    """Load .env file into os.environ. Returns dict of loaded vars."""
    if env_path is None:
        env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if not os.path.isfile(env_path):
        fail("missing_config", f".env not found at {env_path}")
    loaded = {}
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                os.environ[key] = val
                loaded[key] = val
    return loaded


# Add lib dir to path for imports
LIB_DIR = os.path.dirname(os.path.abspath(__file__))
if LIB_DIR not in sys.path:
    sys.path.insert(0, LIB_DIR)
TOOLKIT_DIR = os.path.dirname(LIB_DIR)


# ---------------------------------------------------------------------------
# Whisper.cpp helpers — canonical transcription backend
# ---------------------------------------------------------------------------

def find_whisper_bin() -> str:
    """Return path to whisper.cpp binary.

    Priority:
    1. Montaj-managed binary (~/.local/share/montaj/models/whisper/whisper-cli)
    2. System PATH (whisper-cpp or whisper-cli) — fallback for existing installs
    """
    import models as _models
    managed = _models.model_path("whisper", "whisper-cli")
    if os.path.isfile(managed):
        return managed
    for name in ("whisper-cpp", "whisper-cli"):
        path = shutil.which(name)
        if path:
            return path
    fail("missing_dependency",
         "whisper.cpp not found. Install with: montaj install whisper")


def transcribe_words(input_path: str, model: str = "base.en", work_dir: str = None) -> list:
    """Transcribe audio or video with whisper.cpp.

    Returns a flat list of {"text": str, "start": float, "end": float} dicts (seconds).
    Uses --split-on-word --max-len 1 to get one entry per word.
    """
    import mimetypes, tempfile
    own_work = work_dir is None
    if own_work:
        work_dir = tempfile.mkdtemp(prefix="transcribe_")
    try:
        mime = mimetypes.guess_type(input_path)[0] or ""
        if mime.startswith("video/") or not mime.startswith("audio/"):
            audio = os.path.join(work_dir, "audio.wav")
            run(["ffmpeg", "-y", "-i", input_path, "-vn", "-acodec", "pcm_s16le",
                 "-ar", "16000", "-ac", "1", audio])
        else:
            audio = input_path

        import models as _models
        model_file = _models.model_path("whisper", f"ggml-{model}.bin")
        # Fall back to old brew-installed path for existing users
        if not os.path.isfile(model_file):
            old_path = os.path.expanduser(f"~/.local/share/whisper.cpp/models/ggml-{model}.bin")
            if os.path.isfile(old_path):
                model_file = old_path
        require_file(model_file)  # fails with clear error if neither path works
        whisper_bin = find_whisper_bin()

        prefix = os.path.join(work_dir, "out")
        run([whisper_bin, "-m", model_file, "-f", audio, "-l", "en",
             "--split-on-word", "--max-len", "1", "--output-json", "--output-file", prefix],
            check=False)

        words = []
        json_path = f"{prefix}.json"
        if os.path.exists(json_path):
            data = json.loads(open(json_path).read())
            for entry in data.get("transcription", []):
                text = entry.get("text", "").strip()
                if not text:
                    continue
                offsets = entry.get("offsets", {})
                words.append({
                    "text":  text,
                    "start": offsets.get("from", 0) / 1000.0,
                    "end":   offsets.get("to",   0) / 1000.0,
                })
        return words
    finally:
        if own_work:
            shutil.rmtree(work_dir, ignore_errors=True)
