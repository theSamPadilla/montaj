"""Shared sync + async HTTP I/O helpers: fetch remote files to disk and push
local files to remote URLs. Used by both CLI (sync) and server (async).

Entry points:
    fetch_to_disk(items, target_dir, allowed_hosts)          — sync
    fetch_to_disk_async(items, target_dir, allowed_hosts)    — async
    push_from_disk(items, project_dir, allowed_hosts)        — sync
    push_from_disk_async(items, project_dir, allowed_hosts)  — async
"""
import asyncio
import os
import secrets
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

# serve/common.py lives at the project root / serve/; add root to sys.path so
# imports work from both CLI and server contexts without package installation.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from serve.common import validate_project_subpath

_TIMEOUT = httpx.Timeout(connect=10, read=60, write=60, pool=10)
_MAX_WORKERS = 4
# Strip these caller-supplied headers in all directions.
_ALWAYS_STRIP = {"host"}


def parse_allowed_hosts() -> set[str]:
    """Read MONTAJ_HTTP_ALLOWED_HOSTS env var. Returns the parsed set
    (lowercased, whitespace-stripped, empty entries dropped). Returns
    an empty set if the env var is unset or empty after stripping —
    callers decide how to handle empty (fail-closed)."""
    raw = os.environ.get("MONTAJ_HTTP_ALLOWED_HOSTS", "").strip()
    if not raw:
        return set()
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


def _make_sync_client(transport=None) -> httpx.Client:
    kw = {"timeout": _TIMEOUT, "follow_redirects": False}
    if transport is not None:
        kw["transport"] = transport
    return httpx.Client(**kw)


def _make_async_client(transport=None) -> httpx.AsyncClient:
    kw = {"timeout": _TIMEOUT, "follow_redirects": False}
    if transport is not None:
        kw["transport"] = transport
    return httpx.AsyncClient(**kw)


def _content_type_matches(declared: str, actual: str) -> bool:
    if not declared or not actual:
        return False
    d = declared.split(";")[0].strip().lower()
    a = actual.split(";")[0].strip().lower()
    # Bare application/octet-stream declared is meaningless — reject.
    if d == "application/octet-stream":
        return False
    return d == a


def _check_preflight(url: str, allowed_hosts: set[str]) -> str | None:
    """Return error-code string if URL fails pre-flight; None if OK."""
    if not isinstance(url, str) or not url.startswith("https://"):
        return "not_https"
    hostname = (urlparse(url).hostname or "").lower()
    if hostname not in allowed_hosts:
        return "host_not_allowed"
    return None


def _build_headers(caller_headers: dict | None, strip_extra: set[str] | None = None) -> dict:
    strip = _ALWAYS_STRIP | (strip_extra or set())
    return {k: v for k, v in (caller_headers or {}).items() if k.lower() not in strip}


def _path_traversal_result(dest_key: str, path_val: str, exc: Exception) -> dict:
    detail = getattr(exc, "detail", {})
    msg = detail.get("message", str(exc)) if isinstance(detail, dict) else str(exc)
    return {dest_key: path_val, "status": "error", "error": "path_traversal", "message": msg}


# ── fetch ─────────────────────────────────────────────────────────────────────

def _do_fetch(item: dict, target_dir: Path, allowed_hosts: set[str],
              transport=None) -> dict:
    dest_path = item.get("destPath", "")
    url = item.get("url", "")
    declared_ct = item.get("contentType", "")
    size_bytes = item.get("sizeBytes", 0)
    method = item.get("method", "GET").upper()
    headers = _build_headers(item.get("headers"))

    err = _check_preflight(url, allowed_hosts)
    if err:
        return {"destPath": dest_path, "status": "error", "error": err,
                "message": f"URL failed pre-flight check: {url}"}

    try:
        dest = validate_project_subpath(target_dir, dest_path)
    except HTTPException as exc:
        return _path_traversal_result("destPath", dest_path, exc)

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f"{dest.name}.tmp.{secrets.token_hex(4)}"

    try:
        with _make_sync_client(transport) as client:
            with client.stream(method, url, headers=headers) as resp:
                if resp.status_code < 200 or resp.status_code >= 300:
                    return {"destPath": dest_path, "status": "error", "error": "upstream_error",
                            "upstreamStatus": resp.status_code,
                            "message": f"Upstream returned {resp.status_code}"}

                actual_ct = resp.headers.get("content-type", "")
                if not _content_type_matches(declared_ct, actual_ct):
                    return {"destPath": dest_path, "status": "error",
                            "error": "content_type_mismatch",
                            "message": f"Expected {declared_ct!r}, got {actual_ct!r}"}

                count = 0
                try:
                    with tmp.open("wb") as fh:
                        for chunk in resp.iter_bytes():
                            count += len(chunk)
                            if count > size_bytes:
                                fh.close()
                                tmp.unlink(missing_ok=True)
                                return {"destPath": dest_path, "status": "error",
                                        "error": "size_mismatch",
                                        "message": f"Response exceeded declared {size_bytes} bytes"}
                            fh.write(chunk)
                except OSError as exc:
                    tmp.unlink(missing_ok=True)
                    return {"destPath": dest_path, "status": "error", "error": "write_error",
                            "message": str(exc)}

                if count != size_bytes:
                    tmp.unlink(missing_ok=True)
                    return {"destPath": dest_path, "status": "error", "error": "size_mismatch",
                            "message": f"Expected {size_bytes} bytes, got {count}"}

                os.replace(tmp, dest)
                return {"destPath": dest_path, "status": "ok", "bytesWritten": count}

    except httpx.TimeoutException as exc:
        tmp.unlink(missing_ok=True)
        return {"destPath": dest_path, "status": "error", "error": "timeout", "message": str(exc)}
    except httpx.TransportError as exc:
        tmp.unlink(missing_ok=True)
        return {"destPath": dest_path, "status": "error", "error": "network_error", "message": str(exc)}
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        return {"destPath": dest_path, "status": "error", "error": "write_error", "message": str(exc)}


