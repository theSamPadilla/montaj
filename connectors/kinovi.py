"""Kinovi model API client: Seedance and Wan video, and image models, behind one job API.

One vendor, one API key, direct HTTP via requests. See docs/CONNECTORS.md for
the layering rule. Facts below were read from Kinovi's own docs on 2026-10-12
(kinovi.ai/docs/api.md, /docs/uploads.md, /docs/account.md and
/docs/models/<id>.md); re-read the model's page before changing its table.

Auth: `Authorization: Bearer <api_key>`. Job flow, the same for every model:
    POST https://kinovi.ai/api/v1/jobs/createTask {model, inputs}   -> {taskId}
        (credits are reserved at submit; a failed task is refunded)
    GET  https://kinovi.ai/api/v1/jobs/recordInfo?taskId=…  until status is
        success (output[0].url) or fail (error {code, message})
    POST /jobs/upgradeDraft {taskId}: a Seedance 2.5 480p draft as a new 1080p task
Local reference files go up first: POST /uploads {fileName} -> {uploadUrl, url,
contentType}; PUT the bytes to uploadUrl with that Content-Type and no key; `url`
is then public for 24 hours. GET /account (free) is the key check and balance.

Kinovi IGNORES unknown `inputs` keys silently (a misspelled field falls back to
its default without an error), so every input is checked here against the
model's own table before anything is sent; a field the model does not take is
refused, never sent.

Current functions:
    build_video_inputs(model, prompt, ...) -> dict    # pure, validates
    build_image_inputs(model, prompt, ...) -> dict    # pure, validates
    generate_video(prompt, out_path, ...) -> dict     # {path, taskId, creditsUsed, ...}
    generate_image(prompt, out_path, ...) -> str      # the image's path
    resume(task_id, out_path) -> dict                 # wait for an already-submitted task
    upgrade_draft(draft_task_id, out_path) -> dict    # Seedance 2.5 draft -> 1080p
    check_key() -> dict

Library code: raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import io, json, mimetypes, os, sys, time
from connectors import (ConnectorError, _http, classify_http_error, retarget_extension,
                        CONTENT_REFUSED, INSUFFICIENT_CREDIT, UNREACHABLE)
from lib.credentials import get_credential, CredentialError

API = "https://kinovi.ai/api/v1"

SEEDANCE_ASPECTS = ("16:9", "9:16", "1:1", "4:3", "3:4", "21:9")
WAN_ASPECTS = ("16:9", "9:16", "4:3", "3:4", "1:1")
SEEDANCE_SEED = (0, 4294967295)   # or -1 for random
WAN_SEED = (0, 2147483647)

# Per model, from its docs page:
#   kind        seedance: keyframe (1-2 images: first/last frame) or reference
#                 mode (more images, any video or audio); wan_t2v: text only;
#                 wan_i2v: 1-2 images (first, optional last), required
#   durations   whole seconds, inclusive
#   resolutions inputs.outputResolution
#   aspects     inputs.aspectRatio
#   images/videos/audios  reference caps (videos/audios: Seedance only, 15 s or
#                 30 s combined, checked by Kinovi after submit and refunded)
#   audio_field the model's sound switch: generate_audio (Seedance) or audio (Wan)
#   prompt_max  characters
#   draft       Seedance 2.5 only: a 480p preview that /jobs/upgradeDraft turns into 1080p
VIDEO_MODELS = {
    "seedance2-5": {
        "kind": "seedance", "durations": (4, 30), "resolutions": ("480p", "720p", "1080p"),
        "aspects": SEEDANCE_ASPECTS, "images": 30, "videos": 10, "audios": 10,
        "audio_field": "generate_audio", "seed": SEEDANCE_SEED, "prompt_max": 30000, "draft": True,
    },
    "seedance-20": {
        "kind": "seedance", "durations": (4, 15), "resolutions": ("480p", "720p", "1080p", "4k"),
        "aspects": SEEDANCE_ASPECTS, "images": 9, "videos": 3, "audios": 3,
        "audio_field": "generate_audio", "seed": SEEDANCE_SEED, "prompt_max": 10000,
    },
    "seedance2-fast": {
        "kind": "seedance", "durations": (4, 15), "resolutions": ("480p", "720p"),
        "aspects": SEEDANCE_ASPECTS, "images": 9, "videos": 3, "audios": 3,
        "audio_field": "generate_audio", "seed": SEEDANCE_SEED, "prompt_max": 10000,
    },
    "seedance2.0-mini": {
        "kind": "seedance", "durations": (4, 15), "resolutions": ("480p", "720p"),
        "aspects": SEEDANCE_ASPECTS, "images": 9, "videos": 3, "audios": 3,
        "audio_field": "generate_audio", "seed": SEEDANCE_SEED, "prompt_max": 10000,
    },
    "wan3.0-text-to-video": {
        "kind": "wan_t2v", "durations": (2, 30), "resolutions": ("480p", "720p", "1080p"),
        "aspects": WAN_ASPECTS, "images": 0, "videos": 0, "audios": 0,
        "audio_field": "audio", "seed": WAN_SEED, "prompt_max": 20000,
    },
    "wan3.0-image-to-video": {
        "kind": "wan_i2v", "durations": (2, 30), "resolutions": ("480p", "720p", "1080p"),
        "aspects": WAN_ASPECTS + ("adaptive",), "images": 2, "videos": 0, "audios": 0,
        "audio_field": "audio", "seed": WAN_SEED, "prompt_max": 20000,
    },
}
DEFAULT_VIDEO_MODEL = "seedance2-5"   # Sam's pick (§227)

# Per image model, from its docs page: aspects, resolutions (inputs.resolution),
# refs (inputs.uploadedUrls cap), quality (gpt-image-2 only), formats
# (inputs.outputFormat, where the model takes one). One image per task.
IMAGE_MODELS = {
    "nanobanana-pro": {"aspects": ("1:1", "4:3", "3:4", "16:9", "9:16"), "resolutions": ("1k", "2k", "4k"),
                       "default_resolution": "2k", "refs": 9},
    "nanobanana2": {"aspects": ("1:1", "4:3", "3:4", "16:9", "9:16"), "resolutions": ("2k", "4k"),
                    "default_resolution": "2k", "refs": 9},
    "gpt-image-2": {"aspects": ("auto", "1:1", "4:3", "3:4", "16:9", "9:16"), "resolutions": ("1k", "2k", "4k"),
                    "default_resolution": "1k", "refs": 10, "quality": ("low", "medium", "high"),
                    "formats": ("png", "jpeg")},
    "seedream-5.0-pro": {"aspects": ("auto", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"),
                         "resolutions": ("1k", "2k"), "default_resolution": "2k", "refs": 10,
                         "formats": ("png", "jpeg")},
}
DEFAULT_IMAGE_MODEL = "nanobanana-pro"

# Kinovi's pages: images finish within a minute; video 2-4 min at 480p-1080p,
# about 8 min at 4k, 5-7 min with a reference video ("stuck only after 10
# minutes"). The poll stops short of serve's default 900 s step timeout, and
# says the task id so `resume` can pick it up without paying twice.
POLL_INTERVAL_S = 5.0
MAX_POLL_S = 840.0
MAX_CONSECUTIVE_POLL_FAILURES = 5
# A submit refused for concurrency queued nothing and charged nothing: wait for
# a slot (one frees when one of the account's tasks finishes), up to this long.
CONCURRENCY_WAIT_S, CONCURRENCY_POLL_S = 300.0, 15.0

# References re-encoded through Pillow as JPEG (EXIF-rotated, transparency on
# white), longest side capped. Seedance 2.5 takes 300-6000 px wide; Wan up to 8000.
IMAGE_MAX_SIDE = 4096
JPEG_QUALITY = 92

# Task error text that means Kinovi (or the model under it) refused the content.
_REFUSED_WORDS = ("moderation", "facedetectionsuspect", "real human face", "copyright",
                  "asset_review_failed", "content was blocked", "content review", "sensitive")


def _warn(message: str) -> None:
    print(json.dumps({"warn": message}), file=sys.stderr)


def _key() -> str:
    try:
        return get_credential("kinovi", "api_key").strip()
    except CredentialError as e:
        raise CredentialError(f"Kinovi needs an API key. {e}") from e


def _headers() -> dict:
    return {"Authorization": f"Bearer {_key()}", "Content-Type": "application/json"}


def _body(resp) -> dict:
    try:
        b = resp.json()
        return b if isinstance(b, dict) else {}
    except Exception:
        return {}


def _message(resp) -> str:
    """Kinovi's error text: {message, errors?, required?, available?, limit?, current?}."""
    b = _body(resp)
    msg = str(b.get("message") or b.get("error") or (resp.text or ""))[:400]
    errors = b.get("errors")
    if isinstance(errors, list) and errors:
        msg += ": " + "; ".join(
            str(e.get("message") or e) if isinstance(e, dict) else str(e) for e in errors)[:400]
    return msg


