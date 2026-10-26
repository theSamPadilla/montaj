"""Tests for steps/render/contact_sheet.py. The sampler is stubbed (solid PNGs)
so no Puppeteer is needed; tiling, labels and the time grid are exact."""
import json, os, subprocess, sys
import pytest
from PIL import Image
from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT / "steps" / "render"))
import contact_sheet  # noqa: E402

STEP = REPO_ROOT / "steps" / "render" / "contact_sheet.py"


def _stub_sampler(project, t, out):
    Image.new("RGB", (1920, 1080), (int(t * 40) % 255, 0, 0)).save(out)


def _project(tmp_path, end=4.0):
    p = tmp_path / "project.json"
    p.write_text(json.dumps({"settings": {"resolution": [1920, 1080], "fps": 30},
                             "tracks": [{"id": "trk-1", "items": [{"id": "a", "start": 0, "end": end}]}]}))
    return str(p)


def test_every_builds_a_grid_over_the_project(tmp_path):
    assert contact_sheet.grid_times(4.0, 1.0) == [0.0, 1.0, 2.0, 3.0]


def test_project_duration_is_the_last_item_end(tmp_path):
    assert contact_sheet.project_duration(_project(tmp_path, end=7.5)) == 7.5


def test_tiles_are_laid_out_in_rows(tmp_path):
    out = tmp_path / "sheet.png"
    res = contact_sheet.build(_project(tmp_path), [0, 1, 2, 3, 4], cols=2, tile_width=200,
                              out=str(out), sampler=_stub_sampler)
    img = Image.open(out)
    assert res["times"] == [0, 1, 2, 3, 4]
    assert img.size[0] == 2 * 200 + 3 * 4          # 2 cols + 4 px gutters
    assert img.size[1] == 3 * (113 + 18) + 4 * 4   # 3 rows of (tile + label) + gutters


def test_cli_requires_at_or_every(tmp_path):
    proc = subprocess.run([sys.executable, str(STEP), "--project", _project(tmp_path),
                           "--out", str(tmp_path / "s.png")], capture_output=True, text=True)
    assert proc.returncode != 0
    assert "invalid_args" in proc.stderr


def test_cli_rejects_both_at_and_every(tmp_path):
    proc = subprocess.run([sys.executable, str(STEP), "--project", _project(tmp_path),
                           "--at", "0", "--every", "1", "--out", str(tmp_path / "s.png")],
                          capture_output=True, text=True)
    assert proc.returncode != 0
    assert "invalid_args" in proc.stderr


def test_cli_rejects_zero_every(tmp_path):
    proc = subprocess.run([sys.executable, str(STEP), "--project", _project(tmp_path),
                           "--every", "0", "--out", str(tmp_path / "s.png")],
                          capture_output=True, text=True)
    assert proc.returncode != 0
    assert "invalid_args" in proc.stderr


def test_cli_rejects_negative_every(tmp_path):
    proc = subprocess.run([sys.executable, str(STEP), "--project", _project(tmp_path),
                           "--every", "-1", "--out", str(tmp_path / "s.png")],
                          capture_output=True, text=True)
    assert proc.returncode != 0
    assert "invalid_args" in proc.stderr


def test_cli_rejects_too_many_samples(tmp_path):
    proc = subprocess.run([sys.executable, str(STEP), "--project", _project(tmp_path, end=200.0),
                           "--every", "1", "--out", str(tmp_path / "s.png")],
                          capture_output=True, text=True)
    assert proc.returncode != 0
    assert "invalid_args" in proc.stderr
    assert "raise --every" in proc.stderr


def test_sample_frame_timeout_fails(tmp_path, monkeypatch, capsys):
    def fake_run(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 120)
    monkeypatch.setattr(contact_sheet, "run_stopping", fake_run)
    with pytest.raises(SystemExit) as exc:
        contact_sheet._sample_frame(_project(tmp_path), 0.0, str(tmp_path / "f.png"))
    assert exc.value.code == 1
    assert "sample_failed" in capsys.readouterr().err


