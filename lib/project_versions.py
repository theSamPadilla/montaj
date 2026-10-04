"""Version snapshots of a project: a git commit of project.json."""
import os
import subprocess
from pathlib import Path


def commit_version(project_dir, message) -> bool:
    """git add project.json; commit only if something is staged.

    Author and committer are montaj <montaj@local>. Blocking: call via
    asyncio.to_thread from async code. Returns True when a commit was made;
    False when nothing changed, when git is missing (FileNotFoundError), or
    when a git call fails.
    """
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "montaj", "GIT_AUTHOR_EMAIL": "montaj@local",
        "GIT_COMMITTER_NAME": "montaj", "GIT_COMMITTER_EMAIL": "montaj@local",
    }
    cwd = str(Path(project_dir))
    try:
        added = subprocess.run(["git", "add", "project.json"], cwd=cwd, env=env,
                               capture_output=True)
        if added.returncode != 0:
            return False
        staged = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=cwd, env=env,
                                capture_output=True)
        if staged.returncode == 0:
            return False  # nothing staged
        if staged.returncode != 1:
            return False  # diff itself failed
        done = subprocess.run(["git", "commit", "-m", message], cwd=cwd, env=env,
                              capture_output=True)
        return done.returncode == 0
    except FileNotFoundError:
        return False
