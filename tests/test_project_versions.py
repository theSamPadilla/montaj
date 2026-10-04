"""lib/project_versions.commit_version: real git in a tmp repo."""
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.project_versions import commit_version

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not on PATH")


def _git(d, *args):
    return subprocess.run(["git", *args], cwd=str(d), capture_output=True, text=True, check=True).stdout


@pytest.fixture
def repo(tmp_path):
    _git(tmp_path, "init", "-q")
    (tmp_path / "project.json").write_text('{"v": 1}')
    return tmp_path


def _count(d):
    out = _git(d, "rev-list", "--all", "--count").strip()
    return int(out)


def test_commits_once(repo):
    assert commit_version(repo, "version: first") is True
    assert _count(repo) == 1
    assert _git(repo, "log", "-1", "--format=%s|%an|%ae|%cn|%ce").strip() == \
        "version: first|montaj|montaj@local|montaj|montaj@local"


def test_no_change_returns_false_without_commit(repo):
    assert commit_version(repo, "a") is True
    assert commit_version(repo, "b") is False
    assert _count(repo) == 1


def test_change_after_commit_commits_again(repo):
    commit_version(repo, "a")
    (repo / "project.json").write_text('{"v": 2}')
    assert commit_version(repo, "b") is True
    assert _count(repo) == 2


def test_git_missing_returns_false(repo, monkeypatch):
    empty = repo / "empty-bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    assert commit_version(repo, "x") is False
