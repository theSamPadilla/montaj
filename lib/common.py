#!/usr/bin/env python3
"""Shared helpers for video-toolkit scripts. All scripts import from here."""
import json, os, re, shutil, subprocess, sys


SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]+$")
"""Filesystem-safe single-segment name. No spaces, no special chars, no
path separators. Used by serve/server.py reserve-path validation and
project/init.py --project-path segment validation."""


def fail(code: str, message: str):
    """Print structured error to stderr and exit."""
    print(json.dumps({"error": code, "message": message}), file=sys.stderr)
    sys.exit(1)


def progress(message: str):
    """Print structured progress to stderr. Non-fatal, ignored by serve on success.

    Convention: steps emit {"progress": "..."} to stderr for observability.
    - On exit 0: serve ignores stderr. CLI callers / agents can read it.
    - On exit 1: serve parses stderr for {"error": ...}; progress lines are skipped.
    """
    print(json.dumps({"progress": message}), file=sys.stderr, flush=True)


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


# English-only (".en") whisper models cannot decode other languages — they emit
# sparse/garbage word timestamps, which downstream steps (e.g. rm_nonspeech) then
# treat as silence and cut, silently deleting most of the speech. When the caller
# asks for a non-English language we transparently swap the ".en" model for its
# multilingual sibling (same size → same speed), falling back to whatever
# multilingual weights are actually installed.
_EN_TO_MULTILINGUAL = {
    "tiny.en": "tiny", "base.en": "base", "small.en": "small", "medium.en": "medium",
}

# Whisper weights live in the Montaj-managed model dir; older installs may still
# have whisper.cpp's legacy directory, so both are checked. Module-level so tests
# can point it at a scratch dir.
LEGACY_WHISPER_DIR = os.path.expanduser("~/.local/share/whisper.cpp/models")


def whisper_weight_path(name: str):
    """Path to ``ggml-<name>.bin`` (managed dir first, then the legacy
    whisper.cpp dir), or None if the weight is not installed."""
    import models as _models
    managed = _models.model_path("whisper", f"ggml-{name}.bin")
    if os.path.isfile(managed):
        return managed
    legacy = os.path.join(LEGACY_WHISPER_DIR, f"ggml-{name}.bin")
    if os.path.isfile(legacy):
        return legacy
    return None


def resolve_whisper_model(model: str, language: str) -> str:
    """Pick the right whisper model for *language*.

    English (or unspecified) → *model* unchanged. For any other language (or
    ``auto``), an English-only ``*.en`` model is swapped for a multilingual one:
    its same-size sibling when present, else the best installed multilingual
    weight. If the audio is non-English but no multilingual weight is installed,
    fail with an actionable message (instead of returning a model whose file is
    missing, which would surface later as a cryptic file-not-found). Already-
    multilingual models pass through untouched.
    """
    lang = (language or "en").strip().lower()
    if lang in ("en", "english"):
        return model
    if not model.endswith(".en"):
        return model
    sibling = _EN_TO_MULTILINGUAL.get(model, model[:-3])
    # Prefer the same-size sibling, then progressively more capable installed
    # weights. dict.fromkeys dedups when the sibling already appears in the chain.
    for cand in dict.fromkeys([sibling, "medium", "large-v3", "large", "base"]):
        if whisper_weight_path(cand) is not None:
            return cand
    fail("missing_multilingual_model",
         f"language={language!r} needs a multilingual whisper model, but only "
         f"English-only (*.en) weights are installed. Install one with: "
         f"montaj models download {sibling}")


def transcribe_words(input_path: str, model: str = "base.en", work_dir: str = None,
                     language: str = "en") -> list:
    """Transcribe audio or video with whisper.cpp.

    Returns a flat list of {"text": str, "start": float, "end": float} dicts (seconds).
    Uses --split-on-word --max-len 1 to get one entry per word.
    ``language`` is the whisper language code (e.g. "es"), or "auto" for
    whisper-cli language auto-detection. A non-English ``language`` automatically
    upgrades an English-only ``*.en`` ``model`` to a multilingual one.
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
        model = resolve_whisper_model(model, language)
        # Managed dir first, then the legacy whisper.cpp dir for older installs.
        model_file = whisper_weight_path(model) or _models.model_path("whisper", f"ggml-{model}.bin")
        require_file(model_file)  # fails with a clear error if the model isn't installed
        whisper_bin = find_whisper_bin()

        prefix = os.path.join(work_dir, "out")
        run([whisper_bin, "-m", model_file, "-f", audio, "-l", language,
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
