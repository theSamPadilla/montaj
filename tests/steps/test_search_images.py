"""Step-level tests for steps/media/search_images.py.

NO network: subprocess invocations only exercise argparse paths that exit
before any HTTP call. Behavior tests import the step module directly and
monkeypatch its commons_search / sportsdb_badge references so the limit
clamping and JSON output shape are verified without touching the live APIs.
The library-level parse/filter logic is covered in test_image_sources.py.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from tests.conftest import run_step

_STEP_PATH = REPO_ROOT / "steps" / "media" / "search_images.py"


@pytest.fixture
def step_module():
    """Import steps/media/search_images.py as a module (no subprocess)."""
    spec = importlib.util.spec_from_file_location("search_images_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run_main(step_module, monkeypatch, capsys, argv):
    monkeypatch.setattr(sys, "argv", ["search_images.py", *argv])
    step_module.main()
    return json.loads(capsys.readouterr().out)


# ---------------------------------------------------------------------------
# Argparse paths (subprocess, exits before any HTTP)
# ---------------------------------------------------------------------------

class TestSearchImagesArgs:
    def test_missing_query_exits_nonzero(self):
        proc = run_step("search_images.py")
        assert proc.returncode != 0

    def test_invalid_provider_rejected_by_argparse(self):
        proc = run_step("search_images.py", "--query", "test",
                        "--provider", "unknown_provider")
        assert proc.returncode != 0
        assert "invalid choice" in proc.stderr


# ---------------------------------------------------------------------------
# Behavior (in-process, providers monkeypatched — no network)
# ---------------------------------------------------------------------------

class TestSearchImagesBehavior:
    def test_commons_provider_called_with_clamped_limit(self, step_module, monkeypatch, capsys):
        """--limit 99 must be clamped to 30 before reaching commons_search."""
        seen = {}

        def fake_commons(query, limit=10):
            seen["query"] = query
            seen["limit"] = limit
            return []

        monkeypatch.setattr(step_module, "commons_search", fake_commons)
        out = _run_main(step_module, monkeypatch, capsys,
                        ["--query", "soccer", "--limit", "99"])
        assert seen == {"query": "soccer", "limit": 30}
        assert out == {"results": []}

    def test_limit_floor_is_one(self, step_module, monkeypatch, capsys):
        """--limit 0 must be clamped up to 1."""
        seen = {}

        def fake_commons(query, limit=10):
            seen["limit"] = limit
            return []

        monkeypatch.setattr(step_module, "commons_search", fake_commons)
        _run_main(step_module, monkeypatch, capsys,
                  ["--query", "x", "--limit", "0"])
        assert seen["limit"] == 1

    def test_default_limit_is_10(self, step_module, monkeypatch, capsys):
        seen = {}

        def fake_commons(query, limit=10):
            seen["limit"] = limit
            return []

        monkeypatch.setattr(step_module, "commons_search", fake_commons)
        _run_main(step_module, monkeypatch, capsys, ["--query", "x"])
        assert seen["limit"] == 10

    def test_sportsdb_provider_routes_and_truncates(self, step_module, monkeypatch, capsys):
        """sportsdb results are truncated to the (clamped) limit."""
        fake_results = [{"title": f"Team {i}", "url": f"https://x/{i}.png",
                         "source": "sportsdb"} for i in range(5)]
        monkeypatch.setattr(step_module, "sportsdb_badge", lambda team: fake_results)
        out = _run_main(step_module, monkeypatch, capsys,
                        ["--query", "Barcelona", "--provider", "sportsdb",
                         "--limit", "2"])
        assert len(out["results"]) == 2
        assert out["results"][0]["title"] == "Team 0"

    def test_output_is_results_object(self, step_module, monkeypatch, capsys):
        payload = [{"title": "T", "url": "https://x/t.jpg", "source": "commons"}]
        monkeypatch.setattr(step_module, "commons_search",
                            lambda query, limit=10: payload)
        out = _run_main(step_module, monkeypatch, capsys, ["--query", "t"])
        assert out == {"results": payload}

    def test_provider_exception_becomes_search_failed(self, step_module, monkeypatch, capsys):
        def boom(query, limit=10):
            raise RuntimeError("api down")

        monkeypatch.setattr(step_module, "commons_search", boom)
        monkeypatch.setattr(sys, "argv", ["search_images.py", "--query", "t"])
        with pytest.raises(SystemExit):
            step_module.main()
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "search_failed"
        assert "api down" in err["message"]
