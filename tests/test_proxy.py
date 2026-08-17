"""Tests for lib/proxy.py — the av1-crf35-fast editing proxy encode primitive.

Naming, freshness, and the eager (SDR, no tonemap) encode arm are exercised
end-to-end against a lavfi SDR fixture (tests/conftest.py's `test_video`,
synthesized the same way as the fixture at conftest.py:78). The tonemap arm
is a known-unreliable target for synthetic lavfi HDR fixtures (see
tests/test_sample_steps.py:282), so per the SP3 plan it's asserted at the
source level instead: grep the built ffmpeg command for the zscale chain and
scale-first ordering, without running an actual HDR encode.
"""
import inspect
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

import lib.normalize as nm
import lib.proxy as proxy_mod
from lib.normalize import _run_atomic_encode, probe_video
from lib.proxy import (
    PROXY_LOOK,
    _build_proxy_cmd,
    is_proxy_fresh,
    make_proxy,
    proxy_path_for,
)

HAS_FFMPEG = shutil.which("ffmpeg") is not None
pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


@pytest.fixture(autouse=True)
def _workspace_is_tmp(tmp_path, monkeypatch):
    """SP3 fix S7 made proxy placement workspace-aware: in-workspace sources
    get sibling proxies, outside-workspace sources are routed to
    <workspace>/.sources/_proxycache/. Declare each test's tmp_path as the
    workspace so the naming/encode tests keep exercising the sibling path;
    the outside-workspace routing has its own dedicated tests below."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))


def test_proxy_path_for_outside_workspace_routes_to_sources_proxycache(tmp_path, monkeypatch):
    """SP3 fix S7: an outside-workspace source must not get a proxy written
    next to the user's own footage — it goes to .sources/_proxycache/<hash>/,
    which `montaj clean --proxies` always scans."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(workspace))
    outside = tmp_path / "user-footage" / "clip.mov"
    outside.parent.mkdir()
    outside.write_bytes(b"x")

    out = proxy_path_for(str(outside))
    cache_root = workspace / ".sources" / "_proxycache"
    assert Path(out).name == f"clip_proxy_{PROXY_LOOK}.mp4"
    assert str(cache_root) in out
    # Deterministic: same source → same path; the hash dir keys the realpath.
    assert proxy_path_for(str(outside)) == out


def test_proxy_path_for_outside_workspace_distinct_files_same_basename_do_not_collide(tmp_path, monkeypatch):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(workspace))
    a = tmp_path / "a" / "clip.mov"
    b = tmp_path / "b" / "clip.mov"
    for f in (a, b):
        f.parent.mkdir()
        f.write_bytes(b"x")
    assert proxy_path_for(str(a)) != proxy_path_for(str(b))


# ── helpers ───────────────────────────────────────────────────────────────────

def _ffprobe_streams(path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", str(path)],
        capture_output=True, text=True, timeout=30,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout).get("streams", [])


def _ffprobe_key_frame_flags(path):
    """List of 'key_frame' values (as strings, "0"/"1") for every video frame."""
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
         "-show_entries", "frame=key_frame", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=30,
    )
    assert r.returncode == 0, r.stderr
    return [line.strip() for line in r.stdout.strip().split("\n") if line.strip()]


# ── PROXY_LOOK ───────────────────────────────────────────────────────────────

def test_proxy_look_is_sourced_from_the_look_manifest():
    """PROXY_LOOK is a re-export of lib/look.py's MASTER_LOOK (SP6b Task T5) —
    not an independently-maintained constant — so bumping
    montaj_assets/luts/looks.json's masterLook is the only place a look bump
    needs to happen. Currently "vivid1" (montaj-vivid-v1.cube); "hable1" is
    the historical pre-Vivid value, still pinned in cli/commands/clean.py's
    KNOWN_LOOKS so old proxies stay cleanable."""
    from lib.look import MASTER_LOOK
    assert PROXY_LOOK == MASTER_LOOK
    assert PROXY_LOOK == "vivid1"


# ── proxy_path_for() naming ─────────────────────────────────────────────────

