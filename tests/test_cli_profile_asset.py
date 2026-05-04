"""Tests for `montaj profile asset` subcommands.

Pattern: call handler functions directly with a synthesised argparse.Namespace,
matching the style of test_install_cli.py.  HOME is monkeypatched to tmp_path so
Path.home()-based resolution stays inside the sandbox.
"""
import json
import sys
from argparse import Namespace
from pathlib import Path

import pytest

import cli.commands.profile as profile_cmd
from lib.profile_assets import load_assets_manifest, save_assets_manifest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def profile(home):
    """Create ~/.montaj/profiles/alpha/ (no assets dir yet)."""
    p = home / ".montaj" / "profiles" / "alpha"
    p.mkdir(parents=True)
    return p


@pytest.fixture
def profile_with_assets(profile):
    """alpha profile with an assets dir (no files yet)."""
    (profile / "assets").mkdir()
    return profile


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ns(**kwargs):
    """Build a Namespace with default-None for any unset keys."""
    defaults = {"name": "alpha", "description": None, "tags": None, "set_value": None, "get": False}
    defaults.update(kwargs)
    return Namespace(**defaults)


# ---------------------------------------------------------------------------
# asset list
# ---------------------------------------------------------------------------

class TestAssetList:
    def test_no_profile_errors(self, home):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_list(_ns(name="ghost"))
        assert exc.value.code == 1

    def test_no_assets_dir_prints_no_assets(self, profile, capsys):
        profile_cmd.handle_asset_list(_ns(name="alpha"))
        out = capsys.readouterr().out
        assert "no assets" in out

    def test_empty_assets_dir_no_files(self, profile_with_assets, capsys):
        profile_cmd.handle_asset_list(_ns(name="alpha"))
        out = capsys.readouterr().out
        # No real files → output is blank (or "no assets" is NOT printed either,
        # since assets dir does exist but iterdir yields nothing).
        # The handler prints one line per file; zero files → zero lines.
        assert out.strip() == ""

    def test_populated_alpha_order(self, profile_with_assets, home, capsys):
        assets = profile_with_assets / "assets"
        (assets / "z.png").write_bytes(b"z")
        (assets / "a.txt").write_text("a")
        (assets / "m.mp4").write_bytes(b"m")
        profile_cmd.handle_asset_list(_ns(name="alpha"))
        out = capsys.readouterr().out
        lines = [l.strip() for l in out.splitlines() if l.strip()]
        assert lines[0].startswith("a.txt")
        assert lines[1].startswith("m.mp4")
        assert lines[2].startswith("z.png")

    def test_description_surfaces_for_described_files(self, profile_with_assets, home, capsys):
        assets = profile_with_assets / "assets"
        (assets / "logo.png").write_bytes(b"x")
        (assets / "other.txt").write_text("y")
        save_assets_manifest("alpha", {
            "notes": "",
            "files": {"logo.png": {"description": "primary logo"}},
        })
        profile_cmd.handle_asset_list(_ns(name="alpha"))
        out = capsys.readouterr().out
        assert "primary logo" in out
        # other.txt has no description — should still appear but no description text
        assert "other.txt" in out

    def test_undescribed_file_shows_no_extra_text(self, profile_with_assets, home, capsys):
        assets = profile_with_assets / "assets"
        (assets / "bare.png").write_bytes(b"x")
        profile_cmd.handle_asset_list(_ns(name="alpha"))
        out = capsys.readouterr().out
        line = [l for l in out.splitlines() if "bare.png" in l][0]
        # Trimmed line is just the filename — no trailing description content
        assert line.strip() == "bare.png"

    def test_notes_section_appears_when_nonempty(self, profile_with_assets, home, capsys):
        assets = profile_with_assets / "assets"
        (assets / "f.txt").write_text("x")
        save_assets_manifest("alpha", {"notes": "brand kit v2", "files": {}})
        profile_cmd.handle_asset_list(_ns(name="alpha"))
        out = capsys.readouterr().out
        assert "notes:" in out
        assert "brand kit v2" in out

    def test_notes_section_absent_when_empty(self, profile_with_assets, home, capsys):
        assets = profile_with_assets / "assets"
        (assets / "f.txt").write_text("x")
        save_assets_manifest("alpha", {"notes": "", "files": {}})
        profile_cmd.handle_asset_list(_ns(name="alpha"))
        out = capsys.readouterr().out
        assert "notes:" not in out

    def test_manifest_json_excluded_from_listing(self, profile_with_assets, home, capsys):
        assets = profile_with_assets / "assets"
        (assets / "real.txt").write_text("x")
        (assets / "manifest.json").write_text('{"notes":"","files":{}}')
        profile_cmd.handle_asset_list(_ns(name="alpha"))
        out = capsys.readouterr().out
        assert "manifest.json" not in out
        assert "real.txt" in out

    def test_invalid_name_errors(self, home, capsys):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_list(_ns(name="bad name!"))
        assert exc.value.code == 1
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "invalid_name"


