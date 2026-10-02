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

# Guard on the FILE, not the directory: spikes/tone-mapping/ exists here with its
# scripts while the generated .cube does not, so a directory guard let this fail
# with FileNotFoundError instead of skipping (e7, 2026-09-29). Same shape as the
# c17-detail-max guard below, which always did it this way.
@pytest.mark.skipif(
    not (SPIKE_DIR / "montaj-vivid-v1.cube").exists(),
    reason="spikes/tone-mapping/montaj-vivid-v1.cube not present",
)
def test_winner_cube_byte_identical_to_spike():
    packaged = (LUTS_DIR / "montaj-vivid-v1.cube").read_bytes()
    spike = (SPIKE_DIR / "montaj-vivid-v1.cube").read_bytes()
    assert packaged == spike


@pytest.mark.skipif(
    not (SPIKE_DIR / "montaj-vivid-v1.params.json").exists(),
    reason="spikes/tone-mapping/montaj-vivid-v1.params.json not present",
)
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


# ---------------------------------------------------------------------------
# montaj-natural-v1 (PL24): Apple's own HLG-to-SDR conversion, captured as a
# 33^3 cube. The default look since PL24; vivid1 and vivid1-neutral stay
# selectable.
# ---------------------------------------------------------------------------

# sha256 of the cube's data rows (every line after the header), as captured in
# phase 1. Only the TITLE line was re-stamped on promotion, the same pattern as
# montaj-vivid-v1.cube; a change to any row is a change of look.
NATURAL_DATA_SHA256 = "7dd2e0bd6dd8e39267ac1874741c87551130b5d10f96a567a26efa624498d0ac"


def _cube_header_and_rows(path):
    lines = path.read_text().splitlines()
    header = [ln for ln in lines if ln and (ln[0].isalpha() or ln.startswith("#"))]
    rows = [ln for ln in lines if ln and not (ln[0].isalpha() or ln.startswith("#"))]
    return header, rows


def test_natural1_is_the_default_look():
    looks = _load_looks()
    assert looks["masterLook"] == "natural1"
    assert looks["curves"]["natural1"]["file"] == "montaj-natural-v1.cube"
    assert looks["curves"]["natural1"].get("default") is True


def test_vivid_curves_stay_selectable_and_not_default():
    curves = _load_looks()["curves"]
    for curve_id, file in (("vivid1", "montaj-vivid-v1.cube"),
                           ("vivid1-neutral", "montaj-vivid-v1-neutral.cube")):
        assert curves[curve_id]["file"] == file
        assert not curves[curve_id].get("default")


def test_natural_cube_is_the_phase1_capture():
    header, rows = _cube_header_and_rows(LUTS_DIR / "montaj-natural-v1.cube")
    assert header[0] == 'TITLE "montaj-natural-v1"'
    assert "LUT_3D_SIZE 33" in header
    assert "DOMAIN_MIN 0.0 0.0 0.0" in header and "DOMAIN_MAX 1.0 1.0 1.0" in header
    assert len(rows) == 33 ** 3
    import hashlib
    digest = hashlib.sha256(("\n".join(rows) + "\n").encode()).hexdigest()
    assert digest == NATURAL_DATA_SHA256


def test_natural_params_record_provenance_and_accuracy():
    params = json.loads((LUTS_DIR / "montaj-natural-v1.params.json").read_text())
    assert params["name"] == "montaj-natural-v1"
    assert params["date"] == "2026-10-02"
    assert params["lut_size"] == 33
    assert params["data_sha256"] == NATURAL_DATA_SHA256
    reference = params["reference"]
    assert "avconvert" in reference["tool"] and "Preset1920x1080" in reference["tool"]
    assert reference["macos"] == "26.6.2"
    accuracy = params["accuracy"]["vs_apple_on_a_real_hlg_master"]
    assert accuracy["dE00_mean"] == 0.75 and accuracy["dE00_p95"] == 2.41
    assert params["accuracy"]["h264_noise_floor"] == {"dE00_mean": 0.64, "dE00_p95": 2.47}
