"""Generator unit tests + step-argv parity harness for cli/step_command.py.

The parity harness is the load-bearing test: for each of the 16 migrated
commands it parses a representative argv with the GENERATED parser and asserts
(a) the exact step-subprocess argv the handler would spawn and (b) the emit()
invocation shape (as_json + whether --json is forwarded to the child). Each
expected argv is hand-derived from the (still-present) hand wrapper + the
reconciled schema.

The ``QUIRKS`` table below is the canonical per-command quirks map; Task 3 will
lift it into cli/main.py's registration. It intentionally stays small and
declarative.
"""
import argparse
import sys
import types

import pytest

import cli.step_command as sc
from cli.main import find_step

# ── canonical per-command quirks (declarative) ────────────────────────────────
QUIRKS = {
    "probe":              {},
    "transcribe":         {"emit_json": False},
    "caption":            {},
    "extract-audio":      {},
    "resize":             {},
    "rm-nonspeech":       {},
    "stem-separation":    {"emit_json": False},
    "lyrics-sync":        {"emit_json": False, "file_prechecks": ["lyrics"]},
    "lyrics-render":      {"emit_json": False, "file_prechecks": ["captions", "audio"]},
    "generate-image":     {"required_out": True},
    "generate-music":     {"required_out": True, "forward_json": True},
    "generate-voiceover": {"required_out": True, "forward_json": True, "xor": ("text", "text_file")},
    "kling-generate":     {"required_out": True},
    "analyze-media":      {},
    "snapshot":           {},
    "filler":             {"step_name": "rm_fillers"},
}


def _step_of(cli):
    return QUIRKS[cli].get("step_name") or cli.replace("-", "_")


