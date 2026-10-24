"""§558 E2: `cut` plans a talking-head cut (transcribe, the mechanical pass, one take per section) as an
editable cut-plan.md, writing nothing to the project; `cut` with `plan` applies it through speech_edit's save.

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

import steps.edit.cut as cc  # noqa: E402
from lib import speech_text  # noqa: E402

FIX = REPO_ROOT / "tests" / "fixtures" / "speech_text"
SCHEMA = json.loads((REPO_ROOT / "steps" / "edit" / "cut.json").read_text())
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]
SOURCE_S = cc.get_duration(str(FIX / "speech.mp4"))

# The fixture's 52 real word times, relabelled into retakes: three takes of the first sentence (a filler
# take, a restart take, a clean take), a complete then a truncated take of the second (broken off at a pause
# before the next sentence), then three sentences.
SCRIPT = ("Start by, um, picking the clip you want. "
          "Start by... Start by picking the clip you want. "
          "Start by picking the clip you want. "
          "Then drag it onto the timeline. "
          "Then drag it onto "
          "Trim the start so it opens on the action. "
          "Finally export it for your phone today. "
          "Thanks everyone.").split()
KEPT = ["Start by picking the clip you want.", "Then drag it onto the timeline.",
        # the truncated take run into the next sentence stays: only offered (abandoned?), "Trim" could be a name
        "Then drag it onto Trim the start so it opens on the action.", "Finally export it for your phone today.",
        "Thanks everyone."]


def git(d, *args):
    return subprocess.run([*GIT, *args], cwd=d, capture_output=True, text=True, check=True).stdout


def retake_transcript():
    real = json.loads((FIX / "speech.json").read_text())
    words = [w for w in real["transcription"] if w["text"].strip()]
    assert len(words) == len(SCRIPT)
    out = [{**w, "text": " " + text, "offsets": dict(w["offsets"])} for w, text in zip(words, SCRIPT)]
    trim = SCRIPT.index("Trim")
    out[trim]["offsets"]["from"] = out[trim - 1]["offsets"]["to"] + 350
    return {**real, "transcription": out}


def make_project(tmp_path, transcript=None):
    """A fresh project (one clip straight from project creation: no inPoint/outPoint), its own git repo."""
    d = tmp_path / "proj"
    d.mkdir()
    shutil.copy(FIX / "speech.mp4", d / "speech.mp4")
    base = json.loads((FIX / "project.json").read_text())
    project = {k: base[k] for k in ("version", "settings", "status", "workflow", "editingPrompt")}
    project.update({"id": "cut-fixture", "name": "Cut",
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
    """An edit not yet in any version, so the apply's version commit has something to take."""
    p = json.loads((d / "project.json").read_text())
    p["name"] = "Cut, renamed"
    text = json.dumps(p, indent=2)
    (d / "project.json").write_text(text)
    return text


@pytest.fixture
def stub_transcribe(monkeypatch):
    """transcribe_file writes the given transcript at the prefix it is given, and records the calls."""
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
    monkeypatch.setattr(sys, "argv", ["cut.py", "--project", str(d / "project.json"), *extra])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        cc.main()
    raw = out.getvalue()
    assert raw.count("\n") <= 1, "one JSON object on stdout, nothing else"
    return json.loads(raw), raw


def refused(d, *extra, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["cut.py", "--project", str(d / "project.json"), *extra])
    with pytest.raises(SystemExit) as e, contextlib.redirect_stdout(io.StringIO()) as out:
        cc.main()
    assert e.value.code == 1 and out.getvalue() == ""
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"]


def plan_and_apply(d, monkeypatch, *extra):
    plan, _ = run(d, *extra, monkeypatch=monkeypatch)
    applied, _ = run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    return plan, applied


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


def sections(text):
    cut, unused, sec = [], [], None
    for ln in text.splitlines():
        if ln.startswith("## "):
            sec = ln[3:].strip()
            continue
        if ln.strip() and sec == "Cut":
            cut.append(ln)
        elif ln.strip() and sec == "Unused":
            unused.append(ln)
    return cut, unused


# ── the schema ──────────────────────────────────────────────────────────────

def test_schema_declares_the_params():
    names = {p["name"]: p for p in SCHEMA["params"]}
    assert SCHEMA["name"] == "cut"
    assert names["project"]["required"] is True and names["project"]["type"] == "path"
    assert {"plan", "language", "max-pause", "recut", "detail", "model"} == set(names) - {"project"}
    assert "preview" not in names
    assert SCHEMA["input"]["type"] == "project" and "language is detected" in SCHEMA["description"]


# ── the plan ────────────────────────────────────────────────────────────────

