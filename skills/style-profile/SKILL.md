---
name: style-profile
description: "Create or update a creator style profile — analyzes video content to extract editing style, pacing, color palette, and aesthetic direction for use in all future editing decisions."
---

# Style Profile

A creator profile captures the visual and editorial identity of a single social media account. Once created, it gets injected into the agent context for every project that account produces — shaping every editing decision automatically.

Profiles live at `~/.montaj/profiles/<name>/` and contain:
- `style_profile.md` — the injected artifact (load this into CLAUDE.md); includes pacing data, color palette, editorial direction, and gap analysis vs. inspiration
- `analysis_current.json` — source of truth for all stats and colors (written by `montaj profile analyze`)
- `frames/` — representative sample stills
- `overlays/` — creator-specific overlay assets

---

## When to invoke this skill

- User asks to "create a profile", "set up my style", "analyze my account"
- User asks to "update my profile" or "add inspiration"
- User asks to "use [account name] style for this project"
- User mentions a social media account handle in an editing context

---

## Execution flow

Work through these steps conversationally. Don't batch all questions upfront — ask one thing at a time and respond to the user's answers naturally.

### Step 1 — Identify the account

Ask: **"Which account is this profile for?"**

Get a clean identifier (no @ symbol, lowercase, e.g. `thesampadilla`). This becomes the directory name.

Check if a profile already exists:
```bash
ls ~/.montaj/profiles/<name>/ 2>/dev/null
```

If it exists, ask: **"I found an existing profile. Do you want to update it, or start fresh?"**

---

### Step 2 — Current content sources

Ask: **"Where is your content? You can paste a TikTok/Instagram/YouTube URL, or give me a path to a folder of videos on your machine."**

**If URL(s):** Use the `fetch` step to download. Ask how many recent videos to analyze (suggest 10–20 for a good sample).

If multiple URLs are provided (e.g. several individual video links), fire all fetch calls as **parallel tool calls** — do not download sequentially.
```
montaj fetch --url <url1> --out ~/.montaj/profiles/<name>/videos/current/
montaj fetch --url <url2> --out ~/.montaj/profiles/<name>/videos/current/
# ... fire all simultaneously
```
For a single profile or channel URL with `--limit`, one fetch call is sufficient.
```
montaj fetch --url <url> --out ~/.montaj/profiles/<name>/videos/current/ --limit 15
```

**If local path:** Use the directory directly. List files to confirm.

---

### Step 3 — Inspiration sources (optional)

Ask: **"Do you have any accounts you want to draw inspiration from? These help build a gap analysis — what your current style is vs. what you're aiming for. (Skip this if you just want to capture your current style.)"**

If yes: repeat Step 2 for each inspiration account, using `--source inspired` and a separate download directory.

---

### Step 4 — Run the analysis

Run current and inspired analyses as **parallel tool calls** if both are being collected — they are fully independent.

For the current content:
```bash
python $MONTAJ_ROOT/profiles/analyze.py \
  --name <name> \
  --videos <list of video paths> \
  --source current \
  --out ~/.montaj/profiles/<name>/
```

If inspiration videos were collected, fire simultaneously:
```bash
python $MONTAJ_ROOT/profiles/analyze.py \
  --name <name> \
  --videos <list of inspired video paths> \
  --source inspired \
  --out ~/.montaj/profiles/<name>/
```

`analyze.py` processes its video list sequentially internally. If the list is large (>10 videos) and speed matters, split it into batches and run multiple analyze calls in parallel, then note that the synthesis in Step 6 will only use one analysis file per source type — use the largest/most representative batch.

Report what was found: duration, cut frequency, speech rate. Something like:
> "Analyzed 12 videos. Average length: 38s, ~18 cuts/min, 156 WPM speech rate."

---

### Step 5 — Conversational vibe capture

This is the part analysis alone can't do. Ask targeted questions to capture the subjective aesthetic. Pick 2–4 of these based on what the data already revealed — don't ask all of them.

- **"What makes [your account / the inspiration account] compelling to watch? What's the hook?"**
- **"How would you describe the energy — high-intensity and punchy, or more measured and educational?"**
- **"What's the tone — conversational, authoritative, entertaining, emotional?"**
- **"Is there anything visually distinctive? Color scheme, text style, transitions?"**
- **"What does a bad edit of your content look like? What would feel off?"**

If inspiration was provided, ask: **"What specifically do you like about [inspiration account]? Is it the pacing, the storytelling format, the visual style, the personality — or something else?"**

Synthesize the answers into a 2–4 sentence editorial direction. Read it back: **"Here's what I'll put in the style profile: [synthesis]. Does that capture it?"**

---

### Step 6 — Write the profile

Read `~/.montaj/profiles/<name>/analysis_current.json` (and `analysis_inspired.json` if present) and write `~/.montaj/profiles/<name>/style_profile.md` directly.

The file must open with YAML frontmatter followed by the full profile body:

```markdown
---
username: @<handle>
links: <comma-separated profile URLs>
style_summary: <one sentence — the creator's style in plain English>
content_overview: <2–3 sentences — what they make, who it's for, what makes it work>
created: <ISO timestamp — written by analyze, never change>
updated: <ISO timestamp — written by analyze, never change>
videos_current: <count — written by analyze, never change>
videos_inspired: <count if applicable — written by analyze, never change>
---

## Editorial Direction
...

## Pacing & Rhythm
...

## Color Palette
...

## Format
...

## Gap Analysis  ← only if inspiration content was analyzed
...

*Analyzed from N videos. Generated YYYY-MM-DD.*
```

---

### Step 7 — Connect to projects

To make the profile available in all Claude Code sessions, the following line should be added to `~/.claude/CLAUDE.md` under a `## Montaj Profiles` section:

```markdown
@~/.montaj/profiles/<name>/style_profile.md
```

Offer to do this for the user: **"Want me to add this to your global Claude config so it's always in context?"** If yes, read `~/.claude/CLAUDE.md`, append the section if it doesn't exist, and add the line.

**For MCP-enabled agents** (Claude Desktop, OpenClaw) — the profile is available as a resource automatically: `montaj://profile/<name>`

---

## Update flow

When updating an existing profile:

1. Ask what changed — new videos, new inspiration, or just updating the editorial direction?
2. Run `montaj profile analyze` only on new content if incremental, or all content if full refresh
3. Rewrite `style_profile.md` with the updated data and any revised editorial direction
4. Confirm: "Profile updated. The style_profile.md in your CLAUDE.md will reflect the new data next session."

---

## Notes

- Analysis runs whisper.cpp with `base.en` model by default.
- Color extraction requires Pillow (`pip install Pillow`). If not installed, colors will be skipped but everything else works.
- `fetch` requires `yt-dlp` (`brew install yt-dlp` or `pip install yt-dlp`).
- For TikTok/Instagram, some accounts require authentication. If `fetch` fails, ask the user to log in with `yt-dlp --cookies-from-browser chrome` and retry.
- Large channels: suggest `--limit 15` for initial analysis. Users can always add more later.
