"""Tests for lib/remote_io.py (sync + async fetch/push) and
serve/common.validate_project_subpath + lib/remote_io._content_type_matches."""
import asyncio
import sys
from pathlib import Path

import httpx
import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

import lib.remote_io as rio
from lib.remote_io import (
    _content_type_matches,
    fetch_to_disk,
    fetch_to_disk_async,
    push_from_disk,
    push_from_disk_async,
)
from serve.common import validate_project_subpath


# ── fixtures ───────────────────────────────────────────────────────────────────

ALLOWED = {"example.com"}
BODY = b"12345678"  # 8 bytes


def _make_transport(handler):
    """Return a MockTransport wrapping *handler* for use as transport= kwarg."""
    return httpx.MockTransport(handler)


# ── helpers ────────────────────────────────────────────────────────────────────

def _make_fetch_item(dest: str, url: str = "https://example.com/file.mp4",
                     content_type: str = "video/mp4", size: int = 8,
                     **kw) -> dict:
    return {"url": url, "destPath": dest, "contentType": content_type, "sizeBytes": size, **kw}


def _make_push_item(src: str, url: str = "https://example.com/upload",
                    **kw) -> dict:
    return {"srcPath": src, "url": url, **kw}


def _sync_fetch(items, target_dir, allowed=ALLOWED, transport=None):
    return fetch_to_disk(items, target_dir, allowed, transport=transport)


def _async_fetch(items, target_dir, allowed=ALLOWED, transport=None):
    return asyncio.run(fetch_to_disk_async(items, target_dir, allowed, transport=transport))


def _sync_push(items, project_dir, allowed=ALLOWED, transport=None):
    return push_from_disk(items, project_dir, allowed, transport=transport)


def _async_push(items, project_dir, allowed=ALLOWED, transport=None):
    return asyncio.run(push_from_disk_async(items, project_dir, allowed, transport=transport))


# Parametrize over sync and async so every case exercises both code paths.
FETCH_VARIANTS = [pytest.param(_sync_fetch, id="sync"), pytest.param(_async_fetch, id="async")]
PUSH_VARIANTS  = [pytest.param(_sync_push,  id="sync"), pytest.param(_async_push,  id="async")]


# ── _content_type_matches unit tests ──────────────────────────────────────────

class TestContentTypeMatches:
    def test_exact_match(self):
        assert _content_type_matches("video/mp4", "video/mp4")

    def test_parameter_suffix_ignored(self):
        assert _content_type_matches("video/mp4", "video/mp4; codecs=avc1")

    def test_case_insensitive(self):
        assert _content_type_matches("Video/MP4", "video/mp4")

    def test_mismatch(self):
        assert not _content_type_matches("video/mp4", "text/html")

    def test_bare_octet_stream_declared_never_matches_itself(self):
        assert not _content_type_matches("application/octet-stream", "application/octet-stream")

    def test_bare_octet_stream_declared_never_matches_other(self):
        assert not _content_type_matches("application/octet-stream", "video/mp4")

    def test_empty_declared(self):
        assert not _content_type_matches("", "video/mp4")

    def test_empty_actual(self):
        assert not _content_type_matches("video/mp4", "")

    def test_both_empty(self):
        assert not _content_type_matches("", "")


# ── validate_project_subpath unit tests ───────────────────────────────────────

