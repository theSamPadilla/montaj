"""render.js gets a heap sized to the machine, and a fatal V8 error's native stack does not push its reason out of the
log tail (GPS, 2026-11-13: out of heap at Node's 4 GB on a 36 GB Mac, and the tail held only native frames)."""
from serve.routes.projects import _fold_native_frames, _render_heap_args

GB = 1 << 30


def test_heap_is_a_quarter_of_memory_within_4_to_16_gb():
    assert _render_heap_args(36 * GB) == ["--max-old-space-size=9216"]
    assert _render_heap_args(8 * GB) == ["--max-old-space-size=4096"]
    assert _render_heap_args(128 * GB) == ["--max-old-space-size=16384"]


def test_unknown_memory_leaves_node_s_default():
    assert _render_heap_args(None) == []
    assert _render_heap_args(0) == []


def test_native_frames_fold_and_the_fatal_line_survives_the_tail():
    lines = ["[montaj render] measuring loudness...", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
             "----- Native stack trace -----", ""]
    lines += [f"{n}: 0x1045bbb48 v8::internal::Frame{n}(int) [/Applications/Montaj.app/node]" for n in range(1, 50)]
    folded = _fold_native_frames(lines)
    assert folded == lines[:4] + ["[49 native stack frames]"]
    assert any("heap out of memory" in line for line in folded[-40:])


def test_a_single_frame_and_ordinary_lines_with_numbers_are_kept_apart():
    assert _fold_native_frames(["1: 0xabc f", "segment 1: 0 frames", "2: 0xdef g"]) == [
        "[1 native stack frame]", "segment 1: 0 frames", "[1 native stack frame]"]
