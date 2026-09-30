"""filter_script(): filter graphs travel in a file, never in argv.

Windows caps a CreateProcess command line at 32,767 chars. The graph goes into a
small file that ffmpeg 7+ reads via ``-/filter_complex <file>`` / ``-/vf <file>``.
Always a file, never a threshold, so the Mac exercises the path Windows needs.

The leaf tests put a stub at MONTAJ_FFMPEG (``ffmpeg_bin()`` reads it on every
call), so the real ``subprocess.run`` spawns it and we see the real argv.
"""
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from tests.conftest import FFMPEG_BIN, HAS_FFMPEG, run_step_env  # noqa: E402

CAP = 32767


def _make_stub(tmp_path: Path):
    """An ffmpeg stand-in: logs argv plus the content of every -/opt file, then
    writes a non-empty file at argv[-1] so check_output passes."""
    log = tmp_path / "stub.jsonl"
    stub = tmp_path / "ffmpeg_stub"
    stub.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import json, sys
        argv = sys.argv[1:]
        scripts = {{}}
        for i, a in enumerate(argv):
            if a.startswith("-/") and i + 1 < len(argv):
                with open(argv[i + 1], "rb") as f:
                    scripts[a] = f.read().decode("utf-8")
        with open({str(log)!r}, "a", encoding="utf-8") as f:
            f.write(json.dumps({{"argv": argv, "scripts": scripts}}) + "\\n")
        with open(argv[-1], "wb") as f:
            f.write(b"stub")
        """))
    stub.chmod(0o755)
    return stub, log


def _calls(log: Path):
    return [json.loads(l) for l in log.read_text().splitlines()]


def _assert_leaf(log: Path, stub: Path, opt: str, inline: str, graph: str, out: str):
    calls = _calls(log)
    assert len(calls) == 1, f"stub ran {len(calls)} times"
    call = calls[0]
    argv = call["argv"]
    assert argv[-1] == out
    # Upper bound on MSVCRT quoting: every char escaped, plus quotes and a space.
    total = sum(2 * len(a) + 3 for a in [str(stub), *argv])
    assert total < CAP, f"command line bound {total} >= {CAP}"
    assert opt in argv and inline not in argv
    assert not any(graph in a for a in argv), "graph is inline in argv"
    assert call["scripts"][opt] == graph


# ---------------------------------------------------------------------------
# helper
# ---------------------------------------------------------------------------

def test_filter_script_bytes_are_the_graph_utf8_no_bom_no_newline():
    from common import filter_script
    graph = "drawtext=text='café — 日本語':x=0\n[a]anull[b]"
    with filter_script(graph) as p:
        data = Path(p).read_bytes()
    assert data == graph.encode("utf-8")
    assert not data.startswith(b"\xef\xbb\xbf")


def test_filter_script_fd_is_closed_before_yield():
    from common import filter_script
    def nfds():
        return len(os.listdir("/dev/fd"))
    before = nfds()
    with filter_script("[0:a]anull[aout]"):
        assert nfds() == before
    assert nfds() == before


def test_filter_script_file_removed_after_block():
    from common import filter_script
    with filter_script("x") as p:
        assert os.path.exists(p)
    assert not os.path.exists(p)


def test_filter_script_file_removed_when_body_raises():
    from common import filter_script
    with pytest.raises(RuntimeError):
        with filter_script("x") as p:
            raise RuntimeError("boom")
    assert not os.path.exists(p)


def test_filter_script_concurrent_uses_get_distinct_paths():
    from common import filter_script
    with filter_script("a") as p1, filter_script("a") as p2:
        assert p1 != p2
        assert os.path.exists(p1) and os.path.exists(p2)


def test_filter_script_honours_dir(tmp_path):
    from common import filter_script
    with filter_script("a", dir=str(tmp_path)) as p:
        assert Path(p).parent == tmp_path


# ---------------------------------------------------------------------------
# trim: audio extraction at 500 keep ranges
# ---------------------------------------------------------------------------

def test_filter_script_cleanup_is_best_effort(tmp_path):
    """A script that cannot be removed never fails the run; it is left behind."""
    from common import filter_script
    held = tmp_path / "held"
    held.mkdir()
    try:
        with filter_script("x", dir=str(held)) as p:
            os.chmod(held, 0o555)
        assert os.path.exists(p)
    finally:
        os.chmod(held, 0o755)


def test_trim_500_ranges_reads_graph_from_file(tmp_path, monkeypatch):
    stub, log = _make_stub(tmp_path)
    monkeypatch.setenv("MONTAJ_FFMPEG", str(stub))
    from trim_spec import extract_audio_at_keeps
    keeps = [[i * 2.0, i * 2.0 + 1.5] for i in range(500)]
    out = str(tmp_path / "out.wav")
    extract_audio_at_keeps("/a.mov", keeps, out)
    graph = ";".join(
        [f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]" for i, (s, e) in enumerate(keeps)]
        + ["".join(f"[a{i}]" for i in range(500)) + "concat=n=500:v=0:a=1[aout]"])
    _assert_leaf(log, stub, "-/filter_complex", "-filter_complex", graph, out)


# ---------------------------------------------------------------------------
# lyrics: 160 single-word captions through the real step
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_lyrics_160_single_words_reads_vf_from_file(tmp_path):
    audio = tmp_path / "song.wav"
    subprocess.run(
        [FFMPEG_BIN, "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
         "-t", "2", str(audio)],
        check=True, capture_output=True)
    stub, log = _make_stub(tmp_path)
    words = [{"word": f"w{i}", "start": i * 0.01, "end": i * 0.01 + 0.01} for i in range(160)]
    caps = tmp_path / "captions.json"
    caps.write_text(json.dumps({"segments": [{"text": "x", "start": 0.0, "end": 1.7, "words": words}]}))
    out = str(tmp_path / "render.mp4")
    proc = run_step_env(
        "lyrics_render.py", {"MONTAJ_FFMPEG": str(stub)},
        "--captions", str(caps), "--audio", str(audio),
        "--words-per-line", "1", "--out", out)
    assert proc.returncode == 0, proc.stderr
    call = _calls(log)[0]
    argv = call["argv"]
    graph = call["scripts"].get("-/vf") or argv[argv.index("-vf") + 1]
    print("GRAPH LEN", len(graph), "cmd bound", sum(2 * len(a) + 3 for a in [str(stub), *argv]))
    assert graph.count("drawtext=") == 160
    _assert_leaf(log, stub, "-/vf", "-vf", graph, out)
