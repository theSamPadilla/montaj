# Profiles

A creator profile captures the visual and editorial identity of a single social media account. Once created, it shapes every editing decision for that account's projects — pacing targets, color palette, overlay assets, and editorial direction are all automatically in scope.

---

## Directory structure

```
~/.montaj/profiles/<name>/
  analysis_current.json   — source of truth: per-video measurements + aggregate stats
  analysis_inspired.json  — same, for inspiration/reference accounts (optional)
  style_profile.md        — single agent-facing doc; injected into Claude context
  frames/                 — sample stills extracted during analysis (kept permanently)
  transcripts/            — word-level JSON transcripts, one per analyzed video
  overlays/               — creator-specific overlay assets (.jsx)
```

Source videos are downloaded into `videos/<source>/` during analysis and automatically deleted once analysis completes.

---

## style_profile.md

The single artifact that gets injected into agent context. Written by the agent after analysis and a vibe conversation with the user.

### Frontmatter schema

```yaml
---
username: @<handle>
links: <comma-separated profile URLs>
style_summary: <one sentence — the creator's style in plain English>
content_overview: <2–3 sentences — what they make, who it's for, what makes it work>
created: <ISO timestamp — written by analyze, never modify>
updated: <ISO timestamp — written by analyze, never modify>
videos_current: <count — written by analyze, never modify>
videos_inspired: <count if applicable — written by analyze, never modify>
---
```

Fields marked "written by analyze" are set automatically by `montaj profile analyze` and should never be hand-edited. All other fields are written by the agent during profile creation.

### Body structure

```markdown
## Editorial Direction
Synthesized from the vibe conversation — the creator's intent, energy, tone, and what a bad edit would look like.

## Pacing & Rhythm
- Average video duration: Xs
- Cut frequency: X cuts/min
- Speech rate: X WPM
- Speech density: X% of runtime

## Color Palette
Dominant colors with hex swatches. Current and inspired palettes if inspiration was analyzed.

## Format
- Resolution: 1080×1920
- Frame rate: 30fps

## Gap Analysis  ← only present if inspiration was analyzed
Comparison table of current vs. inspired metrics with directional guidance.

*Analyzed from N videos. Generated YYYY-MM-DD.*
```

---

## analysis_current.json

Source of truth for all measured data. Written by `montaj profile analyze`, never hand-edited.

```json
{
  "name": "techbyjaz",
  "source": "current",
  "analyzed_at": "...",
  "video_count": 15,
  "videos": [
    {
      "path": "...",
      "duration": 48.06,
      "resolution": "1080x1920",
      "fps": 30.0,
      "cuts": 17,
      "cuts_per_min": 21.2,
      "wpm_avg": 245.0,
      "speech_ratio": 0.999,
      "dominant_colors": ["#1d1513", ...],
      "transcript_path": "~/.montaj/profiles/<name>/transcripts/<id>.json",
      "sample_frames": ["..."]
    }
  ],
  "aggregate": {
    "avg_duration": 48.06,
    "avg_cuts_per_min": 10.0,
    "avg_wpm": 245.0,
    "avg_speech_ratio": 0.999,
    "dominant_colors": ["#1d1513", ...],
    "common_resolution": "1080x1920",
    "common_fps": 30.0
  }
}
```

The server derives all profile stats and color palettes from this file at request time — nothing is duplicated.

---

## CLI

### Create a profile

```bash
# Step 1 — fetch videos
montaj fetch "https://www.tiktok.com/@techbyjaz" \
  --out ~/.montaj/profiles/techbyjaz/videos/current/ \
  --limit 15

# Step 2 — analyze
montaj profile analyze --name techbyjaz

# Step 3 — agent writes style_profile.md
# (done conversationally via the style-profile skill)
```

### Analyze with explicit video paths

```bash
montaj profile analyze --name techbyjaz --videos /path/v1.mp4 /path/v2.mp4
```

### Analyze inspiration content

```bash
montaj fetch "https://www.tiktok.com/@otheraccount" \
  --out ~/.montaj/profiles/techbyjaz/videos/inspired/ \
  --limit 15

montaj profile analyze --name techbyjaz --source inspired
```

### List profiles

```bash
montaj profile list
```

---

## Overlays

Profile overlays live at `~/.montaj/profiles/<name>/overlays/` and follow the same layout as global overlays — flat or one level of grouping, each overlay as a directory containing `<name>.jsx` and optional `<name>.json`.

Resolution order when a profile is active:

1. **Project overlays** — `<project>/overlays/` — always wins
2. **Profile overlays** — `~/.montaj/profiles/<name>/overlays/`
3. **Global overlays** — `~/.montaj/overlays/`

Users who never create a profile fall back to global overlays unchanged.

---

## Connecting a profile to projects

**Claude Code** — add to `~/.claude/CLAUDE.md` under a `## Montaj Profiles` section:
```markdown
## Montaj Profiles

@~/.montaj/profiles/<name>/style_profile.md
```

This makes the profile available in all Claude Code sessions globally. The agent can add this line for you during profile creation.

**MCP** — the profile is available as a resource automatically once `analysis_current.json` exists:
```
montaj://profile/<name>
```

---

## Updating a profile

1. Re-fetch new videos into `videos/current/` (or `videos/inspired/`)
2. Run `montaj profile analyze --name <name>` — updates `analysis_current.json` and refreshes the frontmatter bookkeeping fields
3. Agent rewrites `style_profile.md` body with updated data and any revised editorial direction