# ---------------------------------------------------------------------------
# asset add
# ---------------------------------------------------------------------------

class TestAssetAdd:
    def test_simple_add(self, profile, tmp_path, capsys):
        src = tmp_path / "hello.txt"
        src.write_text("hi")
        profile_cmd.handle_asset_add(_ns(name="alpha", path=str(src)))
        out = capsys.readouterr().out
        assert "added: hello.txt" in out
        assert (profile / "assets" / "hello.txt").read_text() == "hi"

    def test_collision_appends_suffix(self, profile, tmp_path, capsys):
        src = tmp_path / "hello.txt"
        src.write_text("first")
        profile_cmd.handle_asset_add(_ns(name="alpha", path=str(src)))

        src.write_text("second")
        profile_cmd.handle_asset_add(_ns(name="alpha", path=str(src)))

        src.write_text("third")
        profile_cmd.handle_asset_add(_ns(name="alpha", path=str(src)))

        assets = profile / "assets"
        assert (assets / "hello.txt").read_text() == "first"
        assert (assets / "hello_1.txt").read_text() == "second"
        assert (assets / "hello_2.txt").read_text() == "third"

    def test_add_with_description(self, profile, tmp_path, capsys):
        src = tmp_path / "logo.png"
        src.write_bytes(b"\x89PNG")
        profile_cmd.handle_asset_add(_ns(name="alpha", path=str(src), description="primary logo"))
        manifest = load_assets_manifest("alpha")
        assert manifest["files"]["logo.png"]["description"] == "primary logo"
        assert "tags" not in manifest["files"]["logo.png"]

    def test_add_with_tags(self, profile, tmp_path, capsys):
        src = tmp_path / "banner.jpg"
        src.write_bytes(b"\xff\xd8")
        profile_cmd.handle_asset_add(_ns(name="alpha", path=str(src), tags="brand,marketing"))
        manifest = load_assets_manifest("alpha")
        entry = manifest["files"]["banner.jpg"]
        assert entry["description"] == ""
        assert entry["tags"] == ["brand", "marketing"]

    def test_add_with_description_and_tags(self, profile, tmp_path, capsys):
        src = tmp_path / "icon.svg"
        src.write_text("<svg/>")
        profile_cmd.handle_asset_add(_ns(
            name="alpha", path=str(src),
            description="app icon", tags="icon,brand",
        ))
        manifest = load_assets_manifest("alpha")
        entry = manifest["files"]["icon.svg"]
        assert entry["description"] == "app icon"
        assert entry["tags"] == ["icon", "brand"]

    def test_add_no_manifest_entry_when_no_flags(self, profile, tmp_path):
        src = tmp_path / "bare.txt"
        src.write_text("x")
        profile_cmd.handle_asset_add(_ns(name="alpha", path=str(src)))
        manifest = load_assets_manifest("alpha")
        assert "bare.txt" not in manifest["files"]

    def test_add_nonexistent_profile_errors(self, home, tmp_path):
        src = tmp_path / "x.txt"
        src.write_text("x")
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_add(_ns(name="ghost", path=str(src)))
        assert exc.value.code == 1

    def test_add_nonexistent_file_errors(self, profile, tmp_path):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_add(_ns(name="alpha", path=str(tmp_path / "missing.txt")))
        assert exc.value.code == 1

    def test_invalid_name_errors(self, home, tmp_path, capsys):
        src = tmp_path / "x.txt"
        src.write_text("x")
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_add(_ns(name="bad name!", path=str(src)))
        assert exc.value.code == 1
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "invalid_name"


# ---------------------------------------------------------------------------
# asset rm
# ---------------------------------------------------------------------------

