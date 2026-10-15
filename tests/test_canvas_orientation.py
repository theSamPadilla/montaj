"""lib.canvas.canvas_for_footage with follow_orientation: a canvas whose aspect nobody chose turns
portrait or landscape to match the footage, then keeps that aspect at the footage's short side."""
from lib.canvas import canvas_for_footage


def test_without_follow_the_canvas_keeps_its_orientation():
    assert canvas_for_footage([1920, 1080], [2160, 3840]) == [3840, 2160]


def test_follow_turns_a_landscape_canvas_for_portrait_footage():
    assert canvas_for_footage([1920, 1080], [2160, 3840], follow_orientation=True) == [2160, 3840]


def test_follow_turns_a_portrait_canvas_for_landscape_footage():
    assert canvas_for_footage([1080, 1920], [3840, 2160], follow_orientation=True) == [3840, 2160]


def test_follow_keeps_the_canvas_aspect_after_turning():
    # 3:4 portrait footage on a default 16:9: the canvas turns to 9:16 at the footage's short side.
    assert canvas_for_footage([1920, 1080], [1080, 1440], follow_orientation=True) == [1080, 1920]


def test_follow_leaves_a_same_orientation_canvas_alone():
    assert canvas_for_footage([1920, 1080], [1440, 1080], follow_orientation=True) == [1920, 1080]


def test_square_footage_or_canvas_has_no_orientation_to_follow():
    assert canvas_for_footage([1920, 1080], [1080, 1080], follow_orientation=True) == [1920, 1080]
    assert canvas_for_footage([1080, 1080], [1080, 1920], follow_orientation=True) == [1080, 1080]
