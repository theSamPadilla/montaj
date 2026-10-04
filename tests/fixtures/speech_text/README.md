# speech_text fixture

Real speech for the speech-text tests (PL44). Whisper on synthesized speech gives zero-length words, so this is a human recording.

## Source

- Item: https://archive.org/details/art_of_war_librivox
- File: `art_of_war_01-02_sun_tzu_64kb.mp3` (first 1.5 MB, a 30 s window starting at 100 s)
- Text: The Art of War, Sun Tzu, translated by Lionel Giles
- Reader: Moira Fogarty (LibriVox)
- Licence: public domain (LibriVox)
- Built 2026-10-03. Nothing is mixed in; the excerpt is a plain cut.

## Files

- `speech.mp4`: 64x64 black video, 30 fps, AAC 64k mono-from-16k audio
- `speech.json`: montaj's own `transcribe` output, unchanged (`large-v3-turbo-q5_0`, app whisper-cli)
- `project.json`: timeline over the sidecar. Absolute paths use the placeholder prefix `/FIXTURE`; tests replace it with their `tmp_path` copy of this folder.
- `overlay.jsx`: one-line overlay both overlay items point at

Timeline (source seconds to timeline seconds): clip-1 1.1-15.2 at 0.0 (cropX 0, 0.3, 0 keyed, `ease-in-out`), clip-2 16.0-24.8 at 14.1, clip-3 25.6-30.0 at 22.7 (0.2 s crossfade with clip-2). `st-face` holds one muted video layer linked to clip-2 (same `start - inPoint`, -1.9). Overlays: ov-1 10.0-14.0 (clip-1's last sentence), ov-2 22.0-24.0 (the clip-2/clip-3 join). Bed 0-27.1, line 22.7-24.7. One marker (16.0) and one note (18.0-19.5) inside clip-2. Captions: one segment per line, lines ending at a pause of 0.6 s or more, timeline time, words kept by midpoint.

## Commands

```
ffmpeg -ss 100 -t 30 -i source.wav w100.wav            # source.wav: mp3 decoded to 16 kHz mono
ffmpeg -f lavfi -i color=black:s=64x64:r=30 -i w100.wav -shortest -c:v libx264 -crf 40 -c:a aac -b:a 64k speech.mp4
python steps/speech/transcribe.py --input tests/fixtures/speech_text/speech.mp4 --model large-v3-turbo-q5_0
ffmpeg -i speech.mp4 -vn -ac 1 -ar 16000 final.wav
ffmpeg -i final.wav -af astats=measure_perchannel=none -f null -        # Noise floor dB: -33.26
ffmpeg -i final.wav -af silencedetect=noise=-25dB:d=0.06 -f null -      # floor + 15 = -18.3, clamped to -25
```

## Measured silences (0.06 s or more)

45 silences; 16 of 0.15 s or more; 16 between 0.15 and 1.2 s. Times are source seconds in `speech.mp4`'s audio.

| start | end | length |
|---|---|---|
| 0.000 | 0.500 | 0.500 |
| 0.500 | 1.091 | 0.591 |
| 1.934 | 2.069 | 0.135 |
| 2.244 | 2.316 | 0.072 |
| 4.667 | 4.735 | 0.068 |
| 4.750 | 4.841 | 0.091 |
| 4.999 | 5.093 | 0.094 |
| 5.438 | 5.498 | 0.060 |
| 5.909 | 5.983 | 0.074 |
| 6.039 | 6.726 | 0.687 |
| 8.488 | 8.579 | 0.091 |
| 8.951 | 9.564 | 0.613 |
| 10.777 | 10.842 | 0.065 |
| 10.845 | 11.157 | 0.312 |
| 11.392 | 11.467 | 0.074 |
| 11.599 | 11.660 | 0.061 |
| 12.353 | 12.413 | 0.061 |
| 12.827 | 13.218 | 0.390 |
| 13.376 | 13.438 | 0.062 |
| 14.558 | 14.630 | 0.072 |
| 14.681 | 14.758 | 0.076 |
| 14.938 | 15.001 | 0.063 |
| 15.180 | 15.982 | 0.802 |
| 15.982 | 16.363 | 0.380 |
| 16.656 | 16.751 | 0.096 |
| 17.499 | 17.563 | 0.064 |
| 17.630 | 17.746 | 0.116 |
| 18.979 | 19.338 | 0.359 |
| 19.338 | 19.713 | 0.375 |
| 20.227 | 20.312 | 0.085 |
| 20.468 | 20.650 | 0.182 |
| 20.996 | 21.097 | 0.101 |
| 21.122 | 21.184 | 0.061 |
| 21.462 | 21.537 | 0.075 |
| 21.642 | 22.153 | 0.511 |
| 22.742 | 22.811 | 0.069 |
| 23.167 | 23.254 | 0.086 |
| 23.258 | 23.516 | 0.259 |
| 23.668 | 23.751 | 0.083 |
| 24.076 | 24.847 | 0.771 |
| 24.847 | 25.629 | 0.782 |
| 27.404 | 27.507 | 0.103 |
| 27.864 | 27.935 | 0.072 |
| 29.156 | 29.255 | 0.099 |
| 29.747 | 30.016 | 0.269 |

## Words that absorb a pause

A word whose `offsets` span holds a silence of 0.06 s or more (source ms from `speech.json`). 23 word/silence pairs across 19 words.

| word | span (s) | silence start | silence length |
|---|---|---|---|
| understood | 2.14-2.91 | 2.244 | 0.072 |
| in | 4.66-4.81 | 4.667 | 0.068 |
| proper | 5.05-5.50 | 5.438 | 0.060 |
| subdivisions | 5.50-6.42 | 5.909 | 0.074 |
| by | 10.76-10.92 | 10.777 | 0.065 |
| supplies | 11.29-11.90 | 11.392 | 0.074 |
| supplies | 11.29-11.90 | 11.599 | 0.061 |
| reach | 12.13-12.51 | 12.353 | 0.061 |
| the | 13.27-13.50 | 13.376 | 0.062 |
| military | 14.19-14.80 | 14.558 | 0.072 |
| military | 14.19-14.80 | 14.681 | 0.076 |
| expenditure | 14.80-15.84 | 14.938 | 0.063 |
| heads | 16.58-16.99 | 16.656 | 0.096 |
| be | 17.48-17.64 | 17.499 | 0.064 |
| general | 18.87-19.45 | 18.979 | 0.359 |
| victorious | 21.09-21.92 | 21.122 | 0.061 |
| victorious | 21.09-21.92 | 21.462 | 0.075 |
| them | 22.74-23.07 | 22.742 | 0.069 |
| not | 23.07-23.32 | 23.167 | 0.086 |
| fail | 23.65-23.98 | 23.668 | 0.083 |
| determine | 27.35-28.09 | 27.404 | 0.103 |
| determine | 27.35-28.09 | 27.864 | 0.072 |
| conditions | 29.00-30.00 | 29.156 | 0.099 |

Examples of long ones: `general` (18.87-19.45) holds a 0.36 s silence; `subdivisions` (5.50-6.42) holds the 0.69 s pause at 6.039 only partly, so not listed above; `expenditure` (14.80-15.84) holds the 0.80 s pause at 15.18 only partly, likewise.

## Measured limitation

On 2026-10-03 a retake spliced into this excerpt (4 shapes, including with `--max-context 0`) was dropped from the transcript by `large-v3-turbo-q5_0`, so the fixture has no retake. Real-footage retakes are checked in T15.
