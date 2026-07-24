"""Shared HTTP helpers for connectors.

Bounded retry with exponential backoff on transient failures (connection
errors, timeouts, 429/5xx), plus a streamed file download. Kept dependency-lazy
like the rest of connectors/: `requests` is only imported when a helper runs.
"""
import os
import time

from connectors import ConnectorError

# Module-level so tests (and callers) can tune them.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_S = 2.0  # attempt n sleeps RETRY_BACKOFF_S * 2**n
TRANSIENT_STATUS = frozenset({429, 500, 502, 503, 504})


def _require_requests():
    try:
        import requests
        return requests
    except ImportError:
        raise ConnectorError("Missing connector dependencies. Run: montaj install connectors")


def request_with_retry(method: str, url: str, *, attempts: int = None,
                       retry_statuses: frozenset = TRANSIENT_STATUS,
                       retry_exceptions: bool = True, **kwargs):
    """`requests.request` with bounded retry on transient failures.

    Retries on connection errors/timeouts (unless ``retry_exceptions`` is
    False — use that for non-idempotent POSTs where a timed-out request may
    have been accepted server-side) and on ``retry_statuses`` responses.
    Non-transient HTTP error responses are RETURNED, not raised, so callers
    keep their own status/body handling.
    """
    requests = _require_requests()
    n = attempts or RETRY_ATTEMPTS
    for attempt in range(n):
        last = attempt == n - 1
        try:
            r = requests.request(method, url, **kwargs)
        except requests.RequestException as e:
            if not retry_exceptions or last:
                raise ConnectorError(
                    f"{method} {url} failed"
                    + (f" after {n} attempts" if retry_exceptions else "")
                    + f": {e}"
                ) from e
        else:
            if r.status_code not in retry_statuses or last:
                return r
        time.sleep(RETRY_BACKOFF_S * (2 ** attempt))


def download_file(url: str, out_path: str, *, timeout: int = 120) -> str:
    """Stream a URL to out_path (1 MiB chunks), with transient-failure retry."""
    r = request_with_retry("GET", url, stream=True, timeout=timeout)
    if r.status_code >= 400:
        raise ConnectorError(f"Download failed (HTTP {r.status_code}): {url}")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=1 << 20):
            f.write(chunk)
    return out_path
