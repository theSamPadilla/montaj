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

    def test_unknown_field_message_has_no_em_dash(self):
        # POSTLAUNCH 20.2: this text reaches agents through the app's run_step.
        with pytest.raises(HTTPException) as exc:
            validate_params(self.SCHEMA, {"input": "/a.mp4", "keeps": "[[1, 2]]"})
        message = exc.value.detail["message"]
        assert "\u2014" not in message
        assert message.startswith("unknown field(s): keeps. This step accepts ")

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


# ── build_cli_args: boolean and array shapes ─────────────────────────────────

class TestBuildCliArgsBooleans:
    """Both `bool` and `boolean` are bare flags; false is omitted."""

    @pytest.mark.parametrize("type_name", ["bool", "boolean"])
    def test_true_is_bare_flag(self, type_name):
        schema = _schema([{"name": "cpu", "type": type_name}])
        assert build_cli_args(schema, {"cpu": True}) == ["--cpu"]

    @pytest.mark.parametrize("type_name", ["bool", "boolean"])
    def test_false_is_omitted(self, type_name):
        schema = _schema([{"name": "cpu", "type": type_name}])
        assert build_cli_args(schema, {"cpu": False}) == []


class TestBuildCliArgsLists:
    def test_array_type_is_one_flag_then_all_values(self):
        # `array` params are argparse nargs="+": a repeated flag would overwrite.
        schema = _schema([{"name": "inputs", "type": "array"}])
        assert build_cli_args(schema, {"inputs": ["a.mp4", "b.mp4"]}) == [
            "--inputs", "a.mp4", "b.mp4"]

    def test_non_array_list_value_stays_repeated(self):
        # Scalar-typed params given a list are action="append" (e.g. --at, --ref-image).
        schema = _schema([{"name": "at", "type": "float"}])
        assert build_cli_args(schema, {"at": [1, 2]}) == ["--at", "1", "--at", "2"]


class TestValidateParamsRepeatable:
    """A repeatable numeric param takes a list (contact_sheet's `at` over run_step, §373)."""

    SCHEMA = _schema([{"name": "at", "type": "float", "repeatable": True, "min": 0}])

    def test_list_passes_and_each_item_becomes_a_flag(self):
        validate_params(self.SCHEMA, {"at": [0.5, "1.25", 3]})
        assert build_cli_args(self.SCHEMA, {"at": [0.5, "1.25", 3]}) == [
            "--at", "0.5", "--at", "1.25", "--at", "3"]

    def test_single_value_still_passes(self):
        validate_params(self.SCHEMA, {"at": 2.0})

    def test_each_item_is_checked(self):
        with pytest.raises(HTTPException) as e:
            validate_params(self.SCHEMA, {"at": [1, "x", -2]})
        msg = e.value.detail["message"]
        assert "'at' must be a float, got 'x'" in msg and "'at' must be >= 0, got -2.0" in msg

    def test_a_list_on_a_param_that_is_not_repeatable_is_refused(self):
        with pytest.raises(HTTPException):
            validate_params(_schema([{"name": "fps", "type": "float"}]), {"fps": [24, 30]})

    def test_repeatable_enum_checks_each_item(self):
        schema = _schema([{"name": "mode", "type": "enum", "options": ["a", "b"], "repeatable": True}])
        validate_params(schema, {"mode": ["a", "b"]})
        with pytest.raises(HTTPException):
            validate_params(schema, {"mode": ["a", "c"]})


def test_contact_sheet_real_schema_takes_a_list_of_times():
    import json
    from pathlib import Path
    path = Path(__file__).resolve().parent.parent / "steps" / "render" / "contact_sheet.json"
    schema = json.loads(path.read_text())
    body = {"project": "/p/project.json", "at": [0.5, 1.0, 2.5], "out": "/p/sheet.png"}
    validate_params(schema, body)
    args = build_cli_args(schema, body)
    assert args.count("--at") == 3 and args[args.index("--at") + 1] == "0.5"


def test_remove_bg_real_schema_batch_and_flags():
    import json
    from pathlib import Path
    path = Path(__file__).resolve().parent.parent / "steps" / "transform" / "remove_bg.json"
    schema = json.loads(path.read_text())
    args = build_cli_args(schema, {"inputs": ["a.mp4", "b.mp4"], "max_height": 1920, "progress": True})
    assert args[:1] == ["--inputs"] and args[1:3] == ["a.mp4", "b.mp4"]
    i = args.index("--max-height")
    assert args[i + 1] == "1920"
    assert "--progress" in args
    assert "True" not in args
    assert args.count("--inputs") == 1


# ── flag smuggling (H2) ───────────────────────────────────────────────────────

class TestRejectFlagValues:
    """A string value (or list item) that begins with '-' would be read as a CLI flag, so a '--out=/x'
    smuggled through `inputs` or any array/string param becomes a real --out the out-guard never saw.
    Refused with 422 invalid_param, except a plain negative number on an int/float param."""

    def _refused(self, schema, body):
        with pytest.raises(HTTPException) as e:
            validate_params(schema, body)
        assert e.value.status_code == 422 and e.value.detail["error"] == "invalid_param"

    def test_a_flag_smuggled_in_inputs_is_refused(self):
        self._refused(_schema([]), {"inputs": ["--out=/tmp/x"]})

    def test_a_flag_as_input_is_refused(self):
        self._refused(_schema([]), {"input": "-rf"})

    def test_a_flag_in_an_array_param_is_refused(self):
        schema = _schema([{"name": "refs", "type": "array"}])
        self._refused(schema, {"refs": ["ok.png", "--output-dir=/x"]})

    def test_a_flag_in_a_string_param_is_refused(self):
        self._refused(_schema([{"name": "label", "type": "string"}]), {"label": "--out=/x"})

    def test_a_plain_negative_number_on_a_number_param_is_allowed(self):
        validate_params(_schema([{"name": "offset", "type": "float"}]), {"offset": "-1.5"})
        validate_params(_schema([{"name": "n", "type": "int"}]), {"n": "-3"})

    def test_a_flag_on_a_number_param_is_still_refused(self):
        self._refused(_schema([{"name": "n", "type": "int"}]), {"n": "--n=/x"})

    def test_a_dash_elsewhere_in_a_path_is_allowed(self):
        validate_params(_schema([{"name": "p", "type": "path"}]), {"p": "/a/-b/c"})
        validate_params(_schema([]), {"input": "/a/-b/c.mp4"})


