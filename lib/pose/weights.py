"""The pose models: pinned files, fetched on first use into the models dir
(family "pose") by lib/models.ensure_model, and converted to ONNX there.

The hand models are MediaPipe's own, from its hand landmarker bundle (a zip
holding hand_detector.tflite and hand_landmarks_detector.tflite). On first use
the bundle is downloaded and checked against its sha256, and each model is
rewritten as ONNX (lib/pose/tflite.py) beside it. A converted file is checked
against its own sha256, so every platform runs the same bytes; a converter
change that alters them must change CONVERTED and its pins together.

MONTAJ_MODEL_MIRROR, when set, is a base URL serving the same files as
<base>/pose/<filename>: https, or http on this machine (localhost, 127.0.0.1)
for tests. Anything else, file:// and bare paths included, is refused. The
sha256 pins hold either way, so a mirror can only serve these exact bytes.

Licence: Google's MediaPipe hand landmarker models, Copyright Google LLC,
Apache License 2.0 (per their model card). Downloaded from Google and converted
to ONNX on the user's machine; the conversion changes the file format only,
never a weight.
"""
import hashlib
import os
import urllib.parse
import zipfile
from collections import namedtuple

from lib import models
from lib.pose.tflite import ConversionError, convert

FAMILY = "pose"
MIRROR_ENV = "MONTAJ_MODEL_MIRROR"

Model = namedtuple("Model", "name filename size sha256 url")


class MirrorError(ValueError):
    pass


_LOCAL_HOSTS = ("localhost", "127.0.0.1")

HAND_BUNDLE = Model(
    "hand_landmarker float16/1",
    "hand_landmarker.task",
    7_819_105,
    "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
)

# The converted models: (bundle member, file written, its sha256). The version
# in the file name is the converter's; a new converter writes new files.
Converted = namedtuple("Converted", "member filename sha256")
PALM = Converted("hand_detector.tflite", "hand_detector.v1.onnx",
                 "cfbaa8f742e4ef7dafb281c0ada81a00336d19f39dbba68344d342919edd8d12")
HAND_LANDMARKS = Converted("hand_landmarks_detector.tflite", "hand_landmarks_detector.v1.onnx",
                           "c555600b285bca0b74210cffb21227972b2bf593c2928534d48698fb4fc3b48e")


def url(model: Model) -> str:
    """The pinned URL, or the mirror's when MONTAJ_MODEL_MIRROR is set (an
    https URL, or http on localhost; anything else raises MirrorError)."""
    base = os.environ.get(MIRROR_ENV, "").strip()
    if not base:
        return model.url
    parts = urllib.parse.urlsplit(base)
    secure = parts.scheme == "https" and bool(parts.hostname)
    local = parts.scheme == "http" and parts.hostname in _LOCAL_HOSTS
    if not (secure or local):
        raise MirrorError(f"{MIRROR_ENV} must be an https:// URL, or http:// on localhost or 127.0.0.1; "
                          f"got {base!r}")
    return f"{base.rstrip('/')}/{FAMILY}/{model.filename}"


def ensure(model: Model) -> str:
    """The model's local path, downloaded and checked against its sha256 on first use."""
    return models.ensure_model(FAMILY, model.filename, url(model), model.sha256)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def converted(bundle_path: str, item: Converted, convert) -> str:
    """The ONNX file for one model of the bundle at bundle_path, written on
    first use by convert(tflite bytes) -> onnx bytes and checked against its pin."""
    dest = models.model_path(FAMILY, item.filename)
    if os.path.isfile(dest):
        with open(dest, "rb") as f:
            if _sha256(f.read()) == item.sha256:
                return dest
    try:
        with zipfile.ZipFile(bundle_path) as z:
            raw = z.read(item.member)
    except (zipfile.BadZipFile, KeyError, OSError) as e:
        raise ConversionError(f"{os.path.basename(bundle_path)} has no readable {item.member} ({e})") from e
    data = convert(raw)
    if _sha256(data) != item.sha256:
        raise ConversionError(f"converting {item.member} gave a file that is not the pinned {item.filename}")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    try:
        with open(part, "wb") as f:
            f.write(data)
        os.replace(part, dest)
    except BaseException:
        try:
            os.remove(part)
        except OSError:
            pass
        raise
    return dest


def hand_models():
    """(palm detector, hand landmark model) as local ONNX paths. A bad mirror
    raises MirrorError; a bundle that will not convert, ConversionError."""
    bundle = ensure(HAND_BUNDLE)
    return converted(bundle, PALM, convert), converted(bundle, HAND_LANDMARKS, convert)
