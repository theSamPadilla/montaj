"""Where each file in a project came from: `assets/.provenance.json`.

The record maps a file's path relative to the project folder (so a moved
project keeps it) to one entry: its `kind`, when it was recorded (`at`, ISO
8601 UTC to the second) and the kind's own fields (`KINDS`):

  user       via: drop, picker, new-project, import, agent-image, import_model, record
  stock      source (commons, sportsdb, web), licence, artist, sourceUrl, title
  web        via (url, youtube, capture_site, fetch), sourceUrl, title, uploader
  ai         provider, model, prompt, step
  derived    step, from (its inputs inside the project folder, as keys)
  synth      step
  library    id, version, spdx, source, notice
  template   templateId
  brand_kit  profileId
  montaj     what: preset, sample

`ai`'s `provider` is the connector id (kling, fal, kinovi, gemini, openai,
elevenlabs, tripo). An entry for a file that existed when it was recorded also
has `bytes`, its size then; a reader (`annotated`) marks the entry `stale` when
the file is gone or its size changed, so a new file under an old name inherits
nothing. Serve is the one writer, and `record_provenance` is the
only code that writes the file. Serve's step funnel calls it for every step
whose output lands in a project (`_note_provenance` in serve/routes/steps.py,
which builds the entries with `step_records`), and the project routes call it
for the app's own imports (`POST /projects/{id}/provenance`, upload-asset,
sources). A run outside serve (the CLI) is not recorded, and a file with no
entry is untagged: nothing is guessed.

`assets/.generated.json`, the AI-only record this replaces, is no longer
written and is still read: `merged` gives its entries kind `ai` wherever the
new record has none for that path. project.json is never touched.
"""
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from lib.project_lock import project_lock, write_json_atomic

RECORD_NAME = ".provenance.json"
LEGACY_NAME = ".generated.json"
ASSETS_DIR = "assets"
_PROMPT_MAX = 2000
_STRING_MAX = 1000
_FROM_MAX = 500
_RECORD_MAX_BYTES = 4 * 1024 * 1024
_MANIFEST_MAX_BYTES = 1024 * 1024

USER_VIA = ("drop", "picker", "new-project", "import", "agent-image", "import_model", "record")
WEB_VIA = ("url", "youtube", "capture_site", "fetch")
STOCK_SOURCES = ("commons", "sportsdb", "web")
MONTAJ_WHAT = ("preset", "sample")

# kind -> {field: (type, required)}. A tuple type is the values the field may take;
# "paths" is a list of keys; "version" is a string or an integer (library.json's).
KINDS = {
    "user": {"via": (USER_VIA, True)},
    "stock": {"source": (STOCK_SOURCES, False), "licence": ("str", False), "artist": ("str", False),
              "sourceUrl": ("str", False), "title": ("str", False)},
    "web": {"via": (WEB_VIA, True), "sourceUrl": ("str", False), "title": ("str", False),
            "uploader": ("str", False)},
    "ai": {"provider": ("str", True), "model": ("str", False), "prompt": ("str", False), "step": ("str", True)},
    "derived": {"step": ("str", True), "from": ("paths", False)},
    "synth": {"step": ("str", True)},
    "library": {"id": ("str", True), "version": ("version", False), "spdx": ("str", False),
                "source": ("str", False), "notice": ("str", False)},
    "template": {"templateId": ("str", True)},
    "brand_kit": {"profileId": ("str", True)},
    "montaj": {"what": (MONTAJ_WHAT, True)},
}
# The kinds a step may declare with `"provenance": {"kind": ...}` (an AI step declares
# its provider instead, and any other step is derived).
STEP_KINDS = ("stock", "web", "synth")

_AT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\+00:00|Z)")
_RESERVED = {"project.json", ".project.lock", f"{ASSETS_DIR}/{RECORD_NAME}", f"{ASSETS_DIR}/{LEGACY_NAME}"}


