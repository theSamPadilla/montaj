"""Tests for connectors.kling — pure functions only, no network."""
import base64
import pytest

from connectors import ConnectorError
from connectors.kling import build_payload, _file_to_base64, MAX_PROMPT_CHARS, MAX_REF_IMAGES, MODEL_NAME


# ---------------------------------------------------------------------------
# _file_to_base64
# ---------------------------------------------------------------------------

def test_file_to_base64(tmp_path):
    p = tmp_path / "pixel.bin"
    p.write_bytes(b"\x89PNG\r\n\x1a\nfakedata")
    result = _file_to_base64(str(p))
    assert result == base64.b64encode(b"\x89PNG\r\n\x1a\nfakedata").decode("ascii")


# ---------------------------------------------------------------------------
# build_payload — text only
# ---------------------------------------------------------------------------

def test_build_payload_text_only():
    result = build_payload(prompt="A cat walking")
    body = result["body"]
    assert body["model_name"] == MODEL_NAME
    assert body["prompt"] == "A cat walking"
    assert "image_list" not in body
    assert result["truncated"] is False
    assert result["original_prompt_length"] == len("A cat walking")


# ---------------------------------------------------------------------------
# build_payload — first frame only
# ---------------------------------------------------------------------------

def test_build_payload_first_frame(tmp_path):
    img = tmp_path / "first.png"
    img.write_bytes(b"\x00\x01\x02")
    result = build_payload(prompt="test", first_frame_path=str(img))
    body = result["body"]
    assert "image_list" in body
    assert len(body["image_list"]) == 1
    assert body["image_list"][0]["type"] == "first_frame"
    assert body["image_list"][0]["image_url"] == base64.b64encode(b"\x00\x01\x02").decode("ascii")


# ---------------------------------------------------------------------------
# build_payload — first + last frame
# ---------------------------------------------------------------------------

def test_build_payload_first_and_last_frame(tmp_path):
    first = tmp_path / "first.png"
    first.write_bytes(b"FIRST")
    last = tmp_path / "last.png"
    last.write_bytes(b"LAST")
    result = build_payload(prompt="test", first_frame_path=str(first), last_frame_path=str(last))
    body = result["body"]
    assert len(body["image_list"]) == 2
    assert body["image_list"][0]["type"] == "first_frame"
    assert body["image_list"][1]["type"] == "end_frame"


# ---------------------------------------------------------------------------
# build_payload — reference images (connector is pure pass-through;
# caller owns <<<image_N>>> token placement in the prompt)
# ---------------------------------------------------------------------------

def test_build_payload_reference_images(tmp_path):
    ref1 = tmp_path / "ref1.png"
    ref1.write_bytes(b"R1")
    ref2 = tmp_path / "ref2.png"
    ref2.write_bytes(b"R2")
    result = build_payload(prompt="a person dancing", reference_image_paths=[str(ref1), str(ref2)])
    body = result["body"]
    # Connector prepends a ref clause: "Use the character/style from <<<image_1>>>, <<<image_2>>>. "
    assert body["prompt"].startswith("Use the character/style from <<<image_1>>>, <<<image_2>>>. ")
    assert body["prompt"].endswith("a person dancing")
    # reference images have no type key
    assert len(body["image_list"]) == 2
    assert "type" not in body["image_list"][0]
    assert "type" not in body["image_list"][1]


def test_build_payload_ref_clause_with_first_frame(tmp_path):
    """When first_frame is present, ref image tokens start after the frame entries."""
    first = tmp_path / "first.png"
    first.write_bytes(b"F")
    ref1 = tmp_path / "ref1.png"
    ref1.write_bytes(b"R1")
    result = build_payload(
        prompt="test", first_frame_path=str(first),
        reference_image_paths=[str(ref1)],
    )
    body = result["body"]
    # first_frame is image_list[0], ref is image_list[1] → token is <<<image_2>>>
    assert "<<<image_2>>>" in body["prompt"]
    assert body["image_list"][0]["type"] == "first_frame"
    assert "type" not in body["image_list"][1]


