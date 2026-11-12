"""lib/onnx_runtime: onnxruntime is imported with its telemetry off, and only
through load()."""
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from lib import onnx_runtime

REPO_ROOT = Path(__file__).resolve().parent.parent

FAKE_RECORDS = (
    "import os\n"
    "SEEN = os.environ.get('ORT_DISABLE_TELEMETRY')\n"
    "CALLS = []\n"
)


def _fake(monkeypatch, tmp_path, body):
    """A stand-in onnxruntime package first on sys.path, imported fresh."""
    pkg = tmp_path / "fake" / "onnxruntime"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text(FAKE_RECORDS + body, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path / "fake"))
    monkeypatch.delitem(sys.modules, "onnxruntime", raising=False)
    monkeypatch.delenv("ORT_DISABLE_TELEMETRY", raising=False)


def test_switch_is_set_before_the_import_and_events_are_turned_off(monkeypatch, tmp_path):
    _fake(monkeypatch, tmp_path, "def disable_telemetry_events():\n    CALLS.append(1)\n")
    ort = onnx_runtime.load()
    assert ort.SEEN == "1"
    assert ort.CALLS == [1]
    assert os.environ["ORT_DISABLE_TELEMETRY"] == "1"


def test_a_build_without_the_events_switch_still_loads(monkeypatch, tmp_path):
    _fake(monkeypatch, tmp_path, "")
    ort = onnx_runtime.load()
    assert ort.SEEN == "1"
    assert not hasattr(ort, "disable_telemetry_events")


def test_a_failing_events_switch_does_not_stop_the_load(monkeypatch, tmp_path):
    _fake(monkeypatch, tmp_path,
          "def disable_telemetry_events():\n    CALLS.append(1)\n    raise RuntimeError('no env')\n")
    ort = onnx_runtime.load()
    assert ort.CALLS == [1]


def test_missing_onnxruntime_raises_an_import_error_named_onnxruntime(monkeypatch):
    # sys.modules[name] = None makes `import name` raise ImportError.
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    monkeypatch.delenv("ORT_DISABLE_TELEMETRY", raising=False)
    with pytest.raises(ImportError) as e:
        onnx_runtime.load()
    assert e.value.name == "onnxruntime"


_DIRECT = re.compile(r"^\s*(import\s+onnxruntime\b|from\s+onnxruntime\b)", re.M)


def test_nothing_imports_onnxruntime_but_the_loader():
    helper = REPO_ROOT / "lib" / "onnx_runtime.py"
    found = []
    for top in ("steps", "lib", "serve", "cli", "project"):
        for path in sorted((REPO_ROOT / top).rglob("*.py")):
            if path == helper:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for m in _DIRECT.finditer(text):
                found.append(f"{path.relative_to(REPO_ROOT)}:{text[:m.start()].count(chr(10)) + 1}")
    assert found == [], "import onnxruntime through lib/onnx_runtime.load(): " + ", ".join(found)


def _telemetry_store(home):
    return [os.path.join(d, n) for d, dirs, files in os.walk(home) for n in dirs + files
            if n in (".onnxruntime", "onnxruntime.db")]


def _import_in(home, code):
    env = {k: v for k, v in os.environ.items()
           if k not in ("PYTHONPATH", "PYTHONHOME", "ORT_DISABLE_TELEMETRY", "ORT_RUNNING_UNIT_TESTS", "CI")}
    env.update(HOME=str(home), CFFIXED_USER_HOME=str(home), PYTHONPATH=str(REPO_ROOT))
    subprocess.run([sys.executable, "-c", code], env=env, cwd=str(home), check=True,
                   capture_output=True, text=True, timeout=120)


def test_the_real_onnxruntime_writes_no_telemetry_store(tmp_path):
    pytest.importorskip("onnxruntime")
    control = tmp_path / "control"
    control.mkdir()
    _import_in(control, "import onnxruntime")
    if not _telemetry_store(control):
        pytest.skip("this onnxruntime keeps no telemetry store here (onnxruntime 1.31.1 on macOS does)")
    home = tmp_path / "home"
    home.mkdir()
    _import_in(home, "from lib import onnx_runtime; onnx_runtime.load()")
    assert _telemetry_store(home) == []
