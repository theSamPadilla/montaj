"""Disk usage on GET /api/info.

Filesystem-level only: no directory walk. /api/info is called casually and must
stay cheap on a 100GB volume of video.
"""
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from serve.server import app


@pytest.fixture
def client():
    return TestClient(app)


class TestInfoDisk:
    def test_reports_total_used_and_free_bytes(self, client, monkeypatch, tmp_path):
        monkeypatch.setattr("serve.routes.skills.resolve_workspace", lambda: tmp_path)
        body = client.get("/api/info").json()
        assert body["disk"]["totalBytes"] > 0
        assert body["disk"]["freeBytes"] >= 0
        assert body["disk"]["usedBytes"] == body["disk"]["totalBytes"] - body["disk"]["freeBytes"]

    def test_reports_used_percent_as_a_number_between_0_and_100(self, client, monkeypatch, tmp_path):
        monkeypatch.setattr("serve.routes.skills.resolve_workspace", lambda: tmp_path)
        pct = client.get("/api/info").json()["disk"]["usedPercent"]
        assert isinstance(pct, (int, float))
        assert 0 <= pct <= 100

    def test_keeps_the_existing_fields(self, client, monkeypatch, tmp_path):
        """Additive only. An older Hub reading this response must not break."""
        monkeypatch.setattr("serve.routes.skills.resolve_workspace", lambda: tmp_path)
        body = client.get("/api/info").json()
        assert "version" in body
        assert "skill_path" in body

    def test_a_failed_disk_read_omits_disk_rather_than_500ing(self, client, monkeypatch, tmp_path):
        """/api/info is a liveness-adjacent call. It must not fail because statvfs did."""
        monkeypatch.setattr("serve.routes.skills.resolve_workspace", lambda: tmp_path)

        def _boom(_path):
            raise OSError("statvfs failed")

        monkeypatch.setattr("serve.routes.skills.shutil.disk_usage", _boom)
        resp = client.get("/api/info")
        assert resp.status_code == 200
        assert "disk" not in resp.json()
        assert "version" in resp.json()

    def test_used_bytes_is_total_minus_free_not_the_kernel_used_field(
        self, client, monkeypatch, tmp_path
    ):
        """Pins the arithmetic on any filesystem.

        shutil.disk_usage derives `free` from f_bavail (blocks an unprivileged
        writer can actually use) and `used` from f_bfree (which excludes the
        root-reserved pool). They differ on ext4 with its default 5% reserve,
        which is what the deployed sidecar runs on, and only `total - free`
        reaches 100% at the moment writes actually start failing. This dev box
        is APFS, which reserves nothing, so a real disk_usage call cannot tell
        the two formulas apart. Fake one that can.
        """
        monkeypatch.setattr("serve.routes.skills.resolve_workspace", lambda: tmp_path)
        # 15 bytes reserved: used (80) is deliberately NOT total - free (95).
        fake = SimpleNamespace(total=100, used=80, free=5)
        monkeypatch.setattr("serve.routes.skills.shutil.disk_usage", lambda _p: fake)

        disk = client.get("/api/info").json()["disk"]
        assert disk["usedBytes"] == 95
        assert disk["usedPercent"] == 95.0

    def test_a_zero_total_omits_disk_rather_than_reporting_an_empty_one(
        self, client, monkeypatch, tmp_path
    ):
        """A non-positive total means we cannot characterise the filesystem.

        Reporting all-zero fields would read downstream as a completely free
        disk, which is the opposite of the truth and the exact confusion the
        omit-on-failure rule exists to prevent.
        """
        monkeypatch.setattr("serve.routes.skills.resolve_workspace", lambda: tmp_path)
        monkeypatch.setattr(
            "serve.routes.skills.shutil.disk_usage",
            lambda _p: SimpleNamespace(total=0, used=0, free=0),
        )
        body = client.get("/api/info").json()
        assert "disk" not in body
        assert "version" in body

    def test_measures_the_workspace_filesystem_not_the_process_cwd(
        self, client, monkeypatch, tmp_path
    ):
        """Pins WHICH path is measured, not merely that a reading happened.

        The deployed sidecar sets MONTAJ_WORKSPACE_DIR to the mounted 100GB
        volume, which is a different filesystem from the container's own. A
        reading taken against the wrong path would look perfectly healthy and
        the disk alert would never fire.
        """
        monkeypatch.setattr("serve.routes.skills.resolve_workspace", lambda: tmp_path)
        seen = []

        def _spy(path):
            seen.append(path)
            return SimpleNamespace(total=100, used=80, free=5)

        monkeypatch.setattr("serve.routes.skills.shutil.disk_usage", _spy)
        client.get("/api/info")
        assert seen == [tmp_path]