def test_build_payload_preserves_caller_placed_tokens(tmp_path):
    """Caller-placed inline tokens are preserved alongside the prepended ref clause."""
    ref1 = tmp_path / "ref1.png"
    ref1.write_bytes(b"R1")
    ref2 = tmp_path / "ref2.png"
    ref2.write_bytes(b"R2")
    prompt = "The man <<<image_1>>> walks past the <<<image_2>>> tree"
    result = build_payload(prompt=prompt, reference_image_paths=[str(ref1), str(ref2)])
    # Ref clause is prepended, caller tokens are preserved in the body
    assert result["body"]["prompt"].startswith("Use the character/style from")
    assert "<<<image_1>>> walks past" in result["body"]["prompt"]


# ---------------------------------------------------------------------------
# build_payload — prompt truncation
# ---------------------------------------------------------------------------

def test_build_payload_truncates_long_prompt():
    long_prompt = "x" * (MAX_PROMPT_CHARS + 500)
    result = build_payload(prompt=long_prompt)
    assert result["truncated"] is True
    assert len(result["body"]["prompt"]) == MAX_PROMPT_CHARS


def test_build_payload_exact_limit_not_truncated():
    exact_prompt = "y" * MAX_PROMPT_CHARS
    result = build_payload(prompt=exact_prompt)
    assert result["truncated"] is False
    assert len(result["body"]["prompt"]) == MAX_PROMPT_CHARS


# ---------------------------------------------------------------------------
# build_payload — duration clamping
# ---------------------------------------------------------------------------

def test_build_payload_clamps_duration_below_min():
    result = build_payload(prompt="test", duration_seconds=1)
    assert result["body"]["duration"] == "3"


def test_build_payload_clamps_duration_above_max():
    result = build_payload(prompt="test", duration_seconds=30)
    assert result["body"]["duration"] == "15"


def test_build_payload_keeps_valid_duration():
    result = build_payload(prompt="test", duration_seconds=10)
    assert result["body"]["duration"] == "10"


# ---------------------------------------------------------------------------
# build_payload — optional fields
# ---------------------------------------------------------------------------

def test_build_payload_negative_prompt():
    result = build_payload(prompt="test", negative_prompt="blurry")
    assert result["body"]["negative_prompt"] == "blurry"


def test_build_payload_no_negative_prompt():
    result = build_payload(prompt="test")
    assert "negative_prompt" not in result["body"]


def test_build_payload_custom_params():
    result = build_payload(prompt="test", sound="off", aspect_ratio="9:16", mode="pro")
    body = result["body"]
    assert body["sound"] == "off"
    assert body["aspect_ratio"] == "9:16"
    assert body["mode"] == "pro"


def test_build_payload_external_task_id_included_when_set():
    result = build_payload(prompt="test", external_task_id="scene-abc123")
    assert result["body"]["external_task_id"] == "scene-abc123"


def test_build_payload_external_task_id_omitted_when_none():
    result = build_payload(prompt="test")
    assert "external_task_id" not in result["body"]


# ---------------------------------------------------------------------------
# Validation — empty prompt, ref-image limit, missing file
# ---------------------------------------------------------------------------

def test_build_payload_rejects_empty_prompt():
    with pytest.raises(ConnectorError, match="empty"):
        build_payload(prompt="")


def test_build_payload_rejects_whitespace_prompt():
    with pytest.raises(ConnectorError, match="empty"):
        build_payload(prompt="   ")


def test_build_payload_rejects_too_many_ref_images(tmp_path):
    paths = []
    for i in range(MAX_REF_IMAGES + 1):
        p = tmp_path / f"ref{i}.png"
        p.write_bytes(b"X")
        paths.append(str(p))
    with pytest.raises(ConnectorError, match="Too many reference images"):
        build_payload(prompt="test", reference_image_paths=paths)


def test_file_to_base64_missing_file():
    with pytest.raises(ConnectorError, match="Could not read"):
        _file_to_base64("/nonexistent/path.png")


# ---------------------------------------------------------------------------
# Multi-shot mode
# ---------------------------------------------------------------------------

def _valid_multi_prompt():
    return [
        {"index": 1, "prompt": "A café in the morning.", "duration": "3"},
        {"index": 2, "prompt": "Two people meet eyes.",   "duration": "4"},
    ]


