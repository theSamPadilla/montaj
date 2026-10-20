"""Tests for lib/project_revisions.py, the Python twin of the app's revision hasher.

The load-bearing property: for any JSON-parsed value, ``canonical`` produces the exact string the JS
hasher hashes (RFC 8785, JCS), so a revision serve answers equals the one the app computes. Every
expected string and hash here comes from the RFC or from the JS reference, never from this module.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

import lib.project_revisions as pr
from lib.project_revisions import (
    CANARY, canary_ok, canonical, clear_cache, revision_of, revisions_for_text, revisions_of, stale_fields,
)


# ── numbers (RFC 8785 section 3.2.2.3 and appendix B) ─────────────────────────

@pytest.mark.parametrize("value, expected", [
    (0, "0"),
    (0.0, "0"),
    (-0.0, "0"),
    (1, "1"),
    (1.0, "1"),
    (-1.0, "-1"),
    (4.5, "4.5"),
    (100, "100"),
    (1e21, "1e+21"),
    (1e20, "100000000000000000000"),
    (1e-7, "1e-7"),
    (0.000001, "0.000001"),
    (0.0001, "0.0001"),
    (123456789012345680000.0, "123456789012345680000"),
    (333333333.3333333, "333333333.3333333"),
    (1e23, "1e+23"),
    (9007199254740992, "9007199254740992"),
    (1.7976931348623157e308, "1.7976931348623157e+308"),
    (5e-324, "5e-324"),
    (-1.5e-9, "-1.5e-9"),
    (1.5e300, "1.5e+300"),
    (295147905179352830000.0, "295147905179352830000"),
    (0.1, "0.1"),
    (123.456, "123.456"),
])
def test_number_serialization_is_ecmascript(value, expected):
    assert canonical(value) == expected


def test_non_finite_numbers_hash_as_null():
    # Python's json.loads accepts NaN and Infinity; JS JSON.stringify writes them as null.
    assert canonical([float("nan"), float("inf"), float("-inf")]) == "[null,null,null]"
    assert canonical(json.loads("[NaN, Infinity, -Infinity, 1e400]")) == "[null,null,null,null]"


def test_ints_past_2_53_round_like_a_js_parse():
    assert canonical(9007199254740993) == "9007199254740992"
    assert canonical(json.loads("123456789012345678901")) == "123456789012345680000"
    assert canonical(-(2 ** 63)) == "-9223372036854776000"
    # An integer too large for a double is Infinity in JS, so null.
    assert canonical(10 ** 400) == "null"


def test_bool_is_not_an_int():
    assert canonical([True, False, None]) == "[true,false,null]"
    assert canonical({"a": True}) == '{"a":true}'


# ── strings ───────────────────────────────────────────────────────────────────

def test_lone_surrogates_are_escaped_lowercase():
    assert canonical("\ud800") == '"\\ud800"'
    assert canonical("a\udc00b") == '"a\\udc00b"'
    assert canonical("\udbff\ud800") == '"\\udbff\\ud800"'
    # The revision must not throw on them either.
    assert len(revision_of("\ud800")) == 12


def test_a_surrogate_pair_held_as_two_code_points_is_one_character():
    # JS cannot tell the two apart, so neither may the hash.
    assert canonical("😀") == canonical("\U0001f600") == '"\U0001f600"'
    assert revision_of("😀") == revision_of("\U0001f600")


def test_line_separators_and_del_stay_raw_control_chars_escape():
    assert canonical("  ") == '"  "'
    assert canonical("\u007f") == '"\u007f"'
    assert canonical("\u0000\u0007\b\f\n\r\t\u001f") == '"\\u0000\\u0007\\b\\f\\n\\r\\t\\u001f"'
    assert canonical('"\\/') == '"\\"\\\\/"'
    assert canonical("é\U0001f600") == '"é\U0001f600"'


# ── objects and arrays ───────────────────────────────────────────────────────

def test_rfc_8785_sorting_example():
    value = json.loads(
        '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",'
        '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",'
        '"\\u00f6":"Latin Small Letter O With Diaeresis"}')
    out = canonical(value)
    keys = list(json.loads(out).keys())
    assert keys == ["\r", "1", "\u0080", "ö", "€", "\U0001f600", "דּ"]
    # Exactly as the JS reference prints it.
    assert out == ('{"\\r":"Carriage Return","1":"One","\u0080":"Control",'
                   '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",'
                   '"\U0001f600":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}')


def test_astral_keys_sort_by_utf16_units_not_code_points():
    # By code point U+E000 sorts after U+10000; by UTF-16 units (0xD800 0xDC00) it sorts before.
    out = canonical({"": 3, "\U00010000": 2, "퟿": 1, "b": 0, "a": 0})
    assert out == '{"a":0,"b":0,"퟿":1,"\U00010000":2,"":3}'


def test_empty_and_nested_containers():
    assert canonical([[], {}, ""]) == '[[],{},""]'
    assert canonical({"z": [1, {"y": [], "x": {}}], "a": {"c": [[]], "b": None}}) == (
        '{"a":{"b":null,"c":[[]]},"z":[1,{"x":{},"y":[]}]}')
    assert canonical([1, 2.5, "x"]) == '[1,2.5,"x"]'


def test_unsupported_types_raise():
    with pytest.raises(TypeError):
        canonical({"a": object()})


# ── revisions ────────────────────────────────────────────────────────────────

def test_revision_of_matches_the_js_reference():
    # From the JS reference: revisionOf(null), revisionOf(undefined) and an absent field.
    assert revision_of(None) == "74234e98afe7"


def test_revisions_of_reads_an_absent_field_as_null():
    project = {"id": "p", "name": "x"}
    assert revisions_of(project) == {"id": revision_of("p"), "name": revision_of("x")}
    assert revisions_of(project, ["name", "tracks"]) == {"name": revision_of("x"), "tracks": "74234e98afe7"}
    assert revisions_of(None, ["a"]) == {"a": "74234e98afe7"}
    assert revisions_of([1], ["a"]) == {"a": "74234e98afe7"}


def test_stale_fields_missing_stale_and_id_skipped():
    project = {"id": "p", "name": "x", "tracks": [1], "assets": []}
    read = {"name": revision_of("x"), "tracks": revision_of([2]), "assets": "", "id": "nope"}
    out = stale_fields(project, ["assets", "id", "tracks", "name", "captions"], read)
    assert out == {"missing": ["assets", "captions"], "stale": ["tracks"]}
    assert stale_fields(project, ["name"], None) == {"missing": ["name"], "stale": []}
    assert stale_fields(project, ["name"], {"name": 5}) == {"missing": ["name"], "stale": []}
    assert stale_fields(project, ["name"], read) == {"missing": [], "stale": []}


# ── cache ────────────────────────────────────────────────────────────────────

def test_revisions_for_text_hashes_each_field_of_a_file_version_once(monkeypatch):
    clear_cache()
    calls = []
    real = pr.revision_of
    monkeypatch.setattr(pr, "revision_of", lambda v: calls.append(v) or real(v))
    text = json.dumps({"id": "p", "tracks": [1, 2], "name": "x"})
    first = revisions_for_text(text, json.loads(text), ["tracks", "name"])
    assert first == {"tracks": real([1, 2]), "name": real("x")}
    assert len(calls) == 2
    again = revisions_for_text(text, json.loads(text), ["tracks", "name"])
    assert again == first and len(calls) == 2
    # A field not hashed yet is hashed once; the project is parsed from the text when not given.
    assert revisions_for_text(text, None, ["id", "tracks"]) == {"id": real("p"), "tracks": real([1, 2])}
    assert len(calls) == 3
    # All fields when none are named.
    assert revisions_for_text(text, None) == {"id": real("p"), "tracks": real([1, 2]), "name": real("x")}
    assert len(calls) == 3
    # Any change to the text is a new version, even one that parses the same.
    changed = text + " "
    assert revisions_for_text(changed, None, ["tracks"]) == {"tracks": real([1, 2])}
    assert len(calls) == 4
    assert revisions_for_text(text.encode("utf-8"), None, ["tracks"]) == {"tracks": real([1, 2])}
    assert len(calls) == 4  # bytes and str of the same text are one version


def test_revision_cache_is_bounded(monkeypatch):
    clear_cache()
    calls = []
    real = pr.revision_of
    monkeypatch.setattr(pr, "revision_of", lambda v: calls.append(v) or real(v))
    texts = [json.dumps({"n": i}) for i in range(pr.CACHE_SIZE + 1)]
    for t in texts:
        revisions_for_text(t, None, ["n"])
    assert len(calls) == pr.CACHE_SIZE + 1
    revisions_for_text(texts[-1], None, ["n"])
    assert len(calls) == pr.CACHE_SIZE + 1
    revisions_for_text(texts[0], None, ["n"])  # the oldest was evicted
    assert len(calls) == pr.CACHE_SIZE + 2


# ── canary ───────────────────────────────────────────────────────────────────

def test_canary_matches_the_js_reference():
    assert canary_ok() is True
    assert set(CANARY["revisions"]) == set(CANARY["document"])


def test_canary_fails_when_the_hasher_drifts(monkeypatch):
    monkeypatch.setattr(pr, "_number", lambda x: repr(float(x)))
    assert canary_ok() is False


# ── corpus CLI ───────────────────────────────────────────────────────────────

def _run_corpus(path):
    return subprocess.run([sys.executable, "-m", "lib.project_revisions", "--corpus", str(path)],
                          cwd=str(REPO_ROOT), capture_output=True, text=True)


def test_corpus_cli_ok(tmp_path):
    corpus = tmp_path / "corpus.json"
    # NaN is accepted, as json.loads does by default; revisions from the JS reference.
    corpus.write_text('[{"name": "null", "value": null, "revision": "74234e98afe7"},'
                      ' {"name": "nan", "value": NaN, "revision": "74234e98afe7"}]')
    out = _run_corpus(corpus)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "ok 2"


def test_corpus_cli_reports_mismatches(tmp_path):
    corpus = tmp_path / "corpus.json"
    corpus.write_text(json.dumps([
        {"name": "null", "value": None, "revision": "74234e98afe7"},
        {"name": "wrong", "value": 1, "revision": "000000000000"},
    ]))
    out = _run_corpus(corpus)
    assert out.returncode == 1
    lines = out.stderr.splitlines()
    assert len(lines) == 1  # only the mismatch is printed
    assert lines[0].split() == ["wrong", "000000000000", revision_of(1)]