async def _do_fetch_async(item: dict, target_dir: Path, allowed_hosts: set[str],
                          sem: asyncio.Semaphore, transport=None) -> dict:
    async with sem:
        dest_path = item.get("destPath", "")
        url = item.get("url", "")
        declared_ct = item.get("contentType", "")
        size_bytes = item.get("sizeBytes", 0)
        method = item.get("method", "GET").upper()
        headers = _build_headers(item.get("headers"))

        err = _check_preflight(url, allowed_hosts)
        if err:
            return {"destPath": dest_path, "status": "error", "error": err,
                    "message": f"URL failed pre-flight check: {url}"}

        try:
            dest = validate_project_subpath(target_dir, dest_path)
        except HTTPException as exc:
            return _path_traversal_result("destPath", dest_path, exc)

        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / f"{dest.name}.tmp.{secrets.token_hex(4)}"

        try:
            async with _make_async_client(transport) as client:
                async with client.stream(method, url, headers=headers) as resp:
                    if resp.status_code < 200 or resp.status_code >= 300:
                        return {"destPath": dest_path, "status": "error", "error": "upstream_error",
                                "upstreamStatus": resp.status_code,
                                "message": f"Upstream returned {resp.status_code}"}

                    actual_ct = resp.headers.get("content-type", "")
                    if not _content_type_matches(declared_ct, actual_ct):
                        return {"destPath": dest_path, "status": "error",
                                "error": "content_type_mismatch",
                                "message": f"Expected {declared_ct!r}, got {actual_ct!r}"}

                    count = 0
                    try:
                        with tmp.open("wb") as fh:
                            async for chunk in resp.aiter_bytes():
                                count += len(chunk)
                                if count > size_bytes:
                                    fh.close()
                                    tmp.unlink(missing_ok=True)
                                    return {"destPath": dest_path, "status": "error",
                                            "error": "size_mismatch",
                                            "message": f"Response exceeded declared {size_bytes} bytes"}
                                fh.write(chunk)
                    except OSError as exc:
                        tmp.unlink(missing_ok=True)
                        return {"destPath": dest_path, "status": "error", "error": "write_error",
                                "message": str(exc)}

                    if count != size_bytes:
                        tmp.unlink(missing_ok=True)
                        return {"destPath": dest_path, "status": "error", "error": "size_mismatch",
                                "message": f"Expected {size_bytes} bytes, got {count}"}

                    os.replace(tmp, dest)
                    return {"destPath": dest_path, "status": "ok", "bytesWritten": count}

        except httpx.TimeoutException as exc:
            tmp.unlink(missing_ok=True)
            return {"destPath": dest_path, "status": "error", "error": "timeout", "message": str(exc)}
        except httpx.TransportError as exc:
            tmp.unlink(missing_ok=True)
            return {"destPath": dest_path, "status": "error", "error": "network_error", "message": str(exc)}
        except OSError as exc:
            tmp.unlink(missing_ok=True)
            return {"destPath": dest_path, "status": "error", "error": "write_error", "message": str(exc)}


# ── push ──────────────────────────────────────────────────────────────────────

def _file_iter(src: Path):
    """Yield 64-KiB chunks from *src* (sync). Module-level so tests can monkeypatch it."""
    with src.open("rb") as f:
        while chunk := f.read(1 << 16):
            yield chunk


async def _file_iter_async(src: Path):
    """Yield 64-KiB chunks from *src* (async). Module-level so tests can monkeypatch it."""
    with src.open("rb") as f:
        while chunk := f.read(1 << 16):
            yield chunk


