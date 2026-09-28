"""The whisper model list is one list (PV27 follow-up).

`montaj models download small.en` succeeded while every whisper step refused
`--model small.en`: the steps' schema `options`, their argparse `choices` and
the `models` CLI were separate hand-kept lists and had drifted. These tests pin
all of them to lib/common.WHISPER_MODEL_CHOICES.
"""
import argparse
import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))

import common  # noqa: E402
import cli.step_command as sc  # noqa: E402
from cli.commands import models as models_cmd  # noqa: E402
from serve.routes.steps import validate_params  # noqa: E402


def _whisper_model_params():
    """Every step schema whose `model` param defaults to the whisper default."""
    out = []
    for path in sorted((REPO_ROOT / "steps").rglob("*.json")):
        try:
            schema = json.loads(path.read_text())
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(schema, dict):
            continue
        for param in schema.get("params", []):
            if param.get("name") == "model" and param.get("default") == common.DEFAULT_WHISPER_MODEL:
                out.append((path.stem, schema, param))
    return out


WHISPER_PARAMS = _whisper_model_params()
ENUM_PARAMS = [(n, s, p) for n, s, p in WHISPER_PARAMS if p.get("type") == "enum"]


def test_the_whisper_steps_are_found():
    names = {n for n, _, _ in WHISPER_PARAMS}
    assert {"transcribe", "rm_fillers", "rm_nonspeech", "lyrics_sync", "generate_captions"} <= names


@pytest.mark.parametrize("name,schema,param", ENUM_PARAMS, ids=[n for n, _, _ in ENUM_PARAMS])
def test_every_whisper_step_offers_the_one_list(name, schema, param):
    assert param["options"] == list(common.WHISPER_MODEL_CHOICES)


def test_every_installable_model_is_selectable():
    # "large" is the one extra: older installs carry ggml-large.bin, which
    # `montaj models download` no longer offers.
    installable = set(models_cmd.AVAILABLE)
    assert installable <= set(common.WHISPER_MODEL_CHOICES)
    assert set(common.WHISPER_MODEL_CHOICES) - installable == {"large"}


@pytest.mark.parametrize("name,schema,param", ENUM_PARAMS, ids=[n for n, _, _ in ENUM_PARAMS])
def test_serve_accepts_small_en(name, schema, param):
    # The surface that refused it: serve's enum check (a 422 before the fix).
    only_model = {"params": [param]}
    validate_params(only_model, {"model": "small.en"})
    with pytest.raises(HTTPException) as exc:
        validate_params(only_model, {"model": "not-a-model"})
    assert exc.value.status_code == 422


@pytest.mark.parametrize("name,schema,param", ENUM_PARAMS, ids=[n for n, _, _ in ENUM_PARAMS])
def test_the_cli_accepts_small_en(name, schema, param):
    parser = argparse.ArgumentParser()
    sc._add_param(parser, param)
    assert parser.parse_args(["--model", "small.en"]).model == "small.en"


def test_base_and_base_en_downloads_are_checksummed():
    # HuggingFace's LFS oids (= SHA-256), re-hashed from real downloads.
    assert models_cmd.CHECKSUMS["base"] == "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
    assert models_cmd.CHECKSUMS["base.en"] == "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
    for name in ("base", "base.en", "large-v3-turbo-q5_0"):
        digest = models_cmd.CHECKSUMS[name]
        assert len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)
