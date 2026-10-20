"""A revision per top-level field of a project, so a writer can only save what it read.

A revision is the first 12 hex digits of the sha256 of the field's canonical JSON. The canonical form
is RFC 8785 (JCS): numbers as ECMAScript prints them, strings as JSON.stringify writes them, object
keys sorted by UTF-16 code units, no whitespace. An absent top-level field reads as null. This is the
twin of the app's JS hasher (desktop/mcp/project-revisions.mjs); the two must agree on every
JSON-parsed value, and CANARY checks that they still do.
"""
import hashlib
import json
import math
import os
import re
import sys
import threading
from collections import OrderedDict

_SURROGATE = re.compile("[\ud800-\udfff]")
_SHORT_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_MAX_SAFE = 2 ** 53


def _number(x) -> str:
    """ECMAScript Number::toString over Python's shortest round-trip digits. Non-finite is null,
    as JSON.stringify writes it; an int is first rounded to a double, as a JS parse does."""
    if isinstance(x, int):
        if -_MAX_SAFE <= x <= _MAX_SAFE:
            return str(x)
        try:
            x = float(x)
        except OverflowError:
            return "null"
    if not math.isfinite(x):
        return "null"
    if x == 0:
        return "0"
    r = repr(x)
    sign = ""
    if r[0] == "-":
        sign, r = "-", r[1:]
    mantissa, _, exp = r.partition("e")
    whole, _, frac = mantissa.partition(".")
    digits = whole + frac
    n = len(whole) + int(exp or 0)       # the value is 0.<digits> x 10^n
    stripped = digits.lstrip("0")
    n -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * -n + digits
    else:
        e = n - 1
        out = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def _string(s: str) -> str:
    """A string as JSON.stringify writes it. json.dumps agrees except on surrogates, which a Python
    str can hold alone (JS escapes a lone one; a high-low pair is one character)."""
    if not _SURROGATE.search(s):
        return json.dumps(s, ensure_ascii=False)
    out = ['"']
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        o = ord(c)
        if 0xD800 <= o <= 0xDBFF and i + 1 < n and 0xDC00 <= ord(s[i + 1]) <= 0xDFFF:
            out.append(chr(0x10000 + ((o - 0xD800) << 10) + (ord(s[i + 1]) - 0xDC00)))
            i += 2
            continue
        if 0xD800 <= o <= 0xDFFF or o < 0x20:
            out.append(_SHORT_ESCAPES.get(c) or "\\u%04x" % o)
        else:
            out.append(_SHORT_ESCAPES.get(c, c))
        i += 1
    out.append('"')
    return "".join(out)


def _utf16_key(k: str) -> bytes:
    return k.encode("utf-16-be", "surrogatepass")


