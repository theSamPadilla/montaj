# B-roll reference analysis — @explorebyjaz

Source: 4 TikToks, pulled with `montaj fetch`, shot-segmented with ffmpeg scene detection
(`select='gt(scene,0.25)'`), transcribed with `montaj transcribe --model base.en`, frames
sampled per shot and read visually.

Gemini `analyze-media` was unavailable — the key in `~/.montaj/credentials.json` returns
`API_KEY_INVALID` on a bare models-list call. Analysis done locally instead.

---

## The four references

| ref | dur | shots | avg shot | min | max | spine |
|---|---|---|---|---|---|---|
| 7598 "Texas hikes that don't suck" | 22.2s | 16 | 1.39s | 0.52s | 3.10s | VO |
| 7533 "Alaska engagement trip day 4" | 67.4s | 37 | 1.82s | 0.50s | **12.90s** | VO |
| 7594 "what I wore in Alaska" | 14.2s | 10 | 1.42s | 0.55s | 1.85s | music |
| 7575 "mornings like this" | 9.5s | 7 | 1.36s | 0.93s | 1.60s | music |

Median shot across all four ≈ **1.1s**. Mean ≈ **1.4s**. This is stable across VO-driven and
music-driven, across 9s and 67s runtimes. It is the single most reproducible number here.

---

## Two distinct modes

These four videos are not one format. They are two.

### Mode A — VO-driven (7598, 7533)

Narration is the spine. Footage illustrates what is being said. Cut points are derived from
the script, not from a metronome.

**7598 shot-by-shot** — the mapping is almost embarrassingly literal:

| # | span | VO | visual |
|---|---|---|---|
| 1 | 0.00–1.62 | "Oregon girl living in Texas…" | ECU moving creek water (atmospheric hook) |
| 2 | 1.62–3.07 | "…looking for hikes that don't suck" | creator selfie, smiling |
| 3 | 3.07–4.28 | "This one is definitely worth doing" | hero wide of the falls |
| 4 | 4.28–7.38 | "a little under four miles round trip" | **AllTrails map screenshot reading "3.7 miles out & back"** |
| 5 | 7.38–8.75 | "the trailhead starts along the San Gabriel River Trail" | **the literal trailhead sign** |
| 6 | 8.75–10.22 | "lots of shade and trees" | trees, dappled trail |
| 7 | 10.22–11.27 | "lake views almost the whole way" | lake through pines |
| 8 | 11.27–13.13 | "some pretty cool cliff jumping spots" | cliff over water |
| 9 | 13.13–16.23 | "limestone formations… walking on the moon" | pale rock, POV boots |
| 10–12 | 16.23–18.72 | "unique water feature and waterfall at the end" | **waterfall × 3 angles** |
| 13–14 | 18.72–20.08 | "this hike is also dog friendly" | POV boots on trail → dog high-five |
| 15–16 | 20.08–22.24 | "save this and follow for more" | falls → creator waving |

Rules visible in that table:

- **One noun phrase per shot.** The cut happens when the subject of the sentence changes.
- **Shot length is a consequence, not a parameter.** Shot 4 runs 3.10s because the viewer has
  to *read a map*. Shots 10–12 run 0.78/0.53/0.52s because the VO is sprinting.
- **Dwell → multiple angles of the same subject.** When the VO spends 2.5s on the waterfall,
  the edit spends three shots on the waterfall rather than one long one.
- **Assets are shots.** The map screenshot is a first-class B-roll shot, and it's the longest
  non-hero shot in the video.
- **Face bookends.** Creator's face at shot 2 and shot 16. Nowhere else.
- **Hook is texture, not information.** Shot 1 is 1.6s of extreme-close water with no
  informational content.

### Mode B — music-driven (7594, 7575)

No narration. Cuts come from a metronome, not a script.

- **7594** "what I wore in ALASKA": categorical montage. Labels run `climbing, climbing,
  hiking, whale watching, whale watching, forest fair, forest fair, AN ENGAGEMENT RING`.
  Two shots per label. Last label is a **twist payoff** — the video is nominally an outfit
  montage and ends on an engagement ring.
- **7575** "mornings like this": *process* montage. One action (making camp coffee) in
  chronological order across 7 shots — stove on, light, pour, plunge, pour, pour, drink
  together. Ends on the payoff (two people drinking). Cuts land on action completion.

Beat-grid fit is weak (best BPM fit leaves ~0.04s mean offset, intervals 0.55–1.85s are not a
clean grid). The honest read: **not beat-locked, just tightly clustered around 1.5s.**

---

## Cut placement (measured)

Distance from each cut to the nearest whisper word boundary:

| ref | cuts | median deviation | within 100ms | landing *inside* a word |
|---|---|---|---|---|
| 7598 | 15 | 0.030s | 15/15 | 7/15 |
| 7533 | 36 | 0.057s | 30/36 | 24/36 |

Cuts are word-locked to within ~50ms, but the majority land slightly **inside** a word rather
than in the silence between words. That's cutting on the *onset* of a word so the new visual
arrives with the emphasis. Practical rule: **snap to word start, not to the gap.**

---

## The taste inversion (7533, the important one)

The Alaska video's median shot is ~1.0s. At 28.53s–41.43s there is **one locked-off tripod
wide shot that runs 12.90 seconds with no cuts** — the proposal. Verified frame-by-frame: the
camera never moves, the couple walks in, he kneels, she reacts, they embrace, all in one take.

That is a **13× pacing inversion at the emotional peak.**

Any algorithm enforcing "max shot length 3.1s" would have chopped this into ten cuts and
destroyed the video. This is the clearest example of what the automated matcher must be able
to *not* do.

Secondary pacing effects in the same video:
- Driving/dashboard shots recur 4× as connective tissue under "we continued along our drive."
- Shot 36 (5.47s) — the moose sighting, second-longest, another payoff hold.
- Rapid-fire 0.5–0.9s runs during list-y narration (shots 21–34, the Anchorage/dinner stretch).

---

## Text treatment

All four use a **persistent small label**, not word-by-word captions:

- 2–4 words, lowercase, small, centered-ish, low contrast white
- **Spans multiple shots** — "waterfall at the end" holds across shots 10–12, "dog-friendly"
  across 13–14, "mornings like this" across all 7 shots of 7575
- The label is a **topic tag, not the transcript**. It never matches the spoken words.
- Mode B relies on it entirely — with no VO, the label is the only semantic channel.

This is a distinct artifact from `captions` and from JSX overlays. It's cheap to generate and
carries a lot of the format's identity.

---

## Audio

- Source-clip audio is effectively absent. B-roll is muted; the bed is VO + music.
- Mode B is music only.
- No speed ramps, no crossfades, no whip pans detected. **Every cut is a hard cut.**

---

## Feasibility probe: does the existing clean-cut chain run on bare audio?

Tested against `vo.wav` extracted from 7533:

| step | result |
|---|---|
| `montaj waveform-trim vo.wav` | ✅ returns keeps |
| `montaj rm-nonspeech spec.json` | ✅ returns speech-only spec |
| `montaj filler spec2.json` | ✅ returns filler-stripped spec |
| `montaj materialize-cut --input spec2.json --out vo_clean.wav` | ❌ ffmpeg fails — hardcoded H.264 video path |

**The entire clean-cut chain is already audio-capable except `materialize_cut`.** That is the
only gap, and it's a narrow one — the step needs an audio output mode.
