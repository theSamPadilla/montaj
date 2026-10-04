# speech_text fixture

Real speech for the speech-text tests (PL44). Whisper on synthesized speech gives zero-length words, so this is a human recording. Replaces an earlier excerpt from another item whose 64 kbps hiss measured a -33 dB floor; real talking-head sources measure -52 to -54 dB, so this one is a quiet recording.

## Source

- Item: https://archive.org/details/tom_sawyer_librivox
- File: `TSawyer_01-02_twain.mp3` (VBR MP3, first 2.5 MB, a 30 s window starting at 70 s)
- Text: The Adventures of Tom Sawyer, Mark Twain
- Reader: John Greenman (LibriVox)
- Licence: public domain (LibriVox)
- Built 2026-10-03. Nothing is mixed in; the excerpt is a plain cut. The window opens on the end of the preface and runs into chapter 1.

Noise floors measured on 30 s windows of candidate items (ffmpeg `astats`, overall "Noise floor dB", windows at 20/60/100/140 s of the first file, 16 kHz mono): Tom Sawyer -53.9/-54.5/-51.2/-52.5; Peter Pan -54.6/-60.2/-54.6/-52.4; Adventures of Sherlock Holmes (adventures_holmes) -inf/-49.5/-50.7/-52.7; Secret Garden -51.2/-50.0/-50.2/-51.4; Dracula -50.9/-49.6/-49.3/-48.9; Pride and Prejudice -44.6/-45.0/-40.8/-46.2; Alice in Wonderland -43.5/-45.4/-43.8/-42.5; The Art of War (64 kbps, the superseded excerpt) -33 to -38.

## Files

- `speech.mp4`: 64x64 black video, 30 fps, AAC 64k audio
- `speech.json`: montaj's own `transcribe` output, unchanged (`large-v3-turbo-q5_0`, app whisper-cli)
- `project.json`: timeline over the sidecar. Absolute paths use the placeholder prefix `/FIXTURE`; tests replace it with their `tmp_path` copy of this folder.
- `overlay.jsx`: one-line overlay both overlay items point at

Timeline (source seconds to timeline seconds): clip-1 0.0-10.1 at 0.0 (cropX 0, 0.3, 0 keyed, `ease-in-out`), clip-2 10.7-19.7 at 10.1, clip-3 20.1-30.0 at 18.9 (0.2 s crossfade with clip-2). `st-face` holds one muted video layer linked to clip-2 (same `start - inPoint`, -0.6). Overlays: ov-1 6.6-10.1 (clip-1's last sentence), ov-2 18.0-20.0 (the clip-2/clip-3 join). Bed 0-28.8, line 18.9-20.9. One marker (12.0) and one note (14.0-15.5) inside clip-2. Captions: one segment per line, lines ending at a pause of 0.6 s or more, timeline time, words kept by midpoint.

## Commands

```
ffmpeg -ss 70 -t 30 -i source.wav w70.wav              # source.wav: the mp3 decoded to 16 kHz mono
ffmpeg -f lavfi -i color=black:s=64x64:r=30 -i w70.wav -shortest -c:v libx264 -crf 40 -c:a aac -b:a 64k speech.mp4
python steps/speech/transcribe.py --input tests/fixtures/speech_text/speech.mp4 --model large-v3-turbo-q5_0
ffmpeg -i speech.mp4 -vn -ac 1 -ar 16000 final.wav
ffmpeg -i final.wav -af astats=measure_perchannel=none -f null -        # Noise floor dB: -54.60
ffmpeg -i final.wav -af silencedetect=noise=-39.6dB:d=0.06 -f null -    # floor + 15, inside [-60, -25]
```

## Measured silences (0.06 s or more)

Noise floor -54.60 dB, threshold -39.60 dB. 26 silences; 14 of 0.15 s or more; 14 between 0.15 and 1.2 s. Times are source seconds in `speech.mp4`'s audio.

Silences under about 0.1 s inside a word are consonant closures, not pauses.

| start | end | length |
|---|---|---|
| 2.926 | 2.994 | 0.068 |
| 6.291 | 6.353 | 0.062 |
| 10.061 | 10.705 | 0.645 |
| 11.370 | 11.886 | 0.516 |
| 11.893 | 11.996 | 0.103 |
| 12.592 | 12.972 | 0.380 |
| 13.115 | 13.188 | 0.074 |
| 14.249 | 14.326 | 0.077 |
| 14.568 | 14.844 | 0.276 |
| 14.847 | 15.344 | 0.497 |
| 15.600 | 15.694 | 0.094 |
| 16.761 | 17.825 | 1.064 |
| 18.264 | 18.713 | 0.449 |
| 19.526 | 19.671 | 0.146 |
| 19.674 | 20.173 | 0.500 |
| 20.778 | 20.923 | 0.145 |
| 20.926 | 21.529 | 0.603 |
| 22.267 | 23.073 | 0.806 |
| 24.974 | 25.036 | 0.063 |
| 25.037 | 25.451 | 0.414 |
| 26.317 | 26.973 | 0.656 |
| 27.676 | 27.774 | 0.098 |
| 27.776 | 27.845 | 0.069 |
| 27.845 | 28.137 | 0.292 |
| 28.347 | 28.521 | 0.174 |
| 29.206 | 29.285 | 0.079 |

## Measured limitation

On 2026-10-03 a retake spliced into an earlier excerpt for this fixture (4 shapes, including with `--max-context 0`) was dropped from the transcript by `large-v3-turbo-q5_0`, so the fixture has no retake. Real-footage retakes are checked in T15.