# ── parity table ──────────────────────────────────────────────────────────────
# row = (id, cli, argv-after-command, expected child flags, as_json, quiet)
PARITY = [
    # ── base rows (one per command) ──────────────────────────────────────────
    ("probe", "probe",
     ["/in.mp4"],
     ["--input", "/in.mp4"], False, False),
    ("transcribe", "transcribe",
     ["/in.mp4", "--model", "medium", "--language", "es", "--max-context", "0"],
     ["--input", "/in.mp4", "--model", "medium", "--language", "es", "--max-context", "0"], False, False),
    ("caption", "caption",
     ["/w.json", "--style", "karaoke"],
     ["--input", "/w.json", "--style", "karaoke"], False, False),
    ("extract-audio", "extract-audio",
     ["/in.mp4", "--format", "mp3"],
     ["--input", "/in.mp4", "--format", "mp3"], False, False),
    ("resize", "resize",  # also exercises --quiet pass-through (NOT forwarded to the child)
     ["/in.mp4", "--ratio", "9:16", "--quiet"],
     ["--input", "/in.mp4", "--ratio", "9:16"], False, True),
    ("rm-nonspeech", "rm-nonspeech",
     ["/in.mp4", "--model", "medium", "--max-word-gap", "0.2", "--sentence-edge", "0.05", "--language", "es"],
     ["--input", "/in.mp4", "--model", "medium", "--max-word-gap", "0.2", "--sentence-edge", "0.05", "--language", "es"], False, False),
    ("stem-separation", "stem-separation",
     ["/in.wav", "--stems", "vocals", "--model", "htdemucs_ft", "--out-dir", "/stems"],
     ["--input", "/in.wav", "--stems", "vocals", "--model", "htdemucs_ft", "--out-dir", "/stems"], False, False),
    ("lyrics-sync", "lyrics-sync",
     ["/voc.wav", "--lyrics", "/lyr.txt", "--model", "medium.en", "--language", "es", "--start", "1.5", "--end", "30.5"],
     ["--input", "/voc.wav", "--lyrics", "/lyr.txt", "--model", "medium.en", "--language", "es", "--start", "1.5", "--end", "30.5"], False, False),
    ("lyrics-render", "lyrics-render",
     ["--captions", "/c.json", "--audio", "/a.mp3", "--input", "/bg.mp4", "--bg-color", "blue",
      "--width", "1080", "--height", "1920", "--fps", "24", "--fontsize", "96", "--color", "yellow",
      "--position", "top-left", "--duration", "10", "--preview-duration", "5", "--box", "--accumulate",
      "--window-size", "2", "--words-per-line", "4", "--audio-inpoint", "2.5"],
     ["--input", "/bg.mp4", "--captions", "/c.json", "--audio", "/a.mp3", "--bg-color", "blue",
      "--width", "1080", "--height", "1920", "--fps", "24", "--fontsize", "96", "--color", "yellow",
      "--position", "top-left", "--duration", "10.0", "--preview-duration", "5.0", "--box", "--accumulate",
      "--window-size", "2", "--words-per-line", "4", "--audio-inpoint", "2.5"], False, False),
    ("generate-image", "generate-image",
     ["--prompt", "a cat", "--out", "/o.png", "--provider", "openai",
      "--ref-image", "/r1.png", "--ref-image", "/r2.png", "--size", "512x512",
      "--aspect-ratio", "1:1", "--model", "gpt-image-1"],
     ["--prompt", "a cat", "--provider", "openai", "--ref-image", "/r1.png", "--ref-image", "/r2.png",
      "--size", "512x512", "--aspect-ratio", "1:1", "--model", "gpt-image-1", "--out", "/o.png"], False, False),
    ("generate-music", "generate-music",
     ["--prompt", "lofi", "--out", "/m.wav", "--model", "lyria-x", "--seed", "42", "--with-vocals"],
     ["--prompt", "lofi", "--model", "lyria-x", "--seed", "42", "--with-vocals", "--out", "/m.wav"], False, False),
    ("generate-voiceover", "generate-voiceover",
     ["--text", "hello", "--voice", "Kore", "--out", "/v.mp3", "--vendor", "gemini",
      "--model", "tts-1", "--speed", "1.2", "--language", "en"],
     ["--text", "hello", "--voice", "Kore", "--vendor", "gemini", "--model", "tts-1",
      "--speed", "1.2", "--language", "en", "--out", "/v.mp3"], False, False),
    ("kling-generate", "kling-generate",
     ["--prompt", "a dog", "--out", "/k.mp4", "--first-frame", "/f.png", "--last-frame", "/l.png",
      "--ref-image", "/r.png", "--duration", "10", "--negative-prompt", "blurry", "--sound", "off",
      "--aspect-ratio", "9:16", "--mode", "pro", "--model", "kling-video-o1"],
     ["--prompt", "a dog", "--first-frame", "/f.png", "--last-frame", "/l.png", "--ref-image", "/r.png",
      "--duration", "10", "--negative-prompt", "blurry", "--sound", "off", "--aspect-ratio", "9:16",
      "--mode", "pro", "--model", "kling-video-o1", "--out", "/k.mp4"], False, False),
    ("analyze-media", "analyze-media",
     ["/media.mp4", "--prompt", "describe", "--model", "gemini-2.5-pro", "--json-output"],
     ["--input", "/media.mp4", "--prompt", "describe", "--model", "gemini-2.5-pro", "--json-output"], False, False),
    ("snapshot", "snapshot",
     ["/in.mp4", "--cols", "4", "--rows", "2", "--start", "1", "--end", "5", "--frames", "all", "--at", "3"],
     ["--input", "/in.mp4", "--cols", "4", "--rows", "2", "--start", "1.0", "--end", "5.0", "--frames", "all", "--at", "3.0"], False, False),
    ("filler", "filler",  # step_name quirk → rm_fillers
     ["/in.mp4", "--model", "medium", "--language", "es"],
     ["--input", "/in.mp4", "--model", "medium", "--language", "es"], False, False),

    # ── --json variant rows: the six emit-quirk commands ─────────────────────
    # These invoke minimally, so they ALSO lock the default-forwarding behavior:
    # a defaulted optional flag the user omits is forwarded to the child at its
    # schema default (== the step's own default, conformance-guaranteed).
    # IGNORE (accept --json, emit as_json=False, do NOT forward it to the child):
    ("transcribe+json", "transcribe",
     ["/in.mp4", "--json"],
     ["--input", "/in.mp4", "--model", "base.en", "--language", "en"], False, False),
    ("stem-separation+json", "stem-separation",
     ["/in.wav", "--json"],
     ["--input", "/in.wav", "--stems", "all", "--model", "htdemucs"], False, False),
    ("lyrics-sync+json", "lyrics-sync",
     ["/voc.wav", "--lyrics", "/lyr.txt", "--json"],
     ["--input", "/voc.wav", "--lyrics", "/lyr.txt", "--model", "base.en", "--language", "en"], False, False),
    ("lyrics-render+json", "lyrics-render",
     ["--captions", "/c.json", "--audio", "/a.mp3", "--json"],
     ["--captions", "/c.json", "--audio", "/a.mp3", "--bg-color", "black", "--width", "720",
      "--height", "1280", "--fps", "30", "--fontsize", "72", "--color", "auto", "--position", "center",
      "--window-size", "1", "--words-per-line", "3"], False, False),
    # FORWARD (pass-through emit as_json=True AND forward --json to child, before --out):
    ("generate-music+json", "generate-music",  # no defaulted scalar params
     ["--prompt", "lofi", "--out", "/m.wav", "--json"],
     ["--prompt", "lofi", "--json", "--out", "/m.wav"], True, False),
    ("generate-voiceover+json", "generate-voiceover",
     ["--text", "hi", "--voice", "Kore", "--out", "/v.mp3", "--json"],
     ["--text", "hi", "--voice", "Kore", "--vendor", "kling", "--speed", "1.0", "--json", "--out", "/v.mp3"], True, False),

    # ── --json pass-through proofs (as_json=True, child NOT forwarded) ────────
    ("probe+json", "probe",  # no params
     ["/in.mp4", "--json"],
     ["--input", "/in.mp4"], True, False),
    ("generate-image+json", "generate-image",
     ["--prompt", "x", "--out", "/o.png", "--json"],
     ["--prompt", "x", "--provider", "gemini", "--size", "1024x1024", "--out", "/o.png"], True, False),

    # ── default-forwarding regression: omit ALL optional flags → each is
    #    forwarded to the child at its schema default (locks the Task-3 fix). ──
    ("rm-nonspeech-defaults", "rm-nonspeech",
     ["/in.mp4"],
     ["--input", "/in.mp4", "--model", "base", "--max-word-gap", "0.18",
      "--sentence-edge", "0.1", "--language", "en"], False, False),
]