class TestValidateProjectSubpath:
    def test_valid_relative_path(self, tmp_path):
        result = validate_project_subpath(tmp_path, "clips/foo.mp4")
        assert result == (tmp_path / "clips" / "foo.mp4").resolve()

    def test_empty_string_rejected(self, tmp_path):
        with pytest.raises(Exception) as exc:
            validate_project_subpath(tmp_path, "")
        assert "path_traversal" in str(exc.value.detail)

    def test_whitespace_only_rejected(self, tmp_path):
        with pytest.raises(Exception):
            validate_project_subpath(tmp_path, "   ")

    def test_pure_dot_rejected(self, tmp_path):
        with pytest.raises(Exception):
            validate_project_subpath(tmp_path, ".")

    def test_dot_dot_rejected(self, tmp_path):
        with pytest.raises(Exception):
            validate_project_subpath(tmp_path, "..")

    def test_absolute_path_rejected(self, tmp_path):
        with pytest.raises(Exception):
            validate_project_subpath(tmp_path, "/etc/passwd")

    def test_parent_escape_rejected(self, tmp_path):
        with pytest.raises(Exception):
            validate_project_subpath(tmp_path, "clips/../../escape.mp4")

    def test_project_dir_itself_rejected(self, tmp_path):
        with pytest.raises(Exception):
            validate_project_subpath(tmp_path, "clips/..")

    def test_symlink_traversal_rejected(self, tmp_path):
        outside = tmp_path.parent / "_outside_vsp"
        outside.mkdir(exist_ok=True)
        link = tmp_path / "link"
        link.symlink_to(outside)
        with pytest.raises(Exception):
            validate_project_subpath(tmp_path, "link/../../../_outside_vsp/secret.txt")

    def test_non_string_rejected(self, tmp_path):
        with pytest.raises(Exception):
            validate_project_subpath(tmp_path, 123)


# ── fetch: happy path ─────────────────────────────────────────────────────────

