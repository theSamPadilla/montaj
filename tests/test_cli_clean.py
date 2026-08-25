"""Tests for `montaj clean --proxies`.

Pattern: call handle() directly with a synthesized argparse.Namespace for
filesystem behavior (matches test_cli_profile_asset.py); HOME is monkeypatched
to tmp_path so ~/Montaj and ~/.montaj/config.json resolution stays inside the
sandbox. A couple of subprocess-level tests cover argparse wiring.
"""
import json
import subprocess
import sys
from argparse import Namespace

import pytest

import cli.commands.clean as clean_cmd
from tests.conftest import REPO_ROOT


def _ns(**kwargs):
    """Build a Namespace with clean's defaults, overridden by kwargs."""
    defaults = {
        "proxies": True, "project": None, "all_projects": False,
        # yes=True here so the pre-existing delete-behavior tests keep their
        # meaning; the SP3-fix-S6 safe default (bare command = list only) has
        # its own explicit tests in TestYesGate below.
        "dry_run": False, "yes": True, "json": False, "out": None, "quiet": False,
    }
    defaults.update(kwargs)
    return Namespace(**defaults)


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("MONTAJ_WORKSPACE_DIR", raising=False)
    return tmp_path


@pytest.fixture
def project_dir(home, monkeypatch):
    """cwd = a project directory under the default workspace root (~/Montaj)."""
    d = home / "Montaj" / "myproj"
    d.mkdir(parents=True)
    (d / "project.json").write_text("{}")
    monkeypatch.chdir(d)
    return d


# ---------------------------------------------------------------------------
# glob matching — only *_proxy_*.mp4 is ever touched
# ---------------------------------------------------------------------------

class TestGlobMatch:
    def test_deletes_only_proxy_named_files(self, project_dir):
        proxy      = project_dir / "clip_proxy_hable1.mp4"
        normalized = project_dir / "clip_normalized.mp4"
        bare_proxy = project_dir / "proxy.mp4"
        wrong_ext  = project_dir / "clip_proxy_hable1.mov"
        for f in (proxy, normalized, bare_proxy, wrong_ext):
            f.write_bytes(b"x" * 1024)

        clean_cmd.handle(_ns())

        assert not proxy.exists()
        assert normalized.exists()
        assert bare_proxy.exists()
        assert wrong_ext.exists()

    def test_deletes_both_proxy_naming_generations(self, project_dir):
        """PROXY_RE's optional `(_h264)?` group covers both proxy-naming
        generations: the pre-AV1->H.264-switch name (`_proxy_<look>.mp4`) and
        the post-switch name (`_proxy_<look>_h264.mp4`) — both must be
        reclaimable, so an old proxy left over from before an upgrade doesn't
        become permanently unclaimable."""
        old_gen = project_dir / f"clip_proxy_{clean_cmd.PROXY_LOOK}.mp4"
        new_gen = project_dir / f"clip_proxy_{clean_cmd.PROXY_LOOK}_h264.mp4"
        old_gen.write_bytes(b"x" * 1024)
        new_gen.write_bytes(b"y" * 1024)

        clean_cmd.handle(_ns())

        assert not old_gen.exists()
        assert not new_gen.exists()

    def test_h264_tagged_lookalike_with_unknown_look_survives(self, project_dir):
        """A file that merely LOOKS like the new h264-tagged generation but
        carries a look tag that isn't in KNOWN_LOOKS must survive, same as
        the untagged-format lookalikes already covered above."""
        lookalike = project_dir / "clip_proxy_unknownlook99x_h264.mp4"
        lookalike.write_bytes(b"x" * 1024)

        clean_cmd.handle(_ns())

        assert lookalike.exists()

    def test_matches_nested_proxy_files(self, project_dir):
        nested = project_dir / "clips" / "sub" / "a_proxy_hable1.mp4"
        nested.parent.mkdir(parents=True)
        nested.write_bytes(b"x")

        clean_cmd.handle(_ns())

        assert not nested.exists()


