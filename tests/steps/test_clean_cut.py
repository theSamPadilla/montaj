"""§558 E2: clean_cut cuts a talking-head project in one call: transcribe, the mechanical pass, one take per
section, applied through speech_edit's save path.

Runs the step's main() in process. Transcription is stubbed (`transcribe_file` writes a fixed sidecar): no
model runs, nothing reaches a connector or the network. ffmpeg measures the fixture's real audio.
"""
import contextlib
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import steps.edit.clean_cut as cc  # noqa: E402
from lib import speech_text  # noqa: E402

FIX = REPO_ROOT / "tests" / "fixtures" / "speech_text"
SCHEMA = json.loads((REPO_ROOT / "steps" / "edit" / "clean_cut.json").read_text())
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]

# The fixture's 52 real word times, relabelled into retakes: three takes of the first sentence (a filler
# take, a restart take, a clean take), a complete then a truncated take of the second, then three sentences.
SCRIPT = ("Start by, um, picking the clip you want. "
          "Start by... Start by picking the clip you want. "
          "Start by picking the clip you want. "
          "Then drag it onto the timeline. "
          "Then drag it onto "
          "Trim the start so it opens on the action. "
          "Finally export it for your phone today. "
          "Thanks everyone.").split()
KEPT = ["Start by picking the clip you want.", "Then drag it onto the timeline.",
        "Trim the start so it opens on the action.", "Finally export it for your phone today.",
        "Thanks everyone."]


SOURCE_S = cc.get_duration(str(FIX / "speech.mp4"))


def git(d, *args):
    return subprocess.run([*GIT, *args], cwd=d, capture_output=True, text=True, check=True).stdout


def retake_transcript():
    real = json.loads((FIX / "speech.json").read_text())
    words = [w for w in real["transcription"] if w["text"].strip()]
    assert len(words) == len(SCRIPT)
    out = []
    for w, text in zip(words, SCRIPT):
        out.append({**w, "text": " " + text, "offsets": dict(w["offsets"])})
    # the truncated take breaks off: a pause before "Trim", where the next sentence starts
    trim = SCRIPT.index("Trim")
    out[trim]["offsets"]["from"] = out[trim - 1]["offsets"]["to"] + 350
    return {**real, "transcription": out}


def make_project(tmp_path, transcript=None):
    """A fresh project (one clip straight from project creation: no inPoint/outPoint), its own git repo.
    With `transcript`, the clip's sidecar is already there."""
    d = tmp_path / "proj"
    d.mkdir()
    shutil.copy(FIX / "speech.mp4", d / "speech.mp4")
    base = json.loads((FIX / "project.json").read_text())
    project = {k: base[k] for k in ("version", "settings", "status", "workflow", "editingPrompt")}
    project.update({"id": "clean-cut-fixture", "name": "Clean cut",
                    "tracks": [{"id": "trk-0", "items": [
                        {"id": "clip-0", "type": "video", "src": str(d / "speech.mp4"), "start": 0.0, "end": 0.0,
                         "sourceDuration": SOURCE_S, "sourceWidth": 64, "sourceHeight": 64}]}]})
    (d / "project.json").write_text(json.dumps(project, indent=2))
    if transcript is not None:
        (d / "speech.json").write_text(json.dumps(transcript))
    git(d, "init", "-q")
    git(d, "add", "project.json")
    git(d, "commit", "-q", "-m", "init")
    return d


def touch_unsaved(d):
    """An edit not yet in any version, so the run's version commit has something to take."""
    p = json.loads((d / "project.json").read_text())
    p["name"] = "Clean cut, renamed"
    text = json.dumps(p, indent=2)
    (d / "project.json").write_text(text)
    return text


@pytest.fixture
def stub_transcribe(monkeypatch):
    """transcribe_file writes the given transcript beside the clip and records what it was asked."""
    calls = []

    def install(transcript, fail=None):
        def fake(input_path, out=None, model=None, language="en", **kw):
            calls.append({"input": input_path, "model": model, "language": language})
            if fail:
                cc.fail(fail, "stub: whisper failed")
            prefix = out or str(Path(input_path).with_suffix(""))
            Path(prefix + ".json").write_text(json.dumps(transcript))
            Path(prefix + ".srt").write_text("")
            return {"words": prefix + ".json", "srt": prefix + ".srt"}
        monkeypatch.setattr(cc, "transcribe_file", fake)
        return calls
    return install


