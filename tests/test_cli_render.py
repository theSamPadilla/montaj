"""Tests for --scale flag on the `montaj render` CLI subcommand.

Strategy: build the parser in-process via register() + monkeypatch render_main
to capture kwargs without shelling out to Node.
"""
import argparse
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))


def _build_parser():
    """Construct a minimal parser with the render subcommand registered."""
    import cli.commands.render  # noqa: F401 — side-effectful for monkeypatch
    from cli.commands.render import register

    parser = argparse.ArgumentParser(prog="montaj")
    subparsers = parser.add_subparsers(dest="command", required=True)
    register(subparsers)
    return parser


class TestRenderScaleFlag:
    """Verify --scale round-trips through argparse and into render_main kwargs."""

    def test_no_scale_calls_render_main_with_scale_none(self, monkeypatch):
        """montaj render <project> (no --scale) → render_main called with scale=None."""
        import cli.commands.render as render_mod

        captured = {}

        def _fake_render_main(**kwargs):
            captured.update(kwargs)

        monkeypatch.setattr(render_mod, "render_main", _fake_render_main)

        parser = _build_parser()
        args = parser.parse_args(["render", "project.json"])
        args.func(args)

        assert "scale" in captured, "scale kwarg not passed to render_main"
        assert captured["scale"] is None

    def test_scale_2_calls_render_main_with_scale_2(self, monkeypatch):
        """montaj render <project> --scale 2 → render_main called with scale=2."""
        import cli.commands.render as render_mod

        captured = {}

        def _fake_render_main(**kwargs):
            captured.update(kwargs)

        monkeypatch.setattr(render_mod, "render_main", _fake_render_main)

        parser = _build_parser()
        args = parser.parse_args(["render", "project.json", "--scale", "2"])
        args.func(args)

        assert captured["scale"] == 2

    def test_scale_1_calls_render_main_with_scale_1(self, monkeypatch):
        """montaj render <project> --scale 1 → render_main called with scale=1."""
        import cli.commands.render as render_mod

        captured = {}

        def _fake_render_main(**kwargs):
            captured.update(kwargs)

        monkeypatch.setattr(render_mod, "render_main", _fake_render_main)

        parser = _build_parser()
        args = parser.parse_args(["render", "project.json", "--scale", "1"])
        args.func(args)

        assert captured["scale"] == 1

    def test_scale_3_calls_render_main_with_scale_3(self, monkeypatch):
        """montaj render <project> --scale 3 → render_main called with scale=3."""
        import cli.commands.render as render_mod

        captured = {}

        def _fake_render_main(**kwargs):
            captured.update(kwargs)

        monkeypatch.setattr(render_mod, "render_main", _fake_render_main)

        parser = _build_parser()
        args = parser.parse_args(["render", "project.json", "--scale", "3"])
        args.func(args)

        assert captured["scale"] == 3

    def test_scale_5_rejected_by_argparse(self):
        """montaj render <project> --scale 5 → argparse exits non-zero (5 not in choices)."""
        parser = _build_parser()
        with pytest.raises(SystemExit) as exc_info:
            parser.parse_args(["render", "project.json", "--scale", "5"])
        assert exc_info.value.code != 0
