#!/usr/bin/env python3
"""Remove video background using RVM (Robust Video Matting).

Outputs ProRes 4444 .mov with alpha channel.
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run

# ---------------------------------------------------------------------------
# Dependency check at import time (not inside main)
# ---------------------------------------------------------------------------
_missing = []
try:
    import torch  # noqa: F401
except ImportError:
    _missing.append("torch")
try:
    import torchvision  # noqa: F401
except ImportError:
    _missing.append("torchvision")
try:
    import av  # noqa: F401
except ImportError:
    _missing.append("av")

if _missing:
    fail("missing_dependency",
         f"Missing packages: {', '.join(_missing)}. Install with: montaj install rvm")

# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

RVM_MODELS = {
    "rvm_mobilenetv3": {
        "url": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3.pth",
        # TODO: SHA-256 checksums are not published on the v1.0.0 release page.
        # To obtain them, download each .pth and run: sha256sum rvm_mobilenetv3.pth
        "checksum": None,
    },
    "rvm_resnet50": {
        "url": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50.pth",
        # TODO: SHA-256 checksums are not published on the v1.0.0 release page.
        # To obtain them, download each .pth and run: sha256sum rvm_resnet50.pth
        "checksum": None,
    },
}

# ---------------------------------------------------------------------------
# Device detection + hardware-aware defaults
# ---------------------------------------------------------------------------

def _detect_device(force_cpu: bool) -> str:
    import torch
    if force_cpu:
        return "cpu"
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _auto_downsample(device: str) -> float:
    """Pick a sensible default downsample ratio based on available memory.

    MPS (Apple Silicon): unified memory — use total RAM as proxy.
    CUDA: use VRAM. CPU: conservative.
    """
    try:
        if device == "mps":
            import subprocess, re
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
            ram_gb = int(out.strip()) / (1024 ** 3)
            if ram_gb >= 32:
                return 0.5   # plenty of memory — standard quality
            elif ram_gb >= 16:
                return 0.375
            else:
                return 0.25  # 8 GB M1 base — keep it light
        elif device == "cuda":
            import torch
            vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
            return 0.5 if vram_gb >= 8 else 0.375
    except Exception:
        pass
    return 0.5  # safe default


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def _load_model(model_name: str, device: str):
    """Download (if needed), load, and optionally compile the RVM model onto device."""
    import torch
    import sys as _sys
    import models as _models

    # Vendor dir — no network call; model architecture is local
    _STEPS_DIR = os.path.dirname(__file__)  # steps/
    if _STEPS_DIR not in _sys.path:
        _sys.path.insert(0, _STEPS_DIR)
    from rvm.model import MattingNetwork  # vendored; relative imports resolve correctly

    info = RVM_MODELS[model_name]
    filename = f"{model_name}.pth"
    model_file = _models.model_path("rvm", filename)
    if not os.path.isfile(model_file):
        fail(
            "missing_model_weights",
            f"RVM model weights not found: {filename}. "
            f"Run `montaj install rvm` or `montaj install --all` to download all model weights before running this step.",
        )
    model_file = _models.ensure_model("rvm", filename, info["url"], info["checksum"])

    backbone = "mobilenetv3" if "mobilenetv3" in model_name else "resnet50"
    model = MattingNetwork(backbone)
    state = torch.load(model_file, map_location=device, weights_only=True)
    model.load_state_dict(state)
    model = model.to(device).eval()

    # torch.compile gives a free speedup on MPS/CUDA with PyTorch >= 2.0
    if hasattr(torch, "compile") and device in ("mps", "cuda"):
        try:
            model = torch.compile(model)
        except Exception:
            pass  # compile is best-effort — fall back to eager silently

    return model


# ---------------------------------------------------------------------------
# Core inference for a single file
# ---------------------------------------------------------------------------

def _process_one(
    input_path: str,
    output_path: str,
    model_name: str,
    device: str,
    downsample: float,
    emit_progress: bool,
    model=None,
) -> str:
    """Process one video file through RVM. Returns output_path.

    Pass a pre-loaded model to avoid reloading weights between clips.
    """
    import torch
    import numpy as np
    import av

    if model is None:
        model = _load_model(model_name, device)

    # Use a temp file for the video-only pass, then mux audio
    tmp_video_fd, tmp_video_path = tempfile.mkstemp(suffix="_novg.mov")
    os.close(tmp_video_fd)

    try:
        in_container = av.open(input_path)
        try:
            video_stream = in_container.streams.video[0]
            fps = video_stream.average_rate  # keep as Fraction for PyAV
            width = video_stream.width
            height = video_stream.height
            total_frames = video_stream.frames  # may be 0 if unknown

            out_container = av.open(tmp_video_path, mode="w", format="mov")
            try:
                out_stream = out_container.add_stream("prores_ks", rate=fps)
                out_stream.width = width
                out_stream.height = height
                out_stream.pix_fmt = "yuva444p10le"
                out_stream.options = {"profile": "4"}  # profile 4 = ProRes 4444

                rec = [None, None, None, None]
                frames_done = 0

                with torch.no_grad():
                    for packet in in_container.demux(video_stream):
                        for frame in packet.decode():
                            # Frame → numpy → tensor [1, C, H, W] float32 in [0, 1]
                            img = frame.to_ndarray(format="rgb24")  # H×W×3 uint8
                            tensor = (
                                torch.from_numpy(img)
                                .permute(2, 0, 1)        # 3×H×W
                                .unsqueeze(0)            # 1×3×H×W
                                .float()
                                .div(255.0)
                                .to(device, non_blocking=True)
                            )

                            fgr, pha, *rec = model(tensor, *rec, downsample_ratio=downsample)

                            # fgr: [1,3,H,W] float  pha: [1,1,H,W] float
                            rgba = torch.cat([fgr, pha], dim=1)  # [1,4,H,W]
                            rgba = rgba.squeeze(0).permute(1, 2, 0)  # H×W×4

                            # Scale to uint16 and write as rgba64be
                            rgba_np = (rgba.cpu().numpy() * 65535).clip(0, 65535).astype(np.uint16)
                            out_frame = av.VideoFrame.from_ndarray(rgba_np, format="rgba64be")
                            out_frame.pts = frame.pts
                            out_frame.time_base = frame.time_base

                            for pkt in out_stream.encode(out_frame):
                                out_container.mux(pkt)

                            frames_done += 1
                            if emit_progress:
                                prog = (frames_done / total_frames) if total_frames else 0.0
                                print(
                                    json.dumps({
                                        "file": input_path,
                                        "progress": round(prog, 4),
                                        "frames_done": frames_done,
                                        "frames_total": total_frames,
                                    }),
                                    file=sys.stderr,
                                )

                # Flush encoder
                for pkt in out_stream.encode(None):
                    out_container.mux(pkt)
            finally:
                out_container.close()
        finally:
            in_container.close()

        # Mux original audio into the output
        run([
            "ffmpeg", "-y",
            "-i", tmp_video_path,
            "-i", input_path,
            "-c:v", "copy",
            "-c:a", "copy",
            "-map", "0:v:0",
            "-map", "1:a?",
            output_path,
        ])

    finally:
        if os.path.exists(tmp_video_path):
            os.unlink(tmp_video_path)

    check_output(output_path)
    return output_path


# ---------------------------------------------------------------------------
# WebM preview generation (VP9 with alpha — browser-compatible)
# ---------------------------------------------------------------------------

def _make_webm_preview(mov_path: str, emit_progress: bool = False) -> str:
    """Convert a ProRes 4444 .mov with alpha to a VP9 WebM for browser preview."""
    import subprocess as _sp
    stem = os.path.splitext(mov_path)[0]
    webm_path = f"{stem}_preview.webm"

    cmd = [
        "ffmpeg", "-y",
        "-i", mov_path,
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-b:v", "0", "-crf", "33",
        "-cpu-used", "4",
        "-deadline", "good",
        "-c:a", "libopus", "-b:a", "128k",
        webm_path,
    ]

    if not emit_progress:
        run(cmd)
        return webm_path

    # Probe total frames for progress percentage
    total_frames = 0
    try:
        r = _sp.run(
            ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
             "-show_entries", "stream=nb_frames", "-of", "csv=p=0", mov_path],
            capture_output=True, text=True,
        )
        val = r.stdout.strip()
        if val.isdigit():
            total_frames = int(val)
    except Exception:
        pass

    # -progress pipe:2 streams key=value progress blocks to stderr
    prog_cmd = cmd[:-1] + ["-progress", "pipe:2", webm_path]
    proc = _sp.Popen(prog_cmd, stderr=_sp.PIPE, stdout=_sp.DEVNULL, text=True)
    for line in proc.stderr:
        line = line.strip()
        if line.startswith("frame="):
            try:
                frames_done = int(line.split("=", 1)[1])
                prog = (frames_done / total_frames) if total_frames else 0.0
                print(json.dumps({
                    "file": mov_path,
                    "phase": "webm",
                    "progress": round(prog, 4),
                    "frames_done": frames_done,
                    "frames_total": total_frames,
                }), file=sys.stderr, flush=True)
            except (ValueError, IndexError):
                pass
    proc.wait()
    if proc.returncode != 0:
        fail("unexpected_error", f"WebM encoding failed for {mov_path}")

    return webm_path


# ---------------------------------------------------------------------------
# Worker trampoline for multiprocessing
# ---------------------------------------------------------------------------

def _worker_trampoline(args):
    """Unpack arguments and call _process_one. Used by multiprocessing.Pool."""
    input_path, output_path, model_name, device, downsample, emit_progress, num_threads = args
    import torch
    torch.set_num_threads(num_threads)
    return _process_one(input_path, output_path, model_name, device, downsample, emit_progress)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Remove video background using RVM — outputs ProRes 4444 .mov with alpha"
    )

    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--input", help="Single source video file")
    input_group.add_argument("--inputs", nargs="+", help="Multiple source video files")

    parser.add_argument("--out", help="Output path (only valid with --input, default: {stem}_nobg.mov)")
    parser.add_argument(
        "--model",
        default="rvm_mobilenetv3",
        choices=list(RVM_MODELS.keys()),
        help="RVM model variant",
    )
    parser.add_argument("--cpu", action="store_true", help="Force CPU and parallelize via multiprocessing")
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Worker count for --cpu mode (default: cpu_count // 2)",
    )
    parser.add_argument(
        "--downsample",
        type=float,
        default=None,
        help="Downsample ratio for inference (0.25–1.0). Defaults to auto-detect based on available memory.",
    )
    parser.add_argument("--progress", action="store_true", help="Emit JSON progress lines to stderr")

    args = parser.parse_args()

    if args.workers is not None and not args.cpu:
        print(json.dumps({"warning": "--workers has no effect without --cpu"}), file=sys.stderr)

    # Validate --out only used with --input
    if args.out and args.inputs:
        fail("invalid_args", "--out is only valid with --input, not --inputs")

    device = _detect_device(args.cpu)

    # Auto-detect downsample if not explicitly set
    if args.downsample is None:
        args.downsample = _auto_downsample(device)

    # Validate downsample range
    if not (0.25 <= args.downsample <= 1.0):
        fail("invalid_args", f"--downsample must be between 0.25 and 1.0, got {args.downsample}")

    if args.input:
        # Single file mode
        require_file(args.input)
        stem = os.path.splitext(args.input)[0]
        out = args.out or f"{stem}_nobg.mov"
        mov_path = _process_one(args.input, out, args.model, device, args.downsample, args.progress)
        webm_path = _make_webm_preview(mov_path, emit_progress=args.progress)
        print(json.dumps({"nobg_src": mov_path, "nobg_preview_src": webm_path}))

    else:
        # Multiple files mode
        results = []

        if args.cpu:
            import multiprocessing
            import os as _os
            cpu_count = _os.cpu_count() or 2
            workers = args.workers or max(1, cpu_count // 2)
            num_threads = max(1, cpu_count // workers)

            if args.progress:
                print(
                    json.dumps({"warning": "--progress is not supported with --cpu (multiprocessing) mode"}),
                    file=sys.stderr,
                )
            emit_progress = False

            worker_args = []
            for path in args.inputs:
                require_file(path)
                stem = os.path.splitext(path)[0]
                out = f"{stem}_nobg.mov"
                worker_args.append((path, out, args.model, "cpu", args.downsample, emit_progress, num_threads))

            with multiprocessing.Pool(processes=workers) as pool:
                mov_paths = pool.map(_worker_trampoline, worker_args)
        else:
            # GPU: load model once, process clips sequentially
            shared_model = _load_model(args.model, device)
            mov_paths = []
            for path in args.inputs:
                require_file(path)
                stem = os.path.splitext(path)[0]
                out = f"{stem}_nobg.mov"
                mov_path = _process_one(path, out, args.model, device, args.downsample, args.progress, model=shared_model)
                mov_paths.append(mov_path)

        for mov_path in mov_paths:
            webm_path = _make_webm_preview(mov_path, emit_progress=args.progress)
            results.append({"nobg_src": mov_path, "nobg_preview_src": webm_path})

        print(json.dumps(results))


if __name__ == "__main__":
    main()
