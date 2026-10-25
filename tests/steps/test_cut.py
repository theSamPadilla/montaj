"""§558 E2: `cut` plans a talking-head cut (transcribe, the mechanical pass, one take per section) as an
editable cut-plan.md, writing nothing to the project; `cut` with `plan` applies it through speech_edit's save.

Runs the step's main() in process. Transcription is stubbed (`transcribe_file` writes a fixed sidecar): no
model runs, nothing reaches a connector or the network. ffmpeg measures the fixture's real audio.
"""
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import steps.edit.cut as cc  # noqa: E402
from lib import speech_energy, speech_text  # noqa: E402

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
        # the truncated take run into the next sentence stays: only offered. (The pause before "Trim" is in
        # whisper's times only: the audio runs straight on, so since §558's audio-placed edges it is the complete
        # take before it that is offered, a fuzzy repeat (F1), not an abandoned opening.)
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
    project.update({"id": "cut-fixture", "name": "Cut", "status": "pending",   # as project creation leaves it
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
    before = json.loads((d / "project.json").read_text()) if "--plan" in extra else None
    held = {}
    if before is not None:
        from lib import speech_energy as _se
        real_hold = _se.Refiner.hold

        def hold(self, key, n):
            s0, s1 = self.layers[key].silences[n]
            held.setdefault(os.path.basename(key), []).append((s0, s1))
            return real_hold(self, key, n)
        monkeypatch.setattr(_se.Refiner, "hold", hold)
    monkeypatch.setattr(sys, "argv", ["cut.py", "--project", str(d / "project.json"), *extra])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        cc.main()
    raw = out.getvalue()
    assert raw.count("\n") <= 1, "one JSON object on stdout, nothing else"
    answer = json.loads(raw)
    if before is not None:
        applied_checks(d, before, answer, extra, held)
    return answer, raw


def applied_checks(d, before, answer, extra=(), held=None):
    """§558 cut v5: tests/cut_checks.py on every applied speech cut (flat runs on the joined timeline, the video's
    lead and tail, wordless pieces, audio tracks). The silences the apply kept whole for an overlay (D2, `held`) are
    reported apart, never a failure; nothing else is exempt. Left out: a silence-only plan (waveform_trim's own
    absolute threshold, not layer 1), a cut with a clip kept whole (b-roll), a max-pause other than the default, and
    an applied project whose speech items do not all come from transcribed media."""
    from tests import cut_checks
    if answer.get("mode") != "applied" or "--max-pause" in extra:
        return
    text = (d / "cut-plan.md").read_text() if (d / "cut-plan.md").is_file() else ""
    p = json.loads((d / "project.json").read_text())
    items = [it for it in p["tracks"][0]["items"] if it.get("type") in (None, "video", "audio")]
    if not text or " · silence · " in text.splitlines()[0] or not items or any(
            not (d / (Path(it["src"]).stem + ".json")).is_file() for it in items):
        return
    if any(w.startswith("kept ") and " whole" in w for w in answer.get("warnings", [])):
        return
    fails = cut_checks.check(d, before, (), (answer,), held=held)
    if os.environ.get("V5_CHECK_LOG"):
        with open(os.environ["V5_CHECK_LOG"], "a") as f:
            f.write(f"{os.environ.get('PYTEST_CURRENT_TEST', '').split(' ')[0]} {sorted(fails)} "
                    f"held={len(cut_checks.exempt_report(d, held=held)['held'])}\n")
    fails.pop("islands", None)          # the plan answer's warnings are not passed here: checked by the tests
    assert not fails, (fails, [(it["inPoint"], it["outPoint"]) for it in items], text.split("## Cut")[-1])


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


def as_cut_reads(project, d):
    """The timeline's speech as cut reads it: words placed by the audio (lib/speech_energy), so a word whisper put
    in a pause is read where cut folded it, beside the word that holds its sound."""
    return speech_text.derive(project, str(d), "trk-0", refiner=speech_energy.Refiner())


def phrases(d):
    """The speech now on the timeline, one sentence per kept take."""
    project = json.loads((d / "project.json").read_text())
    der = as_cut_reads(project, d)
    words = [w.text for r in der.cut if r.kind == "speech" for w in r.words]
    out, cur = [], []
    for w in words:
        cur.append(w)
        if w.endswith((".", "?", "!")):
            out.append(" ".join(cur))
            cur = []
    return out + ([" ".join(cur)] if cur else [])


def emptied(text, words):
    """The plan with the ## Cut row that says `words` (pause markers aside) emptied to its line id: deleted."""
    out = []
    for ln in text.splitlines():
        m = re.match(r"^(\*?[A-Z]+\d+) (.*?)( \[[^\]]*\])?$", ln)
        if m and " ".join(t for t in m.group(2).split() if not t.startswith("{")) == words:
            ln = m.group(1)
        out.append(ln)
    return "\n".join(out) + "\n"


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
    assert {"plan", "language", "max-pause", "breath", "recut", "detail", "model"} == set(names) - {"project"}
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
    offered = [g for g in groups if any((m := cc._TAG.search(r)) and m.group(3) for r in g.splitlines())]
    assert sum(out["removed"]["lines"].values()) == len(groups) - len(offered)    # one group per take
    assert out["removed"]["lines"] == {"retake": 2, "false-start": 1}
    # F1 offers the earlier take (see KEPT); v5: "timeline." (whisper put it in the silence after "the", which holds
    # its sound) is folded, kept and offered inaudible?
    assert out["suggested"] == {"retake?": 1, "inaudible?": 1}
    assert out["removed"]["fillers"] == 1 and out["removed"]["seconds"] > 0
    assert out["removed"]["seconds"] == pytest.approx(SOURCE_S - out["kept"]["seconds"], abs=0.02)
    lines = out["cut"].splitlines()
    assert all(ln.rsplit(" [", 1)[1].rstrip("]").split()[0].rstrip("?") in cc.WHYS for ln in lines)
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
        {"retake", "false-start", "retake?", "inaudible?"}


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
    # the plan records it for the apply (the plan previews once per settle round)
    assert {k["max_pause"] for k in seen} == {0.3} and len(seen) >= 2
    assert all(k["preview"] for k in seen[:-1]) and seen[-1]["preview"] is False and seen[-1]["base"] is not None


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
        a, b = w["offsets"]["from"] / 1000, w["offsets"]["to"] / 1000
        # some of the word's span plays (its middle may be dead air the cut removed, inside whisper's long span)
        if all(_new_time(items, a + (b - a) * k / 20) is None for k in range(21)):
            continue
        played += 1
        start = _new_time(items, w["offsets"]["from"] / 1000)
        if start is not None:          # the word's own start plays: its overlay and note sit there now
            assert overlays[f"ov-{i}"]["start"] == pytest.approx(start, abs=0.01), (i, w["text"])
            assert notes[f"n{i}"]["t"] == pytest.approx(start, abs=0.01), (i, w["text"])
    assert played >= len(" ".join(KEPT).split()) - 2
    starts = [overlays[k]["start"] for k in sorted(overlays, key=lambda k: int(k.split("-")[1]))]
    # an overlay whose own start was dead air the cut removed moves to the next kept moment, so a few share a start
    assert len(set(round(x, 3) for x in starts)) >= played - 6
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
    assert "I love this app. [retake? A2 " in plan["cut"]          # the offer names the other take's line
    cut, unused = sections((d / "cut-plan.md").read_text())
    assert unused and all(cc._TAG.search(r).group(3) for r in unused)          # every one only offered
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
    edited = emptied((d / "cut-plan.md").read_text(), "Thanks everyone.")
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
    p.update({"id": "cut-fixture", "name": "Cut", "status": "pending", "tracks": [{"id": "trk-0", "items": items}]})
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
    edit1 = emptied((d / "cut-plan.md").read_text(), "Thanks everyone.")
    (d / "cut-plan.md").write_text(edit1)
    out, _ = run(d, monkeypatch=monkeypatch)
    assert out["previous"] == str(d / "cut-plan.prev.md") and (d / "cut-plan.prev.md").read_text() == edit1
    out, _ = run(d, "--max-pause", "0.3", monkeypatch=monkeypatch)       # the new plan is unedited: replaced
    assert "previous" not in out and (d / "cut-plan.prev.md").read_text() == edit1
    edit2 = emptied((d / "cut-plan.md").read_text(), "Thanks everyone.")
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


def _set_track(d, items=None, status=None):
    p = json.loads((d / "project.json").read_text())
    if items is not None:
        p["tracks"][0]["items"] = items
    if status:
        p["status"] = status
    (d / "project.json").write_text(json.dumps(p, indent=2))


def _items(d):
    return json.loads((d / "project.json").read_text())["tracks"][0]["items"]


def _error(d, *extra, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["cut.py", "--project", str(d / "project.json"), *extra])
    with pytest.raises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
        cc.main()
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


def test_apply_after_the_timeline_was_emptied_says_so(tmp_path, stub_transcribe, monkeypatch, capsys):
    d = make_project(tmp_path, transcript=retake_transcript())
    _set_track(d, status="pending")
    plan, _ = run(d, monkeypatch=monkeypatch)          # planned on the pending placeholder
    _set_track(d, [], status="draft")                  # "Edit it yourself" drops it
    before = (d / "project.json").read_bytes()
    e = _error(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys)
    assert e["error"] == "stale_plan"
    assert e["message"] == ("This plan was made before cut was updated, or the timeline changed. Run cut again "
                            "(your edited plan is kept). "
                            "There are no clips on the timeline now; place clips first.")
    assert (d / "project.json").read_bytes() == before


def test_a_stale_plan_with_clips_has_no_clips_line(tmp_path, stub_transcribe, monkeypatch, capsys):
    d = make_project(tmp_path, transcript=retake_transcript())
    plan, _ = run(d, monkeypatch=monkeypatch)
    tr = retake_transcript()
    tr["transcription"][-1]["text"] = " everybody."
    (d / "speech.json").write_text(json.dumps(tr))
    e = _error(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys)
    assert e["error"] == "stale_plan"
    assert e["message"] == ("This plan was made before cut was updated, or the timeline changed. Run cut again "
                            "(your edited plan is kept).")


def test_cut_on_a_draft_with_an_empty_timeline_is_refused(tmp_path, stub_transcribe, monkeypatch, capsys):
    d = make_project(tmp_path, transcript=retake_transcript())
    _set_track(d, [], status="draft")
    before = (d / "project.json").read_bytes()
    e = _error(d, monkeypatch=monkeypatch, capsys=capsys)
    assert e["error"] == "no_clips"
    assert e["message"] == ("No clips on the timeline. Place clips first (the footage is in the project's media), "
                            "then run cut.")
    assert (d / "project.json").read_bytes() == before
    assert not (d / "cut-plan.md").exists()


def test_a_draft_with_only_zero_placeholders_is_refused(tmp_path, stub_transcribe, monkeypatch, capsys):
    d = make_project(tmp_path, transcript=retake_transcript())
    _set_track(d, status="draft")
    assert _error(d, monkeypatch=monkeypatch, capsys=capsys)["error"] == "no_clips"


def test_a_pending_project_with_placeholders_still_plans(tmp_path, stub_transcribe, monkeypatch):
    d = make_project(tmp_path, transcript=retake_transcript())
    _set_track(d, status="pending")
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["mode"] == "plan" and (d / "cut-plan.md").exists()


# ── a pending project is started by the apply (same write) ───────────────────

def _status(d):
    return json.loads((d / "project.json").read_text())["status"]


def test_apply_on_a_pending_project_sets_draft_in_the_same_write(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    assert _status(d) == "pending"
    before = json.loads((d / "project.json").read_text())
    touch_unsaved(d)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert _status(d) != "draft"                      # a plan writes nothing
    commits = git(d, "rev-list", "--count", "HEAD").strip()
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    after = json.loads((d / "project.json").read_text())
    assert after["status"] == "draft"
    log = git(d, "log", "--format=%s", "--", "project.json").splitlines()
    print("GIT LOG", log)
    assert log[0] == "version: before cut" and int(commits) + 1 == len(git(d, "rev-list", "HEAD").split())
    # the version holds the project as it was: still pending
    assert json.loads(git(d, "show", "HEAD:project.json"))["status"] == "pending"
    # nothing else moved beyond today's apply
    assert {k for k in after if after[k] != before.get(k)} <= {"status", "name", "tracks", "cleanCut", "captions",
                                                              "audio", "markers", "notes"}


def test_apply_on_a_draft_project_leaves_the_status(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    p = json.loads((d / "project.json").read_text())
    p["status"] = "draft"
    p["tracks"][0]["items"][0]["end"] = SOURCE_S   # a draft counts only a clip with length
    (d / "project.json").write_text(json.dumps(p, indent=2))
    git(d, "commit", "-qam", "draft")
    plan_and_apply(d, monkeypatch)
    assert _status(d) == "draft"


def test_a_plan_on_a_pending_project_leaves_it_pending(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe(retake_transcript())
    d = make_project(tmp_path)
    run(d, monkeypatch=monkeypatch)
    assert _status(d) == "pending"


def test_a_status_the_person_changes_during_a_silence_apply_is_not_overwritten(tmp_path, stub_transcribe, monkeypatch, capsys):
    """cut sets a pending project to draft in its write, so status is guarded: a status the person set meanwhile
    refuses the apply instead of being overwritten with draft."""
    stub_transcribe({"transcription": []})
    d = make_project(tmp_path)
    plan, _ = run(d, monkeypatch=monkeypatch)
    real = cc.commit_version
    human = {}

    def version_then_person_sets_status(*a, **k):
        out = real(*a, **k)
        p = json.loads((d / "project.json").read_text())
        p["status"] = "final"
        (d / "project.json").write_text(json.dumps(p, indent=2))
        human["bytes"] = (d / "project.json").read_bytes()
        return out
    monkeypatch.setattr(cc, "commit_version", version_then_person_sets_status)
    assert refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "project_changed"
    assert (d / "project.json").read_bytes() == human["bytes"]


def test_a_status_the_person_changes_during_a_speech_apply_is_not_overwritten(tmp_path, stub_transcribe, monkeypatch, capsys):
    """The speech path guards status the same way when it starts a pending project."""
    d = make_project(tmp_path, transcript=retake_transcript())
    plan, _ = run(d, monkeypatch=monkeypatch)
    real = cc.select
    human = {}

    def select_then_person_sets_status(*a, **k):
        p = json.loads((d / "project.json").read_text())
        p["status"] = "final"
        (d / "project.json").write_text(json.dumps(p, indent=2))
        human["bytes"] = (d / "project.json").read_bytes()
        return real(*a, **k)
    monkeypatch.setattr(cc, "select", select_then_person_sets_status)
    assert refused(d, "--plan", plan["plan"], monkeypatch=monkeypatch, capsys=capsys) == "project_changed"
    assert (d / "project.json").read_bytes() == human["bytes"]


def test_a_silence_apply_on_a_pending_project_sets_draft_too(tmp_path, stub_transcribe, monkeypatch):
    stub_transcribe({"transcription": []})
    d = make_project(tmp_path)
    plan, applied = plan_and_apply(d, monkeypatch)
    assert plan.get("silence") and _status(d) == "draft"


# ── real-footage shapes, on synthetic audio (§558 field test) ─────────────────
#
# A voiceover with pauses hidden in whisper's words, retakes said inline, and a made-up tail. The audio is made
# here: tones at set levels over a quiet noise floor, so a word's level and every pause are known exactly.

import math as _math  # noqa: E402
import random as _random  # noqa: E402
import wave as _wave  # noqa: E402

RATE = 16000
NOISE_DB = -70.0
SPEECH_DB = -20.0


def tone_media(path, spans, total, rate=RATE):
    """A .mov (64x64 black video, PCM audio, so no codec shifts a time) of `total` seconds: noise at NOISE_DB,
    and a 220 Hz tone at `db` over each (t0, t1, db) of `spans`."""
    rnd = _random.Random(7)
    n = int(total * rate)
    amp = [10 ** (NOISE_DB / 20) * _math.sqrt(3)] * n
    for t0, t1, db in spans:
        for i in range(int(t0 * rate), min(n, int(t1 * rate))):
            amp[i] = 10 ** (db / 20) * _math.sqrt(2)
    frames = bytearray()
    for i in range(n):
        noise = rnd.uniform(-1, 1) * 10 ** (NOISE_DB / 20) * _math.sqrt(3)
        tone = _math.sin(2 * _math.pi * 220 * i / rate) * amp[i] if amp[i] > 10 ** (NOISE_DB / 20) * 2 else 0.0
        v = max(-32767, min(32767, int((tone + noise) * 32767)))
        frames += v.to_bytes(2, "little", signed=True)
    wav = Path(str(path) + ".wav")
    with _wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    subprocess.run([cc.ffmpeg_bin() if hasattr(cc, "ffmpeg_bin") else "ffmpeg", "-v", "error", "-y",
                    "-f", "lavfi", "-i", f"color=c=black:s=64x64:r=30:d={total}", "-i", str(wav),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", str(path)],
                   check=True, capture_output=True)
    wav.unlink()


def gapless(words):
    """A whisper transcript of (text, from, to) words, as whisper writes them (offsets in ms)."""
    real = json.loads((FIX / "speech.json").read_text())
    return {**real, "result": {"language": "en"}, "transcription": [
        {"timestamps": {"from": "", "to": ""}, "offsets": {"from": int(round(a * 1000)), "to": int(round(b * 1000))},
         "text": " " + t} for t, a, b in words]}


def tone_project(tmp_path, clips):
    """A fresh project of clips [(name, spans, total, words)], each its own synthetic media and transcript."""
    d = tmp_path / "proj"
    d.mkdir()
    base = json.loads((FIX / "project.json").read_text())
    p = {k: base[k] for k in ("version", "settings", "status", "workflow", "editingPrompt")}
    items = []
    for n, (name, spans, total, words) in enumerate(clips):
        tone_media(d / f"{name}.mov", spans, total)
        (d / f"{name}.json").write_text(json.dumps(gapless(words)))
        items.append({"id": f"clip-{n}", "type": "video", "src": str(d / f"{name}.mov"), "start": 0.0, "end": 0.0,
                      "sourceDuration": cc.get_duration(str(d / f"{name}.mov")), "sourceWidth": 64, "sourceHeight": 64})
    p.update({"id": "cut-fixture", "name": "Cut", "status": "pending", "tracks": [{"id": "trk-0", "items": items}]})
    (d / "project.json").write_text(json.dumps(p, indent=2))
    git(d, "init", "-q")
    git(d, "add", "project.json")
    git(d, "commit", "-q", "-m", "init")
    return d


def played_words(d):
    """[(text, timeline start, timeline end)] of every word the project plays now, in timeline order."""
    project = json.loads((d / "project.json").read_text())
    der = as_cut_reads(project, d)
    items = {it["id"]: it for it in project["tracks"][0]["items"]}
    out = []
    for r in der.cut:
        if r.kind != "speech":
            continue
        it = items[r.item_ids[0]]
        for w in r.words:
            out.append((w.text, it["start"] + w.start - it["inPoint"], it["start"] + w.end - it["inPoint"]))
    return sorted(out, key=lambda x: x[1])


def test_pauses_beside_a_word_whisper_put_in_silence_are_capped_on_apply(tmp_path, monkeypatch):
    """(a): whisper puts a quiet word inside a pause, which made both gaps beside it "unsure", so the apply kept
    them whole (0.6-0.8 s pauses in a cut capped at 0.45). A gap that is all measured silence hides no word:
    capped like any other, inside a line and between lines."""
    spans = [(0.20, 0.50, SPEECH_DB), (1.95, 2.30, SPEECH_DB), (2.30, 2.60, SPEECH_DB), (3.70, 4.00, SPEECH_DB),
             (4.00, 4.30, SPEECH_DB)]
    words = [("Hello", 0.20, 0.50), ("there", 0.50, 1.40), ("world", 1.40, 2.30), ("again", 2.30, 2.60),
             ("and", 2.60, 3.00), ("once", 3.00, 4.00), ("more.", 4.00, 4.30)]
    # "there" lies wholly in the silence 0.5-1.95 (a gapless whisper word), so the 0.55 s after it is unsure; "and"
    # in 2.6-3.7, so the 0.7 s after it is too, and opens a new line
    d = tone_project(tmp_path, [("vo", spans, 5.0, words)])
    plan, _ = run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    assert "max-pause 0.45" in text
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    said = played_words(d)
    gaps = [b[1] - a[2] for a, b in zip(said, said[1:])]
    assert gaps and max(gaps) <= 0.45 + 0.02, (said, gaps)
    assert {"Hello", "world", "again", "once", "more."} <= {w for w, _, _ in said}    # every audible word plays


def spoken(lines, start=0.3, word=0.25, gap=0.05, line_gap=0.8, db=SPEECH_DB, pause=0.45):
    """Lines said one after another: a tone per word, `gap` between words and `line_gap` of silence between
    lines (whisper's line breaks); a "|" inside a line is a `pause` of silence there that whisper did not break the
    line at. Returns (tone spans, gapless whisper words, end time): whisper's word spans run on to the next word, so
    every pause sits inside a word."""
    spans, words, t = [], [], start
    flat, held = [], set()
    for n, ln in enumerate(lines):
        for tok in ln.split():
            if tok == "|":
                held.add(len(flat))
            else:
                flat.append((tok, n))
    for k, (tok, n) in enumerate(flat):
        spans.append((t, t + word, db))
        nxt = t + word + (line_gap if k + 1 < len(flat) and flat[k + 1][1] != n
                          else pause if k + 1 in held else gap)
        words.append([tok, t, nxt])
        t = nxt
    words[-1][2] = words[-1][1] + word
    return spans, [tuple(w) for w in words], t + word


def spoken_project(tmp_path, *clips, **kw):
    """One clip per list of lines."""
    out = []
    for n, lines in enumerate(clips):
        spans, words, end = spoken(lines, **kw)
        out.append((f"vo{n}", spans, end + 1.0, words))
    return tone_project(tmp_path, out)


def said_text(d):
    return " ".join(w for w, _, _ in played_words(d))


def test_a_five_word_repeat_inside_one_line_is_removed_the_last_kept(tmp_path, monkeypatch):
    d = spoken_project(tmp_path, ["so the frame went past straight | so the frame went past straight and tipped over."])
    plan, _ = run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    cut, unused = sections(text)
    assert re.sub(r" \{[\d.]+\}", "", cut[0]).startswith("A1 so the frame went past straight and tipped over. [")
    # v5: the pause before the second saying is a silence the mechanical pass cut, so the first saying is a row of
    # its own (the line cut there is two rows), removed whole
    assert unused == [next(r for r in unused if re.sub(r" \{[\d.]+\}", "", r).startswith(
        "A1 so the frame went past straight ["))]
    # with the pause before the second saying (D3), select's restart rule takes it before the phrase rule does
    assert unused[0].endswith(" restart]") and plan["removed"]["lines"] == {"restart": 1}
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "so the frame went past straight and tipped over."


def test_a_removed_inline_retake_comes_back_by_putting_its_star_row_in_place(tmp_path, monkeypatch):
    d = spoken_project(tmp_path, ["so the frame went past straight | so the frame went past straight and tipped over."])
    run(d, monkeypatch=monkeypatch)
    lines = (d / "cut-plan.md").read_text().splitlines()
    # v5: the removed saying is a row of its own (the line was cut at the silence before the second saying): moved
    # back into ## Cut, before the row it was cut from
    gone = next(ln for ln in lines[lines.index("## Unused"):] if ln.startswith("A1 "))
    lines = [ln for ln in lines if ln is not gone]
    at = next(i for i, ln in enumerate(lines) if ln.startswith("A1 "))
    lines.insert(at, gone)
    (d / "cut-plan.md").write_text("\n".join(lines) + "\n")
    run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    assert said_text(d) == "so the frame went past straight so the frame went past straight and tipped over."


def test_a_repeat_across_two_lines_is_removed_from_the_first(tmp_path, monkeypatch):
    d = spoken_project(tmp_path, ["you lean right and the whole frame tips", "the whole frame tips and you fall."])
    plan, _ = run(d, monkeypatch=monkeypatch)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "you lean right and the whole frame tips and you fall."


def test_three_repeats_across_lines_keep_only_the_last(tmp_path, monkeypatch):
    # the second saying opens a line, the third follows a pause; whisper broke the second inside it
    d = spoken_project(tmp_path, ["then every wobble made the next one bigger", "then every wobble made", "the next one",
                                  "bigger | then every wobble made the next one bigger so we stop."])
    plan, _ = run(d, monkeypatch=monkeypatch)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "then every wobble made the next one bigger so we stop."


def test_a_four_word_repeat_is_a_suggestion_only(tmp_path, monkeypatch):
    line = "we lean to the left we lean to the right today."
    d = spoken_project(tmp_path, [line])
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["lines"] == {} and plan.get("suggested")
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == line


def test_a_near_repeat_is_a_suggestion_only(tmp_path, monkeypatch):
    lines = ["you turned the front bars too far", "you turned the bars too far and fell."]
    d = spoken_project(tmp_path, lines)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["lines"] == {} and plan.get("suggested")
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == " ".join(lines)


def test_a_false_start_with_five_same_opening_words_is_removed(tmp_path, monkeypatch):
    # the speaker stops after the false start, mumbles a word, then starts again
    d = spoken_project(tmp_path, ["the one rule you should", "here", "the one rule you should know is this."])
    plan, _ = run(d, monkeypatch=monkeypatch)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "the one rule you should know is this."


def test_a_line_said_again_in_the_next_clip_is_removed_from_the_first(tmp_path, monkeypatch):
    d = spoken_project(tmp_path, ["Hello there friends.", "we built a robot that rides a bike"],
                       ["so we built a robot that rides a bike and it learns."])
    plan, _ = run(d, monkeypatch=monkeypatch)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "Hello there friends. so we built a robot that rides a bike and it learns."


def test_a_four_word_repeat_across_clips_is_a_suggestion_only(tmp_path, monkeypatch):
    d = spoken_project(tmp_path, ["Hello there friends.", "the robot rides fast"], ["so the robot rides fast today."])
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["lines"] == {} and plan.get("suggested")


def test_a_line_said_in_three_clips_keeps_only_the_last_copy(tmp_path, monkeypatch):
    d = spoken_project(tmp_path, ["Hello there friends.", "the robot learns by falling down"],
                       ["the robot learns by falling down"], ["the robot learns by falling down a lot."])
    plan, _ = run(d, monkeypatch=monkeypatch)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "Hello there friends. the robot learns by falling down a lot."


def _tail_project(tmp_path, tail, audible):
    """A real line, then `tail` glued onto its end by whisper: its words fill the rest of the clip (gapless), over
    silence unless `audible`."""
    spans, words, end = spoken(["you learn it by doing it again and again"])
    t, dur = end + 0.05, 0.25
    words = list(words)
    words[-1] = (words[-1][0], words[-1][1], t)
    for k, tok in enumerate(tail.split()):
        a = t + (1.4 * k if not audible else 0.3 * k)
        b = a + (1.4 if not audible else dur)
        words.append((tok, a, b))
        if audible:
            spans.append((a, a + dur, SPEECH_DB))
    return tone_project(tmp_path, [("vo", spans, words[-1][2] + 0.5, words)])


def test_a_made_up_tail_glued_to_the_last_line_is_dropped(tmp_path, monkeypatch):
    """(c): whisper writes "Thank you." over the room tone at the end, appended to the last real line."""
    d = _tail_project(tmp_path, "Thank you.", audible=False)
    plan, _ = run(d, monkeypatch=monkeypatch)
    cut, unused = sections((d / "cut-plan.md").read_text())
    assert "Thank" not in " ".join(cut) and any(r.startswith("*A1 ") and r.endswith(" pause]") for r in unused)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "you learn it by doing it again and again"


def test_a_real_short_ending_is_kept(tmp_path, monkeypatch):
    d = _tail_project(tmp_path, "thanks for watching", audible=True)
    plan, _ = run(d, monkeypatch=monkeypatch)
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "you learn it by doing it again and again thanks for watching"


# ── (d) the energy pass: words where the audio is, dead air trimmed to a breath ─

def _gaps(d):
    said = played_words(d)
    return [round(b[1] - a[2], 3) for a, b in zip(said, said[1:])]


def test_a_quiet_but_audible_word_is_kept(tmp_path, monkeypatch):
    spans, words, end = spoken(["you lean right and fall over."])
    spans[2] = (spans[2][0], spans[2][1], -35.0)                 # "right", 15 dB under the rest: quiet, audible
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["inaudible"] == 0
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "you lean right and fall over."


def test_words_under_the_floor_are_removed_and_tagged_and_come_back_from_the_plan(tmp_path, monkeypatch):
    spans, words, end = spoken(["you feel a slight lean so you steer."])
    for k in (2, 3):              # "a slight": 3 dB over the room's -70, 47 dB under the speech
        spans[k] = (spans[k][0], spans[k][1], -67.0)
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, _ = run(d, monkeypatch=monkeypatch)
    # v5: both lie wholly in a silence of layer 1 (no neighbour long enough to hold them): they go with it, tagged
    # inaudible (b7639ba5 kept "slight", within 40 ms of "lean"'s sound)
    assert plan["removed"]["inaudible"] == 2
    # silence: the mechanical pass's own silence trimming, apart from the filler words (#1 should-fix 5, #2 #9)
    assert set(plan["removed"]["by"]) == {"pause", "deadAir", "retake", "inaudible", "tail", "fillers", "silence"}
    cut, unused = sections((d / "cut-plan.md").read_text())
    removed = [r for r in unused if not r.endswith("?]")]
    assert removed == [next(r for r in unused if r.startswith("*A1 ") and r.endswith(" inaudible]"))]
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "you feel lean so you steer."
    # the person keeps them: the * row in place of the line's rows (cut at the silence: two rows of A1)
    (tmp_path / "again").mkdir()
    d = tone_project(tmp_path / "again", [("vo", spans, end + 1.0, words)])
    run(d, monkeypatch=monkeypatch)
    lines = (d / "cut-plan.md").read_text().splitlines()
    star = next(ln for ln in lines if ln.startswith("*A1 "))
    at = next(i for i, ln in enumerate(lines) if ln.startswith("A1 "))
    lines = [ln for ln in lines if ln is not star and not ln.startswith("A1 ")]
    lines.insert(at, star[1:])
    (d / "cut-plan.md").write_text("\n".join(lines) + "\n")
    run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    assert said_text(d) == "you feel a slight lean so you steer."


def test_a_lone_word_whisper_put_in_a_pause_stays_a_word(tmp_path, monkeypatch):
    """Whisper times a short word into the pause beside the word that holds its sound ("I", "with"): with no sound
    of its own but audible words on both sides, it stays, so the text and the captions keep it."""
    spans, words, end = spoken(["and that is what we did."])
    spans[2] = (spans[2][0], spans[2][1], -80.0)
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["inaudible"] == 0
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "and that is what we did."


def test_an_elongated_word_is_tightened_to_its_sound(tmp_path, monkeypatch):
    """Whisper's span for "lean" starts 0.5 s before it is said: that silence inside the span is cut to a breath."""
    spans = [(0.30, 0.55, SPEECH_DB), (0.60, 0.85, SPEECH_DB), (1.40, 1.65, SPEECH_DB), (1.70, 1.95, SPEECH_DB)]
    words = [("you", 0.30, 0.60), ("feel", 0.60, 0.90), ("lean", 0.90, 1.70), ("now.", 1.70, 1.95)]
    d = tone_project(tmp_path, [("vo", spans, 3.0, words)])
    plan, _ = run(d, monkeypatch=monkeypatch)
    # v5: cut at the silence, so the line is two rows, "you feel" and "lean now." (b7639ba5: "feel {0.08} lean")
    assert "\nA1 you feel [" in (d / "cut-plan.md").read_text() and "\nA1 lean now. [" in (d / "cut-plan.md").read_text()
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert said_text(d) == "you feel lean now."
    assert max(_gaps(d)) <= 0.08 + 0.02


def test_dead_air_keeps_a_breath_each_side_and_breath_loosens_it(tmp_path, monkeypatch):
    lines = ["you lean right", "and the frame tips over."]
    d = spoken_project(tmp_path, lines, line_gap=0.9)
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["by"]["silence"] > 0.3        # v5: layer 1 cuts it, in the mechanical pass
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert max(_gaps(d)) == pytest.approx(0.08, abs=0.02)              # a breath each side
    (tmp_path / "loose").mkdir()
    d2 = spoken_project(tmp_path / "loose", lines, line_gap=0.9)
    plan, _ = run(d2, "--breath", "0.15", monkeypatch=monkeypatch)
    assert "breath 0.150" in (d2 / "cut-plan.md").read_text()         # v5: the apply rebuilds the same base
    run(d2, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert max(_gaps(d2)) == pytest.approx(0.30, abs=0.02)


# ── §558 cut fix pass 2 (two reviews' adversarial probes, synthetic tones and invented words only) ─────────────

def plan_apply_said(d, monkeypatch, *extra):
    """(plan answer, plan text, the words the applied cut plays)."""
    plan, _ = run(d, *extra, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    return plan, text, said_text(d)


LISTS = {
    "commas": (["We tested it on the iPhone, we tested it on the Pixel, we tested it on the Galaxy, and all three passed."], ()),
    "lines": (["you can use it on your phone", "you can use it on your laptop", "you can use it on your TV."], ()),
    "quote": (['he said "I will be there tonight" and she said "I will be there tonight" too.'], ()),
    "spanish": (["tienes que ir a la tienda, tienes que ir a la playa, y luego descansas."], ("--language", "es")),
    "milk": (["You need to buy the fresh organic milk, you need to buy the eggs from the farm."], ()),
    "refrain": (["and I said it is going to be fine and you said it is going to be fine"], ()),
    "beaches": (["we will fight on the beaches,", "we will fight on the landing grounds."], ()),
}


@pytest.mark.parametrize("name", sorted(LISTS))
def test_a_list_a_refrain_or_a_quote_is_never_cut(tmp_path, monkeypatch, name):
    """Review #2 blocker 1 / review #1 B1: offered, never cut, so every word plays."""
    lines, extra = LISTS[name]
    d = spoken_project(tmp_path, lines)
    plan, text, said = plan_apply_said(d, monkeypatch, *extra)
    assert said == " ".join(lines), (name, said)
    assert plan["removed"]["by"]["retake"] == 0


def kept_iv(d):
    """(inPoint, outPoint) of each speech item, in timeline order."""
    p = json.loads((d / "project.json").read_text())
    return [(it["inPoint"], it["outPoint"]) for it in sorted(p["tracks"][0]["items"], key=lambda x: x["start"])
            if "inPoint" in it]


def plays_whole(d, t0, t1):
    """Every moment of source [t0, t1] plays (one clip)."""
    return any(a <= t0 + 1e-3 and b >= t1 - 1e-3 for a, b in kept_iv(d))


def unheard_pieces(d, spans, under=0.3):
    """Kept pieces shorter than `under` that hold no whole tone a person hears (one clip)."""
    heard = [(a, b) for a, b, db in spans if db > NOISE_DB + 10]
    return [(a, b) for a, b in kept_iv(d) if b - a < under and not any(a <= x - 1e-3 and y <= b + 1e-3 for x, y in heard)]


# B3, B4, B2 (review #1)

def test_soft_words_in_a_quiet_recording_are_kept(tmp_path, monkeypatch):
    spans, words, end = spoken(["you feel a slight lean so you steer."], db=-40.0)
    for k in (2, 3):                    # 10 dB softer, 30 dB over the room
        spans[k] = (spans[k][0], spans[k][1], -50.0)
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, _, said = plan_apply_said(d, monkeypatch)
    assert said == "you feel a slight lean so you steer." and plan["removed"]["inaudible"] == 0
    assert all(plays_whole(d, a, b) for a, b, _ in spans)


def test_a_zero_length_audible_last_word_is_kept(tmp_path, monkeypatch):
    spans, words, end = spoken(["you learn it by doing it again and that's it."])
    words = list(words)
    a = words[-1][1]
    words[-1] = (words[-1][0], a + 0.1, a + 0.1)        # whisper's zero-length last word, over its own sound
    words[-2] = (words[-2][0], words[-2][1], a + 0.1)
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, _, said = plan_apply_said(d, monkeypatch)
    assert said == "you learn it by doing it again and that's it." and plan["removed"]["by"]["tail"] == 0
    assert plays_whole(d, *spans[-1][:2])


@pytest.mark.parametrize("onset", [False, True])
def test_a_weak_fricative_edge_plays(tmp_path, monkeypatch, onset):
    """B4: a -48 dB "f" decay (or "h" onset) of 120 ms beside a -20 dB word, the floor at -46."""
    spans = [(0.30, 0.55, SPEECH_DB), (0.60, 0.85, SPEECH_DB)]
    if not onset:
        nxt = 0.97 + 0.7
        spans += [(0.85, 0.97, -48.0), (nxt, nxt + 0.25, SPEECH_DB)]
        words = [("you", 0.30, 0.60), ("laugh", 0.60, nxt), ("now.", nxt, nxt + 0.25)]
    else:
        spans += [(1.55, 1.67, -48.0), (1.67, 1.92, SPEECH_DB)]
        words = [("you", 0.30, 0.60), ("feel", 0.60, 1.55), ("happy.", 1.55, 1.92)]
    d = tone_project(tmp_path, [("vo", spans, 3.5, words)])
    plan_apply_said(d, monkeypatch)
    assert plays_whole(d, *spans[2][:2]), kept_iv(d)


def test_a_breath_inside_a_long_whisper_span_keeps_the_word(tmp_path, monkeypatch):
    spans = [(0.30, 0.55, SPEECH_DB), (0.60, 0.85, SPEECH_DB), (0.92, 1.32, -50.0), (1.40, 1.65, SPEECH_DB),
             (1.70, 1.95, SPEECH_DB)]
    words = [("you", 0.30, 0.60), ("feel", 0.60, 0.90), ("lean", 0.90, 1.70), ("now.", 1.70, 1.95)]
    d = tone_project(tmp_path, [("vo", spans, 3.0, words)])
    _, _, said = plan_apply_said(d, monkeypatch)
    assert said == "you feel lean now." and plays_whole(d, 1.40, 1.65)


def test_a_word_s_sound_past_whisper_s_end_is_not_cut_by_the_silence_pass(tmp_path, monkeypatch):
    """Fragment (b): the mechanical pass cut at whisper's end + 0.05 s, through the word's own sound."""
    spans = [(0.30, 0.55, SPEECH_DB), (0.60, 1.05, SPEECH_DB), (1.80, 2.05, SPEECH_DB)]
    words = [("you", 0.30, 0.60), ("laugh", 0.60, 0.85), ("now.", 1.80, 2.05)]
    d = tone_project(tmp_path, [("vo", spans, 3.0, words)])
    plan_apply_said(d, monkeypatch)
    assert plays_whole(d, 0.60, 1.05), kept_iv(d)


def test_a_final_follow_me_keeps_both_words_whole(tmp_path, monkeypatch):
    spans, words, end = spoken(["so come along and follow me"])
    spans[-1] = (spans[-1][0], spans[-1][1], SPEECH_DB)
    spans.append((spans[-1][1], spans[-1][1] + 0.12, -48.0))       # the soft end of "me"
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    _, _, said = plan_apply_said(d, monkeypatch)
    assert said == "so come along and follow me"
    assert plays_whole(d, spans[-3][0], spans[-1][1]), kept_iv(d)


# D2: dense overlays keep their pauses (review #1 should-fix 1)

def test_dense_overlays_keep_the_pauses_they_start_in_and_never_refuse_the_plan(tmp_path, stub_transcribe, monkeypatch):
    d, words = _layered_project(tmp_path)
    plan, applied = plan_and_apply(d, monkeypatch)
    assert plan["mode"] == "plan" and applied["mode"] == "applied"
    assert any("where an overlay starts" in w for w in plan["warnings"])


# R2-Q2: words under the floor are offered, never removed, unless within 10 dB of the room (review #2 blocker 2)

def _lv(lines, levels=None, **kw):
    spans, words, end = spoken(lines, **kw)
    for k, db in (levels or {}).items():
        spans[k] = (spans[k][0], spans[k][1], db)
    return spans, words, end


def test_a_whispered_aside_is_kept_and_only_offered(tmp_path, monkeypatch):
    lines = ["so that is the plan", "just between you and me", "and we ship it on friday."]
    spans, words, end = _lv(lines, {k: -48.0 for k in range(5, 10)})
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, text, said = plan_apply_said(d, monkeypatch)
    assert said == " ".join(lines) and plan["removed"]["inaudible"] == 0
    # v5: 28 dB under the speech is voiced (within 30 dB): heard, so not offered (b7639ba5 offered it)
    assert not (plan.get("suggested") or {}).get("inaudible?") and "inaudible?]" not in text
    assert all(plays_whole(d, a, b) for a, b, _ in spans)


def test_a_lone_soft_word_plays_whole_never_cut_to_40_ms(tmp_path, monkeypatch):
    spans, words, end = _lv(["and that is what we did today."], {2: -48.0})
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    _, _, said = plan_apply_said(d, monkeypatch)
    assert said == "and that is what we did today." and plays_whole(d, *spans[2][:2]), kept_iv(d)


def test_a_soft_real_ending_is_kept(tmp_path, monkeypatch):
    lines = ["that is all for today, thanks for watching", "thank you so much."]
    spans, words, end = _lv(lines, {k: -48.0 for k in range(7, 11)})
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, _, said = plan_apply_said(d, monkeypatch)
    assert said == " ".join(lines) and plan["removed"]["by"]["tail"] == 0


@pytest.mark.parametrize("db, room", [(-52.0, -75.0), (-52.0, -70.0)])
def test_a_quiet_recording_loses_nothing(tmp_path, monkeypatch, db, room):
    """Gain down: speech at -52 dB. Never empty_cut, nothing removed as inaudible."""
    monkeypatch.setattr(sys.modules[__name__], "NOISE_DB", room)
    lines = ["this whole clip was recorded quietly", "but every word is clear."]
    spans, words, end = _lv(lines, db=db)
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, _, said = plan_apply_said(d, monkeypatch)
    assert said == " ".join(lines) and plan["removed"]["inaudible"] == 0


def test_a_quiet_second_clip_loses_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(sys.modules[__name__], "NOISE_DB", -78.0)
    out = []
    for n, (lines, db) in enumerate([(["this first clip is loud and clear."], -14.0),
                                     (["the second clip was recorded with the gain down", "but you can hear it fine."],
                                      -50.0)]):
        spans, words, end = _lv(lines, db=db)
        out.append((f"vo{n}", spans, end + 1.0, words))
    d = tone_project(tmp_path, out)
    plan, _, said = plan_apply_said(d, monkeypatch)
    assert said == ("this first clip is loud and clear. the second clip was recorded with the gain down but you can "
                    "hear it fine.")
    assert plan["removed"]["inaudible"] == 0


def test_an_aside_over_a_music_bed_is_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(sys.modules[__name__], "NOISE_DB", -35.0)
    lines = ["so that is the plan", "just between you and me", "and we ship it on friday."]
    spans, words, end = _lv(lines, {k: -48.0 for k in range(5, 10)})
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    _, _, said = plan_apply_said(d, monkeypatch)
    assert said == " ".join(lines)


# the tail rule: energy evidence only (B2, review #2 blocker 3)

def test_a_real_last_word_stretched_over_outro_music_is_kept(tmp_path, monkeypatch):
    lines = ["that is it for today thanks for watching and see you."]
    spans, words, end = spoken(lines)
    words = list(words)
    last = words[-1]
    words[-1] = (last[0], last[1], last[1] + 3.5)          # whisper runs the last word to the clip's end
    spans.append((last[1] + 0.3, last[1] + 3.5, -30.0))     # outro music under and after it
    d = tone_project(tmp_path, [("vo", spans, last[1] + 3.6, words)])
    plan, _, said = plan_apply_said(d, monkeypatch)
    assert said == lines[0] and plan["removed"]["by"]["tail"] == 0
    assert plays_whole(d, *spans[-2][:2])


# misplaced words (orchestrator's bar; review #2 should-fix 5)

def test_misplaced_words_whose_sound_is_in_a_long_neighbour_are_kept(tmp_path, monkeypatch):
    """"ride the bike": whisper puts "the bike" in a pause; the audio of all three sits in "ride"'s long span."""
    spans = [(0.30, 0.55, SPEECH_DB), (0.60, 1.65, SPEECH_DB), (2.40, 2.65, SPEECH_DB), (2.70, 2.95, SPEECH_DB)]
    words = [("we", 0.30, 0.60), ("ride", 0.60, 1.70), ("the", 1.70, 2.05), ("bike", 2.05, 2.40),
             ("all", 2.40, 2.70), ("day.", 2.70, 2.95)]
    d = tone_project(tmp_path, [("vo", spans, 3.6, words)])
    plan, text, said = plan_apply_said(d, monkeypatch)
    assert said == "we ride the bike all day." and plan["removed"]["inaudible"] == 0
    # v5: folded into "ride" and kept, but with no sound of their own they are offered inaudible? (never removed)
    assert " inaudible]" not in text.split("\n## Unused\n")[1] and plan["suggested"] == {"inaudible?": 1}


def test_a_truly_silent_run_between_two_short_words_is_still_removed(tmp_path, monkeypatch):
    spans = [(0.30, 0.55, SPEECH_DB), (0.60, 0.85, SPEECH_DB), (2.40, 2.65, SPEECH_DB), (2.70, 2.95, SPEECH_DB)]
    words = [("we", 0.30, 0.60), ("ride", 0.60, 1.70), ("the", 1.70, 2.05), ("bike", 2.05, 2.40),
             ("all", 2.40, 2.70), ("day.", 2.70, 2.95)]
    d = tone_project(tmp_path, [("vo", spans, 3.6, words)])
    plan, _, said = plan_apply_said(d, monkeypatch)
    # v5: both lie wholly in the silence and "ride" is too short to hold them: both go (b7639ba5 kept "bike", within
    # 40 ms of "all"'s sound)
    assert said == "we ride all day." and plan["removed"]["inaudible"] == 2


def test_words_whisper_started_early_in_a_pause_are_kept(tmp_path, monkeypatch):
    spans = [(0.3 + 0.3 * k, 0.55 + 0.3 * k, SPEECH_DB) for k in range(4)]
    spans += [(3.0 + 0.3 * k, 3.25 + 0.3 * k, SPEECH_DB) for k in range(5)]
    words = [("that", 0.3, 0.6), ("was", 0.6, 0.9), ("day", 0.9, 1.2), ("one.", 1.2, 1.5),
             ("and", 1.9, 2.2), ("so", 2.2, 2.5), ("we", 2.5, 3.85), ("went", 3.9, 4.2), ("home.", 4.2, 4.45)]
    d = tone_project(tmp_path, [("vo", spans, 5.5, words)])
    plan, _, said = plan_apply_said(d, monkeypatch)
    assert said == "that was day one. and so we went home." and plan["removed"]["inaudible"] == 0
    assert all(plays_whole(d, a, b) for a, b, _ in spans)


def test_words_in_the_quiet_band_are_offered_inaudible_and_kept(tmp_path, monkeypatch):
    spans, words, end = _lv(["you feel a slight lean so you steer."], {2: -58.0, 3: -58.0})
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, text, said = plan_apply_said(d, monkeypatch)
    # v5: 38 dB under the speech, between kept words: attached (orchestrator), so their sound plays and they are
    # heard, not offered (b7639ba5: offered inaudible?)
    assert said == "you feel a slight lean so you steer." and not plan.get("suggested")
    assert all(plays_whole(d, a, b) for a, b, _ in spans), kept_iv(d)


# dead slivers and word fragments (Sam, in the QA app)

def test_no_sliver_is_left_after_a_removed_retake(tmp_path, monkeypatch):
    """A word whisper put in the pause after a removed retake ("look", no sound of its own) was left as a 0.12 s
    clip of breath between removed words."""
    lines = ["so then we lean the frame over.", "look", "so then we lean the frame over and it tips."]
    spans, words, end = _lv(lines, {7: -90.0})
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan_apply_said(d, monkeypatch)
    assert unheard_pieces(d, spans) == [], kept_iv(d)


def test_no_sliver_is_left_when_the_person_deletes_the_words_on_both_sides(tmp_path, monkeypatch):
    """Apply: the person deletes the words around one whisper put in a pause; it is not left as a clip of its own."""
    spans, words, end = _lv(["and that is what we did today."], {2: -90.0})
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    run(d, monkeypatch=monkeypatch)
    text = (d / "cut-plan.md").read_text()
    text = re.sub(r"\bthat\b", "", text.replace(" what ", " ", 1), count=1)
    (d / "cut-plan.md").write_text(text)
    run(d, "--plan", str(d / "cut-plan.md"), monkeypatch=monkeypatch)
    assert unheard_pieces(d, spans) == [], kept_iv(d)


def test_a_short_audible_word_is_kept_as_its_own_piece(tmp_path, monkeypatch):
    spans = [(0.30, 0.55, SPEECH_DB), (0.60, 0.85, SPEECH_DB), (2.0, 2.15, SPEECH_DB), (3.4, 3.65, SPEECH_DB)]
    words = [("are", 0.30, 0.60), ("you?", 0.60, 1.2), ("Yes.", 1.2, 2.6), ("Good.", 2.6, 3.65)]
    d = tone_project(tmp_path, [("vo", spans, 4.5, words)])
    _, _, said = plan_apply_said(d, monkeypatch)
    assert said == "are you? Yes. Good." and plays_whole(d, 2.0, 2.15)


def test_a_breath_before_a_removed_retake_does_not_open_the_clip(tmp_path, monkeypatch):
    """The kungfu case: the clip's first kept piece was 0.13 s of breath before a removed retake."""
    lines = ["look", "| we built a robot that rides a bike", "| we built a robot that rides a bike and it learns."]
    spans, words, end = _lv(lines, start=0.6)
    spans[0] = (spans[0][0], spans[0][1], -90.0)                  # "look": silent, folded into the retake
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    _, _, said = plan_apply_said(d, monkeypatch)
    assert said == "we built a robot that rides a bike and it learns."
    assert unheard_pieces(d, spans) == [] and kept_iv(d)[0][0] >= spans[8][0] - 0.2, kept_iv(d)


# F2: a line spliced from two takes is flagged, never changed

def test_a_line_spliced_from_two_takes_is_offered_not_changed(tmp_path, monkeypatch):
    lines = ["now the robot rides the bike up the hill.", "the robot rides the bike up the hill today."]
    spans, words, end = _lv(lines, {9: -90.0, 10: -90.0})       # the second take's "the robot": not said
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    plan, text, said = plan_apply_said(d, monkeypatch)
    assert said == "now the robot rides the bike up the hill today."
    # offered: the take as it would be (the fragment out), naming the take it was spliced with
    assert "\nA1 now [0.3 retake? spliced A2 " in text and any("spliced from two takes" in w for w in plan["warnings"])


# #2 should-fix 6: the kept share and large inaudible losses, after every pass

def test_a_clip_left_with_almost_nothing_by_the_inaudible_pass_is_warned(tmp_path, monkeypatch):
    toks = ["we", "go"] + [f"w{k}" for k in range(24)] + ["now."]
    spans = [(0.3, 0.55, SPEECH_DB), (0.6, 0.85, SPEECH_DB), (9.0, 9.25, SPEECH_DB)]
    words = [(t, 0.3 + 0.3 * k, 0.6 + 0.3 * k) for k, t in enumerate(toks[:2])]
    words += [(t, 0.9 + 0.31 * k, 1.21 + 0.31 * k) for k, t in enumerate(toks[2:-1])] + [("now.", 9.0, 9.25)]
    # v5: 12 s, not 30: the speech level is the 95th-percentile frame, so speech must fill over 5% of the clip
    d = tone_project(tmp_path, [("vo", spans, 12.0, words)])
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert any("keeps only" in w for w in plan["warnings"]) and any("as inaudible" in w for w in plan["warnings"])


def test_removed_by_tells_silence_from_fillers(tmp_path, monkeypatch):
    d = spoken_project(tmp_path, ["you lean right and the frame tips over."])
    plan, _ = run(d, monkeypatch=monkeypatch)
    assert plan["removed"]["by"]["fillers"] == 0 and plan["removed"]["by"]["silence"] > 0.5


# R2-Q3 and D1: the breath, clamped, and dead air at a sentence end

@pytest.mark.parametrize("breath, kept", [("0", 0.04), ("0.3", 0.45)])
def test_the_breath_is_clamped(tmp_path, monkeypatch, breath, kept):
    """v5: the breath is layer 1's pad, written in the plan's header; the clamped one is what plays."""
    d = spoken_project(tmp_path, ["you lean right", "and the frame tips over."], line_gap=0.9)
    plan, _ = run(d, "--breath", breath, monkeypatch=monkeypatch)
    assert f"breath {kept / 2:.3f}" in (d / "cut-plan.md").read_text()
    run(d, "--plan", plan["plan"], monkeypatch=monkeypatch)
    assert max(_gaps(d)) == pytest.approx(kept, abs=0.02)


def test_dead_air_at_a_sentence_end_keeps_a_sentence_pause(tmp_path, monkeypatch):
    d = spoken_project(tmp_path, ["you lean right.", "and the frame tips over."], line_gap=0.9)
    plan, text, said = plan_apply_said(d, monkeypatch)
    # v5: layer 1 keeps min(pause, 0.18) at a sentence end, half each side, so no marker shows (b7639ba5:
    # "A2 {0.18} and the frame")
    assert "\nA2 and the frame" in text, text
    assert max(_gaps(d)) == pytest.approx(0.18, abs=0.02)


# #2 should-fix 4: the plan and the apply keep the same copy of a repeat in one row

def test_a_repeat_the_apply_would_keep_the_other_copy_of_is_only_offered(tmp_path, monkeypatch):
    import lib.speech_build as sb
    real = sb.align_row

    def other_copy(line_id, tokens, lines):
        got = real(line_id, tokens, lines)
        return [k - 7 if 9 <= k <= 15 else k for k in got] if len(got) == 12 else got   # the first saying instead
    monkeypatch.setattr(sb, "align_row", other_copy)
    line = "okay so then you tip the whole frame over | then you tip the whole frame over and it falls."
    # v5: a 0.35 s pause (a break, under max-pause), so both sayings stay in one row; a pause over max-pause is
    # cut by layer 1 and splits the row
    d = spoken_project(tmp_path, [line], pause=0.35)
    plan, text, said = plan_apply_said(d, monkeypatch)
    assert plan["removed"]["lines"] == {} and plan["suggested"].get("repeat?")
    assert said == line.replace(" |", "")


def test_a_sure_repeat_plays_the_second_saying(tmp_path, monkeypatch):
    lines = ["okay so then you tip the whole frame over | then you tip the whole frame over and it falls."]
    spans, words, end = _lv(lines)
    d = tone_project(tmp_path, [("vo", spans, end + 1.0, words)])
    _, _, said = plan_apply_said(d, monkeypatch)
    assert said == "okay so then you tip the whole frame over and it falls."
    first = spans[2:9]
    assert not any(plays_whole(d, a, b) for a, b, _ in first), kept_iv(d)
    assert all(plays_whole(d, a, b) for a, b, _ in spans[9:])


# Sam's repeat rule (2026-10-24): a CLEAR repeat is pre-picked (the last take kept, the earlier in ## Unused, tagged);
# a POSSIBLE one is only flagged, naming both places, and both takes stay in ## Cut: the unedited plan applies them both

def test_a_paraphrase_pair_applies_both_takes_with_the_plan_unedited(tmp_path, monkeypatch):
    lines = ["you overcorrected that as well.", "you overcorrected that too."]
    d = spoken_project(tmp_path, lines)
    plan, text, said = plan_apply_said(d, monkeypatch)
    assert said == " ".join(lines) and plan["removed"]["lines"] == {}
    cut, unused = sections(text)
    assert [re.sub(r" ?\{[\d.]+\} ?", " ", r.split(" [")[0]).strip() for r in cut] == \
        ["A1 you overcorrected that as well.", "A2 you overcorrected that too."]
    assert any(r.startswith("A1 ") and re.search(r"\?\s+A2 \d", r) for r in unused), unused   # names the other


def test_a_list_like_repeat_keeps_every_item_through_the_apply(tmp_path, monkeypatch):
    lines = ["you can use it on your phone", "you can use it on your laptop", "you can use it on your TV."]
    d = spoken_project(tmp_path, lines)
    plan, text, said = plan_apply_said(d, monkeypatch)
    assert said == " ".join(lines) and plan["removed"]["lines"] == {} and plan.get("suggested")


def test_a_clear_back_to_back_retake_keeps_the_last_take_the_earlier_in_unused(tmp_path, monkeypatch):
    lines = ["so then we lean the frame over", "so then we lean the frame over and it tips."]
    d = spoken_project(tmp_path, lines)
    plan, text, said = plan_apply_said(d, monkeypatch)
    assert said == "so then we lean the frame over and it tips."
    cut, unused = sections(text)
    assert len(unused) == 1 and unused[0].startswith("A1 so then we lean the frame over [0.3 ")
    assert cc._TAG.search(unused[0]).group(2) in ("retake", "restart", "false-start") and not cc._TAG.search(unused[0]).group(3)
    assert [re.sub(r" ?\{[\d.]+\} ?", " ", r.split(" [")[0]).strip() for r in cut] == \
        ["A2 so then we lean the frame over and it tips."]

