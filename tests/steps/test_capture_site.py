import json, shutil, subprocess, sys
import pytest
from tests.conftest import REPO_ROOT

STEP = REPO_ROOT / "steps" / "media" / "capture_site.py"
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "capture_site" / "index.html"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def test_captures_screens_logo_palette_and_fonts(tmp_path):
    proc = subprocess.run([sys.executable, str(STEP), "--url", FIXTURE.as_uri(), "--out-dir", str(tmp_path / "site")],
                          capture_output=True, text=True, timeout=180)
    assert proc.returncode == 0, proc.stderr
    m = json.loads((tmp_path / "site" / "manifest.json").read_text())
    assert m["title"] == "Fixture Co"
    for k in ("desktop", "mobile", "full"):
        assert (tmp_path / "site" / m["screenshots"][k]).is_file()
    assert any(l["source"] == "img" for l in m["logos"])
    hexes = [p["hex"] for p in m["palette"]]
    assert "#101820" in hexes and "#ff3366" in hexes
    assert "Fixture Sans" in m["fonts"]


def test_rejects_non_http_non_file_urls(tmp_path):
    proc = subprocess.run([sys.executable, str(STEP), "--url", "javascript:alert(1)", "--out-dir", str(tmp_path)],
                          capture_output=True, text=True)
    assert proc.returncode != 0 and "invalid_argument" in proc.stderr