def test_the_plan_writes_nothing_to_the_project(tmp_path, stub_transcribe, monkeypatch):
    calls = stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    unsaved = touch_unsaved(d)
    commits = git(d, "rev-list", "--count", "HEAD")
    out, raw = run(d, monkeypatch=monkeypatch)
    assert (d / "project.json").read_text() == unsaved
    assert git(d, "rev-list", "--count", "HEAD") == commits
    assert not (d / "speech-text.md").exists()
    assert out["plan"] == str(d / "cut-plan.md") and (d / "cut-plan.md").is_file()
    # the transcript is the one file written beside the clip, where speech_text finds it
    assert calls == [{"input": str(d / "speech.mp4"), "model": "large-v3-turbo-q5_0", "language": "auto"}]
    assert (d / "speech.json").is_file() and not (d / "speech.srt").exists()

    assert set(out) == {"project", "mode", "plan", "kept", "removed", "suggested", "duration", "layers", "cut",
                        "next", "transcribed"}
    assert out["layers"] == {} and out["next"].startswith(f'Apply: cut with plan "{d / "cut-plan.md"}".')
    assert out["mode"] == "plan" and out["transcribed"] == ["clip-0"]
    cut_rows, unused_rows = sections((d / "cut-plan.md").read_text())
    assert out["kept"]["lines"] == len(cut_rows)                    # rows of the plan, as removed counts rows
    unused_part = (d / "cut-plan.md").read_text().split("\n## Unused\n", 1)[1].strip()
    groups = unused_part.split("\n\n")
    assert sum(out["removed"]["lines"].values()) == sum(1 for g in groups if "?]" not in g)   # one group per take
    assert out["removed"]["lines"] == {"retake": 2, "false-start": 1}
    assert out["suggested"] == {"abandoned?": 1}
    assert out["removed"]["fillers"] == 1 and out["removed"]["seconds"] > 0
    assert out["removed"]["seconds"] == pytest.approx(SOURCE_S - out["kept"]["seconds"], abs=0.02)
    lines = out["cut"].splitlines()
    assert all(ln.rsplit(" [", 1)[1].rstrip("]").rstrip("?") in cc.WHYS for ln in lines)
    assert any(ln.endswith("[false-start]") and "Start by..." in ln for ln in lines)
    assert len(raw) < 1500


