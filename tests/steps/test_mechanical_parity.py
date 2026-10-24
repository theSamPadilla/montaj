"""§558 E2: rm_nonspeech, rm_fillers and jump_cut give the same output after their logic moved into pure
functions the cut step reuses.

Each step's real main() runs in process with only its I/O stubbed (whisper, ffmpeg, the project file). The
expected outputs in tests/fixtures/mechanical_parity.json were captured from the code BEFORE the refactor
(montaj 071e689e, in a throwaway worktree), by `python tests/steps/test_mechanical_parity.py --capture`.
"""
import contextlib
import io
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

GOLDENS = REPO_ROOT / "tests" / "fixtures" / "mechanical_parity.json"

# Joined-audio (or source) words, seconds. Gaps of 0.05 (bridged), 0.4 and 1.2 (cut), and fillers.
WORDS = [
    {"text": "Start", "start": 0.40, "end": 0.70},
    {"text": "by", "start": 0.75, "end": 0.90},
    {"text": "um,", "start": 1.30, "end": 1.60},
    {"text": "picking", "start": 1.65, "end": 2.00},
    {"text": "the", "start": 2.05, "end": 2.15},
    {"text": "clip.", "start": 2.20, "end": 2.60},
    {"text": "Uh", "start": 3.80, "end": 4.00},
    {"text": "you", "start": 4.10, "end": 4.30},
    {"text": "want", "start": 4.35, "end": 4.60},
    {"text": "hmm", "start": 4.62, "end": 4.70},
    {"text": "to", "start": 4.72, "end": 4.85},
    {"text": "edit.", "start": 4.90, "end": 5.40},
]
DURATION = 5.5


def _run_speech_step(mod_name, argv, words, monkeypatch):
    import importlib
    mod = importlib.import_module(f"steps.speech.{mod_name}")
    monkeypatch.setattr(mod, "require_file", lambda p: None)
    monkeypatch.setattr(mod, "require_whisper_model", lambda m, l: (m, "/none"))
    monkeypatch.setattr(mod, "transcribe_words", lambda *a, **k: [dict(w) for w in words])
    monkeypatch.setattr(mod, "get_duration", lambda p: DURATION)
    monkeypatch.setattr(mod, "extract_audio_at_keeps", lambda *a, **k: None)
    monkeypatch.setattr(sys, "argv", [f"{mod_name}.py", *argv])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        mod.main()
    return json.loads(out.getvalue())


def _spec(tmp, keeps):
    p = Path(tmp) / "spec.json"
    p.write_text(json.dumps({"input": "/src/clip.mp4", "keeps": keeps}))
    return str(p)


def _speech_cases(tmp):
    spec = _spec(tmp, [[0.0, 2.7], [3.5, 5.5]])
    return {
        "rm_nonspeech/raw": ("rm_nonspeech", ["--input", "/src/clip.mp4"], WORDS),
        "rm_nonspeech/raw-edge": ("rm_nonspeech", ["--input", "/src/clip.mp4", "--sentence-edge", "0.5",
                                                   "--max-word-gap", "0.3"], WORDS),
        "rm_nonspeech/raw-empty": ("rm_nonspeech", ["--input", "/src/clip.mp4"], []),
        "rm_nonspeech/spec": ("rm_nonspeech", ["--input", spec], WORDS[:6]),
        "rm_nonspeech/spec-empty": ("rm_nonspeech", ["--input", spec], []),
        "rm_nonspeech/window": ("rm_nonspeech", ["--input", "/src/clip.mp4", "--window-in", "1.0",
                                                 "--window-out", "4.0"], WORDS[:5]),
        "rm_fillers/raw": ("rm_fillers", ["--input", "/src/clip.mp4"], WORDS),
        "rm_fillers/raw-empty": ("rm_fillers", ["--input", "/src/clip.mp4"], []),
        "rm_fillers/raw-es": ("rm_fillers", ["--input", "/src/clip.mp4", "--language", "es"],
                              [*WORDS[:2], {"text": "eh", "start": 1.0, "end": 1.2}, *WORDS[3:]]),
        "rm_fillers/spec": ("rm_fillers", ["--input", spec], WORDS[:6]),
        "rm_fillers/spec-lead-filler": ("rm_fillers", ["--input", spec],
                                        [{"text": "Um", "start": 0.1, "end": 0.3}, *WORDS[:6]]),
        "rm_fillers/window": ("rm_fillers", ["--input", "/src/clip.mp4", "--window-in", "0.2",
                                             "--window-out", "5.0"],
                              [{"text": "um", "start": 0.0, "end": 0.6}, *WORDS[:8]]),
    }


