"""speech_apply: one write per speech edit, with a preview, a version first and nothing on refusal (PL44 T10).

Runs on the real speech fixture of tests/fixtures/speech_text (README there), copied to a tmp git repo.
"""
import json
import os
import shutil
import subprocess

import pytest

from lib import speech_apply
from lib.speech_text import derive, render

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "speech_text")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@local"]


def _git(pdir, *args):
    return subprocess.run([*GIT, *args], cwd=pdir, capture_output=True, text=True, check=True).stdout


@pytest.fixture
def env(tmp_path):
    pdir = tmp_path / "proj"
    shutil.copytree(FIX, pdir)
    pj = pdir / "project.json"
    pj.write_text(pj.read_text().replace("/FIXTURE", str(pdir)))
    _git(pdir, "init", "-q")
    _git(pdir, "add", "project.json")
    _git(pdir, "commit", "-q", "-m", "init")
    project = json.loads(pj.read_text())
    text = render(derive(project, str(pdir)), project.get("name") or project["id"])
    return type("E", (), {"dir": str(pdir), "path": str(pj), "text": text, "project": project})


def commits(env):
    return _git(env.dir, "rev-list", "--count", "HEAD").strip()


def snapshot(env):
    with open(env.path, "rb") as f:
        return f.read(), commits(env)


def apply(env, text, preview=False, max_pause=None, feel="tight"):
    """Applied tight by default: these tests hold the apply's mechanics on tight's cut (test_speech_feel.py
    holds natural's)."""
    return speech_apply.apply(env.path, text, preview=preview, max_pause=max_pause, feel=feel)


def refused(env, text, code, capsys, **kw):
    before = snapshot(env)
    with pytest.raises(SystemExit):
        apply(env, text, **kw)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == code, err
    assert snapshot(env) == before
    return err


def delete_row(text, prefix):
    lines = text.split("\n")
    hit = [i for i, ln in enumerate(lines) if ln.startswith(prefix + " ")]
    assert len(hit) == 1, prefix
    del lines[hit[0]]
    return "\n".join(lines)


def test_noop_writes_nothing(env):
    before = snapshot(env)
    mtime = os.stat(env.path).st_mtime_ns
    r = apply(env, env.text)
    assert r["applied"] is False and r["noop"] is True
    assert r["clamped"] == [] and r["hardCuts"] == 0 and r["warnings"] == [] and "cut" in r
    assert snapshot(env) == before and os.stat(env.path).st_mtime_ns == mtime
    assert not os.path.exists(os.path.join(env.dir, "speech-text.md"))


def test_preview_writes_nothing_and_matches_apply(env):
    text = delete_row(env.text, "A4")
    before = snapshot(env)
    p = apply(env, text, preview=True)
    assert p["applied"] is False and p["preview"] is True and p["noop"] is False
    assert snapshot(env) == before
    assert not os.path.exists(os.path.join(env.dir, "speech-text.md"))
    a = apply(env, text)
    assert a["applied"] is True and a["preview"] is False
    for k in ("after", "before", "cut", "moved", "pauses", "clamped", "hardCuts", "carried", "flagged", "text"):
        assert a[k] == p[k], k
    assert a["cut"] and a["cut"][0]["line"] == "A4"


def test_clean_tree_makes_no_version_commit(env):
    # HEAD already holds the old project, so there is nothing to snapshot
    n = commits(env)
    r = apply(env, delete_row(env.text, "A4"))
    assert r["applied"] is True and r["version"] is False and commits(env) == n


def test_apply_makes_one_version_holding_the_old_project(env):
    # the old project has unsaved changes (as after an editor save): the version captures them
    p = json.loads(open(env.path).read())
    p["editingPrompt"] = "unsaved"
    open(env.path, "w").write(json.dumps(p, indent=2))
    old = snapshot(env)[0]
    n = int(commits(env))
    r = apply(env, delete_row(env.text, "A4"))
    assert r["version"] is True and int(commits(env)) == n + 1
    assert _git(env.dir, "log", "-1", "--format=%s").strip() == "version: before speech edit"
    assert _git(env.dir, "show", "HEAD:project.json").encode() == old
    assert open(env.path, "rb").read() != old
    assert r["after"]["duration"] < r["before"]["duration"]
    assert json.loads(open(env.path).read())["tracks"][0]["items"]
    # the sidecar text is the re-derived one, and the result carries it
    md = open(os.path.join(env.dir, "speech-text.md")).read()
    assert md == r["text"]
    assert not [f for f in os.listdir(env.dir) if ".tmp" in f]


def test_applied_text_is_stable(env):
    r = apply(env, delete_row(env.text, "A4"))
    again = apply(env, r["text"])
    assert again["applied"] is False and again["noop"] is True


def test_changed_words_refused(env, capsys):
    lines = env.text.split("\n")
    i = next(i for i, ln in enumerate(lines) if ln.startswith("A1 "))
    toks = lines[i].split(" ")
    toks[1] = "zzzxqv"
    lines[i] = " ".join(toks)
    refused(env, "\n".join(lines), "changed_words", capsys)


