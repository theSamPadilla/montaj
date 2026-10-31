"""Shots: label a long source once (Sam, 2026-10-26). `shots` finds a source's shots from where the picture changes,
keeps them in a sidecar beside the file (`<stem>.shots.json`, stamped with the file's size and mtime) with the labels
the agent gives, and answers ONE sheet with a tile per shot. Kung fu pl89i/j: both arms picked the wrong moments of a
74 s screen recording from sparse sheets. Synthetic clips here: solid colour shots, one with a moving box."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib import shots as sh  # noqa: E402
from lib.common import ffmpeg_bin, ffprobe_bin  # noqa: E402


def make_clip(path, parts=(("white", 2.0, False), ("0x707070", 3.0, True), ("0x181818", 2.0, False))):
    """Shots of solid colour, each `seconds` long; a moving dark box in the ones marked True."""
    inputs, chains = [], []
    for i, (color, seconds, moving) in enumerate(parts):
        inputs += ["-f", "lavfi", "-i", f"color=c={color}:s=320x180:d={seconds}:r=30"]
        if moving:
            inputs += ["-f", "lavfi", "-i", f"color=c=0xf0f0f0:s=80x80:d={seconds}:r=30"]
    filt, k, labels = [], 0, []
    for i, (color, seconds, moving) in enumerate(parts):
        if moving:
            filt.append(f"[{k}][{k + 1}]overlay=x='10+70*t':y=50[s{i}]")
            k += 2
        else:
            filt.append(f"[{k}]null[s{i}]")
            k += 1
        labels.append(f"[s{i}]")
    filt.append("".join(labels) + f"concat=n={len(parts)}:v=1:a=0[v]")
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filt), "-map", "[v]",
                    "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


@pytest.fixture
def clip(tmp_path):
    return make_clip(tmp_path / "demo.mp4")


def test_shots_split_where_the_picture_changes_and_score_the_moving_one(clip):
    found = sh.detect(str(clip))
    assert [round(s["start"], 1) for s in found] == [0.0, 2.0, 5.0], found
    assert round(found[-1]["end"], 1) == 7.0
    assert [s["n"] for s in found] == [1, 2, 3]
    assert found[1]["motion"] > found[0]["motion"] and found[1]["motion"] > found[2]["motion"]


def test_too_many_shots_merge_down_to_the_cap_shortest_first():
    raw = [{"start": float(i), "end": float(i + 1), "motion": 0.1} for i in range(10)]
    raw[3]["end"] = 3.2   # a short one
    raw[4]["start"] = 3.2
    merged = sh.cap_shots(raw, 6)
    assert len(merged) == 6 and merged[0]["start"] == 0.0 and merged[-1]["end"] == 10.0
    assert all(a["end"] == b["start"] for a, b in zip(merged, merged[1:]))
    assert [s["n"] for s in merged] == [1, 2, 3, 4, 5, 6]


def test_the_sidecar_is_kept_and_read_back_without_scanning_again(clip, monkeypatch):
    first = sh.shots_for(str(clip))
    side = clip.with_name("demo.shots.json")
    doc = json.loads(side.read_text())
    assert doc["size"] == clip.stat().st_size and doc["shots"] == first["shots"]
    monkeypatch.setattr(sh, "frame_scores", lambda *a, **k: pytest.fail("scanned again"))
    assert sh.shots_for(str(clip))["shots"] == first["shots"]


def test_a_sidecar_for_another_version_of_the_file_is_scanned_again(clip):
    sh.shots_for(str(clip))
    side = clip.with_name("demo.shots.json")
    doc = json.loads(side.read_text())
    doc["mtime"] -= 100
    doc["shots"] = [{"n": 1, "start": 0, "end": 7, "motion": 0}]
    side.write_text(json.dumps(doc))
    assert len(sh.shots_for(str(clip))["shots"]) == 3


def test_labels_are_saved_by_number_and_kept(clip):
    sh.shots_for(str(clip))
    out = sh.label(str(clip), {"2": "box crosses the room", "3": "blue hold"})
    assert [s.get("label") for s in out["shots"]] == [None, "box crosses the room", "blue hold"]
    out = sh.label(str(clip), {"1": "red open"})
    assert [s.get("label") for s in out["shots"]] == ["red open", "box crosses the room", "blue hold"]
    out = sh.label(str(clip), {"3": ""})
    assert "label" not in out["shots"][2], "an empty label removes it"
    with pytest.raises(sh.ShotsError, match="no shot 9.*1 to 3"):
        sh.label(str(clip), {"9": "x"})


def test_detecting_again_keeps_the_labels_of_shots_that_are_still_there(clip):
    sh.shots_for(str(clip))
    sh.label(str(clip), {"2": "box crosses the room"})
    again = sh.shots_for(str(clip), redetect=True)
    assert again["shots"][1]["label"] == "box crosses the room"


def test_the_sheet_has_a_tile_per_shot(clip, tmp_path):
    from PIL import Image
    found = sh.shots_for(str(clip))
    out = tmp_path / "sheet.jpg"
    sh.sheet(str(clip), found["shots"], str(out))
    with Image.open(out) as im:
        w, h = im.size
    assert out.exists() and w > 0 and h > 0


# -- the step and the route -------------------------------------------------------------------------------------------

def _project(tmp_path, clip):
    pdir = tmp_path / "proj"
    pdir.mkdir()
    (pdir / "project.json").write_text(json.dumps({
        "id": "p1", "name": "t", "settings": {"fps": 30},
        "sources": [{"id": "clip-9", "type": "video", "src": str(clip), "start": 0, "end": 0}],
        "tracks": [{"id": "trk-0", "items": [{"id": "b-1", "type": "video", "src": str(clip), "start": 0, "end": 2,
                                              "inPoint": 0, "outPoint": 2}]}]}))
    return pdir / "project.json"


def test_the_step_answers_the_shots_and_one_sheet_then_saves_labels(tmp_path, clip):
    pj = _project(tmp_path, clip)
    step = [sys.executable, str(ROOT / "steps" / "media" / "shots.py"), "--project", str(pj), "--clip", "clip-9"]
    out = json.loads(subprocess.run(step, check=True, capture_output=True, text=True).stdout)
    assert out["clip"] == "clip-9" and len(out["shots"]) == 3 and os.path.isfile(out["sheet"])
    assert out["sheet"].endswith(".jpg")
    out = json.loads(subprocess.run(step + ["--labels", json.dumps({"2": "box"})], check=True, capture_output=True,
                                    text=True).stdout)
    assert out["shots"][1]["label"] == "box"
    # a timeline item id names the same file
    out = json.loads(subprocess.run(step[:-1] + ["b-1"], check=True, capture_output=True, text=True).stdout)
    assert out["shots"][1]["label"] == "box"


def test_project_shots_lists_every_source_with_a_sidecar(tmp_path, clip):
    pj = _project(tmp_path, clip)
    assert sh.project_shots(json.loads(pj.read_text())) == {}
    sh.shots_for(str(clip))
    sh.label(str(clip), {"1": "red"})
    got = sh.project_shots(json.loads(pj.read_text()))
    assert list(got) == ["clip-9"] and got["clip-9"]["src"] == str(clip) and got["clip-9"]["shots"][0]["label"] == "red"


def test_the_route_answers_the_projects_shots(tmp_path, clip):
    import asyncio
    import serve.routes.projects as projects_mod
    pj = _project(tmp_path, clip)
    assert asyncio.run(projects_mod.list_shots("p1", project_dir=pj.parent)) == {"shots": {}}
    sh.shots_for(str(clip))
    got = asyncio.run(projects_mod.list_shots("p1", project_dir=pj.parent))["shots"]
    assert list(got) == ["clip-9"] and len(got["clip-9"]["shots"]) == 3


# -- snapshot: one sheet for several clips (clips: true answered 10+ images, most of them takes nobody needed) ---------

def test_snapshot_makes_one_sheet_a_row_per_clip(tmp_path):
    from PIL import Image
    a = make_clip(tmp_path / "a.mp4")
    b = make_clip(tmp_path / "b.mp4", parts=(("0x303030", 3.0, False),))
    out = tmp_path / "clips.jpg"
    r = subprocess.run([sys.executable, str(ROOT / "steps" / "media" / "snapshot.py"), "--inputs", str(a), "--inputs", str(b),
                        "--names", "clip-9", "--names", "clip-3", "--cols", "4", "--out", str(out)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == str(out)
    with Image.open(out) as im:
        w, h = im.size
    assert w > h, "two rows of four"


@pytest.mark.parametrize("n,sheets", [(12, 1), (13, 2), (25, 3)])
def test_snapshot_splits_more_than_twelve_clips_into_sheets(tmp_path, n, sheets):
    a = make_clip(tmp_path / "a.mp4")
    out = tmp_path / "clips.jpg"
    args = [x for i in range(n) for x in ("--inputs", str(a), "--names", f"c{i}")]
    r = subprocess.run([sys.executable, str(ROOT / "steps" / "media" / "snapshot.py"), *args, "--cols", "2",
                        "--out", str(out)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    paths = r.stdout.split()
    assert paths[0] == str(out) and len(paths) == sheets
    assert all(os.path.isfile(p) for p in paths)


def test_snapshot_declares_inputs_and_names_and_serve_passes_them():
    from serve.routes.steps import build_cli_args
    spec = json.loads((ROOT / "steps" / "media" / "snapshot.json").read_text())
    names = {p["name"] for p in spec["params"]}
    assert {"inputs", "names"} <= names
    args = build_cli_args(spec, {"inputs": ["/a.mp4", "/b.mp4"], "names": ["clip-9", "clip-3"], "cols": 4})
    pairs = list(zip(args, args[1:]))
    assert [b for a, b in pairs if a == "--inputs"] == ["/a.mp4", "/b.mp4"]
    assert [b for a, b in pairs if a == "--names"] == ["clip-9", "clip-3"]
    assert "--input" not in args


# Run 5 (Sam saw a 1-2 frame flash): a variable-frame-rate screen recording, shots reported on the 10 fps scan's grid
# (48.6 for a cut at 48.567), and an outPoint at the shot's end showed a frame of the next shot.
def vfr_clip(path):
    """48 fps for 40 frames, then about 36 fps (timebase 1/600): a hard cut from grey to near-black at frame 59."""
    first, cut = 40, 59
    pts = f"if(lt(N,{first}),N/48,{first}/48+(N-{first})/36)/TB"
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x909090:s=320x180:r=48:d=3",
                    "-vf", f"geq=lum='if(lt(N,{cut}),144,20)':cb=128:cr=128,setpts='{pts}'",
                    "-fps_mode", "vfr", "-video_track_timescale", "600", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-g", "1", str(path)], check=True)
    # the frames' own times, as written (the encoder rounds them to its timebase): the new shot's first, the old's last
    times = [float(x.strip(",")) for x in subprocess.run([ffprobe_bin(), "-v", "error", "-select_streams", "v", "-show_entries",
                                               "frame=pts_time", "-of", "csv=p=0", str(path)],
                                              check=True, capture_output=True, text=True).stdout.split()]
    assert round(times[cut] * 10) != times[cut] * 10, "the cut is off the 0.1 s grid"
    return path, times[cut], times[cut - 1]


def test_a_cut_is_reported_at_the_exact_frame_times_never_on_the_scan_grid(tmp_path):
    path, first_new, last_old = vfr_clip(tmp_path / "vfr.mp4")
    found = sh.detect(str(path))
    assert len(found) == 2, found
    one, two = found
    assert abs(two["start"] - first_new) < 0.002, (two["start"], first_new)       # 1.355, not the scan's 1.4
    assert abs(one["end"] - last_old) < 0.002, (one["end"], last_old)             # the old shot's last frame
    assert one["end"] < two["start"]