def _http_error(resp, what: str) -> ConnectorError:
    status, b, msg = resp.status_code, _body(resp), _message(resp)
    if status == 402:
        need, have = b.get("required"), b.get("available")
        detail = f" It needs {need} credits; the balance is {have}." if need is not None else ""
        return ConnectorError(f"Kinovi: not enough credits.{detail} Add credit at kinovi.ai/pricing.",
                              reason=INSUFFICIENT_CREDIT)
    if status == 403 and "access denied" not in msg.lower():
        return ConnectorError(f"Kinovi {what}: this account can't use that model ({msg})")
    return ConnectorError(f"Kinovi {what} failed (HTTP {status}): {msg}",
                          reason=classify_http_error(status, msg))


def _get(path: str, what: str, **kwargs):
    try:
        return _http.request_with_retry("GET", f"{API}{path}", headers=_headers(), **kwargs)
    except ConnectorError as e:
        raise ConnectorError(f"Kinovi {what} failed: {e}", reason=UNREACHABLE) from e


def _range(name: str, value, lo_hi: tuple[int, int], model: str) -> int:
    if isinstance(value, str) and value.lstrip("-").isdigit():
        value = int(value)
    if not isinstance(value, int) or isinstance(value, bool) or not lo_hi[0] <= value <= lo_hi[1]:
        raise ConnectorError(f"{model} {name} must be {lo_hi[0]}-{lo_hi[1]}, got {value!r}")
    return value


