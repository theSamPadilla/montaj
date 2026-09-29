"""lib/color_provenance.py's probe when ffprobe fails (PV57).

Python twin of montaj_assets/render/test/sdr-layer.test.mjs's failed-probe
tests (PV51, 67a21de). A probe of a file that exists and cannot be read raises
ProbeError, because every answer the module could give for it picks a grade. A
file that is not there keeps FAILED_PROBE, so a marked clip whose original is
gone stays HDR (Q1).

Two seams. The probe-level tests pass a fake `run`, `sleep` and `exists` to
probe_media (the twin of the JS spawn/sleep/exists options). The provenance
tests swap the module's `subprocess` for one whose `run` fails for one file, so
the real probe_media, origin_of and proxy_source_for run end to end.
"""
import errno
import json
import os
import pickle
import shutil
import subprocess
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

import lib.color_provenance as cp
import lib.normalize as nm

MARKER = nm.SDR_ORIGIN_MARKER


@pytest.fixture(autouse=True)
def _empty_cache(monkeypatch):
    monkeypatch.setattr(cp, "_CACHE", {})


@pytest.fixture
def clip(tmp_path):
    """A file that exists, so probe_media's stat passes and the fake decides."""
    f = Path(os.path.realpath(tmp_path)) / "source.mp4"
    f.write_bytes(b"not read: the fake run answers for it")
    return str(f)


# ── fake ffprobe runs (shapes measured from Python 3.13's subprocess.run) ─────


def _ok_json(transfer, comment=""):
    return json.dumps({
        "streams": [{"width": 64, "height": 64, "r_frame_rate": "30/1", "color_transfer": transfer}],
        "format": {"duration": "1.000000", "tags": {"comment": comment} if comment else {}},
    })


def ok(transfer="bt709", comment=""):
    return lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, _ok_json(transfer, comment), "")


def timed_out(cmd, **kw):
    raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))


def killed(cmd, **kw):
    return subprocess.CompletedProcess(cmd, -9, "", "")


def spawn_failed(code):
    def run(cmd, **kw):
        raise OSError(code, os.strerror(code), cmd[0])  # OSError picks the subclass: ENOENT -> FileNotFoundError
    return run


def exited(stderr, code=1):
    return lambda cmd, **kw: subprocess.CompletedProcess(cmd, code, "", stderr)


def printed(stdout):
    return lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout, "")


class Script:
    """A fake subprocess.run answering from `steps`, one per call; the last
    step repeats. Records each call."""

    def __init__(self, *steps):
        self.steps = list(steps)
        self.calls = []

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        return step(cmd, **kw)


def probe_with(path, *steps, exists=None, keep_cache=False):
    """probe_media(path) over a scripted run, from an empty cache unless
    `keep_cache`; returns (result or error, run, sleeps)."""
    if not keep_cache:
        cp._CACHE.clear()
    run = Script(*steps)
    sleeps = []
    opts = {"run": run, "sleep": sleeps.append}
    if exists is not None:
        opts["exists"] = exists
    try:
        out = cp.probe_media(path, **opts)
    except cp.ProbeError as e:
        out = e
    return out, run, sleeps


def assert_probe_error(err, path, reason):
    assert isinstance(err, cp.ProbeError), f"a ProbeError, got {err!r}"
    assert err.path == path
    assert err.reason == reason
    assert path in str(err) and reason in str(err), str(err)


# ── probe_media: every failure kind ──────────────────────────────────────────


def test_a_timeout_is_retried_once_after_a_backoff_then_raises_timeout(clip):
    out, run, sleeps = probe_with(clip, timed_out, ok("bt709"))
    assert out.transfer == "bt709"
    assert len(run.calls) == 2
    assert run.calls[0][1]["timeout"] == cp.PROBE_TIMEOUT_S == 30
    assert sleeps == [0.25]

    out, run, _ = probe_with(clip, timed_out)
    assert_probe_error(out, clip, "timeout")
    assert "2 tries" in str(out)
    assert len(run.calls) == 2


def test_killed_by_a_signal_is_retried_once_then_raises_killed(clip):
    out, run, _ = probe_with(clip, killed, ok("bt709"))
    assert out.transfer == "bt709" and len(run.calls) == 2

    out, run, _ = probe_with(clip, killed)
    assert_probe_error(out, clip, "killed")
    assert "SIGKILL" in str(out)
    assert len(run.calls) == 2


@pytest.mark.parametrize("code", [errno.EAGAIN, errno.ENOMEM, errno.EMFILE, errno.ENFILE],
                         ids=lambda c: errno.errorcode[c])
