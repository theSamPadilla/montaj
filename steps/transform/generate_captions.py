#!/usr/bin/env python3
"""Generate a project's caption track server-side, writing project["captions"].

CLI-subprocess equivalent of the /projects/{id}/captions SSE route. Given a
project id, it derives the timeline's AUDIBLE MIX — every unmuted video item on
every enabled visual track plus every unmuted audio track, each at its own
timeline position — then runs the full pipeline as subprocesses:

  1. mix_timeline    — sum the audible timeline into one 16 kHz mono WAV whose
                       time IS timeline time (gaps stay silent).
  2. transcribe      — multilingual, output-time word timings (plain audio in,
                       NOT a trim spec, so timestamps are project-time).
  3. caption         — group words into styled caption segments.

It then finishes the new track exactly as the SSE route does
(lib/caption_translation.py: every prior theme key carried forward, segment
ids minted, translated rows kept and re-cut), writes project.json, cleans up
temp files, and prints the track JSON as the step result.

Async driving (montaj_step async:true + montaj_step_status) is handled
generically by the serve route — this step is a plain CLI subprocess.
"""
import argparse
import json
import os
import sys

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
MONTAJ_ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))

sys.path.insert(0, os.path.join(MONTAJ_ROOT, "lib"))
from common import fail, run, require_whisper_model, DEFAULT_WHISPER_MODEL, WHISPER_MODEL_CHOICES, whisper_runaway_timeout_for  # noqa: E402
from caption_translation import finish_regenerated_track, merge_caption_theme as _merge_theme, record_source_language  # noqa: E402

sys.path.insert(0, MONTAJ_ROOT)
from serve.common import get_project_dir  # noqa: E402
from serve.caption_job import build_audio_mix_spec, caption_input_change, caption_input_fingerprint  # noqa: E402
from lib.project_revisions import engine_guard_enabled  # noqa: E402
from lib import caption_ink  # noqa: E402
from lib.caption_script import script_of, spell_from_script  # noqa: E402
from lib.caption_words import timeline_words, write_transcript  # noqa: E402
from lib.caption_marks import keep_persons, stamp_all, stamped  # noqa: E402
from lib.project_versions import commit_version  # noqa: E402
from lib.caption_profile_look import caption_words_args, resolve_style_and_look  # noqa: E402
from serve.caption_theme import seed_prev  # noqa: E402
from lib.project_lock import ProjectLockTimeout, ProjectReadOnly, update_project  # noqa: E402
from lib.sync_clash import SyncBusy, SyncConflict, exit_refused  # noqa: E402

# The whisper run before this write took minutes: a short lock wait must not throw it away.
STEP_LOCK_TIMEOUT = 30.0
VERSION_MESSAGE = "version: before captions"   # the captions step's, so both read alike in the history


def resolve_style(args_style, project: dict) -> str:
    """style = explicit arg, else prior captions.style, else the profile's captionStyle, else 'pop'.

    Mirrors the SSE route's (lib/caption_profile_look.resolve_style_and_look).
    """
    return resolve_style_and_look(args_style, project)[0]


def merge_caption_theme(track: dict, prev) -> dict:
    """Carry forward every prior caption-track key except `style` and
    `segments` into a fresh one. Mutates and returns `track`; a key already on
    `track` wins. The SSE route's merge (it used to be five keys here, so a
    font, weight or per-style colour was lost on this path only).
    """
    return _merge_theme(prev, track)


def ink_pass(project_path) -> list:
    """Run the caption_ink pass on the project just written (a no-op, with no render, when it has no card on screen
    anywhere). A failure is a warning for the answer, never a failed caption run."""
    try:
        out = caption_ink.update(project_path)
    except Exception as e:  # noqa: BLE001 — the captions are written; ink is a refinement
        return [f"caption ink not set ({type(e).__name__}): run caption_ink"]
    return list((out or {}).get("warnings") or [])