def run(d, *extra, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["clean_cut.py", "--project", str(d / "project.json"), *extra])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        cc.main()
    raw = out.getvalue()
    assert raw.count("\n") <= 1, "one JSON object on stdout, nothing else"
    return json.loads(raw), raw


def phrases(d):
    """The speech now on the timeline, one sentence per kept take."""
    project = json.loads((d / "project.json").read_text())
    der = speech_text.derive(project, str(d), "trk-0")
    words = [w.text for r in der.cut if r.kind == "speech" for w in r.words]
    out, cur = [], []
    for w in words:
        cur.append(w)
        if w.endswith((".", "?", "!")):
            out.append(" ".join(cur))
            cur = []
    return out + ([" ".join(cur)] if cur else [])


def test_schema_declares_the_params():
    names = {p["name"]: p for p in SCHEMA["params"]}
    assert names["project"]["required"] is True and names["project"]["type"] == "path"
    assert {"max-pause", "preview", "model", "language"} <= set(names)
    assert SCHEMA["input"]["type"] == "project"


def test_cuts_to_one_take_per_section_through_the_speech_edit_save(tmp_path, stub_transcribe, monkeypatch):
    calls = stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    unsaved = touch_unsaved(d)
    commits = int(git(d, "rev-list", "--count", "HEAD"))
    out, raw = run(d, monkeypatch=monkeypatch)

    assert phrases(d) == KEPT
    # speech_edit's save path: a version taken first, with the original project in it
    assert int(git(d, "rev-list", "--count", "HEAD")) == commits + 1
    assert git(d, "log", "-1", "--format=%s") .strip() == "version: before clean cut"
    assert git(d, "show", "HEAD:project.json") == unsaved
    # and speech-text.md written, the way speech_edit leaves it
    assert (d / "speech-text.md").is_file()
    # the transcript landed beside the clip as the project holds it
    assert calls == [{"input": str(d / "speech.mp4"), "model": "large-v3-turbo-q5_0", "language": "en"}]
    assert (d / "speech.json").is_file()

    assert set(out) == {"project", "mode", "kept", "removed", "duration", "text", "transcribed"}
    assert out["project"] == "clean-cut-fixture" and out["mode"] == "speech"
    assert out["transcribed"] == ["clip-0"]
    assert out["kept"]["lines"] == len(KEPT)
    assert out["removed"]["takes"] == 4          # filler take, "Start by...", restart take, truncated take
    assert out["removed"]["fillers"] == 1
    assert out["removed"]["seconds"] > 0
    items = json.loads((d / "project.json").read_text())["tracks"][0]["items"]
    assert out["duration"] == pytest.approx(max(it["end"] for it in items), abs=0.01)
    assert out["kept"]["seconds"] == pytest.approx(out["duration"], abs=0.01)
    assert out["removed"]["seconds"] == pytest.approx(SOURCE_S - out["duration"], abs=0.02)
    lines = out["text"].splitlines()
    assert [ln.split(" ", 1)[1] for ln in lines] == KEPT
    assert all(float(ln.split(" ", 1)[0]) >= 0 for ln in lines)
    assert len(raw) < 2000


def test_preview_writes_nothing(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path, transcript=retake_transcript())
    before = (d / "project.json").read_bytes()
    commits = git(d, "rev-list", "--count", "HEAD")
    out, _ = run(d, "--preview", monkeypatch=monkeypatch)
    assert out["mode"] == "speech" and out["kept"]["lines"] == len(KEPT)
    assert [ln.split(" ", 1)[1] for ln in out["text"].splitlines()] == KEPT
    assert out["transcribed"] == []              # the sidecar was already there
    assert (d / "project.json").read_bytes() == before
    assert git(d, "rev-list", "--count", "HEAD") == commits
    assert not (d / "speech-text.md").exists()
    assert git(d, "status", "--porcelain", "--", "project.json") == ""


