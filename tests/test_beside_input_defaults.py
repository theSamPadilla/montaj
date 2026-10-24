"""Every BESIDE_INPUT_STEPS member's DEFAULT output (what it writes when `out`/`out-dir` is omitted) is
safe to drop beside the input.

This is the premise the beside-input out-guard rests on (`serve/out_guard._check_beside_input`): because a
beside-input step chooses its own sidecar name and suffix — the caller never names the output — the guard only
has to keep that sidecar out of code/config locations (a DENY check), not confine it to the workspace. For that
premise to hold, every such default must:

  (a) never be the input path itself (never an in-place overwrite), and
  (b) have a safe, non-empty extension — never extension-less, never an executable or config suffix.

The DEFAULTS table below is the inventory, derived by reading each step's `out`-is-omitted branch (source line
cited per row). If a future step's default became in-place, extension-less or a dangerous suffix, OR a step was
added to BESIDE_INPUT_STEPS without an inventory row, this test fails — and that step must take an allowed `out`
(refuse when omitted) rather than ship beside-input.
"""
import os
from pathlib import PurePosixPath

import serve.out_guard as guard

# Suffixes a beside-input default may never have: an executable or a config/code file that a later `serve`,
# node or shell run could pick up. A bare dotfile (no extension) is dangerous too and is caught by the
# "non-empty extension" check.
DANGEROUS_SUFFIXES = {
    ".sh", ".command", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".py",
    ".plist", ".app", ".dylib", ".so",
}

# step -> (representative input basename, [default outputs]).
# Each output is (basename, kind, content_suffixes). kind is "file" or "dir"; content_suffixes lists the
# suffixes of the files a "dir" output holds (checked the same way), and is () for a "file".
DEFAULTS = {
    # steps/audio/extract_audio.py:17  out = f"{splitext(input)[0]}.{format}"  (format default "wav")
    "extract_audio": ("clip.mp4", [("clip.wav", "file", ())]),
    # steps/media/normalize.py:98-99  out = f"{splitext(input)[0]}_normalized{ext}"
    "normalize": ("clip.mp4", [("clip_normalized.mp4", "file", ())]),
    # steps/transform/resize.py:23-24  out = f"{splitext(input)[0]}_{ratio.replace(':','x')}{ext}"
    "resize": ("clip.mp4", [("clip_9x16.mp4", "file", ())]),
    # steps/media/snapshot.py:125 (grid), :88 (--frames all dir), :64 (--at)
    "snapshot": ("clip.mp4", [
        ("clip_snapshot.jpg", "file", ()),
        ("clip_frames", "dir", (".jpg",)),
        ("clip_at_1.50.jpg", "file", ()),
    ]),
    # steps/audio/waveform_image.py:22-23  <dir>/<stem>_waveforms/ of chunk_NN.png
    "waveform_image": ("clip.mp4", [("clip_waveforms", "dir", (".png",))]),
    # steps/lyrics/caption.py:23  out = f"{splitext(input)[0]}_captions.json"  (input is a transcript JSON)
    "caption": ("clip.json", [("clip_captions.json", "file", ())]),
    # steps/lyrics/lyrics_render.py:407-408  default is beside --captions: <captions_stem>_render.mp4
    "lyrics_render": ("captions.json", [("captions_render.mp4", "file", ())]),
    # steps/transform/crop_spec.py:108-111  <dir(input)>/<stem>_cropped.json
    "crop_spec": ("cut.json", [("cut_cropped.json", "file", ())]),
    # steps/media/paper_cutout.py:263-265  <stem>_paper.png (enforced .png)
    "paper_cutout": ("photo.png", [("photo_paper.png", "file", ())]),
    # steps/transform/remove_bg.py:444 (<stem>_nobg.mov), :333-334 (<mov_stem>_preview.webm)
    "remove_bg": ("clip.mp4", [
        ("clip_nobg.mov", "file", ()),
        ("clip_nobg_preview.webm", "file", ()),
    ]),
    # steps/audio/mix_timeline.py:229-230  <spec_stem>_mix.wav (beside the mix-spec input)
    "mix_timeline": ("mix.json", [("mix_mix.wav", "file", ())]),
    # steps/transform/materialize_cut.py:40-41,287-288  <ref_src_stem>_cut.mp4 (or _cut.wav with --audio)
    "materialize_cut": ("clip.mp4", [
        ("clip_cut.mp4", "file", ()),
        ("clip_cut.wav", "file", ()),
    ]),
    # steps/speech/transcribe.py:93,114,145  <input_stem>.json and <input_stem>.srt
    "transcribe": ("clip.mp4", [("clip.json", "file", ()), ("clip.srt", "file", ())]),
}


def test_the_inventory_covers_exactly_the_guarded_steps():
    """Every BESIDE_INPUT_STEPS member has an inventory row, and no stale rows. A new beside-input step with no
    row here fails until its default is inventoried and proven safe."""
    assert set(DEFAULTS) == set(guard.BESIDE_INPUT_STEPS)


def _is_safe_suffix(name: str) -> bool:
    ext = PurePosixPath(name).suffix
    return ext != "" and ext.lower() not in DANGEROUS_SUFFIXES


def test_no_default_output_overwrites_its_input_in_place():
    """(a) A step's default output is never the input path itself."""
    for step, (input_name, outputs) in DEFAULTS.items():
        in_path = os.path.join("/some/folder", input_name)
        for out_name, _kind, _contents in outputs:
            out_path = os.path.join("/some/folder", out_name)
            assert out_path != in_path, f"{step}: default output {out_name} overwrites its input in place"


def test_every_default_output_has_a_safe_non_executable_suffix():
    """(b) A file default has a safe, non-empty extension; a folder default is not an `.app`-style bundle and
    the files it holds are safe too."""
    for step, (_input_name, outputs) in DEFAULTS.items():
        for out_name, kind, contents in outputs:
            if kind == "file":
                assert _is_safe_suffix(out_name), f"{step}: unsafe default output suffix: {out_name}"
            else:  # a folder of outputs beside the input
                # The folder itself must not be a dangerous bundle (e.g. foo.app), and may be extension-less.
                ext = PurePosixPath(out_name).suffix.lower()
                assert ext not in DANGEROUS_SUFFIXES, f"{step}: unsafe default output folder: {out_name}"
                assert contents, f"{step}: folder default {out_name} declares no content suffixes to check"
                for suffix in contents:
                    probe = f"item{suffix}"
                    assert _is_safe_suffix(probe), f"{step}: unsafe file in default folder {out_name}: {suffix}"
