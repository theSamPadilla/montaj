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
# build_payload — reference images add <<<image_N>>> prefix
# ---------------------------------------------------------------------------

def test_build_payload_reference_images(tmp_path):
    ref1 = tmp_path / "ref1.png"
    ref1.write_bytes(b"R1")
    ref2 = tmp_path / "ref2.png"
    ref2.write_bytes(b"R2")
    result = build_payload(prompt="a person dancing", reference_image_paths=[str(ref1), str(ref2)])
    body = result["body"]
    assert body["prompt"].startswith("<<<image_1>>> <<<image_2>>> ")
    assert "a person dancing" in body["prompt"]
    # reference images have no type key
    assert len(body["image_list"]) == 2
    assert "type" not in body["image_list"][0]
    assert "type" not in body["image_list"][1]


# ---------------------------------------------------------------------------
# build_payload — prompt truncation
# ---------------------------------------------------------------------------

def test_build_payload_truncates_long_prompt():
    long_prompt = "x" * (MAX_PROMPT_CHARS + 500)
    result = build_payload(prompt=long_prompt)
    assert result["truncated"] is True
    assert result["original_prompt_length"] == MAX_PROMPT_CHARS + 500
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