def _one_of(name: str, value, allowed: tuple, model: str):
    if value not in allowed:
        raise ConnectorError(f"{model} {name} must be one of {', '.join(allowed)}, got {value!r}")
    return value


def _seed(seed, lo_hi: tuple[int, int], model: str) -> int:
    if seed == -1:
        return -1
    return _range("seed", seed, lo_hi, model)


def build_video_inputs(
    model: str,
    prompt: str,
    image_urls: list[str] = None,
    reference: bool = False,
    video_urls: list[str] = None,
    audio_urls: list[str] = None,
    duration=5,
    aspect_ratio: str = None,
    resolution: str = "720p",
    sound: bool = False,
    seed: int = None,
    draft: bool = False,
) -> dict:
    """Validate against the model's table and build `inputs`. No HTTP.

    image_urls: frames (keyframe: first, then last when end_image) or, with
    reference=True, reference images. video_urls/audio_urls are Seedance
    references (they put Seedance in reference mode; audio needs an image or
    a video beside it). The sound switch is sent explicitly every time, so
    Kinovi's own default (on) never decides it.
    """
    if model not in VIDEO_MODELS:
        raise ConnectorError(f"Unknown Kinovi video model {model!r}; supported: {', '.join(VIDEO_MODELS)}")
    m = VIDEO_MODELS[model]
    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")
    if len(prompt) > m["prompt_max"]:
        raise ConnectorError(f"{model} prompt is {len(prompt)} characters; the limit is {m['prompt_max']}")
    images, videos, audios = list(image_urls or []), list(video_urls or []), list(audio_urls or [])
    kind = m["kind"]

    if kind == "wan_t2v" and (images or videos or audios):
        raise ConnectorError(f"{model} is text-to-video: it takes no images, videos or audio "
                             f"(use wan3.0-image-to-video for frames)")
    if kind == "wan_i2v":
        if videos or audios or reference:
            raise ConnectorError(f"{model} takes 1-2 frame images only (first, optional last)")
        if not images:
            raise ConnectorError(f"{model} needs a first frame image (and optionally a last)")
        if len(images) > 2:
            raise ConnectorError(f"{model} takes 1-2 frame images (first, optional last), got {len(images)}")
    if len(images) > max(m["images"], 0):
        raise ConnectorError(f"{model} takes up to {m['images']} images, got {len(images)}")
    if len(videos) > m["videos"]:
        raise ConnectorError(f"{model} takes up to {m['videos']} reference videos, got {len(videos)}")
    if len(audios) > m["audios"]:
        raise ConnectorError(f"{model} takes up to {m['audios']} reference audio clips, got {len(audios)}")
    if audios and not (images or videos):
        raise ConnectorError(f"{model}: reference audio needs at least one image or video beside it")

    inputs = {"prompt": prompt}
    inputs["duration"] = _range("duration", duration, m["durations"], model)
    inputs["outputResolution"] = _one_of("resolution", resolution, m["resolutions"], model)

    mode = None
    if kind == "seedance":
        if reference or videos or audios:
            mode = "reference"
        elif images:
            if len(images) > 2:
                raise ConnectorError(f"{model}: more than 2 images are references; pass them as references")
            mode = "keyframe"
        if mode:
            inputs["mode"] = mode
    if images:
        inputs["imageUrls"] = images
    if videos:
        inputs["videoUrls"] = videos
    if audios:
        inputs["audioUrls"] = audios

    # Seedance keyframe keeps the first frame's ratio; Wan image-to-video takes "adaptive" for that.
    frames = mode == "keyframe" or kind == "wan_i2v"
    if aspect_ratio is not None:
        if mode == "keyframe":
            _warn(f"{model} keyframe mode follows the first frame's aspect ratio; ignoring {aspect_ratio!r}")
        else:
            inputs["aspectRatio"] = _one_of("aspect_ratio", aspect_ratio, m["aspects"], model)
    elif kind == "wan_i2v":
        inputs["aspectRatio"] = "adaptive"
    elif not frames and not (mode == "reference"):
        inputs["aspectRatio"] = "16:9"   # Kinovi's own default, sent so it is never a silent guess

    inputs[m["audio_field"]] = bool(sound)
    if seed is not None:
        inputs["seed"] = _seed(seed, m["seed"], model)
    if draft:
        if not m.get("draft"):
            raise ConnectorError(f"{model} has no draft mode (seedance2-5 only)")
        if resolution != "480p":
            raise ConnectorError(f"{model} drafts are 480p only, got {resolution!r}")
        inputs["draft"] = True
    return inputs


