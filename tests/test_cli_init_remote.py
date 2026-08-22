"""Tests for remote-input support on montaj init (Task 2 — init portion only).

Strategy:
- Tests for project/init.py (the script) use the direct-import approach:
  `import project.init as init_mod; monkeypatch sys.argv + lib.remote_io.fetch_to_disk`.
  This lets monkeypatch intercept the fetch without fighting subprocess isolation.
- Tests for cli/commands/init.py (the CLI wrapper) use subprocess via
  `sys.executable -m cli.main init ...` so we exercise the real argument parsing
  and file-expansion logic. These tests don't exercise network I/O (they only test
  the CLI-wrapper's argument shaping and file-not-found error path).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
INIT_PY = str(REPO_ROOT / "project" / "init.py")
sys.path.insert(0, str(REPO_ROOT))

from lib.project_tracks import track_items


# ── helpers ────────────────────────────────────────────────────────────────────

def _project_path_from_stdout(stdout: str) -> Path:
    """init.py emits a single stdout line — the project.json path."""
    lines = [ln for ln in stdout.strip().split("\n") if ln.strip()]
    return Path(lines[-1])


def _run_init_subprocess(*args, env_override=None):
    """Run project/init.py directly as a subprocess (matches existing test_init.py pattern)."""
    e = {**os.environ, **(env_override or {})}
    return subprocess.run(
        [sys.executable, INIT_PY, *args],
        capture_output=True, text=True, env=e,
    )


def _run_cli(*args, env_override=None):
    """Run `montaj init` via the CLI entry point."""
    e = {**os.environ, **(env_override or {})}
    return subprocess.run(
        [sys.executable, "-m", "cli.main", "init", *args],
        capture_output=True, text=True, env=e,
        cwd=str(REPO_ROOT),
    )


def _make_fetch_stub(tmp_path: Path):
    """Return a fetch_to_disk stub that creates each destPath under target_dir
    and returns all-ok results. Suitable for monkeypatching lib.remote_io.fetch_to_disk."""
    def _stub(items, target_dir, allowed_hosts, *, transport=None):
        results = []
        for item in items:
            dest = target_dir / item["destPath"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"fake remote content")
            results.append({"destPath": item["destPath"], "status": "ok", "bytesWritten": 19})
        return results
    return _stub


def _make_fetch_stub_failing(error_code: str = "host_not_allowed"):
    """Return a fetch_to_disk stub that returns an error for every item."""
    def _stub(items, target_dir, allowed_hosts, *, transport=None):
        return [
            {"destPath": item.get("destPath", "?"), "status": "error",
             "error": error_code, "message": f"Stub error: {error_code}"}
            for item in items
        ]
    return _stub


# ── Section 1: CLI gap fix — --clip / --asset pass-through ─────────────────────

class TestCliLocalClipAssetPassthrough:
    """Verify the existing CLI gap is closed: --clip and --asset flags on `montaj init`."""

    def test_clip_flag_produces_valid_project(self, tmp_path):
        """montaj init --clip ./local.mp4 produces a valid project with the clip staged."""
        clip = tmp_path / "local.mp4"
        clip.write_bytes(b"fake video")
        ws = tmp_path / "ws"
        ws.mkdir()
        result = _run_cli(
            "--prompt", "test clip passthrough",
            "--clip", str(clip),
            env_override={"MONTAJ_WORKSPACE_DIR": str(ws)},
        )
        assert result.returncode == 0, result.stderr
        project_path = _project_path_from_stdout(result.stdout)
        project = json.loads(project_path.read_text())
        assert project["version"] == "0.2"
        assert len(project["tracks"]) == 1
        track = track_items(project)[0]
        assert len(track) == 1
        assert track[0]["src"].endswith("local.mp4")

    def test_asset_flag_produces_valid_project(self, tmp_path):
        """montaj init --asset ./logo.png produces a valid project with the asset staged."""
        asset = tmp_path / "logo.png"
        asset.write_bytes(b"fake png")
        ws = tmp_path / "ws"
        ws.mkdir()
        result = _run_cli(
            "--prompt", "test asset passthrough",
            "--asset", str(asset),
            env_override={"MONTAJ_WORKSPACE_DIR": str(ws)},
        )
        assert result.returncode == 0, result.stderr
        project_path = _project_path_from_stdout(result.stdout)
        project = json.loads(project_path.read_text())
        assert len(project["assets"]) == 1
        assert project["assets"][0]["name"] == "logo.png"

    def test_clip_and_asset_together(self, tmp_path):
        """montaj init --clip X --asset Y produces a valid project with both staged."""
        clip = tmp_path / "clip.mp4"
        clip.write_bytes(b"fake video")
        asset = tmp_path / "logo.png"
        asset.write_bytes(b"fake png")
        ws = tmp_path / "ws"
        ws.mkdir()
        result = _run_cli(
            "--prompt", "test clip + asset",
            "--clip", str(clip),
            "--asset", str(asset),
            env_override={"MONTAJ_WORKSPACE_DIR": str(ws)},
        )
        assert result.returncode == 0, result.stderr
        project_path = _project_path_from_stdout(result.stdout)
        project = json.loads(project_path.read_text())
        assert len(track_items(project)[0]) == 1
        assert len(project["assets"]) == 1


# ── Section 2: --remote-clip on project/init.py (direct, monkeypatched) ───────

class TestRemoteClipDirect:
    """Test --remote-clip / --remote-asset on project/init.py via direct import + monkeypatch."""

    def test_remote_clip_produces_valid_project(self, tmp_path, monkeypatch):
        """--remote-clip fetches a clip and produces a valid project referencing it."""
        import project.init as init_mod
        import lib.remote_io

        ws = tmp_path / "ws"
        ws.mkdir()

        item = {
            "url": "https://example.com/clip.mp4",
            "destPath": "clips/clip.mp4",
            "contentType": "video/mp4",
            "sizeBytes": 19,
        }

        monkeypatch.setattr(lib.remote_io, "fetch_to_disk", _make_fetch_stub(tmp_path))
        # Also patch the reference that project.init imported at module level.
        monkeypatch.setattr(init_mod, "fetch_to_disk", _make_fetch_stub(tmp_path))

        monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        monkeypatch.setattr(
            sys, "argv",
            [INIT_PY, "--prompt", "remote clip test", "--remote-clip", json.dumps(item)],
        )

        project_path_str = None

        def _capture_print(*args, **kwargs):
            nonlocal project_path_str
            if args and str(args[0]).endswith("project.json"):
                project_path_str = str(args[0])
            _orig_print(*args, **kwargs)

        import builtins
        _orig_print = builtins.print
        monkeypatch.setattr(builtins, "print", _capture_print)

        init_mod.main()

        assert project_path_str is not None, "init.main() did not print a project path"
        project = json.loads(Path(project_path_str).read_text())
        assert project["version"] == "0.2"
        track = track_items(project)[0]
        assert len(track) == 1
        # The clip src should reference the fetched file inside the workspace.
        assert "clip.mp4" in track[0]["src"]

    def test_remote_asset_produces_valid_project(self, tmp_path, monkeypatch):
        """--remote-asset fetches an asset and produces a valid project referencing it."""
        import project.init as init_mod

        ws = tmp_path / "ws"
        ws.mkdir()

        item = {
            "url": "https://example.com/logo.png",
            "destPath": "assets/logo.png",
            "contentType": "image/png",
            "sizeBytes": 19,
        }

        monkeypatch.setattr(init_mod, "fetch_to_disk", _make_fetch_stub(tmp_path))
        monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        monkeypatch.setattr(
            sys, "argv",
            [INIT_PY, "--prompt", "remote asset test", "--remote-asset", json.dumps(item)],
        )

        project_path_str = None

        def _capture_print(*args, **kwargs):
            nonlocal project_path_str
            if args and str(args[0]).endswith("project.json"):
                project_path_str = str(args[0])
            _orig_print(*args, **kwargs)

        import builtins
        _orig_print = builtins.print
        monkeypatch.setattr(builtins, "print", _capture_print)

        init_mod.main()

        project = json.loads(Path(project_path_str).read_text())
        assert len(project["assets"]) == 1
        assert "logo.png" in project["assets"][0]["src"]

    def test_allowlist_unset_fails_when_remote_items_present(self, tmp_path, monkeypatch):
        """--remote-clip with MONTAJ_HTTP_ALLOWED_HOSTS unset → allowlist_unset fail."""
        import project.init as init_mod

        ws = tmp_path / "ws"
        ws.mkdir()

        item = {
            "url": "https://example.com/clip.mp4",
            "destPath": "clips/clip.mp4",
            "contentType": "video/mp4",
            "sizeBytes": 19,
        }

        monkeypatch.setattr(init_mod, "fetch_to_disk", _make_fetch_stub(tmp_path))
        monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
        # Unset the allowlist env var.
        monkeypatch.delenv("MONTAJ_HTTP_ALLOWED_HOSTS", raising=False)
        monkeypatch.setattr(
            sys, "argv",
            [INIT_PY, "--prompt", "no allowlist", "--remote-clip", json.dumps(item)],
        )

        with pytest.raises(SystemExit) as exc_info:
            init_mod.main()
        assert exc_info.value.code == 1

    def test_allowlist_unset_ok_when_no_remote_items(self, tmp_path, monkeypatch):
        """Local-only init (no remote items) does NOT fail when allowlist is unset."""
        import project.init as init_mod

        ws = tmp_path / "ws"
        ws.mkdir()
        clip = tmp_path / "local.mp4"
        clip.write_bytes(b"fake")

        monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
        monkeypatch.delenv("MONTAJ_HTTP_ALLOWED_HOSTS", raising=False)
        monkeypatch.setattr(
            sys, "argv",
            [INIT_PY, "--prompt", "local only", "--clips", str(clip)],
        )

        project_path_str = None

        def _capture_print(*args, **kwargs):
            nonlocal project_path_str
            if args and str(args[0]).endswith("project.json"):
                project_path_str = str(args[0])
            _orig_print(*args, **kwargs)

        import builtins
        _orig_print = builtins.print
        monkeypatch.setattr(builtins, "print", _capture_print)

        init_mod.main()  # Must not raise.
        assert project_path_str is not None

    def test_invalid_json_fails_with_invalid_remote_item(self, tmp_path, monkeypatch):
        """--remote-clip <invalid-json> → init fails with invalid_remote_item."""
        import project.init as init_mod

        ws = tmp_path / "ws"
        ws.mkdir()

        monkeypatch.setattr(init_mod, "fetch_to_disk", _make_fetch_stub(tmp_path))
        monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        monkeypatch.setattr(
            sys, "argv",
            [INIT_PY, "--prompt", "bad json", "--remote-clip", "{not valid json}"],
        )

        with pytest.raises(SystemExit) as exc_info:
            init_mod.main()
        assert exc_info.value.code == 1

    def test_missing_required_keys_fails(self, tmp_path, monkeypatch):
        """--remote-clip without required keys → invalid_remote_item fail."""
        import project.init as init_mod

        ws = tmp_path / "ws"
        ws.mkdir()

        # Missing contentType and sizeBytes.
        bad_item = json.dumps({"url": "https://example.com/clip.mp4", "destPath": "clips/c.mp4"})

        monkeypatch.setattr(init_mod, "fetch_to_disk", _make_fetch_stub(tmp_path))
        monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        monkeypatch.setattr(
            sys, "argv",
            [INIT_PY, "--prompt", "missing keys", "--remote-clip", bad_item],
        )

        with pytest.raises(SystemExit) as exc_info:
            init_mod.main()
        assert exc_info.value.code == 1

    def test_fetch_failure_cleans_up_project_dir(self, tmp_path, monkeypatch):
        """Fetch failure → init fails AND the partially-created project dir is removed."""
        import project.init as init_mod

        ws = tmp_path / "ws"
        ws.mkdir()

        item = {
            "url": "https://example.com/clip.mp4",
            "destPath": "clips/clip.mp4",
            "contentType": "video/mp4",
            "sizeBytes": 19,
        }

        monkeypatch.setattr(init_mod, "fetch_to_disk", _make_fetch_stub_failing("host_not_allowed"))
        monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        monkeypatch.setattr(
            sys, "argv",
            [INIT_PY, "--prompt", "fetch fail cleanup", "--remote-clip", json.dumps(item)],
        )

        with pytest.raises(SystemExit) as exc_info:
            init_mod.main()
        assert exc_info.value.code == 1

        # No project directories should remain in the workspace after the failure.
        leftover = list(ws.iterdir())
        assert leftover == [], (
            f"Partially-created project dir was not cleaned up: {leftover}"
        )

    def test_canvas_and_remote_clip_mutually_exclusive(self, tmp_path, monkeypatch):
        """--canvas and --remote-clip are mutually exclusive."""
        import project.init as init_mod

        ws = tmp_path / "ws"
        ws.mkdir()

        item = {
            "url": "https://example.com/clip.mp4",
            "destPath": "clips/clip.mp4",
            "contentType": "video/mp4",
            "sizeBytes": 19,
        }

        monkeypatch.setattr(init_mod, "fetch_to_disk", _make_fetch_stub(tmp_path))
        monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "example.com")
        monkeypatch.setattr(
            sys, "argv",
            [INIT_PY, "--prompt", "mutual exclusion",
             "--canvas", "--remote-clip", json.dumps(item)],
        )

        with pytest.raises(SystemExit) as exc_info:
            init_mod.main()
        assert exc_info.value.code == 1


# ── Section 3: --remote-clips-file on CLI wrapper (subprocess) ────────────────

class TestRemoteClipsFile:
    """Test --remote-clips-file on cli/commands/init.py (CLI wrapper, subprocess)."""

    def test_remote_clips_file_missing_gives_cli_error(self, tmp_path):
        """--remote-clips-file pointing at a nonexistent file → CLI-level error, no subprocess."""
        ws = tmp_path / "ws"
        ws.mkdir()
        result = _run_cli(
            "--prompt", "missing file test",
            "--remote-clips-file", str(tmp_path / "nonexistent.json"),
            env_override={"MONTAJ_WORKSPACE_DIR": str(ws)},
        )
        # Must fail (non-zero exit) and NOT have run project/init.py (no project dir created).
        assert result.returncode != 0
        assert not any(ws.iterdir()), "No project dir should exist after CLI-level failure"

    def test_remote_clips_file_not_a_list_gives_cli_error(self, tmp_path):
        """--remote-clips-file containing a JSON object (not array) → CLI-level error."""
        ws = tmp_path / "ws"
        ws.mkdir()
        bad_file = tmp_path / "bad.json"
        bad_file.write_text(json.dumps({"url": "https://example.com/x.mp4"}))
        result = _run_cli(
            "--prompt", "bad format test",
            "--remote-clips-file", str(bad_file),
            env_override={"MONTAJ_WORKSPACE_DIR": str(ws)},
        )
        assert result.returncode != 0

    def test_remote_clips_file_invalid_json_gives_cli_error(self, tmp_path):
        """--remote-clips-file containing invalid JSON → CLI-level error."""
        ws = tmp_path / "ws"
        ws.mkdir()
        bad_file = tmp_path / "bad.json"
        bad_file.write_text("{not valid")
        result = _run_cli(
            "--prompt", "invalid json file",
            "--remote-clips-file", str(bad_file),
            env_override={"MONTAJ_WORKSPACE_DIR": str(ws)},
        )
        assert result.returncode != 0

    def test_remote_clips_file_expands_to_multiple_remote_clip_args(self, tmp_path, monkeypatch):
        """--remote-clips-file expands to individual --remote-clip args.

        Verified by checking that project/init.py receives the items and (with a
        mocked fetch) produces a project with all clips staged. Since we can't
        monkeypatch across subprocess, this test calls the CLI wrapper's handle()
        directly via import + monkeypatch of subprocess.run.
        """
        import cli.commands.init as cli_init
        import lib.remote_io

        ws = tmp_path / "ws"
        ws.mkdir()

        items = [
            {"url": "https://example.com/a.mp4", "destPath": "clips/a.mp4",
             "contentType": "video/mp4", "sizeBytes": 19},
            {"url": "https://example.com/b.mp4", "destPath": "clips/b.mp4",
             "contentType": "video/mp4", "sizeBytes": 19},
        ]
        clips_file = tmp_path / "clips.json"
        clips_file.write_text(json.dumps(items))

        # Capture the subprocess.run call to verify the expanded args.
        captured_cmd = []

        def _fake_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            # Return a fake success result (no actual subprocess).
            import subprocess as _sp
            return _sp.CompletedProcess(cmd, 0, stdout="/fake/project.json\n", stderr="")

        monkeypatch.setattr("cli.commands.init.subprocess.run", _fake_run)
        monkeypatch.setattr(cli_init, "emit", lambda result, **kw: None)

        # Craft a fake args namespace.
        import argparse
        args = argparse.Namespace(
            prompt="file expansion test",
            workflow="clean_cut",
            name=None,
            project_path=None,
            color_space="auto",
            clips=[],
            assets=[],
            voiceover_asset=None,
            remote_clips=[],
            remote_assets=[],
            remote_clips_file=str(clips_file),
            remote_assets_file=None,
            json=False,
            quiet=False,
        )
        cli_init.handle(args)

        # The subprocess command must contain --remote-clip for each item.
        assert captured_cmd.count("--remote-clip") == 2
        # Verify both JSON strings appear somewhere in the cmd list.
        for item in items:
            assert json.dumps(item) in captured_cmd

    def test_remote_clips_file_and_remote_clip_concatenated(self, tmp_path, monkeypatch):
        """Both --remote-clip and --remote-clips-file apply (concatenated)."""
        import cli.commands.init as cli_init

        ws = tmp_path / "ws"
        ws.mkdir()

        extra_item = {
            "url": "https://example.com/extra.mp4", "destPath": "clips/extra.mp4",
            "contentType": "video/mp4", "sizeBytes": 19,
        }
        file_items = [
            {"url": "https://example.com/a.mp4", "destPath": "clips/a.mp4",
             "contentType": "video/mp4", "sizeBytes": 19},
        ]
        clips_file = tmp_path / "clips.json"
        clips_file.write_text(json.dumps(file_items))

        captured_cmd = []

        def _fake_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            import subprocess as _sp
            return _sp.CompletedProcess(cmd, 0, stdout="/fake/project.json\n", stderr="")

        monkeypatch.setattr("cli.commands.init.subprocess.run", _fake_run)
        monkeypatch.setattr(cli_init, "emit", lambda result, **kw: None)

        import argparse
        args = argparse.Namespace(
            prompt="concat test",
            workflow="clean_cut",
            name=None,
            project_path=None,
            color_space="auto",
            clips=[],
            assets=[],
            voiceover_asset=None,
            remote_clips=[json.dumps(extra_item)],
            remote_assets=[],
            remote_clips_file=str(clips_file),
            remote_assets_file=None,
            json=False,
            quiet=False,
        )
        cli_init.handle(args)

        # Should have 2 total: 1 from --remote-clip, 1 from --remote-clips-file.
        assert captured_cmd.count("--remote-clip") == 2


# ── Section 4: End-to-end subprocess tests (no network) ───────────────────────

class TestInitRemoteSubprocess:
    """End-to-end tests via subprocess on project/init.py with host-allowlist enforcement."""

    def test_init_invalid_json_remote_clip_via_subprocess(self, tmp_path):
        """--remote-clip with invalid JSON → init exits 1 via subprocess."""
        ws = tmp_path / "ws"
        ws.mkdir()
        result = _run_init_subprocess(
            "--prompt", "bad json",
            "--remote-clip", "{not json}",
            env_override={
                "MONTAJ_WORKSPACE_DIR": str(ws),
                "MONTAJ_HTTP_ALLOWED_HOSTS": "example.com",
            },
        )
        assert result.returncode != 0
        # Stderr must carry a structured JSON error.
        stderr_lines = [
            ln for ln in result.stderr.strip().split("\n")
            if ln.strip().startswith("{")
        ]
        assert stderr_lines, f"No JSON error in stderr: {result.stderr!r}"
        err = json.loads(stderr_lines[-1])
        assert err["error"] == "invalid_remote_item"

    def test_init_allowlist_unset_with_remote_clip_fails(self, tmp_path):
        """--remote-clip with MONTAJ_HTTP_ALLOWED_HOSTS unset → allowlist_unset error."""
        ws = tmp_path / "ws"
        ws.mkdir()
        item = json.dumps({
            "url": "https://example.com/clip.mp4",
            "destPath": "clips/clip.mp4",
            "contentType": "video/mp4",
            "sizeBytes": 19,
        })
        env = {k: v for k, v in os.environ.items() if k != "MONTAJ_HTTP_ALLOWED_HOSTS"}
        env["MONTAJ_WORKSPACE_DIR"] = str(ws)
        result = subprocess.run(
            [sys.executable, INIT_PY, "--prompt", "no allowlist", "--remote-clip", item],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode != 0
        stderr_lines = [
            ln for ln in result.stderr.strip().split("\n")
            if ln.strip().startswith("{")
        ]
        err = json.loads(stderr_lines[-1])
        assert err["error"] == "allowlist_unset"

    def test_init_local_only_succeeds_without_allowlist(self, tmp_path):
        """Local-only init (no --remote-clip) succeeds even when allowlist env is absent."""
        ws = tmp_path / "ws"
        ws.mkdir()
        clip = tmp_path / "clip.mp4"
        clip.write_bytes(b"fake")
        env = {k: v for k, v in os.environ.items() if k != "MONTAJ_HTTP_ALLOWED_HOSTS"}
        env["MONTAJ_WORKSPACE_DIR"] = str(ws)
        result = subprocess.run(
            [sys.executable, INIT_PY, "--prompt", "local only", "--clips", str(clip)],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode == 0, result.stderr


# ── Section 5: montaj upload command ──────────────────────────────────────────

class TestUpload:
    """Tests for cli/commands/upload.py — the `montaj upload` command."""

    # ── helpers ────────────────────────────────────────────────────────────────

    @staticmethod
    def _make_args(
        src=None,
        to=None,
        method="PUT",
        headers=None,
        uploads_file=None,
        json_flag=False,
        quiet=False,
    ):
        """Craft a fake argparse Namespace for upload.handle()."""
        import argparse
        return argparse.Namespace(
            src=src or [],
            to=to or [],
            method=method,
            headers=headers or [],
            uploads_file=uploads_file,
            json=json_flag,
            quiet=quiet,
            out=None,
        )

    @staticmethod
    def _push_stub_ok(items, project_dir, allowed_hosts, *, transport=None):
        """push_from_disk stub: all items succeed."""
        return [
            {"srcPath": item["srcPath"], "status": "ok", "bytesSent": 10, "upstreamStatus": 200}
            for item in items
        ]

    @staticmethod
    def _push_stub_error(items, project_dir, allowed_hosts, *, transport=None):
        """push_from_disk stub: all items fail."""
        return [
            {"srcPath": item["srcPath"], "status": "error", "error": "upstream_error",
             "upstreamStatus": 500, "message": "Upstream returned 500"}
            for item in items
        ]

    # ── happy paths ────────────────────────────────────────────────────────────

    def test_single_upload_paired_flags(self, tmp_path, monkeypatch, capsys):
        """Single --src/--to pair with mocked push → exit 0, JSON result on stdout."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr(upload_mod, "push_from_disk", self._push_stub_ok)

        args = self._make_args(
            src=["output/render.mp4"],
            to=["https://cdn.example.com/render.mp4?sig=abc"],
        )

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 0

        out = capsys.readouterr().out
        data = json.loads(out)
        assert "results" in data
        assert len(data["results"]) == 1
        assert data["results"][0]["status"] == "ok"
        assert data["results"][0]["srcPath"] == "output/render.mp4"

    def test_multiple_uploads_paired_flags(self, tmp_path, monkeypatch, capsys):
        """Two --src/--to pairs → both items sent to push_from_disk, exit 0."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")

        captured_items = []

        def _stub(items, project_dir, allowed_hosts, *, transport=None):
            captured_items.extend(items)
            return [
                {"srcPath": i["srcPath"], "status": "ok", "bytesSent": 10, "upstreamStatus": 200}
                for i in items
            ]

        monkeypatch.setattr(upload_mod, "push_from_disk", _stub)

        args = self._make_args(
            src=["output/render.mp4", "output/manifest.json"],
            to=["https://cdn.example.com/render.mp4", "https://cdn.example.com/manifest.json"],
        )

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 0

        assert len(captured_items) == 2
        assert captured_items[0]["srcPath"] == "output/render.mp4"
        assert captured_items[1]["srcPath"] == "output/manifest.json"

        out = capsys.readouterr().out
        data = json.loads(out)
        assert len(data["results"]) == 2

    def test_uploads_file_batch(self, tmp_path, monkeypatch, capsys):
        """--uploads-file with 2 items → push_from_disk receives those items, exit 0."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        uploads = [
            {"srcPath": "output/render.mp4",    "url": "https://cdn.example.com/render.mp4",
             "method": "PUT", "headers": {"Content-Type": "video/mp4"}},
            {"srcPath": "output/manifest.json", "url": "https://cdn.example.com/manifest.json",
             "headers": {"Content-Type": "application/json"}},
        ]
        uploads_file = tmp_path / "uploads.json"
        uploads_file.write_text(json.dumps(uploads))

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")

        captured_items = []

        def _stub(items, project_dir, allowed_hosts, *, transport=None):
            captured_items.extend(items)
            return [
                {"srcPath": i["srcPath"], "status": "ok", "bytesSent": 10, "upstreamStatus": 200}
                for i in items
            ]

        monkeypatch.setattr(upload_mod, "push_from_disk", _stub)

        args = self._make_args(uploads_file=str(uploads_file))

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 0

        assert len(captured_items) == 2
        assert captured_items[0]["srcPath"] == "output/render.mp4"
        assert captured_items[1]["srcPath"] == "output/manifest.json"

        out = capsys.readouterr().out
        data = json.loads(out)
        assert len(data["results"]) == 2

    def test_combined_paired_flags_and_uploads_file(self, tmp_path, monkeypatch, capsys):
        """Paired flags + --uploads-file → both contribute to items list (file appended after)."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        file_items = [
            {"srcPath": "output/manifest.json", "url": "https://cdn.example.com/manifest.json"},
        ]
        uploads_file = tmp_path / "uploads.json"
        uploads_file.write_text(json.dumps(file_items))

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")

        captured_items = []

        def _stub(items, project_dir, allowed_hosts, *, transport=None):
            captured_items.extend(items)
            return [
                {"srcPath": i["srcPath"], "status": "ok", "bytesSent": 10, "upstreamStatus": 200}
                for i in items
            ]

        monkeypatch.setattr(upload_mod, "push_from_disk", _stub)

        args = self._make_args(
            src=["output/render.mp4"],
            to=["https://cdn.example.com/render.mp4"],
            uploads_file=str(uploads_file),
        )

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 0

        # Flag item first, file item second.
        assert len(captured_items) == 2
        assert captured_items[0]["srcPath"] == "output/render.mp4"
        assert captured_items[1]["srcPath"] == "output/manifest.json"

    # ── validation errors ──────────────────────────────────────────────────────

    def test_mismatched_src_to_counts_gives_cli_error(self, tmp_path, monkeypatch, capsys):
        """--src a --src b --to one → emit_error before calling push_from_disk."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")

        push_called = []
        monkeypatch.setattr(upload_mod, "push_from_disk",
                            lambda *a, **kw: push_called.append(a) or [])

        args = self._make_args(
            src=["a.mp4", "b.mp4"],
            to=["https://cdn.example.com/one.mp4"],
        )

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 1
        assert push_called == [], "push_from_disk must not be called on validation error"

        err_output = capsys.readouterr().err
        err = json.loads(err_output.strip())
        assert err["error"] == "mismatched_arguments"

    def test_neither_src_nor_uploads_file_gives_cli_error(self, tmp_path, monkeypatch, capsys):
        """No --src and no --uploads-file → emit_error missing_argument."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")

        args = self._make_args()  # empty src, no uploads_file

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 1

        err_output = capsys.readouterr().err
        err = json.loads(err_output.strip())
        assert err["error"] == "missing_argument"

    def test_uploads_file_missing_gives_cli_error(self, tmp_path, monkeypatch, capsys):
        """--uploads-file pointing at nonexistent path → file_not_found, no push call."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")

        push_called = []
        monkeypatch.setattr(upload_mod, "push_from_disk",
                            lambda *a, **kw: push_called.append(a) or [])

        args = self._make_args(uploads_file=str(tmp_path / "nonexistent.json"))

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 1
        assert push_called == []

        err_output = capsys.readouterr().err
        err = json.loads(err_output.strip())
        assert err["error"] == "file_not_found"

    def test_allowlist_unset_gives_cli_error(self, tmp_path, monkeypatch, capsys):
        """MONTAJ_HTTP_ALLOWED_HOSTS not set → emit_error allowlist_unset."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("MONTAJ_HTTP_ALLOWED_HOSTS", raising=False)

        args = self._make_args(
            src=["output/render.mp4"],
            to=["https://cdn.example.com/render.mp4"],
        )

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 1

        err_output = capsys.readouterr().err
        err = json.loads(err_output.strip())
        assert err["error"] == "allowlist_unset"

    def test_no_project_json_gives_cli_error(self, tmp_path, monkeypatch, capsys):
        """CWD has no project.json and no workspace/ subdir → project_not_found error."""
        import cli.commands.upload as upload_mod

        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()
        monkeypatch.chdir(empty_dir)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")

        args = self._make_args(
            src=["output/render.mp4"],
            to=["https://cdn.example.com/render.mp4"],
        )

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 1

        err_output = capsys.readouterr().err
        err = json.loads(err_output.strip())
        assert err["error"] == "project_not_found"

    def test_per_upload_error_exits_nonzero_with_json(self, tmp_path, monkeypatch, capsys):
        """push_from_disk returns error for an item → exit 1, but JSON still printed."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")
        monkeypatch.setattr(upload_mod, "push_from_disk", self._push_stub_error)

        args = self._make_args(
            src=["output/render.mp4"],
            to=["https://cdn.example.com/render.mp4"],
        )

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 1

        out = capsys.readouterr().out
        data = json.loads(out)
        assert "results" in data
        assert data["results"][0]["status"] == "error"

    def test_quiet_suppresses_json_output_but_keeps_exit_code(self, tmp_path, monkeypatch, capsys):
        """--quiet suppresses JSON output but exit code still reflects result."""
        import cli.commands.upload as upload_mod

        project_json = tmp_path / "project.json"
        project_json.write_text('{"id": "test", "version": "0.2"}')

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")

        # Test quiet + success: exit 0, no output.
        monkeypatch.setattr(upload_mod, "push_from_disk", self._push_stub_ok)
        args = self._make_args(
            src=["output/render.mp4"],
            to=["https://cdn.example.com/render.mp4"],
            quiet=True,
        )
        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 0
        out = capsys.readouterr().out
        assert out.strip() == "", "quiet mode must suppress JSON output"

        # Test quiet + error: exit 1, still no JSON on stdout.
        monkeypatch.setattr(upload_mod, "push_from_disk", self._push_stub_error)
        args_quiet_err = self._make_args(
            src=["output/render.mp4"],
            to=["https://cdn.example.com/render.mp4"],
            quiet=True,
        )
        with pytest.raises(SystemExit) as exc_info2:
            upload_mod.handle(args_quiet_err)
        assert exc_info2.value.code == 1
        out2 = capsys.readouterr().out
        assert out2.strip() == "", "quiet mode must suppress JSON output even on error"

    # ── project resolution via workspace subdir ────────────────────────────────

    def test_project_resolution_from_workspace_subdir(self, tmp_path, monkeypatch, capsys):
        """project.json in workspace/ subdir is found when cwd has no direct project.json."""
        import cli.commands.upload as upload_mod

        workspace = tmp_path / "workspace" / "2024-01-01-my-project"
        workspace.mkdir(parents=True)
        project_json = workspace / "project.json"
        project_json.write_text('{"id": "ws-project", "version": "0.2"}')

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "cdn.example.com")

        captured_project_dirs = []

        def _stub(items, project_dir, allowed_hosts, *, transport=None):
            captured_project_dirs.append(project_dir)
            return [
                {"srcPath": i["srcPath"], "status": "ok", "bytesSent": 10, "upstreamStatus": 200}
                for i in items
            ]

        monkeypatch.setattr(upload_mod, "push_from_disk", _stub)

        args = self._make_args(
            src=["output/render.mp4"],
            to=["https://cdn.example.com/render.mp4"],
        )

        with pytest.raises(SystemExit) as exc_info:
            upload_mod.handle(args)
        assert exc_info.value.code == 0
        assert len(captured_project_dirs) == 1
        assert captured_project_dirs[0] == workspace
