"""Tests for /api/run aiVideoIntake validation in serve/server.py."""
from starlette.testclient import TestClient

from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


def test_image_ref_missing_both_path_and_text():
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "clean_cut",
        "clips": [],
        "aiVideoIntake": {
            "imageRefs": [{"label": "Max"}],
            "styleRefs": [],
        },
    })
    assert resp.status_code == 400
    assert "exactly one" in resp.json()["detail"]["message"]


def test_image_ref_has_both_path_and_text():
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "clean_cut",
        "clips": [],
        "aiVideoIntake": {
            "imageRefs": [{"label": "Max", "path": "/tmp/x.png", "text": "a dog"}],
            "styleRefs": [],
        },
    })
    assert resp.status_code == 400
    assert "exactly one" in resp.json()["detail"]["message"]


def test_style_ref_missing_path():
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "clean_cut",
        "clips": [],
        "aiVideoIntake": {
            "imageRefs": [],
            "styleRefs": [{"label": "mood"}],
        },
    })
    assert resp.status_code == 400
    assert "requires 'path'" in resp.json()["detail"]["message"]


def test_too_many_style_refs():
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "clean_cut",
        "clips": [],
        "aiVideoIntake": {
            "imageRefs": [],
            "styleRefs": [
                {"label": "a", "path": "/tmp/a.mp4"},
                {"label": "b", "path": "/tmp/b.mp4"},
                {"label": "c", "path": "/tmp/c.mp4"},
            ],
        },
    })
    assert resp.status_code == 400
    assert "at most 2" in resp.json()["detail"]["message"]