def test_a_transient_spawn_failure_is_retried_once_then_raises_spawn(clip, code):
    out, run, sleeps = probe_with(clip, spawn_failed(code), ok("bt709"))
    assert out.transfer == "bt709"
    assert len(run.calls) == 2 and sleeps == [0.25]

    out, run, _ = probe_with(clip, spawn_failed(code))
    assert_probe_error(out, clip, "spawn")
    assert errno.errorcode[code] in str(out)
    assert len(run.calls) == 2


def test_no_ffprobe_at_all_raises_at_once_even_for_a_file_that_is_gone(clip):
    out, run, sleeps = probe_with(clip, spawn_failed(errno.ENOENT))
    assert_probe_error(out, clip, "spawn")
    assert "ENOENT" in str(out)
    assert len(run.calls) == 1 and sleeps == [], "never retried"

    # The file vanished too: still "no ffprobe", or every clip would read as gone.
    out, run, _ = probe_with(clip, spawn_failed(errno.ENOENT), exists=lambda p: False)
    assert_probe_error(out, clip, "spawn")
    assert len(run.calls) == 1


def test_a_non_zero_exit_raises_exit_with_stderr_trimmed_and_capped_never_retried(clip):
    out, run, sleeps = probe_with(clip, exited(f"\n{clip}: Invalid data found when processing input\n\n"))
    assert_probe_error(out, clip, "exit")
    assert "Invalid data found when processing input" in str(out)
    assert out.detail.endswith("processing input")
    assert len(run.calls) == 1 and sleeps == []
    cmd = run.calls[0][0]
    assert cmd[cmd.index("-v") + 1] == "error", "ffprobe runs at -v error, so a failure says why"

    out, _, _ = probe_with(clip, exited("x" * 10_000))
    assert_probe_error(out, clip, "exit")
    assert len(str(out)) < 1000


def test_unparseable_output_and_no_video_stream_raise_parse_and_no_stream_never_retried(clip):
    out, run, _ = probe_with(clip, printed('{"streams": ['))
    assert_probe_error(out, clip, "parse")
    assert len(run.calls) == 1

    out, run, _ = probe_with(clip, printed('{"streams": [], "format": {}}'))
    assert_probe_error(out, clip, "no-stream")
    assert len(run.calls) == 1


def test_probe_error_carries_path_reason_and_detail_and_pickles():
    e = cp.ProbeError("/a/b.mp4", "timeout", "no answer in 30 s")
    assert (e.path, e.reason, e.detail) == ("/a/b.mp4", "timeout", "no answer in 30 s")
    assert e.errno is None
    assert str(e).startswith("ffprobe could not read /a/b.mp4 (timeout): no answer in 30 s")
    back = pickle.loads(pickle.dumps(e))
    assert (back.path, back.reason, back.detail, back.errno, str(back)) == \
        (e.path, e.reason, e.detail, e.errno, str(e))


def test_probe_error_carries_errno_for_a_real_spawn_failure_and_pickles(clip):
    out, _, _ = probe_with(clip, spawn_failed(errno.ENOENT))
    assert out.errno == errno.ENOENT
    back = pickle.loads(pickle.dumps(out))
    assert back.errno == errno.ENOENT

    out, _, _ = probe_with(clip, exited("boom"))
    assert out.errno is None, "errno is spawn-specific; other reasons carry none"


# ── PV57 review: one classification, TRANSIENT vs PERMANENT, everything reads ─


def test_transient_and_permanent_probe_reasons_cover_all_six_with_no_overlap():
    all_reasons = {"timeout", "killed", "spawn", "exit", "parse", "no-stream"}
    assert cp.TRANSIENT_PROBE_REASONS | cp.PERMANENT_PROBE_REASONS == all_reasons
    assert cp.TRANSIENT_PROBE_REASONS & cp.PERMANENT_PROBE_REASONS == set()


@pytest.mark.parametrize("reason", sorted(cp.TRANSIENT_PROBE_REASONS))
def test_is_probe_retryable_true_for_every_transient_reason(reason):
    assert cp.is_probe_retryable(cp.ProbeError("/a", reason, "d"))


@pytest.mark.parametrize("reason", sorted(cp.PERMANENT_PROBE_REASONS))
def test_is_probe_retryable_false_for_every_permanent_reason(reason):
    assert not cp.is_probe_retryable(cp.ProbeError("/a", reason, "d"))