def test_max_pause_is_passed_to_the_apply(tmp_path, stub_transcribe, monkeypatch):
    seen = {}
    real = cc.apply

    def spy(*a, **k):
        seen.update(k)
        return real(*a, **k)
    monkeypatch.setattr(cc, "apply", spy)
    d = make_project(tmp_path, transcript=retake_transcript())
    run(d, "--preview", "--max-pause", "0.3", monkeypatch=monkeypatch)
    assert seen["max_pause"] == 0.3 and seen["preview"] is True and seen["base"] is not None


def test_no_speech_falls_back_to_silence_removal(tmp_path, stub_transcribe, monkeypatch):
    silent = {**retake_transcript(), "transcription": []}
    stub_transcribe(silent)
    d = make_project(tmp_path)
    expected = cc.waveform_trim.process_one(str(d / "speech.mp4"), -30.0, 0.3)["keeps"]
    unsaved = touch_unsaved(d)
    commits = int(git(d, "rev-list", "--count", "HEAD"))
    out, _ = run(d, monkeypatch=monkeypatch)
    assert out["mode"] == "silence" and "silence" in out["note"]
    items = json.loads((d / "project.json").read_text())["tracks"][0]["items"]
    kept = [[it["inPoint"], it["outPoint"]] for it in items]
    want = [[round(s, 6), round(e, 6)] for s, e in expected if e - s >= 0.05]
    assert kept == want
    assert int(git(d, "rev-list", "--count", "HEAD")) == commits + 1
    assert git(d, "show", "HEAD:project.json") == unsaved
    assert out["kept"]["lines"] == 0 and out["removed"]["takes"] == 0


def test_failed_transcription_falls_back_to_silence_removal(tmp_path, stub_transcribe, monkeypatch, capsys):
    stub_transcribe(None, fail="transcription_failed")
    d = make_project(tmp_path)
    out, _ = run(d, "--preview", monkeypatch=monkeypatch)
    assert out["mode"] == "silence" and out["transcribed"] == []
    assert any("transcription failed" in w for w in out["warnings"])


def test_no_whisper_model_fails_as_transcribe_does(tmp_path, stub_transcribe, monkeypatch, capsys):
    stub_transcribe(None, fail="whisper_model_missing")
    d = make_project(tmp_path)
    before = (d / "project.json").read_bytes()
    monkeypatch.setattr(sys, "argv", ["clean_cut.py", "--project", str(d / "project.json")])
    with pytest.raises(SystemExit):
        cc.main()
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "whisper_model_missing"
    assert (d / "project.json").read_bytes() == before


def test_a_human_edit_during_the_run_is_refused_not_merged(tmp_path, stub_transcribe, monkeypatch, capsys):
    """clean_cut reads the project, cuts it in memory, then writes: a human edit in between refuses the write."""
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    real = cc.select
    human = {}

    def select_then_human_edits(*a, **k):
        p = json.loads((d / "project.json").read_text())
        p["tracks"][0]["items"][0]["volume"] = 0.5      # the human edits the clip meanwhile
        (d / "project.json").write_text(json.dumps(p, indent=2))
        human["bytes"] = (d / "project.json").read_bytes()
        return real(*a, **k)
    monkeypatch.setattr(cc, "select", select_then_human_edits)
    monkeypatch.setattr(sys, "argv", ["clean_cut.py", "--project", str(d / "project.json")])
    out = io.StringIO()
    with pytest.raises(SystemExit) as e, contextlib.redirect_stdout(out):
        cc.main()
    assert e.value.code == 1 and out.getvalue() == ""
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "project_changed"
    assert (d / "project.json").read_bytes() == human["bytes"]


def test_no_network_or_connector_is_reachable():
    src = (REPO_ROOT / "steps" / "edit" / "clean_cut.py").read_text()
    for name in ("connectors", "credentials", "requests", "urllib", "http"):
        assert f"import {name}" not in src and f"from {name}" not in src


