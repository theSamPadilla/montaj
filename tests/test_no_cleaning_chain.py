"""Nothing an agent can read may teach the old multi-step talk-cleaning chain.

The one way to clean talk is `cut` (plan, select-takes, apply). An agent that followed
the old chain (silence -> non-speech -> fillers -> transcribe -> select-takes) hit usage
errors, and fed one step's multi-input JSON to another as if it were media. The steps
themselves stay (the editor's audio polish and `cut` use them), but no instruction may
present them as a way to clean talk.

Three scopes:
  1. skills/**/*.md, workflows/*.json, montaj_assets/mcp/*.js: the chain steps are not named at all.
  2. steps/*/*.json: a step's json may name only itself.
  3. docs/ and README.md: a chain step may be named only on a line that matches ALLOWED_DOC_LINES.
Everywhere (1 to 3, step jsons included): no sequence that reads as the chain.
"""
import json
import re

from tests.conftest import REPO_ROOT, STEPS_DIR

CHAIN_STEPS = (
    "waveform_trim", "rm_nonspeech", "rm_fillers", "jump_cut", "waveform_silence",
)
_NAME_RE = re.compile(
    "|".join(re.escape(n).replace("_", "[_-]") for n in CHAIN_STEPS), re.IGNORECASE
)

# Phrases and sequences that teach the chain, whichever words they use for the steps.
_SEQUENCE_RES = (
    re.compile(r"five[- ]step", re.I),
    re.compile(r"\b(?:cleaning|clean|trim) chain\b", re.I),
    re.compile(r"silence\s*(?:→|->|=>|then)\s*(?:remove\s+)?(?:non-?speech\s*(?:→|->|=>|then)\s*)?(?:transcribe|fillers?)", re.I),
    re.compile(r"\bto chain\b", re.I),
    re.compile(r"mechanical pass", re.I),
    re.compile(r"silence\s*[×x]\d*", re.I),
    re.compile(r"silence trim,", re.I),
    re.compile(r"remove fillers", re.I),
)

# Scope 3: the only places outside a step's own json that may name a chain step.
# path -> substrings; a line naming a chain step passes only if it holds one of them.
ALLOWED_DOC_LINES = {
    # The directory inventory lists every step file by name.
    "docs/CLI.md": ("| `steps/",),
    # The editor's audio polish modal calls these steps behind its adapter.
    "docs/UI.md": ("(`rm_nonspeech`)", "(`rm_fillers`)", "(`waveform_trim`)"),
}


def _read(path):
    return path.read_text(encoding="utf-8")


def _rel(path):
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def _agent_text_files():
    files = sorted((REPO_ROOT / "skills").rglob("*.md"))
    files += sorted((REPO_ROOT / "workflows").glob("*.json"))
    files += sorted(
        p for p in (REPO_ROOT / "montaj_assets" / "mcp").glob("*.js")
    )
    return files


def _doc_files():
    files = [REPO_ROOT / "README.md"]
    files += sorted((REPO_ROOT / "docs").glob("*.md"))
    files += sorted((REPO_ROOT / "docs" / "schemas").glob("*.md"))
    return [f for f in files if f.is_file()]


def _step_json_strings(path):
    """Every string value in a step json, with the key path it sits at."""
    out = []

    def walk(node, where):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, f"{where}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{where}[{i}]")
        elif isinstance(node, str):
            out.append((where, node))

    walk(json.loads(_read(path)), "")
    return out


def _chain_names_in(text):
    return {m.group(0).lower().replace("-", "_") for m in _NAME_RE.finditer(text)}


def scan_agent_text(files):
    """Scope 1: no chain step is named at all."""
    problems = []
    for f in files:
        for n, line in enumerate(_read(f).splitlines(), 1):
            for name in _chain_names_in(line):
                problems.append(f"{_rel(f)}:{n} names {name}")
    return problems


def scan_step_jsons(step_files):
    """Scope 2: a step json names only itself."""
    problems = []
    for f in step_files:
        own = f.stem
        for where, text in _step_json_strings(f):
            for name in _chain_names_in(text) - {own}:
                problems.append(f"{_rel(f)}{where} names {name}")
    return problems


def scan_docs(files, allowed=ALLOWED_DOC_LINES):
    """Scope 3: names only on allowlisted lines."""
    problems = []
    for f in files:
        ok = allowed.get(_rel(f), ())
        for n, line in enumerate(_read(f).splitlines(), 1):
            if _chain_names_in(line) and not any(a in line for a in ok):
                problems.append(f"{_rel(f)}:{n} names a chain step")
    return problems


def scan_sequences(texts):
    """Everywhere: no sequence that reads as the chain. texts = [(label, text)]."""
    problems = []
    for label, text in texts:
        flat = re.sub(r"\s+", " ", text)
        for rx in _SEQUENCE_RES:
            m = rx.search(flat)
            if m:
                problems.append(f"{label} teaches a chain: '{m.group(0)}'")
    return problems


def _all_texts():
    texts = [(_rel(f), _read(f)) for f in _agent_text_files() + _doc_files()]
    for f in sorted(STEPS_DIR.glob("*/*.json")):
        for where, text in _step_json_strings(f):
            texts.append((f"{_rel(f)}{where}", text))
    return texts


def test_agent_text_never_names_the_chain_steps():
    problems = scan_agent_text(_agent_text_files())
    assert not problems, "use `cut` instead:\n" + "\n".join(problems)


def test_step_jsons_name_only_themselves():
    problems = scan_step_jsons(sorted(STEPS_DIR.glob("*/*.json")))
    assert not problems, "point to `cut`, not to sibling steps:\n" + "\n".join(problems)


def test_docs_name_chain_steps_only_where_allowlisted():
    problems = scan_docs(_doc_files())
    assert not problems, "\n".join(problems)


def test_no_text_teaches_the_chain_as_a_sequence():
    problems = scan_sequences(_all_texts())
    assert not problems, "\n".join(problems)


def test_the_guard_catches_the_chain(tmp_path):
    """The scans fail on the old wording (so a pass above means something)."""
    skill = tmp_path / "SKILL.md"
    skill.write_text("waveform_trim -> trim spec -> rm_nonspeech -> transcribe\n")
    assert scan_agent_text([skill])
    step = tmp_path / "other_step.json"
    step.write_text(json.dumps({"description": "pass this to rm_nonspeech to chain"}))
    assert scan_step_jsons([step])
    assert scan_sequences([("x", "silence trim, remove non-speech, transcribe")])
    assert scan_sequences([("x", "Run the five-step chain")])
    doc = tmp_path / "README.md"
    doc.write_text("| Clean | `rm_fillers` |\n")
    assert scan_docs([doc], allowed={})