def test_the_plan_is_speech_edit_text_with_removed_rows_tagged(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    out, _ = run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    header, rows = speech_text.parse(cc._untagged(text)[0])
    assert header["track"] == "trk-0"
    assert "language en" in text           # detected: the step transcribes with auto
    cut, unused = sections(text)
    kept_words = " ".join(" ".join(t for t in r.tokens) for r in rows if r.kind == "speech")
    assert kept_words == " ".join(KEPT)
    assert all(cc._TAG.search(r) for r in cut + unused)
    assert {cc._TAG.search(r).group(2) + (cc._TAG.search(r).group(3) or "") for r in unused} == \
        {"retake", "false-start", "abandoned?"}


def test_the_same_transcript_gives_the_same_plan(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    run(d, monkeypatch=monkeypatch)
    first = (d / "cut-plan.md").read_text()
    run(d, monkeypatch=monkeypatch)
    assert (d / "cut-plan.md").read_text() == first


def test_detail_adds_the_kept_lines(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    out, _ = run(d, "--detail", monkeypatch=monkeypatch)
    keep = " ".join(ln.split(" ", 2)[2] for ln in out["keep"].splitlines())
    assert keep == " ".join(KEPT)


# ── the apply ───────────────────────────────────────────────────────────────

def test_the_apply_cuts_through_the_speech_edit_save(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    plan, _ = run(d, monkeypatch=monkeypatch)
    unsaved = touch_unsaved(d)
    commits = int(git(d, "rev-list", "--count", "HEAD"))
    out, raw = run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert phrases(d) == KEPT
    assert int(git(d, "rev-list", "--count", "HEAD")) == commits + 1
    assert git(d, "log", "-1", "--format=%s").strip() == "version: before cut"
    assert git(d, "show", "HEAD:project.json") == unsaved
    assert (d / "speech-text.md").is_file()
    assert out == {"project": "cut-fixture", "mode": "applied", "version": "version: before cut",
                   "duration": plan["duration"], "undo": 'Restore the version "version: before cut".',
                   "layers": {}}
    marker = json.loads((d / "project.json").read_text())["cleanCut"]
    assert marker["removed"]["lines"] == {"retake": 2, "false-start": 1}
    assert marker["maxPause"] == 0.45 and marker["kept"]["seconds"] == plan["kept"]["seconds"]
    assert len(raw) < 300
    assert marker["planStamp"] == speech_text.parse(cc._untagged((d / "cut-plan.md").read_text())[0])[0]["stamp"]


def test_plan_text_inline_applies_too(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    run(d, monkeypatch=monkeypatch)
    run(d, "--plan", (d / "cut-plan.md").read_text(), monkeypatch=monkeypatch)
    assert phrases(d) == KEPT


def test_an_edited_plan_applies_exactly_that(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    lines = text.splitlines()
    unused_at = lines.index("## Unused")
    group = [i for i, ln in enumerate(lines) if i > unused_at and ln.startswith("A1 ")]   # the filler take
    restored = [lines[i] for i in group]
    assert [r.split(" [")[0] for r in restored] == ["A1 Start by,", "A1 picking the clip you want."]
    for i in reversed(group):
        lines.pop(i)
    drop = next(i for i, ln in enumerate(lines) if ln.split(" ", 1)[-1].startswith("Thanks everyone."))
    lines.pop(drop)
    unused_at = lines.index("## Unused")
    lines[unused_at - 1:unused_at - 1] = restored            # the restored take goes last in ## Cut
    (d / "cut-plan.md").write_text("\n".join(lines) + "\n")
    run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    assert phrases(d) == KEPT[:-1] + ["Start by, picking the clip you want."]


def test_max_pause_reaches_the_apply(tmp_path, stub_transcribe, monkeypatch):
    seen = []
    real = cc.apply

    def spy(*a, **k):
        seen.append(k)
        return real(*a, **k)
    monkeypatch.setattr(cc, "apply", spy)
    d = make_project(tmp_path, transcript=retake_transcript())
    plan, _ = run(d, "--max-pause", "0.3", monkeypatch=monkeypatch)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert [k["max_pause"] for k in seen] == [0.3, 0.3]           # the plan records it for the apply
    assert seen[0]["preview"] is True and seen[1]["preview"] is False and seen[1]["base"] is not None


def test_a_stale_plan_is_refused_when_the_transcript_changed(tmp_path, stub_transcribe, monkeypatch, capsys):
    d = make_project(tmp_path, transcript=retake_transcript())
    plan, _ = run(d, monkeypatch=monkeypatch)
    tr = retake_transcript()
    tr["transcription"][-1]["text"] = " everybody."
    (d / "speech.json").write_text(json.dumps(tr))
    before = (d / "project.json").read_bytes()
    assert refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "stale_plan"
    assert (d / "project.json").read_bytes() == before


def test_a_stale_plan_is_refused_when_the_speech_track_changed(tmp_path, stub_transcribe, monkeypatch, capsys):
    d = make_project(tmp_path, transcript=retake_transcript())
    plan, _ = run(d, monkeypatch=monkeypatch)
    p = json.loads((d / "project.json").read_text())
    p["tracks"][0]["items"][0].update({"inPoint": 1.0, "outPoint": SOURCE_S, "end": SOURCE_S - 1.0})
    (d / "project.json").write_text(json.dumps(p, indent=2))
    before = (d / "project.json").read_bytes()
    assert refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "stale_plan"
    assert (d / "project.json").read_bytes() == before


def test_a_plan_applied_twice_is_refused_the_second_time(tmp_path, stub_transcribe, monkeypatch, capsys):
    d = make_project(tmp_path, transcript=retake_transcript())
    plan_and_apply(d, monkeypatch)
    after = (d / "project.json").read_bytes()
    assert refused(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch, capsys=capsys) == "already_applied"
    assert (d / "project.json").read_bytes() == after


def test_a_human_edit_during_the_apply_is_refused_not_merged(tmp_path, stub_transcribe, monkeypatch, capsys):
    """The apply reads the project, rebuilds the base in memory, then writes: an edit in between refuses it."""
    d = make_project(tmp_path, transcript=retake_transcript())
    plan, _ = run(d, monkeypatch=monkeypatch)
    real = cc.select
    human = {}

    def select_then_human_edits(*a, **k):
        p = json.loads((d / "project.json").read_text())
        p["tracks"][0]["items"][0]["volume"] = 0.5
        (d / "project.json").write_text(json.dumps(p, indent=2))
        human["bytes"] = (d / "project.json").read_bytes()
        return real(*a, **k)
    monkeypatch.setattr(cc, "select", select_then_human_edits)
    assert refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "project_changed"
    assert (d / "project.json").read_bytes() == human["bytes"]


def test_a_marker_written_during_the_apply_refuses_it(tmp_path, stub_transcribe, monkeypatch, capsys):
    """cleanCut is a guarded key of the write: another apply's marker landing meanwhile refuses this one."""
    d = make_project(tmp_path, transcript=retake_transcript())
    plan, _ = run(d, monkeypatch=monkeypatch)
    real = cc.select

    def select_while_another_run_cuts(*a, **k):
        p = json.loads((d / "project.json").read_text())
        p["cleanCut"] = {"at": "2026-10-24T00:00:00Z"}
        (d / "project.json").write_text(json.dumps(p, indent=2))
        return real(*a, **k)
    monkeypatch.setattr(cc, "select", select_while_another_run_cuts)
    assert refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "project_changed"
    assert json.loads((d / "project.json").read_text())["cleanCut"] == {"at": "2026-10-24T00:00:00Z"}


def test_a_plan_outside_the_project_folder_is_refused(tmp_path, stub_transcribe, monkeypatch, capsys):
    d = make_project(tmp_path, transcript=retake_transcript())
    run(d, monkeypatch=monkeypatch)
    outside = tmp_path / "elsewhere.md"
    shutil.copy(d / "cut-plan.md", outside)
    assert refused(d, "--plan", str(outside), monkeypatch=monkeypatch, capsys=capsys) == "invalid_params"


def test_apply_with_a_base_refuses_when_the_disk_moved_since_the_base_was_read(tmp_path, capsys):
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


# ── a project already cut ───────────────────────────────────────────────────

def test_planning_a_cut_project_answers_already_cut(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    plan, _ = plan_and_apply(d, monkeypatch)
    marker = json.loads((d / "project.json").read_text())["cleanCut"]
    assert set(marker) == {"at", "maxPause", "stepVersion", "mode", "kept", "removed", "duration", "tracksRev",
                           "planStamp", "planHash"}
    plan_file = (d / "cut-plan.md").read_bytes()
    again, _ = run(d, monkeypatch=monkeypatch)
    assert again == {"project": "cut-fixture", "mode": "already-cut", "cutAt": marker["at"], "kept": marker["kept"],
                     "removed": marker["removed"], "duration": marker["duration"],
                     "note": "Already cut. Pass recut to cut it again."}
    assert (d / "cut-plan.md").read_bytes() == plan_file
    # a human edit afterwards does not clear the marker; the answer says the timeline moved on
    p = json.loads((d / "project.json").read_text())
    p["tracks"][0]["items"][0]["volume"] = 0.8
    (d / "project.json").write_text(json.dumps(p, indent=2))
    again, _ = run(d, monkeypatch=monkeypatch)
    assert again["mode"] == "already-cut" and again["changedSince"] is True


def test_recut_plans_again(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    plan_and_apply(d, monkeypatch)
    plan, applied = plan_and_apply(d, monkeypatch, "--recut")
    assert plan["mode"] == "plan" and plan["removed"]["lines"] == {}    # one take of each line already
    assert applied["mode"] == "applied" and phrases(d) == KEPT


def test_a_run_that_finds_the_project_cut_after_transcribing_does_nothing(tmp_path, stub_transcribe, monkeypatch):
    """Two runs at once: the second re-reads after its transcription and finds the first's marker."""
    calls = stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    real = cc.transcribe_file

    def transcribe_while_another_run_cuts(*a, **k):
        r = real(*a, **k)
        p = json.loads((d / "project.json").read_text())
        p["cleanCut"] = {"at": "2026-10-24T00:00:00Z", "kept": {"seconds": 1.0}, "removed": {}, "duration": 1.0}
        (d / "project.json").write_text(json.dumps(p, indent=2))
        return r
    monkeypatch.setattr(cc, "transcribe_file", transcribe_while_another_run_cuts)
    out, _ = run(d, monkeypatch=monkeypatch)
    assert out["mode"] == "already-cut" and calls and not (d / "cut-plan.md").exists()


# ── no usable speech ────────────────────────────────────────────────────────

def test_no_speech_plans_and_applies_silence_removal(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe({**retake_transcript(), "transcription": []})
    d = make_project(tmp_path)
    expected = cc.waveform_trim.process_one(str(d / "speech.mp4"), -30.0, 0.3)["keeps"]
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["mode"] == "plan" and plan["silence"] is True and "silences only" in plan["note"]
    assert json.loads((d / "project.json").read_text())["tracks"][0]["items"][0]["end"] == 0.0
    unsaved = touch_unsaved(d)
    commits = int(git(d, "rev-list", "--count", "HEAD"))
    out, _ = run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert out["mode"] == "applied" and out["version"] == "version: before cut"
    project = json.loads((d / "project.json").read_text())
    assert [[it["inPoint"], it["outPoint"]] for it in project["tracks"][0]["items"]] == \
        [[round(s, 6), round(e, 6)] for s, e in expected if e - s >= 0.05]
    assert int(git(d, "rev-list", "--count", "HEAD")) == commits + 1
    assert git(d, "show", "HEAD:project.json") == unsaved
    assert project["cleanCut"]["mode"] == "silence"
    again, _ = run(d, monkeypatch=monkeypatch)
    assert again["mode"] == "already-cut"


def test_a_silence_plan_with_nothing_to_cut_writes_nothing(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe({**retake_transcript(), "transcription": []})
    d = make_project(tmp_path)
    monkeypatch.setattr(cc.waveform_trim, "process_one",
                        lambda src, thr, ms: {"input": src, "keeps": [[0.0, SOURCE_S]]})
    plan, _ = run(d, monkeypatch=monkeypatch)
    unsaved = touch_unsaved(d)
    commits = git(d, "rev-list", "--count", "HEAD")
    out, _ = run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert out["version"] is None and "Nothing to cut." in out["warnings"]
    assert (d / "project.json").read_text() == unsaved
    assert git(d, "rev-list", "--count", "HEAD") == commits


def test_a_silence_cut_after_a_failed_transcription_leaves_no_marker(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(None, fail="transcription_timeout")
    d = make_project(tmp_path)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["silence"] is True and "failed" in plan["note"] and plan["transcribed"] == []
    assert any("transcription failed" in w for w in plan["warnings"])
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    project = json.loads((d / "project.json").read_text())
    assert "cleanCut" not in project and len(project["tracks"][0]["items"]) > 1


def test_a_waveform_failure_is_reported(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe({**retake_transcript(), "transcription": []})
    d = make_project(tmp_path)
    monkeypatch.setattr(cc.waveform_trim, "process_one", lambda *a: cc.fail("no_speech", "No speech detected"))
    out, _ = run(d, monkeypatch=monkeypatch)
    assert any("no silence cut on clip-0" in w for w in out["warnings"])


def test_no_whisper_model_fails_as_transcribe_does(tmp_path, stub_transcribe, monkeypatch, capsys):
    stub_transcribe(None, fail="whisper_model_missing")
    d = make_project(tmp_path)
    before = (d / "project.json").read_bytes()
    assert refused(d, monkeypatch=monkeypatch, capsys=capsys) == "whisper_model_missing"
    assert (d / "project.json").read_bytes() == before


# ── languages ───────────────────────────────────────────────────────────────

def test_a_language_written_without_spaces_cuts_only_silences_and_fillers(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    out, _ = run(d, "--language", "ja", monkeypatch=monkeypatch)
    assert out["removed"]["lines"] == {}
    assert any("not chosen for ja" in w for w in out["warnings"])
    assert "language ja" in (d / "cut-plan.md").read_text()


@pytest.mark.parametrize("bad", ["../x", "en us", "english-language-long", "e", "en-"])
def test_a_malformed_language_is_refused_before_anything_is_written(tmp_path, stub_transcribe, monkeypatch, capsys, bad):
    d = make_project(tmp_path, transcript=retake_transcript())
    before = (d / "project.json").read_bytes()
    assert refused(d, "--language", bad, monkeypatch=monkeypatch, capsys=capsys) == "invalid_params"
    assert (d / "project.json").read_bytes() == before and not (d / "cut-plan.md").exists()


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
    out, _ = run(d, monkeypatch=monkeypatch)
    assert calls == []
    assert any("project.json" in w for w in out["warnings"])
    assert json.loads((d / "project.json").read_text())["tracks"][0]["items"][0]["id"] == "clip-0"


def test_a_users_own_files_beside_the_clip_are_never_overwritten(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    (d / "speech.srt").write_text("my own subtitles\n")
    run(d, monkeypatch=monkeypatch)
    assert (d / "speech.srt").read_text() == "my own subtitles\n"     # the .srt is never written
    assert "transcription" in json.loads((d / "speech.json").read_text())


def test_an_existing_json_that_is_not_a_transcript_is_left_alone(tmp_path, stub_transcribe, monkeypatch):
    calls = stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    (d / "speech.json").write_text('{"mine": true}')
    out, _ = run(d, monkeypatch=monkeypatch)
    assert calls == [] and (d / "speech.json").read_text() == '{"mine": true}'
    assert any("not a transcript" in w for w in out["warnings"])


def test_a_clip_in_a_hidden_folder_outside_the_project_is_not_transcribed(tmp_path, stub_transcribe, monkeypatch):
    calls = stub_transcribe(retake_transcript())
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path / "ws"))
    hidden = tmp_path / ".private" / "speech.mp4"
    d = _project_with_clip(tmp_path / "c", hidden)
    out, _ = run(d, monkeypatch=monkeypatch)
    assert calls == [] and not (hidden.parent / "speech.json").exists()
    assert any("not a place" in w for w in out["warnings"])


def test_two_clips_sharing_a_transcript_name_fail(tmp_path, stub_transcribe, monkeypatch, capsys):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    shutil.copy(FIX / "speech.mp4", d / "speech.mov")
    p = json.loads((d / "project.json").read_text())
    p["tracks"][0]["items"].append({**p["tracks"][0]["items"][0], "id": "clip-1", "src": str(d / "speech.mov")})
    (d / "project.json").write_text(json.dumps(p, indent=2))
    assert refused(d, monkeypatch=monkeypatch, capsys=capsys) == "transcript_name_clash"
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


def test_overlays_notes_and_captions_follow_the_kept_speech(tmp_path, stub_transcribe, monkeypatch):
    d, words = _layered_project(tmp_path)
    plan_and_apply(d, monkeypatch)
    after = json.loads((d / "project.json").read_text())
    items = after["tracks"][0]["items"]
    overlays = {it["id"]: it for t in after["tracks"] if t["id"] == "trk-ov" for it in t["items"]}
    notes = {n["id"]: n for n in after.get("notes") or []}
    played = 0
    for i, w in enumerate(words):
        if _new_time(items, (w["offsets"]["from"] + w["offsets"]["to"]) / 2000) is None:
            continue
        played += 1
        start = _new_time(items, w["offsets"]["from"] / 1000)
        if start is not None:          # the word's own start plays: its overlay and note sit there now
            assert overlays[f"ov-{i}"]["start"] == pytest.approx(start, abs=0.01), (i, w["text"])
            assert notes[f"n{i}"]["t"] == pytest.approx(start, abs=0.01), (i, w["text"])
    assert played >= len(" ".join(KEPT).split()) - 2
    starts = [overlays[k]["start"] for k in sorted(overlays, key=lambda k: int(k.split("-")[1]))]
    assert len(set(round(x, 3) for x in starts)) >= played - 2
    cap_words = [x["word"] for seg in after["captions"]["segments"] for x in seg.get("words", [])]
    assert cap_words == " ".join(KEPT).split()


# ── end to end: what must never be cut ──────────────────────────────────────

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
    plan, _ = plan_and_apply(d, monkeypatch)
    assert plan["removed"]["lines"] == {}
    assert phrases(d) == sentences


# ── serve ───────────────────────────────────────────────────────────────────

def test_serve_plans_and_applies_on_a_project_id(tmp_path, monkeypatch):
    """Through POST /api/steps/cut (a subprocess: the clip already has its transcript, nothing runs whisper)."""
    from starlette.testclient import TestClient
    import serve.server
    ws = tmp_path / "Montaj"
    ws.mkdir()
    d = make_project(ws, transcript=retake_transcript())
    before = (d / "project.json").read_bytes()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    monkeypatch.setattr(serve.server, "HEADLESS", True)
    with TestClient(serve.server.app, raise_server_exceptions=False) as client:
        plan = client.post("/api/steps/cut", json={"project": "cut-fixture"})
        assert plan.status_code == 200, plan.text
        assert (d / "project.json").read_bytes() == before
        applied = client.post("/api/steps/cut", json={"project": "cut-fixture", "plan": plan.json()["plan"]})
    assert applied.status_code == 200, applied.text
    assert applied.json()["mode"] == "applied" and phrases(d) == KEPT


def test_no_network_or_connector_is_reachable():
    src = (REPO_ROOT / "steps" / "edit" / "cut.py").read_text()
    for name in ("connectors", "credentials", "requests", "urllib", "http"):
        assert f"import {name}" not in src and f"from {name}" not in src


def test_a_partly_kept_row_is_listed_whole_and_marked(tmp_path):
    """A kept take's row that loses some words (a restart) is listed whole under ## Unused, marked *."""
    from lib.take_select import Unit, select
    from lib.speech_lines import Word
    words = "Start by p- start by picking the clip you want.".split()     # a cut-off word: a sure restart
    ws = [Word(i, w, w.lower().strip(",."), i * 0.5, i * 0.5 + 0.4) for i, w in enumerate(words)]
    row = speech_text.Row("speech", line="A1", words=ws, pauses={}, item_ids=["it"])
    units = [(Unit(words), [(0, row)], [])]
    sel = select([u for u, _, _ in units], cc._filler_test("en"))
    d = type("D", (), {"unused": [], "partly": set(), "letters": {}})()
    monkey_render = speech_text.render
    try:
        speech_text.render = lambda *a, **k: "<!-- montaj speech text v1 · track t · stamp s -->\n# x\n\n## Cut\n"
        text, kept, removed, suggested = cc._plan(d, "x", units, [], sel, lambda i, s: s, lambda src, s: s, "en",
                                                  0.45, str(tmp_path), cc._filler_test("en"))
    finally:
        speech_text.render = monkey_render
    cut, unused = sections(text)
    assert cut == ["A1 start by picking the clip you want. [0.0]"]
    assert unused == ["*A1 Start by p- start by picking the clip you want. [0.0 restart]"]
    assert removed == [("A1", 0.0, "Start by p-", "restart")]


# ── re-review: suggestions, layers, the plan file, b-roll ───────────────────

def _scripted(sentences):
    script = " ".join(sentences).split()
    real = json.loads((FIX / "speech.json").read_text())
    words = [w for w in real["transcription"] if w["text"].strip()]
    assert len(words) == len(script)
    return {**real, "transcription": [{**w, "text": " " + t} for w, t in zip(words, script)]}


def test_an_uncertain_retake_stays_kept_and_is_offered(tmp_path, stub_transcribe, monkeypatch):
    sentences = ["I love this app.", "I really love this app.", "You can cut your clips in one click.",
                 "The best part is the price.", "The best part is the speed.", "This is the way we do it.",
                 "Never, never, never give up today.", "Thanks so much for watching this video.", "See you soon."]
    stub_transcribe(_scripted(sentences))
    d = make_project(tmp_path)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["lines"] == {} and plan["suggested"]["retake?"] >= 1
    assert "I love this app. [retake?]" in plan["cut"]
    cut, unused = sections((d / "cut-plan.md").read_text())
    assert unused and all(r.endswith("?]") for r in unused)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert phrases(d) == sentences                       # nothing uncertain was cut
    assert json.loads((d / "project.json").read_text())["cleanCut"]["removed"]["lines"] == {}


def test_taking_a_suggestion_is_deleting_its_row(tmp_path, stub_transcribe, monkeypatch):
    sentences = ["I love this app.", "I really love this app.", "You can cut your clips in one click.",
                 "The best part is the price.", "The best part is the speed.", "This is the way we do it.",
                 "Never, never, never give up today.", "Thanks so much for watching this video.", "See you soon."]
    stub_transcribe(_scripted(sentences))
    d = make_project(tmp_path)
    run(d, monkeypatch=monkeypatch)
    lines = (d / "cut-plan.md").read_text().splitlines()
    cut_at, unused_at = lines.index("## Cut"), lines.index("## Unused")
    lines = [ln for i, ln in enumerate(lines) if not (cut_at < i < unused_at and "I love this app." in ln)]
    (d / "cut-plan.md").write_text("\n".join(lines) + "\n")
    run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    assert phrases(d) == sentences[1:]


def test_both_answers_say_what_happens_to_the_other_layers(tmp_path, stub_transcribe, monkeypatch):
    d, _ = _layered_project(tmp_path)
    plan, applied = plan_and_apply(d, monkeypatch)
    assert plan["layers"].get("overlay_removed", 0) > 0
    assert applied["layers"] == plan["layers"]


def test_a_new_plan_keeps_an_edited_one(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    run(d, monkeypatch=monkeypatch)
    edited = (d / "cut-plan.md").read_text().replace("A14 Thanks everyone.", "A14")
    (d / "cut-plan.md").write_text(edited)
    out, _ = run(d, monkeypatch=monkeypatch)
    assert (d / "cut-plan.prev.md").read_text() == edited
    assert out["previous"] == str(d / "cut-plan.prev.md")
    again, _ = run(d, monkeypatch=monkeypatch)          # the same plan again: nothing to keep
    assert "previous" not in again and (d / "cut-plan.prev.md").read_text() == edited


def test_the_plan_never_writes_through_a_link(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    target = tmp_path / "outside.md"
    target.write_text("keep me\n")
    (d / "cut-plan.md").symlink_to(target)
    run(d, monkeypatch=monkeypatch)
    assert target.read_text() == "keep me\n"
    assert not (d / "cut-plan.md").is_symlink() and (d / "cut-plan.md").read_text().startswith("<!--")


def test_a_clip_that_is_not_speech_is_kept_whole(tmp_path, stub_transcribe, monkeypatch):
    real = json.loads((FIX / "speech.json").read_text())
    w = [x for x in real["transcription"] if x["text"].strip()][:2]
    stub_transcribe({**real, "transcription": [{**w[0], "text": " Thank"}, {**w[1], "text": " you."}]})
    d = make_project(tmp_path)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert any("do not look like speech" in x for x in plan["warnings"])
    assert plan["kept"]["seconds"] == pytest.approx(SOURCE_S, abs=0.05)


# ── pass 3: b-roll, the plan file, a recut, the next step ────────────────────

def synthetic(spec, start=0.2, word=0.3, gap=0.08, end_gap=0.7, lang="en"):
    """A transcript of `spec` on the fixture media with even word times; sentences end with . ? !"""
    real = json.loads((FIX / "speech.json").read_text())
    out, t = [], start
    for tok in spec.split():
        out.append({"timestamps": {"from": "", "to": ""}, "offsets": {"from": int(t * 1000), "to": int((t + word) * 1000)},
                    "text": " " + tok})
        t += word + (end_gap if tok.rstrip("\"'").endswith((".", "?", "!")) else gap)
    assert t < SOURCE_S
    return {**real, "result": {"language": lang}, "transcription": out}


def clips_project(tmp_path, clips):
    """A fresh project of several clips of the fixture media, each [(name, transcript)], its own git repo."""
    d = tmp_path / "proj"
    d.mkdir()
    base = json.loads((FIX / "project.json").read_text())
    p = {k: base[k] for k in ("version", "settings", "status", "workflow", "editingPrompt")}
    items = []
    for n, (name, tr) in enumerate(clips):
        shutil.copy(FIX / "speech.mp4", d / f"{name}.mp4")
        (d / f"{name}.json").write_text(json.dumps(tr))
        items.append({"id": f"clip-{n}", "type": "video", "src": str(d / f"{name}.mp4"), "start": 0.0, "end": 0.0,
                      "sourceDuration": SOURCE_S, "sourceWidth": 64, "sourceHeight": 64})
    p.update({"id": "cut-fixture", "name": "Cut", "tracks": [{"id": "trk-0", "items": items}]})
    (d / "project.json").write_text(json.dumps(p, indent=2))
    git(d, "init", "-q")
    git(d, "add", "project.json")
    git(d, "commit", "-q", "-m", "init")
    return d


SPEECH = ("Hey everyone, welcome back. Today we're making pasta from scratch. "
          "It only takes twenty minutes. Thanks for watching!")


@pytest.mark.parametrize("order", ["after", "before"])
def test_b_roll_words_never_take_part(tmp_path, monkeypatch, order):
    """B1: the made-up line on b-roll is not a retake of the speaker's, and the b-roll is not cut."""
    clips = [("speech", synthetic(SPEECH)), ("broll", synthetic("Thanks for watching!", start=12.0))]
    d = clips_project(tmp_path, clips if order == "after" else clips[::-1])
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["lines"] == {} and "suggested" not in plan
    assert any("do not look like speech" in w for w in plan["warnings"])
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    items = json.loads((d / "project.json").read_text())["tracks"][0]["items"]
    broll = [it for it in items if it["src"].endswith("broll.mp4")]
    assert len(broll) == 1 and broll[0]["outPoint"] - broll[0]["inPoint"] == pytest.approx(SOURCE_S, abs=0.05)
    assert "Thanks for watching!" in " ".join(phrases(d))
    speech_first = order == "after"
    assert items[0]["src"].endswith("speech.mp4") == speech_first      # nothing moved across the b-roll


def test_a_short_real_line_is_still_cut(tmp_path, stub_transcribe, monkeypatch):
    """Six real words, then the camera left running: dense enough to be speech, so the rest is cut."""
    stub_transcribe(synthetic("Hey everyone, today we cook pasta."))
    d = make_project(tmp_path)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert not any("do not look like speech" in w for w in plan.get("warnings", []))
    assert plan["kept"]["seconds"] < 10


def test_an_unedited_plan_is_replaced_and_every_edit_is_kept(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    run(d, monkeypatch=monkeypatch)
    again, _ = run(d, "--max-pause", "0.6", monkeypatch=monkeypatch)     # nobody edited it: no backup
    assert "previous" not in again and not (d / "cut-plan.prev.md").exists()
    edit1 = (d / "cut-plan.md").read_text().replace("A14 Thanks everyone.", "A14")
    (d / "cut-plan.md").write_text(edit1)
    out, _ = run(d, monkeypatch=monkeypatch)
    assert out["previous"] == str(d / "cut-plan.prev.md") and (d / "cut-plan.prev.md").read_text() == edit1
    out, _ = run(d, "--max-pause", "0.3", monkeypatch=monkeypatch)       # the new plan is unedited: replaced
    assert "previous" not in out and (d / "cut-plan.prev.md").read_text() == edit1
    edit2 = (d / "cut-plan.md").read_text().replace("A14 Thanks everyone.", "A14")
    (d / "cut-plan.md").write_text(edit2)
    out, _ = run(d, monkeypatch=monkeypatch)                             # a second edit: its own file
    assert out["previous"].startswith(str(d / "cut-plan.prev-")) and Path(out["previous"]).read_text() == edit2
    assert (d / "cut-plan.prev.md").read_text() == edit1


def test_already_applied_needs_the_same_plan_not_only_the_same_stamp(tmp_path, stub_transcribe, monkeypatch, capsys):
    d = make_project(tmp_path, transcript=retake_transcript())
    plan, _ = run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    stamp = speech_text.parse(cc._untagged(text)[0])[0]["stamp"]
    p = json.loads((d / "project.json").read_text())
    p["cleanCut"] = {"planStamp": stamp, "planHash": "000000000000"}   # a cut from another plan of the same base
    (d / "project.json").write_text(json.dumps(p, indent=2))
    out, _ = run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert out["mode"] == "applied"
    p = json.loads((d / "project.json").read_text())
    p["cleanCut"].update(planStamp=stamp, planHash=cc._plan_hash(text))
    (d / "project.json").write_text(json.dumps(p, indent=2))
    assert refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "already_applied"


def test_next_says_how_to_take_a_suggestion(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    out, _ = run(d, monkeypatch=monkeypatch)
    assert "To take a ? suggestion: delete a retake? or false-start? row from ## Cut" in out["next"]
    (tmp_path / "s").mkdir()
    silent = clips_project(tmp_path / "s", [("speech", {**retake_transcript(), "transcription": []})])
    out, _ = run(silent, monkeypatch=monkeypatch)
    assert out["next"] == f'Apply: cut with plan "{silent / "cut-plan.md"}".'


# ── made-up words: real whisper output on music and sound effects (pass 5) ───

CAPTURES = json.loads((REPO_ROOT / "tests" / "fixtures" / "whisper_no_speech_captures.json").read_text())


def captured(name):
    real = json.loads((FIX / "speech.json").read_text())
    return {**real, **CAPTURES[name]}


@pytest.mark.parametrize("broll, outro", [("h2", "Thank you so much for joining us."),
                                          ("h3", "I'll see you next time.")])
@pytest.mark.parametrize("order", ["after", "before"])
def test_a_real_line_is_never_removed_for_a_made_up_copy_on_b_roll(tmp_path, monkeypatch, broll, outro, order):
    """Whisper over music or sound effects writes a line with no gaps that fills the clip: words of median length
    4 s and more, or zero length. That clip is b-roll, kept whole; the speaker's own line stays."""
    speech = "Hey everyone, welcome back. Today we're making pasta from scratch. "
    speech = speech + outro if order == "after" else outro + " " + speech
    clips = [("speech", synthetic(speech)), ("broll", captured(broll))]
    d = clips_project(tmp_path, clips if order == "after" else clips[::-1])
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["lines"] == {} and any("do not look like speech" in w for w in plan["warnings"])
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    items = json.loads((d / "project.json").read_text())["tracks"][0]["items"]
    speech_items = [it for it in items if it["src"].endswith("speech.mp4")]
    broll_items = [it for it in items if it["src"].endswith("broll.mp4")]
    said = " ".join(phrases(d))
    assert outro.split()[0] in said and speech_items
    # kept whole means the whole window (review: it lost its last 2.5 s)
    assert len(broll_items) == 1
    assert (broll_items[0]["inPoint"], broll_items[0]["outPoint"]) == (0.0, pytest.approx(SOURCE_S, abs=0.01))


@pytest.mark.parametrize("name", ["h1", "h2", "h3", "h4", "h6"])
def test_whisper_on_music_and_sound_effects_is_made_up(name):
    words = [{"text": w["text"].strip(), "start": w["offsets"]["from"] / 1000, "end": w["offsets"]["to"] / 1000}
             for w in CAPTURES[name]["transcription"] if w["text"].strip()]
    assert cc._made_up(words)


def test_a_real_line_with_a_noise_tail_is_cut_to_the_line(tmp_path, monkeypatch):
    """d_line_noisy: a real 2.4 s line, then 28 s of noise whisper heard as "." at the end."""
    d = clips_project(tmp_path, [("speech", captured("d_line_noisy"))])
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["kept"]["seconds"] < 4
    assert not any("do not look like speech" in w for w in plan.get("warnings", []))


def test_made_up_words_on_a_quiet_end_are_dropped_as_a_pause():
    """c_line_quiet: a real line, then "Thank you." at 30 s, inside the measured silence of a quiet room."""
    from lib.take_select import Unit
    from lib.speech_lines import Word
    line = [Word(i, t, t.lower(), i * 0.4, i * 0.4 + 0.35) for i, t in enumerate("results of what they".split())]
    tail = [Word(4, "Thank", "thank", 30.0, 30.52), Word(5, "you.", "you", 30.52, 31.0)]
    rows = lambda ws: [(0, speech_text.Row("speech", line="A1", words=ws, pauses={}, item_ids=["i"]))]
    units = [(Unit([w.text for w in line], clip="A"), rows(line), []), (Unit([w.text for w in tail], clip="A"), rows(tail), [])]
    cc._mark_made_up_tails(units, inside={("A", 4), ("A", 5)})
    assert [u.madeup for u, _, _ in units] == [False, True]
    cc._mark_made_up_tails(units[:1] + [(Unit(["Thank", "you."], clip="A"), rows(tail), [])], inside=set())
    from lib.take_select import select
    sel = select([u for u, _, _ in units], cc._filler_test("en"))
    assert sel.losers == [1] and sel.why[1] == "pause"


# ── pass 4: made-up words that pass for speech ───────────────────────────────

OUTRO = "Thanks for watching and see you next time."


def test_a_clip_that_keeps_almost_nothing_of_itself_is_reported(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(synthetic("Hey everyone, good morning friends."))
    d = make_project(tmp_path)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert any("clip-0 keeps only" in w for w in plan["warnings"])


def test_a_correct_cut_of_a_long_quiet_tail_is_not_reported(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(synthetic("Hey everyone, today we cook pasta from scratch in my kitchen."))
    d = make_project(tmp_path)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert not any("keeps only" in w for w in plan.get("warnings", []))
