#!/usr/bin/env python3
"""Shared helpers for video-toolkit scripts. All scripts import from here."""
import contextlib, json, math, os, re, shutil, subprocess, sys, tempfile


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


def run(cmd: list[str], timeout: int = 300, check: bool = True, cwd: str = None) -> subprocess.CompletedProcess:
    """Run a command without a shell, capture output. ``cwd`` defaults to the
    caller's own (unchanged)."""
    r = subprocess.run(cmd, shell=False, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    if check and r.returncode != 0:
        fail("unexpected_error", f"Command failed: {' '.join(cmd)}\n{r.stderr[:4000]}")
    return r


@contextlib.contextmanager
def filter_script(graph: str, dir=None):
    """Write an ffmpeg filter graph to a temp file and yield its path.

    Windows caps a CreateProcess command line at 32,767 chars, so a graph never
    travels in argv: pass the path as ``-/filter_complex <path>`` or ``-/vf <path>``
    (ffmpeg 7+ reads the option value from the file). Always a file, never a
    size threshold, so every OS runs the same path.

    Bytes are exactly ``graph`` as UTF-8: no BOM, no trailing newline, written in
    binary mode (no cp1252, no CRLF). The fd is closed before the yield so the
    spawned ffmpeg can open the file on Windows. Names are unique (mkstemp), in
    the system temp dir unless ``dir`` is given, and removed on exit even if the
    body raises.
    """
    fd, path = tempfile.mkstemp(prefix="montaj_fc_", suffix=".txt", dir=dir)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(graph.encode("utf-8"))
        yield path
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


# Executable-name seam. Windows binaries carry a ".exe" suffix; everywhere
# else the name is used as-is, so on macOS/Linux _exe() is the identity.
# Tests prove Windows behaviour by patching _EXE_SUFFIX on this module, never
# sys.platform. Reused by other managed-binary lookups (ffmpeg_static, and
# whisper-cli in a later change).
_EXE_SUFFIX = ".exe" if sys.platform == "win32" else ""


def _exe(name):
    """Platform executable filename for `name` ("ffmpeg" -> "ffmpeg.exe" on Windows)."""
    return name + _EXE_SUFFIX


def _managed_ffmpeg_dir():
    """Directory of the montaj-managed static ffmpeg build (may not exist).

    Resolves via lib/models.py's canonical MONTAJ_MODELS_DIR (same as
    find_whisper_bin) so env/test overrides of the models dir are honored
    consistently between the downloader and this resolver.
    """
    import models as _models
    return _models.models_dir("ffmpeg")


def _bundled_av_dir():
    """Directory of the ffmpeg/ffprobe bundled by the Homebrew formula (may not exist).

    The formula stages the pinned zscale static build into `libexec/vendor/ffmpeg`,
    and for that venv `sys.prefix` == `libexec` — so this is a sys.prefix-relative
    lookup. Non-Homebrew installs (pip, dev checkout) simply have no such dir.
    """
    return os.path.join(sys.prefix, "vendor", "ffmpeg")


def _resolve_av_bin(name, env_var):
    """Resolver: env override -> managed static build -> bundled (Homebrew) -> bare PATH name."""
    env = os.environ.get(env_var)
    if env:
        return env
    managed = os.path.join(_managed_ffmpeg_dir(), _exe(name))
    if os.access(managed, os.X_OK):
        return managed
    bundled = os.path.join(_bundled_av_dir(), _exe(name))
    if os.access(bundled, os.X_OK):
        return bundled
    return name


def ffmpeg_bin():
    return _resolve_av_bin("ffmpeg", "MONTAJ_FFMPEG")


def ffprobe_bin():
    return _resolve_av_bin("ffprobe", "MONTAJ_FFPROBE")


def node_child_env() -> dict:
    """Environment for spawning the node-based render children (render.js,
    sample-frame.js, sample-overlay.js, render-carousel.js).

    Those scripts fall back to a bare `python3` on PATH when MONTAJ_PYTHON is
    unset — fine on a Mac with Xcode CLT, but there is no `python3` on PATH on
    a stock Windows install, so every render there failed with `spawn python3
    ENOENT`. Only cli/commands/mcp.py set MONTAJ_PYTHON before this; serve's
    render spawns never did. Also carries the resolved ffmpeg/ffprobe binaries
    (MONTAJ_FFMPEG/MONTAJ_FFPROBE) those same children need.

    Returns a fresh copy of os.environ each call; never mutates os.environ.
    """
    env = os.environ.copy()
    env["MONTAJ_FFMPEG"] = ffmpeg_bin()
    env["MONTAJ_FFPROBE"] = ffprobe_bin()
    env["MONTAJ_PYTHON"] = sys.executable
    return env


# Filtergraph path-escaping seam. ':' is ffmpeg's own key=value separator
# inside a filter's option list, and '\' is its escape character — so a raw
# Windows path spliced into a filter description (`lut3d=file=C:\Users\a\x.cube`,
# `drawtext=fontfile=C:\Users\a\x.ttf`) breaks twice: `file=C` ends at the
# drive colon, and the backslashes are read as escapes rather than separators.
# Windows-ness is read from the string itself (a drive letter, or any literal
# backslash), never from the host OS, so this is provable on macOS/Linux too.
_FILTER_DRIVE = re.compile(r"^[A-Za-z]:")
_FILTER_NEEDS_ESCAPE = re.compile(r"[:'\[\],; ]")


def ffmpeg_filter_path(p) -> str:
    """Escape a filesystem path for splicing into an ffmpeg filtergraph option
    value (``lut3d=file=...``, ``drawtext=fontfile=...``).

    A plain path with none of ``: ' , ; [ ]`` or a space is returned UNCHANGED
    — every existing caller's filter string stays byte-for-byte identical.

    A path that looks like Windows (a drive letter, or any backslash) has its
    backslashes turned into forward slashes first. Then, if the (possibly
    slash-converted) value contains any of the characters above, the whole
    value is quoted per ffmpeg's documented *two-level* filtergraph escaping:
    ffmpeg parses a filter option value once as a filtergraph (splitting on
    unquoted ``'``) and again as the option's own value (interpreting ``\\``
    escapes). A single-level ``'\\''`` for an embedded ``'`` survives the
    first parse but is then re-read as a quote by the second, so the value
    must be escaped for the inner (option) level first, and only then quoted
    for the outer (filtergraph) level: a literal ``'`` becomes ``\\'`` and a
    literal ``:`` becomes ``\\:`` at the inner level, then any literal ``'``
    still present (from that inner escape) is itself requoted as ``'\\''``
    before the whole value is wrapped in single quotes. Accepts a ``str`` or
    ``pathlib.Path`` (``lib.look.lut_path()`` returns the latter).
    """
    s = str(p)
    if _FILTER_DRIVE.match(s) or "\\" in s:
        s = s.replace("\\", "/")
    if not _FILTER_NEEDS_ESCAPE.search(s):
        return s
    inner = s.replace("'", "\\'").replace(":", "\\:")
    return "'" + inner.replace("'", "'\\''") + "'"


def run_ffmpeg(args: list[str], timeout: int = 300):
    """Run ffmpeg, suppress output."""
    return run([ffmpeg_bin()] + args, timeout=timeout)


def ffprobe_value(path: str, entries: str, stream_select: str = "") -> str:
    """Get a single value from ffprobe."""
    cmd = [ffprobe_bin(), "-v", "quiet"]
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
    1. Montaj-managed binary (~/.local/share/montaj/models/whisper/whisper-cli[.exe])
    2. System PATH (whisper-cpp or whisper-cli) — fallback for existing installs
    """
    import models as _models
    managed = _models.model_path("whisper", _exe("whisper-cli"))
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
# The Montaj App bundles only this weight (PV27, 2026-09-27): multilingual, so
# it serves every language, and far more accurate than base at the same speed.
DEFAULT_WHISPER_MODEL = "large-v3-turbo-q5_0"

_EN_TO_MULTILINGUAL = {
    "tiny.en": "tiny", "base.en": "base", "small.en": "small", "medium.en": "medium",
}

# Every model a whisper step's --model accepts: each weight `montaj models
# download` can install (cli/commands/models.py AVAILABLE), plus "large" for
# older installs that carry ggml-large.bin. The steps' schema `options` and
# argparse `choices` are this list, and tests/test_whisper_models.py pins all
# of them to it: a model that can be installed must always be selectable (it
# was not: small.en downloaded fine and every step then refused it).
WHISPER_MODEL_CHOICES = (
    "large-v3-turbo-q5_0", "large-v3-turbo",
    "tiny.en", "base.en", "small.en", "medium.en",
    "tiny", "base", "small", "medium",
    "large", "large-v1", "large-v2", "large-v3",
)

# Most capable first: the order a missing model falls back through when none of
# the usual fallbacks is installed (see resolve_whisper_model).
_WHISPER_BY_CAPABILITY = (
    "large-v3-turbo-q5_0", "large-v3-turbo", "large-v3", "large-v2", "large-v1", "large",
    "medium.en", "medium", "small.en", "small", "base.en", "base", "tiny.en", "tiny",
)

# ── Whisper runaway guard ────────────────────────────────────────────────────
# NOT a performance budget. Nobody has measured whisper on a Windows CPU: the
# only timing on record is Apple silicon with Metal, where the PV27 spike's 75 s
# clip took ~4 s. Turbo runs on the CPU on Windows and is far slower there, and
# the flat limits it used to run under (300 s for the whisper-cli call, 900 s
# for the serve step) killed long transcriptions part-way through. These only
# exist to stop a hung whisper from running forever: the limit is
# WHISPER_RUNAWAY_FACTOR times the audio's duration, and never below the old
# 900 s, so no clip that finished before can time out now. Do not tune them
# down to "how long whisper should take": that number is unknown.
WHISPER_RUNAWAY_FLOOR_S = 900
WHISPER_RUNAWAY_FACTOR = 4


def whisper_runaway_timeout(duration_s) -> int:
    """Seconds whisper may run on audio of ``duration_s`` before it is treated
    as hung: ``WHISPER_RUNAWAY_FACTOR`` x the duration, never below
    ``WHISPER_RUNAWAY_FLOOR_S``. An unknown or unusable duration gets the floor."""
    try:
        d = float(duration_s)
    except (TypeError, ValueError):
        return WHISPER_RUNAWAY_FLOOR_S
    if not d > 0 or d == float("inf"):
        return WHISPER_RUNAWAY_FLOOR_S
    return max(WHISPER_RUNAWAY_FLOOR_S, int(math.ceil(d * WHISPER_RUNAWAY_FACTOR)))


def whisper_runaway_timeout_for(path: str) -> int:
    """``whisper_runaway_timeout`` for a media file; the floor when it cannot be
    probed (``get_duration`` exits through ``fail``, hence SystemExit)."""
    try:
        return whisper_runaway_timeout(get_duration(path))
    except (Exception, SystemExit):
        return WHISPER_RUNAWAY_FLOOR_S


_WHISPER_PATH_FLAGS = {"-m", "--model", "-f", "--file", "-of", "--output-file"}


def _absolute_whisper_paths(args: list[str]) -> list[str]:
    """Make the value after each whisper path flag absolute (relative to the
    caller's cwd, which is what the caller meant)."""
    out, absolutize = [], False
    for a in args:
        out.append(os.path.abspath(a) if absolutize else a)
        absolutize = a in _WHISPER_PATH_FLAGS
    return out


def run_whisper(cmd: list[str], audio_path: str, check: bool = False) -> subprocess.CompletedProcess:
    """Run a whisper-cli command under the runaway guard (``check`` as in
    ``run``). A run that outlives the guard is stopped and fails with
    ``transcription_timeout``, naming the limit, rather than escaping as a raw
    TimeoutExpired traceback that serve would pass on as the error message."""
    timeout = whisper_runaway_timeout_for(audio_path)
    # whisper.cpp loads its ggml-cpu-*.dll backends from the current directory as
    # well as the exe's, so it must not inherit serve's cwd (a planted DLL there
    # would load). Run it in its own directory instead. That moves every relative
    # path it is given, so the path arguments are made absolute first.
    exe = os.path.abspath(shutil.which(cmd[0]) or cmd[0])
    cmd = [exe] + _absolute_whisper_paths(cmd[1:])
    try:
        return run(cmd, timeout=timeout, check=check, cwd=os.path.dirname(exe))
    except subprocess.TimeoutExpired:
        fail("transcription_timeout",
             f"whisper.cpp was stopped after {timeout}s without finishing. The limit is a "
             f"runaway guard: {WHISPER_RUNAWAY_FACTOR}x the audio's length, at least "
             f"{WHISPER_RUNAWAY_FLOOR_S}s.")

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

    A requested model that is not installed falls back to the first installed
    of ``DEFAULT_WHISPER_MODEL`` (turbo), ``base.en`` (English only) and
    ``base``: callers that still ask for ``base.en`` keep working on installs
    that only carry turbo, and older CLI installs (base.en only) keep working
    now that turbo is the default. Failing those, it takes the most capable
    other installed weight (multilingual only, for a non-English language).
    With nothing installed the name is returned unchanged so
    ``transcribe_words``' require_file names the missing file.

    Then: English (or unspecified) → the model unchanged. For any other
    language (or ``auto``), an English-only ``*.en`` model is swapped for a
    multilingual one: turbo when installed, else its same-size sibling, else
    the best installed multilingual weight. If the audio is non-English but no
    multilingual weight is installed, fail with an actionable message (instead
    of returning a model whose file is missing, which would surface later as a
    cryptic file-not-found). Already-multilingual models pass through untouched.
    """
    lang = (language or "en").strip().lower()
    english = lang in ("en", "english")
    if whisper_weight_path(model) is None:
        fallbacks = [DEFAULT_WHISPER_MODEL, *(["base.en"] if english else []), "base"]
        for cand in fallbacks:
            if cand != model and whisper_weight_path(cand) is not None:
                return cand
        # None of the usual fallbacks is installed, but another weight is (a
        # lone small.en, say): use the most capable one rather than return a
        # name whose file is missing, which surfaced later as a bare
        # file-not-found. English takes any weight; other languages only a
        # multilingual one (an .en-only install still fails clearly below).
        for cand in _WHISPER_BY_CAPABILITY:
            if cand == model or (not english and cand.endswith(".en")):
                continue
            if whisper_weight_path(cand) is not None:
                return cand
        if not english and any(whisper_weight_path(m) is not None for m in _EN_TO_MULTILINGUAL):
            # Only English-only weights are installed (an older CLI install):
            # say what to install rather than a bare file-not-found later.
            fail("missing_multilingual_model",
                 f"language={language!r} needs a multilingual whisper model, but only "
                 f"English-only (*.en) weights are installed. Install one with: "
                 f"montaj models download {DEFAULT_WHISPER_MODEL}")
    if english:
        return model
    if not model.endswith(".en"):
        return model
    sibling = _EN_TO_MULTILINGUAL.get(model, model[:-3])
    # Prefer turbo, then the same-size sibling, then progressively more capable
    # installed weights. dict.fromkeys dedups repeats in the chain.
    for cand in dict.fromkeys([DEFAULT_WHISPER_MODEL, sibling, "medium", "large-v3", "large", "base"]):
        if whisper_weight_path(cand) is not None:
            return cand
    fail("missing_multilingual_model",
         f"language={language!r} needs a multilingual whisper model, but only "
         f"English-only (*.en) weights are installed. Install one with: "
         f"montaj models download {sibling}")


def transcribe_words(input_path: str, model: str = DEFAULT_WHISPER_MODEL, work_dir: str = None,
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
            run([ffmpeg_bin(), "-y", "-i", input_path, "-vn", "-acodec", "pcm_s16le",
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
        r = run_whisper([whisper_bin, "-m", model_file, "-f", audio, "-l", language,
                         "--split-on-word", "--max-len", "1", "--output-json", "--output-file", prefix],
                        audio)

        words = []
        json_path = f"{prefix}.json"
        if not os.path.exists(json_path):
            # whisper.cpp writes its JSON output even for silent clips; a missing
            # file means the transcription itself failed — never "no speech".
            fail("transcription_failed",
                 f"whisper.cpp exited {r.returncode} without producing output: {r.stderr[-2000:]}")
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
