"""Tests for steps/rm_fillers.py — uses fake whisper binary."""
import json
import os
import textwrap
import pytest
from tests.conftest import run_step_env, assert_file_output, assert_error

_WHISPER_MODEL_NEW = os.path.expanduser("~/.local/share/montaj/models/whisper/ggml-base.en.bin")
_WHISPER_MODEL_OLD = os.path.expanduser("~/.local/share/whisper.cpp/models/ggml-base.en.bin")
requires_whisper = pytest.mark.skipif(
    not os.path.isfile(_WHISPER_MODEL_NEW) and not os.path.isfile(_WHISPER_MODEL_OLD),
    reason="whisper model not installed",
)

pytestmark = requires_whisper


def test_rm_fillers_produces_output(test_video, fake_whisper_env):
    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "input" in result
    assert "keeps" in result


def test_rm_fillers_auto_output_path(test_video, fake_whisper_env):
    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"


def test_rm_fillers_missing_input(fake_whisper_env):
    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")


def test_rm_fillers_accepts_trim_spec(tmp_path, test_video, fake_whisper_env):
    spec = {"input": str(test_video), "keeps": [[0.0, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))

    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "input" in result
    assert "keeps" in result
    assert result["input"] == str(test_video)


def test_rm_fillers_output_keeps_within_input_keeps(tmp_path, test_video, fake_whisper_env):
    spec = {"input": str(test_video), "keeps": [[0.0, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))

    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en")
    result = json.loads(proc.stdout)
    # All output keeps must be within the input keep bounds
    for ks, ke in result["keeps"]:
        assert ks >= 0.0
        assert ke <= 3.0


@pytest.fixture
def fake_whisper_env_with_filler(tmp_path_factory):
    """Like conftest's fake_whisper_env, but the transcript includes a filler
    word ("um") so cuts[].text behavior can be exercised."""
    d = tmp_path_factory.mktemp("whisper_filler")
    models = d / "models"
    models.mkdir()
    (models / "ggml-base.en.bin").touch()

    fake_script = textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys, json

        args = sys.argv[1:]
        out_file = None
        for i, a in enumerate(args):
            if a == "--output-file" and i + 1 < len(args):
                out_file = args[i + 1]

        data = {
            "transcription": [
                {"text": "Hello",   "offsets": {"from": 0,    "to": 400}},
                {"text": "um",      "offsets": {"from": 500,  "to": 800}},
                {"text": "world",   "offsets": {"from": 900,  "to": 1400}},
                {"text": "this",    "offsets": {"from": 1500, "to": 1800}},
                {"text": "is",      "offsets": {"from": 1900, "to": 2100}},
                {"text": "a",       "offsets": {"from": 2200, "to": 2300}},
                {"text": "test",    "offsets": {"from": 2400, "to": 2800}},
            ]
        }
        if out_file:
            with open(out_file + ".json", "w") as f:
                json.dump(data, f)
    """)

    main = d / "main"
    main.write_text(fake_script)
    main.chmod(0o755)

    bin_dir = d / "bin"
    bin_dir.mkdir()
    fake_bin = bin_dir / "whisper-cpp"
    fake_bin.write_text(fake_script)
    fake_bin.chmod(0o755)

    original_path = os.environ.get("PATH", "")
    return {
        "WHISPER_DIR": str(d),
        "PATH": f"{bin_dir}:{original_path}",
    }


@pytest.fixture
def fake_whisper_env_filler_before_first_word(tmp_path_factory):
    """A filler ("um") comes BEFORE the first non-filler word, entirely inside
    the span head-snap will trim. This is the order that trips the
    double-report bug: a naive concat of filler cuts + the head-trim entry
    reports the same audio (the filler) as two separate `cuts` entries."""
    d = tmp_path_factory.mktemp("whisper_filler_before")
    models = d / "models"
    models.mkdir()
    (models / "ggml-base.en.bin").touch()

    fake_script = textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys, json

        args = sys.argv[1:]
        out_file = None
        for i, a in enumerate(args):
            if a == "--output-file" and i + 1 < len(args):
                out_file = args[i + 1]

        data = {
            "transcription": [
                {"text": "um",      "offsets": {"from": 100,  "to": 400}},
                {"text": "hello",   "offsets": {"from": 2000, "to": 2400}},
                {"text": "world",   "offsets": {"from": 2500, "to": 2800}},
            ]
        }
        if out_file:
            with open(out_file + ".json", "w") as f:
                json.dump(data, f)
    """)

    main = d / "main"
    main.write_text(fake_script)
    main.chmod(0o755)

    bin_dir = d / "bin"
    bin_dir.mkdir()
    fake_bin = bin_dir / "whisper-cpp"
    fake_bin.write_text(fake_script)
    fake_bin.chmod(0o755)

    original_path = os.environ.get("PATH", "")
    return {
        "WHISPER_DIR": str(d),
        "PATH": f"{bin_dir}:{original_path}",
    }


@pytest.fixture
def fake_whisper_env_filler_straddles_head_trim(tmp_path_factory):
    """A filler ("um") starts before the head-trim boundary and ends after it,
    so the boundary lands in the middle of the word — the straddling case
    that must survive as a clipped remainder rather than vanish entirely.

    first non-filler word "hello" starts at 2.0s -> head-trim end (HEAD_PAD =
    0.05) lands at 1.95s. "um" spans 1.80-1.98s, straddling that boundary.
    """
    d = tmp_path_factory.mktemp("whisper_filler_straddle")
    models = d / "models"
    models.mkdir()
    (models / "ggml-base.en.bin").touch()

    fake_script = textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys, json

        args = sys.argv[1:]
        out_file = None
        for i, a in enumerate(args):
            if a == "--output-file" and i + 1 < len(args):
                out_file = args[i + 1]

        data = {
            "transcription": [
                {"text": "um",      "offsets": {"from": 1800, "to": 1980}},
                {"text": "hello",   "offsets": {"from": 2000, "to": 2400}},
                {"text": "world",   "offsets": {"from": 2500, "to": 2800}},
            ]
        }
        if out_file:
            with open(out_file + ".json", "w") as f:
                json.dump(data, f)
    """)

    main = d / "main"
    main.write_text(fake_script)
    main.chmod(0o755)

    bin_dir = d / "bin"
    bin_dir.mkdir()
    fake_bin = bin_dir / "whisper-cpp"
    fake_bin.write_text(fake_script)
    fake_bin.chmod(0o755)

    original_path = os.environ.get("PATH", "")
    return {
        "WHISPER_DIR": str(d),
        "PATH": f"{bin_dir}:{original_path}",
    }


def _assert_cuts_tile_window_without_overlap(result, win_start, win_end, tol=1e-4):
    """General regression guard (not pinned to specific literals): `keeps` and
    `cuts` together must exactly partition [win_start, win_end] — no gaps, and
    no overlap between any two entries (sorted by start, each start must equal
    the previous entry's end)."""
    segments = sorted(
        [(s, e) for s, e in result["keeps"]]
        + [(c["start"], c["end"]) for c in result["cuts"]]
    )
    pos = win_start
    for s, e in segments:
        assert s == pytest.approx(pos, abs=tol), (
            f"segment [{s},{e}] does not start where the previous one ended "
            f"({pos}) — gap or overlap in {segments}"
        )
        pos = e
    assert pos == pytest.approx(win_end, abs=tol)


def test_rm_fillers_windowed_cuts_do_not_overlap_when_filler_precedes_first_word(
    test_video, fake_whisper_env_filler_before_first_word
):
    """Regression: a filler wholly inside the head-trim span must not also
    appear as its own `cuts` entry — that would double-report the same audio,
    and unticking the filler entry in a review UI would silently do nothing
    since the head-trim entry still covers it."""
    proc = run_step_env("rm_fillers.py", fake_whisper_env_filler_before_first_word,
                        "--input", str(test_video), "--model", "base.en",
                        "--window-in", "0.0", "--window-out", "3.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "cuts" in result
    _assert_cuts_tile_window_without_overlap(result, 0.0, 3.0)

    # The wholly-contained filler must not survive as its own duplicate entry.
    starts_ends = [(c["start"], c["end"]) for c in result["cuts"]]
    assert len(starts_ends) == len(set(starts_ends)) == len(result["cuts"])


def test_rm_fillers_windowed_straddling_filler_survives_as_clipped_remainder(
    test_video, fake_whisper_env_filler_straddles_head_trim
):
    """A filler that starts before the head-trim boundary and continues past
    it must survive as its trimmed remainder — dropping it entirely would
    hide a real removal from the operator's review list."""
    proc = run_step_env("rm_fillers.py", fake_whisper_env_filler_straddles_head_trim,
                        "--input", str(test_video), "--model", "base.en",
                        "--window-in", "0.0", "--window-out", "3.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "cuts" in result
    _assert_cuts_tile_window_without_overlap(result, 0.0, 3.0)

    texted = [c for c in result["cuts"] if c.get("text") == "um"]
    assert len(texted) == 1, f"expected exactly one surviving 'um' remainder, got {result['cuts']}"
    remainder = texted[0]
    # The remainder must be a real, positive-length span, and must not start
    # before the head-trim boundary (that part is already covered by the
    # separate head-trim entry).
    assert remainder["end"] > remainder["start"]
    assert remainder["start"] >= 1.9  # ~1.95s head-trim boundary, some tolerance
    assert remainder["end"] <= 2.0


def test_rm_fillers_window_flags_require_both(test_video, fake_whisper_env):
    """--window-in without --window-out (and vice versa) is a clear error, not silent."""
    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en",
                        "--window-in", "0.5")
    assert_error(proc, "invalid_args")

    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en",
                        "--window-out", "2.5")
    assert_error(proc, "invalid_args")


def test_rm_fillers_windowed_emits_cuts_with_matched_word_text(test_video, fake_whisper_env_with_filler):
    proc = run_step_env("rm_fillers.py", fake_whisper_env_with_filler,
                        "--input", str(test_video), "--model", "base.en",
                        "--window-in", "0.0", "--window-out", "3.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "cuts" in result
    texts = [c.get("text") for c in result["cuts"]]
    assert "um" in texts


def test_rm_fillers_windowed_cuts_and_keeps_tile_the_window(test_video, fake_whisper_env_with_filler):
    """Covers the other word ordering — a non-filler first word, so no
    head-trim occurs and the filler cut stands on its own."""
    proc = run_step_env("rm_fillers.py", fake_whisper_env_with_filler,
                        "--input", str(test_video), "--model", "base.en",
                        "--window-in", "0.0", "--window-out", "3.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    _assert_cuts_tile_window_without_overlap(result, 0.0, 3.0)


def test_rm_fillers_windowed_stays_within_the_window_bounds(test_video, fake_whisper_env):
    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en",
                        "--window-in", "0.5", "--window-out", "2.5")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    for s, e in result["keeps"]:
        assert s >= 0.5 - 1e-6 and e <= 2.5 + 1e-6
    for c in result["cuts"]:
        assert c["start"] >= 0.5 - 1e-6 and c["end"] <= 2.5 + 1e-6


def test_rm_fillers_unwindowed_output_has_no_cuts_key(test_video, fake_whisper_env):
    """Unwindowed behaviour is byte-identical to today — no new `cuts` key."""
    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "cuts" not in result


def test_rm_fillers_plain_trim_spec_has_no_cuts_key(tmp_path, test_video, fake_whisper_env):
    """A caller-supplied trim spec without --window-in/--window-out is also
    unaffected — `cuts` is only added when this step itself windowed the call."""
    spec = {"input": str(test_video), "keeps": [[0.0, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))

    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "cuts" not in result


def _load_rm_fillers_module():
    """Import steps/speech/rm_fillers.py directly for pure-function tests."""
    import importlib.util, pathlib, sys
    root = pathlib.Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "lib"))
    spec = importlib.util.spec_from_file_location(
        "rm_fillers_mod", root / "steps" / "speech" / "rm_fillers.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_filler_matcher_is_language_aware():
    mod = _load_rm_fillers_module()
    en = mod._filler_matcher("en")
    es = mod._filler_matcher("es")
    # English hesitations match the English matcher, not the Spanish one
    assert en.match("um") and en.match("uh")
    assert not es.match("um")
    # Spanish hesitations match the Spanish matcher
    assert es.match("eh") and es.match("mmm")
    # Real Spanish words are never treated as fillers (no false cuts)
    assert not es.match("este") and not es.match("pues")
    # Unknown language falls back to the English set
    assert mod._filler_matcher("xx").match("um")