def main():
    parser = argparse.ArgumentParser(
        description="Generate a project's caption track from its audible timeline mix"
    )
    parser.add_argument("--project-id", required=True, help="Project id")
    parser.add_argument("--model", default=DEFAULT_WHISPER_MODEL, choices=list(WHISPER_MODEL_CHOICES),
                        help="Whisper model")
    parser.add_argument("--language", default="auto",
                        help="Language code (e.g. en, es), or 'auto' to detect")
    parser.add_argument("--style", default=None, help="Caption animation style")
    parser.add_argument("--replace-edited", action="store_true",
                        help="Replace the lines a person made or edited too (only when they ask)")
    parser.add_argument("--script", default=None,
                        help="The script the speaker read (default: the project's editingPrompt; \"\" for none): caption "
                             "words take its spelling on the transcript's timings")
    args = parser.parse_args()

    # Resolve the project dir. The step is a CLI subprocess, not an HTTP
    # handler, so convert the route's HTTPException(404) into a structured fail.
    try:
        project_dir = get_project_dir(args.project_id)
    except Exception as e:
        if e.__class__.__name__ == "HTTPException":
            fail("project_not_found", f"Project '{args.project_id}' not found")
        raise

    project_path = os.path.join(str(project_dir), "project.json")
    try:
        with open(project_path, encoding="utf-8") as f:
            project = json.load(f)
    except Exception:
        fail("project_not_found", f"project.json for {args.project_id} not found")
    # What the result depends on, as read now (§477): compared under the lock before the
    # write, so an audio or caption-text edit made while whisper ran is not overwritten.
    fingerprint = caption_input_fingerprint(project) if engine_guard_enabled() else None

    # Before mixing: no weight fails as whisper_model_missing here, rather than
    # surfacing later inside transcribe's unexpected_error.
    require_whisper_model(args.model, args.language)

    try:
        mix_spec = build_audio_mix_spec(project)
    except ValueError as e:
        fail("no_audible_timeline", str(e))

    # The profile's caption look (font, emphasis colour) for a new track, as the editor seeds it.
    style, look = resolve_style_and_look(args.style, project)

    mix_timeline_py = os.path.join(MONTAJ_ROOT, "steps", "audio", "mix_timeline.py")
    transcribe_py = os.path.join(MONTAJ_ROOT, "steps", "speech", "transcribe.py")
    caption_py = os.path.join(MONTAJ_ROOT, "steps", "lyrics", "caption.py")

    d = str(project_dir)
    mix_spec_path = os.path.join(d, "_caption_mix.json")
    mix_wav_path = os.path.join(d, "_caption_mix.wav")
    words_prefix = os.path.join(d, "_caption_words")
    words_json_path = os.path.join(d, "_caption_words.json")
    words_srt_path = os.path.join(d, "_caption_words.srt")
    track_path = os.path.join(d, "_caption_track.json")

    try:
        # Run 5: the words are each audible clip's and voiceover's own transcript, mapped through the timeline
        # (lib/caption_words): the ones the cut was made on. The mix is transcribed only when one has none.
        from_sources = timeline_words(project, d)
        if from_sources is not None:
            write_transcript(from_sources, words_json_path)
        else:
            # 1. Write the mix spec.
            with open(mix_spec_path, "w") as f:
                json.dump(mix_spec, f)

            # 2. Mix the audible timeline into one WAV, in timeline time.
            run([sys.executable, mix_timeline_py,
                 "--input", mix_spec_path, "--out", mix_wav_path])

            # 3. Transcribe the mix as plain audio so word timings are
            #    output/project-time (NOT a trim spec). By voiced runs, so the words sit on the voice; never
            #    --fit-pauses, whose pauses found on a mix squeezed run 5's words early.
            #    Outlasts transcribe's own whisper runaway guard, so a stuck
            #    whisper surfaces as its structured transcription_timeout rather
            #    than this wrapper's bare TimeoutExpired.
            run([sys.executable, transcribe_py,
                 "--input", mix_wav_path,
                 "--model", args.model, "--language", args.language,
                 "--out", words_prefix],
                timeout=whisper_runaway_timeout_for(mix_wav_path) + 300)

        # 3b. Spell the words from the script, when one is given (lib/caption_script.py): timings stay the transcript's.
        script = args.script if args.script is not None else script_of(project)
        corrected = spell_from_script(words_json_path, script) if script and script.strip() else None

        # 4. Group words into a styled caption track.
        run([sys.executable, caption_py,
             "--input", words_json_path, "--style", style, "--out", track_path, *caption_words_args(project)])

        # 5. Load the track, finish it like the SSE route (theme, ids, kept
        #    translations), persist onto project.
        with open(track_path, encoding="utf-8") as f:
            track = json.load(f)
        # Re-read the project UNDER the project lock and set only `captions`:
        # the AI or the editor may have saved it while whisper ran (a
        # translation, any edit), and writing back the copy read at the start
        # would undo that.
        written = {}

        # A track made before stamps cannot be judged line by line (§585): save a version first, so a person's
        # earlier edits can be got back, and say so in the answer.
        prior = list((project.get("captions") or {}).get("segments") or [])
        lines = [s for s in prior if isinstance(s, dict) and not (isinstance(s.get("lang"), str) and isinstance(s.get("translationOf"), list))]
        unguarded = bool(lines) and not stamped(lines) and not args.replace_edited
        if unguarded:
            commit_version(d, VERSION_MESSAGE)

        def apply(fresh):
            if fingerprint is not None:
                change = caption_input_change(fingerprint, fresh)
                if change is not None:
                    fail("project_changed", change["message"])
            prev_lines = list((fresh.get("captions") or {}).get("segments") or [])
            done = finish_regenerated_track(seed_prev(fresh.get("captions") or {}, look), dict(track))
            stamp_all(done.get("segments") or [])   # every line this run writes is the AI's (§585)
            if not args.replace_edited:
                # A line the person made or edited is theirs: it stays, and the new lines go around it.
                done["segments"], kept = keep_persons(prev_lines, done.get("segments") or [])
                written["kept"] = [{"id": k.get("id"), "text": k.get("text")} for k in kept]
            record_source_language(done, args.language, words_json_path)
            fresh["captions"] = done
            written["track"] = done
            return fresh

        try:
            update_project(project_path, apply, timeout=STEP_LOCK_TIMEOUT)
        except ProjectLockTimeout as e:
            fail("project_locked", str(e))
        except ProjectReadOnly as e:
            fail("project_read_only", str(e))
        except (SyncConflict, SyncBusy) as e:   # §482: captions in an open Studio sync clash
            exit_refused(e.body)
        except (OSError, ValueError):
            fail("project_not_found", f"project.json for {args.project_id} not readable")
        track = written["track"]
        warnings = ink_pass(project_path)

        answer = dict(track)
        if corrected is not None:
            answer["corrected"] = corrected
        if written.get("kept"):
            answer["keptYours"] = written["kept"]
        if unguarded:
            answer["unguarded"] = True
        if warnings:
            answer["warnings"] = warnings
        print(json.dumps(answer))
    finally:
        for tmp in (mix_spec_path, mix_wav_path, words_json_path,
                    words_srt_path, track_path):
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass


if __name__ == "__main__":
    main()
