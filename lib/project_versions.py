"""Version snapshots of a project: a git commit of project.json."""
import os
import subprocess
from pathlib import Path


def _env() -> dict:
    return {
        **os.environ,
        "GIT_AUTHOR_NAME": "montaj", "GIT_AUTHOR_EMAIL": "montaj@local",
        "GIT_COMMITTER_NAME": "montaj", "GIT_COMMITTER_EMAIL": "montaj@local",
    }


def is_own_repo(project_dir) -> bool:
    """True when the project folder is the root of its own git repo. A folder inside someone else's
    repo is not: a version there would commit into that repo's history."""
    try:
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(Path(project_dir)),
                             env=_env(), capture_output=True, text=True)
    except FileNotFoundError:
        return False
    return top.returncode == 0 and os.path.realpath(top.stdout.strip()) == os.path.realpath(str(project_dir))


def commit_version(project_dir, message) -> bool:
    """git add project.json; commit project.json only, and only if it changed.

    Does nothing (False) when the project folder is not the root of its own git repo, so a project
    nested in another repo never writes into that repo's history or takes its staged files.

    Author and committer are montaj <montaj@local>. Blocking: call via
    asyncio.to_thread from async code. Returns True when a commit was made;
    False when nothing changed, when git is missing (FileNotFoundError), or
    when a git call fails.
    """
    env = _env()
    cwd = str(Path(project_dir))
    if not is_own_repo(project_dir):
        return False
    try:
        added = subprocess.run(["git", "add", "project.json"], cwd=cwd, env=env,
                               capture_output=True)
        if added.returncode != 0:
            return False
        staged = subprocess.run(["git", "diff", "--cached", "--quiet", "--", "project.json"], cwd=cwd, env=env,
                                capture_output=True)
        if staged.returncode == 0:
            return False  # nothing staged
        if staged.returncode != 1:
            return False  # diff itself failed
        done = subprocess.run(["git", "commit", "-m", message, "--", "project.json"], cwd=cwd, env=env,
                              capture_output=True)
        return done.returncode == 0
    except FileNotFoundError:
        return False
