---
name: onboarding
description: "A guided first session in the Montaj app: what Montaj is, checking the connection, then walking the user through their first edit from their own footage, from the clips to the exported video. Load it right after Montaj is installed, or when the user asks to get started or what Montaj is."
---

# Getting started with Montaj

Walk the user through their first session, one step at a time. Keep each message short, ask one question at a time, and wait for the answer. Do the work with the Montaj connection's tools. If you have not loaded it yet, call `get_skill` with `mcp`: it says which tool does each thing.

## 1. Say what Montaj is

In two or three lines, for example:

> Montaj is a video editor on your computer that I can drive. You bring your footage; I cut it, caption it and add graphics, and you review it in the Montaj app and export it. Your footage stays on your computer.

## 2. Check the connection

Call `get_plan`.

- It answers with the user's plan: you are connected. Don't read the plan out and don't bring up upgrades.
- "Montaj isn't set up on this computer yet": the app is still opening, or was never opened. Ask the user to open the Montaj app, wait a minute, then try again.
- "Montaj isn't running" or "Montaj isn't open": ask the user to open the Montaj app, then try again.
- "Montaj was moved or updated": ask the user to quit and reopen this AI app so it reconnects.

If the Montaj window still shows its welcome screens, ask the user to finish them first.

## 3. Ask what they want to do first

Offer three choices and recommend the first:

1. **Edit a video from your own footage** (recommended): a clip you filmed, trimmed and captioned.
2. **Try a template**: the kinds of video Montaj makes.
3. **Set up your style profile**: I study your account and save how you make videos, so later edits follow it.

Then:

- **1**: go to section 4.
- **2**: ask the user to open **Projects**, then **New project**, in the Montaj app. Each card shows what that template makes. When they pick one, make the project with `create_project` and that template's `workflow` (see section 4), then load the skills its workflow names. If the tool says the template needs a plan the user doesn't have, tell them once, with the link it gives, and ask what they'd like to do instead.
- **3**: call `get_skill` with `app/style-profile` and follow it. If it says it needs another plan, tell the user once, with the link it gives, and ask what they'd like to do instead.

## 4. The first edit, step by step

1. **Get the clips.** Ask where the footage is.
   - The user gives you the clips' file paths: use them in the next step. For a link (YouTube, or a direct video link), call `import_media` with the `url`, then `get_import_status` with its `jobId` until it is done, and use the `path` it gives.
   - Or the user adds the clips in the app: **Projects**, then **New project**, then **Talking head**. They drop the clips on **Drop your clips** (or use **Browse files**), write what they want in **Prompt**, and click **Run**. The app makes the project and shows **Send this to your AI** with a message to copy. Ask them to paste it here: it has the project's id. Then skip to step 3.
2. **Make the project.** Confirm a short name and what they want (length, tone, captions) with the user, then call `create_project` with `workflow` `overlays` (the Talking head template), `name`, `prompt` in the user's words, and `clips` as the absolute paths. It returns the project's id, with status pending, and a `link`.
3. **Make the edit.** Call `get_skill` with `montaj` and follow it to start the pending project. Tell the user what you are doing as you go: each step's progress line shows live in the Montaj window too. Some steps take a while; say so rather than going quiet.
4. **Review it in the editor.** When the edit is saved as a draft, give the user the project's `link`: it opens the project in Montaj. (They can also click **Projects**, then the project.) They can play it, trim on the timeline and fix captions by hand. Ask what they'd like changed, then call `get_skill` with `edit-session` and follow it. When they point at something on screen, call `get_editor_state` to see where they are looking.
5. **Export.** The user clicks **Export** at the top of the editor. When it says **Render complete**, **Download** gives them the file, and Montaj also keeps it as `<project name>.mp4` in the project's `output` folder, inside the `Montaj` folder in their home folder.

## 5. What else Montaj can do

Don't explain these now. Name them when the user asks for something they cover, and load the skill with `get_skill`:

- `edit-session`: changes to a draft: cuts, timing, overlays.
- `speech-edit`: cut words, pauses and failed takes by editing the transcript as text.
- `select-takes`: keep the best take of each part when they filmed several.
- `write-overlay` and `overlay`: titles, callouts and animated graphics.
- `image-search`: find real images to put in a video.
- `carousel`: swipeable image slides.
- `ai-video-plan`: a video generated from a prompt, with a storyboard first.

`list_skills` lists every skill this user can load.

On the command line, without the Montaj app, follow the root `montaj` skill instead.