def test_proxy_path_for_appends_look_suffix(monkeypatch):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", "/a")  # in-workspace ⇒ sibling naming
    assert proxy_path_for("/a/b/clip.mp4") == f"/a/b/clip_proxy_{PROXY_LOOK}.mp4"


def test_proxy_path_for_strips_only_the_last_extension(monkeypatch):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", "/a")
    assert proxy_path_for("/a/b/my.clip.mov") == f"/a/b/my.clip_proxy_{PROXY_LOOK}.mp4"


def test_proxy_path_for_is_sibling_of_source(monkeypatch):
    # Shared lazy sources live in ~/Montaj/.sources/<id>/; the proxy must land
    # next to the encoded-from file, not in some other directory.
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", "/Users/x/Montaj")
    src = "/Users/x/Montaj/.sources/abc123/original.mov"
    out = proxy_path_for(src)
    assert os.path.dirname(out) == os.path.dirname(src)


def test_proxy_path_for_extensionless_source_under_dotted_directory(monkeypatch):
    # rsplit('.', 1) on the WHOLE path (not just the basename) would treat the
    # dotted ".sources" directory segment as the "extension" for an
    # extension-less source, landing the proxy in the wrong directory.
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", "/Users/x/Montaj")
    assert proxy_path_for("/Users/x/Montaj/.sources/abc/original") == (
        f"/Users/x/Montaj/.sources/abc/original_proxy_{PROXY_LOOK}.mp4"
    )


# ── is_proxy_fresh() ─────────────────────────────────────────────────────────

def test_is_proxy_fresh_false_when_proxy_missing(tmp_path):
    src = tmp_path / "src.mp4"
    src.write_text("x")
    assert is_proxy_fresh(str(tmp_path / "missing_proxy.mp4"), str(src)) is False


def test_is_proxy_fresh_true_when_proxy_newer(tmp_path):
    src = tmp_path / "src.mp4"
    proxy = tmp_path / "src_proxy.mp4"
    src.write_text("src")
    time.sleep(0.05)
    proxy.write_text("proxy")
    assert is_proxy_fresh(str(proxy), str(src)) is True


def test_is_proxy_fresh_false_when_proxy_stale(tmp_path):
    """A source re-imported/re-normalized after the proxy was cut → stale."""
    src = tmp_path / "src.mp4"
    proxy = tmp_path / "src_proxy.mp4"
    proxy.write_text("proxy")
    time.sleep(0.05)
    src.write_text("src")  # src touched after proxy → proxy is stale
    assert is_proxy_fresh(str(proxy), str(src)) is False


# ── _build_proxy_cmd() — source-level assertions (no ffmpeg run) ───────────────

def test_build_proxy_cmd_eager_arm_is_plain_scale_no_tonemap():
    """Eager (already-SDR master): scale only, no zscale chain."""
    cmd, used_fallback = _build_proxy_cmd(
        "master.mp4", "out.mp4", tonemap=False, info={"has_audio": True}
    )
    assert used_fallback is False
    vf = cmd[cmd.index("-vf") + 1]
    assert vf == "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)'"
    assert "zscale" not in vf