def _do_push(item: dict, project_dir: Path, allowed_hosts: set[str],
             transport=None) -> dict:
    src_path = item.get("srcPath", "")
    url = item.get("url", "")
    method = item.get("method", "PUT").upper()

    err = _check_preflight(url, allowed_hosts)
    if err:
        return {"srcPath": src_path, "status": "error", "error": err,
                "message": f"URL failed pre-flight check: {url}"}

    try:
        src = validate_project_subpath(project_dir, src_path)
    except HTTPException as exc:
        return _path_traversal_result("srcPath", src_path, exc)

    if not src.exists() or not src.is_file():
        return {"srcPath": src_path, "status": "error", "error": "not_found",
                "message": f"Source file not found: {src_path}"}

    size = src.stat().st_size
    # Strip caller Content-Length; we set it from actual file size.
    headers = _build_headers(item.get("headers"), strip_extra={"content-length"})
    headers["Content-Length"] = str(size)

    try:
        with _make_sync_client(transport) as client:
            resp = client.request(method, url, headers=headers, content=_file_iter(src))
            etag = resp.headers.get("etag", "")
            result: dict = {
                "srcPath": src_path,
                "status": "ok" if 200 <= resp.status_code < 300 else "error",
                "bytesSent": size,
                "upstreamStatus": resp.status_code,
            }
            if etag:
                result["etag"] = etag
            if result["status"] == "error":
                result["error"] = "upstream_error"
                result["message"] = f"Upstream returned {resp.status_code}"
            return result
    except httpx.TimeoutException as exc:
        return {"srcPath": src_path, "status": "error", "error": "timeout", "message": str(exc)}
    except httpx.TransportError as exc:
        cause = exc.__cause__ or exc.__context__
        if isinstance(cause, OSError):
            return {"srcPath": src_path, "status": "error", "error": "read_error", "message": str(cause)}
        return {"srcPath": src_path, "status": "error", "error": "network_error", "message": str(exc)}
    except OSError as exc:
        return {"srcPath": src_path, "status": "error", "error": "read_error", "message": str(exc)}


async def _do_push_async(item: dict, project_dir: Path, allowed_hosts: set[str],
                         sem: asyncio.Semaphore, transport=None) -> dict:
    async with sem:
        src_path = item.get("srcPath", "")
        url = item.get("url", "")
        method = item.get("method", "PUT").upper()

        err = _check_preflight(url, allowed_hosts)
        if err:
            return {"srcPath": src_path, "status": "error", "error": err,
                    "message": f"URL failed pre-flight check: {url}"}

        try:
            src = validate_project_subpath(project_dir, src_path)
        except HTTPException as exc:
            return _path_traversal_result("srcPath", src_path, exc)

        if not src.exists() or not src.is_file():
            return {"srcPath": src_path, "status": "error", "error": "not_found",
                    "message": f"Source file not found: {src_path}"}

        size = src.stat().st_size
        headers = _build_headers(item.get("headers"), strip_extra={"content-length"})
        headers["Content-Length"] = str(size)

        try:
            async with _make_async_client(transport) as client:
                resp = await client.request(method, url, headers=headers, content=_file_iter_async(src))
                etag = resp.headers.get("etag", "")
                result: dict = {
                    "srcPath": src_path,
                    "status": "ok" if 200 <= resp.status_code < 300 else "error",
                    "bytesSent": size,
                    "upstreamStatus": resp.status_code,
                }
                if etag:
                    result["etag"] = etag
                if result["status"] == "error":
                    result["error"] = "upstream_error"
                    result["message"] = f"Upstream returned {resp.status_code}"
                return result
        except httpx.TimeoutException as exc:
            return {"srcPath": src_path, "status": "error", "error": "timeout", "message": str(exc)}
        except httpx.TransportError as exc:
            cause = exc.__cause__ or exc.__context__
            if isinstance(cause, OSError):
                return {"srcPath": src_path, "status": "error", "error": "read_error", "message": str(cause)}
            return {"srcPath": src_path, "status": "error", "error": "network_error", "message": str(exc)}
        except OSError as exc:
            return {"srcPath": src_path, "status": "error", "error": "read_error", "message": str(exc)}


# ── public entry points ───────────────────────────────────────────────────────

def fetch_to_disk(items: list[dict], target_dir: Path,
                  allowed_hosts: set[str], *, transport=None) -> list[dict]:
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        return list(pool.map(lambda i: _do_fetch(i, target_dir, allowed_hosts, transport), items))


async def fetch_to_disk_async(items: list[dict], target_dir: Path,
                              allowed_hosts: set[str], *, transport=None) -> list[dict]:
    sem = asyncio.Semaphore(_MAX_WORKERS)
    return list(await asyncio.gather(
        *(_do_fetch_async(i, target_dir, allowed_hosts, sem, transport) for i in items)
    ))


def push_from_disk(items: list[dict], project_dir: Path,
                   allowed_hosts: set[str], *, transport=None) -> list[dict]:
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        return list(pool.map(lambda i: _do_push(i, project_dir, allowed_hosts, transport), items))


async def push_from_disk_async(items: list[dict], project_dir: Path,
                               allowed_hosts: set[str], *, transport=None) -> list[dict]:
    sem = asyncio.Semaphore(_MAX_WORKERS)
    return list(await asyncio.gather(
        *(_do_push_async(i, project_dir, allowed_hosts, sem, transport) for i in items)
    ))