def build_image_inputs(
    model: str,
    prompt: str,
    ref_urls: list[str] = None,
    aspect_ratio: str = None,
    resolution: str = None,
    quality: str = None,
    output_format: str = None,
) -> dict:
    """Validate against the image model's table and build `inputs`. No HTTP."""
    if model not in IMAGE_MODELS:
        raise ConnectorError(f"Unknown Kinovi image model {model!r}; supported: {', '.join(IMAGE_MODELS)}")
    m = IMAGE_MODELS[model]
    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")
    refs = list(ref_urls or [])
    if len(refs) > m["refs"]:
        raise ConnectorError(f"{model} takes up to {m['refs']} reference images, got {len(refs)}")
    inputs = {"prompt": prompt}
    if refs:
        inputs["uploadedUrls"] = refs
    if aspect_ratio is not None:
        inputs["aspectRatio"] = _one_of("aspect_ratio", aspect_ratio, m["aspects"], model)
    inputs["resolution"] = _one_of("resolution", resolution or m["default_resolution"], m["resolutions"], model)
    if quality is not None:
        if "quality" not in m:
            raise ConnectorError(f"{model} takes no quality setting (gpt-image-2 does)")
        inputs["quality"] = _one_of("quality", quality, m["quality"], model)
    if output_format is not None:
        if "formats" not in m:
            raise ConnectorError(f"{model} takes no output format; its images are PNG or JPEG as it makes them")
        inputs["outputFormat"] = _one_of("output_format", output_format, m["formats"], model)
    return inputs


