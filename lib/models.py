#!/usr/bin/env python3
"""Generic helper for downloading and verifying AI model weights and binaries.

All Montaj-managed assets live under ~/.local/share/montaj/models/{family}/.
"""
import hashlib
import json
import os
import stat
import sys
import urllib.request


# Monkeypatchable in tests
MONTAJ_MODELS_DIR = os.path.expanduser("~/.local/share/montaj/models")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def models_dir(family: str) -> str:
    """Return the directory for a model family."""
    return os.path.join(MONTAJ_MODELS_DIR, family)


def model_path(family: str, filename: str) -> str:
    """Return the full path to a specific model file."""
    return os.path.join(models_dir(family), filename)


def is_downloaded(family: str, filename: str) -> bool:
    """Return True if the model file already exists on disk."""
    return os.path.isfile(model_path(family, filename))


def ensure_model(family: str, filename: str, url: str, checksum: str | None) -> str:
    """Download model on first use, verify SHA-256, return local path.

    - If checksum is None, SHA-256 verification is skipped.
    - On checksum mismatch: delete and re-download once, then fail.
    - On download failure: fail with a clear message including the URL.
    """
    dest = model_path(family, filename)

    if os.path.isfile(dest):
        if checksum is None or _sha256(dest) == checksum:
            return dest
        # Checksum mismatch — delete and re-download once
        os.remove(dest)
        _download_and_verify(family, filename, url, checksum, is_retry=True)
    else:
        _download_and_verify(family, filename, url, checksum, is_retry=False)

    return dest


def ensure_binary(family: str, filename: str, url: str, checksum: str | None) -> str:
    """Like ensure_model but also sets chmod 755 on the file."""
    dest = ensure_model(family, filename, url, checksum)
    current = os.stat(dest).st_mode
    os.chmod(dest, current | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
             | stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH
             | stat.S_IWUSR)
    return dest


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _download_and_verify(family: str, filename: str, url: str, checksum: str | None, *, is_retry: bool):
    """Download a file and verify its checksum. Calls _fail on any error."""
    dest = model_path(family, filename)
    os.makedirs(models_dir(family), exist_ok=True)

    try:
        _download(url, dest)
    except Exception as exc:
        _fail(f"Failed to download {filename} from {url}: {exc}")

    if checksum is not None and _sha256(dest) != checksum:
        os.remove(dest)
        label = "re-downloaded" if is_retry else "downloaded"
        _fail(
            f"SHA-256 mismatch for {label} file {filename}. "
            f"Expected {checksum}. The download may be corrupt or the URL has changed. URL: {url}"
        )


def _download(url: str, dest: str):
    """Download url to dest using a .part temp file; show progress to stderr."""
    part = dest + ".part"
    try:
        def _reporthook(block_num, block_size, total_size):
            downloaded = block_num * block_size
            if total_size > 0:
                pct = min(100, downloaded * 100 // total_size)
                mb = downloaded / (1024 * 1024)
                total_mb = total_size / (1024 * 1024)
                print(
                    f"\r  Downloading {os.path.basename(dest)}: {pct}% ({mb:.1f}/{total_mb:.1f} MB)",
                    end="",
                    file=sys.stderr,
                    flush=True,
                )
            else:
                mb = downloaded / (1024 * 1024)
                print(
                    f"\r  Downloading {os.path.basename(dest)}: {mb:.1f} MB",
                    end="",
                    file=sys.stderr,
                    flush=True,
                )

        urllib.request.urlretrieve(url, part, reporthook=_reporthook)
        print(file=sys.stderr)  # newline after progress
        os.replace(part, dest)
    except Exception:
        if os.path.exists(part):
            try:
                os.remove(part)
            except OSError:
                pass
        raise


def _sha256(path: str) -> str:
    """Return the SHA-256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _fail(message: str):
    """Print structured error to stderr and exit 1.

    Intentionally self-contained (does not call common.fail) so that models.py
    can be imported standalone without pulling in the rest of lib/ — useful for
    scripts or tools that only need model management.
    """
    print(json.dumps({"error": "model_download_failed", "message": message}), file=sys.stderr)
    sys.exit(1)