def test_project_duration_ignores_disabled_tracks_and_items(tmp_path):
    p = tmp_path / "project.json"
    p.write_text(json.dumps({
        "tracks": [
            {"id": "trk-0", "items": [{"id": "a", "start": 0, "end": 5.0}]},
            {"id": "trk-1", "enabled": False, "items": [{"id": "b", "start": 0, "end": 50.0}]},
            {"id": "trk-2", "items": [{"id": "c", "start": 0, "end": 3.0},
                                      {"id": "d", "start": 0, "end": 99.0, "enabled": False}]},
        ]
    }))
    assert contact_sheet.project_duration(str(p)) == 5.0


def test_frames_dir_keeps_pngs_and_reports_paths(tmp_path):
    frames_dir = tmp_path / "frames"
    out = tmp_path / "sheet.png"
    res = contact_sheet.build(_project(tmp_path), [0, 1, 2], cols=3, tile_width=100,
                              out=str(out), sampler=_stub_sampler, frames_dir=str(frames_dir))
    expected = [os.path.abspath(os.path.join(str(frames_dir), f"f_{i:04d}.png")) for i in range(3)]
    assert res["frames"] == expected
    for f in res["frames"]:
        assert os.path.isfile(f)


def test_frames_key_absent_without_frames_dir(tmp_path):
    out = tmp_path / "sheet.png"
    res = contact_sheet.build(_project(tmp_path), [0, 1], cols=2, tile_width=100,
                              out=str(out), sampler=_stub_sampler)
    assert "frames" not in res


# Round 9 (52's notes): look never ran (the run ended place, caption_ink, contact_sheet), so a line drawn over a card's
# credit went unchecked. The closing contact sheet answers look's issues too: the same call, no new turn.
def test_the_contact_sheet_answers_looks_issues_and_never_fails_for_them(tmp_path):
    out = tmp_path / "sheet.png"
    res = contact_sheet.build(_project(tmp_path), [0, 1], cols=2, tile_width=200, out=str(out), sampler=_stub_sampler,
                              look_fn=lambda p: {"ok": False, "overlays": 3, "issues": ["2.0s ov-a: text runs off the frame"]})
    assert res["look"] == {"ok": False, "overlays": 3, "issues": ["2.0s ov-a: text runs off the frame"]}
    def broken(p):
        raise SystemExit(1)
    res = contact_sheet.build(_project(tmp_path), [0, 1], cols=2, tile_width=200, out=str(out), sampler=_stub_sampler, look_fn=broken)
    assert "look" not in res and os.path.isfile(out), "the sheet stands without it"
    res = contact_sheet.build(_project(tmp_path), [0, 1], cols=2, tile_width=200, out=str(out), sampler=_stub_sampler)
    assert "look" not in res, "no look asked (a frame strip, a raw sheet)"


# PL89j (cost): the closing sheets of 18 and 30 frames were 6 columns at 320 px, so the 768 px preview made each tile
# about 128 px, and the agent asked for them full size (209 KB and 143 KB). Past 12 frames the sheet is several sheets
# of at most 12, in 4 columns: each tile about 192 px in the preview, the times shared evenly.
def test_more_than_12_frames_are_several_sheets_of_at_most_12_in_4_columns(tmp_path):
    out = tmp_path / "contact_sheet.png"
    times = [round(0.5 * k, 2) for k in range(30)]
    res = contact_sheet.build(_project(tmp_path, end=20), times, cols=6, tile_width=320, out=str(out), sampler=_stub_sampler)
    assert res["path"] == str(out)
    assert len(res["sheets"]) == 3 and res["sheets"][0] == str(out)
    assert all(os.path.isfile(p) for p in res["sheets"])
    assert [len(t) for t in res["sheet_times"]] == [10, 10, 10] and sum(res["sheet_times"], []) == times
    assert Image.open(res["sheets"][1]).size[0] == 4 * 320 + 5 * 4      # 4 columns
    assert res["times"] == times


def test_twelve_frames_or_fewer_stay_one_sheet(tmp_path):
    out = tmp_path / "contact_sheet.png"
    res = contact_sheet.build(_project(tmp_path), [0, 1, 2], cols=6, tile_width=200, out=str(out), sampler=_stub_sampler)
    assert "sheets" not in res and os.path.isfile(out)