def test_build_proxy_cmd_lazy_arm_scale_composed_ahead_of_tonemap(monkeypatch):
    """Lazy (HDR original): scale must come BEFORE the zscale/LUT tonemap chain
    (the SP1 scale-first finding — tonemapping a smaller frame is cheaper and
    equivalent).

    SP6b T2 swapped the bare-tonemap chain for the Montaj Vivid LUT chain in
    the shared `_build_tonemap_vf_to_sdr` builder (lib/normalize.py) — this
    proxy build inherits it automatically. Chain-string assertions updated to
    match (sanctioned cross-file touch per the T2 task scope: proxy.py itself
    is untouched, only this assertion)."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: True)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: True)
    cmd, used_fallback = _build_proxy_cmd(
        "original.mov", "out.mp4", tonemap=True,
        info={"has_audio": True, "color_transfer": "arib-std-b67"},
    )
    assert used_fallback is False
    vf = cmd[cmd.index("-vf") + 1]
    scale_idx = vf.index("scale=")
    zscale_idx = vf.index("zscale=")
    assert scale_idx < zscale_idx, f"scale must precede zscale chain: {vf!r}"
    assert vf.startswith("scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)',")
    # decision-8a regression: format=rgb48le must land before lut3d.
    assert vf.index("format=rgb48le") < vf.index("lut3d=")
    assert "interp=tetrahedral" in vf
    assert vf.endswith("format=yuv420p")


def test_build_proxy_cmd_lazy_arm_falls_back_without_zscale(monkeypatch):
    """No libzimg on the box → degraded fallback path, flagged for the caller
    to warn loudly (mirrors normalize()'s used_fallback_tonemap contract)."""
    monkeypatch.setattr(nm, "_has_zscale", lambda: False)
    cmd, used_fallback = _build_proxy_cmd(
        "original.mov", "out.mp4", tonemap=True,
        info={"has_audio": True, "color_transfer": "smpte2084"},
    )
    assert used_fallback is True
    vf = cmd[cmd.index("-vf") + 1]
    assert "zscale" not in vf
    assert "tonemap=hable:desat=0" in vf


def test_build_proxy_cmd_encoder_params():
    """The locked av1-crf35-fast params: all-intra libsvtav1 + opus."""
    cmd, _ = _build_proxy_cmd("master.mp4", "out.mp4", tonemap=False, info={"has_audio": True})
    assert "-hwaccel" in cmd and cmd[cmd.index("-hwaccel") + 1] == "auto"
    assert cmd[cmd.index("-c:v") + 1] == "libsvtav1"
    assert cmd[cmd.index("-crf") + 1] == "35"
    assert cmd[cmd.index("-preset") + 1] == "8"
    assert cmd[cmd.index("-g") + 1] == "1"  # GOP=1 → all-intra
    assert cmd[cmd.index("-c:a") + 1] == "libopus"
    assert cmd[cmd.index("-b:a") + 1] == "96k"
    assert "-movflags" in cmd and cmd[cmd.index("-movflags") + 1] == "+faststart"
    assert cmd[-1] == "out.mp4"


def test_build_proxy_cmd_silent_source_gets_anullsrc():
    """A source with no audio track still gets a valid Opus stream (silent),
    matching normalize.py's anullsrc convention."""
    cmd, _ = _build_proxy_cmd("master.mp4", "out.mp4", tonemap=False, info={"has_audio": False})
    assert "anullsrc=cl=stereo:r=48000" in cmd
    assert cmd[cmd.index("-c:a") + 1] == "libopus"


# ── make_proxy() — real encode on the lavfi SDR fixture (eager arm) ────────────

def test_make_proxy_eager_encode_all_intra_av1_opus(test_video, tmp_path):
    out = tmp_path / "proxy.mp4"
    info = probe_video(str(test_video))
    assert info is not None

    result = make_proxy(str(test_video), str(out), tonemap=False, info=info)

    assert result == str(out)
    assert out.exists() and out.stat().st_size > 0

    streams = _ffprobe_streams(out)
    video = next(s for s in streams if s["codec_type"] == "video")
    audio = next(s for s in streams if s["codec_type"] == "audio")
    assert video["codec_name"] == "av1"
    assert audio["codec_name"] == "opus"

    # All-intra: every sampled frame is a keyframe.
    flags = _ffprobe_key_frame_flags(out)
    assert flags, "no frames probed"
    assert all(f == "1" for f in flags), f"non-keyframes present: {flags}"


def test_make_proxy_scales_to_720(test_video, tmp_path):
    """test_video is 640x480 (landscape) → height pinned to 720, width auto."""
    out = tmp_path / "proxy.mp4"
    info = probe_video(str(test_video))
    make_proxy(str(test_video), str(out), tonemap=False, info=info)
    video = next(s for s in _ffprobe_streams(out) if s["codec_type"] == "video")
    assert video["height"] == 720


def test_make_proxy_uses_proxy_path_for_naming_convention(test_video, tmp_path):
    """Exercise the naming convention end-to-end: proxy_path_for(src) is a
    valid target for make_proxy()."""
    src_copy = tmp_path / "clip.mp4"
    shutil.copyfile(test_video, src_copy)
    out = proxy_path_for(str(src_copy))
    info = probe_video(str(src_copy))
    make_proxy(str(src_copy), out, tonemap=False, info=info)
    assert Path(out).exists()
    assert out == str(tmp_path / f"clip_proxy_{PROXY_LOOK}.mp4")


def test_make_proxy_freshness_short_circuits_reencode(test_video, tmp_path):
    """Simulates the caller-side contract: a caller checks is_proxy_fresh()
    before calling make_proxy(); once fresh, no re-encode is needed."""
    src_copy = tmp_path / "clip.mp4"
    shutil.copyfile(test_video, src_copy)
    out = proxy_path_for(str(src_copy))
    info = probe_video(str(src_copy))

    assert is_proxy_fresh(out, str(src_copy)) is False
    make_proxy(str(src_copy), out, tonemap=False, info=info)
    assert is_proxy_fresh(out, str(src_copy)) is True

    mtime_before = os.path.getmtime(out)
    # A second caller re-checks freshness and (per the contract) skips re-encoding.
    if is_proxy_fresh(out, str(src_copy)):
        pass  # no-op: this IS the short-circuit — make_proxy is not called again
    assert os.path.getmtime(out) == mtime_before


# ── _run_atomic_encode() timeout kwarg ─────────────────────────────────────────

def test_run_atomic_encode_timeout_defaults_to_600():
    assert inspect.signature(_run_atomic_encode).parameters["timeout"].default == 600


def test_run_atomic_encode_forwards_custom_timeout(tmp_path, monkeypatch):
    """make_proxy relies on a duration-scaled timeout actually reaching
    subprocess.run — prove _run_atomic_encode forwards it."""
    out = tmp_path / "cache.mp4"
    from lib.normalize import _tmp_for
    tmp = _tmp_for(str(out))
    seen = {}

    def fake_run(cmd, **kw):
        seen["timeout"] = kw.get("timeout")
        with open(tmp, "w") as f:
            f.write("bytes")
        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(nm.subprocess, "run", fake_run)
    _run_atomic_encode(["ffmpeg"], tmp, str(out), label="x", timeout=1234)
    assert seen["timeout"] == 1234


# ── make_proxy() — timeout sizing from source duration ─────────────────────────

def test_make_proxy_timeout_scales_with_duration(test_video, tmp_path, monkeypatch):
    out = tmp_path / "proxy.mp4"
    info = probe_video(str(test_video))
    captured = {}

    def fake_run_atomic_encode(cmd, tmp_path_, out_path, *, label, timeout=600):
        captured["timeout"] = timeout
        # Satisfy make_proxy's contract without actually invoking ffmpeg.
        Path(out_path).write_bytes(b"fake")

    monkeypatch.setattr(proxy_mod, "_run_atomic_encode", fake_run_atomic_encode)
    make_proxy(str(test_video), str(out), tonemap=False, info=info)
    # test_video is a 3s clip: max(900, 3 * 2) == 900.
    assert captured["timeout"] == 900


def test_make_proxy_timeout_uses_info_duration_when_present(tmp_path, monkeypatch):
    """When the caller's info dict already carries a duration, avoid a second
    ffprobe call — use it directly."""
    out = tmp_path / "proxy.mp4"
    captured = {}

    def fake_run_atomic_encode(cmd, tmp_path_, out_path, *, label, timeout=600):
        captured["timeout"] = timeout
        Path(out_path).write_bytes(b"fake")

    monkeypatch.setattr(proxy_mod, "_run_atomic_encode", fake_run_atomic_encode)
    monkeypatch.setattr(proxy_mod, "get_duration", lambda _p: (_ for _ in ()).throw(
        AssertionError("get_duration should not be called when info has duration")))
    make_proxy(
        "unused-src.mp4", str(out), tonemap=False,
        info={"has_audio": True, "duration": 600},
    )
    assert captured["timeout"] == 1200
