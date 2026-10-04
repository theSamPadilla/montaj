"""transcribe records which time each output field is in (PL51)."""
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
from trim_spec import remap_timestamp  # noqa: E402
from common import ffmpeg_bin  # noqa: E402

STEP = REPO_ROOT / "steps" / "speech" / "transcribe.py"

KEEPS = [[2.0, 12.0], [18.0, 30.0], [35.0, 50.0], [56.0, 75.0], [80.0, 100.0], [105.0, 125.0]]
JOINED_S = sum(e - s for s, e in KEEPS)  # 106 s

SHIM = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, shutil, sys
    args = sys.argv[1:]
    prefix = args[args.index("--output-file") + 1]
    shutil.copy(os.environ["CANNED_WHISPER_JSON"], prefix + ".json")
    data = json.load(open(prefix + ".json"))
    with open(prefix + ".srt", "w") as f:
        for i, w in enumerate(data["transcription"], 1):
            t = w["timestamps"]
            f.write(f"{i}\\n{t['from']} --> {t['to']}\\n{w['text']}\\n\\n")
""")


def srt_ts(ms):
    return f"{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}"


def parse_ts(s):
    hms, ms = s.split(",")
    h, m, sec = hms.split(":")
    return ((int(h) * 60 + int(m)) * 60 + int(sec)) * 1000 + int(ms)


@pytest.fixture
def env(tmp_path):
    d = tmp_path / "whisper"
    (d / "models").mkdir(parents=True)
    (d / "models" / "ggml-base.en.bin").touch()
    (d / "models" / "ggml-base.bin").touch()
    bin_dir = d / "bin"
    bin_dir.mkdir()
    shim = bin_dir / "whisper-cpp"
    shim.write_text(SHIM)
    shim.chmod(0o755)

    words = []
    for i in range(40):
        frm = int(i * (JOINED_S * 1000 - 600) / 40)
        to = frm + 500
        words.append({"text": f"w{i}",
                      "timestamps": {"from": srt_ts(frm), "to": srt_ts(to)},
                      "offsets": {"from": frm, "to": to}})
    canned = tmp_path / "canned.json"
    canned.write_text(json.dumps({"transcription": words}))
    return {**os.environ, "WHISPER_DIR": str(d),
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "CANNED_WHISPER_JSON": str(canned)}, words


@pytest.fixture
def source(tmp_path):
    p = tmp_path / "src.wav"
    subprocess.run([ffmpeg_bin(), "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                    "-t", "150", str(p)], check=True, capture_output=True)
    return p


def run(env, *args):
    proc = subprocess.run([sys.executable, str(STEP), *args], capture_output=True, text=True, env=env)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_spec_input_records_time_bases(tmp_path, env, source):
    env, canned = env
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps({"input": str(source), "keeps": KEEPS}))
    prefix = tmp_path / "out"
    result = run(env, "--input", str(spec), "--out", str(prefix))
    data = json.loads(Path(result["words"]).read_text())

    for src_w, w in zip(canned, data["transcription"]):
        virtual = src_w["offsets"]["from"] / 1000.0
        expected = remap_timestamp(virtual, KEEPS) * 1000
        assert abs(w["offsets"]["from"] - expected) <= 1
        assert abs(parse_ts(w["timestamps"]["from"]) - w["offsets"]["from"]) <= 1
        assert abs(parse_ts(w["timestamps"]["to"]) - w["offsets"]["to"]) <= 1

    assert data["montaj"] == {"input": "spec", "spec": str(spec), "keeps": KEEPS,
                              "offsets": "source", "timestamps": "source", "srt": "spec"}

    cues = [l for l in Path(result["srt"]).read_text().splitlines() if "-->" in l]
    srt_end = parse_ts(cues[-1].split(" --> ")[1])
    assert srt_end < JOINED_S * 1000
    assert data["transcription"][-1]["offsets"]["to"] > JOINED_S * 1000


def test_plain_input_records_source(tmp_path, env, source):
    env, _ = env
    result = run(env, "--input", str(source), "--out", str(tmp_path / "plain"))
    data = json.loads(Path(result["words"]).read_text())
    assert data["montaj"] == {"input": "file", "offsets": "source",
                              "timestamps": "source", "srt": "source"}
