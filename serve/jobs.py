"""In-process registry for async step jobs.

Jobs are held in a module-level dict and are ephemeral: a server restart drops
them. That's acceptable on the single-instance sidecar — there is exactly one
process serving the API, so there is no cross-process state to reconcile, and a
restart already aborts any in-flight subprocess.
"""
import uuid


_STEP_JOBS: dict[str, dict] = {}


def create_job(step: str | None = None) -> str:
    """Register a new running job and return its id. `step` is the step it runs
    (POST /api/steps/{name} passes the route's name); every other job has None.
    The record keeps it through done and error, so a poll can tell which step a
    job is."""
    job_id = uuid.uuid4().hex
    _STEP_JOBS[job_id] = {"status": "running", "step": step}
    return job_id


def _step_of(job_id: str) -> str | None:
    return (_STEP_JOBS.get(job_id) or {}).get("step")


def set_done(job_id: str, result) -> None:
    """Mark a job done with its wrap_output result payload (its step kept)."""
    _STEP_JOBS[job_id] = {"status": "done", "step": _step_of(job_id), "result": result}


def set_error(job_id: str, err) -> None:
    """Mark a job failed with its (already-scrubbed) error detail (its step kept)."""
    _STEP_JOBS[job_id] = {"status": "error", "step": _step_of(job_id), "error": err}


def get_job(job_id: str) -> dict | None:
    """Return the job record, or None if unknown."""
    return _STEP_JOBS.get(job_id)
