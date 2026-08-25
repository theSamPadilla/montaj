"""Tests for lib/project_tracks.py — the both-shapes tolerance for
``project["tracks"]``.

The load-bearing properties: normalization never mutates its input, is
idempotent, and returns the SAME OBJECT when the project is already in object
form (the lazy on-open migration reads that identity as "no write needed").
"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.project_tracks import enabled_track_items, normalize_tracks, replace_track_items, track_items


# ── helpers ───────────────────────────────────────────────────────────────────

def item(id_):
    return {"id": id_, "type": "video", "src": f"{id_}.mp4", "start": 0, "end": 1}


def legacy_project():
    return {"id": "p1", "tracks": [[item("a"), item("b")], [item("c")]]}


def object_project():
    return {
        "id": "p1",
        "tracks": [
            {"id": "trk-0", "items": [item("a"), item("b")]},
            {"id": "trk-1", "items": [item("c")]},
        ],
    }


# ── legacy → object ───────────────────────────────────────────────────────────

def test_legacy_shape_becomes_object_shape():
    out = normalize_tracks(legacy_project())
    assert out["tracks"] == [
        {"id": "trk-0", "items": [item("a"), item("b")]},
        {"id": "trk-1", "items": [item("c")]},
    ]


def test_legacy_items_are_carried_by_reference_and_keep_order():
    p = legacy_project()
    out = normalize_tracks(p)
    assert out["tracks"][0]["items"][0] is p["tracks"][0][0]
    assert out["tracks"][0]["items"][1] is p["tracks"][0][1]
    assert out["tracks"][1]["items"][0] is p["tracks"][1][0]
    assert [i["id"] for i in out["tracks"][0]["items"]] == ["a", "b"]


def test_track_order_is_preserved():
    p = {"id": "p1", "tracks": [[item("a")], [item("b")], [item("c")]]}
    out = normalize_tracks(p)
    assert [t["id"] for t in out["tracks"]] == ["trk-0", "trk-1", "trk-2"]
    assert [t["items"][0]["id"] for t in out["tracks"]] == ["a", "b", "c"]


def test_other_project_keys_survive():
    p = legacy_project()
    p["settings"] = {"resolution": [1080, 1920]}
    out = normalize_tracks(p)
    assert out["id"] == "p1"
    assert out["settings"] is p["settings"]


# ── purity ────────────────────────────────────────────────────────────────────

def test_input_is_not_mutated():
    p = legacy_project()
    before = [[dict(i) for i in t] for t in p["tracks"]]
    normalize_tracks(p)
    assert p["tracks"] == before
    assert isinstance(p["tracks"][0], list)  # still legacy shape
    assert "tracks" in p and set(p) == {"id", "tracks"}


def test_item_lists_are_new_containers():
    p = legacy_project()
    out = normalize_tracks(p)
    out["tracks"][0]["items"].append(item("z"))
    assert len(p["tracks"][0]) == 2


# ── identity / idempotency ────────────────────────────────────────────────────

def test_already_normalized_returns_the_same_object():
    p = object_project()
    assert normalize_tracks(p) is p


def test_normalization_is_idempotent():
    p = legacy_project()
    once = normalize_tracks(p)
    twice = normalize_tracks(once)
    assert twice == once
    assert twice is once  # converged — the migration must not rewrite it


# ── absent / empty tracks ─────────────────────────────────────────────────────

def test_missing_tracks_key_returns_same_object_and_invents_nothing():
    p = {"id": "p1"}
    assert normalize_tracks(p) is p
    assert "tracks" not in normalize_tracks(p)


def test_tracks_none_returns_same_object():
    p = {"id": "p1", "tracks": None}
    out = normalize_tracks(p)
    assert out is p
    assert out["tracks"] is None


def test_empty_tracks_list_returns_same_object():
    p = {"id": "p1", "tracks": []}
    assert normalize_tracks(p) is p


# ── hostile input ─────────────────────────────────────────────────────────────

def test_tracks_not_a_list_returns_same_object():
    for bogus in ("nope", 7, {"trk-0": []}):
        p = {"id": "p1", "tracks": bogus}
        assert normalize_tracks(p) is p


def test_non_list_non_dict_track_becomes_an_empty_track():
    p = {"id": "p1", "tracks": [None, "nope", 7]}
    out = normalize_tracks(p)
    assert out["tracks"] == [
        {"id": "trk-0", "items": []},
        {"id": "trk-1", "items": []},
        {"id": "trk-2", "items": []},
    ]


def test_dict_track_missing_items_gets_an_empty_list():
    p = {"id": "p1", "tracks": [{"id": "trk-0"}]}
    assert normalize_tracks(p)["tracks"] == [{"id": "trk-0", "items": []}]


def test_dict_track_with_items_none_or_non_list_gets_an_empty_list():
    p = {"id": "p1", "tracks": [{"id": "a", "items": None}, {"id": "b", "items": "x"}]}
    out = normalize_tracks(p)
    assert out["tracks"] == [{"id": "a", "items": []}, {"id": "b", "items": []}]


def test_dict_track_missing_id_gets_a_generated_one():
    p = {"id": "p1", "tracks": [{"items": [item("a")]}, {"id": "", "items": []},
                                {"id": 7, "items": []}]}
    out = normalize_tracks(p)
    assert [t["id"] for t in out["tracks"]] == ["trk-0", "trk-1", "trk-2"]


def test_duplicate_ids_the_first_holder_keeps_it():
    p = {"id": "p1", "tracks": [{"id": "dup", "items": []}, {"id": "dup", "items": []}]}
    out = normalize_tracks(p)
    assert [t["id"] for t in out["tracks"]] == ["dup", "trk-1"]


def test_explicit_id_colliding_with_a_generated_one_wins_the_name():
    # Track 1 already owns "trk-0", so track 0's generated id steps aside.
    p = {"id": "p1", "tracks": [[item("a")], {"id": "trk-0", "items": [item("b")]}]}
    out = normalize_tracks(p)
    assert [t["id"] for t in out["tracks"]] == ["trk-0-2", "trk-0"]


def test_generated_ids_stay_unique_under_repeated_collision():
    p = {"id": "p1", "tracks": [[], {"id": "trk-0", "items": []},
                                {"id": "trk-0-2", "items": []}]}
    out = normalize_tracks(p)
    ids = [t["id"] for t in out["tracks"]]
    assert ids == ["trk-0-3", "trk-0", "trk-0-2"]
    assert len(set(ids)) == 3


# ── track properties ──────────────────────────────────────────────────────────

def test_track_properties_and_unknown_keys_survive():
    p = {"id": "p1", "tracks": [
        {"id": "trk-0", "items": [], "volume": 0.8, "muted": False, "enabled": True,
         "somethingNew": {"a": 1}},
        [item("a")],  # forces a rebuild so the dict above is copied, not returned as-is
    ]}
    out = normalize_tracks(p)
    assert out["tracks"][0] == {
        "id": "trk-0", "items": [], "volume": 0.8, "muted": False, "enabled": True,
        "somethingNew": {"a": 1},
    }


def test_normalization_adds_no_default_track_properties():
    out = normalize_tracks(legacy_project())
    assert set(out["tracks"][0]) == {"id", "items"}


# ── track_items ───────────────────────────────────────────────────────────────

def test_track_items_on_legacy_shape():
    p = legacy_project()
    assert track_items(p) == [[item("a"), item("b")], [item("c")]]


def test_track_items_on_object_shape():
    p = object_project()
    assert track_items(p) == [[item("a"), item("b")], [item("c")]]
    assert track_items(p)[0] is p["tracks"][0]["items"]


def test_track_items_with_no_tracks():
    assert track_items({"id": "p1"}) == []
    assert track_items({"id": "p1", "tracks": None}) == []
    assert track_items({"id": "p1", "tracks": []}) == []
    assert track_items({"id": "p1", "tracks": "nope"}) == []


def test_track_items_flattens_the_same_either_way():
    legacy = legacy_project()
    obj = normalize_tracks(legacy)

    def flat(p):
        return [i["id"] for t in track_items(p) for i in t]

    assert flat(legacy) == flat(obj) == ["a", "b", "c"]


# ── replace_track_items ───────────────────────────────────────────────────────

def settings_project():
    """Object shape with settings on both tracks, so we can prove they survive."""
    return {
        "id": "p1",
        "tracks": [
            {"id": "primary", "items": [item("a")], "volume": 0.5},
            {"id": "overlay", "items": [item("c")], "volume": 0.8,
             "muted": False, "enabled": True},
        ],
    }


def test_replace_track_items_replaces_the_named_track():
    p = settings_project()
    out = replace_track_items(p, 0, [item("x"), item("y")])
    assert [i["id"] for i in out[0]["items"]] == ["x", "y"]
    assert [i["id"] for i in out[1]["items"]] == ["c"]


def test_replace_track_items_preserves_other_tracks_settings_and_ids():
    p = settings_project()
    out = replace_track_items(p, 0, [])
    assert out[1] == {
        "id": "overlay", "items": [item("c")], "volume": 0.8,
        "muted": False, "enabled": True,
    }


def test_replace_track_items_preserves_the_target_tracks_own_settings_and_id():
    p = settings_project()
    out = replace_track_items(p, 0, [item("x")])
    assert out[0] == {"id": "primary", "items": [item("x")], "volume": 0.5}


def test_replace_track_items_grows_past_the_end():
    p = {"id": "p1", "tracks": [[item("a")]]}
    out = replace_track_items(p, 2, [item("z")])
    assert [t["id"] for t in out] == ["trk-0", "trk-1", "trk-2"]
    assert out[1]["items"] == []
    assert out[2]["items"] == [item("z")]


def test_replace_track_items_on_a_project_with_no_tracks():
    out = replace_track_items({"id": "p1"}, 0, [item("a")])
    assert out == [{"id": "trk-0", "items": [item("a")]}]


def test_replace_track_items_accepts_the_legacy_shape():
    p = legacy_project()
    out = replace_track_items(p, 0, [item("x")])
    assert out == [
        {"id": "trk-0", "items": [item("x")]},
        {"id": "trk-1", "items": [item("c")]},
    ]


def test_replace_track_items_does_not_mutate_the_input():
    p = settings_project()
    before = json.loads(json.dumps(p))
    replace_track_items(p, 0, [item("x")])
    assert p == before
    # the returned track dicts are copies, not the project's own
    out = replace_track_items(p, 0, [item("x")])
    assert out[1] is not p["tracks"][1]
    out[1]["muted"] = True
    assert p["tracks"][1]["muted"] is False


def test_replace_track_items_copies_the_items_list():
    p = settings_project()
    items = [item("x")]
    out = replace_track_items(p, 0, items)
    assert out[0]["items"] == items
    assert out[0]["items"] is not items
    # …but shares the item dicts, so in-place item edits still land
    assert out[0]["items"][0] is items[0]


# ── enabled_track_items ──────────────────────────────────────────────────────
# The accessor for anything that PRODUCES output, as opposed to anything that
# EDITS. `track_items` (every track) stays the editing view.

def test_enabled_track_items_empties_disabled_tracks_in_place():
    project = {
        "tracks": [
            {"id": "t0", "items": [{"id": "a"}]},
            {"id": "t1", "items": [{"id": "b"}], "enabled": False},
            {"id": "t2", "items": [{"id": "c"}], "enabled": True},
        ]
    }
    assert [[i["id"] for i in t] for t in enabled_track_items(project)] == [["a"], [], ["c"]]
    assert len(track_items(project)) == 3, "the editing view still sees every track"


def test_enabled_track_items_does_not_renumber_when_track_zero_is_skipped():
    # A map, not a filter: every consumer indexes this list positionally
    # (index 0 = base footage track, the rest = overlay tracks). Filtering a
    # skipped track OUT would promote t1 into slot 0 and drop t2 from the
    # overlay set entirely.
    project = {
        "tracks": [
            {"id": "t0", "items": [{"id": "base"}], "enabled": False},
            {"id": "t1", "items": [{"id": "o1"}]},
            {"id": "t2", "items": [{"id": "o2"}]},
        ]
    }
    out = enabled_track_items(project)
    assert [[i["id"] for i in t] for t in out] == [[], ["o1"], ["o2"]]
    assert [[i["id"] for i in t] for t in out[1:]] == [["o1"], ["o2"]]


def test_enabled_track_items_absent_flag_means_enabled():
    # Nothing writes the field in, so every pre-existing project relies on this.
    assert len(enabled_track_items({"tracks": [{"id": "t0", "items": [{"id": "a"}]}]})) == 1


def test_enabled_track_items_accepts_legacy_shape():
    assert len(enabled_track_items({"tracks": [[{"id": "a"}], [{"id": "b"}]]})) == 2


def test_enabled_track_items_shares_items_by_reference():
    item = {"id": "a", "src": "rel.mp4"}
    out = enabled_track_items({"tracks": [{"id": "t0", "items": [item]}]})
    assert out[0][0] is item


def test_enabled_track_items_tolerates_malformed_input():
    for bad in ({}, {"tracks": None}, {"tracks": "nope"}, {"tracks": 42}):
        assert enabled_track_items(bad) == []
