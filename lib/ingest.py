#!/usr/bin/env python3
"""Ingest a single new source clip into an already-initialized project.

Reproduces `montaj init`'s per-clip ingest pipeline (stage -> probe ->
normalize -> proxy) for ONE source, so a clip can be added to a project after
init and land a `sources` entry identical in shape to what init writes. This is
the shared primitive behind a post-init "add clip" route; init itself is
untouched — it stays the source of truth for the multi-clip creation flow, and
this module mirrors its per-clip decisions (see project/init.py:_normalize_one,
_schedule_proxy, _copy_into_workspace).

Deliberate deviations from init (all sound for a single, synchronous add):
  - No proxy inline-duration gate. init defers long-source proxies to a
    backfill job because it runs inside serve's 1800s project-creation budget;
    a standalone add has no such budget, so it always proxies inline.
  - No concurrency machinery (ThreadPoolExecutor, encode semaphores, per-path
    proxy locks). Those exist to parallelize N clips safely; here there is one
    clip and one caller.
  - Staging is copy-only (init also offers a symlink path for clips-workflow
    fan-out, which this entry point does not need).
"""
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import get_duration

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # add repo root so `from lib.types...` works
from lib.normalize import probe_video, is_normalized, normalized_output_path, normalize
from lib.proxy import proxy_path_for, is_proxy_fresh, make_proxy
from lib.types.colorspace import detect_from_transfer, is_hdr, require_valid_key


def _is_inside(path: str, directory: str) -> bool:
    """True if *path*'s realpath is *directory*'s realpath or nested under it."""
    path = os.path.realpath(path)
    directory = os.path.realpath(directory)
    return path == directory or path.startswith(directory + os.sep)


def _stage_into_project(src: str, project_dir: str, prefix: str) -> str:
    """Copy *src* into *project_dir*, avoiding name collisions with a numeric suffix.

    Faithful replication of project/init.py:_copy_into_workspace's copy path: on
    collision the destination is renamed ``<base>_<prefix><N><ext>`` where N
    starts at 2. Returns the copied file's path.

    Replicated rather than imported: that helper is private, and importing
    project.init into a lib/ module would both invert the lib<-project
    dependency layering and pull init's entire CLI import tree (remote_io,
    profile_assets, workflow, the type modules) into this small primitive.
    Copy-only here — post-init ingest never symlinks.

    Guard: when *src* already lives inside *project_dir* — e.g. a browser
    upload staged there by an existing route before ingest runs — no copy is
    made; the file is used in place. Without this, a source already staged at
    (say) ``<project_dir>/uploads/shot.mp4`` would get copied a second time to
    ``<project_dir>/shot.mp4`` (or ``shot_clip2.mp4`` on a name collision),
    leaving a duplicate on disk. Native-picker sources (outside project_dir)
    are unaffected and still get copied in as before.
    """
    if _is_inside(src, project_dir):
        return src
    name = os.path.basename(src)
    dest = os.path.join(project_dir, name)
    if os.path.exists(dest):
        base, ext = os.path.splitext(name)
        counter = 2
        while os.path.exists(os.path.join(project_dir, f"{base}_{prefix}{counter}{ext}")):
            counter += 1
        dest = os.path.join(project_dir, f"{base}_{prefix}{counter}{ext}")
    shutil.copy2(src, dest)
    return dest