def _image_bytes(path: str) -> bytes:
    """An image file as JPEG bytes: EXIF-rotated, transparency on white, longest side capped."""
    from PIL import Image, ImageOps
    try:
        with Image.open(path) as src:
            im = ImageOps.exif_transpose(src)
            if im.mode in ("RGBA", "LA", "P", "PA"):
                im = im.convert("RGBA")
                flat = Image.new("RGB", im.size, (255, 255, 255))
                flat.paste(im, mask=im.getchannel("A"))
                im = flat
            else:
                im = im.convert("RGB")
            if max(im.size) > IMAGE_MAX_SIDE:
                im.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=JPEG_QUALITY)
    except OSError as e:
        raise ConnectorError(f"Could not read image file {path}: {e}") from e
    return buf.getvalue()


def upload(path: str, *, image: bool = False) -> str:
    """Upload a local file to Kinovi's storage; its public URL (valid 24 h). An
    image is re-encoded as JPEG first; video and audio go as they are."""
    if image:
        data, name = _image_bytes(path), os.path.splitext(os.path.basename(path))[0] + ".jpg"
    else:
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError as e:
            raise ConnectorError(f"Could not read {path}: {e}") from e
        name = os.path.basename(path)
    try:
        r = _http.request_with_retry("POST", f"{API}/uploads", headers=_headers(),
                                     json={"fileName": name}, timeout=30)
    except ConnectorError as e:
        raise ConnectorError(f"Kinovi upload failed: {e}", reason=UNREACHABLE) from e
    if r.status_code >= 400:
        raise _http_error(r, "upload")
    slot = _body(r)
    if not slot.get("uploadUrl") or not slot.get("url"):
        raise ConnectorError(f"Kinovi upload returned no upload URL for {name}")
    content_type = slot.get("contentType") or mimetypes.guess_type(name)[0] or "application/octet-stream"
    try:
        # The signed URL is the credential: no API key on the PUT.
        put = _http.request_with_retry("PUT", slot["uploadUrl"], data=data,
                                       headers={"Content-Type": content_type}, timeout=300)
    except ConnectorError as e:
        raise ConnectorError(f"Kinovi upload of {name} failed: {e}", reason=UNREACHABLE) from e
    if put.status_code >= 400:
        raise ConnectorError(f"Kinovi storage refused the upload of {name} (HTTP {put.status_code})")
    return slot["url"]


def _media_urls(paths, *, image: bool) -> list[str]:
    """Each local path uploaded (URLs pass through as they are)."""
    out = []
    for p in paths or []:
        out.append(p if p.startswith(("http://", "https://")) else upload(p, image=image))
    return out


def create_task(model: str, inputs: dict) -> str:
    """POST the task. Returns its taskId. A concurrency refusal (429) queued
    nothing, so it is waited out (a slot frees when a task finishes) for up to
    CONCURRENCY_WAIT_S; a timed-out POST may already be a paid task, so it is
    never retried."""
    waited = 0.0
    while True:
        try:
            r = _http.request_with_retry("POST", f"{API}/jobs/createTask", headers=_headers(),
                                         json={"model": model, "inputs": inputs}, timeout=120,
                                         retry_statuses=frozenset(), retry_exceptions=False)
        except ConnectorError as e:
            raise ConnectorError(
                f"Kinovi submit failed: {e}. If it timed out, the task may still have been "
                f"created and charged; check kinovi.ai before generating again.") from e
        if r.status_code == 429 and waited < CONCURRENCY_WAIT_S:
            time.sleep(CONCURRENCY_POLL_S)
            waited += CONCURRENCY_POLL_S
            continue
        if r.status_code == 429:
            b = _body(r)
            raise ConnectorError(
                f"Kinovi is already running {b.get('current', 'all')} of the "
                f"{b.get('limit', 'allowed')} tasks this account may run at once. "
                f"Try again when one finishes.")
        if r.status_code >= 400:
            raise _http_error(r, "submit")
        task_id = _body(r).get("taskId")
        if not task_id:
            raise ConnectorError("Kinovi accepted the task but returned no taskId")
        return task_id