def test_is_probe_retryable_false_for_spawn_enoent_even_though_spawn_is_transient():
    """No ffprobe binary at all is an operator problem, not a momentary one —
    unlike the other spawn causes (EAGAIN/ENOMEM/EMFILE/ENFILE under load),
    which stay retryable (PV57 review nit)."""
    assert not cp.is_probe_retryable(cp.ProbeError("/a", "spawn", "no ffprobe", errno=errno.ENOENT))
    assert cp.is_probe_retryable(cp.ProbeError("/a", "spawn", "busy", errno=errno.EAGAIN))
    assert cp.is_probe_retryable(cp.ProbeError("/a", "spawn", "busy"))  # errno unknown: not specifically ENOENT


# ── probe_media: a file that is not there ────────────────────────────────────


def test_a_missing_path_is_the_failure_shape_without_running_ffprobe():
    out, run, _ = probe_with("/nonexistent/montaj/clip.mp4", exited("unreachable"))
    assert out == cp.FAILED_PROBE
    assert run.calls == []


def test_a_file_gone_by_the_time_ffprobe_fails_is_the_failure_shape(clip):
    out, run, _ = probe_with(clip, exited(f"{clip}: No such file or directory"), exists=lambda p: False)
    assert out == cp.FAILED_PROBE
    assert len(run.calls) == 1


def test_a_file_that_vanishes_after_a_failed_attempt_is_the_failure_shape_not_retried(clip):
    """The real os.path.exists: the file is deleted while ffprobe runs."""
    def vanish_then_killed(cmd, **kw):
        os.unlink(clip)
        return killed(cmd, **kw)

    run = Script(vanish_then_killed, ok("bt709"))
    sleeps = []
    assert cp.probe_media(clip, run=run, sleep=sleeps.append) == cp.FAILED_PROBE
    assert len(run.calls) == 1 and sleeps == []


# ── probe_media: the cache ───────────────────────────────────────────────────


def test_a_probe_error_is_not_cached_and_the_next_success_is(clip):
    out, _, _ = probe_with(clip, exited("boom"))
    assert isinstance(out, cp.ProbeError)
    assert cp._CACHE == {}
    out, run, _ = probe_with(clip, ok("arib-std-b67"), keep_cache=True)
    assert out.transfer == "arib-std-b67" and len(run.calls) == 1
    out, run, _ = probe_with(clip, exited("never asked"), keep_cache=True)
    assert out.transfer == "arib-std-b67" and run.calls == [], "served from the cache"


# ── real ffprobe ─────────────────────────────────────────────────────────────

HAS_FFMPEG = shutil.which(nm.ffmpeg_bin()) is not None or os.path.isfile(nm.ffmpeg_bin())


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_real_ffprobe_on_a_real_file_still_gives_the_same_probe(tmp_path):
    f = Path(os.path.realpath(tmp_path)) / "hlg.mp4"
    subprocess.run([nm.ffmpeg_bin(), "-y", "-v", "error", "-f", "lavfi",
                    "-i", "testsrc2=size=64x32:rate=30000/1001:duration=0.5",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-bsf:v", "h264_metadata=transfer_characteristics=18:colour_primaries=9:matrix_coefficients=9",
                    "-metadata", f"comment={MARKER}src.mov", str(f)],
                   check=True, capture_output=True, timeout=60)
    p = cp.probe_media(str(f))
    assert (p.transfer, p.comment, p.width, p.height, p.fps) == (
        "arib-std-b67", f"{MARKER}src.mov", 64, 32, "30000/1001")
    assert abs(p.duration - 0.5) < 0.05
    assert p.encoder.startswith("Lavf")
    assert cp._ffprobe(str(f)) == p


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_real_ffprobe_on_an_existing_file_that_is_not_media_raises_not_sdr(tmp_path):
    f = Path(os.path.realpath(tmp_path)) / "not-a-video.mp4"
    f.write_text("this is not a video")
    try:
        got = cp.probe_media(str(f))
    except Exception as e:  # noqa: BLE001 - asserted below
        got = e
    assert type(got).__name__ == "ProbeError", f"a ProbeError, got {got!r}"
    assert got.path == str(f) and got.reason == "exit"
    assert "Invalid data" in str(got), str(got)


# ── the defect: the provenance probe of a marked conversion's original fails ──
#
# The real probe_media, origin_of and proxy_source_for. Only the module's
# `subprocess.run` is swapped, and only for ffprobe of the original (or of the
# clip itself); the marked file probes as HLG with the marker naming it.


