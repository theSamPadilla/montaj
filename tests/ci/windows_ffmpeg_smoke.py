#!/usr/bin/env python3
"""Windows CI smoke: real ffmpeg download + filter/encoder listing + lut3d path escaping.

Not a pytest test file — its name matches neither `test_*.py` nor `*_test.py`,
so pytest's default collection (testpaths = ["tests"]) never picks it up even
though it lives under tests/. Run directly: `python tests/ci/windows_ffmpeg_smoke.py`.

Exercises, for real, on a real Windows runner:
  1. lib.ffmpeg_static.ensure_ffmpeg() — a genuine download + sha256 verify of
     the pinned gyan.dev archive (tests/test_ffmpeg_static.py only ever fakes
     urlretrieve; nothing in the suite proves the real zip is still at that
     URL with that digest, or actually extracts on a Windows-shaped path).
  2. The extracted ffmpeg.exe actually has the filters/encoders montaj selects
     (zscale, lut3d; libx264, libx265, aac, prores_ks) — the pinned-table tests
     only check the pinned sha256s, never the binary's own -filters/-encoders.
  3. lib.common.ffmpeg_filter_path against a REAL Windows absolute path (drive
     letter + backslashes) actually round-trips through ffmpeg's own
     filtergraph parser: the escaped form must exit 0, and — as a control —
     the same path left unescaped must fail. Unit tests pin the string
     ffmpeg_filter_path returns; only a real ffmpeg process can prove that
     string is what ffmpeg itself wants.

Exits 0 on success; prints a diagnostic and exits 1 on the first failed check.
"""
import os
import re
import subprocess
import sys

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import lib.models as models  # noqa: E402


def _set_models_dir():
    """Redirect the managed-models dir under $RUNNER_TEMP, same convention
    tests/test_ffmpeg_static.py's fake_downloads fixture uses (monkeypatch
    lib.models.MONTAJ_MODELS_DIR) — except this really downloads."""
    runner_temp = os.environ.get("RUNNER_TEMP")
    if not runner_temp:
        raise SystemExit("RUNNER_TEMP is not set — this script is meant to run in CI")
    models.MONTAJ_MODELS_DIR = os.path.join(runner_temp, "models")
    print(f"lib.models.MONTAJ_MODELS_DIR = {models.MONTAJ_MODELS_DIR}", flush=True)


def _run(argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, **kw)


def _assert_listed(output, needles, flag):
    missing = [n for n in needles if not re.search(rf"\b{re.escape(n)}\b", output)]
    if missing:
        raise SystemExit(f"ffmpeg {flag}: missing {missing!r}\n--- output ---\n{output}")


def _cube_path_from_installed_package():
    """The pinned Montaj Vivid LUT, resolved off the installed `montaj_assets`
    package (an editable install still resolves this to a real path on disk —
    see lib.look.lut_path(), which resolves the same way at runtime)."""
    import montaj_assets
    base = os.path.dirname(os.path.abspath(montaj_assets.__file__))
    path = os.path.join(base, "luts", "montaj-vivid-v1.cube")
    if not os.path.isfile(path):
        raise SystemExit(f"expected LUT not found at {path}")
    return path


def main():
    _set_models_dir()

    from lib.ffmpeg_static import ensure_ffmpeg
    paths = ensure_ffmpeg()
    print(f"ensure_ffmpeg() -> {paths}", flush=True)
    ffmpeg = paths["ffmpeg"]

    filters = _run([ffmpeg, "-hide_banner", "-filters"])
    _assert_listed(filters.stdout + filters.stderr, ["zscale", "lut3d"], "-filters")

    encoders = _run([ffmpeg, "-hide_banner", "-encoders"])
    _assert_listed(encoders.stdout + encoders.stderr,
                    ["libx264", "libx265", "aac", "prores_ks"], "-encoders")

    buildconf = _run([ffmpeg, "-hide_banner", "-buildconf"])
    print("--- ffmpeg -buildconf ---", flush=True)
    print(buildconf.stdout + buildconf.stderr, flush=True)

    # --- lut3d path-escaping smoke: a real Windows absolute path -----------
    from lib.common import ffmpeg_filter_path

    cube = _cube_path_from_installed_package()
    print(f"LUT path (raw, as found on disk): {cube!r}", flush=True)

    escaped = ffmpeg_filter_path(cube)
    print(f"LUT path (ffmpeg_filter_path): {escaped!r}", flush=True)

    def _lut3d_argv(file_expr):
        return [
            ffmpeg, "-hide_banner",
            "-f", "lavfi", "-i", "testsrc2=s=64x64:d=0.1",
            "-vf", f"format=rgb48le,lut3d=file={file_expr}:interp=tetrahedral",
            "-f", "null", "-",
        ]

    ok = _run(_lut3d_argv(escaped))
    if ok.returncode != 0:
        raise SystemExit(
            "escaped lut3d path was rejected by ffmpeg (expected exit 0): "
            f"exit={ok.returncode}\n--- stderr ---\n{ok.stderr}"
        )
    print("escaped lut3d path: ffmpeg exited 0 (expected)", flush=True)

    bad = _run(_lut3d_argv(cube))
    if bad.returncode == 0:
        raise SystemExit(
            "unescaped Windows lut3d path unexpectedly SUCCEEDED — the control "
            "case must fail (the drive colon / backslashes must break the "
            "filtergraph parser when not escaped)"
        )
    print(f"unescaped lut3d path: ffmpeg exited {bad.returncode} (expected non-zero)", flush=True)

    print("windows_ffmpeg_smoke: OK", flush=True)


if __name__ == "__main__":
    main()
