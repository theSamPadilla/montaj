"""Unit tests for validate_params and build_cli_args param handling.

Covers the underscore-alias fallback: a schema param named ``foo-bar``
(hyphenated, canonical) must be accepted when the request body supplies
``foo_bar`` (underscored, JSON-friendly).
"""
import pytest
from fastapi import HTTPException

from serve.routes.steps import validate_params, build_cli_args


# ── helpers ──────────────────────────────────────────────────────────────────

def _schema(params):
    """Minimal step schema with the given params list."""
    return {"name": "test-step", "params": params}


# ── validate_params ───────────────────────────────────────────────────────────

class TestValidateParamsUnderscoreAlias:
    """Required hyphenated param accepted via underscore alias."""

    SCHEMA = _schema([{"name": "foo-bar", "required": True, "type": "string"}])

    def test_hyphen_key_passes(self):
        """Canonical hyphenated key must still work."""
        validate_params(self.SCHEMA, {"foo-bar": "x"})  # no exception

    def test_underscore_alias_passes(self):
        """Underscore alias must be accepted (was previously rejected)."""
        validate_params(self.SCHEMA, {"foo_bar": "x"})  # must NOT raise

    def test_missing_both_raises(self):
        """Neither key present → still raises 422."""
        with pytest.raises(HTTPException) as exc_info:
            validate_params(self.SCHEMA, {})
        assert exc_info.value.status_code == 422
        assert "foo-bar" in exc_info.value.detail["message"]

    def test_unrelated_key_raises(self):
        """A key that is not an alias must not satisfy the requirement."""
        with pytest.raises(HTTPException):
            validate_params(self.SCHEMA, {"baz": "x"})


class TestValidateParamsNonRequired:
    """Non-required hyphenated param: alias lookup must not cause errors."""

    SCHEMA = _schema([{"name": "foo-bar", "type": "string"}])

    def test_missing_optional_no_raise(self):
        validate_params(self.SCHEMA, {})

    def test_underscore_alias_not_validated_as_error(self):
        validate_params(self.SCHEMA, {"foo_bar": "hello"})


class TestValidateParamsNumericConstraints:
    """Numeric constraints still apply when value arrives via alias."""

    SCHEMA = _schema([{
        "name": "my-count",
        "type": "int",
        "required": True,
        "min": 1,
        "max": 10,
    }])

    def test_alias_in_range_passes(self):
        validate_params(self.SCHEMA, {"my_count": "5"})

    def test_alias_out_of_range_raises(self):
        with pytest.raises(HTTPException) as exc_info:
            validate_params(self.SCHEMA, {"my_count": "99"})
        assert "my-count" in exc_info.value.detail["message"]


class TestValidateParamsUnknownFields:
    """Unknown body fields are rejected (fail-loud), not silently dropped.

    This is the rm_nonspeech footgun: a caller passed `keeps`/`language` to a
    step that didn't declare them; build_cli_args dropped them and the step ran
    full-file detection instead of refining the intended window.
    """

    SCHEMA = _schema([
        {"name": "model", "type": "string"},
        {"name": "max-word-gap", "type": "float"},
    ])

    def test_unknown_field_raises(self):
        with pytest.raises(HTTPException) as exc_info:
            validate_params(self.SCHEMA, {"model": "large", "keeps": [[0, 1]]})
        assert exc_info.value.status_code == 422
        assert "keeps" in exc_info.value.detail["message"]

    def test_multiple_unknown_fields_listed(self):
        with pytest.raises(HTTPException) as exc_info:
            validate_params(self.SCHEMA, {"keeps": [[0, 1]], "language": "es"})
        msg = exc_info.value.detail["message"]
        assert "keeps" in msg and "language" in msg

    def test_declared_param_and_alias_pass(self):
        validate_params(self.SCHEMA, {"model": "large", "max_word_gap": 0.1})  # no raise

    def test_reserved_keys_allowed(self):
        # input/inputs/out and underscore-prefixed control fields are recognized.
        validate_params(self.SCHEMA, {"input": "/a.mov", "out": "/b.json", "_async": True})


# ── build_cli_args ────────────────────────────────────────────────────────────

class TestBuildCliArgsUnderscoreAlias:
    """build_cli_args already supported the alias; ensure it still does."""

    SCHEMA = _schema([{"name": "foo-bar", "type": "string"}])

    def test_hyphen_key(self):
        flags = build_cli_args(self.SCHEMA, {"foo-bar": "x"})
        assert flags == ["--foo-bar", "x"]

    def test_underscore_alias(self):
        flags = build_cli_args(self.SCHEMA, {"foo_bar": "x"})
        assert flags == ["--foo-bar", "x"]

    def test_missing_key_omitted(self):
        flags = build_cli_args(self.SCHEMA, {})
        assert flags == []
