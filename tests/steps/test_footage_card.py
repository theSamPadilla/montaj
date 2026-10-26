"""footage-card.jsx (frame_broll's card) against look's motion and type checks (PL89b).

look says an overlay that never reads `duration` (it vanishes with the cut) or moves only linearly, and text under the
36 px a phone reads. The card's paper must stay put (it frames the video item under it exactly), so its brackets and
credit carry the motion: Motion.motion, an eased pop in and a fade out before the end.
"""
import json
import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib import look_check as lc  # noqa: E402
import steps.render.look as look  # noqa: E402

PRESET = REPO_ROOT / "montaj_assets" / "render" / "templates" / "presets" / "footage-card.jsx"
PROPS = {"box": "0.06,0.18,0.88,0.28", "credit": "Footage: PhoneBot project video", "subject": "", "canvasW": "1080", "canvasH": "1920"}


def card_item(tmp_path):
    (tmp_path / "overlays").mkdir()
    (tmp_path / "overlays" / "footage-card.jsx").write_text(PRESET.read_text())
    return {"id": "ov-card", "type": "overlay", "src": "./overlays/footage-card.jsx", "start": 2, "end": 6, "props": PROPS}


def test_the_card_moves_eased_and_leaves_before_its_end(tmp_path):
    assert lc.motion_issues(card_item(tmp_path), str(tmp_path), "ov-card") == []


def test_the_paper_never_moves_only_the_brackets_and_credit_do():
    code = PRESET.read_text()
    assert "Motion.motion(frame, fps, duration" in code
    paper = next(line for line in code.splitlines() if "boxShadow" in line)
    assert "transform" not in paper and "opacity" not in paper, "the paper frames the video item exactly"


def _has_render():
    import shutil
    return shutil.which("node") is not None and (REPO_ROOT / "montaj_assets" / "render" / "node_modules" / "puppeteer").exists()


@pytest.mark.skipif(not _has_render(), reason="needs node and the render bundle's puppeteer")
def test_the_credit_is_at_least_the_36_px_a_phone_reads(tmp_path):
    item = card_item(tmp_path)
    got = look.measure(item, str(PRESET), 60, 120, 30, 1080, 1920, str(tmp_path / "m.png"))
    meas = got[0] if isinstance(got, tuple) else got
    assert meas, got
    assert lc.type_floor_issues(item, meas, 1080, 1920, 4, "ov-card") == []
