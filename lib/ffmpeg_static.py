#!/usr/bin/env python3
"""Managed static ffmpeg/ffprobe download.

Downloads pinned, checksum-verified static builds (with libzimg/zscale) from
https://ffmpeg.martin-riedl.de into the managed models dir
(~/.local/share/montaj/models/ffmpeg/), following the same convention as the
whisper binary and RVM weights. `montaj install ffmpeg` calls ensure_ffmpeg();
lib.common.ffmpeg_bin() resolves to the managed binary when present.

Version bumps are a deliberate constants change here (build_id + sha256 per
platform), never an ambient system upgrade.
"""
import os, platform, sys, zipfile

# When imported as part of the `lib` package (e.g. `from lib import ffmpeg_static`
# in tests), reuse the already-loaded `lib.models` module so monkeypatching one
# name (`lib.models` or `models`) is visible everywhere. When run standalone
# (no parent package — the convention used by cli/*.py and steps/*.py), fall
# back to the sys.path + bare-import style used throughout the rest of lib/.
try:
    from . import models
except ImportError:
    sys.path.insert(0, os.path.dirname(__file__))
    import models

BASE_URL = "https://ffmpeg.martin-riedl.de/download"

# (os, arch) -> pinned build. Verified 2026-07-20; config includes --enable-libzimg.
PINNED_BUILDS = {
    ("macos", "arm64"): {
        "build_id": "1783011502_8.1.2",
        "ffmpeg_sha256":  "ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c",
        "ffprobe_sha256": "c39787f4af7a3932502d2d48db6f6feaaa836b48a73ef78c32cc3285df61dfaf",
    },
    ("macos", "amd64"): {
        "build_id": "1783018342_8.1.2",
        "ffmpeg_sha256":  "a52ef43883f44c219766d4b3bdde4e635b35465d0b704c01c3a0566b59775df9",
        "ffprobe_sha256": "5408ca588c8c72b0dde3afe676d0a7acf25ef97e55ae6eba5c7bede1cda42695",
    },
    ("linux", "amd64"): {
        "build_id": "1783011670_8.1.2",
        "ffmpeg_sha256":  "56452c0bfc4ee0325cd615d62f46ba8264f62eed34f727c2224c6c84fa7b8719",
        "ffprobe_sha256": "c6f2d36e98f9a4445fad0b0be539f4c4faf13fd502116bf131becd53f56cd390",
    },
    ("linux", "arm64"): {
        "build_id": "1783010599_8.1.2",
        "ffmpeg_sha256":  "ab9e16864b6bf4ae7e13bbdbdc29621be11a5c547c57af8d4250e9fa2f5e6461",
        "ffprobe_sha256": "fb78317b81cdeb614533be59e489019b754afd199670666af28f0e9574be395b",
    },
}


class UnsupportedPlatform(Exception):
    pass


class ChecksumMismatch(Exception):
    pass


def _install_ua_opener():
    """Install a default urllib opener with a descriptive User-Agent.

    ffmpeg.martin-riedl.de sits behind Cloudflare, which 403s urllib's default
    "Python-urllib/x.y" User-Agent (curl and browsers work fine). Installing a
    global opener keeps the urlretrieve(url, dest) call signature unchanged —
    important because tests monkeypatch urllib.request.urlretrieve directly and
    match on the plain string url.
    """
    import urllib.request
    opener = urllib.request.build_opener()
    opener.addheaders = [("User-Agent", "montaj-ffmpeg-static/1.0 (+https://montaj.ag)")]
    urllib.request.install_opener(opener)


def _platform_key():
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Darwin":
        os_key = "macos"
    elif system == "Linux":
        os_key = "linux"
    else:
        raise UnsupportedPlatform(f"no static ffmpeg build for {system}")
    if machine in ("arm64", "aarch64"):
        arch = "arm64"
    elif machine in ("x86_64", "amd64"):
        arch = "amd64"
    else:
        raise UnsupportedPlatform(f"no static ffmpeg build for {system}/{machine}")
    return (os_key, arch)


def _zip_url(key, build_id, name):
    os_key, arch = key
    return f"{BASE_URL}/{os_key}/{arch}/{build_id}/{name}.zip"


def bin_dir():
    return models.models_dir("ffmpeg")


def managed_path(name):
    """Path where the managed binary lives (whether or not it exists yet)."""
    return os.path.join(bin_dir(), name)


def is_installed():
    """True when both binaries exist and the stamp matches the pinned build."""
    key = _platform_key()
    build_id = PINNED_BUILDS[key]["build_id"]
    stamp = os.path.join(bin_dir(), ".build_id")
    try:
        if open(stamp).read().strip() != build_id:
            return False
    except FileNotFoundError:
        return False
    return all(os.access(managed_path(n), os.X_OK) for n in ("ffmpeg", "ffprobe"))


def ensure_ffmpeg():
    """Download + verify + extract the pinned ffmpeg/ffprobe for this platform.

    Idempotent via the .build_id stamp. Returns {"ffmpeg": path, "ffprobe": path}.
    """
    key = _platform_key()
    entry = PINNED_BUILDS[key]
    dest_dir = bin_dir()
    os.makedirs(dest_dir, exist_ok=True)

    if is_installed():
        return {n: managed_path(n) for n in ("ffmpeg", "ffprobe")}

    _install_ua_opener()
    out = {}
    for name in ("ffmpeg", "ffprobe"):
        url = _zip_url(key, entry["build_id"], name)
        zip_tmp = os.path.join(dest_dir, f"{name}.zip.part.{os.getpid()}")
        import urllib.request
        urllib.request.urlretrieve(url, zip_tmp)
        digest = models._sha256(zip_tmp)
        if digest != entry[f"{name}_sha256"]:
            os.unlink(zip_tmp)
            raise ChecksumMismatch(
                f"{name}.zip sha256 {digest} != pinned {entry[f'{name}_sha256']}")
        out[name] = _extract_zip(zip_tmp, dest_dir, name)
        os.unlink(zip_tmp)

    with open(os.path.join(dest_dir, ".build_id"), "w") as f:
        f.write(entry["build_id"])
    return out


def _extract_zip(zip_path, dest_dir, name):
    """Extract the single binary from the zip, atomic-place it, chmod 755."""
    tmp = os.path.join(dest_dir, f".{name}.tmp.{os.getpid()}")
    with zipfile.ZipFile(zip_path) as z:
        members = [m for m in z.namelist() if os.path.basename(m) == name]
        if not members:
            raise ChecksumMismatch(f"{name} not found inside {zip_path}")
        with z.open(members[0]) as src, open(tmp, "wb") as dst:
            dst.write(src.read())
    os.chmod(tmp, 0o755)
    final = os.path.join(dest_dir, name)
    os.replace(tmp, final)
    return final
