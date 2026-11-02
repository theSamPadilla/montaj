import pytest

from lib import scene_time as st


def test_no_map_is_in_point_plus_item_time():
    assert st.scene_at({"inPoint": 2.0}, 1.5) == 3.5
    assert st.scene_at({}, 1.5) == 1.5


def test_a_map_jumps_over_the_removed_seconds():
    props = {"inPoint": 0, "timeMap": [[0, 0, 1.04], [1.04, 1.76, 1.3]]}
    assert st.scene_at(props, 0.5) == pytest.approx(0.5)
    assert st.scene_at(props, 1.04) == pytest.approx(1.76)
    assert st.scene_at(props, 2.0) == pytest.approx(2.72)


def test_a_malformed_map_is_ignored():
    for bad in ([], [[0, 0]], [[1, 0, 1]], [[0, 0, 1], [0.5, 2, 1]], [[0, 0, 0]], "x"):
        assert st.time_map({"timeMap": bad}) is None


def test_pieces_between_splits_at_a_jump_and_follows_an_old_map():
    props = {"timeMap": [[0, 0, 1.0], [1.0, 3.0, 2.0]]}
    assert st.pieces_between(props, 0.5, 1.5) == [(0.5, 1.0, 0.0), (3.0, 3.5, 0.5)]
    assert st.pieces_between({"inPoint": 2}, 1, 2) == [(3, 4, 0.0)]


def test_pieces_of_joins_runs_that_play_on():
    got = st.pieces_of([[0, 1, 0], [1, 2, 1], [5, 6, 2]])
    assert got == [[0, 0, 2.0], [2, 5, 1.0]] or got == [[0.0, 0.0, 2.0], [2.0, 5.0, 1.0]]


def test_item_at_is_the_inverse_and_skips_removed_seconds():
    props = {"inPoint": 0, "timeMap": [[0, 0, 1.0], [1.0, 3.0, 2.0]]}
    assert st.item_at(props, 0.5) == pytest.approx(0.5)
    assert st.item_at(props, 4.0) == pytest.approx(2.0)
    assert st.item_at(props, 2.0) == pytest.approx(1.0)      # removed: where the next piece starts
    assert st.item_at(props, 9.0) is None
    assert st.item_at({"inPoint": 2}, 3.5) == pytest.approx(1.5)