def test_stale_after_trim(env, capsys):
    p = json.loads(open(env.path).read())
    p["tracks"][0]["items"][0]["outPoint"] += 0.001
    open(env.path, "w").write(json.dumps(p, indent=2))
    _git(env.dir, "add", "project.json")
    _git(env.dir, "commit", "-q", "-m", "trim")
    err = refused(env, env.text, "stale", capsys)
    assert "speech_text" in err["message"]


def test_stale_after_sidecar_change(env, capsys):
    with open(os.path.join(env.dir, "speech.json"), "a") as f:
        f.write(" ")
    refused(env, env.text, "stale", capsys)


def test_stale_wrong_track(env, capsys):
    refused(env, env.text.replace("track trk-0", "track trk-9", 1), "track_not_found", capsys)


def test_unknown_line_refused(env, capsys):
    t = env.text.replace("\n\n## Unused", "\nA999 hello there\n\n## Unused", 1)
    refused(env, t, "unknown_line", capsys)


def test_bad_row_refused(env, capsys):
    t = env.text.replace("\n\n## Unused", "\nwhat is this\n\n## Unused", 1)
    refused(env, t, "bad_row", capsys)


def test_atomic_when_a_stage_after_the_build_raises(env, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(speech_apply, "carry", boom)
    before = snapshot(env)
    with pytest.raises(RuntimeError):
        apply(env, delete_row(env.text, "A4"))
    assert snapshot(env) == before
    assert not [f for f in os.listdir(env.dir) if ".tmp" in f or f == "speech-text.md"]


def test_atomic_when_the_write_fails_after_the_version(env, monkeypatch):
    # a failure inside the replace step leaves project.json untouched (the version commit is harmless)
    old = open(env.path, "rb").read()
    def boom(*a, **k):
        raise OSError("disk")
    monkeypatch.setattr(speech_apply.os, "replace", boom)
    with pytest.raises(OSError):
        apply(env, delete_row(env.text, "A4"))
    assert open(env.path, "rb").read() == old
    assert not [f for f in os.listdir(env.dir) if ".tmp" in f]


def test_invalid_candidate_refused_with_engine_code(env, monkeypatch, capsys):
    real = speech_apply.carry
    def bad(project, *a, **k):
        new, rep = real(project, *a, **k)
        new["tracks"][0]["volume"] = "loud"
        return new, rep
    monkeypatch.setattr(speech_apply, "carry", bad)
    seen = []
    real_validate = speech_apply.validate_project
    def spy(path):
        seen.append(path)
        return real_validate(path)
    monkeypatch.setattr(speech_apply, "validate_project", spy)
    before = snapshot(env)
    with pytest.raises(SystemExit):
        apply(env, delete_row(env.text, "A4"))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "invalid_result" and "invalid_field" in err["message"]
    assert snapshot(env) == before
    # validated outside the project folder, and cleaned up
    assert seen and not seen[0].startswith(env.dir) and not os.path.exists(os.path.dirname(seen[0]))


# ---- PL44 review: uncertain gaps (words whisper placed inside a pause), fixture README measurements

def edit_row(text, prefix, old, new):
    lines = text.split("\n")
    hit = [i for i, ln in enumerate(lines) if ln.startswith(prefix + " ")]
    assert len(hit) == 1, prefix
    assert old in lines[hit[0]], (old, lines[hit[0]])
    lines[hit[0]] = lines[hit[0]].replace(old, new, 1)
    return "\n".join(lines)


def written_items(env):
    return json.loads(open(env.path).read())["tracks"][0]["items"]


def spans(items, src_only=True):
    return [(it["inPoint"], it["outPoint"]) for it in items if it.get("type", "video") == "video"]


def test_shortening_a_pause_next_to_an_inside_word_keeps_the_gap_whole(env):
    # "I" (whisper 16.98-17.06) is really spoken at about 17.36-17.8, inside pause 16.761-17.825
    before = snapshot(env)
    r = apply(env, edit_row(env.text, "A6", "{0.77}", "{0.30}"))
    assert r["noop"] is True and snapshot(env) == before     # clip-2 stays whole: nothing to change
    assert any(c.get("unsure") is True and c["line"] == "A6" for c in r["clamped"]), r["clamped"]


def test_deleting_a_pause_next_to_an_inside_word_keeps_the_gap_whole(env):
    # "with" (whisper 22.33-22.8) sits inside pause 22.267-23.073
    before = snapshot(env)
    r = apply(env, edit_row(env.text, "A10", "{0.27} ", ""))
    assert r["noop"] is True and snapshot(env) == before     # clip-3 stays whole
    assert any(c.get("unsure") is True for c in r["clamped"]), r["clamped"]


def test_deleting_an_inside_word_leaves_no_kept_span_over_the_real_word(env):
    r = apply(env, edit_row(env.text, "A5", " {0.22} I", ""))
    assert r["applied"] is True
    for lo, hi in spans(written_items(env)):
        assert min(hi, 17.8) - max(lo, 17.36) <= 0, (lo, hi)


# ---- PL44 review: an empty Cut never writes

def _all_rows_deleted(text):
    out, in_cut = [], False
    for ln in text.split("\n"):
        if ln.startswith("## "):
            in_cut = ln.strip() == "## Cut"
        elif in_cut and ln.strip():
            continue
        out.append(ln)
    return "\n".join(out)


def test_every_row_deleted_is_refused_and_writes_nothing(env, capsys):
    refused(env, _all_rows_deleted(env.text), "empty_cut", capsys)


def test_text_without_a_cut_section_is_refused_and_writes_nothing(env, capsys):
    head = env.text.split("\n## Cut")[0]
    refused(env, head + "\n", "bad_header", capsys)


def test_the_text_is_rendered_before_the_version_is_taken(env, monkeypatch):
    # nothing may fail after the write: a render failure leaves the project and the history alone
    def boom(*a, **k):
        raise RuntimeError("render")
    monkeypatch.setattr(speech_apply.speech_text, "render", boom)
    before = snapshot(env)
    with pytest.raises(RuntimeError):
        apply(env, delete_row(env.text, "A4"))
    assert snapshot(env) == before


# ---- PL44 review: unedited text is a no-op on real-world project shapes

def _rewrite(env, mutate):
    p = json.loads(open(env.path).read())
    mutate(p)
    open(env.path, "w").write(json.dumps(p, indent=2))
    return render(derive(p, env.dir), p["id"])    # the text an agent would read from this project


def test_unedited_text_on_unsorted_items_is_a_noop(env):
    text = _rewrite(env, lambda p: p["tracks"][0]["items"].reverse())
    before = snapshot(env)
    r = apply(env, text)
    assert r["noop"] is True and snapshot(env) == before


def test_unedited_text_on_integer_timings_is_a_noop(env):
    def ints(p):
        it = p["tracks"][0]["items"][0]
        assert it["inPoint"] == 0.0
        it["inPoint"] = 0
    text = _rewrite(env, ints)
    before = snapshot(env)
    r = apply(env, text)
    assert r["noop"] is True and snapshot(env) == before


def test_deleted_trailing_word_keeps_its_silence_end_to_end(env):
    # A8's "Tom!" is deleted and A7 asks for a 0.17 tail: the old item's trailing silence supplies it
    t = edit_row(env.text, "A7", '"Tom!"', '"Tom!" {0.17}')
    t = delete_row(t, "A8")
    r = apply(env, t)
    assert r["applied"] is True and r["clamped"] == []
    again = apply(env, r["text"])
    assert again["noop"] is True


# ---- PL44 review (should): track override, version repo, no-op report, mixed track

def test_text_read_with_a_track_override_applies_as_a_noop(env):
    text = render(derive(env.project, env.dir, track="st-face"), "x")
    assert "track st-face" in text
    before = snapshot(env)
    r = apply(env, text)
    assert r["noop"] is True and snapshot(env) == before


def test_project_inside_another_repo_is_applied_without_a_version_and_says_so(env):
    shutil.rmtree(os.path.join(env.dir, ".git"))
    parent = os.path.dirname(env.dir)
    _git(parent, "init", "-q")
    _git(parent, "add", "proj/project.json")
    _git(parent, "commit", "-q", "-m", "someone else's")
    head = _git(parent, "rev-parse", "HEAD")
    p = json.loads(open(env.path).read())
    p["editingPrompt"] = "unsaved"
    open(env.path, "w").write(json.dumps(p, indent=2))
    r = apply(env, delete_row(env.text, "A4"))
    assert r["applied"] is True and r["version"] is False
    assert any("no version saved" in w for w in r["warnings"]), r["warnings"]
    assert _git(parent, "rev-parse", "HEAD") == head


def test_overlay_item_on_the_speech_track_is_refused_before_any_write(env, capsys):
    p = json.loads(open(env.path).read())
    p["tracks"][0]["items"].append({"id": "ov-on-speech", "type": "overlay", "src": os.path.join(env.dir, "overlay.jsx"),
                                    "start": 1.0, "end": 3.0})
    open(env.path, "w").write(json.dumps(p, indent=2))
    before = snapshot(env)
    with pytest.raises(SystemExit):
        apply(env, env.text)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "mixed_track" and "ov-on-speech" in err["message"], err
    assert snapshot(env) == before


# ---- PL44 review (nit): silences are measured once per apply

def test_silences_are_measured_once_per_source_per_apply(env, monkeypatch):
    from lib import speech_text as st
    real = st.silences
    calls = []
    def spy(media):
        calls.append(media)
        return real(media)
    monkeypatch.setattr(st, "silences", spy)
    monkeypatch.setattr(speech_apply, "silences", spy, raising=False)
    r = apply(env, delete_row(env.text, "A4"))
    assert r["applied"] is True
    assert len(calls) == 1, calls
