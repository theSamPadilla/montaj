Fixture audio for tests/test_talk_*.py.

- arctic_a0023.wav: CMU ARCTIC (awb/bdl family), utterance a0023, unmodified. Licence: ARCTIC-COPYING. Words: whisper.cpp word offsets, text and offsets only.
- pt_excerpt.wav: the first 3.3 s of a LibriVox reading in Portuguese (public domain), 16 kHz mono, otherwise unmodified. Words cropped to match.
- golden_clips.json, golden_reports.json: output of the 3D26 spike's face.build (non-legacy) on the above, with moods.json. expressive 0, 1, 2 for English, 1 for Portuguese.

- tiny-head.glb, tiny-head/ (model.json, meshes/): a synthetic two-primitive head, six vertices each, with jawOpen and browInnerUp morph targets (made with tests/test_talk_reach.py make_glb, plus a scene entry the importer needs). tiny-head/ is that GLB through the Montaj app's own importer (library/model3d/import.js gltfToModel, units "file" so the model stays in metres), written as the app saves it: model.json plus meshes/<id>.json. Made with montaj-app commit 402bfd157902198620549a9a1a90caa6dfd602d8, three 0.160.0. No real head is committed.
