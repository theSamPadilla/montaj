"""The random part of a minted timeline id (§482).

Two copies of one project, edited apart on two machines and merged by item id, must never mint
one id for two different things: the merge would read them as one item changed on both sides. An
id built only from the document (an index, a max+1, a counter) comes out the same on both
machines, so an id minted for a NEW track item or a NEW track carries this random part after its
readable stem (``clip-3-<hex>``, ``clip-3-seg-1-<hex>``, ``trk-<hex>``).

An existing id is never rewritten: only a mint takes a suffix. Mirrored by ``idSuffix`` in
``montaj_assets/editor/src/video/timeline/timeline-model.ts``.
"""
import secrets


def id_suffix() -> str:
    """Six lower-case hex characters."""
    return secrets.token_hex(3)
