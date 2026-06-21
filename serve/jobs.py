"""In-process registry for async step jobs.

Jobs are held in a module-level dict and are ephemeral: a server restart drops
them. That's acceptable on the single-instance sidecar — there is exactly one
process serving the API, so there is no cross-process state to reconcile, and a
restart already aborts any in-flight subprocess.
"""
import uuid


_STEP_JOBS: dict[str, dict] = {}


def create_job() -> str:
    """Register a new running job and return its id."""
    job_id = uuid.uuid4().hex
    _STEP_JOBS[job_id] = {"status": "running"}
    return job_id


def set_done(job_id: str, result) -> None:
    """Mark a job done with its wrap_output result payload."""
    _STEP_JOBS[job_id] = {"status": "done", "result": result}


def set_error(job_id: str, err) -> None:
    """Mark a job failed with its (already-scrubbed) error detail."""
    _STEP_JOBS[job_id] = {"status": "error", "error": err}


def get_job(job_id: str) -> dict | None:
    """Return the job record, or None if unknown."""
    return _STEP_JOBS.get(job_id)
