"""Unit tests for the packaged Vivid LUT assets (montaj_assets/luts/).

SP6b ships montaj-vivid-v1.cube as the single HDR->SDR tone-map LUT across
the whole product, plus a "neutral" (no hk_pop/hk_darken/hk_skin) variant and
a looks.json manifest naming both. `.cube` files match neither the
`"*" = ["*.json"]` package-data glob nor (pre-SP6b) any "montaj_assets" glob
in pyproject.toml, so packaging silently drops them without an explicit
entry — the exact failure mode documented there and guarded by the wheel job
in ci.yml. This file guards the source-of-truth copies actually match their
spike originals and that looks.json is internally consistent.
"""
import json

import pytest

from tests.conftest import REPO_ROOT

LUTS_DIR = REPO_ROOT / "montaj_assets" / "luts"
SPIKE_DIR = REPO_ROOT / "spikes" / "tone-mapping"

pytestmark = pytest.mark.skipif(
    not LUTS_DIR.exists(), reason="montaj_assets/luts/ not present"
)


# ---------------------------------------------------------------------------
# looks.json — manifest shape and internal consistency
# ---------------------------------------------------------------------------

def _load_looks():
    return json.loads((LUTS_DIR / "looks.json").read_text())


def test_looks_json_parses():
    looks = _load_looks()
    assert isinstance(looks, dict)
    assert "masterLook" in looks
    assert "curves" in looks


def test_looks_json_names_an_existing_default_curve():
    looks = _load_looks()
    master = looks["masterLook"]
    curves = looks["curves"]
    assert master in curves, f"masterLook {master!r} not in curves registry"
    assert curves[master].get("default") is True, (
        f"masterLook {master!r} entry must be flagged default: true"
    )


def test_looks_json_every_registry_file_exists():
    looks = _load_looks()
    curves = looks["curves"]
    assert curves, "curves registry must not be empty"
    for curve_id, entry in curves.items():
        assert "file" in entry, f"{curve_id} missing 'file'"
        assert "label" in entry, f"{curve_id} missing 'label'"
        cube_path = LUTS_DIR / entry["file"]
        assert cube_path.exists(), f"{curve_id} -> {entry['file']} does not exist"


def test_looks_json_exactly_one_default():
    looks = _load_looks()
    defaults = [cid for cid, entry in looks["curves"].items() if entry.get("default")]
    assert defaults == [looks["masterLook"]]


# ---------------------------------------------------------------------------
# montaj-vivid-v1 (the winner) — byte-identical to the spike original
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not SPIKE_DIR.exists(), reason="spikes/tone-mapping/ not present")
def test_winner_cube_byte_identical_to_spike():
    packaged = (LUTS_DIR / "montaj-vivid-v1.cube").read_bytes()
    spike = (SPIKE_DIR / "montaj-vivid-v1.cube").read_bytes()
    assert packaged == spike


@pytest.mark.skipif(not SPIKE_DIR.exists(), reason="spikes/tone-mapping/ not present")
def test_winner_params_byte_identical_to_spike():
    packaged = (LUTS_DIR / "montaj-vivid-v1.params.json").read_bytes()
    spike = (SPIKE_DIR / "montaj-vivid-v1.params.json").read_bytes()
    assert packaged == spike


# ---------------------------------------------------------------------------
# montaj-vivid-v1-neutral — data rows match the spike's c17-detail-max
# generator output (only the TITLE line is re-stamped, same as the winner's
# promotion from round8/c24-pop-wide.cube — see tuning-log.md "Final" section)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(
    not (SPIKE_DIR / "luts" / "round8" / "c17-detail-max.cube").exists(),
    reason="spikes/tone-mapping/luts/round8/ not present",
)
def test_neutral_cube_data_matches_spike_c17_detail_max():
    packaged_lines = (LUTS_DIR / "montaj-vivid-v1-neutral.cube").read_text().splitlines()
    spike_lines = (SPIKE_DIR / "luts" / "round8" / "c17-detail-max.cube").read_text().splitlines()
    # Line 0 is the TITLE, intentionally re-stamped; everything after must match.
    assert packaged_lines[1:] == spike_lines[1:]


def test_neutral_params_delta_documents_generator_command():
    params = json.loads((LUTS_DIR / "montaj-vivid-v1-neutral.params.json").read_text())
    assert "generate_luts.py" in params.get("provenance", "") + params.get("generator", "")
    assert "hk_pop" not in params["params"]
    assert "hk_darken" not in params["params"]
    assert "hk_skin" not in params["params"]


# ---------------------------------------------------------------------------
# Both cubes share the winner's tone-curve params minus the hk_* pop knobs
# ---------------------------------------------------------------------------

def test_neutral_params_are_winner_params_minus_pop_knobs():
    winner = json.loads((LUTS_DIR / "montaj-vivid-v1.params.json").read_text())["params"]
    neutral = json.loads((LUTS_DIR / "montaj-vivid-v1-neutral.params.json").read_text())["params"]
    pop_knobs = {"hk_pop", "hk_darken", "hk_skin"}
    expected = {k: v for k, v in winner.items() if k not in pop_knobs}
    assert neutral == expected
