"""libx265's worker pool lowers the whole ffmpeg process to nice 19, so every
libx265 encode asks for pools=none with frame threads instead."""
import re
import lib.normalize as nm


def test_hevc_specs_carry_pools_none_and_frame_threads():
    for key in ("hdr_hlg", "hdr_pq"):
        args = nm._encoder_args(nm.SPECS[key], threads=6)
        params = args[args.index("-x265-params") + 1]
        assert params.endswith(":pools=none:frame-threads=6")
        # the colour params the schema carries are untouched, in front
        assert params.startswith(nm.SPECS[key]["encoder_params"]["x265-params"])


def test_sdr_libx264_spec_is_unchanged():
    spec = nm.SPECS["sdr_bt709"]
    args = nm._encoder_args(spec)
    assert "-x265-params" not in args
    assert args == [a for k, v in spec["encoder_params"].items() for a in (f"-{k}", v)]


def test_default_thread_count_is_capped_at_eight():
    assert 1 <= nm.X265_THREADS <= 8


def test_normalize_command_uses_it():
    src = open(nm.__file__).read()
    assert re.search(r'enc_args = \["-c:v", spec\["encoder"\], \*_encoder_args\(spec\)\]', src)