def _run_handler(monkeypatch, cli, argv):
    """Register the generated command, parse argv, run the handler; capture the
    spawned subprocess argv + the emit() kwargs (subprocess/file-checks stubbed)."""
    cap = {}

    def fake_run(cmd, **kw):
        cap["cmd"] = cmd
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    def fake_emit(result, as_json=False, quiet=False):
        cap["emit"] = {"as_json": as_json, "quiet": quiet}

    monkeypatch.setattr(sc.subprocess, "run", fake_run)
    monkeypatch.setattr(sc, "emit", fake_emit)
    monkeypatch.setattr(sc, "_require_file", lambda *a, **k: None)

    parser = argparse.ArgumentParser(prog="montaj")
    subs = parser.add_subparsers(dest="command")
    sc.register_step_command(subs, cli, quirks=QUIRKS[cli])
    args = parser.parse_args([cli, *argv])
    args.func(args)
    return cap


@pytest.mark.parametrize(
    "cli,argv,flags,as_json,quiet",
    [(r[1], r[2], r[3], r[4], r[5]) for r in PARITY],
    ids=[r[0] for r in PARITY],
)
def test_parity(monkeypatch, cli, argv, flags, as_json, quiet):
    cap = _run_handler(monkeypatch, cli, argv)
    expected_cmd = [sys.executable, find_step(_step_of(cli)), *flags]
    assert cap["cmd"] == expected_cmd
    assert cap["emit"] == {"as_json": as_json, "quiet": quiet}


def test_parity_covers_all_16_commands():
    assert {r[1] for r in PARITY} == set(QUIRKS)


def test_json_variant_rows_present_for_the_six_emit_quirk_commands():
    json_rows = {r[1] for r in PARITY if r[0].endswith("+json")}
    six = {"transcribe", "stem-separation", "lyrics-sync", "lyrics-render",
           "generate-music", "generate-voiceover"}
    assert six <= json_rows


# ── flag-builder unit tests (build_cli_args semantics) ────────────────────────

def _flags(schema, quirks=None, **argvals):
    return sc._build_step_flags(argparse.Namespace(**argvals), schema, quirks or {})