class ProvenanceError(ValueError):
    """A path or entry the record refuses. `code`: invalid_entry, invalid_path,
    outside_project or record_full."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _at(value) -> str:
    if value is None:
        return _now()
    if isinstance(value, str) and _AT.fullmatch(value):
        value = value.replace("Z", "+00:00")
        try:
            datetime.fromisoformat(value)
            return value
        except ValueError:
            pass
    raise ProvenanceError("invalid_entry", f"'at' must be a UTC time to the second, as "
                                           f"2026-10-20T14:03:09+00:00, got {value!r}")


def _absent(value) -> bool:
    return value is None or value == [] or (isinstance(value, str) and not value.strip())


def _field(kind: str, name: str, ftype, value):
    where = f"'{name}' of a {kind} entry"
    if ftype == "paths":
        if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
            raise ProvenanceError("invalid_entry", f"{where} must be a list of paths")
        return [v[:_STRING_MAX] for v in value[:_FROM_MAX]]
    if ftype == "version":
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            raise ProvenanceError("invalid_entry", f"{where} must be a string or an integer")
        return value[:_STRING_MAX] if isinstance(value, str) else value
    if not isinstance(value, str):
        raise ProvenanceError("invalid_entry", f"{where} must be a string")
    if isinstance(ftype, tuple) and value not in ftype:
        raise ProvenanceError("invalid_entry", f"{where} must be one of {list(ftype)}, got {value!r}")
    return value[:_PROMPT_MAX if name == "prompt" else _STRING_MAX]


def validate_entry(entry) -> dict:
    """`entry` as it is stored: its kind's fields only, strings capped (a prompt at
    2000 characters, the rest at 1000), `at` stamped now when absent. A null or
    empty optional field is left out. Raises ProvenanceError (invalid_entry) for
    an unknown kind or field, a wrong type, a value outside a field's set or a
    missing required field."""
    if not isinstance(entry, dict):
        raise ProvenanceError("invalid_entry", "entry must be an object")
    kind = entry.get("kind")
    fields = KINDS.get(kind) if isinstance(kind, str) else None
    if fields is None:
        raise ProvenanceError("invalid_entry", f"'kind' must be one of {list(KINDS)}, got {kind!r}")
    unknown = sorted(k for k in entry if k not in fields and k not in ("kind", "at"))
    if unknown:
        raise ProvenanceError("invalid_entry", f"unknown field(s) for a {kind} entry: {', '.join(unknown)}. "
                                               f"It takes {list(fields)} and 'at'")
    clean = {"kind": kind, "at": _at(entry.get("at"))}
    for name, (ftype, required) in fields.items():
        value = entry.get(name)
        if _absent(value):
            if required:
                raise ProvenanceError("invalid_entry", f"a {kind} entry needs '{name}'")
            continue
        clean[name] = _field(kind, name, ftype, value)
    return clean


def key_for(project_dir, path) -> str:
    """`path` (relative to the project folder, or absolute) as the record's key: its
    path relative to the folder, symlinks followed. Raises ProvenanceError when it
    is not inside the folder (outside_project) or is one of the project's own files
    (project.json, the lock, the records, .git)."""
    if not isinstance(path, str) or not path.strip() or "\x00" in path:
        raise ProvenanceError("invalid_path", "'path' must be the path of a file in the project")
    pdir = Path(os.path.realpath(project_dir))
    p = Path(path)
    real = Path(os.path.realpath(p if p.is_absolute() else pdir / p))
    if pdir not in real.parents:
        raise ProvenanceError("outside_project", f"'{path}' is not inside the project folder")
    key = real.relative_to(pdir).as_posix()
    if key in _RESERVED or key == ".git" or key.startswith((".git/", f"{ASSETS_DIR}/{RECORD_NAME}.")):
        raise ProvenanceError("invalid_path", f"'{key}' is one of the project's own files")
    return key


def _load(path: Path) -> dict:
    """{key: entry} from one record file. Missing, unreadable, over the size cap or
    not an object: {}."""
    try:
        if path.stat().st_size > _RECORD_MAX_BYTES:
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, dict)}


def read(project_dir) -> dict:
    """`assets/.provenance.json`: {key: entry}."""
    return _load(Path(project_dir) / ASSETS_DIR / RECORD_NAME)


def read_legacy(project_dir) -> dict:
    """`assets/.generated.json`, the AI-only record (no `kind`): {key: entry}."""
    return _load(Path(project_dir) / ASSETS_DIR / LEGACY_NAME)


def merged(project_dir) -> dict:
    """The whole record: `.provenance.json`'s entries, plus `.generated.json`'s as
    kind `ai` for each path the new record has no entry for."""
    legacy = {k: {**v, "kind": "ai"} for k, v in read_legacy(project_dir).items()}
    return {**legacy, **read(project_dir)}


def _is_stale(project_dir, key: str, entry: dict) -> bool:
    """The file is gone, or it is not the size `bytes` says it was when recorded.
    An entry with no `bytes` (the file did not exist yet, or the older record) is
    stale only when the file is gone."""
    file = Path(project_dir) / key
    try:
        if not file.exists():
            return True
        size = entry.get("bytes")
        return (isinstance(size, int) and not isinstance(size, bool) and file.is_file()
                and file.stat().st_size != size)
    except (OSError, ValueError):
        return True


def annotated(project_dir) -> dict:
    """`merged`, each entry whose file is gone or changed size marked `stale: true`
    (`_is_stale`). Nothing is deleted: what GET /projects/{id}/provenance answers."""
    return {k: {**e, "stale": True} if _is_stale(project_dir, k, e) else e
            for k, e in merged(project_dir).items()}


def generated(project_dir) -> dict:
    """The ai entries of `annotated`, in the shape the AI-only record had (no
    `kind`): what `GET /projects/{id}/generated` answers."""
    return {k: {f: v for f, v in e.items() if f != "kind"}
            for k, e in annotated(project_dir).items() if e.get("kind") == "ai"}


def _read_for_write(target: Path) -> dict:
    """The record about to be changed. Missing: {}. Over the size cap: refused
    (record_full), so a full record is never replaced by a near-empty one. Not a
    JSON object: copied aside to `.provenance.json.unreadable-<time>` (kept), then {}."""
    try:
        size = target.stat().st_size
    except FileNotFoundError:
        return {}
    if size > _RECORD_MAX_BYTES:
        raise ProvenanceError("record_full", "The project's provenance record is full")
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except ValueError:
        data = None
    if isinstance(data, dict):
        return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, dict)}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    shutil.copyfile(target, target.with_name(f"{RECORD_NAME}.unreadable-{stamp}"))
    return {}


def record_provenance(project_dir, path, entry) -> tuple[str, dict]:
    """Record `entry` (validated by `validate_entry`) for `path`, a file in
    `project_dir`, with `bytes` (the file's size) when the file exists; returns
    the key and the entry as stored. The one writer of `.provenance.json`.

    Under the project lock (lib/project_lock.py) it re-reads the record, changes
    the one key and writes the whole file to a temp file renamed over it, so
    concurrent writers never lose an entry and a reader never sees half a file.
    A module lock would not be enough: serve is one process (uvicorn.run with no
    workers, cli/commands/serve.py), but a second serve may run on the same
    workspace (serve/lockfile.py). It blocks while it waits, so serve's async
    code calls it through asyncio.to_thread. Raises ProvenanceError,
    ProjectLockTimeout, ProjectReadOnly or OSError, and the record is then as it
    was."""
    clean = validate_entry(entry)
    key = key_for(project_dir, path)
    pdir = Path(os.path.realpath(project_dir))
    assets = pdir / ASSETS_DIR
    with project_lock(pdir):
        if assets.is_symlink():
            raise ProvenanceError("invalid_path", "The project's assets folder is a symlink; the record "
                                                  "is not written through it")
        assets.mkdir(exist_ok=True)
        target = assets / RECORD_NAME
        data = _read_for_write(target)
        file = pdir / key
        if file.is_file():
            clean["bytes"] = file.stat().st_size
        data[key] = clean
        if len(json.dumps(data, indent=2).encode()) > _RECORD_MAX_BYTES:
            raise ProvenanceError("record_full", "The project's provenance record is full")
        write_json_atomic(target, data)
    return key, clean


# ── the step funnel ──────────────────────────────────────────────────────────

def _param_default(schema: dict, name: str):
    for p in schema.get("params") or []:
        if p.get("name") == name:
            return p.get("default")
    return None


def _param(body: dict, name: str):
    """A param's value as the step was given it (hyphenated or underscored)."""
    v = body.get(name)
    return body.get(name.replace("-", "_")) if v is None else v


def entry_for(name: str, schema: dict, body: dict, result) -> dict | None:
    """The ai entry for one run of step `name`, or None when the step declares no
    provider or no provider can be told."""
    prov = schema.get("provenance")
    if not isinstance(prov, dict):
        return None
    provider = prov.get("provider")
    if not provider and isinstance(prov.get("providerParam"), str):
        param = prov["providerParam"]
        provider = body.get(param) or _param_default(schema, param)
    if not isinstance(provider, str) or not provider:
        return None
    model = result.get("model") if isinstance(result, dict) else None
    if not isinstance(model, str) or not model:
        model = body.get("model") or _param_default(schema, "model")
    entry = {"kind": "ai", "provider": provider, "step": name, "at": _now()}
    if isinstance(model, str) and model:
        entry["model"] = model
    prompt = body.get("prompt") or body.get("text")
    if isinstance(prompt, str) and prompt.strip():
        entry["prompt"] = prompt[:_PROMPT_MAX]
    return entry


def output_path(result, body: dict) -> str | None:
    """The file the run made: the result's `out` or `path`, else the `out` param."""
    if isinstance(result, dict):
        for key in ("out", "path"):
            v = result.get(key)
            if isinstance(v, str) and v:
                return v
    v = body.get("out")
    return v if isinstance(v, str) and v else None


def project_dir_containing(path: str, workspace: str) -> Path | None:
    """The nearest folder above `path` with a project.json, inside `workspace`
    (symlinks followed), or None."""
    ws = Path(os.path.realpath(workspace))
    here = Path(os.path.realpath(path)).parent
    while here != ws and ws in here.parents:
        if (here / "project.json").is_file():
            return here
        here = here.parent
    return None


def _absolute(path: str, workspace: str) -> str:
    # A step runs with the workspace as its cwd, so a relative path is the workspace's.
    return path if os.path.isabs(path) else os.path.join(workspace, path)


def _inside(folder, path: str) -> bool:
    return Path(os.path.realpath(folder)) in Path(os.path.realpath(path)).parents


def _manifest(path: str) -> tuple[dict, list[str]]:
    """capture_site's manifest.json: ({url, title}, the files it lists, absolute)."""
    try:
        if os.path.getsize(path) > _MANIFEST_MAX_BYTES:
            return {}, []
        m = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, []
    if not isinstance(m, dict):
        return {}, []
    shots, logos = m.get("screenshots"), m.get("logos")
    rels = [v for v in shots.values() if isinstance(v, str)] if isinstance(shots, dict) else []
    if isinstance(logos, list):
        rels += [lg["path"] for lg in logos if isinstance(lg, dict) and isinstance(lg.get("path"), str)]
    meta = {k: m[k] for k in ("url", "title") if isinstance(m.get(k), str)}
    base = os.path.dirname(path)
    return meta, [os.path.join(base, r) for r in rels if r and not os.path.isabs(r)]


def _outputs(prov: dict | None, body: dict, result, workspace: str) -> list[tuple[str, dict]]:
    """(absolute path, what the result says about it) for each file the run made:
    the result's `paths` (fetch's playlist), else its one output. A `manifest`
    declaration adds the files the manifest lists. Folders are left out."""
    res = result if isinstance(result, dict) else {}
    videos = res.get("videos") if isinstance(res.get("videos"), list) else []
    about = {v["path"]: v for v in videos if isinstance(v, dict) and isinstance(v.get("path"), str)}
    if isinstance(res.get("paths"), list):
        named = [p for p in res["paths"] if isinstance(p, str) and p]
    else:
        one = output_path(result, body)
        named = [one] if one else []
    found = [(_absolute(p, workspace), about.get(p) or {}) for p in named]
    if prov and prov.get("manifest") is True and found:
        meta, files = _manifest(found[0][0])
        found = [(p, {**meta, **m}) for p, m in found] + [(f, meta) for f in files]
    return [(p, m) for p, m in found if os.path.isfile(p)]


def _path_values(schema: dict, body: dict):
    """Every path the run was given: `input`, `inputs` and each `path` or `array`
    param, except the outputs (`out`, `out-dir`)."""
    values = [body.get("input"), body.get("inputs")]
    for p in schema.get("params") or []:
        name = p.get("name")
        if isinstance(name, str) and p.get("type") in ("path", "array") and not name.startswith("out"):
            values.append(_param(body, name))
    for v in values:
        for item in v if isinstance(v, list) else [v]:
            if isinstance(item, str) and item:
                yield item


def _inputs_inside(pdir: Path, schema: dict, body: dict, workspace: str) -> list[str]:
    keys = []
    for v in _path_values(schema, body):
        p = _absolute(v, workspace)
        if not os.path.exists(p):
            continue
        try:
            key = key_for(pdir, p)
        except ProvenanceError:
            continue
        if key not in keys:
            keys.append(key)
    return keys


def step_records(name: str, schema: dict, body: dict, result, workspace: str,
                 named: Path | None = None) -> list[tuple[Path, str, dict]]:
    """(project folder, output path, entry) for each file a finished run of step
    `name` made in a project's folder: `named` (the project the run's `_project`
    named) when the file is inside it, else the nearest folder above the file
    with a project.json. The kind comes from the step's `provenance` declaration:
    a `provider` or `providerParam` is ai, `{"kind": "stock"|"web"|"synth"}` is
    that kind (fields from the step's params and result), and no declaration is
    derived, `from` the run's input paths inside the project. Not recorded: an AI
    run whose provider cannot be told, and a derived output that is one of its
    own inputs (a file rewritten in place keeps its record)."""
    prov = schema.get("provenance") if isinstance(schema.get("provenance"), dict) else None
    kind = (prov.get("kind") or "ai") if prov else "derived"
    if kind not in ("ai", "derived") + STEP_KINDS:
        return []
    ai = entry_for(name, schema, body, result) if kind == "ai" else None
    if kind == "ai" and ai is None:
        return []
    records = []
    for out, about in _outputs(prov, body, result, workspace):
        pdir = named if named is not None and _inside(named, out) else project_dir_containing(out, workspace)
        if pdir is None:
            continue
        if kind == "ai":
            entry = dict(ai)
        elif kind == "stock":
            entry = {"kind": "stock", "source": _param(body, "source"), "licence": _param(body, "licence"),
                     "artist": _param(body, "artist"),
                     "sourceUrl": _param(body, "source-url") or _param(body, "url"),
                     "title": _param(body, "title")}
        elif kind == "web":
            entry = {"kind": "web", "via": prov.get("via"),
                     "sourceUrl": about.get("url") or _param(body, "url"),
                     "title": about.get("title"), "uploader": about.get("uploader")}
        elif kind == "synth":
            entry = {"kind": "synth", "step": name}
        else:
            inputs = _inputs_inside(pdir, schema, body, workspace)
            try:
                if key_for(pdir, out) in inputs:
                    continue
            except ProvenanceError:
                continue
            entry = {"kind": "derived", "step": name, "from": inputs}
        records.append((pdir, out, entry))
    return records