def _jump_cut_cases():
    def clip(cid, start, end, **kw):
        return {"id": cid, "type": "video", "src": f"/src/{cid}.mp4", "start": start, "end": end, **kw}
    probed = [clip("a", 0.0, 6.0, inPoint=1.0, outPoint=7.0, proxySrc="/p/a.mp4", volume=0.5),
              clip("b", 6.0, 9.0, inPoint=0.0, outPoint=3.0)]
    fresh = [clip("a", 0.0, 0.0, sourceDuration=8.0), clip("b", 0.0, 0.0, sourceDuration=5.0)]
    return {
        "jump_cut/cuts": (probed, ["--clip-id", "a", "--cuts", json.dumps([[1.0, 2.0], [4.0, 4.5]])], None),
        "jump_cut/keeps": (probed, ["--clip-id", "b", "--keeps", json.dumps([[0.0, 1.0], [1.5, 3.0]])], None),
        "jump_cut/spec": (probed, ["--clip-id", "a", "--spec", "SPEC"],
                          {"input": "/src/a.mp4", "keeps": [[0.5, 2.0], [2.5, None], [None, 1.2]]}),
        "jump_cut/spec-placeholder": (fresh, ["--clip-id", "a", "--spec", "SPEC"],
                                      {"input": "/src/a.mp4", "keeps": [[0.2, 3.0], [3.5, 7.9]]}),
        "jump_cut/spec-second-placeholder": (fresh, ["--clip-id", "b", "--spec", "SPEC"],
                                             {"keeps": [[1.0, 4.0]]}),
    }


def _run_jump_cut(items, argv, spec, tmp, monkeypatch):
    import copy
    import steps.edit.jump_cut as jc
    project = {"id": "p1", "tracks": [{"id": "trk-0", "items": copy.deepcopy(items)},
                                      {"id": "trk-1", "items": [{"id": "ov", "type": "overlay", "src": "/o.jsx",
                                                                 "start": 1.0, "end": 2.0}]}]}
    saved = {}
    monkeypatch.setattr(jc, "find_project", lambda pid: (Path(tmp) / "project.json", project))
    monkeypatch.setattr(jc, "save_project_changes", lambda p, orig, proj: saved.update(project=proj))
    monkeypatch.setattr(jc, "id_suffix", lambda: "x")
    monkeypatch.setattr(jc, "get_duration", lambda p: 99.0)
    if spec is not None:
        sp = Path(tmp) / "jc-spec.json"
        sp.write_text(json.dumps(spec))
        argv = [str(sp) if a == "SPEC" else a for a in argv]
    monkeypatch.setattr(sys, "argv", ["jump_cut.py", "--project-id", "p1", *argv])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        jc.main()
    return {"stdout": json.loads(out.getvalue()), "tracks": saved["project"]["tracks"]}


def _all_outputs(tmp, monkeypatch):
    got = {}
    for name, (mod, argv, words) in _speech_cases(tmp).items():
        got[name] = _run_speech_step(mod, argv, words, monkeypatch)
    for name, (items, argv, spec) in _jump_cut_cases().items():
        got[name] = _run_jump_cut(items, argv, spec, tmp, monkeypatch)
    return got


def _normalise(outputs, tmp):
    """Spec paths are per run; compare them by name."""
    return json.loads(json.dumps(outputs).replace(str(tmp), "<tmp>"))


def test_outputs_match_the_pre_refactor_code(tmp_path, monkeypatch):
    expected = json.loads(GOLDENS.read_text())
    got = _normalise(_all_outputs(tmp_path, monkeypatch), tmp_path)
    assert set(got) == set(expected)
    for name in expected:
        assert got[name] == expected[name], name


if __name__ == "__main__" and "--capture" in sys.argv:
    import tempfile

    class _MP:
        def __init__(self):
            self.undo = []

        def setattr(self, obj, name, value):
            self.undo.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)

        def restore(self):
            for obj, name, value in reversed(self.undo):
                setattr(obj, name, value)
            self.undo = []

    mp = _MP()
    tmp = tempfile.mkdtemp()
    argv0 = list(sys.argv)
    try:
        outputs = _normalise(_all_outputs(tmp, mp), tmp)
    finally:
        mp.restore()
        sys.argv = argv0
    out = Path(sys.argv[sys.argv.index("--capture") + 1])
    out.write_text(json.dumps(outputs, indent=1, sort_keys=True) + "\n")
    print(f"wrote {len(outputs)} cases to {out}")