def test_multi_shot_customize_basic():
    result = build_payload(
        multi_shot=True, shot_type="customize", multi_prompt=_valid_multi_prompt()
    )
    body = result["body"]
    assert body["multi_shot"] is True
    assert body["shot_type"] == "customize"
    assert body["multi_prompt"] == _valid_multi_prompt()
    # prompt field is omitted in customize mode (per docs: "prompt is invalid")
    assert "prompt" not in body
    # duration is computed from the sum of shot durations (3 + 4 = 7)
    assert body["duration"] == "7"


def test_multi_shot_intelligence_uses_single_prompt():
    result = build_payload(
        prompt="A whole cohesive story",
        multi_shot=True, shot_type="intelligence",
        duration_seconds=10,
    )
    body = result["body"]
    assert body["multi_shot"] is True
    assert body["shot_type"] == "intelligence"
    assert body["prompt"] == "A whole cohesive story"
    assert "multi_prompt" not in body
    assert body["duration"] == "10"


def test_multi_shot_rejects_missing_shot_type():
    with pytest.raises(ConnectorError, match="shot_type"):
        build_payload(multi_shot=True, multi_prompt=_valid_multi_prompt())


def test_multi_shot_rejects_bad_shot_type():
    with pytest.raises(ConnectorError, match="shot_type"):
        build_payload(multi_shot=True, shot_type="freestyle", multi_prompt=_valid_multi_prompt())


def test_multi_shot_customize_requires_multi_prompt():
    with pytest.raises(ConnectorError, match="multi_prompt"):
        build_payload(multi_shot=True, shot_type="customize")


def test_multi_shot_intelligence_requires_prompt():
    with pytest.raises(ConnectorError, match="non-empty prompt"):
        build_payload(multi_shot=True, shot_type="intelligence")


def test_multi_shot_rejects_first_frame(tmp_path):
    img = tmp_path / "first.png"
    img.write_bytes(b"\x00\x01")
    with pytest.raises(ConnectorError, match="first_frame"):
        build_payload(
            multi_shot=True, shot_type="customize",
            multi_prompt=_valid_multi_prompt(),
            first_frame_path=str(img),
        )


def test_multi_shot_rejects_too_many_shots():
    too_many = [
        {"index": i, "prompt": f"shot {i}", "duration": "1"}
        for i in range(1, 8)  # 7 entries, cap is 6
    ]
    with pytest.raises(ConnectorError, match="1-6 entries"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=too_many)


def test_multi_shot_rejects_empty_shots():
    with pytest.raises(ConnectorError, match="1-6 entries"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=[])


def test_multi_shot_rejects_oversize_shot_prompt():
    oversized = [
        {"index": 1, "prompt": "x" * 513, "duration": "3"},
    ]
    with pytest.raises(ConnectorError, match="512 chars"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=oversized)


def test_multi_shot_rejects_missing_entry_fields():
    bad = [{"index": 1, "prompt": "ok"}]  # missing duration
    with pytest.raises(ConnectorError, match="duration"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=bad)


def test_multi_shot_rejects_non_integer_duration():
    bad = [{"index": 1, "prompt": "ok", "duration": "three"}]
    with pytest.raises(ConnectorError, match="integer durations"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=bad)


def test_single_shot_ignores_multi_prompt_silently():
    # multi_prompt passed without multi_shot=True is a no-op.
    result = build_payload(prompt="hello", multi_prompt=_valid_multi_prompt())
    body = result["body"]
    assert "multi_shot" not in body
    assert "multi_prompt" not in body
    assert body["prompt"] == "hello"


def test_multi_shot_customize_with_ref_images(tmp_path):
    ref1 = tmp_path / "ref1.png"
    ref1.write_bytes(b"R1")
    result = build_payload(
        multi_shot=True, shot_type="customize",
        multi_prompt=_valid_multi_prompt(),
        reference_image_paths=[str(ref1)],
    )
    body = result["body"]
    assert body["multi_shot"] is True
    assert len(body["image_list"]) == 1
    # In customize mode, prompt is omitted from body — per-shot prompts in multi_prompt.
    # No top-level prompt means no ref clause prepended (callers put refs in per-shot prompts).
    assert "prompt" not in body