# ── a negative number is one argv token (§563) ───────────────────────────────

class TestBuildCliArgsNegativeNumbers:
    """argparse reads `-3e1` or `-inf` after a flag as a flag of its own, so a negative number on an
    int/float param goes in as `--flag=value`, which argparse always reads as the value."""

    def test_a_negative_number_is_joined_to_its_flag(self):
        schema = _schema([{"name": "offset", "type": "float"}])
        assert build_cli_args(schema, {"offset": -1.5}) == ["--offset=-1.5"]
        assert build_cli_args(schema, {"offset": "-3e1"}) == ["--offset=-3e1"]

    def test_a_positive_number_keeps_its_own_token(self):
        schema = _schema([{"name": "offset", "type": "float"}])
        assert build_cli_args(schema, {"offset": 1.5}) == ["--offset", "1.5"]

    def test_each_negative_item_of_a_repeated_param_is_joined(self):
        schema = _schema([{"name": "at", "type": "float"}])
        assert build_cli_args(schema, {"at": [-1, 2]}) == ["--at=-1", "--at", "2"]


# ── waveform_trim's threshold is a number (§563) ─────────────────────────────

def _real_schema(rel: str) -> dict:
    import json
    from pathlib import Path
    return json.loads((Path(__file__).resolve().parent.parent / "steps" / rel).read_text())


class TestWaveformTrimThreshold:
    """`threshold` went into ffmpeg's `-af silencedetect=noise={threshold}dB` as free text, so a value
    like `1,ametadata=mode=print:file=/x,silencedetect=noise=1` added a filter that created or truncated
    any file ffmpeg could reach, past the out-guard. It is a float now."""

    SCHEMA = _real_schema("audio/waveform_trim.json")
    INJECTION = "1,ametadata=mode=print:file=/tmp/s563-x,silencedetect=noise=1"

    def test_threshold_is_declared_a_float(self):
        param = next(p for p in self.SCHEMA["params"] if p["name"] == "threshold")
        assert param["type"] == "float" and param["default"] == -30

    def test_a_filter_graph_injection_is_refused(self):
        with pytest.raises(HTTPException) as e:
            validate_params(self.SCHEMA, {"input": "/a.mp4", "threshold": self.INJECTION})
        assert e.value.status_code == 422
        assert "'threshold' must be a float" in e.value.detail["message"]

    @pytest.mark.parametrize("value", [-30, -30.5, "-30", "-3e1"])
    def test_a_negative_threshold_validates_and_reaches_argv_whole(self, value):
        body = {"input": "/a.mp4", "threshold": value}
        validate_params(self.SCHEMA, body)
        args = build_cli_args(self.SCHEMA, body)
        assert args == ["--input", "/a.mp4", f"--threshold={value}"]

    @pytest.mark.parametrize("value", [-500, 6])
    def test_a_threshold_out_of_range_is_refused(self, value):
        with pytest.raises(HTTPException):
            validate_params(self.SCHEMA, {"input": "/a.mp4", "threshold": value})


# ── number params are typed so serve checks them (§563) ──────────────────────

@pytest.mark.parametrize("rel, name, good, bad", [
    ("transform/materialize_cut.json", "workers", 3, "3:x"),
])
def test_a_number_param_is_validated_as_one(rel, name, good, bad):
    schema = _real_schema(rel)
    param = next(p for p in schema["params"] if p["name"] == name)
    assert param["type"] in ("float", "int")
    required = {p["name"]: "x" for p in schema["params"] if p.get("required")}
    validate_params(schema, {**required, name: good})
    with pytest.raises(HTTPException) as e:
        validate_params(schema, {**required, name: bad})
    assert e.value.status_code == 422


# ── §558: non-finite numbers ──────────────────────────────────────────────────────────────────────────────────────
# NaN and infinity pass every min and max check (nan < 0.1 is False) and float() takes "nan" and "inf", so a step
# got them and wrote them into project.json, which then would not open (found in place's review). Refused for every
# float and int param, as numbers and as strings, alone and in a repeatable list.

@pytest.mark.parametrize("ptype", ["float", "int"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf"), "nan", "NaN", "inf", "-Infinity", "+inf"])
def test_a_non_finite_number_is_refused(ptype, value):
    schema = _schema([{"name": "for", "type": ptype, "min": 0.1}])
    with pytest.raises(HTTPException) as exc_info:
        validate_params(schema, {"for": value})
    assert exc_info.value.status_code == 422
    assert "'for' must be" in exc_info.value.detail["message"]


def test_a_non_finite_number_in_a_repeatable_list_is_refused():
    schema = _schema([{"name": "at", "type": "float", "repeatable": True}])
    with pytest.raises(HTTPException):
        validate_params(schema, {"at": [1.0, "nan", 2.0]})
    validate_params(schema, {"at": [1.0, "2.5", 3]})   # finite values still pass


@pytest.mark.parametrize("value", [0, -2.5, "3", "1e3", 1e300])
def test_finite_numbers_still_pass(value):
    validate_params(_schema([{"name": "x", "type": "float"}]), {"x": value})
