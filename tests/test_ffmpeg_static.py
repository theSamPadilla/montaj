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
    def test_all_four_platforms_present(self):
        keys = set(ffmpeg_static.PINNED_BUILDS.keys())
        assert keys == {("macos", "arm64"), ("macos", "amd64"),
                        ("linux", "amd64"), ("linux", "arm64")}

    def test_every_entry_has_build_id_and_checksums(self):
        for entry in ffmpeg_static.PINNED_BUILDS.values():
            assert entry["build_id"].endswith("_8.1.2")
            assert len(entry["ffmpeg_sha256"]) == 64
            assert len(entry["ffprobe_sha256"]) == 64

    def test_platform_key_maps_current_machine(self):
        key = ffmpeg_static._platform_key()
        assert key in ffmpeg_static.PINNED_BUILDS

    def test_platform_key_unsupported_raises(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Windows")
        with pytest.raises(ffmpeg_static.UnsupportedPlatform):
            ffmpeg_static._platform_key()


class TestEnsureFfmpeg:
    @pytest.fixture
    def fake_downloads(self, monkeypatch, tmp_path):
        """Redirect the models dir to tmp and stub the network download."""
        from lib import models
        monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path / "models"))
        payloads = {}  # url -> bytes

        def fake_urlretrieve(url, dest, reporthook=None):
            if url not in payloads:
                raise IOError(f"unexpected url {url}")
            with open(dest, "wb") as f:
                f.write(payloads[url])
        monkeypatch.setattr("urllib.request.urlretrieve", fake_urlretrieve)
        return payloads

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
        entry = self._register(fake_downloads, key)
        entry["ffmpeg_sha256"] = "0" * 64  # wrong
        monkeypatch.setitem(ffmpeg_static.PINNED_BUILDS, key, entry)
        with pytest.raises(ffmpeg_static.ChecksumMismatch):
            ffmpeg_static.ensure_ffmpeg()

    def test_idempotent_when_stamp_matches(self, fake_downloads, monkeypatch):
        key = ("macos", "arm64")
        monkeypatch.setattr(ffmpeg_static, "_platform_key", lambda: key)
        entry = self._register(fake_downloads, key)
        monkeypatch.setitem(ffmpeg_static.PINNED_BUILDS, key, entry)
        first = ffmpeg_static.ensure_ffmpeg()
        fake_downloads.clear()  # any further download would now IOError
        second = ffmpeg_static.ensure_ffmpeg()
        assert first == second

    def test_stale_stamp_triggers_redownload(self, fake_downloads, monkeypatch):
        key = ("macos", "arm64")
        monkeypatch.setattr(ffmpeg_static, "_platform_key", lambda: key)
        entry = self._register(fake_downloads, key)
        monkeypatch.setitem(ffmpeg_static.PINNED_BUILDS, key, entry)
        paths = ffmpeg_static.ensure_ffmpeg()
        stamp = os.path.join(os.path.dirname(paths["ffmpeg"]), ".build_id")
        with open(stamp, "w") as f:
            f.write("old_build")
        self._register(fake_downloads, key)
        ffmpeg_static.ensure_ffmpeg()
        assert open(stamp).read().strip() == entry["build_id"]