def _refused(error: dict) -> ConnectorError | None:
    code, message = str(error.get("code") or ""), str(error.get("message") or "")
    text = f"{code} {message}".lower()
    if "facedetectionsuspect" in text or "real human face" in text:
        return ConnectorError(
            "Kinovi refused it: it looked like a real, identifiable person's face "
            "(FaceDetectionSuspect). Describe a fictional or stylised character instead.",
            reason=CONTENT_REFUSED)
    if any(w in text for w in _REFUSED_WORDS):
        return ConnectorError(
            f"Kinovi's content review refused the prompt, a reference or the result ({message or code}). "
            f"Change the prompt or the reference and try again.", reason=CONTENT_REFUSED)
    return None


def wait(task_id: str) -> dict:
    """Poll recordInfo until success; the record. A failed task raises
    (Kinovi refunds it). Transient poll failures are tolerated
    (MAX_CONSECUTIVE_POLL_FAILURES in a row); the task is already paid for, so
    giving up says how to pick it up again rather than to regenerate."""
    elapsed, failures, last = 0.0, 0, None
    while elapsed < MAX_POLL_S:
        record = None
        try:
            r = _http.request_with_retry("GET", f"{API}/jobs/recordInfo", headers=_headers(),
                                         params={"taskId": task_id}, timeout=30)
        except ConnectorError as e:
            last = e
        else:
            if r.status_code >= 400 and r.status_code not in _http.TRANSIENT_STATUS:
                raise _http_error(r, f"status check for task {task_id}")
            if r.status_code >= 400:
                last = f"HTTP {r.status_code}"
            else:
                record = _body(r)
        if record is None:
            failures += 1
            if failures >= MAX_CONSECUTIVE_POLL_FAILURES:
                raise ConnectorError(
                    f"Kinovi task {task_id}: {failures} status checks failed in a row. It may still "
                    f"finish; resume it with --task-id {task_id} instead of generating again. "
                    f"Last error: {last}")
        else:
            failures = 0
            status = record.get("status") or record.get("state")
            if status == "success":
                return record
            if status == "fail":
                error = record.get("error") or {}
                raise _refused(error) or ConnectorError(
                    f"Kinovi task {task_id} failed ({error.get('code') or 'no code'}): "
                    f"{error.get('message') or 'no message'}. Its credits are refunded.")
        time.sleep(POLL_INTERVAL_S)
        elapsed += POLL_INTERVAL_S
    raise ConnectorError(
        f"Kinovi task {task_id} is still running after {MAX_POLL_S:.0f} s. It is paid for and "
        f"may still finish: resume it with --task-id {task_id} instead of generating again.")


def _download(record: dict, out_path: str, task_id: str, *, image: bool) -> str:
    outputs = record.get("output") or []
    first = outputs[0] if outputs and isinstance(outputs[0], dict) else {}
    url = first.get("url")
    if not url:
        raise ConnectorError(f"Kinovi task {task_id} succeeded but returned no output URL")
    media = str(first.get("mediaType") or "")
    if image:
        # Named after what the bytes are: some models answer JPEG whatever the request said.
        ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(media)
        if ext:
            out_path = retarget_extension(out_path, ext)
    elif media == "video/quicktime":
        out_path = retarget_extension(out_path, ".mov")
    return _http.download_file(url, out_path, timeout=300)


def _result(record: dict, path: str, task_id: str) -> dict:
    return {"path": path, "taskId": task_id, "model": record.get("model"),
            "creditsUsed": record.get("creditsUsed"), "draft": bool(record.get("draft"))}


