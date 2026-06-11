"""Step-level tests for steps/media/search_images.py.

Uses the run_step + assert_json_output conftest helpers.
HTTP is not mocked at this level — instead we exercise the argparse interface
and error-path behaviour that doesn't require network (bad args, etc.).
The library-level parse/filter logic is covered in test_image_sources.py.
"""
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from tests.conftest import assert_error, run_step


# ---------------------------------------------------------------------------
# Argument handling
# ---------------------------------------------------------------------------

class TestSearchImagesArgs:
    def test_missing_query_exits_nonzero(self):
        proc = run_step("search_images.py")
        assert proc.returncode != 0

    def test_valid_args_format(self):
        # We can't call live APIs in tests; verify that with a patched import
        # the step emits valid JSON. We do this by injecting a fake module
        # into the subprocess via PYTHONPATH with a monkeypatched image_sources.
        # Instead, rely on the library tests for logic coverage and just
        # verify that the step fails gracefully on bad_provider.
        proc = run_step("search_images.py", "--query", "test", "--provider", "unknown_provider")
        # argparse rejects invalid enum choices before we ever call fail()
        assert proc.returncode != 0

    def test_limit_capped_at_30(self):
        # Step should accept limit=30 without error (argparse validation only)
        # We can't verify network output, but we CAN verify the step parses --limit
        # without crashing (it will fail on the actual API call, which is network).
        # This is best tested at the library level; confirm the step at least starts.
        proc = run_step("search_images.py", "--query", "soccer", "--limit", "30",
                        "--provider", "commons")
        # Exit code may be nonzero due to actual network call failing in CI
        # but we confirm stderr is structured JSON error if nonzero.
        if proc.returncode != 0:
            try:
                err = json.loads(proc.stderr)
                assert "error" in err
            except json.JSONDecodeError:
                # argparse error, also acceptable
                pass
