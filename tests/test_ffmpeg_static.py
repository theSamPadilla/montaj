"""Tests for lib/ffmpeg_static.py — managed static ffmpeg download."""
import io, os, sys, zipfile, hashlib
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import ffmpeg_static


def _make_zip(binary_name: str, content: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(binary_name, content)
    return buf.getvalue()


class TestPinnedTable:
    def test_all_five_platforms_present(self):
        keys = set(ffmpeg_static.PINNED_BUILDS.keys())
        assert keys == {("macos", "arm64"), ("macos", "amd64"),
                        ("linux", "amd64"), ("linux", "arm64"),
                        ("windows", "amd64")}

    def test_every_entry_has_build_id_and_checksums(self):
        for entry in ffmpeg_static.PINNED_BUILDS.values():
            assert "8.1.2" in entry["build_id"]
            if "archive_urls" in entry:
                # Archive shape: one zip holding both binaries, one digest.
                assert isinstance(entry["archive_urls"], list)
                assert entry["archive_urls"]
                assert len(entry["archive_sha256"]) == 64
                assert set(entry["members"]) == {"ffmpeg", "ffprobe"}
            else:
                # Per-binary shape: one zip + digest per binary.
                assert len(entry["ffmpeg_sha256"]) == 64
                assert len(entry["ffprobe_sha256"]) == 64

    def test_platform_key_maps_current_machine(self):
        key = ffmpeg_static._platform_key()
        assert key in ffmpeg_static.PINNED_BUILDS

    def test_platform_key_unsupported_raises(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "FreeBSD")
        with pytest.raises(ffmpeg_static.UnsupportedPlatform):
            ffmpeg_static._platform_key()

    def test_platform_key_windows_amd64(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Windows")
        monkeypatch.setattr("platform.machine", lambda: "AMD64")
        assert ffmpeg_static._platform_key() == ("windows", "amd64")

    def test_platform_key_windows_arm64_raises_with_emulation_hint(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Windows")
        monkeypatch.setattr("platform.machine", lambda: "ARM64")
        with pytest.raises(ffmpeg_static.UnsupportedPlatform, match="emulation"):
            ffmpeg_static._platform_key()


class _Payloads(dict):
    """url -> bytes (or an exception instance to raise); .fetched records
    every url requested, in order."""
    def __init__(self):
        super().__init__()
        self.fetched = []


@pytest.fixture
def fake_downloads(monkeypatch, tmp_path):
    """Redirect the models dir to tmp and stub the network download."""
    from lib import models
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path / "models"))
    payloads = _Payloads()

    def fake_urlretrieve(url, dest, reporthook=None):
        payloads.fetched.append(url)
        if url not in payloads:
            raise IOError(f"unexpected url {url}")
        if isinstance(payloads[url], BaseException):
            raise payloads[url]
        with open(dest, "wb") as f:
            f.write(payloads[url])
    monkeypatch.setattr("urllib.request.urlretrieve", fake_urlretrieve)
    return payloads


class TestEnsureFfmpeg:
    def _register(self, payloads, key):
        entry = dict(ffmpeg_static.PINNED_BUILDS[key])
        for name in ("ffmpeg", "ffprobe"):
            blob = _make_zip(name, f"#!fake {name}".encode())
            entry[f"{name}_sha256"] = hashlib.sha256(blob).hexdigest()
            payloads[ffmpeg_static._zip_url(key, entry["build_id"], name)] = blob
        return entry

    def test_downloads_extracts_and_chmods(self, fake_downloads, monkeypatch, tmp_path):
        key = ("macos", "arm64")
        monkeypatch.setattr(ffmpeg_static, "_platform_key", lambda: key)
        # common._EXE_SUFFIX defaults to the real host's suffix (".exe" on a
        # Windows CI runner) regardless of which platform `key` is faked —
        # pin it explicitly so the extracted-binary basename this test
        # asserts on matches the "macos" key being simulated, not whatever
        # host happens to run it.
        monkeypatch.setattr(ffmpeg_static.common, "_EXE_SUFFIX", "")
        entry = self._register(fake_downloads, key)
        monkeypatch.setitem(ffmpeg_static.PINNED_BUILDS, key, entry)

        paths = ffmpeg_static.ensure_ffmpeg()
        assert os.path.basename(paths["ffmpeg"]) == "ffmpeg"
        assert os.path.basename(paths["ffprobe"]) == "ffprobe"
        for p in paths.values():
            assert os.path.isfile(p)
            assert os.access(p, os.X_OK)
        stamp = os.path.join(os.path.dirname(paths["ffmpeg"]), ".build_id")
        assert open(stamp).read().strip() == entry["build_id"]

    def test_checksum_mismatch_raises(self, fake_downloads, monkeypatch):
        key = ("macos", "arm64")
        monkeypatch.setattr(ffmpeg_static, "_platform_key", lambda: key)
        monkeypatch.setattr(ffmpeg_static.common, "_EXE_SUFFIX", "")
        entry = self._register(fake_downloads, key)
        entry["ffmpeg_sha256"] = "0" * 64  # wrong
        monkeypatch.setitem(ffmpeg_static.PINNED_BUILDS, key, entry)
        with pytest.raises(ffmpeg_static.ChecksumMismatch):
            ffmpeg_static.ensure_ffmpeg()

    def test_idempotent_when_stamp_matches(self, fake_downloads, monkeypatch):
        key = ("macos", "arm64")
        monkeypatch.setattr(ffmpeg_static, "_platform_key", lambda: key)
        monkeypatch.setattr(ffmpeg_static.common, "_EXE_SUFFIX", "")
        entry = self._register(fake_downloads, key)
        monkeypatch.setitem(ffmpeg_static.PINNED_BUILDS, key, entry)
        first = ffmpeg_static.ensure_ffmpeg()
        fake_downloads.clear()  # any further download would now IOError
        second = ffmpeg_static.ensure_ffmpeg()
        assert first == second

    def test_stale_stamp_triggers_redownload(self, fake_downloads, monkeypatch):
        key = ("macos", "arm64")
        monkeypatch.setattr(ffmpeg_static, "_platform_key", lambda: key)
        monkeypatch.setattr(ffmpeg_static.common, "_EXE_SUFFIX", "")
        entry = self._register(fake_downloads, key)
        monkeypatch.setitem(ffmpeg_static.PINNED_BUILDS, key, entry)
        paths = ffmpeg_static.ensure_ffmpeg()
        stamp = os.path.join(os.path.dirname(paths["ffmpeg"]), ".build_id")
        with open(stamp, "w") as f:
            f.write("old_build")
        self._register(fake_downloads, key)
        ffmpeg_static.ensure_ffmpeg()
        assert open(stamp).read().strip() == entry["build_id"]


WIN_KEY = ("windows", "amd64")
_ROOT = "ffmpeg-8.1.2-essentials_build"


def _make_archive(members: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, content in members.items():
            z.writestr(name, content)
    return buf.getvalue()


class TestEnsureFfmpegWindowsArchive:
    """The archive-shaped (gyan.dev) entry, proven on macOS through the
    module's _EXE_SUFFIX seam rather than by patching sys.platform."""

    PRIMARY = "https://example.invalid/primary/ffmpeg.zip"
    MIRROR = "https://example.invalid/mirror/ffmpeg.zip"

    @pytest.fixture
    def win(self, fake_downloads, monkeypatch):
        monkeypatch.setattr(ffmpeg_static.common, "_EXE_SUFFIX", ".exe")
        monkeypatch.setattr(ffmpeg_static, "_platform_key", lambda: WIN_KEY)
        blob = _make_archive({
            # Decoy with the same basename, listed first: extraction must
            # go by exact member path, not by basename.
            f"{_ROOT}/doc/ffmpeg.exe": b"decoy",
            f"{_ROOT}/bin/ffmpeg.exe": b"MZ fake ffmpeg",
            f"{_ROOT}/bin/ffprobe.exe": b"MZ fake ffprobe",
            f"{_ROOT}/bin/ffplay.exe": b"MZ fake ffplay",
        })
        entry = {
            "build_id": "gyan-8.1.2-essentials",
            "archive_urls": [self.PRIMARY, self.MIRROR],
            "archive_sha256": hashlib.sha256(blob).hexdigest(),
            "members": {
                "ffmpeg": f"{_ROOT}/bin/ffmpeg.exe",
                "ffprobe": f"{_ROOT}/bin/ffprobe.exe",
            },
        }
        monkeypatch.setitem(ffmpeg_static.PINNED_BUILDS, WIN_KEY, entry)
        return fake_downloads, blob, entry

    def test_archive_fetched_once_and_members_extracted(self, win):
        payloads, blob, entry = win
        payloads[self.PRIMARY] = blob
        paths = ffmpeg_static.ensure_ffmpeg()
        assert payloads.fetched == [self.PRIMARY]
        assert paths["ffmpeg"].endswith("ffmpeg.exe")
        assert paths["ffprobe"].endswith("ffprobe.exe")
        assert open(paths["ffmpeg"], "rb").read() == b"MZ fake ffmpeg"
        assert open(paths["ffprobe"], "rb").read() == b"MZ fake ffprobe"
        d = os.path.dirname(paths["ffmpeg"])
        assert open(os.path.join(d, ".build_id")).read().strip() == entry["build_id"]
        assert not os.path.exists(os.path.join(d, "ffplay.exe"))
        assert not [f for f in os.listdir(d) if ".part" in f]
        assert ffmpeg_static.is_installed()
        assert ffmpeg_static.managed_path("ffmpeg").endswith("ffmpeg.exe")

    def test_archive_bad_digest_raises_and_deletes_part(self, win):
        payloads, blob, entry = win
        payloads[self.PRIMARY] = blob
        entry["archive_sha256"] = "0" * 64
        with pytest.raises(ffmpeg_static.ChecksumMismatch):
            ffmpeg_static.ensure_ffmpeg()
        d = ffmpeg_static.bin_dir()
        assert not [f for f in os.listdir(d) if ".part" in f]
        assert not os.path.exists(os.path.join(d, ".build_id"))

    def test_archive_falls_back_to_mirror_on_network_error(self, win):
        import urllib.error
        payloads, blob, entry = win
        payloads[self.PRIMARY] = urllib.error.URLError("unreachable")
        payloads[self.MIRROR] = blob
        paths = ffmpeg_static.ensure_ffmpeg()
        assert payloads.fetched == [self.PRIMARY, self.MIRROR]
        assert open(paths["ffmpeg"], "rb").read() == b"MZ fake ffmpeg"

    def test_mirror_verified_against_same_digest(self, win):
        import urllib.error
        payloads, blob, entry = win
        payloads[self.PRIMARY] = urllib.error.URLError("unreachable")
        payloads[self.MIRROR] = blob + b"tampered"
        with pytest.raises(ffmpeg_static.ChecksumMismatch):
            ffmpeg_static.ensure_ffmpeg()
        assert not [f for f in os.listdir(ffmpeg_static.bin_dir()) if ".part" in f]

    def test_all_urls_failing_raises_last_error(self, win):
        import urllib.error
        payloads, blob, entry = win
        payloads[self.PRIMARY] = urllib.error.URLError("primary down")
        payloads[self.MIRROR] = urllib.error.URLError("mirror down")
        with pytest.raises(urllib.error.URLError, match="mirror down"):
            ffmpeg_static.ensure_ffmpeg()