def test_build_flags_skips_none_and_orders_input_first_out_last():
    schema = {"params": [{"name": "model", "type": "string"},
                         {"name": "language", "type": "string"}]}
    flags = _flags(schema, input="/in", model="base.en", language=None, out="/o", json=False)
    assert flags == ["--input", "/in", "--model", "base.en", "--out", "/o"]


def test_build_flags_bool_is_bare_and_only_when_true():
    schema = {"params": [{"name": "with-vocals", "type": "bool"},
                         {"name": "box", "type": "boolean"}]}
    assert _flags(schema, with_vocals=True, box=False) == ["--with-vocals"]
    assert _flags(schema, with_vocals=False, box=True) == ["--box"]


def test_build_flags_repeatable_repeats_the_flag():
    schema = {"params": [{"name": "ref-image", "type": "path", "repeatable": True}]}
    assert _flags(schema, ref_image=["/a.png", "/b.png"]) == \
        ["--ref-image", "/a.png", "--ref-image", "/b.png"]
    assert _flags(schema, ref_image=[]) == []


def test_build_flags_dict_value_is_json_encoded_but_cli_string_passes_through():
    schema = {"params": [{"name": "blob", "type": "dict"}]}
    # An actual dict (build_cli_args parity) → json.dumps.
    assert _flags(schema, blob={"k": 1}) == ["--blob", '{"k": 1}']
    # A JSON string (what argparse actually yields on the CLI) → passthrough.
    assert _flags(schema, blob='{"k": 1}') == ["--blob", '{"k": 1}']


def test_build_flags_forward_json_sits_before_out():
    schema = {"params": [{"name": "prompt", "type": "string"}]}
    flags = _flags(schema, {"forward_json": True}, prompt="hi", out="/o", json=True)
    assert flags == ["--prompt", "hi", "--json", "--out", "/o"]
    # not forwarded when --json absent
    assert _flags(schema, {"forward_json": True}, prompt="hi", out="/o", json=False) == \
        ["--prompt", "hi", "--out", "/o"]


def test_build_flags_multiple_inputs_use_inputs_flag():
    schema = {"params": []}
    assert _flags(schema, input=["/a"]) == ["--input", "/a"]
    assert _flags(schema, input=["/a", "/b"]) == ["--inputs", "/a", "/b"]


# ── parser-construction / type-mapping unit tests ─────────────────────────────

def _build_parser(monkeypatch, schema, cli="x", quirks=None):
    monkeypatch.setattr(sc, "load_step_schema", lambda name: dict(schema))
    parser = argparse.ArgumentParser(prog="montaj")
    subs = parser.add_subparsers(dest="command")
    return sc.register_step_command(subs, cli, quirks=quirks or {})


def _by_dest(parser):
    return {a.dest: a for a in parser._actions}


def test_type_mapping(monkeypatch):
    schema = {"name": "x", "input": {"type": "video", "description": "in"}, "params": [
        {"name": "flag", "type": "bool"},
        {"name": "flag2", "type": "boolean"},
        {"name": "count", "type": "int"},
        {"name": "amount", "type": "float"},
        {"name": "mode", "type": "enum", "options": ["a", "b"]},
        {"name": "label", "type": "string"},
        {"name": "path-arg", "type": "path"},
        {"name": "refs", "type": "path", "repeatable": True},
        {"name": "blob", "type": "dict"},
    ]}
    a = _by_dest(_build_parser(monkeypatch, schema))
    assert isinstance(a["flag"], argparse._StoreTrueAction)
    assert isinstance(a["flag2"], argparse._StoreTrueAction)
    assert a["count"].type is int
    assert a["amount"].type is float
    assert a["mode"].choices == ["a", "b"]
    assert a["label"].type is None and a["label"].choices is None
    assert a["path_arg"].type is None and a["path_arg"].choices is None
    assert isinstance(a["refs"], argparse._AppendAction) and a["refs"].default == []
    assert a["blob"].type is None and a["blob"].choices is None
    # globals always present
    assert {"json", "out", "quiet"} <= set(a)


def test_required_and_enum_together(monkeypatch):
    schema = {"name": "r", "input": {"type": "video"}, "params": [
        {"name": "ratio", "type": "enum", "required": True, "options": ["9:16", "1:1", "16:9"]},
    ]}
    a = _by_dest(_build_parser(monkeypatch, schema))
    assert a["ratio"].required is True
    assert a["ratio"].choices == ["9:16", "1:1", "16:9"]