def test_apply_with_a_base_refuses_when_the_disk_moved_since_the_base_was_read(tmp_path, monkeypatch, capsys):
    """speech_apply's base=: the guards compare with base_of (the caller's read), not with a later read."""
    from lib.speech_apply import apply
    d = make_project(tmp_path, transcript=retake_transcript())
    as_read = json.loads((d / "project.json").read_text())
    base = json.loads(json.dumps(as_read))
    base["tracks"][0]["items"][0].update({"inPoint": 0.0, "outPoint": SOURCE_S, "end": SOURCE_S})
    der = speech_text.derive(base, str(d), "trk-0")
    text = speech_text.render(der, "x", "none")
    text = "\n".join(ln for ln in text.splitlines() if not ln.startswith("A1 ")) + "\n"
    edited = json.loads(json.dumps(as_read))
    edited["tracks"][0]["items"][0]["volume"] = 0.5
    (d / "project.json").write_text(json.dumps(edited, indent=2))
    moved = (d / "project.json").read_bytes()
    with pytest.raises(SystemExit):
        apply(str(d / "project.json"), text, preview=False, max_pause=None, base=base, base_of=as_read)
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "project_changed"
    assert (d / "project.json").read_bytes() == moved
    with pytest.raises(ValueError):
        apply(str(d / "project.json"), text, preview=True, max_pause=None, base=base)