@pytest.fixture
def marked(tmp_path, monkeypatch):
    d = Path(os.path.realpath(tmp_path))
    original, conv = d / "source.mp4", d / "source_normalized_hdr_hlg_w203.mp4"
    original.write_bytes(b"sdr original")
    conv.write_bytes(b"marked conversion")
    state = {"original": [ok("bt709")], "conv": [ok("arib-std-b67", f"{MARKER}source.mp4")],
             "probed": []}

    def run(cmd, **kw):
        path = os.path.realpath(cmd[-1])
        which = {str(original): "original", str(conv): "conv"}.get(path)
        if which is None or os.path.basename(cmd[0]) != os.path.basename(nm.ffprobe_bin()):
            return subprocess.run(cmd, **kw)
        state["probed"].append(which)
        steps = state[which]
        step = steps.pop(0) if len(steps) > 1 else steps[0]
        return step(cmd, **kw)

    shim = types.ModuleType("subprocess")
    shim.__dict__.update({k: v for k, v in vars(subprocess).items() if not k.startswith("__")})
    shim.run = run
    monkeypatch.setattr(cp, "subprocess", shim)
    return types.SimpleNamespace(original=str(original), conv=str(conv), state=state)


def _script(marked, which, *steps):
    cp._CACHE.clear()
    marked.state[which] = list(steps)
    marked.state["probed"].clear()


def _raises_probe_error(fn, path):
    try:
        out = fn()
    except Exception as e:  # noqa: BLE001 - asserted below
        assert type(e).__name__ == "ProbeError", f"a ProbeError, got {e!r}"
        assert e.path == path, e.path
        return e
    pytest.fail(f"returned {out!r}, not a ProbeError: a failed probe picked a grade")


TRANSIENT = {"timeout": timed_out, "killed": killed,
             "EAGAIN": spawn_failed(errno.EAGAIN), "ENOMEM": spawn_failed(errno.ENOMEM)}
PERSISTENT = {"exit": exited("boom"), "parse": printed("nope"),
              "no-stream": printed('{"streams": [], "format": {}}')}


def test_healthy_marked_conversion_resolves_to_its_original(marked):
    assert cp.origin_of(marked.conv) == cp.Origin("sdr_bt709", marked.original)
    assert cp.proxy_source_for(marked.conv) == (marked.original, False)


@pytest.mark.parametrize("kind", list(TRANSIENT))
def test_a_transient_failure_on_the_original_clears_on_retry_and_gives_the_original(marked, kind):
    _script(marked, "original", TRANSIENT[kind], ok("bt709"))
    assert cp.proxy_source_for(marked.conv) == (marked.original, False)
    assert marked.state["probed"].count("original") == 2
    _script(marked, "original", TRANSIENT[kind], ok("bt709"))
    assert cp.origin_of(marked.conv) == cp.Origin("sdr_bt709", marked.original)


@pytest.mark.parametrize("kind", list(TRANSIENT) + list(PERSISTENT))
def test_a_failure_on_the_original_that_does_not_clear_raises_never_src_graded(marked, kind):
    fail = {**TRANSIENT, **PERSISTENT}[kind]
    _script(marked, "original", fail)
    _raises_probe_error(lambda: cp.proxy_source_for(marked.conv), marked.original)
    _script(marked, "original", fail)
    _raises_probe_error(lambda: cp.origin_of(marked.conv), marked.original)


@pytest.mark.parametrize("kind", ["timeout", "exit"])
def test_a_failure_on_the_clip_itself_raises_never_sdr_ungraded(marked, kind):
    """An HLG file whose own probe fails used to read as SDR: an ungraded proxy."""
    _script(marked, "conv", {**TRANSIENT, **PERSISTENT}[kind])
    _raises_probe_error(lambda: cp.proxy_source_for(marked.conv), marked.conv)


def test_a_missing_original_keeps_hdr_graded_without_probing_it(marked):
    """Q1 (Sam): a marked clip whose original is gone stays HDR."""
    os.unlink(marked.original)
    _script(marked, "original", exited("unreachable"))
    assert cp.origin_of(marked.conv) == cp.Origin("hdr_hlg", None)
    assert cp.proxy_source_for(marked.conv) == (marked.conv, True)
    assert "original" not in marked.state["probed"]


def test_an_original_that_vanishes_while_probed_keeps_hdr_graded(marked):
    def vanish_then_killed(cmd, **kw):
        os.unlink(marked.original)
        return killed(cmd, **kw)

    _script(marked, "original", vanish_then_killed)
    assert cp.proxy_source_for(marked.conv) == (marked.conv, True)
    assert marked.state["probed"].count("original") == 1