def test_out_param_is_skipped_no_double_registration(monkeypatch):
    # 'out' in params must NOT be registered (add_global_flags owns --out);
    # a second registration would raise argparse.ArgumentError at build time.
    schema = {"name": "g", "params": [
        {"name": "out", "type": "path", "required": True},
        {"name": "foo", "type": "string"},
    ]}
    p = _build_parser(monkeypatch, schema)          # must not raise
    outs = [x for x in p._actions if x.dest == "out"]
    assert len(outs) == 1                            # only the global --out
    assert "--out" in outs[0].option_strings


def test_duplicate_input_param_is_skipped(monkeypatch):
    schema = {"name": "z", "input": {"type": "media", "description": "m"}, "params": [
        {"name": "input", "type": "path", "required": True},
        {"name": "bar", "type": "string"},
    ]}
    p = _build_parser(monkeypatch, schema)          # must not raise
    inputs = [x for x in p._actions if x.dest == "input"]
    assert len(inputs) == 1
    assert inputs[0].option_strings == []           # the positional, not a --flag
    assert "bar" in _by_dest(p)


# ── input-rule unit tests ─────────────────────────────────────────────────────

def test_input_rule_no_block_means_no_input_arg(monkeypatch):
    a = _by_dest(_build_parser(monkeypatch, {"name": "a", "params": []}))
    assert "input" not in a


def test_input_rule_type_any_means_no_input_arg(monkeypatch):
    a = _by_dest(_build_parser(monkeypatch, {"name": "b", "input": {"type": "any"}, "params": []}))
    assert "input" not in a


def test_input_rule_required_false_is_optional_flag(monkeypatch):
    a = _by_dest(_build_parser(
        monkeypatch,
        {"name": "c", "input": {"type": "video", "required": False, "description": "bg"}, "params": []},
    ))
    assert a["input"].option_strings == ["--input"]   # optional flag, not positional
    assert a["input"].required is False


def test_input_rule_required_default_is_positional(monkeypatch):
    a = _by_dest(_build_parser(
        monkeypatch,
        {"name": "d", "input": {"type": "video", "description": "src"}, "params": []},
    ))
    assert a["input"].option_strings == []            # positional
    assert a["input"].nargs is None


def test_input_rule_multiple_is_positional_nargs_plus(monkeypatch):
    a = _by_dest(_build_parser(
        monkeypatch,
        {"name": "e", "input": {"type": "video", "multiple": True}, "params": []},
    ))
    assert a["input"].option_strings == []
    assert a["input"].nargs == "+"


# ── handler quirk prechecks ───────────────────────────────────────────────────

def test_required_out_precheck_fails_without_out(monkeypatch):
    schema = {"name": "generate_image", "params": [{"name": "prompt", "type": "string", "required": True}]}
    monkeypatch.setattr(sc, "load_step_schema", lambda name: dict(schema))
    parser = argparse.ArgumentParser(prog="montaj")
    subs = parser.add_subparsers(dest="command")
    sc.register_step_command(subs, "generate-image", quirks={"required_out": True})
    args = parser.parse_args(["generate-image", "--prompt", "x"])  # no --out
    with pytest.raises(SystemExit):
        args.func(args)


def test_xor_precheck_rejects_both_and_neither(monkeypatch):
    schema = {"name": "generate_voiceover", "params": [
        {"name": "text", "type": "string"},
        {"name": "text-file", "type": "string"},
        {"name": "voice", "type": "string", "required": True},
    ]}
    monkeypatch.setattr(sc, "load_step_schema", lambda name: dict(schema))
    monkeypatch.setattr(sc, "_require_file", lambda *a, **k: None)
    parser = argparse.ArgumentParser(prog="montaj")
    subs = parser.add_subparsers(dest="command")
    sc.register_step_command(subs, "generate-voiceover",
                             quirks={"required_out": True, "xor": ("text", "text_file")})
    both = parser.parse_args(["generate-voiceover", "--voice", "V", "--out", "/o",
                              "--text", "a", "--text-file", "/f"])
    with pytest.raises(SystemExit):
        both.func(both)
    neither = parser.parse_args(["generate-voiceover", "--voice", "V", "--out", "/o"])
    with pytest.raises(SystemExit):
        neither.func(neither)