def canonical(value) -> str:
    """The RFC 8785 canonical JSON of a JSON-parsed value."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=_utf16_key)
        return "{" + ",".join(_string(k) + ":" + canonical(value[k]) for k in keys) + "}"
    raise TypeError(f"not a JSON value: {type(value).__name__}")


def revision_of(value) -> str:
    """The revision of one field's value. The canonical string never holds a lone surrogate (they
    are escaped), so it always encodes as UTF-8."""
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()[:12]


def revisions_of(project, fields=None) -> dict:
    """{field: revision} for the top-level fields of project (all of them, or just fields; a named
    field the project lacks reads as null)."""
    p = project if isinstance(project, dict) else {}
    names = list(fields) if fields is not None else list(p)
    return {f: revision_of(p.get(f)) for f in names}


def stale_fields(project, changed_fields, read, revisions=None) -> dict:
    """Which of the fields a save changes cannot be written: missing (no revision was sent for it,
    so it was never read) and stale (the revision sent differs from the project's now). id is never
    checked. Both keep the order of changed_fields. revisions, when given, are the project's
    current revisions for those fields already computed (serve's cached ones)."""
    have = read if isinstance(read, dict) else {}
    names = [f for f in changed_fields if f != "id"]
    now = {f: revisions[f] for f in names} if revisions is not None else revisions_of(project, names)
    missing, stale = [], []
    for field, rev in now.items():
        sent = have.get(field)
        if not isinstance(sent, str) or sent == "":
            missing.append(field)
        elif sent != rev:
            stale.append(field)
    return {"missing": missing, "stale": stale}


# ── cache: one file version is hashed at most once per field ──────────────────

CACHE_SIZE = 8
_cache: "OrderedDict[str, dict]" = OrderedDict()
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _text_key(text) -> str:
    raw = text.encode("utf-8") if isinstance(text, str) else bytes(text)
    return hashlib.sha256(raw).hexdigest()


def revisions_for_text(text, project=None, fields=None, base=None) -> dict:
    """revisions_of for the project.json whose raw text is text (str or bytes), cached by the sha256
    of that text, so each file version's fields are hashed once. project is the parsed text when the
    caller has it; otherwise the text is parsed.

    base, when given, is (the text of an earlier version, its parsed project) that project was made
    from (a save's merge): every top-level field whose value in project is the very object it was in
    base's project keeps base's cached revision, so a save hashes only the fields it changed."""
    key = _text_key(text)
    with _cache_lock:
        known = _cache.get(key)
        if known is not None:
            _cache.move_to_end(key)
        known = dict(known or {})
        old = _cache.get(_text_key(base[0])) if base is not None and base[0] is not None else None
        old = dict(old) if old else None
    if project is None:
        project = json.loads(text.encode("utf-8") if isinstance(text, str) else bytes(text))
    p = project if isinstance(project, dict) else {}
    if old and isinstance(base[1], dict):
        before = base[1]
        for f, rev in old.items():
            if f not in known and (f in p) == (f in before) and p.get(f) is before.get(f):
                known[f] = rev
    names = list(fields) if fields is not None else list(p)
    for f in names:
        if f not in known:
            known[f] = revision_of(p.get(f))
    with _cache_lock:
        _cache[key] = {**_cache.get(key, {}), **known}
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return {f: known[f] for f in names}


# ── startup canary ────────────────────────────────────────────────────────────

# A small fixed document over the hard cases. Every top-level field is one family.
CANARY_TEXT = (
    '{"numbers":[0,-0,-0.0,1,1.0,4.5,100,1e21,1e-7,0.000001,1e23,123456789012345680000,333333333.3333333,'
    '9007199254740993,5e-324,1.7976931348623157e308,-1.5e-9,1e400,1' + "0" * 400 + '],'
    '"strings":["\\ud800","a\\udc00b","\\u2028\\u2029","\\u0000\\u0007\\b\\f\\n\\r\\t\\u001f\\u007f",'
    '"\\"\\\\/","\\u00e9\\ud83d\\ude00"],'
    '"keys":{"\\ue000":3,"\\ud800\\udc00":2,"\\ud7ff":1,"b":0,"a":0},'
    '"empty":[[],{},""],"literals":[true,false,null]}'
)


def _canary_document() -> dict:
    doc = json.loads(CANARY_TEXT)
    doc["nonfinite"] = [float("nan"), float("inf"), float("-inf")]
    return doc


# Produced by the JS reference, desktop/mcp/project-revisions.mjs at montaj-app commit dab1ff94e
# (revisionsOf over the document above, with nonfinite = [NaN, Infinity, -Infinity]). Never
# regenerate these with this module: they are what it is checked against.
CANARY = {
    "document": _canary_document(),
    "revisions": {
        "numbers": "ca8240ddc7aa",
        "strings": "18b63178cc1e",
        "keys": "294142db3acf",
        "empty": "17f03cd1fef9",
        "literals": "4d0f18de2133",
        "nonfinite": "fe44a8cccd89",
    },
}


def canary_ok() -> bool:
    """True when this hasher still agrees with the JS reference on the canary document."""
    try:
        return revisions_of(_canary_document(), list(CANARY["revisions"])) == CANARY["revisions"]
    except Exception:
        return False


# ── the switch, for serve and for the steps it starts ─────────────────────────

GUARD_ENV = "MONTAJ_ENGINE_GUARD"


def engine_guard_requested() -> bool:
    """True when the app started serve with MONTAJ_ENGINE_GUARD=1. Every step serve starts
    inherits it (only the shell secret is taken out), so a step reads it here without
    importing serve."""
    return os.environ.get(GUARD_ENV) == "1"


def engine_guard_enabled() -> bool:
    """The §477 comparisons are on: requested, and this hasher still agrees with the app's.
    Off, every writer behaves as it did before §477."""
    return engine_guard_requested() and canary_ok()


def step_stale_message(fields) -> str:
    """What a step says when a field it read changed before it could write (§477)."""
    return (f"The project changed while the step ran: {', '.join(fields)} changed since it was read. "
            f"Read the project again and rerun.")


def _check_corpus(path) -> int:
    with open(path, encoding="utf-8") as f:
        cases = json.loads(f.read())
    bad = 0
    for case in cases:
        got = revision_of(case.get("value"))
        if got != case.get("revision"):
            bad += 1
            print(f"{case.get('name')}\t{case.get('revision')}\t{got}", file=sys.stderr)
    if bad:
        return 1
    print(f"ok {len(cases)}")
    return 0


def main(argv=None) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog="python -m lib.project_revisions")
    parser.add_argument("--corpus", required=True,
                        help='JSON array of {"name", "value", "revision"}, revision from the JS hasher')
    args = parser.parse_args(argv)
    return _check_corpus(args.corpus)


if __name__ == "__main__":
    sys.exit(main())