# ---------------------------------------------------------------------------
# --dry-run
# ---------------------------------------------------------------------------

class TestDryRun:
    def test_dry_run_leaves_files_in_place(self, project_dir):
        proxy = project_dir / "clip_proxy_hable1.mp4"
        proxy.write_bytes(b"x" * 1024)

        clean_cmd.handle(_ns(dry_run=True))

        assert proxy.exists()

    def test_dry_run_json_marks_undeleted(self, project_dir, capsys):
        proxy = project_dir / "clip_proxy_hable1.mp4"
        proxy.write_bytes(b"x" * 2048)

        clean_cmd.handle(_ns(dry_run=True, json=True))

        out = json.loads(capsys.readouterr().out)
        assert len(out) == 1
        assert out[0]["path"] == str(proxy)
        assert out[0]["bytes"] == 2048
        assert out[0]["deleted"] is False

    def test_real_run_json_marks_deleted(self, project_dir, capsys):
        proxy = project_dir / "clip_proxy_hable1.mp4"
        proxy.write_bytes(b"x" * 512)

        clean_cmd.handle(_ns(json=True))

        out = json.loads(capsys.readouterr().out)
        assert out[0]["deleted"] is True
        assert not proxy.exists()

    def test_human_output_prints_size(self, project_dir, capsys):
        proxy = project_dir / "clip_proxy_hable1.mp4"
        proxy.write_bytes(b"x" * 2048)

        clean_cmd.handle(_ns())

        out = capsys.readouterr().out
        assert "clip_proxy_hable1.mp4" in out
        assert "KB" in out


# ---------------------------------------------------------------------------
# scan scope: current project (default) / --project / --all-projects / .sources
# ---------------------------------------------------------------------------