def generate_video(
    prompt: str,
    out_path: str,
    model: str = DEFAULT_VIDEO_MODEL,
    image_path: str = None,
    end_image_path: str = None,
    reference_image_paths: list[str] = None,
    reference_video_paths: list[str] = None,
    reference_audio_paths: list[str] = None,
    duration=5,
    aspect_ratio: str = None,
    resolution: str = "720p",
    sound: bool = False,
    seed: int = None,
    draft: bool = False,
) -> dict:
    """Validate, upload the references, submit, wait, download. Returns
    {path, taskId, model, creditsUsed, draft}. Everything is checked before any
    upload or submit (a dry build with placeholder URLs)."""
    if not out_path:
        raise ConnectorError("out_path is required")
    if image_path and reference_image_paths:
        raise ConnectorError("Use either frames (image_path, end_image_path) or reference images, not both")
    if end_image_path and not image_path:
        raise ConnectorError("An end frame needs a first frame (image_path)")
    frames = [p for p in (image_path, end_image_path) if p]
    refs = list(reference_image_paths or [])
    kwargs = dict(reference=bool(refs), duration=duration,
                  aspect_ratio=aspect_ratio, resolution=resolution, sound=sound, seed=seed, draft=draft)
    # Dry run first: a bad input costs neither an upload nor a submit.
    build_video_inputs(model, prompt, image_urls=["u"] * len(frames or refs),
                       video_urls=["u"] * len(reference_video_paths or []),
                       audio_urls=["u"] * len(reference_audio_paths or []), **kwargs)
    inputs = build_video_inputs(
        model, prompt, image_urls=_media_urls(frames or refs, image=True),
        video_urls=_media_urls(reference_video_paths, image=False),
        audio_urls=_media_urls(reference_audio_paths, image=False), **kwargs)
    task_id = create_task(model, inputs)
    return resume(task_id, out_path)


def resume(task_id: str, out_path: str) -> dict:
    """Wait for an already-submitted video task and download it: no new task, no new charge."""
    if not task_id:
        raise ConnectorError("task_id is required")
    record = wait(task_id)
    return _result(record, _download(record, out_path, task_id, image=False), task_id)


def upgrade_draft(draft_task_id: str, out_path: str) -> dict:
    """A Seedance 2.5 480p draft as a new 1080p task (billed as a 1080p video of
    the draft's length, within 7 days of the draft), waited for and downloaded."""
    if not draft_task_id:
        raise ConnectorError("the draft's task id is required")
    try:
        r = _http.request_with_retry("POST", f"{API}/jobs/upgradeDraft", headers=_headers(),
                                     json={"taskId": draft_task_id}, timeout=120,
                                     retry_statuses=frozenset(), retry_exceptions=False)
    except ConnectorError as e:
        raise ConnectorError(f"Kinovi draft upgrade failed: {e}. If it timed out, it may still "
                             f"have been created; check kinovi.ai before trying again.") from e
    if r.status_code >= 400:
        raise _http_error(r, "draft upgrade")
    task_id = _body(r).get("taskId")
    if not task_id:
        raise ConnectorError("Kinovi accepted the draft upgrade but returned no taskId")
    return resume(task_id, out_path)


def generate_image(
    prompt: str,
    out_path: str,
    model: str = DEFAULT_IMAGE_MODEL,
    ref_images: list[str] = None,
    aspect_ratio: str = None,
    resolution: str = None,
    quality: str = None,
    output_format: str = None,
) -> str:
    """Validate, upload the references, submit, wait, download. Returns the
    image's path, its extension matching the bytes."""
    if not out_path:
        raise ConnectorError("out_path is required")
    kwargs = dict(aspect_ratio=aspect_ratio, resolution=resolution, quality=quality, output_format=output_format)
    build_image_inputs(model, prompt, ref_urls=["u"] * len(ref_images or []), **kwargs)
    inputs = build_image_inputs(model, prompt, ref_urls=_media_urls(ref_images, image=True), **kwargs)
    task_id = create_task(model, inputs)
    record = wait(task_id)
    return _download(record, out_path, task_id, image=True)


def check_key() -> dict:
    """Validate the stored/overlaid key with one free call: GET /account (a
    read of the live balance). Returns the balance as `credits`; the account's
    email and name are not passed on. The default model can't be confirmed
    without a task, so default_model_verified is False."""
    r = _get("/account", "key check", timeout=15)
    if r.status_code >= 400:
        raise _http_error(r, "key check")
    credits = _body(r).get("credits")
    return {
        "ok": True,
        "default_model": DEFAULT_VIDEO_MODEL,
        "default_model_ok": True,
        "default_model_verified": False,
        "credits": credits,
        "detail": f"balance {credits} credits" if credits is not None else "balance unknown",
    }
