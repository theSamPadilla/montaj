# Tripo fixtures: captured, not written

Captured on 2026-10-18 from one real run of `generate_model`, `rig_model` and
`animate_model` against Tripo's v3 API (openapi.tripo3d.ai), on a paid key, so
the outputs are the key holder's under Tripo's terms (section 5.2.2). The run
cost 95 credits: an image-to-model prop (30), a text-to-model character (20), a
free rig check, a biped rig with Mixamo names (25) and two preset animations in
place (`preset:biped:walk`, `preset:biped:wave_goodbye_01`, 20).

## `captures/`

One file per API call, written by `connectors/tripo.py`'s capture
(`MONTAJ_TRIPO_CAPTURE`): `{source, method, path, status, captured, request?,
response}`. `source` is the capture's own file name. One call of each kind and
state was kept (the run polled every 5 s). Not in these files:

- headers (the key);
- every URL's query string (a signed download's signature): `?<query removed>`;
- the value of any field named like a key or token (`file_token`, the storage
  `object.key`): `<redacted>`;
- the account's upload ids (`file_<redacted>`, sent as `input`) and its storage
  folder in download paths (`tcli_<redacted>`);
- `request_id` (`<redacted>`), removed by hand after the capture.

Everything else is as Tripo sent it, task ids included. The first balance and
the 403 (`code 2010`, insufficient credit) are from the same key before it was
topped up.

## The two GLBs

- `prop-image-to-model.glb`: image-to-model from a Montaj render of a CC0 crate,
  `face_limit` 5,000 (4,631 vertices, 4,023 triangles, no skin).
- `character-rigged-animated.glb`: text-to-model (`face_limit` 10,000), rigged
  (v1.0-20240301, `spec: mixamo`) and animated in place: 23 joints (Root and 22
  `mixamorig:` bones), 5,971 vertices, clips `walk` (2.37 s) and
  `wave_goodbye_01` (6.6 s; a seated wave in Tripo's own file).

Tripo ships each with three 2048x2048 textures (base colour and ORM as JPEG,
normal as PNG). To keep the repository small, every texture here is
downscaled to 256x256 in its own format (Pillow, LANCZOS; JPEG quality 85),
the BIN chunk repacked (`lib/glb_textures.py` `_repack`) and the JSON chunk
re-serialized. Geometry, skins, joints, rest poses and animations are byte for
byte as captured.
