#!/usr/bin/env python3
"""Managed static ffmpeg/ffprobe download.

Downloads pinned, checksum-verified static builds (with libzimg/zscale) into
the managed models dir (~/.local/share/montaj/models/ffmpeg/), following the
same convention as the whisper binary and RVM weights. `montaj install ffmpeg`
calls ensure_ffmpeg(); lib.common.ffmpeg_bin() resolves to the managed binary
when present.

Two providers, because no single one publishes all five targets:

  * macOS + Linux: https://ffmpeg.martin-riedl.de. One zip per binary, each
    pinned by its own sha256 ("per-binary" entries: ffmpeg_sha256 /
    ffprobe_sha256). It publishes no Windows builds.
  * Windows x64: gyan.dev, via its immutable versioned GitHub release assets
    (GyanD/codexffmpeg), "essentials" variant, GPLv3. One zip holding both
    binaries under a versioned folder ("archive" entries: archive_urls /
    archive_sha256 / members, extracted by exact member path). archive_urls
    are tried in order; each download is verified against the one digest.
    The Windows on ARM machine key is refused: no native arm64 build is
    pinned, and the x64 build runs there under emulation.

Feature diff (measured 2026-09-26): essentials covers every codec and filter
montaj selects (libx264/libx265/aac/libopus/libmp3lame/libvpx-vp9/prores_ks/
ffv1/png; zscale, tonemap, lut3d, loudnorm, drawtext, sidechaincompress, ...),
and has fontconfig/freetype/harfbuzz/libass/libzimg. Its gaps against the
macOS build are libdav1d (software AV1 decode falls to libaom-av1; the
native av1 decoder is hwaccel-only), libsvtav1 (no longer selected
anywhere), openh264, rav1e,
vvenc, zvbi, snappy, klvanc; the full_build variant would add only libraries
montaj does not use, at 2.4x the download.

What the Windows digest proves: archive_sha256 equals the sha256 GitHub
reports for the release asset (its API "digest" field) and was re-derived
locally from a fresh download (2026-09-26, match). gyan.dev publishes no
.sha256 file for versioned releases (only for its rolling "latest" build),
so there is no independent publisher checksum; the pin guarantees the bytes
we reviewed, not the publisher's provenance.

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
    from . import models, common
except ImportError:
    sys.path.insert(0, os.path.dirname(__file__))
    import models, common

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
    # gyan.dev essentials, archive shape. Verified 2026-09-26: 109,728,040
    # bytes; sha256 matches GitHub's asset digest and a local re-derivation.
    ("windows", "amd64"): {
        "build_id": "gyan-8.1.2-essentials",
        "archive_urls": [
            "https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip",
            # R2 mirror, added in a follow-up task
        ],
        "archive_sha256": "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec",
        "members": {
            "ffmpeg":  "ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe",
            "ffprobe": "ffmpeg-8.1.2-essentials_build/bin/ffprobe.exe",
        },
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
    elif system == "Windows":
        os_key = "windows"
    else:
        raise UnsupportedPlatform(f"no static ffmpeg build for {system}")
    if machine in ("arm64", "aarch64"):
        arch = "arm64"
    elif machine in ("x86_64", "amd64"):
        arch = "amd64"
    else:
        raise UnsupportedPlatform(f"no static ffmpeg build for {system}/{machine}")
    if os_key == "windows" and arch == "arm64":
        raise UnsupportedPlatform(
            "no native Windows on ARM ffmpeg build is pinned; the x64 build "
            "runs under emulation there")
    return (os_key, arch)


def _zip_url(key, build_id, name):
    os_key, arch = key
    return f"{BASE_URL}/{os_key}/{arch}/{build_id}/{name}.zip"


def bin_dir():
    return models.models_dir("ffmpeg")


def managed_path(name):
    """Path where the managed binary lives (whether or not it exists yet)."""
    return os.path.join(bin_dir(), common._exe(name))


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

    if "archive_urls" in entry:
        return _ensure_from_archive(entry, dest_dir)

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


def _ensure_from_archive(entry, dest_dir):
    """Archive-shaped entry: one zip with both binaries, one digest.

    Tries each archive_urls entry in order, moving on only on a network error
    (OSError, which covers URLError/HTTPError). A digest mismatch is never
    retried against the next URL: it raises. Members are extracted by exact
    path, not basename.
    """
    import urllib.request
    _install_ua_opener()
    zip_tmp = os.path.join(dest_dir, f"ffmpeg-archive.zip.part.{os.getpid()}")
    last_err = None
    for url in entry["archive_urls"]:
        try:
            urllib.request.urlretrieve(url, zip_tmp)
        except OSError as e:
            last_err = e
            if os.path.exists(zip_tmp):
                os.unlink(zip_tmp)
            continue
        break
    else:
        raise last_err

    digest = models._sha256(zip_tmp)
    if digest != entry["archive_sha256"]:
        os.unlink(zip_tmp)
        raise ChecksumMismatch(
            f"ffmpeg archive sha256 {digest} != pinned {entry['archive_sha256']}")
    try:
        out = {name: _extract_zip(zip_tmp, dest_dir, name, member=entry["members"][name])
               for name in ("ffmpeg", "ffprobe")}
    finally:
        os.unlink(zip_tmp)

    with open(os.path.join(dest_dir, ".build_id"), "w") as f:
        f.write(entry["build_id"])
    return out


def _extract_zip(zip_path, dest_dir, name, member=None):
    """Extract the single binary from the zip, atomic-place it, chmod 755.

    `member` (archive entries) names the exact path inside the zip; without
    it the first member whose basename is `name` is taken (per-binary zips).
    """
    tmp = os.path.join(dest_dir, f".{name}.tmp.{os.getpid()}")
    with zipfile.ZipFile(zip_path) as z:
        if member is not None:
            members = [m for m in z.namelist() if m == member]
        else:
            members = [m for m in z.namelist() if os.path.basename(m) == name]
        if not members:
            raise ChecksumMismatch(f"{member or name} not found inside {zip_path}")
        with z.open(members[0]) as src, open(tmp, "wb") as dst:
            dst.write(src.read())
    os.chmod(tmp, 0o755)
    final = os.path.join(dest_dir, common._exe(name))
    os.replace(tmp, final)
    return final