def ingest_source(
    project_dir: str,
    src_path: str,
    color_space: str,
    normalize_mode: str = "eager",
    *,
    proxy: bool = True,
    clip_id: str | None = None,
) -> dict:
    """Ingest one source video into an initialized project; return its clip dict.

    Mirrors init's per-clip pipeline for a single source:
      1. Stage (copy) the source into *project_dir* (collision-suffixed).
      2. Probe it.
      3. Normalize per *normalize_mode* ("eager" transcodes non-conformant
         sources to *color_space*; "lazy" leaves the source untouched).
      4. Record source duration.
      5. Generate a preview proxy (unless *proxy* is False).

    Args:
      project_dir: project directory the clip is staged into and artifacts land in.
      src_path: source video to ingest (may live outside *project_dir*).
      color_space: project target color space key (one of the valid
        `ColorSpaceKey`s). Validated up front — raises ValueError if unknown.
      normalize_mode: "eager" (default) or "lazy", same semantics as init.
      proxy: whether to encode a preview proxy.
      clip_id: id for the returned dict. When None (default), the ``id`` key is
        OMITTED entirely so the caller (e.g. the add-clip route) assigns the
        final id when appending to ``project["sources"]`` — this keeps id
        allocation the caller's responsibility, exactly as init owns ``clip-<i>``.

    Returns a clip dict of the same shape init writes, plus source dimensions:
        {"id"?, "type": "video", "src", "start": 0.0, "end": 0.0,
         "sourceDuration", "sourceWidth"?, "sourceHeight"?, "sourceCreatedAt"?,
         "proxySrc"?}
    Optional keys: ``id`` only when *clip_id* is given; ``sourceWidth`` /
    ``sourceHeight`` only when the probe succeeded; ``sourceCreatedAt`` only when
    the container carried a `creation_time` tag; ``proxySrc`` only when a
    proxy was generated (or an already-fresh one adopted). Transcode/proxy
    failures never raise — they fall back to the staged source and no proxy,
    mirroring init.
    """
    require_valid_key(color_space)

    staged_src = os.path.abspath(_stage_into_project(os.path.abspath(src_path), project_dir, "clip"))
    info = probe_video(staged_src)

    clip: dict = {}
    if clip_id is not None:
        clip["id"] = clip_id
    clip["type"] = "video"
    clip["src"] = staged_src
    clip["start"] = 0.0
    clip["end"] = 0.0

    if normalize_mode == "lazy":
        # No transcode — src stays the staged original; the proxy tonemaps from
        # the original's own (possibly HDR) transfer, encoded from its realpath
        # so symlinked fan-out children converge on one shared proxy (init's
        # lazy-arm contract).
        proxy_src = os.path.realpath(staged_src)
        proxy_tonemap = is_hdr(detect_from_transfer(info.get("color_transfer"))) if info else False
    else:
        # Eager: conform non-normalized sources to the project color space.
        master_color_space = color_space
        if info is not None and not is_normalized(staged_src, info, color_space):
            tonemapped = (
                is_hdr(detect_from_transfer(info.get("color_transfer")))
                and color_space == "sdr_bt709"
            )
            out = normalized_output_path(staged_src, color_space, tonemapped=tonemapped)
            try:
                normalize(staged_src, out, color_space, info=info)
                clip["src"] = out
            except SystemExit:
                # normalize() fails via fail() -> SystemExit; keep the original
                # src and tag the proxy from the source's real (HDR) color.
                master_color_space = detect_from_transfer(info.get("color_transfer"))
        # Proxy is encoded from the post-normalize master, so it only tonemaps
        # when that master is itself HDR (an eager HDR-native project, or a
        # transcode that fell back to the untouched HDR original).
        proxy_src = clip["src"]
        proxy_tonemap = is_hdr(master_color_space)

    # Source duration — computed against the final src (post-normalize in eager).
    try:
        clip["sourceDuration"] = get_duration(clip["src"])
    except (Exception, SystemExit):
        pass

    if info is not None:
        clip["sourceWidth"] = info["display_width"]
        clip["sourceHeight"] = info["display_height"]
        # Recording timestamp (ISO 8601), when the container carries one — lets
        # the footage bin sort by "Date created". Absent for footage with no
        # creation_time tag, which the bin sorts last.
        if info.get("creation_time"):
            clip["sourceCreatedAt"] = info["creation_time"]

    if proxy and info is not None:
        proxy_out = proxy_path_for(proxy_src)
        try:
            if not is_proxy_fresh(proxy_out, proxy_src):
                make_proxy(proxy_src, proxy_out, tonemap=proxy_tonemap, info=info)
            clip["proxySrc"] = proxy_out
        except (Exception, SystemExit):
            pass  # proxies are an enhancement, never a blocker (mirrors init)

    return clip
