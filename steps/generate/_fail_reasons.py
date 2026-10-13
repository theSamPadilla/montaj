"""Shared ConnectorError.reason -> fail() mapping for every generate step.

kling_generate, generate_image, generate_voiceover, generate_music,
seedance_generate and generate_sfx all wrap a connector call in
``except ConnectorError as e:`` and used to hand-roll their own
reason -> fail() code table (or, worse, silently collapse every reason but
invalid_api_key into "api_error" — generate_image's old OpenAI path did
exactly that, swallowing insufficient_credit and model_retired). One table,
here, used by all of them.

Not a step itself — a helper module living alongside the steps that import
it (``from _fail_reasons import fail_for``, relying on Python putting a
script's own directory on sys.path when it's the thing being run; callers
that get loaded another way, e.g. via ``importlib.util.spec_from_file_location``
or this file's own test harness, insert this directory onto sys.path
themselves first — see any generate step's imports for the pattern).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from lib.common import fail  # noqa: E402
from connectors import (  # noqa: E402
    ConnectorError, INVALID_API_KEY, INSUFFICIENT_CREDIT, MODEL_RETIRED, UNREACHABLE,
)

# ConnectorError.reason -> fail() code. Anything else (including reason=None,
# the generic/unclassified case) is "api_error".
_FAIL_CODES = {
    INVALID_API_KEY: "invalid_api_key",
    INSUFFICIENT_CREDIT: "insufficient_credit",
    MODEL_RETIRED: "model_retired",
    UNREACHABLE: "provider_unreachable",
}


def fail_for(e: ConnectorError, vendor_label: str) -> None:
    """fail() using the shared reason vocabulary; never returns.

    The message is always the connector's own (``str(e)``) — every
    connector already writes messages that name the vendor and, where
    there's vendor detail to show, quote the vendor's own rejection text
    (see connectors/*.py's ConnectorError call sites: "Kling rejected the
    key: ...", "fal.ai rejected the request ...: ...", "ElevenLabs music
    needs a paid plan.", and so on) — so for those, str(e) reaches fail()
    completely unchanged. `vendor_label` (e.g. "Seedance", "ElevenLabs")
    is prefixed only onto the rarer message that doesn't already name the
    vendor at all — a bare pre-HTTP validation error such as "Prompt must
    not be empty" — so the operator-facing text still says who it's from.
    """
    code = _FAIL_CODES.get(e.reason, "api_error")
    message = str(e)
    if vendor_label and vendor_label.lower() not in message.lower():
        message = f"{vendor_label}: {message}"
    fail(code, message)
