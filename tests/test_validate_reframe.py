"""Validation backstop: a sourceCrop whose recorded dims disagree with the source.

The regression: an iPhone portrait clip codes 1920x1080 with a -90 rotation flag
but displays 1080x1920. A reframe computed from the coded dims writes
`sourceWidth: 1920, sourceHeight: 1080` plus a "crop the sides off this landscape
frame" `sourceCrop` onto a clip that was already portrait, and the renderer
faithfully turns a ~228px sliver into a full-canvas stretch. These tests pin the
check that rejects that at validate time.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

import validate as v  # noqa: E402
import normalize  # noqa: E402  — patched directly; validate imports it lazily
from tests.conftest import run_step, assert_json_output  # noqa: E402

HAS_FFMPEG = shutil.which("ffmpeg") is not None

VALID_PROJECT = {
    "version": "0.2",
    "id": "abc",
    "status": "pending",
    "workflow": "default",
    "editingPrompt": "test",
    "settings": {"resolution": [1080, 1920], "fps": 30},
    "tracks": [[]],
    "assets": [],
    "audio": {},
}

# A 9:16 slice out of a 16:9 frame — the shape the agent wrote for the rotated clip.
LANDSCAPE_CROP = {"x": 0.3418, "y": 0.0, "w": 0.3164, "h": 1.0}
FULL_CROP = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}


def _write_project(tmp_path, name, data):
    path = tmp_path / name
    path.write_text(json.dumps(data))
    return str(path)


def _clip(src, **extra):
    return {"id": "clip-0", "type": "video", "src": str(src),
            "start": 0.0, "end": 1.0, **extra}


@pytest.fixture(scope="module")
def fixtures(tmp_path_factory):
    """A 1920x1080 landscape mp4 and a -90-rotated copy of it (displays 1080x1920)."""
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not installed")
    d = tmp_path_factory.mktemp("reframe_fixtures")
    land, rot = d / "land.mp4", d / "rot.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30",
         "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(land)],
        capture_output=True, check=True,
    )
    # -display_rotation writes the displaymatrix side data; needs ffmpeg 6+.
    subprocess.run(
        ["ffmpeg", "-y", "-display_rotation", "-90", "-i", str(land), "-c", "copy", str(rot)],
        capture_output=True, check=True,
    )

    # A fixture that silently isn't rotated would make the regression test pass
    # for the wrong reason. Prove the flag landed before handing it out.
    info = normalize.probe_video(str(rot)) or {}
    if (info.get("width"), info.get("height")) != (1920, 1080) or abs(info.get("rotation") or 0) % 180 != 90:
        pytest.skip(f"ffmpeg did not produce a rotated fixture: {info}")
    if (info.get("display_width"), info.get("display_height")) != (1080, 1920):
        pytest.skip(f"rotated fixture does not display 1080x1920: {info}")
    return {"land": land, "rot": rot}


@pytest.fixture
def probe_spy(monkeypatch):
    """Counts calls to the name `validate` actually resolves, keeping real behaviour."""
    calls = []
    real = normalize.probe_video

    def spy(path):
        calls.append(path)
        return real(path)

    monkeypatch.setattr(normalize, "probe_video", spy)
    return calls


# ── the regression ────────────────────────────────────────────────────────────

def test_rotated_source_with_landscape_reframe_fails(tmp_path, fixtures, capsys):
    clip = _clip(fixtures["rot"], sourceCrop=LANDSCAPE_CROP, sourceWidth=1920, sourceHeight=1080)
    path = _write_project(tmp_path, "project.json", {**VALID_PROJECT, "tracks": [[clip]]})

    with pytest.raises(SystemExit):
        v.validate_project(path)

    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "source_dims_mismatch"
    msg = err["message"]
    # The message has to name the real dims and the fix, not just say "invalid".
    assert "1080x1920" in msg
    assert "1920x1080" in msg
    assert "-90" in msg
    assert "reframe" in msg


def test_correctly_reframed_landscape_passes(tmp_path, fixtures):
    clip = _clip(fixtures["land"], sourceCrop=LANDSCAPE_CROP, sourceWidth=1920, sourceHeight=1080)
    path = _write_project(tmp_path, "project.json", {**VALID_PROJECT, "tracks": [[clip]]})
    assert v.validate_project(path)["valid"] is True


def test_rotated_source_with_display_dims_passes(tmp_path, fixtures):
    """Keys on the dims, not on "does this source have a rotation flag"."""
    clip = _clip(fixtures["rot"], sourceCrop=FULL_CROP, sourceWidth=1080, sourceHeight=1920)
    path = _write_project(tmp_path, "project.json", {**VALID_PROJECT, "tracks": [[clip]]})
    assert v.validate_project(path)["valid"] is True


# ── gating: what is never probed ──────────────────────────────────────────────

def test_no_source_crop_is_never_probed(tmp_path, fixtures, probe_spy):
    """Wrong dims, no crop ⇒ passes AND costs nothing (the perf property)."""
    clip = _clip(fixtures["rot"], sourceWidth=1920, sourceHeight=1080)
    path = _write_project(tmp_path, "project.json", {**VALID_PROJECT, "tracks": [[clip]]})
    assert v.validate_project(path)["valid"] is True
    assert probe_spy == []


def test_missing_source_is_skipped_not_failed(tmp_path):
    """Validate is not a file-existence checker; projects are validated away from media."""
    clip = _clip("./does-not-exist.mp4", sourceCrop=LANDSCAPE_CROP,
                 sourceWidth=1920, sourceHeight=1080)
    path = _write_project(tmp_path, "project.json", {**VALID_PROJECT, "tracks": [[clip]]})
    assert v.validate_project(path)["valid"] is True


def test_source_crop_without_recorded_dims_is_skipped(tmp_path, fixtures, probe_spy):
    """Nothing to compare against ⇒ no probe, no failure."""
    clip = _clip(fixtures["rot"], sourceCrop=LANDSCAPE_CROP)
    path = _write_project(tmp_path, "project.json", {**VALID_PROJECT, "tracks": [[clip]]})
    assert v.validate_project(path)["valid"] is True
    assert probe_spy == []


# ── round-trip: reframe's real output through validate ───────────────────────

@pytest.mark.parametrize("key", ["rot", "land"])
def test_reframe_output_satisfies_the_invariant(tmp_path, fixtures, key):
    """Round-trip: whatever `reframe` emits must pass validate unchanged.

    The other tests above hand-write both the sourceCrop and the recorded
    dims, so they'd stay green even if `reframe` itself started emitting
    coded dims instead of display dims. This is the one test where the crop
    and dims come from actually running the step — the seam between "what
    reframe produces" and "what validate accepts" is what's under test.
    """
    r = assert_json_output(run_step("reframe.py", "--input", str(fixtures[key]), "--target", "9:16"))
    extra = {"sourceWidth": r["sourceWidth"], "sourceHeight": r["sourceHeight"]}
    if r["sourceCrop"] is not None:
        extra["sourceCrop"] = r["sourceCrop"]
    path = _write_project(tmp_path, "project.json",
                          {**VALID_PROJECT, "tracks": [[_clip(fixtures[key], **extra)]]})
    assert v.validate_project(path)["valid"] is True


# ── caching ───────────────────────────────────────────────────────────────────

def test_probe_is_cached_per_source(tmp_path, fixtures, probe_spy):
    items = [
        _clip(fixtures["land"], sourceCrop=LANDSCAPE_CROP, sourceWidth=1920, sourceHeight=1080),
        _clip(fixtures["land"], sourceCrop=LANDSCAPE_CROP, sourceWidth=1920, sourceHeight=1080),
    ]
    items[1]["id"] = "clip-1"
    items[1]["start"], items[1]["end"] = 1.0, 2.0
    path = _write_project(tmp_path, "project.json", {**VALID_PROJECT, "tracks": [[items[0], items[1]]]})

    assert v.validate_project(path)["valid"] is True
    # Exactly one — and nonzero, which is what proves the spy is patched where
    # validate looks the name up (a mis-patched spy makes the zero-call tests vacuous).
    assert len(probe_spy) == 1