def _ok_handler(body=BODY, status=200, content_type="video/mp4"):
    def handler(request):
        return httpx.Response(status, headers={"content-type": content_type}, content=body)
    return handler


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_happy_path_single(tmp_path, run_fetch):
    transport = _make_transport(_ok_handler())
    items = [_make_fetch_item("out.mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path, transport=transport)
    assert len(results) == 1
    r = results[0]
    assert r["status"] == "ok"
    assert r["bytesWritten"] == len(BODY)
    assert (tmp_path / "out.mp4").read_bytes() == BODY


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_happy_path_multi_order_preserved(tmp_path, run_fetch):
    transport = _make_transport(_ok_handler())
    items = [_make_fetch_item(f"file{i}.mp4", size=len(BODY)) for i in range(5)]
    results = run_fetch(items, tmp_path, transport=transport)
    assert [r["destPath"] for r in results] == [f"file{i}.mp4" for i in range(5)]
    assert all(r["status"] == "ok" for r in results)


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_method_override(tmp_path, run_fetch):
    seen_methods = []

    def handler(request):
        seen_methods.append(request.method)
        return httpx.Response(200, headers={"content-type": "video/mp4"}, content=BODY)

    transport = _make_transport(handler)
    items = [_make_fetch_item("out.mp4", size=len(BODY), method="POST")]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    assert seen_methods == ["POST"]


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_caller_headers_passed_through(tmp_path, run_fetch):
    seen_auth = []

    def handler(request):
        seen_auth.append(request.headers.get("authorization", ""))
        return httpx.Response(200, headers={"content-type": "video/mp4"}, content=BODY)

    transport = _make_transport(handler)
    items = [_make_fetch_item("out.mp4", size=len(BODY), headers={"Authorization": "Bearer xyz"})]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    assert seen_auth == ["Bearer xyz"]


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_host_header_stripped(tmp_path, run_fetch):
    seen_hosts = []

    def handler(request):
        seen_hosts.append(request.headers.get("host", ""))
        return httpx.Response(200, headers={"content-type": "video/mp4"}, content=BODY)

    transport = _make_transport(handler)
    items = [_make_fetch_item("out.mp4", size=len(BODY), headers={"Host": "169.254.169.254"})]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    # The wire host must be the URL's own hostname, not the injected SSRF value.
    assert seen_hosts[0] != "169.254.169.254"


# ── fetch: pre-flight failures ─────────────────────────────────────────────────

@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_allowlist_empty_all_fail(tmp_path, run_fetch):
    items = [_make_fetch_item("out.mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path, allowed=set())
    assert results[0]["status"] == "error"
    assert results[0]["error"] == "host_not_allowed"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_host_not_in_allowlist(tmp_path, run_fetch):
    items = [_make_fetch_item("out.mp4", url="https://evil.com/file.mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path, allowed={"example.com"})
    assert results[0]["error"] == "host_not_allowed"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_not_https(tmp_path, run_fetch):
    items = [_make_fetch_item("out.mp4", url="http://example.com/file.mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path)
    assert results[0]["error"] == "not_https"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_dest_absolute_path_traversal(tmp_path, run_fetch):
    items = [_make_fetch_item("/etc/passwd", size=len(BODY))]
    results = run_fetch(items, tmp_path)
    assert results[0]["error"] == "path_traversal"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_dest_parent_escape_traversal(tmp_path, run_fetch):
    items = [_make_fetch_item("clips/../../escape.mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path)
    assert results[0]["error"] == "path_traversal"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
@pytest.mark.parametrize("bad_path", ["", ".", "..", "./", "../"])
def test_fetch_dest_empty_or_dot(tmp_path, run_fetch, bad_path):
    items = [_make_fetch_item(bad_path, size=len(BODY))]
    results = run_fetch(items, tmp_path)
    assert results[0]["error"] == "path_traversal"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_dest_symlink_traversal(tmp_path, run_fetch):
    outside = tmp_path.parent / "_outside_rio_fetch"
    outside.mkdir(exist_ok=True)
    link = tmp_path / "linkout"
    link.symlink_to(outside)
    items = [_make_fetch_item("linkout/../../../_outside_rio_fetch/evil.mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path)
    assert results[0]["error"] == "path_traversal"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_creates_subdir(tmp_path, run_fetch):
    transport = _make_transport(_ok_handler())
    assert not (tmp_path / "clips").exists()
    items = [_make_fetch_item("clips/foo.mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    assert (tmp_path / "clips" / "foo.mp4").exists()


# ── fetch: content-type / size checks ─────────────────────────────────────────

@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_content_type_mismatch(tmp_path, run_fetch):
    transport = _make_transport(_ok_handler(content_type="text/html"))
    items = [_make_fetch_item("out.mp4", content_type="video/mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["error"] == "content_type_mismatch"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_content_type_with_params_matches(tmp_path, run_fetch):
    transport = _make_transport(_ok_handler(content_type="video/mp4; codecs=avc1"))
    items = [_make_fetch_item("out.mp4", content_type="video/mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_octet_stream_declared_fails(tmp_path, run_fetch):
    transport = _make_transport(_ok_handler(content_type="application/octet-stream"))
    items = [_make_fetch_item("out.mp4", content_type="application/octet-stream", size=len(BODY))]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["error"] == "content_type_mismatch"


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_size_mismatch_too_small(tmp_path, run_fetch):
    transport = _make_transport(_ok_handler(body=b"abc"))
    items = [_make_fetch_item("out.mp4", size=10)]  # declared 10, server sends 3
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["error"] == "size_mismatch"
    assert not (tmp_path / "out.mp4").exists()


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_size_mismatch_too_large(tmp_path, run_fetch):
    transport = _make_transport(_ok_handler(body=b"x" * 20))
    items = [_make_fetch_item("out.mp4", size=5)]  # declared 5, server sends 20
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["error"] == "size_mismatch"
    assert not (tmp_path / "out.mp4").exists()


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_upstream_5xx(tmp_path, run_fetch):
    transport = _make_transport(lambda request: httpx.Response(503, content=b"Service Unavailable"))
    items = [_make_fetch_item("out.mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["error"] == "upstream_error"
    assert results[0]["upstreamStatus"] == 503


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_timeout(tmp_path, run_fetch):
    def handler(request):
        raise httpx.TimeoutException("timed out", request=request)

    transport = _make_transport(handler)
    items = [_make_fetch_item("out.mp4", size=len(BODY))]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["error"] == "timeout"
    assert not (tmp_path / "out.mp4").exists()


@pytest.mark.parametrize("run_fetch", FETCH_VARIANTS)
def test_fetch_existing_file_preserved_on_failure(tmp_path, run_fetch):
    """Pre-existing file at destPath must be intact when re-fetch fails."""
    original = b"original_content"
    dest = tmp_path / "out.mp4"
    dest.write_bytes(original)

    # Server returns 3 bytes; we declare 10 → size_mismatch, temp removed, dest untouched.
    transport = _make_transport(_ok_handler(body=b"abc"))
    items = [_make_fetch_item("out.mp4", size=10)]
    results = run_fetch(items, tmp_path, transport=transport)
    assert results[0]["error"] == "size_mismatch"
    assert dest.read_bytes() == original


# ── push: happy path ──────────────────────────────────────────────────────────

def _ok_push_handler(status=200, etag='"abc123"'):
    def handler(request):
        hdrs = {"ETag": etag} if etag else {}
        return httpx.Response(status, headers=hdrs)
    return handler


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_happy_path_single(tmp_path, run_push):
    src = tmp_path / "output.mp4"
    src.write_bytes(b"data1234")
    transport = _make_transport(_ok_push_handler())
    items = [_make_push_item("output.mp4")]
    results = run_push(items, tmp_path, transport=transport)
    r = results[0]
    assert r["status"] == "ok"
    assert r["bytesSent"] == len(b"data1234")
    assert r["upstreamStatus"] == 200
    assert r.get("etag") == '"abc123"'


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_happy_path_multi_order_preserved(tmp_path, run_push):
    for i in range(5):
        (tmp_path / f"file{i}.mp4").write_bytes(b"data")
    transport = _make_transport(_ok_push_handler(etag=""))
    items = [_make_push_item(f"file{i}.mp4") for i in range(5)]
    results = run_push(items, tmp_path, transport=transport)
    assert [r["srcPath"] for r in results] == [f"file{i}.mp4" for i in range(5)]
    assert all(r["status"] == "ok" for r in results)


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_method_override(tmp_path, run_push):
    src = tmp_path / "out.mp4"
    src.write_bytes(b"data")
    seen = []

    def handler(request):
        seen.append(request.method)
        return httpx.Response(200)

    transport = _make_transport(handler)
    items = [_make_push_item("out.mp4", method="POST")]
    results = run_push(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    assert seen == ["POST"]


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_caller_headers_passed_through(tmp_path, run_push):
    src = tmp_path / "out.mp4"
    src.write_bytes(b"data")
    seen_sig = []
    seen_auth = []

    def handler(request):
        seen_sig.append(request.headers.get("x-hub-signature", ""))
        seen_auth.append(request.headers.get("authorization", ""))
        return httpx.Response(200)

    transport = _make_transport(handler)
    items = [_make_push_item("out.mp4", headers={"X-Hub-Signature": "sha256=abc",
                                                   "Authorization": "Bearer tok"})]
    results = run_push(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    assert seen_sig[0] == "sha256=abc"
    assert seen_auth[0] == "Bearer tok"


# ── push: pre-flight / path failures ─────────────────────────────────────────

@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_src_not_found(tmp_path, run_push):
    items = [_make_push_item("nonexistent.mp4")]
    results = run_push(items, tmp_path)
    assert results[0]["error"] == "not_found"


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_src_is_directory(tmp_path, run_push):
    (tmp_path / "adir").mkdir()
    items = [_make_push_item("adir")]
    results = run_push(items, tmp_path)
    assert results[0]["error"] == "not_found"


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_src_traversal(tmp_path, run_push):
    items = [_make_push_item("../../etc/passwd")]
    results = run_push(items, tmp_path)
    assert results[0]["error"] == "path_traversal"


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_allowlist_empty(tmp_path, run_push):
    src = tmp_path / "out.mp4"
    src.write_bytes(b"data")
    items = [_make_push_item("out.mp4")]
    results = run_push(items, tmp_path, allowed=set())
    assert results[0]["error"] == "host_not_allowed"


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_not_https(tmp_path, run_push):
    src = tmp_path / "out.mp4"
    src.write_bytes(b"data")
    items = [_make_push_item("out.mp4", url="http://example.com/upload")]
    results = run_push(items, tmp_path)
    assert results[0]["error"] == "not_https"


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_upstream_error(tmp_path, run_push):
    src = tmp_path / "out.mp4"
    src.write_bytes(b"data")
    transport = _make_transport(lambda request: httpx.Response(403))
    items = [_make_push_item("out.mp4")]
    results = run_push(items, tmp_path, transport=transport)
    r = results[0]
    assert r["error"] == "upstream_error"
    assert r["upstreamStatus"] == 403


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_no_etag_omitted(tmp_path, run_push):
    src = tmp_path / "out.mp4"
    src.write_bytes(b"data")
    transport = _make_transport(_ok_push_handler(etag=""))
    items = [_make_push_item("out.mp4")]
    results = run_push(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    assert "etag" not in results[0]


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_content_length_overridden(tmp_path, run_push):
    """Caller-supplied Content-Length is replaced with actual file size."""
    real_data = b"hello world"
    src = tmp_path / "out.mp4"
    src.write_bytes(real_data)
    seen_cl = []

    def handler(request):
        seen_cl.append(request.headers.get("content-length", ""))
        return httpx.Response(200)

    transport = _make_transport(handler)
    items = [_make_push_item("out.mp4", headers={"Content-Length": "99999"})]
    results = run_push(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    assert seen_cl[0] == str(len(real_data))


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_host_header_stripped(tmp_path, run_push):
    src = tmp_path / "out.mp4"
    src.write_bytes(b"data")
    seen_host = []

    def handler(request):
        seen_host.append(request.headers.get("host", ""))
        return httpx.Response(200)

    transport = _make_transport(handler)
    items = [_make_push_item("out.mp4", headers={"Host": "169.254.169.254"})]
    results = run_push(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    assert seen_host[0] != "169.254.169.254"


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_wire_format_content_length_not_chunked(tmp_path, run_push):
    """Push must use Content-Length (not Transfer-Encoding: chunked)."""
    data = b"testdata" * 100
    src = tmp_path / "out.mp4"
    src.write_bytes(data)
    seen_cl = []
    seen_te = []

    def handler(request):
        seen_cl.append(request.headers.get("content-length", ""))
        seen_te.append(request.headers.get("transfer-encoding", ""))
        return httpx.Response(200)

    transport = _make_transport(handler)
    items = [_make_push_item("out.mp4")]
    results = run_push(items, tmp_path, transport=transport)
    assert results[0]["status"] == "ok"
    assert seen_cl[0] == str(len(data))
    assert "chunked" not in seen_te[0].lower()


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_timeout(tmp_path, run_push):
    src = tmp_path / "out.mp4"
    src.write_bytes(b"data")

    def handler(request):
        raise httpx.TimeoutException("timed out", request=request)

    transport = _make_transport(handler)
    items = [_make_push_item("out.mp4")]
    results = run_push(items, tmp_path, transport=transport)
    assert results[0]["error"] == "timeout"


@pytest.mark.parametrize("run_push", PUSH_VARIANTS)
def test_push_mid_stream_read_failure(tmp_path, monkeypatch, run_push):
    """OSError from the file generator must surface as read_error."""
    src = tmp_path / "out.mp4"
    src.write_bytes(b"x" * (1 << 17))  # > 64KB — ensures at least 2 chunks

    def _failing_iter(path):
        yield b"first chunk"
        raise OSError("simulated mid-stream read failure")

    async def _failing_iter_async(path):
        yield b"first chunk"
        raise OSError("simulated mid-stream read failure")

    monkeypatch.setattr(rio, "_file_iter", _failing_iter)
    monkeypatch.setattr(rio, "_file_iter_async", _failing_iter_async)

    def handler(request):
        try:
            b"".join(request.stream)
        except Exception:
            pass
        return httpx.Response(200)

    transport = _make_transport(handler)
    items = [_make_push_item("out.mp4")]
    results = run_push(items, tmp_path, transport=transport)
    assert results[0]["status"] == "error"
    assert results[0]["error"] == "read_error"