def test_serve_runs_it_on_a_project_id(tmp_path, monkeypatch):
    """Through POST /api/steps/clean_cut (a subprocess: the clip already has its transcript, nothing runs whisper)."""
    from starlette.testclient import TestClient
    import serve.server
    ws = tmp_path / "Montaj"
    ws.mkdir()
    d = make_project(ws, transcript=retake_transcript())
    before = (d / "project.json").read_bytes()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    monkeypatch.setattr(serve.server, "HEADLESS", True)
    with TestClient(serve.server.app, raise_server_exceptions=False) as client:
        resp = client.post("/api/steps/clean_cut", json={"project": "clean-cut-fixture", "preview": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "speech" and [ln.split(" ", 1)[1] for ln in body["text"].splitlines()] == KEPT
    assert (d / "project.json").read_bytes() == before


def test_a_second_run_is_a_no_op_answer(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    first, _ = run(d, monkeypatch=monkeypatch)
    project = json.loads((d / "project.json").read_text())
    marker = project["cleanCut"]
    assert set(marker) == {"at", "maxPause", "stepVersion", "mode", "kept", "removed", "duration", "tracksRev"}
    assert marker["stepVersion"] == cc.STEP_VERSION and marker["maxPause"] == 0.45   # the effective cap
    assert (marker["kept"], marker["removed"], marker["duration"]) == (first["kept"], first["removed"], first["duration"])
    assert "cleanCut" not in json.loads(git(d, "show", "HEAD:project.json"))   # the version is the project before
    # a human edit afterwards does not clear it
    project["tracks"][0]["items"][0]["volume"] = 0.8
    (d / "project.json").write_text(json.dumps(project, indent=2))
    after = (d / "project.json").read_bytes()
    commits = git(d, "rev-list", "--count", "HEAD")
    again, raw = run(d, monkeypatch=monkeypatch)
    assert again == {"project": "clean-cut-fixture", "mode": "already-cut", "cutAt": marker["at"],
                     "kept": first["kept"], "removed": marker["removed"], "duration": first["duration"],
                     "changedSince": True,
                     "note": "Already cut, and the timeline changed since. Pass recut to cut it again."}
    assert (d / "project.json").read_bytes() == after
    assert git(d, "rev-list", "--count", "HEAD") == commits
    preview, _ = run(d, "--preview", monkeypatch=monkeypatch)
    assert preview["mode"] == "already-cut"


def test_already_cut_without_a_later_change_says_so_plainly(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    run(d, monkeypatch=monkeypatch)
    again, _ = run(d, monkeypatch=monkeypatch)
    assert again["mode"] == "already-cut" and "changedSince" not in again


def test_a_run_that_finds_the_project_cut_after_transcribing_does_nothing(tmp_path, stub_transcribe, monkeypatch):
    """Two runs at once: the second re-reads after its transcription and finds the first's marker."""
    calls = stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    real = cc.transcribe_file

    def transcribe_while_another_run_cuts(*a, **k):
        r = real(*a, **k)
        p = json.loads((d / "project.json").read_text())
        p["cleanCut"] = {"at": "2026-10-24T00:00:00Z", "kept": {"lines": 1, "seconds": 1.0},
                         "removed": {"takes": 0, "fillers": 0, "seconds": 0.0}, "duration": 1.0}
        (d / "project.json").write_text(json.dumps(p, indent=2))
        return r
    monkeypatch.setattr(cc, "transcribe_file", transcribe_while_another_run_cuts)
    out, _ = run(d, monkeypatch=monkeypatch)
    assert out["mode"] == "already-cut" and calls
    assert json.loads((d / "project.json").read_text())["tracks"][0]["items"][0]["id"] == "clip-0"


def test_recut_cuts_again(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    run(d, monkeypatch=monkeypatch)
    first_at = json.loads((d / "project.json").read_text())["cleanCut"]
    out, _ = run(d, "--recut", "--max-pause", "0.3", monkeypatch=monkeypatch)
    assert out["mode"] == "speech" and [ln.split(" ", 1)[1] for ln in out["text"].splitlines()] == KEPT
    assert out["removed"]["takes"] == 0          # the timeline holds one take each already
    marker = json.loads((d / "project.json").read_text())["cleanCut"]
    assert marker["maxPause"] == 0.3 and marker["kept"] == out["kept"]
    assert phrases(d) == KEPT


def test_silence_mode_leaves_the_marker_too(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe({**retake_transcript(), "transcription": []})
    d = make_project(tmp_path)
    run(d, monkeypatch=monkeypatch)
    assert json.loads((d / "project.json").read_text())["cleanCut"]["mode"] == "silence"
    again, _ = run(d, monkeypatch=monkeypatch)
    assert again["mode"] == "already-cut"


# ── where the transcript may be written (review B1, S4) ─────────────────────

def _project_with_clip(tmp_path, clip_path):
    tmp_path.mkdir(parents=True, exist_ok=True)
    d = make_project(tmp_path)
    clip_path.parent.mkdir(parents=True, exist_ok=True)
    if clip_path != d / "speech.mp4":
        shutil.copy(FIX / "speech.mp4", clip_path)
    p = json.loads((d / "project.json").read_text())
    p["tracks"][0]["items"][0]["src"] = str(clip_path)
    (d / "project.json").write_text(json.dumps(p, indent=2))
    return d


def test_a_clip_named_project_never_replaces_project_json(tmp_path, stub_transcribe, monkeypatch):
    calls = stub_transcribe(retake_transcript())
    d = _project_with_clip(tmp_path / "b", tmp_path / "b" / "proj" / "project.mp4")
    out, _ = run(d, "--preview", monkeypatch=monkeypatch)
    assert calls == []
    assert any("project.json" in w for w in out["warnings"])
    assert json.loads((d / "project.json").read_text())["tracks"][0]["items"][0]["id"] == "clip-0"


def test_a_users_own_files_beside_the_clip_are_never_overwritten(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    (d / "speech.srt").write_text("my own subtitles\n")
    run(d, "--preview", monkeypatch=monkeypatch)
    assert (d / "speech.srt").read_text() == "my own subtitles\n"     # the .srt is never written
    assert "transcription" in json.loads((d / "speech.json").read_text())


def test_an_existing_json_that_is_not_a_transcript_is_left_alone(tmp_path, stub_transcribe, monkeypatch):
    calls = stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    (d / "speech.json").write_text('{"mine": true}')
    out, _ = run(d, "--preview", monkeypatch=monkeypatch)
    assert calls == [] and (d / "speech.json").read_text() == '{"mine": true}'
    assert any("not a transcript" in w for w in out["warnings"])


def test_a_clip_in_a_hidden_folder_outside_the_project_is_not_transcribed(tmp_path, stub_transcribe, monkeypatch):
    calls = stub_transcribe(retake_transcript())
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path / "ws"))
    hidden = tmp_path / ".private" / "speech.mp4"
    d = _project_with_clip(tmp_path / "c", hidden)
    out, _ = run(d, "--preview", monkeypatch=monkeypatch)
    assert calls == [] and not (hidden.parent / "speech.json").exists()
    assert any("not a place" in w for w in out["warnings"])


def test_two_clips_sharing_a_transcript_name_fail(tmp_path, stub_transcribe, monkeypatch, capsys):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    shutil.copy(FIX / "speech.mp4", d / "speech.mov")
    p = json.loads((d / "project.json").read_text())
    p["tracks"][0]["items"].append({**p["tracks"][0]["items"][0], "id": "clip-1", "src": str(d / "speech.mov")})
    (d / "project.json").write_text(json.dumps(p, indent=2))
    monkeypatch.setattr(sys, "argv", ["clean_cut.py", "--project", str(d / "project.json")])
    with pytest.raises(SystemExit):
        cc.main()
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "transcript_name_clash"
    assert not (d / "speech.json").exists()


# ── layers follow the speech they sat on (review B2) ────────────────────────

def _layered_project(tmp_path):
    """The retake project with an overlay and a note at every word, and captions, timed to the original
    timeline (a fresh clip: timeline time is source time)."""
    d = make_project(tmp_path, transcript=retake_transcript())
    words = [w for w in retake_transcript()["transcription"]]
    p = json.loads((d / "project.json").read_text())
    (d / "x.jsx").write_text("export default function X(){return null}")
    p["tracks"].append({"id": "trk-ov", "items": [
        {"id": f"ov-{i}", "type": "overlay", "src": str(d / "x.jsx"),
         "start": w["offsets"]["from"] / 1000, "end": w["offsets"]["from"] / 1000 + 0.2} for i, w in enumerate(words)]})
    p["notes"] = [{"id": f"n{i}", "t": w["offsets"]["from"] / 1000, "text": w["text"].strip()} for i, w in enumerate(words)]
    segs, cur = [], []
    for w in words:
        cur.append({"word": w["text"].strip(), "start": w["offsets"]["from"] / 1000, "end": w["offsets"]["to"] / 1000})
        if cur[-1]["word"].endswith((".", "?", "!")) or len(cur) == 6:
            segs.append({"id": f"cap-{len(segs)}", "text": " ".join(x["word"] for x in cur),
                         "start": cur[0]["start"], "end": cur[-1]["end"], "words": cur})
            cur = []
    if cur:
        segs.append({"id": f"cap-{len(segs)}", "text": " ".join(x["word"] for x in cur),
                     "start": cur[0]["start"], "end": cur[-1]["end"], "words": cur})
    p["captions"] = {"style": "subtitle", "segments": segs}
    (d / "project.json").write_text(json.dumps(p, indent=2))
    return d, words


def _new_time(items, s):
    """Where source second s plays in the cut, or None when it was cut."""
    for it in items:
        if it["inPoint"] - 1e-6 <= s < it["outPoint"]:
            return it["start"] + (s - it["inPoint"])
    return None


@pytest.mark.parametrize("preview", [False, True])
def test_overlays_notes_and_captions_follow_the_kept_speech(tmp_path, stub_transcribe, monkeypatch, preview):
    d, words = _layered_project(tmp_path)
    seen = {}
    real = cc.apply

    def spy(*a, **k):
        seen["result"] = real(*a, **k)
        return seen["result"]
    monkeypatch.setattr(cc, "apply", spy)
    run(d, *(["--preview"] if preview else []), monkeypatch=monkeypatch)
    after = seen["result"]["_project"] if preview else json.loads((d / "project.json").read_text())
    items = after["tracks"][0]["items"]
    overlays = {it["id"]: it for t in after["tracks"] if t["id"] == "trk-ov" for it in t["items"]}
    notes = {n["id"]: n for n in after.get("notes") or []}
    played = 0
    for i, w in enumerate(words):
        src_mid = (w["offsets"]["from"] + w["offsets"]["to"]) / 2000
        t = _new_time(items, src_mid)
        if t is None:
            continue
        played += 1
        start = _new_time(items, w["offsets"]["from"] / 1000)
        if start is not None:          # the word's own start plays: its overlay and note sit there now
            assert overlays[f"ov-{i}"]["start"] == pytest.approx(start, abs=0.01), (i, w["text"])
            assert notes[f"n{i}"]["t"] == pytest.approx(start, abs=0.01), (i, w["text"])
    assert played >= len(" ".join(KEPT).split()) - 2
    # nothing piles up at the head: overlays keep distinct times, in the kept speech's order
    starts = [overlays[k]["start"] for k in sorted(overlays, key=lambda k: int(k.split("-")[1]))]
    assert len(set(round(x, 3) for x in starts)) >= played - 2
    # captions now read the kept speech, in order
    cap_words = [x["word"] for seg in after["captions"]["segments"] for x in seg.get("words", [])]
    assert cap_words == " ".join(KEPT).split()


def test_a_marker_written_during_the_run_refuses_the_write(tmp_path, stub_transcribe, monkeypatch, capsys):
    """S1: cleanCut is a guarded key of the write: another run's marker landing meanwhile refuses this one."""
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    real = cc.select

    def select_while_another_run_cuts(*a, **k):
        p = json.loads((d / "project.json").read_text())
        p["cleanCut"] = {"at": "2026-10-24T00:00:00Z"}
        (d / "project.json").write_text(json.dumps(p, indent=2))
        return real(*a, **k)
    monkeypatch.setattr(cc, "select", select_while_another_run_cuts)
    monkeypatch.setattr(sys, "argv", ["clean_cut.py", "--project", str(d / "project.json")])
    with pytest.raises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
        cc.main()
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "project_changed"
    assert json.loads((d / "project.json").read_text())["cleanCut"] == {"at": "2026-10-24T00:00:00Z"}


def test_silence_mode_with_nothing_to_cut_writes_nothing(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe({**retake_transcript(), "transcription": []})
    d = make_project(tmp_path)
    monkeypatch.setattr(cc.waveform_trim, "process_one",
                        lambda src, thr, ms: {"input": src, "keeps": [[0.0, SOURCE_S]]})
    unsaved = touch_unsaved(d)
    commits = git(d, "rev-list", "--count", "HEAD")
    out, _ = run(d, monkeypatch=monkeypatch)
    assert out["mode"] == "silence" and out["note"] == "Nothing to cut."
    assert (d / "project.json").read_text() == unsaved
    assert git(d, "rev-list", "--count", "HEAD") == commits


def test_a_silence_cut_after_a_failed_transcription_leaves_no_marker(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(None, fail="transcription_timeout")
    d = make_project(tmp_path)
    out, _ = run(d, monkeypatch=monkeypatch)
    assert out["mode"] == "silence" and "failed" in out["note"]
    project = json.loads((d / "project.json").read_text())
    assert "cleanCut" not in project and len(project["tracks"][0]["items"]) > 1


def test_a_waveform_failure_is_reported(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe({**retake_transcript(), "transcription": []})
    d = make_project(tmp_path)
    monkeypatch.setattr(cc.waveform_trim, "process_one", lambda *a: cc.fail("no_speech", "No speech detected"))
    out, _ = run(d, "--preview", monkeypatch=monkeypatch)
    assert any("no silence cut on clip-0" in w for w in out["warnings"])


def test_parallel_sentences_are_never_cut_end_to_end(tmp_path, stub_transcribe, monkeypatch):
    """Review 2, blocker 3: sentences built the same way are not retakes; every one stays."""
    sentences = ["You can cut your clips in one click.", "You can cut your audio in one click.",
                 "You can cut your captions in one click.", "The best part is the price.",
                 "The best part is the speed.", "This is the way we do it.", "Never, never, never give up today.",
                 "Thanks so much."]
    script = " ".join(sentences).split()
    real = json.loads((FIX / "speech.json").read_text())
    words = [w for w in real["transcription"] if w["text"].strip()]
    assert len(words) == len(script)
    stub_transcribe({**real, "transcription": [{**w, "text": " " + t} for w, t in zip(words, script)]})
    d = make_project(tmp_path)
    out, _ = run(d, monkeypatch=monkeypatch)
    assert out["removed"]["takes"] == 0
    assert [ln.split(" ", 1)[1] for ln in out["text"].splitlines()] == sentences
    assert phrases(d) == sentences