class TestAssetRm:
    def test_remove_file_and_entry(self, profile_with_assets, home, capsys):
        assets = profile_with_assets / "assets"
        (assets / "a.txt").write_text("a")
        save_assets_manifest("alpha", {"notes": "", "files": {"a.txt": {"description": "x"}}})

        profile_cmd.handle_asset_rm(_ns(name="alpha", filename="a.txt"))

        assert not (assets / "a.txt").exists()
        manifest = load_assets_manifest("alpha")
        assert "a.txt" not in manifest["files"]
        out = capsys.readouterr().out
        assert "removed: a.txt" in out

    def test_remove_file_only_no_entry(self, profile_with_assets, home, capsys):
        assets = profile_with_assets / "assets"
        (assets / "bare.txt").write_text("x")
        profile_cmd.handle_asset_rm(_ns(name="alpha", filename="bare.txt"))
        assert not (assets / "bare.txt").exists()

    def test_remove_entry_only_file_already_gone(self, profile_with_assets, home, capsys):
        assets = profile_with_assets / "assets"
        save_assets_manifest("alpha", {"notes": "", "files": {"ghost.png": {"description": "x"}}})
        profile_cmd.handle_asset_rm(_ns(name="alpha", filename="ghost.png"))
        manifest = load_assets_manifest("alpha")
        assert "ghost.png" not in manifest["files"]

    def test_remove_nonexistent_errors(self, profile_with_assets, home):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_rm(_ns(name="alpha", filename="missing.txt"))
        assert exc.value.code == 1

    def test_invalid_name_errors(self, home):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_rm(_ns(name="bad name!", filename="a.txt"))
        assert exc.value.code == 1

    def test_invalid_filename_errors(self, profile_with_assets, home):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_rm(_ns(name="alpha", filename=".hidden"))
        assert exc.value.code == 1

    def test_leading_dash_filename_errors(self, profile_with_assets, home):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_rm(_ns(name="alpha", filename="-leading"))
        assert exc.value.code == 1

    def test_handler_rejects_filename_with_traversal_chars(self, profile_with_assets, home, capsys):
        """Filenames containing '..' or leading with '-' are rejected before any
        filesystem access.  Bypass the argparse layer and call the handler directly
        with an args namespace so we test the handler's own validation rather than
        the standard library.
        """
        # "../etc/passwd" contains ".." which the _FILENAME_RE in the handler blocks.
        args = Namespace(name="alpha", filename="../etc/passwd")
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_rm(args)
        assert exc.value.code == 1
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "invalid_filename"

    def test_nonexistent_profile_errors(self, home):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_rm(_ns(name="ghost", filename="a.txt"))
        assert exc.value.code == 1


# ---------------------------------------------------------------------------
# asset notes
# ---------------------------------------------------------------------------

class TestAssetNotes:
    def test_get_empty_manifest_prints_empty_string(self, profile, capsys):
        profile_cmd.handle_asset_notes(_ns(name="alpha", set_value=None))
        out = capsys.readouterr().out
        # print("") → one newline character, so .strip() is empty
        assert out.strip() == ""

    def test_get_populated_notes(self, profile, capsys):
        save_assets_manifest("alpha", {"notes": "brand kit v2", "files": {}})
        profile_cmd.handle_asset_notes(_ns(name="alpha", set_value=None))
        out = capsys.readouterr().out
        assert out.strip() == "brand kit v2"

    def test_set_value(self, profile):
        profile_cmd.handle_asset_notes(_ns(name="alpha", set_value="new notes"))
        manifest = load_assets_manifest("alpha")
        assert manifest["notes"] == "new notes"

    def test_set_empty_string_clears_notes(self, profile):
        save_assets_manifest("alpha", {"notes": "existing", "files": {}})
        profile_cmd.handle_asset_notes(_ns(name="alpha", set_value=""))
        manifest = load_assets_manifest("alpha")
        assert manifest["notes"] == ""

    def test_get_after_set(self, profile, capsys):
        profile_cmd.handle_asset_notes(_ns(name="alpha", set_value="hello world"))
        profile_cmd.handle_asset_notes(_ns(name="alpha", set_value=None))
        out = capsys.readouterr().out
        assert out.strip() == "hello world"

    def test_nonexistent_profile_errors(self, home):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_notes(_ns(name="ghost", set_value=None))
        assert exc.value.code == 1

    def test_invalid_name_errors(self, home, capsys):
        with pytest.raises(SystemExit) as exc:
            profile_cmd.handle_asset_notes(_ns(name="bad name!", set_value=None))
        assert exc.value.code == 1
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "invalid_name"
