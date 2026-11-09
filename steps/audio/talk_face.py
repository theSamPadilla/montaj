#!/usr/bin/env python3
"""Turn a voice into a talking face: the face move and the body move as .glb files direct_scene's play takes (lib/talk).

Standalone and free: the voice is decoded to 16 kHz mono, transcribed locally (or --words is used), and lib/talk.face builds the
clip from the audio. Prints a JSON result: the files, what was driven, the report's gestures, and the exact layer entries that play
the moves. An unknown mood or beat name is a note listing the known ones; the rest still runs.
"""
import sys, os, argparse, json, re, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, require_file, ff_input, ffmpeg_bin, run

FACE_BONES = ("head", "neck")


def _decode(src, wav):
    r = run([ffmpeg_bin(), "-y", "-i", ff_input(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], check=False)
    if r.returncode != 0 or not os.path.isfile(wav) or os.path.getsize(wav) < 100:
        fail("decode_failed", f"ffmpeg could not read audio from {src}")


def _words_language(path):
    try:
        with open(path) as f:
            j = json.load(f)
        lang = (j.get("result") or {}).get("language")
        return lang if isinstance(lang, str) and lang else None
    except Exception:
        return None


def _check_words(path):
    try:
        with open(path) as f:
            j = json.load(f)
        ok = isinstance(j.get("transcription"), list) and all("offsets" in t and "text" in t for t in j["transcription"])
    except Exception:
        ok = False
    if not ok:
        fail("invalid_args", f"--words must be transcribe's words JSON ({{transcription: [{{text, offsets: {{from, to}}}}]}}): {path}")


def _clean_moods(moods, RD, notes):
    """Keep the entries the face can carry out; an unknown name is a note with the known list."""
    from lib.talk import recipes
    if moods is None:
        return []
    if not isinstance(moods, list) or not all(isinstance(m, dict) for m in moods):
        fail("invalid_args", "--moods must be a JSON list of {from, to, mood} and {at, beat, strength, hold}")
    out = []
    for i, m in enumerate(moods):
        try:
            if "beat" in m:
                float(m["at"])
                if "hold" in m:
                    float(m["hold"])
                name = str(m["beat"])
                if "strength" in m:  # the face reads strength inside the name: "wince@0.8"
                    base = name.split("@")[0]
                    name = f"{base}@{float(m['strength'])}" + (".R" if name.endswith(".R") else "")
                recipes.meta(name, RD)
                out.append({k: v for k, v in dict(m, beat=name).items() if k != "strength"})
            else:
                float(m["from"]); float(m["to"])
                recipes.mood(str(m["mood"]), RD)
                out.append(m)
        except (KeyError, ValueError, TypeError) as e:
            msg = str(e.args[0]) if isinstance(e, KeyError) and e.args else str(e)
            if isinstance(e, (KeyError, ValueError)) and "known:" in msg:
                notes.append(f"moods[{i}] skipped: {msg}")
            else:
                notes.append(f"moods[{i}] skipped: needs {{from, to, mood}} or {{at, beat}} with numbers ({msg})")
    return out


def main():
    p = argparse.ArgumentParser(description="Turn a voice into a talking face (.glb moves for direct_scene play)")
    p.add_argument("--input", required=True)
    p.add_argument("--words")
    p.add_argument("--language")
    p.add_argument("--model")
    p.add_argument("--moods", action="append", default=None,
                   help="A mood or beat as a JSON object (repeat the flag), or a JSON list of them")
    p.add_argument("--expressive", type=float, default=1.0)
    p.add_argument("--name")
    p.add_argument("--out", required=True)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    require_file(args.input)
    if args.words:
        require_file(args.words)
        _check_words(args.words)
    if not 0 <= args.expressive <= 2:
        fail("invalid_args", f"--expressive is 0..2, got {args.expressive}")
    model_json = None
    if args.model:
        model_json = os.path.join(args.model, "model.json") if os.path.isdir(args.model) else args.model
        require_file(model_json)
    moods_raw = None
    if args.moods is not None:
        moods_raw = []
        for raw in args.moods:
            try:
                v = json.loads(raw)
            except ValueError as e:
                fail("invalid_args", f"--moods is not valid JSON: {e}")
            moods_raw += v if isinstance(v, list) else [v]

    stem = args.out
    if stem.lower().endswith((".json", ".glb")):
        stem = os.path.splitext(stem)[0]
    result_path = stem + ".json"
    body_path = stem + "-body.glb"
    for taken in (result_path, body_path, stem + "-face.glb", stem + "-face-1.glb"):
        if os.path.lexists(taken):
            fail("invalid_out", f"{taken} already exists. Montaj does not overwrite a move: choose a new --out.")
    os.makedirs(os.path.dirname(os.path.abspath(stem)), exist_ok=True)
    base = args.name or re.sub(r"[^\w.-]+", "_", os.path.splitext(os.path.basename(args.input))[0]).strip("_") or "talk"

    from lib.talk import face, glb, recipes, reach
    notes = []
    RD = recipes.load()
    moods = _clean_moods(moods_raw, RD, notes)

    with tempfile.TemporaryDirectory(prefix="talk_face_") as tmp:
        wav = os.path.join(tmp, "voice.wav")
        _decode(args.input, wav)
        words = args.words
        if not words:
            from steps.speech.transcribe import transcribe
            prefix = os.path.join(tmp, "words")
            res = transcribe(wav, prefix, language=args.language or "auto", whole_file=True)
            words = res["words"]
        lang = (args.language or _words_language(words) or "en").lower().split("-")[0]
        try:
            clip, rep = face.build(wav, words, lang, moods, head=model_json, expressive=args.expressive,
                                   cmudict=None if lang in ("en", "pt") else _empty_dict(tmp), recipe_data=RD)
        except (ValueError, KeyError, OSError) as e:
            fail("talk_failed", str(e.args[0]) if isinstance(e, KeyError) and e.args else str(e))

    skeleton = None
    if model_json:
        try:
            skeleton = glb.skeleton_of(model_json)
        except (ValueError, OSError) as e:
            notes.append(f"{e}; the reference skeleton was used")
    if lang not in ("en", "pt"):
        notes.append(f"language {lang!r}: mouth shapes come from letter rules, not a dictionary")

    dur = clip["duration"]
    face_bones = {b: v for b, v in clip["bones"].items() if b in FACE_BONES}
    body_bones = {b: v for b, v in clip["bones"].items() if b not in FACE_BONES}
    ph = rep["phrases"]
    pauses = [[ph[i][1], ph[i + 1][0]] for i in range(len(ph) - 1)]
    try:
        pieces = glb.write_clips(stem + "-face", dur, clip["morphs"], face_bones, skeleton, name=base + "_face", pauses=pauses)
        binfo = glb.write_glb(body_path, dur, None, body_bones, skeleton, name=base + "_body")
    except ValueError as e:
        fail("talk_failed", str(e))
    dropped = sorted(set(binfo["dropped"]) | {b for pc in pieces for b in pc["dropped"]})
    if dropped:
        notes.append("bones this skeleton lacks, not played: " + ", ".join(dropped))
    if len(pieces) > 1:
        notes.append(f"the face move is {len(pieces)} files: send every action in play in one direct_scene call")

    reach_mm = reach.reach(model_json) if model_json else dict(RD["reference_reach_mm"])
    wanted = set(RD["reference_reach_mm"]) | set(clip["morphs"])  # the keys the voice drives, and the ones a gesture would
    missing = sorted(({k for k in wanted if not reach_mm.get(k)} if model_json else set()) | set(rep.get("missingKeys", [])))
    if missing and model_json:
        notes.append("this model lacks, or has no reach on, keys the voice would drive: " + ", ".join(missing))

    binfo_path = body_path
    face_out = [{k: pc[k] for k in ("path", "name", "start", "duration")} for pc in pieces]
    play = {
        "face": [{"play": {"clip": os.path.abspath(pc["path"]), "start": pc["start"], "over": "face"}} for pc in pieces],
        "body": {"play": {"clip": os.path.abspath(binfo_path), "start": 0, "over": "add"}},
        "note": "direct_scene play actions. start is seconds after the voice starts: add the voice's own start.",
    }
    result = {
        "face": face_out,
        "body": {"path": body_path, "name": base + "_body", "firstValues": binfo["firstValues"]},
        "duration": dur, "language": lang,
        "keys": sorted(clip["morphs"]), "missingKeys": missing,
        "gestures": rep["gestures"],
        "beats": [{k: v for k, v in b.items() if k != "keys"} for b in rep["beats"]],
        "phrases": rep["phrases"],
        "known": {"moods": sorted(RD["moods"]), "beats": sorted(RD["recipes"])},
        "play": play, "notes": notes,
    }
    with open(result_path, "w") as f:
        json.dump(result, f)
    print(json.dumps(result))


def _empty_dict(tmp):
    path = os.path.join(tmp, "empty.dict")
    open(path, "w").close()
    return path


if __name__ == "__main__":
    main()