class TestScope:
    def test_no_project_found_errors(self, home, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)  # no project.json, no workspace/ subdir
        with pytest.raises(SystemExit) as exc:
            clean_cmd.handle(_ns())
        assert exc.value.code == 1

    def test_project_flag_scopes_to_given_dir(self, home, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)  # cwd itself has no project.json
        other = home / "Montaj" / "other"
        other.mkdir(parents=True)
        (other / "project.json").write_text("{}")  # S4: --project requires a real project dir
        target = other / "clip_proxy_hable1.mp4"
        target.write_bytes(b"x")

        clean_cmd.handle(_ns(project=str(other)))

        assert not target.exists()

    def test_default_scope_ignores_sibling_project(self, project_dir, home):
        sibling = home / "Montaj" / "sibling"
        sibling.mkdir(parents=True)
        untouched = sibling / "clip_proxy_hable1.mp4"
        untouched.write_bytes(b"x")

        clean_cmd.handle(_ns())  # default scope = project_dir only (+ .sources)

        assert untouched.exists()

    def test_all_projects_scans_whole_workspace(self, home, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        proj_a = home / "Montaj" / "a"
        proj_b = home / "Montaj" / "b"
        proj_a.mkdir(parents=True)
        proj_b.mkdir(parents=True)
        (proj_a / "clip_proxy_hable1.mp4").write_bytes(b"x")
        (proj_b / "clip_proxy_hable1.mp4").write_bytes(b"y")

        clean_cmd.handle(_ns(all_projects=True))

        assert not (proj_a / "clip_proxy_hable1.mp4").exists()
        assert not (proj_b / "clip_proxy_hable1.mp4").exists()

    def test_sources_dir_always_scanned(self, project_dir, home):
        shared = home / "Montaj" / ".sources" / "abc123" / "clip_proxy_hable1.mp4"
        shared.parent.mkdir(parents=True)
        shared.write_bytes(b"x")

        clean_cmd.handle(_ns())  # default scope; .sources/ is always included

        assert not shared.exists()

    def test_project_dir_not_found_errors(self, home, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        with pytest.raises(SystemExit) as exc:
            clean_cmd.handle(_ns(project=str(tmp_path / "does-not-exist")))
        assert exc.value.code == 1

    def test_project_pointing_at_workspace_root_dedupes_sources_overlap(
        self, home, tmp_path, monkeypatch, capsys
    ):
        """--project <workspace_root> makes .sources/ a *descendant* of the
        scan root (not an exact-realpath duplicate of it), so
        os.walk(workspace_root) already yields files under .sources/ once,
        and the explicit .sources/ root yields them again. Without
        file-level dedup this double-deletes and raises FileNotFoundError
        on the second os.remove()."""
        monkeypatch.chdir(tmp_path)  # cwd irrelevant since --project is passed
        workspace_root = home / "Montaj"
        proxy = workspace_root / ".sources" / "abc123" / "clip_proxy_hable1.mp4"
        proxy.parent.mkdir(parents=True)
        proxy.write_bytes(b"x" * 1024)
        # S4 requires --project to be a real project dir; a project.json AT the
        # workspace root is the (unusual but legal) layout that still produces
        # the ancestor-overlap this test exists to cover.
        (workspace_root / "project.json").write_text("{}")

        clean_cmd.handle(_ns(project=str(workspace_root), json=True))

        out = json.loads(capsys.readouterr().out)
        assert len(out) == 1
        assert not proxy.exists()

    def test_project_pointing_at_workspace_root_dry_run_dedupes_sources_overlap(
        self, home, tmp_path, monkeypatch, capsys
    ):
        monkeypatch.chdir(tmp_path)
        workspace_root = home / "Montaj"
        proxy = workspace_root / ".sources" / "abc123" / "clip_proxy_hable1.mp4"
        proxy.parent.mkdir(parents=True)
        proxy.write_bytes(b"x" * 1024)
        (workspace_root / "project.json").write_text("{}")  # satisfy the S4 guard

        clean_cmd.handle(_ns(project=str(workspace_root), dry_run=True, json=True))

        out = json.loads(capsys.readouterr().out)
        assert len(out) == 1
        assert proxy.exists()


# ---------------------------------------------------------------------------
# proxySrc pointer cleanup — a deleted proxy must not leave a dangling
# pointer in project.json (timeline-core would keep selecting it and the
# preview <video> has no error fallback, so the clip goes black).
# ---------------------------------------------------------------------------

class TestProxySrcStripping:
    def test_strips_dangling_proxy_src_from_project_json(self, project_dir):
        proxy = project_dir / "clip_proxy_hable1.mp4"
        proxy.write_bytes(b"x")
        project_json = project_dir / "project.json"
        project_json.write_text(json.dumps({
            "tracks": [[{"id": "c1", "type": "video", "src": "/orig.mp4", "proxySrc": str(proxy)}]],
        }))

        clean_cmd.handle(_ns())

        assert not proxy.exists()
        data = json.loads(project_json.read_text())
        assert "proxySrc" not in data["tracks"][0][0]

    def test_dry_run_leaves_project_json_untouched(self, project_dir):
        proxy = project_dir / "clip_proxy_hable1.mp4"
        proxy.write_bytes(b"x")
        project_json = project_dir / "project.json"
        original = json.dumps({
            "tracks": [[{"id": "c1", "type": "video", "src": "/orig.mp4", "proxySrc": str(proxy)}]],
        })
        project_json.write_text(original)

        clean_cmd.handle(_ns(dry_run=True))

        assert proxy.exists()
        assert project_json.read_text() == original

    def test_keeps_proxy_src_pointing_at_a_different_surviving_proxy(self, project_dir, home):
        deleted_proxy = project_dir / "a_proxy_hable1.mp4"
        deleted_proxy.write_bytes(b"x")

        # Out of scope for this scan (default scope = project_dir + .sources
        # only), so clean never touches it -- proves stripping is keyed on the
        # actual deleted-paths set, not "any proxySrc field looks dangling".
        sibling = home / "Montaj" / "sibling"
        sibling.mkdir(parents=True)
        surviving_proxy = sibling / "b_proxy_hable1.mp4"
        surviving_proxy.write_bytes(b"y")

        project_json = project_dir / "project.json"
        project_json.write_text(json.dumps({
            "tracks": [[
                {"id": "c1", "type": "video", "src": "/orig1.mp4", "proxySrc": str(deleted_proxy)},
                {"id": "c2", "type": "video", "src": "/orig2.mp4", "proxySrc": str(surviving_proxy)},
            ]],
        }))

        clean_cmd.handle(_ns())

        assert not deleted_proxy.exists()
        assert surviving_proxy.exists()
        data = json.loads(project_json.read_text())
        assert "proxySrc" not in data["tracks"][0][0]
        assert data["tracks"][0][1]["proxySrc"] == str(surviving_proxy)

    def test_malformed_project_json_does_not_crash(self, project_dir):
        proxy = project_dir / "clip_proxy_hable1.mp4"
        proxy.write_bytes(b"x")
        (project_dir / "project.json").write_text("{not valid json")

        clean_cmd.handle(_ns())  # must not raise

        assert not proxy.exists()


# ---------------------------------------------------------------------------
# superseded normalized masters — an untagged tone-mapped master
# (*_normalized_sdr_bt709.mp4) that has gained a look-tagged sibling
# (*_normalized_sdr_bt709_<look>.mp4) is a stale leftover from before that
# look existed. Without a tagged sibling it's a live master and must survive.
# ---------------------------------------------------------------------------

class TestSupersededMasters:
    def test_untagged_master_with_tagged_sibling_is_deleted(self, project_dir):
        untagged = project_dir / "clip_normalized_sdr_bt709.mp4"
        tagged = project_dir / f"clip_normalized_sdr_bt709_{clean_cmd.PROXY_LOOK}.mp4"
        untagged.write_bytes(b"x" * 1024)
        tagged.write_bytes(b"y" * 1024)

        clean_cmd.handle(_ns())

        assert not untagged.exists()
        assert tagged.exists()

    def test_untagged_master_without_tagged_sibling_survives(self, project_dir):
        """CAREFUL case: a plain *_normalized_sdr_bt709.mp4 with no tagged
        sibling is a legitimate current SDR-source conformance master —
        it must never be listed, let alone deleted."""
        untagged = project_dir / "clip_normalized_sdr_bt709.mp4"
        untagged.write_bytes(b"x" * 1024)

        clean_cmd.handle(_ns())

        assert untagged.exists()

    def test_untagged_master_with_only_hable1_tagged_sibling_is_deleted(self, project_dir):
        """The historical hable1 tag also counts as a superseding sibling —
        KNOWN_LOOKS covers every look that's ever shipped, not just the
        current one."""
        untagged = project_dir / "clip_normalized_sdr_bt709.mp4"
        tagged = project_dir / "clip_normalized_sdr_bt709_hable1.mp4"
        untagged.write_bytes(b"x" * 1024)
        tagged.write_bytes(b"y" * 1024)

        clean_cmd.handle(_ns())

        assert not untagged.exists()
        assert tagged.exists()

    def test_untagged_master_dry_run_lists_but_does_not_delete(self, project_dir, capsys):
        untagged = project_dir / "clip_normalized_sdr_bt709.mp4"
        tagged = project_dir / f"clip_normalized_sdr_bt709_{clean_cmd.PROXY_LOOK}.mp4"
        untagged.write_bytes(b"x" * 1024)
        tagged.write_bytes(b"y" * 1024)

        clean_cmd.handle(_ns(dry_run=True, json=True))

        out = json.loads(capsys.readouterr().out)
        assert len(out) == 1
        assert out[0]["path"] == str(untagged)
        assert out[0]["deleted"] is False
        assert untagged.exists()

    def test_untagged_master_bare_command_without_yes_lists_only(self, project_dir):
        """SP3 fix S6's safe default applies equally to superseded masters:
        no --yes, no deletion."""
        untagged = project_dir / "clip_normalized_sdr_bt709.mp4"
        tagged = project_dir / f"clip_normalized_sdr_bt709_{clean_cmd.PROXY_LOOK}.mp4"
        untagged.write_bytes(b"x" * 1024)
        tagged.write_bytes(b"y" * 1024)

        clean_cmd.handle(_ns(yes=False))

        assert untagged.exists()

    def test_unrelated_normalized_files_are_never_matched(self, project_dir):
        """Other color spaces / other normalize outputs never match — the
        pattern is scoped to *_normalized_sdr_bt709.mp4 specifically, since
        that's the only master lib/normalize.py ever look-tags."""
        keep = [
            project_dir / "clip_normalized_hdr_hlg.mp4",
            project_dir / "clip_normalized_sdr_bt709_vivid1-neutral.mp4",  # tagged, not untagged
            project_dir / "clip.mp4",
        ]
        for f in keep:
            f.write_bytes(b"x" * 1024)

        clean_cmd.handle(_ns())

        for f in keep:
            assert f.exists(), f.name


# ---------------------------------------------------------------------------
# argparse wiring
# ---------------------------------------------------------------------------

def _run(*args):
    return subprocess.run(
        [sys.executable, "-m", "cli.main", *args],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )


class TestArgparseWiring:
    def test_bare_command_without_yes_lists_but_does_not_delete(self, project_dir, capsys):
        """SP3 fix S6: deletion requires an explicit --yes; the bare command is
        a safe listing."""
        proxy = project_dir / "clip_proxy_hable1.mp4"
        proxy.write_bytes(b"x" * 1024)
        clean_cmd.handle(_ns(yes=False))
        assert proxy.exists()
        out = capsys.readouterr().out
        assert "pass --yes to delete" in out

    def test_dry_run_beats_yes(self, project_dir):
        proxy = project_dir / "clip_proxy_hable1.mp4"
        proxy.write_bytes(b"x" * 1024)
        clean_cmd.handle(_ns(yes=True, dry_run=True))
        assert proxy.exists()

    def test_unknown_look_tags_and_user_proxy_names_survive(self, project_dir):
        """SP3 fix S5: only KNOWN look tags are deleted — user files that merely
        contain '_proxy_' and unknown-tagged files all survive."""
        keep = [
            project_dir / "reverse_proxy_demo.mp4",   # user file, matches old loose glob
            project_dir / "nginx_proxy_test.mp4",     # user file
            project_dir / "_proxy_.mp4",              # empty look tag
            project_dir / "clip_proxy_unknownlook99x.mp4",  # not in KNOWN_LOOKS
        ]
        goner = project_dir / "clip_proxy_hable1.mp4"
        for f in keep + [goner]:
            f.write_bytes(b"x" * 1024)
        clean_cmd.handle(_ns())
        assert not goner.exists()
        for f in keep:
            assert f.exists(), f.name

    def test_project_without_project_json_errors(self, home, tmp_path, monkeypatch):
        """SP3 fix S4: --project must point at a real project dir, not any
        directory — prevents recursive delete walks over e.g. $HOME."""
        arbitrary = tmp_path / "not-a-project"
        arbitrary.mkdir()
        monkeypatch.chdir(tmp_path)
        with pytest.raises(SystemExit):
            clean_cmd.handle(_ns(project=str(arbitrary)))

    def test_proxies_flag_is_required(self):
        r = _run("clean")
        assert r.returncode != 0
        assert "--proxies" in r.stderr

    def test_project_and_all_projects_are_mutually_exclusive(self):
        r = _run("clean", "--proxies", "--project", "/tmp", "--all-projects")
        assert r.returncode != 0
        assert "not allowed with" in r.stderr

    def test_clean_is_visible_in_top_level_help(self):
        r = _run("--help")
        assert r.returncode == 0
        assert "clean" in r.stdout
