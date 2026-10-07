"""sample_overlay's google_fonts reaches sample-frame.js whole (§140).

serve turns a list value for a step param into the flag once per element, so
an agent's ["DM Serif Display", "DM Sans:wght@700"] arrives as two
--google-fonts flags; argparse's default kept only the last. Each value is
passed on as its own flag, untouched: sample-frame.js (google-fonts.js) reads
a list, a JSON-array string or a comma list. A fake `node` on PATH echoes the
argv it was given, as in test_sample_frame.py, so no browser runs.
"""
import json
import os
import textwrap

import pytest

from tests.conftest import run_step_env

STEP = "sample_overlay.py"


@pytest.fixture(scope="module")
def fake_node_env(tmp_path_factory) -> dict:
    d = tmp_path_factory.mktemp("fakenode")
    node = d / "node"
    node.write_text(textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys, json
        print(json.dumps(sys.argv[1:]))
    """))
    node.chmod(0o755)
    return {"PATH": f"{d}:{os.environ.get('PATH', '')}"}


def _fonts_passed(argv):
    return [argv[i + 1] for i, a in enumerate(argv) if a == "--google-fonts"]


def _run(env, tmp_path, *font_args):
    overlay = tmp_path / "title-card.jsx"
    overlay.write_text("export default () => null\n")
    proc = run_step_env(STEP, env, "--overlay", str(overlay), *font_args, "--out", str(tmp_path / "s.png"))
    assert proc.returncode == 0, proc.stderr
    return _fonts_passed(json.loads(proc.stdout))


def test_every_repeated_google_fonts_flag_reaches_node(fake_node_env, tmp_path):
    assert _run(fake_node_env, tmp_path, "--google-fonts", "DM Serif Display", "--google-fonts", "DM Sans:wght@700") == [
        "DM Serif Display", "DM Sans:wght@700",
    ]


def test_a_json_array_string_reaches_node_untouched(fake_node_env, tmp_path):
    value = '["DM+Serif+Display", "DM+Sans:wght@700"]'
    assert _run(fake_node_env, tmp_path, "--google-fonts", value) == [value]


def test_no_google_fonts_passes_no_flag(fake_node_env, tmp_path):
    assert _run(fake_node_env, tmp_path) == []
