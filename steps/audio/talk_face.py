#!/usr/bin/env python3
"""Turn a voice into a talking face: the face move and the body move as .glb files direct_scene's play takes (lib/talk).

Standalone and free: the voice is decoded to 16 kHz mono, transcribed locally (or --words is used), and lib/talk.face builds the
clip from the audio. Prints a JSON result: the files, what was driven, the report's gestures, and the exact layer entries that play
the moves. An unknown mood or beat name is a note listing the known ones; the rest still runs.
"""
import sys, os, argparse, json, re, shutil, tempfile

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
    notes = []
    ex = args.expressive
    if ex != ex:
        ex = 1.0
        notes.append("--expressive was not a number: 1 was used")
    elif not 0 <= ex <= 2:
        ex = min(max(ex, 0.0), 2.0)
        notes.append(f"--expressive is 0..2: {args.expressive:g} was set to {ex:g}")
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
    stem = os.path.abspath(stem)
    result_path = stem + ".json"
    body_path = stem + "-body.glb"
    words_path = stem + "-words.json"
    for taken in (result_path, body_path, words_path, stem + "-face.glb", stem + "-face-1.glb"):
        if os.path.lexists(taken):
            fail("invalid_out", f"{taken} already exists. Montaj does not overwrite a move: choose a new --out.")
    base = args.name or re.sub(r"[^\w.-]+", "_", os.path.splitext(os.path.basename(args.input))[0]).strip("_") or "talk"

    try:
        from lib.talk import face, glb, recipes, reach
    except ImportError as e:
        fail("missing_dependency", f"talk_face needs numpy, which Montaj does not install by itself ({e}). Install it: pip install numpy")
    RD = recipes.load()
    moods = _clean_moods(moods_raw, RD, notes)

    outdir = os.path.dirname(stem)
    os.makedirs(outdir, exist_ok=True)
    # Every file is written under temp names in the output folder and renamed at the end: a failure leaves nothing behind.
    stage = tempfile.mkdtemp(prefix=".talk_face_", dir=outdir)
    try:
        sbase = os.path.join(stage, os.path.basename(stem))
        words_kept = None
        with tempfile.TemporaryDirectory(prefix="talk_face_") as tmp:
            wav = os.path.join(tmp, "voice.wav")
            _decode(args.input, wav)
            words = args.words
            want = None if (args.language or "").lower() in ("", "auto") else args.language
            if not words:
                from steps.speech.transcribe import transcribe
                res = transcribe(wav, os.path.join(tmp, "words"), language=want or "auto", whole_file=True)
                words = res["words"]
                shutil.copyfile(words, sbase + "-words.json")
                words_kept = words_path
            lang = (want or _words_language(words) or "en").lower().split("-")[0]
            if lang not in ("en", "pt"):
                notes.append(f"language {lang!r}: mouth shapes come from letter rules, not a dictionary")
            # The reach is read once. A model whose face keys cannot be read plays with the reference head's reach.
            reach_mm = None
            if model_json:
                try:
                    reach_mm = reach.reach(model_json)
                except (ValueError, KeyError, TypeError, OSError) as e:
                    notes.append("this model has no face keys Montaj can read: the reference head's reach was used")
            have_reach = reach_mm is not None
            if reach_mm is None:
                reach_mm = dict(RD["reference_reach_mm"])
            try:
                clip, rep = face.build(wav, words, lang, moods, head=model_json if have_reach else None, expressive=ex,
                                       cmudict=None if lang in ("en", "pt") else _empty_dict(tmp), recipe_data=RD, reach_mm=reach_mm)
            except (ValueError, KeyError, OSError) as e:
                fail("talk_failed", str(e.args[0]) if isinstance(e, KeyError) and e.args else str(e))

        skeleton = None
        if model_json:
            try:
                # Direct play (retarget in the app) is not given the model's rig.json, so it applies no placement: write for none.
                skeleton = dict(glb.skeleton_of(model_json), place=None)
            except (ValueError, KeyError, TypeError, OSError) as e:
                notes.append(f"{e}; the reference skeleton was used")

        dur = clip["duration"]
        face_bones = {b: v for b, v in clip["bones"].items() if b in FACE_BONES}
        body_bones = {b: v for b, v in clip["bones"].items() if b not in FACE_BONES}
        have = {r[0] for r in (skeleton or glb.REFERENCE)["rows"] if isinstance(r, list) and r} - {"root"}
        # Additive play adds the change since the move's time 0 (motion.js Layers): key every bone at 0 as no turn, so the body's
        # posture plays in (play's fade-in ramps it) instead of being taken off every key.
        for b, keys in body_bones.items():
            body_bones[b] = [[0, [0, 0, 0]]] + [k for k in keys if float(k[0]) > 0]
        ph = rep["phrases"]
        pauses = [[ph[i][1], ph[i + 1][0]] for i in range(len(ph) - 1)]
        try:
            pieces = glb.write_clips(sbase + "-face", dur, clip["morphs"], face_bones, skeleton, name=base + "_face", pauses=pauses)
            binfo = None
            if any(b in have for b in body_bones):
                binfo = glb.write_glb(sbase + "-body.glb", dur, None, body_bones, skeleton, name=base + "_body")
        except ValueError as e:
            fail("talk_failed", str(e))
        dropped = sorted(set(binfo["dropped"] if binfo else body_bones) | {b for pc in pieces for b in pc["dropped"]})
        if dropped:
            notes.append("bones this skeleton lacks, not played: " + ", ".join(dropped))
        if binfo is None:
            notes.append("no body move: this skeleton has none of the bones the voice moves")
        if len(pieces) > 1:
            notes.append(f"the face move is {len(pieces)} files: send every action in play in one direct_scene call")

        wanted = set(RD["reference_reach_mm"]) | set(clip["morphs"])  # the keys the voice drives, and the ones a gesture would
        missing = sorted(({k for k in wanted if not reach_mm.get(k)} if have_reach else set()) | set(rep.get("missingKeys", [])))
        if missing and have_reach:
            notes.append("this model lacks, or has no reach on, keys the voice would drive: " + ", ".join(missing))

        final = lambda path: os.path.join(outdir, os.path.basename(path))
        face_out = [{"path": final(pc["path"]), "name": pc["name"], "start": pc["start"], "duration": pc["duration"]} for pc in pieces]
        play = {
            "face": [{"play": {"clip": fo["path"], "start": fo["start"], "over": "face"}} for fo in face_out],
            "note": "direct_scene play actions. start is seconds after the voice starts: add the voice's own start.",
        }
        if binfo:
            play["body"] = {"play": {"clip": body_path, "start": 0, "over": "add"}}
        result = {
            "face": face_out,
            "body": {"path": body_path, "name": base + "_body"} if binfo else None,
            "words": words_kept or os.path.abspath(args.words),
            "duration": dur, "language": lang,
            "keys": sorted(clip["morphs"]), "missingKeys": missing,
            "gestures": rep["gestures"],
            "beats": [{k: v for k, v in b.items() if k != "keys"} for b in rep["beats"]],
            "phrases": rep["phrases"],
            "known": {"moods": sorted(RD["moods"]), "beats": sorted(RD["recipes"])},
            "play": play, "notes": notes,
        }
        with open(sbase + ".json", "w") as f:
            json.dump(result, f)
        moved = []
        try:
            for name in sorted(os.listdir(stage)):
                dst = os.path.join(outdir, name)
                if os.path.lexists(dst):
                    raise FileExistsError(dst)
                os.rename(os.path.join(stage, name), dst)
                moved.append(dst)
        except OSError as e:
            for dst in moved:
                try:
                    os.remove(dst)
                except OSError:
                    pass
            fail("invalid_out", f"could not write {e.filename or outdir}: {e.strerror or e}. Nothing was written.")
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    print(json.dumps(result))


def _empty_dict(tmp):
    path = os.path.join(tmp, "empty.dict")
    open(path, "w").close()
    return path


if __name__ == "__main__":
    main()
