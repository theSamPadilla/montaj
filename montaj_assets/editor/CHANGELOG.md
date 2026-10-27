# Changelog

All notable changes to `@bycrux/editor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Added: a sound dragged from the host's Media bin lands in `audio.tracks` (never on a video track). The host starts the drag with `AUDIO_DND_MIME` and an `AudioDropPayload` (`{ src, sourceDuration, name?, type? }`, both exported). A drop on an audio lane lands on that lane at the time under the pointer; anywhere else, or where it would overlap a track in that lane, it gets a new lane under the last. `placeDroppedAudio` (exported) is the pure rule; tracks that carried no `lane` are given the lane they are drawn on, so no row moves. Video drops are unchanged.
- Added: Remove background in the rail toolbar for a photo (§587), when the host implements the new optional `EditorAdapter.removeBackground(src, projectId)`. A spinner shows while it runs (one run per image); the cutout replaces the photo's `src` in one undo step that keeps the box and crop, drops `mediaId` and adds the cutout to `project.assets`. The original file stays. A failure goes to `onError`; a locked image's button is disabled; a photo replaced meanwhile is left as it is. `ElementToolbarProps` gains `onRemoveBackground` and `removingBackground`.
- Added: your own fonts in the carousel font menu (§587). `CarouselEditorProps.customFonts` (`CustomFont`: `{ family, url, src? }`, exported) lead the list, after "Use brand default", each drawn in its own face (loaded with FontFace from `url`). `onAddFonts` adds an "Add your fonts" row at the head of the list, which closes the menu and calls the host; the editor has no upload of its own. A pick writes `fontFamily` (the family, then the system stack) and the element's new `fontFiles` (`FontFile[]`: `{ family, src }`, exported) in one undo step; `importFont(font)` lets the host make the file the project keeps (a copy in the project) and resolves its path; a family the project already holds a file for reuses it, and a rejected import writes nothing. A locked element keeps its font. The canvas loads an element's `fontFiles` through `resolveImageSrc`; a copied or pasted text style carries them with the family, as `googleFonts`. `FontFamilyPicker` takes `customFonts`, `onPickCustom` and `onAddFonts`; `ElementToolbarProps` gains `fontMenu`. The carousel renderer (`render-carousel.js`) declares each element's `fontFiles` as an `@font-face` (a relative `src` is the project dir's, as an image's), so the export draws the same face.
- Added: groups in the carousel editor (§587). Select several, then Group: the toolbar (`Group`/`Ungroup` icons; `ElementToolbarProps` gains `onGroup`, `onUngroup`, `groupDisabled`, `groupBox`), the right-click menu, or Cmd+G and Cmd+Shift+G (Ctrl off a Mac). Elements stay flat: each member carries an optional `group` id (`ImageElement.group`, `OverlayElement.group`; editor-only, the renderer ignores it), and members are kept next to each other at the frontmost member's place (`carousel/groups.ts`). A click on a member selects the whole group, a band or shift-click takes whole groups, and Cmd-click, the pick list, a double-click or a Layers member row reaches one member alone (clicks then stay inside that group). A selected group draws one box (the members' covered union) with resize and rotate handles (`GroupChrome`, `carousel/groupGestures.ts`): a drag moves every member, a corner scales them about the group box with text fonts (Shift frees the ratio, a side stretches), the rotate handle turns them about its centre; each gesture previews live and is one undo step. `SlideCanvas` takes `editElements` for the resize and turn. Layers shows a group as one row that opens to its members; the row selects, locks and hides the group, a drag of it moves the whole group, members reorder within their group, and an element dropped on a group lands beside it (`LayersPanelProps` gains `onSelectGroup`, `onToggleGroupLock`). Layer order moves a group as one step (`reorderSelection`, `moveToLayer`). Locking a group locks every member; a group with a locked member does not move, resize, turn or ungroup, and its badge unlocks all of it. Copy, paste, Duplicate and duplicating a slide give a copied group a new id; a group copied in part is not a group in the copy. Delete removes the group. Position aligns a selected group to the slide as one box.
- Added: style one word or range of a carousel text box (§587). Select text in the inline editor and the rail toolbar's colour ("A" and the swatch), Bold, Italic and a new Underline style that range alone, one undo step each; with no selection they style the whole element as before. The range is stored on the element as `runs`, a JSON array string beside `text` (`[{"t":"Make it "},{"t":"red","c":"#ff0000","b":1}]`: `c` a hex colour, `b`/`i`/`u` 1 or 0, absent the element's own); `text` stays the plain text, and runs that do not join to it are ignored. A style every char shares goes onto the element (`fontWeight`, `fontStyle`, `color`); Underline with no selection underlines every run. The static-text template draws runs as spans with the same fit, so the canvas and the export match. The inline editor is now a contenteditable (`role="textbox"`, still "Edit text") that draws the runs while editing: typing, deleting and pasting keep them aligned (an insertion takes the style of the char before it; text typed over a selection, its first char's), paste is plain text, Shift+Enter a newline, Cmd/Ctrl+B, I and U style the selected range, and its keys no longer reach the canvas's shortcuts. `InlineTextEditor`'s `onCommit` now gets `(value, runs, base)`. New in `text/runs.ts`: `decodeRuns`, `encodeRuns`, `spliceRuns`, `styleRange`, `rangeStyle`, `runsPatch`, `styleWholeText`, `supportsRuns`, `setOverlayPropsIn`. `SlideCanvas` takes `updateOverlayProps`, `textEditRef` and `onTextRange`; `ElementToolbar` takes `textRange` and `onTextStyle`.
- Fixed: styled runs in the carousel text editor (§587). The Enter or Esc that confirms an IME composition no longer ends the edit, and an edit that ends mid-composition keeps the composed text. A text commit writes only what the edit changed: a colour or weight saved to the element while the person typed (by their AI) is no longer put back (`runsPatch` moves a shared style onto the element only when the edit gave it, and leaves every other key as the live element has it; `InlineTextEditor`'s `onWrite` and `onCommit` get runs relative to the element as the edit last wrote it). Cmd+Z and Cmd+Shift+Z (and the browser's own undo) undo and redo inside the edit, typing close together as one step, and no longer reach the editor-wide undo while editing. Moving the selection inside one style no longer re-renders the editor. A range never splits an emoji's two halves (runs whose boundary does are ignored, as the static-text template ignores them). Opening and closing an edit on runs with a redundant style writes nothing. An element colour that is not hex (`white`) is kept as the element's, so a word coloured `#111111` is kept, and a colour that is not hex is never written to a run. New in `text/runs.ts`: `liftShared`, `rebaseRuns`, `cleanPatch`.

- Added: `CarouselApi.addImage(src, options?: { asset?: { name?: string } })` also lists the image in `project.assets`, in the same save as the element (one undo step), as `setBackgroundImage` does. Fixed: `addImage` resolves `false` when nothing was written (the slide went mid-upload, or the image could not be read).
- Fixed: the toolbar's colour swatch and Stroke popover (`shapeKind`, `strokeStateOf`) apply only to a shipped template (`shippedTemplateKey`), so a project overlay that shares a file name such as `callout-stat.jsx` gets neither control (§587).
- Fixed: a shape, arrow or callout tile previews in the box the element is added in (`newOverlayBox`), then shrinks to the tile, so px props such as a corner radius are in scale (§587).
- Changed: Polygon's default is 5 corners, so its tile no longer reads as Hexagon (§587); an element keeps its stored `points`.
- Added: the rail layout's Elements panel lists the fuller shape set in five sections, in order: Shapes, Arrows, Lines, Frames, Callouts (§587). `ELEMENT_CATEGORIES` gains `arrow` and `callout`; tiles follow a fixed order (`orderElements`: the basics first, the blobs last). A shape, arrow or callout is added in a box of its sidecar's `aspect` (`GlobalOverlay.aspect`, `elementAspect`, `aspectBox`), and its tile draws at that aspect. The toolbar's colour swatch and Stroke popover recognise every new template (`shapeKind` reads `arrow-*` and `callout-*` as filled shapes).
- Changed: the rail toolbar's Position popover holds Align and layer order only (§587). The X, Y, W, H and rotation fields are gone there: the canvas handles place, size and turn an element, and the AI sets exact numbers through its tools. `TransformFields` stays exported (the classic panel uses it).
- Added: a stroke control in the rail layout's element toolbar for the shipped lines, shapes and frames (§587): a Stroke button opens a popover with four style tiles (solid, long dash, short dash, dotted; `strokeStyle`), "Rounded end points" (a line's `roundCaps`) or "Rounded corners" (`roundJoins`, where the shape has corners), and the stroke weight as a slider and a number field (`strokeWidth`). A line also gets start and end arrow toggles (`arrowhead`). Each pick or toggle is one undo step; the slider and the field preview live and save once on release or Enter. Locked: the arrows and the popover's controls are disabled. The Edit popover leaves out the props the stroke popover writes. `ElementToolbarProps` gains `onPreviewOverlayProp` and `onCommitPropPreview`.
- Fixed: the prop editor's checkbox reads a bool prop saved as the string `'false'` as off (§587).
- Changed: the carousel rail layout's element toolbar has a row of its own above the stack (§587): the slides scroll under it and it never moves; it keeps one row's height and grows when the toolbar wraps, so it never covers a slide. A selection now holds its slide while its element is in view: scrolling another slide more into view no longer clears it, and only scrolling the whole selection more than a slide header's height (`SELECTION_AWAY_PX`, 32 px) past the stack's visible edge does (a crop applies), after which the slide most in view becomes active. `StackedSlides` takes `selectedElementIds` and `onSelectionScrolledAway`.
- Added: a colour swatch in the rail layout's element toolbar (§587): a round swatch of the element's colour (a text element's text colour; a shape's fill, or its stroke when the fill draws nothing; a line's or a frame's stroke; none for an image or a graphic). A click opens the colour panel on that colour, one undo step per pick; with the panel open on another colour of the element (an effect colour, an outline) the swatch shows that colour and a click closes the panel. A locked element's swatch opens the panel disabled. `elementColourTarget`, `shapeKind`, `elementColours` and `DEFAULT_SOLIDS` are in `carousel/colours.ts`.
- Changed: the rail toolbar's text colour is an "A" over a thick rounded bar filled with the text's colour, live (§587). The video editor's text toolbar is unchanged.
- Changed: the colour panel's sections, top to bottom (§587): a search field (a CSS colour name or a hex, written on Enter), the element's own colours with the current one pressed, its hex, transparency and "Change on every slide", "In this carousel", the brand palette with "Use brand default" first, photo colours, and a fixed grid of default solid colours. Photo colours are the dominant colours of each image on the slide, read in the browser from a 48 px nearest-neighbour copy on a canvas (`carousel/photoColours.ts`, cached per `src`); an image the page cannot read is left out.
- Changed: `CarouselApi.setBackgroundImage(src, options?)` resolves `boolean` (§587): `false` when it did nothing (no slide, read-only, crop mode, grid view, pending surface), `true` once it wrote. `options.asset` (`{ name? }`) also adds the image to `project.assets` in the same save and undo step, skipping a `src` already there. The Background panel disables the host's images slot (a disabled `fieldset`) while the images cannot be set.
- Changed: a new background replaces the slide's current one (§587). `setImageAsBackground` (Set as background, the Background panel's image rows, `CarouselApi.setBackgroundImage`) drops the back-most element when it is a locked, unrotated image covering the slide, in the same write, so one undo brings the previous background back. `isBackground` is exported from `carousel/background`.
- Changed: the carousel rail layout takes Montaj's look (§587): the rail items are muted 16 px icons with an 11 px label, and the open one is paper with a soft shadow and ink; panel titles, eyebrow labels and muted text, 10 px tool corners, pill buttons at 600, a light accent tint for a selected layer or a pressed tool, Montaj's menus, fields and keycap. The rail's icons are Image (Media), Blocks (Elements), TextCursor (Text), Sparkles, Layers, PaintBucket and NotebookPen (Notes). The class strings live in `carousel/railStyles.ts`; the shared `ui/*` primitives and the video editor are unchanged.
- Removed: the rail layout's Brand item, the `'brand'` `CarouselRailItemId` and the `EditorSlots.carouselBrandPanel` slot (§587).
- Added: shapes, lines and frames in the rail layout's Elements panel (§587). The engine ships them as overlay templates (`render/templates/overlays/`: `shape-rect`, `shape-rounded-rect`, `shape-ellipse`, `shape-triangle`, `shape-star`, `shape-polygon`, `shape-arrow`, `line-straight`, `line-arrow`, `line-dashed`, `frame-border`, `frame-double`, `frame-corners`), each an SVG of its box with `fill`, `stroke` and `strokeWidth` (px) and its own options; no schema change. The panel lists them from `adapter.listSystemOverlays()` in Shapes, Lines and Frames sections, for every user, above the person's own graphics; a tile adds its template to the active slide on click (a square for a shape, a wide thin box for a line, 70% of the slide for a frame) or where it is dropped on a slide (`TEMPLATE_DND_MIME` in `carousel/overlayElement.ts`, believed only while a tile drag of the editor's own is under way), one undo step each. Their props show in the Edit popover (`useOverlaySchemas` now loads the shipped templates that have a `category`).
- Added: `GlobalOverlay.category` (optional, from a template sidecar's `"category"`: `'shape'`, `'line'` or `'frame'`), passed through by serve's overlay listings. `GlobalOverlayProp` gains `enum` (the prop editor shows a select) and `format` (`'color'`: a string prop edited with a swatch, transparency allowed).
- Added: `CarouselEditorProps.onAskAi(request)` (`AskAiRequest`: `{ kind: 'shape', slideId, text }`, exported). With it, the Elements panel ends with an "Ask your AI for a custom shape" field; Enter or Ask hands the host the trimmed text and clears. The host builds the prompt for the person's own AI. Absent: no field.
- Fixed: a carousel font pick (the font list and Use brand default) writes the element's `googleFonts` with `fontFamily`, in one undo step, so the export fetches the face instead of drawing a fallback (§587). `FontFamilyPicker.onChange` passes the pick's specs as a second argument (empty for System), and takes `brandGoogleFonts`.
- Fixed: the carousel canvas passes an overlay its box (`boxWidth`, `boxHeight`, slide px) as the renderer's `slide.jsx` does, so a template that draws to its box (the shapes, the charts) looks the same in the editor as in the export. The charts used to draw at 1080 px in the editor whatever their box.
- Added: the carousel rail layout (§587). `CarouselEditorProps.layout` (`CarouselLayout`: `'classic'`, the default and today's layout, or `'rail'`) swaps in a top bar, an icon rail (Media, Elements, Text, Brand, AI image, Layers, Background, Notes; `CarouselRailItemId`) with a side panel, a right notes panel and a bottom bar (zoom slider, a % menu, Slides N/M, the grid view, the Controls "?"). The host fills it through the `EditorSlots` entries `carouselTopLeft`, `carouselTopRight`, `carouselMediaPanel`, `carouselBrandPanel` and `carouselNotesPanel`, and `railPanels` (`Partial<Record<CarouselRailItemId, ReactNode>>`) overrides any item's panel. Every slide is stacked in one scrolling canvas with a header per slide (`Slide.title`, optional, typed in the header, editor-only, ignored by the renderer), and a grid view reorders slides by drag. An element toolbar with Position and Edit popovers, a Layers panel, a Background panel (colour, set an image as the background) and Text, Elements and AI image panels add to the active slide.
- Added: `CarouselEditorProps.brand` (`CarouselBrand`: `colors`, and `fonts` with `heading`, `body` and `googleFonts`), for `layout="rail"`: the colour panel shows the brand palette and the Text presets use the brand fonts. The colour panel also takes a hex, a transparency, this carousel's colours and "change on every slide"; `ColourPanelContext` (with `ColourRequest` and `OpenColourPanel`) is exported from `ui` so a swatch can open it.
- Added: `UseProjectState.editSlides(edit)` (one save and one undo step over every slide, gated like every slide edit; the same array back writes nothing) and `previewSlides(edit)` (the same edit as a transient, until `commit()`). `CarouselApi.setAsBackground(elementId)` makes an image the slide's background: it covers the slide, goes to the back and is locked, in one undo step.
- Added: rail layout keys and gestures (§587), listed in `CAROUSEL_CONTROLS`: Cmd+= or Cmd++ zoom in, Cmd+- zoom out, Cmd+0 Fit, Cmd+1 100% (Ctrl off a Mac); Cmd-click also opens a pick list of every layer under the pointer (`SlideCanvas` `pickList`; Up and Down move, Esc or Enter close); right-click opens a menu on an element or the empty canvas (`SlideCanvas` `onContextMenu`); Esc closes an open toolbar popover first. A copy or duplicate of a locked element is unlocked.
- Added: `EditorTheme.colors.accentText` (optional, §587): the accent as small text (active rail item, selected slide). Absent, the stock light theme keeps indigo-600, a custom light accent is darkened to 4.5:1 on the background (it was indigo for every light theme), and dark themes use the accent, as before.
- Changed: in the rail layout (§587), N and the right-click "Add a note here" open the Notes panel (closing the side panel) when the host passes `carouselNotesPanel`; with locked notes (`notes.enabled` false) the Notes item calls `notes.onLocked` and opens nothing; with no `notes` option, or enabled notes and no panel, the Notes item is hidden.
- Changed: an image file dropped from the OS onto the carousel canvas also joins `project.assets` (skipping a `src` already there), in the same save and undo step as the new elements; `editElements` takes an optional third argument `assets` for it (§587). A drag of a Media card adds none.
- Added: `SlideNotesApi.add(slideId, point?, text?)` takes the note's text, so a note typed in a host field is one save and one undo step (§587).
- Fixed: a carousel overlay follows its selection box on every move of a resize, not only on release (§587): a shape, line, frame or chart redraws at the live box (its `boxWidth`/`boxHeight` and its layer), and text wraps to it on a side handle. Only the overlay being resized renders per move (`carousel/liveBox.ts`). Images and corner-scaled text already followed.
- Fixed: a Layers panel row dragged with the mouse reorders the stack (§587). The rows were native drag sources that took only `dragover`, so a release soon after the pointer crossed into a row's name, thumbnail or buttons dropped nothing; a row is now a pointer drag (past 4 px, so a press that does not move still selects): the whole row shows a grab cursor (grabbing while dragging), a line in the accent colour marks the drop place, and the release is one save and one undo step, locked elements included. `moveToLayer` (`carousel/layerOrder.ts`) is the reorder the drop and `CarouselEditor` share.
- Fixed: the rail layout's zoom slider is released after a drag, so the zoom and editor keys keep working (a focused range input counts as a typing surface to the keymap).
- Fixed: the selection chrome of an element far off the slide is no longer cut off at the canvas margin (§586). With a `margin`, `SlideCanvas` draws the outlines, handles, guides, crop handles and lock badge over the visible part of the scroll area holding the canvas, so they show and take the press wherever that area shows them, above a slide that follows, and never make it scroll. The elements still clip at the slide edge.
- Changed: `FontSizePicker` (public export) writes once, on Enter or blur, not on every keystroke.
- Added: smart-guide snapping (§586). `snapToSlideAndElements` (from `gestures`, with the `SnapBox`, `GapSegment`, `SmartSnapResult`, `SmartSnapOptions` and `DragModifiers` types) snaps a moving box to the slide and to other elements' edges and centres and shows equal gaps; holding Cmd/Ctrl during a drag skips snapping.
- Added: `SlideCanvas` takes `margin` (px of canvas drawn around the page, so handles, guides and crop handles show past the slide edge). `CanvasCropHandles` and `CanvasCropHandlesProps` are exported, and `CanvasCropOverlay` takes `fit` (`'contain'`, the default, or `'current'` to show the picture at its current scale). Applying a crop keeps the picture's scale: the box resizes to the kept part.
- Added: element lock (§586). `locked` on an element (schema) protects the element's place and content: no move, resize, rotate, crop, replace, delete, text edit, text toolbar or panel prop write, or style paste, through the editor; it still selects, copies and changes layer; a selected locked element shows a lock badge that unlocks on click. `CarouselEditorProps.lockKey` (default off) binds Opt+Shift+L (Alt+Shift+L on Windows) to lock or unlock the selection, and lists it in the Controls.
- Added: selecting on the carousel canvas (§586). Cmd-click selects the layer below, a press inside the selected element drags it even under another, and a drag from empty canvas selects every element the band touches.
- Changed: a corner drag on a text box scales its font size with the box (§586). `ResizeGesture` is exported from `gestures`. Esc keeps an inline text edit, an edit that changed nothing writes nothing, and typed panel numbers are one undo step. `UseProjectState.updateOverlayProp` now accepts a number `value` as well as a string.
- Added: T adds a text box, and Opt+Cmd+C and Opt+Cmd+V copy and paste a text element's style (§586). `CAROUSEL_CONTROLS` names every new key and gesture.
- Removed: Audio polish's Isolate voice piece. `'voice'` leaves `AudioPolishAnalysis`, `AnalyzeAudioPolishArgs` and `PolishPiece`, `canIsolateVoice` leaves `EditorAdapter`, and `voiceTrackFor` and the plan's `vocalsPath` go with them; the stem separation the piece needed is gone from the engine. `pieceSupported` keeps its one restriction, `loop`. An audio track an earlier polish made (a `polish_voice_` id) stays a plain audio track. The `renderMode: 'ffmpeg-drawtext'` banner on the timeline is gone with that render mode, and `captions.position` and `captions.bgColor` leave the caption track's type (only that mode read them).
- Fixed: a cropped image is placed with `translate(-x * 100%, -y * 100%)` (x, y the crop's origin) instead of percentage `margin-left` and `margin-top`, in `SlideCanvas` and in the renderer's `templates/slide.jsx` (§562). A percentage `margin-top` is a share of the box's width, so a crop with a top offset on a box that is not square showed another region than the one picked, in the editor and in the export. A translate's percentages are of the image's own size, so the box shows the picked rect on a box of any shape. Crops already saved with a top offset on a non-square box now draw the area that was picked, so they look a little different. See the root CHANGELOG (Unreleased).
- Changed: crop mode (§556). A double-click on an unrotated image enters it: `SlideCanvas` takes `onEnterCrop(elementId)` (absent, a double-click on an image does nothing; text still opens its inline editor), and `CarouselEditor` passes it the entry the panel's Crop button uses. The window can be dragged as a whole, at its size and kept inside the image (`CanvasCropOverlay`: the window is `data-testid="crop-move"`, and the new optional `onDragEnd` fires when a press on a handle or on the window is let go, so the host can ignore the click that follows). Leaving crop mode applies the window as one undo step, through one path that the host reaches with the new `cropControlRef`, a ref to a `SlideCanvasCropControl` (exported with `CropExit`) whose `leave('apply' | 'discard')` resolves once what it wrote is saved: Esc (the canvas handles it itself), a click on the canvas or on another element, a request for crop mode on another image, another slide, a new or duplicated slide or element (the copy has the crop), and Render (the toolbar's or the host's trigger), which `CarouselEditor` awaits before it saves as final. A window equal to the crop the image has (the whole frame when it has none) writes nothing: no `resizeElement`, no `updateImageCrop`, no `commit`. Undo in crop mode, by key or by button, discards the window and ends crop mode with no write, and redo does nothing there. A change to the slide while cropping keeps the window; a new file for the image restarts it from that file's crop; deleting the image or its slide, or every slide going, ends crop mode unwritten (`leave('discard')`).
- Added: images onto the carousel canvas (§556). New exports `IMAGE_DND_MIME` (`'application/x-montaj-image'`) and the `ImageDropPayload` type (`{ src, name? }`, `src` a host path as an `ImageElement` holds): a drag carrying that MIME as JSON (start it with `effectAllowed = 'copy'`) is taken by the canvas, and the image lands centred on the drop point. The payload is believed only for a drag that began in the same document (a `dragstart` there; a `dragend` or a drop ends it, and a cancelled `dragstart` does not count): any other page or app can put the same type on a drag, and its `src` would be stored and fetched. A drag of `Files` is taken too, and its image files (png, jpeg, gif, webp, avif, svg+xml and bmp, the types a browser can draw) are uploaded with `adapter.uploadFile(file, project.id, 'drop')`; the other files in the drop, HEIC, TIFF and PSD among them, are ignored. The canvas claims a drag only when it can take it now (not while the project cannot be edited, not in crop mode, and files only when the adapter can upload), and a drop it claims is always kept from the browser, which would open the file. Several files are one slide write and one undo step, each 20 px further down and right, and they end up selected, unless the person has gone to another slide or into crop mode meanwhile; an upload that fails goes to `onError` once and the others are still added; nothing is written if the editor is gone or the slide was deleted meanwhile. `SlideCanvas` forwards `onDragEnter`, `onDragOver` and `onDrop` to the root of an interactive canvas only. A new image keeps its own shape (`placeImageBox` in `carousel/imageGeometry.ts`): the largest box of its shape inside 80% of the slide, centred on the drop point or on the slide, and the old centred square, 80% of the slide's width, only when its size cannot be read. "+ Upload Image" and AI images use the same box, and one that lands after the person went to another slide is added to its own slide without taking the selection or ending a crop on the slide on show.
- Added: `CarouselEditorProps.onProvideCarouselApi(api)`, called with a stable `CarouselApi` on mount and with `null` on unmount, as `onProvideNotesApi` is. Its one action, `addImage(src)`, adds the image at host path `src` to the selected slide in the new-image box above, selects it, and is one save and one undo step. It resolves when the save settles (a failed save is shown by the editor, not rejected) and does nothing with no slide selected, when the project cannot be edited, and in crop mode. Absent: no api.
- Changed: `EditorAdapter.uploadFile(file, projectId?, via?)` takes an optional third argument, `via` (`'drop'`: dropped on the editor; `'picker'`: chosen in a file picker), for the host's provenance. It never changes where the file is stored, and it is absent when the caller does not say. The carousel passes `'drop'` for files dropped on the canvas, and `'picker'` for Replace image (`uploadFile(file, project.id, 'picker')`) and "+ Upload Image" (`uploadFile(file, undefined, 'picker')`). An adapter written for two arguments keeps working. `onError` also reports a Replace image whose file could not be uploaded (the image is left as it was) and an image file dropped on the canvas that could not be uploaded.
- Added: Replace image (§556). `SlidePropertyPanel` takes `onReplaceImage(slideId, elementId, file)` and shows a Replace button beside Crop (off while a replace is in flight, and off for good when the prop is absent). `CarouselEditor` uploads the file into the project, reads its size and writes it with the new `replaceImage(slideId, elementId, { src, crop })` of `useProjectState`, backed by a `replaceImage` action in `projectReducer`: it sets `src` and `crop` (removed when `undefined`) on an image element, drops `mediaId` and keeps x, y, w, h and rotation, as one save and one undo step, gated like every slide edit and dropped when the target is gone or is not an image. The crop is the centred region of the new image with the box's aspect (`coverCrop` in `carousel/imageGeometry.ts`), so the box stays filled with no bands; there is none when the shapes already match (within 0.5%), and none when the size cannot be read (`loadImageNaturalSize`, 5 s timeout, never rejects), in which case the old crop is cleared and the image shows whole, so bands can show. It uses the box the element has when the replace lands, not when it started.
- Changed: resize gestures (§556). `nextResizeBox(state, cursor, scale, options?)` takes an optional `{ keepRatio }` (new `ResizeOptions`, default off). On a corner handle it keeps the start box's w/h, the dragged corner following the cursor's projection onto the diagonal from the pinned corner and never going below 1 px on either side; side handles always move one side. It honours `startBox.rotation` (new and optional, as `startResize` takes it too): the cursor's travel is turned into the box's own axes and the point opposite the handle keeps its place on the slide. With no rotation and `keepRatio` off it returns what it always did. New `roundResizedBox(box, handle, rotation?)` rounds a resized box to whole px for the commit: w and h first, then x and y placed from the pinned point, which moves by at most half a pixel on each axis. `useOverlayResize`: `onPointerMove(cursor, modifiers?)` (new `ResizeModifiers`, `{ shiftKey }`) keeps the ratio on corners unless Shift is held in the `modifiers` it is given; a caller that passes none gets the free resize it always had, so the hook's API stays additive (`SlideCanvas` passes `{ shiftKey }` on every move), and `onCommit(elementId, box, gesture)` gets the gesture (`ResizeState`, for `roundResizedBox`) as a third argument, with the box unrounded. In `SlideCanvas` the eight handles and the rotate handle sit in percentages of the box, so they follow a resize preview live, and a release after a resize, rotate or drag never deselects the element or collapses the selection (the next press on the canvas clears that). A drag, resize, turn or crop-window move whose mouse release never reaches the window (it lost the mouse mid-drag) ends where it is at the next move with no button held, and the click after it is not swallowed.
- Changed: `useOverlayDrag`, `useOverlayResize` and `useOverlayRotate` call `onCommit` only for a gesture that moved something: a press and release in place commits nothing, and neither does a move that ends where it began. They used to commit the unchanged value, which saved and added an undo step. `SlideCanvas` also records nothing for a drag, resize or rotate that rounds back to where the element is, and for a group drag that does not move.
- Added: a Text background control in `TextFormattingToolbar` for an overlay that supports `bgColor` (§556): a swatch ("Text background") right after the text color, which previews a pick locally and writes `bgColor` once, when the picker closes, so one pick is one undo step, and a button ("No text background", shown only while there is a background) that writes `transparent`. While the box has no solid color the swatch starts on mid grey, because the native picker fires nothing for the color it already shows.
- Added: `reorderElement` takes `'front'` and `'back'` as well as `'forward'` and `'backward'` (`ReorderDirection`, in `projectReducer` and `UseProjectState`, and exported from the package index). The element goes all the way to the end or the start of the stacking order, the others keeping theirs; one already there changes nothing.
- Added: `editElements(slideId, edit)` on `UseProjectState`, backed by an `editElements` action in `projectReducer` (§556 review). `edit` is called once, synchronously, with the slide's elements as the project holds them when it lands, and its result is one save and one undo step, gated like every slide edit. The same array back writes nothing (no save, no undo step), and for a slide that is gone `edit` is not called. The carousel's writes built from a list (Delete and Cut on several elements, paste, Cmd/Ctrl+D, the layer keys, several images added at once) use it instead of `updateSlide({ elements })`, which wrote the editor's copy of the list over an element another writer (an AI, another window) had added since the editor last drew.
- Added: carousel element keys (§556): copy, cut and paste (Cmd/Ctrl+C, X, V), duplicate (D), select all (A, every element the host is not hiding), nudge (the arrows 1 px, with Shift 10 px), layer order (Cmd/Ctrl+] and [ one step, with Alt all the way to the front or back, matched by the physical key) and Esc to deselect. The clipboard is in memory (a ref in `CarouselEditor`, emptied when the project changes) and leaves the browser's own clipboard alone; a paste is claimed only when something was copied. Pastes and Duplicate step by 20 px (`COPY_OFFSET` in `carousel/clipboard.ts`) so copies never stack: each paste onto a slide lands one step further than the last, and the first one keeps the copied position, except on the slide they were copied from while one of them is still there, where it already steps off it (a Cut takes them away, so the first paste back lands where they were). `deepCloneElement` is now `cloneElement` (`structuredClone` and a fresh id), used by Duplicate slide and the panel's Duplicate too, so no clone shares a crop, overlay props or fonts with its source. A nudge is transient moves and one commit 500 ms after the last press or on the arrow's release; any other key, a change of selection or slide, losing focus and unmount commit an open burst first, so Cmd/Ctrl+Z right after it undoes it, and so do the toolbar's Undo and Redo. A burst that nets to zero (Right then Left) is given up with the new `discardTransient` of `UseProjectState` (it was on `useProjectSync`): no undo step, no save. `reorderSelection` (`carousel/layerOrder.ts`) keeps the selection's own relative order and changes nothing when nothing would move. None of these acts in crop mode, with no slide on show, while typing (a native select counts) or while the Controls window, the Render window, the overlay picker or a dialog of the host's marked `aria-modal="true"` is open, and the ones that edit, Delete included, need an editable project. `CAROUSEL_CONTROLS` lists every key and, under Canvas, the double-click to crop an image and Shift to free the ratio; the hint under the canvas names the double-click for an image.
- Changed: every carousel shortcut (Esc to place an armed note, undo, redo, Delete, N and the element keys above) is one `useKeymap` registry in `CarouselEditor`, in priority order, on `document`. It replaces three `window` keydown listeners; one key runs one shortcut, the first that matches. A test or host that dispatched keys on `window` must dispatch on `document`. `useKeymap` skips typing surfaces and holds every key while the Controls window, the Render window or the overlay picker is open (`AddElementMenu` reports the picker through the new optional `onOverlayPickerOpenChange`). `CarouselEditor`'s bindings also stand down while any element marked `aria-modal="true"` is in the document, so a dialog of the host's (the Library picker, an image preview) holds the keys too and the page keeps them. `isTypingTarget` now counts a `SELECT` (the video editor's keymaps share it). Esc in crop mode is left to `SlideCanvas`, which applies the crop. Delete uses `matchesDelete`, so Shift+Delete no longer removes elements, and, as the other editing keys, it needs an editable project.
- Changed: a multi-selection dragged onto another visual row moves every selected clip onto the track under the pointer, at the times the drag gives them (new `moveSelectionToTrack` in `multiSelectOps.ts`; `coarseItemKind` exported from `timeline-model.ts`). Above the top row it mints a new track; emptied tracks are pruned. The move is refused, and the selection snaps back with nothing committed, when any clip would overlap a clip on that track, two clips from different tracks would overlap each other, or a clip's kind does not match the track (a video clip never lands on an overlay track, and a group mixing the two cannot share one). Audio tracks and captions in the selection move only in time, and a drag that starts on one stays horizontal. The target track is judged after empty tracks are pruned, by `engine/validate.py`'s rules: no clip inside another except on tracks[0], and never three clips live at once. Over the pressed row the group move is unchanged until the pointer has left that row once; after that, coming back gathers onto it. Gathering the whole base track onto a new track keeps the base track's id and settings. One commit, one undo step. `Press` carries the press-time `layout`.
- Changed: the shuttle steps 1x, 1.5x, 2x, 4x (`SHUTTLE_STEPS`, was 1x, 2x, 4x; capped at 4x), backward the same (§532). `ShuttleDeps.onRateChange` reports every rate change, including the controller's own stop on an external seek, and `formatShuttleRate` gives the label (`1.5×`). `VideoEditor` shows it beside the preview timecode (`data-testid="playback-speed"`) when the rate is neither 0 nor 1.
- Changed: `CaptionListPanel` scrolls the selected caption's row into view when the selection changes (`selectedIds`), smoothly and only when the row is not fully visible, and not within 1.2 s of a wheel, touch or press on the list (§531). It never changes the tab, the search or the row filter.
- Changed: a ripple on the base footage track (the first track holding a video) moves audio tracks, notes and markers with the edit, and a ripple on any other track moves that track only (§527). `rippleDelete` moves the audio tracks that start at or after the deleted item's end earlier by its length; `collapseGaps` moves each audio track with the clip its start lies in (to where the gap closes when it starts in one), whatever `remapCaptions` says. Audio is only ever moved, never trimmed or deleted. Notes and markers inside a ripple-deleted window (`rippleDelete`'s base-footage item, `applyCutToTracks`'s range) are deleted and a note range over its edge is clipped; later ones move; one in a gap `collapseGaps` closes moves to where it closes. `insertClipAt`'s ripple insert on the base track, when it pushed its later items, also moves the other tracks' items, the captions, the audio tracks, the notes and the markers at or after the insertion point (straddling ones keep their start). `rippleDelete` and `insertClipAt` on any other track change that track only: the base track, other tracks, captions, audio, notes and markers stay (before, `rippleDelete` of an overlay moved every track and the captions). `shiftMarks` is new. See the root CHANGELOG.
- Added: `onBusyChange(busy)`, a `VideoEditor` prop and `useProjectSync` option, called when the editor goes busy or idle: busy is a save in flight or a gesture open (a preview not yet committed or cancelled). It fires on transitions only (never a repeated value, never on mount with false), a gesture that starts during a save keeps it busy until both end, and nothing is called after unmount. A throw from it is logged and never stops a save, a gesture or undo. Absent, nothing changes.
- Added: `EditorAdapter.subscribe`'s `onFrame` takes an optional second argument, the frame's writer (`FrameWriter`, `{ writer, origin? }`). A frame from writer `tool` with origin `sync` (a Studio sync pull) prunes the undo and redo history: a step that changed what the pull changed is dropped (per item, item list, track fields and track order within `tracks`; whole for other fields), the drop cascades to steps further back that changed what a dropped step changed, a step that cannot be rebuilt without guessing is dropped too, and every kept step is rebased onto the pulled document. `useProjectSync` takes `prunesHistory(writer?)` (the trigger) and `onHistoryPruned({ undo, redo })`; `VideoEditor` takes `onHistoryPruned`. An adapter that passes no writer behaves exactly as before.
- Added: `onFrame` takes an optional third argument, `FrameInfo` (`{ gap? }`), and `VideoEditor` and `useProjectSync` take `syncedProject` (default false). With `syncedProject`, a frame marked `gap` (the first after the transport reconnected, when a pull's stamp may have gone to no listener) prunes the history like a sync pull when its content differs from what the editor holds, whatever `prunesHistory` says; so does every `refetch`. An identical frame or refetch leaves the history as it was. Without it, both apply exactly as before, with no pruning. The mark is not a writer: `prunesHistory` still receives the frame's own writer, and the mark binds to that one frame.
- Changed: frames held while a save is in flight are applied in order when it finishes (a run of frames that do not prune keeps only its last). Each pruning frame (a sync pull or a gap frame) prunes against its own content, measured from the screen at that moment, and every other frame applies without pruning, so a frame on top of a pull (an AI write, the watcher's copy, an adapter's refetch) prunes nothing of its own and the history is the one the same frames give with no save in flight. A drain reports once. Frames held for one project never apply after a switch to another; a resubscription to the same project (a re-created adapter) still applies them. With `syncedProject`, the first frame of every subscription after the first is treated as a gap frame.
- Changed: `saveProject` receives the document as it was before the edit as an optional third argument, absent when the core cannot say (for example an external change arrived mid-gesture). A commit with no changes passes the current project.
- Changed: undo and redo restore only the fields the edit changed, so a field another writer changed since is not reverted. A `mutate` during an open gesture saves the gesture with it.

## 2.6.0

- Changed: the carousel's Render reports a failed or stalled save to the host through the new `onError({ title, detail })` prop instead of a system alert, and Render is enabled again. The save gives up after `renderSaveTimeoutMs` (default 30 s). A guard keeps `alert`, `confirm` and `prompt` out of the editor's source. See the root CHANGELOG (v5.35.0).

## 2.5.0

- Fixed: the preview shows the footage under an opaque overlay wherever the overlay is below full opacity (mid-fade or at 0), the rule the export uses. `planTick` asks `@bycrux/timeline-core`'s `opaqueReplacesPicture(item, seek)` for the tick's instant. See the root CHANGELOG (Unreleased).
- Fixed: a 3D item (`src: 'engine:scene3d'`) keeps its picture in place through a head trim, a split, a lift or collapse cut, a roll and a slide: `props.inPoint` moves with its head, and a head extended earlier stops at `inPoint` 0.
- Changed: `visualItemLabel` labels a 3D item `3D`, never its `src` or the id of its 3D.
- Changed: `OverlayContentPanel` shows no field for a 3D item's own props (`SCENE3D_PROPS`: `scene`, `inPoint`, `sceneFile`, `sceneJson`), which every write still carries, and nothing at all when it has no other prop.

## 2.4.0

- Changed: scrubbing the timeline is silent by default; the ear button turns sound on. `settings.audibleScrub` absent now means muted (it meant sound since 2.1.0); an explicit `true` or `false` is kept either way.
- Changed: "+ Language" calls the host's `onAddCaptionLanguage(have)` (`CaptionListPanel`'s `onAddLanguage`) with the languages the track already has (its `lang`, or `source` when unknown, then each translation), so the host can ask which one to add. The inline Copy-prompt popover is gone.

## 2.3.0

- Added: which languages the captions draw. `Captions.showLangs` (the source's code and each translated row's `lang`; absent draws every row) is applied to what the preview draws, through `captionSegmentsToShow` from `@bycrux/timeline-core`; `Captions.lang` is the source language. The caption panel's header gets a Languages row (one chip per language, at least one on) and, when the host passes `onAddCaptionLanguage` (a new `VideoEditorProps` and `CaptionListPanel` prop, `onAddLanguage`), a "+ Language" chip that opens a one-line pointer and a Copy prompt button which calls it. `captionLanguages` is new.
- Added: translated caption segments (`lang`, `translationOf` on `CaptionSegment`). The editor never fills in words for one, a text edit on one adds none, the preview's selection box and drag address the caption it sits under, and the regenerate warning counts only the rows a regeneration replaces. `isCaptionTranslation` is new.
- Added: a ninth caption style, `plate` (the phrase on one rounded plate, the spoken word in the accent colour). `Captions.style` gains `'plate'`; `Captions` and `CaptionSegment` gain `plateOpacity`, `platePadding` and `plateRadius`, and `backgroundColor` is the plate's colour. The caption panel offers a plate colour and opacity for it.
- Fixed: `computeAutoCrossfade` only pairs audio tracks that share a row (`lane`, or both without one) and a kind (`type`, absent meaning `audio`), so a voiceover under a split music bed is no longer faded into it.
- Documented: an overlay item whose `src` is `engine:scene3d` is a 3D scene item. The host's `compileOverlay` returns its own 3D stage for it; `scene` and `inPoint` show as the ordinary property fields. No editor code change.

## 2.2.0

- Added: the carousel editor selects several elements at once. Shift-click adds or removes an element; dragging moves them all, Delete removes them all, and Align aligns them to the box the selection covers. One save and one undo step each.
- Added: Distribute in the carousel inspector. With three or more selected, spread them evenly across or down, or set an exact gap in px.
- Changed: with Apply to all off, a Format change (size, font, weight, case, alignment, spacing, line height, colours) lands only on the selected captions, and dragging or resizing one of several selected captions moves or sizes all of them.
- Fixed: an overlay keeps its props object across a project echo, so a 3D overlay's camera keeps following its keys after a save.

## 2.1.3

- Fixed: 23 controls had no accessible name or role, so a screen reader or an AI driving the editor could not tell them apart. Fields are named, click targets get a role, and click-away layers are hidden from the tree.

## 2.1.2

- Fixed: with no source footage, the export dialog's resolution choices are never capped below 1080, so choosing 720p can be undone.
- Changed: overlapping scrub grains pass a soft limiter, so scrubbing never clips. Steady playback is unchanged.

## 2.1.1

- Fixed: after a pause, a click back on the play-start position seeks instead of being taken for the engine's own echo (`video/preview/useEnginePlayback.ts`).

## 2.1.0

- **Changed: the preview mixes its audio from one clock.** Once serve has conformed the sources, one AudioWorklet mixes the main track, overlay videos and lanes with the export's rules (speed, crossfades, fades, curves, ducking, mute), so there is no silence at cuts, and the picture, overlays and playhead are painted at the audible time (output latency compensated). Scrubbing and the reverse shuttle sound lanes and reversed audio. The `<video>` player uses the same mixer; an unconformed source keeps the previous behaviour. Needs serve's `POST /api/audio/conform` and `GET /api/audio/conformed`; a host without them stays on the previous path.

## 2.0.11

- **Fixed: a sped-up clip on the main track previews at its speed** in the `<video>` player: seek, `playbackRate` and reported time all apply `speed`, as `OverlayVideo` and timeline-core's `seekTime` do.

## 2.0.10

- **Added: carousel text effects and fit.** The inspector offers Effect presets (None, Shadow, Outline, Glow) with color and strength, a Fit to box switch (shrinks to a minimum size), and an Align row (six buttons, aligned to the slide). The export draws the same effect and fitted size as the preview.

## 2.0.9

- **Changed: carousel slide thumbnails show note bubbles instead of a whole-slide pin count.** One small speech bubble per tone (yours, then reviews, in the pin colours) counts all of that slide's `pins`, with a point or without, and is numbered only past one. A click selects the slide and calls `onPinClick` with that tone's first pin, without the thumbnail's own click or a drag. `data-slide-pin-count` is replaced by `data-slide-note-bubble` (with `data-tone`); thumbnails carry `data-slide-thumb`.

## 2.0.8

- **Changed: carousel note pins are text chips.** A pin is an 18 px badge with its `label` (accent for `tone: 'self'`, amber for `'review'`) instead of a dot. `SlidePin` gains `text` and `active`; `CarouselEditor` gains `pinDisplay` (`'badge'` default, `'chip'` adds the note's first words, collapsing to the badge where pins crowd until hovered). The `active` pin shows its whole text, or a blinking caret while empty. Past x 0.6 a pin opens leftward. The armed note cursor is an arrow with a chip, crosshair as fallback. New export: `SlidePinDisplay`.
- **Added: `CarouselEditor` takes `onSelectedSlideChange(slideId)`.** Called whenever the selected slide changes (the slide list, a slide added, duplicated or deleted, the notes api's `selectSlide`); not for the slide selected at mount, and not when the same slide is picked again.

## 2.0.7

- **Added: `EditorAdapter.canIsolateVoice`.** A host without stem separation sets it to `false`, and Audio polish hides Isolate voice. Omitted, it shows as before.

## 2.0.6

- **Added: the carousel editor takes `pendingSurface="host"`.** While a project is pending it shows the slide list and the selected slide's canvas, so slides appear as they are added, and draws no pending block of its own, leaving the prompt and progress to the host. Render stays disabled and no starter slide is created while pending. `'default'` is unchanged. Same option as the video editor's.

## 2.0.5

- **Fixed: an opaque overlay that does not cover the canvas no longer blacks out the footage.** `planTick` read any active `opaque: true` overlay as covering the frame, so a photo at scale 0.38 hid the clip behind black. It now reads `@bycrux/timeline-core`'s `opaqueReplacesPicture` (opaque AND scale 1, no offset or rotation, no keyframes other than `opacity`), the rule render uses. Needs `@bycrux/timeline-core` 0.4.0. See the root CHANGELOG (Unreleased).

## 2.0.4

- **Fixed: a timeline marquee released off the canvas keeps what it caught.** Released past t=0 over the track rail, or below the last lane, the browser's click for that press landed on an ancestor of the canvas and Timeline's background-click handler cleared the new selection. `TimelineCanvas` swallows that one click. No cap on selection size existed. See the root CHANGELOG (Unreleased).

## 2.0.3

- **Fixed: a project-relative overlay `src` previews.** `OverlayItemsLayer` passes the project id to the adapter's `compileOverlay(template, projectId?)` and `watchFile(path, onChange, projectId?)` for video overlay items (new optional trailing arguments), so the host can resolve `overlays/x.jsx` against the project the way render does. Bound once per project, so a frame change neither recompiles nor resubscribes. See the root CHANGELOG (v5.20.2).

## 2.0.2

- **Changed: the render dialog offers Natural, true-to-life HDR-to-SDR colour, as the default look.** Vivid and Neutral stay selectable. See the root CHANGELOG (v5.19.6).

## 2.0.1

- **Fixed: layered audio tracks no longer get a whole-length crossfade on open.** `computeAutoCrossfade` crossfaded any two time-overlapping audio tracks, so a music bed plus sfx both spanning the film got `fadeOut`/`fadeIn` equal to the whole overlap the moment the project opened. Only a sequential overlap (the earlier track starts first and ends first) crossfades now; containment and identical spans are layering and keep their fades. It also tests every later track starting inside a track, not just the next neighbour, so a layered track sorted between a real pair no longer hides it; a track in two pairs takes the longer overlap per side. Projects already written with the old fades are left as they are. Files: `video/timeline/timeline-model.ts`, `video/timeline/__tests__/timeline-model.test.ts`.

## 2.0.0

- **Removed: the HDR image tone feature (breaking for hosts).** The toolbar image-tone menu and the export dialog's "Image color" section are gone, along with the exports `ImageToneMenu`, `ImageToneMenuProps`, `IMAGE_TONES`, `DEFAULT_IMAGE_TONE`, `ImageTone`, `ImageToneInfo` and `TONE_EXAMPLES`, the `onProvideImageTone` prop on `VideoEditor`, `PreRenderOptions.imageTone`, and `EditorProject.settings.imageTone`. A host that passes `onProvideImageTone` or imports any of these must drop them. A saved `settings.imageTone` in an old project is ignored: it loads, renders and saves as before, the editor shows no tone control, and the key is left in place on save. Why: HDR renders convert the whole overlay capture with one mapping, so a per-image tone has nothing left to choose. Files: `video/ImageToneMenu.tsx`, `video/imageTone.ts`, `video/imageToneExamples.ts` (deleted), `video/VideoEditor.tsx`, `video/RenderModal.tsx`, `types.ts`, `schema.ts`, `index.ts`, `video/__tests__/VideoEditor.keymap.test.tsx`, `video/__tests__/RenderModal.options.test.tsx`, `__tests__/index-render-helpers.test.ts`
- **Fixed: overlays rescale when the project's resolution changes while the editor is open.** `PreviewPlayer` stored the overlay scale from a container observer set up once, so it kept the first render's design-canvas width after a resolution change. It now derives the scale from the observed width and the current canvas on every render (1 until the observer reports). Files: `video/preview/PreviewPlayer.tsx`, `video/preview/__tests__/PreviewPlayer.overlayScale.test.tsx` (new).
- **Fixed: a horizontal drag into an overlap keeps the item on its track.** `resolveTargetTrackIdx` rejected the item's own track once the overlap with a neighbour passed 30% of the item's duration, so a purely horizontal drag minted a new top track on whichever mousemove crossed that line, or on an edge auto-scroll tick with the pointer held still. The collision gate no longer applies to the item's own track while `Math.round(dy / VISUAL_ROW_HEIGHT_PX)` is 0 (`hasVerticalIntent`, new). With vertical travel the search is unchanged (fan-out, minting a top track); without it, only the kind gate can still move the item.
  - What the fan-out used to keep valid, `applyMove` now clamps, live on every move rather than at the drop: the start stops `EPSILON` short of the shapes `engine/validate.py` rejects (lines 566-635), containing or being contained by a neighbour on any track but tracks[0], and three items live at once on every track (`legalMoveStart`, the move's counterpart of `applyTrim`'s guard). A video clip on tracks[0] may still overlap or pass a neighbour; passing one on any other track takes vertical travel. Ripple mode is unchanged.
  - One drag is one save and one undo entry. Timeline's debounced crossfade passes (audio and overlay) committed whenever a drag into an overlap paused for `CROSSFADE_COMMIT_DELAY_MS`, a save and an undo entry per pause. `TimelineCanvas` reports a gesture through `onGestureActiveChange` (press to release) and Timeline holds both passes off until it ends; the drop's own commit carries the fades as before.
  - Files: `video/timeline/timeline-model.ts`, `video/timeline/canvas/pointer-machine.ts`, `video/timeline/canvas/TimelineCanvas.tsx`, `video/timeline/Timeline.tsx`, `video/timeline/__tests__/Timeline.overlapDrag.test.tsx` (new), `video/timeline/__tests__/_overlapRules.ts` (new), `video/timeline/__tests__/moveItemAcrossTracks.test.ts`, `video/timeline/canvas/__tests__/pointer-machine.test.ts`, `video/timeline/canvas/__tests__/TimelineCanvas.edgeScroll.test.tsx`, `video/__tests__/VideoEditor.test.tsx`.

## 1.10.1

- **Fixed: captions show in the preview on landscape projects.** `CaptionPreview` laid its caption layer out on a fixed 1080x1920 canvas scaled by the player's width / 1080. On a 1920x1080 project that layer was about 1.78x taller than the player, so a caption anchored 25% up from the bottom (every built-in style) sat below the frame and the wrapper's `overflow-hidden` clipped it. `CaptionPreview` now takes a required `designCanvas`, which `PreviewPlayer` passes as `getOverlayDesignCanvas(settings.resolution)`: the canvas the frame and the overlays are laid out on, and the one render.js captures captions at (1920x1080 for a 16:9 or 4K landscape project). Caption drag and resize use it too; on landscape a vertical drag saved about a third of the offset the pointer moved, since Y was measured against 1920. 9:16 is unchanged. Files: `video/preview/CaptionPreview.tsx`, `video/preview/PreviewPlayer.tsx`, `video/preview/__tests__/CaptionPreview.canvas.test.tsx` (new), `video/preview/__tests__/PreviewPlayer.captionCanvas.test.tsx` (new), `video/preview/__tests__/CaptionPreview.fonts.test.tsx`, `video/__tests__/captionPositioning.test.tsx`.

## 1.10.0

- **Added: `onProvideSeek` lets a host move the playhead, on `VideoEditor`.** It is called with a stable `seek(sec)`, like `onProvideRenderTrigger`. The seek goes through the editor's own clock, clamped to [0, duration], works playing or paused and never starts playback. The editor still does not seek on a pin click by itself; a host wires `onPinClick` to it. Files: `types.ts`, `video/VideoEditor.tsx`, `video/__tests__/VideoEditor.test.tsx`.

## 1.9.0

### Both editors

- **Added: `renderControls` lets a host draw the Controls window, on `VideoEditor` and `CarouselEditor`.** A host that passes it gets a `ControlsWindowContext` (`open`, `title`, `kind`, `sections`, `onClose`), and the package no longer mounts `ControlsInfoModal`.
  - `sections` is the modal's own content, platform-resolved: each entry's `keys` and `label` already read Ctrl, Alt and Shift off Apple, and each section carries its card's `icon`. The modal now renders through the same `platformSections`, so the two cannot drift.
  - Called on every render, `open` saying whether to show anything. The Controls button and the open state stay the editor's, so the video timeline's shortcuts are still held off while the host's window is open. Absent, nothing changes.
  - `ControlsWindowContext`, `ControlsWindowSection`, `ControlSection` and `ControlEntry` are exported from the index as types. `ControlEntry` and `ControlSection` moved to `types.ts`; `ControlsInfoModal` re-exports them.
  - Files: `types.ts`, `ControlsInfoModal.tsx`, `video/VideoEditor.tsx`, `carousel/CarouselEditor.tsx`, `index.ts`, `__tests__/platformSections.test.ts` (new), `__tests__/controls-window-types.ts` (new), `video/__tests__/VideoEditor.test.tsx`, `carousel/__tests__/CarouselEditor.test.tsx`.

## 1.8.0

### Video editor

- **Fixed: the preview frame stays W:H in a parent of any shape.** `PreviewPlayer`'s frame and `VideoEditor`'s preview box were `h-full max-w-full` plus `aspect-ratio`. The height is fixed at 100%, so the aspect ratio derives the width; when that width is wider than the parent, `max-w-full` clamps it and the height stays, so the box stops being W:H. A landscape project in a preview area narrower than its aspect hit it every time: the engine canvas fills the frame, so the picture played squashed, and overlays (scaled by the frame's width) drifted off the picture on both paths. Measured in Chrome: a 16:9 frame in a 900x600 row was 884x584 (aspect 1.514); it is now 884x497 (1.778), and 9:16 and wide rows are unchanged.
  - The frame is contain-fitted with container query units: its parent is a size container and the frame is `width: min(100cqw, calc(100cqh * W / H))` with `aspect-ratio: W / H`. `PreviewPlayer` brings its own size-container wrapper, so every host gets the fit (the review view and the mobile live view host it directly); `VideoEditor`'s preview row is a size container for its outer box.
  - The frame carries `data-montaj-preview-frame`. It is no longer the player's first element (the wrapper is).
  - Files: `video/preview/fitBox.ts` (new), `video/preview/PreviewPlayer.tsx`, `video/VideoEditor.tsx`, `video/preview/__tests__/PreviewPlayer.fitBox.test.tsx` (new), `video/preview/__tests__/PreviewPlayer.perAxis.test.tsx`.
- **Fixed: shortcut labels show Ctrl, Alt and Shift on Windows and Linux.** The command palette hints, the tooltips, the Controls list and the carousel Undo and Redo titles showed ⌘, ⌥ and ⇧ (or "⌘/Ctrl") on every platform. Shortcuts always worked with Ctrl; only the labels were wrong. Source data still writes the Mac glyphs and conversion happens when a label is rendered, through the new `ui/modifierKeys.ts` (`isApplePlatform`, `modifierKeys`, `shortcutText`). Mac is unchanged.
  - Files: `ui/modifierKeys.ts`, `ui/Tooltip.tsx`, `video/CommandPalette.tsx`, `ControlsInfoModal.tsx`, `carousel/CarouselEditor.tsx`, `video/keymap.ts`.
- **Fixed: tabbing past a colour swatch in the captions panel changes nothing.** `SwatchInput` committed on every blur, so a blur with no pick wrote the input's own value onto the colour, spent an undo entry and triggered a save. That value is `#ffffff` when the caption colour is unset, because the panel hands the input `toHex(..., '#ffffff')` and the native colour input reports it back. It hit the track text colour, one caption's text colour ("Apply to all" off) and the style accent swatch. `SwatchInput` now fires `onCommit` only when a pick changed the colour, so a blur with no pick and a pick that ends on the colour it started from commit nothing. A real pick is unchanged: live preview, one undo step, undo restores the old colour. Fixed once in the component, so every `onCommit` caller gets it (the overlay content panel too).
  - Files: `ui/SwatchInput.tsx`, `video/CaptionListPanel.test.tsx`, `video/__tests__/VideoEditor.captionGesture.test.tsx`.
- **Fixed: undo restores a caption's color and format after a live-previewed change.** The captions Format tab previews every intermediate value into the project (the transient channel, `handleProjectChange`) and commits once when the gesture ends. The commit was a bare `sync.mutate`, which records the project as it is at that moment as its undo snapshot, and by then the preview had already written the new value into it. So undo spent its entry and changed nothing. Measured on the selected caption's text color ("Apply to all" off), the track text color, the font size slider and box, letter spacing and line height; the accent color swatch commits the same way. "Apply to all" on was already correct.
  - `VideoEditor`'s new `commitCaptionProject` lands every such commit: it drops the live preview (`sync.discardTransient`), which puts the project back to where the gesture began, then does the one `sync.mutate`. `onCaptionEdit` and `handleCaptionSegmentChange` both go through it, so the fix is in the two commit channels and no control in `CaptionListPanel` changed.
  - The commit's project is built from what was on screen, preview included, before the discard, so nothing previewed is lost. A preview drag that lands while a color pick is still waiting on its blur keeps the pick, and its undo entry is the project from before the pick.
  - Unchanged: the preview still updates live and is not an undo step, a gesture is one undo step, and a slider or number box that changed nothing commits nothing.
  - Files: `video/VideoEditor.tsx`, `video/__tests__/VideoEditor.captionGesture.test.tsx`.
- **Added: an "Apply to all" checkbox in the captions panel.** It sits in the `CaptionListPanel` header, above the tab strip, so it shows on Format, Styles and Captions. Off (the default), nothing changes: a preview drag, a corner resize and the selected caption's text color change one caption. On, the same edit lands on every caption as the same absolute value (not a delta): a drag writes `offsetX`/`offsetY`, a resize writes `scale`, the swatch writes `color`. It is one undo step, and the preview shows every caption following the drag live. Text edits still change one caption. The value is remembered per browser (`localStorage`, key `montaj.editor.captionApplyToAll`) and is never written to the project.
  - `makeCaptionEditAll` (beside `makeCaptionEdit`) builds the all-segments change; it writes only `offsetX`, `offsetY`, `scale` and `color`, and is a no-op when every segment already holds the values.
  - `CaptionListPanel` takes `applyToAll`, `onApplyToAllChange` and `onCaptionAllSegmentsChange`; `PreviewPlayer` takes `captionApplyToAll` and `onCaptionAllSegmentsChange`. All optional: a host that passes none gets no checkbox and one-caption edits as before. `VideoEditor` wires them itself.
  - With the checkbox on, a swatch blur with no pick commits nothing, so tabbing past it cannot copy one caption's color onto the rest.
  - Files: `video/timeline/makeCaptionEdit.ts`, `video/preview/captionDragState.ts`, `video/preview/CaptionPreview.tsx`, `video/preview/PreviewPlayer.tsx`, `video/CaptionListPanel.tsx`, `video/VideoEditor.tsx`, and their tests.
- **Changed: selecting a caption keeps the playhead when it is already inside the caption.** A timeline caption click and a captions-list row click used to jump the playhead to the caption's start (plus half a frame) every time. They now jump only when the playhead is outside the caption. "Inside" is the on-screen rule: the frame-snapped playhead with `start <= t < end`, so at exactly `end` the jump still fires. Clip and overlay clicks still seek to the click point. The shared test is `playheadInside` in `video/captionSeek.ts`. (`video/captionSeek.ts`, `video/timeline/canvas/pointer-machine.ts`, `video/CaptionListPanel.tsx`, `video/__tests__/captionSeek.test.ts`, `video/timeline/canvas/__tests__/pointer-machine.test.ts`, `video/CaptionListPanel.test.tsx`)

## 1.7.0

### Both editors

- **Added: `renderModal`, a host-owned render window, on `VideoEditor` and `CarouselEditor`.** A host that passes it gets everything the package's own modal was given plus `open`, and the package no longer mounts `RenderModal` / `CarouselRenderModal` or calls `adapter.render`.
  - Video gets `RenderModalContext`: `projectId`, `adapter`, `preRenderOptions`, `exportActions`, `mode`, `onClose`, `onRenderComplete`.
  - Carousel gets `CarouselRenderModalContext`: `projectId`, `adapter`, `slidesCount`, `resolution`, `exportActions`, `mode`, `onClose`.
  - Both are called on every render, so a video host can refresh versions for a render that finishes while its window is closed. Absent, nothing changes.
  - `parseLogProgress`, `stepperPhases`, `phaseLabel`, `phaseIndex`, `RENDER_PHASES`, `pickSampleTime`, `sanitizeOutputName`, `resLabel` and `TONE_EXAMPLES` are now exported from the index.
  - Files: `types.ts`, `video/VideoEditor.tsx`, `carousel/CarouselEditor.tsx`, `index.ts`, `video/__tests__/VideoEditor.test.tsx`, `carousel/__tests__/CarouselEditor.test.tsx`, `__tests__/index-render-helpers.test.ts`.

### Video editor

- **Added: keyframed crop on video.** The Crop tab's diamond keys a video's crop, with `sourceWidth`/`sourceHeight` written in the same change; once keyed, the crop tool keys it at the playhead, while an unkeyed video's Apply still writes the static crop. `useVideoNaturalSize` probes the display size; a keyed video's crop modal locks to the keys' aspect and hides the shape choices. The preview draws the sampled crop for the base clip, upper-track videos and the scheduler. (`video/useVideoNaturalSize.ts`, `crop/VideoSourceCropModal.tsx`, `video/preview/PreviewPlayer.tsx`, `video/preview/OverlayItemsLayer.tsx`, `engine/scheduler.ts`)

- **Fixed: the preview showed source video outside a crop whose shape differs from its box, where the export shows empty space.** It now shows only the crop.
- **Fixed: a crop edit made while paused did not appear until the playhead moved.**

- **Added: pan and zoom a still inside its box.** The Crop tab and crop tool now open on images on any track, locked to the box's shape and opening on the crop at the playhead; the tab's diamond keys the crop there. `CroppedImage` draws an image through its crop in the preview, `CropKeyframeNav` is the tab's `‹ ◇ ›` unit, `keyframeOps` gains `writeCrop` and `toggleCropKeyframeAt`, and `VideoSourceCropModal` gains a still mode. (`video/preview/CroppedImage.tsx`, `crop/CropKeyframeNav.tsx`, `video/keyframeOps.ts`, `crop/VideoSourceCropModal.tsx`)

- **Fixed: the base clip's drag and wheel zoom started from the static value on an animated clip.** In a project with video on tracks[0], `PreviewPlayer`'s own base-clip gestures (move box, corner handles, wheel zoom) and the picture itself read the clip's static scale and offsets, while keyframes set what the export draws. A drag started from the wrong place and keyed a value the picture ignored, so the clip snapped back on release. The picture and those gestures now read the value at the playhead (`geometryAt`, clamped into the clip's span as the commit clamps it), so a keyframed base clip animates in the preview as it does in the export. Each commit passes `{ shiftAnimation }` (Option/Alt at release or on the wheel), so the host's `applyOverlayChanges` keys the playhead or shifts the whole animation exactly as for the overlay drag. A clip with no animation behaves as before. `PreviewPlayer`'s `onOverlayChange` prop type now names the third `options` argument. (`video/preview/PreviewPlayer.tsx`, `video/preview/useDragOverlay.ts`, `video/preview/__tests__/PreviewPlayer.baseClipKeyframes.test.tsx`)
- **Fixed: the inspector's keyframe diamond deleted the whole animation.** Its label said "Remove keyframe at playhead", but a click removed every keyframe of the property. A diamond is now filled only when a keyframe sits at the playhead, and a click adds one there or removes just that one. Removing a property's last keyframe keeps its value, so nothing moves. The Position diamond does the same for both axes. Every diamond and arrow now recognises the keyframe an arrow just landed on, which float rounding used to hide. `keyframeOps` gains `addKeyframeAt`, `removeKeyframeAt` and `toggleKeyframeAt`. (`video/keyframeOps.ts`, `video/OverlayInspector.tsx`, `video/__tests__/OverlayInspector.test.tsx`, `video/__tests__/keyframeOps.test.ts`)
- **Fixed: a drag, resize or rotate in the preview was thrown away on an animated clip or overlay.** The gesture wrote the static value, which keyframes hide on every frame and in the export, so the item snapped back on release and rendered unmoved. A gesture on an animated property now adds or updates a keyframe at the playhead, the rule every inspector control already followed. Hold Option (Alt) on release to move the whole animation by the drag instead: offsets and rotation shift by the same amount, scale by the same ratio. A property with no animation still takes the plain value. `useDragOverlay` exports `applyOverlayChanges` (the commit `VideoEditor` runs) and passes `onOverlayChange` a third `{ shiftAnimation }` argument; `keyframeOps` gains `writeProp` (moved out of the inspector), `writeGestureProp`, `offsetTrack`, `localTimeOf` and `keyframeTimeAt`. (`video/keyframeOps.ts`, `video/preview/useDragOverlay.ts`, `video/VideoEditor.tsx`, `video/OverlayInspector.tsx`, `video/preview/__tests__/useDragOverlay.keyframes.test.tsx`, `video/__tests__/keyframeOps.test.ts`, `video/__tests__/VideoEditor.test.tsx`)
- **Added: the Editor controls modal shows the editor's version.** The footer's bottom right reads `vX.Y.Z`, taken from `@bycrux/editor`'s own `package.json`. (`ControlsInfoModal.tsx`, `__tests__/ControlsInfoModal.test.tsx`)
- **Changed: "Generate captions" counts only clips the server can hear.** A timeline whose only video is muted, on a muted track or on a disabled track used to leave the button enabled, and the job then failed with a raw `no_audio`. The button now follows the server's rule: only an audible video clip, or an audio track, enables it. (`video/VideoEditor.tsx`, `video/__tests__/VideoEditor.emptyProject.test.tsx`)
- **Fixed: a regression from the previous release's blank-project change, which saved Media as the left rail's tab for every later project.** The blank project's switch to Media now updates the tab without writing it to storage, so projects with content still open on their own saved tab. `LeftPanelTabs`' `activationRequest` takes an optional `persist` (default true), and a user's own tab click still saves. (`video/VideoEditor.tsx`, `video/panels/LeftPanelTabs.tsx`, `video/panels/__tests__/LeftPanelTabs.test.tsx`, `video/__tests__/VideoEditor.emptyProject.test.tsx`)
- **Added: `slots.previewEmptyState`, the preview region of a blank project.** When a project has no items, captions or audio, a host-supplied node replaces the preview's "No clips" label and fills the whole region, so a host can make it the footage drop target. Absent, "No clips" shows as before. (`types.ts`, `video/VideoEditor.tsx`, `video/__tests__/VideoEditor.emptyProject.test.tsx`)
- **Changed: a blank project opens the left rail on Media.** In the media-panel layout, an editor that mounts on a project with no content switches to the Media tab even over a persisted tab. A project with content opens on its persisted tab as before, and selecting a caption still jumps to Captions. (`video/VideoEditor.tsx`, `video/__tests__/VideoEditor.emptyProject.test.tsx`)
- **Changed: "Generate captions" waits until the timeline has audio.** With no audio track and no video clip, the captions empty state's button is disabled and reads "Add a clip with sound first." `CaptionListPanel` takes the reason as a new optional `generateCaptionsDisabledReason` prop; absent, the button is enabled as before. The footer's "Regenerate captions" is unchanged. (`video/VideoEditor.tsx`, `video/CaptionListPanel.tsx`, `video/__tests__/CaptionListPanel.generate.test.tsx`, `video/__tests__/VideoEditor.emptyProject.test.tsx`)
- **Fixed: an audio track with no `end` was silent in the preview, though the export played it.** The preview's audio window read a missing `end` as 0, so the track was never inside it; a project whose voiceovers and SFX carried no `end` previewed only its one track that did. Such a track now plays to the end of its source slice, and a track whose window outlasts its file is left paused once the file is done instead of restarting from 0 on every tick. The window comes from `@bycrux/timeline-core`'s `audioSourceWindow`, the same one the export uses. (`video/preview/useVideoPlayback.ts`, `video/preview/useEnginePlayback.ts`, `video/preview/audioLane.ts`)
- **Fixed: a still image clip no longer shows a Volume tab.** A still has no audio; the clip panel now offers Volume for video clips only. (`video/panels/ClipPropertiesPanel.tsx`, `video/panels/__tests__/ClipPropertiesPanel.test.tsx`, `video/__tests__/VideoEditor.propertiesPanel.test.tsx`)
- **Fixed: the inspector's Position row clipped its keyframe controls at the default 300px rail.** The row needed 336px against 283px, so the section's clip hid the diamond. The row now wraps and the keyframe controls drop to a second line when they do not fit. (`video/OverlayInspector.tsx`, `video/__tests__/OverlayInspector.test.tsx`)

## 1.6.0 — 2026-09-28

### Video editor

- **Added: read-only host pins on the timeline ruler.** A new `pins` prop on `VideoEditorProps` takes `{ id, t, label }` entries and paints them as flags in the marker strip above the ruler, beside the user's own markers; `onPinClick` reports a click by the pin's id. Pins belong to the host alone: the editor never creates, moves, renames, deletes or persists one, and a pin never enters the project document, so passing pins cannot mark a project dirty or change a render. A pin is hit-tested before a user marker. Omitting the prop leaves the timeline exactly as it was. (`types.ts`, `index.ts`, `video/VideoEditor.tsx`, `video/timeline/Timeline.tsx`, `video/timeline/canvas/{TimelineCanvas.tsx,draw.ts,hit-test.ts,pointer-machine.ts}`, `video/timeline/canvas/__tests__/pins.test.tsx`)

### Schema

- **Added: `settings.motionBlur` and `settings.loudness` on the project type.** `motionBlur` (1 to 8 sub-frames per output frame, absent or 1 is off) and `loudness` (an integrated LUFS target, -30 to -5, absent is no normalization) mirror what the render engine now reads. Types only; the editor does not render either. (`schema.ts`)

## 1.5.1 — 2026-09-27

Everything below shipped between 1.0.0 and 1.5.1; per-version headings were not kept for that range.

### Video editor

- **Changed: the captions panel opens on the Captions list every time (no remembered sub-tab).** `CaptionListPanel`'s Format/Styles/Captions sub-tab used to default to Format and persist the last choice to localStorage; it now always mounts on Captions and the choice is plain component state, not read from or written to storage — switching tabs mid-session still works. (`video/CaptionListPanel.tsx`, `video/CaptionListPanel.test.tsx`, `video/__tests__/CaptionListPanel.generate.test.tsx`, `video/__tests__/CaptionListPanel.font.test.tsx`)

- **Added: the context report carries `playing`.** `EditorContext` gains an optional `playing`, which `useReportContext` sends with every report and at once on play/pause, so a host's agent can tell a parked playhead from a moving one. `PreviewPlayer` takes an optional `onPlayingChange(playing)`, called on mount and on each real play/pause change from whichever playback path is active. (`types.ts`, `video/use-report-context.ts`, `video/preview/PreviewPlayer.tsx`, `video/VideoEditor.tsx`)

- **Fixed: modals, popovers and menus were partly unreadable when hosted in a page with dark body text.** Everything the editor portals to `document.body` (Export, render progress and done views, Controls, Command palette, Audio polish, Caption regen, Version compare, Crop source, carousel render, overlay picker, social preview menu, track settings, tooltips) sits outside the editor root, so it inherited the HOST page's text colour; in the Montaj desktop app that is `#111827`, the same as the dark `--editor-surface`, so any text without its own colour class (or whose class the host's Tailwind did not emit, as with the old `/NN` modifiers) went dark on dark: the Export dialog's Cancel label and tier dims vanished. Every portal root now sets `text-[var(--editor-text)]` itself, and a guard test fails if a `fixed` root in a portalling component omits a text colour. Alongside: the Export dialog's selected tiles (resolution, frame rate, format, image color, tone curve) and the image color menu now use `--editor-accent` instead of a hard-coded violet; secondary text in these surfaces is raised to 60% of `--editor-text`; the render-log terminal and its Copy button use fixed white text on their fixed near-black ground (they were theme text, invisible in light mode); the render phase stepper and progress footer buttons follow the theme instead of a fixed near-black; the done view's download buttons and the carousel slide captions read correctly in light mode. (`video/RenderModal.tsx`, `video/ImageToneMenu.tsx`, `ControlsInfoModal.tsx`, `video/CommandPalette.tsx`, `video/AudioPolishModal.tsx`, `video/CaptionRegenModal.tsx`, `video/VersionCompare.tsx`, `crop/VideoSourceCropModal.tsx`, `carousel/CarouselRenderModal.tsx`, `carousel/OverlayPicker.tsx`, `video/preview/SocialPreviewMenu.tsx`, `video/timeline/TrackSettingsPopover.tsx`, `__tests__/portal-roots-set-editor-text.test.ts`, `video/__tests__/RenderModal.hostTheme.test.tsx`)

- **Added: `pendingSurface` and `onUserEdit` on `VideoEditor`, for hosts that own the pending gate.** `pendingSurface="host"` renders the full editor while `status === 'pending'` and draws no pending UI of its own, so the host can put its own overlay over a visible, editable project; `onBackToSetup` and `slots.pendingStatus` are unused in that mode, and the skill-path `getInfo` fetch is skipped. `onUserEdit` fires on every edit the user makes (edits, finished gestures, undo, redo) and never on server frames, so a host can tell its own user's edits from an agent's writes; `onProjectChange` cannot, since it also fires on SSE frames. It is fed by a new `onLocalEdit` option on `useProjectSync`, read through a ref so its identity never re-creates the core's callbacks. Backward compatible: `pendingSurface` defaults to `'default'`, today's behaviour. (`types.ts`, `state/use-project-sync.ts`, `video/VideoEditor.tsx`, `state/__tests__/use-project-sync.test.tsx`, `video/__tests__/VideoEditor.pendingSurface.test.tsx`)

- **Fixed: a failed save in the video editor rolled the edit back with no visible sign anything went wrong.** `sync.lastError` (`use-project-sync.ts`) was tracked but never rendered in `VideoEditor.tsx` — a rejected `saveProject` call reverted the optimistic edit silently, so the operator's change just vanished. `CarouselEditor.tsx` already surfaces the same field as a dismissible banner; `VideoEditor` now renders the identical pattern on its outermost container, above both layout branches, with a dismiss button that calls `sync.clearError`. (`video/VideoEditor.tsx`, `video/__tests__/VideoEditor.saveError.test.tsx`)

- **Fixed: the left media rail's inactive items (everything but the selected tab, e.g. Media/Versions next to a selected Captions) were unreadable — near-invisible dark text on the editor's dark background.** `LeftPanelTabs.tsx` colored them with Tailwind's `/NN` opacity modifier on an arbitrary CSS-variable value (`text-[var(--editor-text)]/60`, plus the selected tab's `bg-[var(--editor-accent)]/10` tint and the hover tint). That modifier only works when Tailwind can parse the color itself to inject an alpha channel — it cannot do that for an opaque `var(...)` reference, so the utility silently emitted NO rule at all, in this package's own Tailwind build and in a consumer's alike (measured under a host app's Tailwind v3.4: zero `editor-text`/`editor-accent` rules generated for any `/NN`-modified class here). With no color rule, the button fell back to an inherited/default text color, invisible against the editor's near-black background. Replaced with the same math baked directly into the arbitrary value instead — `text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)]` and so on — which compiles correctly in both builds since Tailwind never has to interpret the color at all, just emit it verbatim. (`video/panels/LeftPanelTabs.tsx`)

- **Fixed: the export dialog's cover picker offered no frames at all on a project made entirely of overlays.** The picker samples a grid of frames across the finished video, bounded by the dialog's `durationSec` — which was computed as the furthest `end` over the track-0 VIDEO items alone, the same list that feeds the SDR curve thumbnails' `keeps`. That reads track 0 as "the footage track", which holds only while there IS footage. An overlay-only project — one track of nothing but overlays, which the animations workflow emits routinely — measured `0`, so the grid came out empty and the dialog reported "No frames to pick from" for a project consisting entirely of pickable frames. The same defect had a milder form on ordinary projects: an outro overlay outliving the last clip was simply unreachable, because the grid stopped where the footage did. `durationSec` now comes from `visualDuration` (timeline-core's port of the renderer's own `getTotalDurationSeconds`: the furthest `end` over every item on every track, audio excluded), so the picker spans exactly what the export will contain. Disabled tracks stay out, since the render skips them too. `keeps` is deliberately NOT widened to match — it answers a different question, namely which windows hold real footage the curve thumbnails can sample, and an overlay-only project genuinely has none. (`video/VideoEditor.tsx`, `video/__tests__/exportDurationSec.test.ts`)

- **Added: press `M` to drop a marker on the timeline — a small, named flag pinned to a moment, drawn in a strip along the very top, above the ruler.** The strip only exists once a project actually has a marker (`computeTimelineLayout` reserves it only when `project.markers` is non-empty), so a project without one lays out at the exact same pixel it always has. A new marker gets an auto-number (`nextMarkerLabel` reads the highest purely-numeric label currently in use and hands out one more) instead of an empty box to fill in, so dropping one never interrupts the edit to type a name; delete marker "2" out of 1/2/3 and the next one is still "4", never a reused "3", and naming a marker "cut this" contributes nothing to the count, so renaming can never stall or rewind it.

  `M` drops the marker at the playhead, except when the preview axis (`⌘`/`Ctrl`+`A`) is on, where it drops on the yellow line the operator is actually looking at instead (`markerDropTime`, deliberately `??` rather than `||`, since a hovered `0` — the very start of the timeline — is still a legitimate drop point, not a signal to fall back to the playhead), falling back to the playhead anyway if the axis is on but the pointer has left the timeline. This mirrors the rule Split (`S`) already follows rather than inventing a new one.

  Holding `M` down doesn't spray markers across the strip: `addMarker` hands back the exact same project reference, unchanged, whenever a marker already sits within half a frame of the requested time, and the caller reads that as a no-op instead of pushing an empty undo entry. Key repeat fires at whatever rate the OS picks — easily several times a second — and cleaning up a pile of stacked near-duplicate markers is worse than the rare case of genuinely wanting two markers a frame apart, which the half-frame window is narrow enough to leave alone.

  Double-click a marker's label to rename it inline, in a real `<input>` positioned over the canvas — the one text editor this canvas hosts directly, since caption text edits route to the sidebar instead. `Enter` or clicking away commits; `Escape` cancels; a blank or all-whitespace name is refused rather than saved, because clearing the box means "leave it alone," and deleting the marker is the actual way to get rid of it. Dragging a marker along the strip retimes it, grab-relative like every other drag on this timeline (`dragDeltaSeconds`): it preserves the offset between where the pointer grabbed the flag and the flag's own position, rather than snapping the marker to meet the cursor. That matters here specifically because a marker's clickable region is 72px wide so the *label* is grabbable and not just its 2px flag stem, which means a press routinely lands well right of the flag itself.

  Selecting a marker and pressing Delete removes it. Markers live at `project.markers`, outside `tracks`/`audio`, so the existing multi-select delete path can't see them on its own; `Timeline.tsx` folds `removeMarkers` into the same commit, so a mixed selection of clips, captions and markers deletes as one undo entry, not several. Markers are saved with the project and covered by undo/redo like any other edit, and the renderer ignores them completely — an editing and communication aid, never part of the export. That communication purpose is the actual point of the feature: every marker's name and time now reaches the agent through the editor's context endpoint, alongside the playhead, the clip under it, and the transcript it already receives, so naming a marker is how an operator tells the agent what to do and where. (`schema.ts`, `video/timeline/markers.ts`, `video/timeline/canvas/draw.ts`, `video/timeline/canvas/hit-test.ts`, `video/timeline/canvas/pointer-machine.ts`, `video/timeline/canvas/TimelineCanvas.tsx`, `video/timeline/Timeline.tsx`, `video/VideoEditor.tsx`, `ControlsInfoModal.tsx`, `index.ts`, `video/__tests__/markerDropTime.test.ts`, `video/timeline/__tests__/markers.test.ts`, `video/timeline/canvas/__tests__/draw.test.ts`, `video/timeline/canvas/__tests__/hit-test.test.ts`, `video/timeline/canvas/__tests__/pointer-machine.test.ts`, `video/timeline/canvas/__tests__/TimelineCanvas.test.tsx`, `video/timeline/__tests__/Timeline.keymap.test.tsx`, `video/__tests__/VideoEditor.keymap.test.tsx`)

- **Fixed: cutting an audio track manufactured a fade-out at the razor, every time.** `splitAudioTrack` built both halves by spreading the original track, so both fragments inherited BOTH fades — including on the two edges the cut had just created. On a voiceover carrying the usual trailing fade-out, every cut left the left fragment ramping to silence into the razor (and the right fragment fading in out of it), which the operator then had to zero by hand on each new piece. Fades are added deliberately; a cut is not a request for one. Each half now keeps only the fade whose edge it still owns — the left half the original START and its `fadeIn`, the right half the original END and its `fadeOut` — and the two new edges at the cut carry no fade at all. Splitting repeatedly follows from that: a middle fragment owns neither original edge and so carries neither fade. Each fade's curve travels with it, since a `fadeOutCurve` describing a fade-out that no longer exists is dead data and the next hand-drawn fade should start from the default shape. A kept fade is also clamped to its own fragment's span — a 3s fade-out is fine on a 20s track, but split that track 1s from its end and the fade no longer fits the fragment it lands on, and nothing downstream re-clamps (the pointer-machine and the properties panel each clamp only their own edits, and the render just anchors `st = end - fadeOut`). The auto-crossfade pass is unaffected and was never the cause: it needs a genuine overlap, and a split produces adjacent fragments. Splitting a track that carries no fades is byte-identical to before — no field is invented. (`video/cuts.ts`, `video/__tests__/cuts.test.ts`)

- **Fixed: a project whose visuals all sit on the first track would not play at all — space and the play button did nothing, on a timeline that showed the right duration.** A project with no video clips on `tracks[0]` runs the preview's canvas clock, whose ceiling was read off the *overlay* tracks alone (`tracks.slice(1)`). That is a safe reading only while `tracks[0]` holds primary footage, and in canvas mode it does not — it holds content: the background images, and on an agent-authored project frequently the overlays themselves. An animations-workflow project is routinely ONE track of nothing but overlays, and for exactly those the ceiling summed to `0`. The transport then started and stopped inside the same frame: the first tick clamped the playhead to `0` and called `setIsPlaying(false)`, so the picture never moved and nothing was logged, because nothing had failed — the clock had simply been told the project was zero seconds long. A canvas project whose track-0 background image outlasted its last overlay stopped early for the same reason. Both playback paths carried the defect independently and both are fixed, so falling back from the WebCodecs engine to the legacy `<video>` player would not have helped and no longer differs here. The ceiling now spans every enabled track, track 0 included, which is what `OverlayItemsLayer` has always DRAWN in canvas mode (`isCanvasProject ? enabledTrackItems : overlayTracks`) — the transport was the one component disagreeing with what was on screen. The clamp itself is unchanged and still stops playback at the last frame of content rather than running past it. Audio deliberately stays out of the canvas ceiling: that canvas/video divergence is documented in `timeline-core`'s `durations.js` and changing it would alter playback length for every existing canvas project, which this fix does not do. Nothing about project files changes — no migration, no re-save, and a project that played correctly before plays identically. (`engine/scheduler.ts`, `engine/__tests__/scheduler.test.ts`, `video/preview/useVideoPlayback.ts`, `video/preview/__tests__/useVideoPlayback.canvasClock.test.ts`)

- **Fixed `textTransform` at its source, so a consumer's typecheck actually passes.** `1.0.2` narrowed `CaptionSpecimen`'s `textTransform` prop to `CSSProperties['textTransform']`, but left `Captions.textTransform` in `schema.ts` as a bare `string` — so the error did not go away, it MOVED to the call site that feeds the component, surfacing as the same `TS2322` at `CaptionStyleGallery.tsx:445` instead. Because this package ships raw TypeScript, a type error inside it is a hard build failure in any consumer (`skipLibCheck` only covers `.d.ts`, and `exclude: node_modules` does not stop TypeScript following imports), so this blocked a consumer app's `next build` outright with no fix available on their side. The field is now a named, exported `CaptionTextTransform` union — `'uppercase' | 'lowercase' | 'capitalize' | 'none'`, exactly what the comment on that line already documented — and `CAPTION_STYLE_TEXT_TRANSFORM` is keyed to it too, so both the write path (the case chips, already `as const`) and the read path narrow from one declaration. No runtime or behavior change: the values written and rendered are the same ones as before. The lesson worth keeping: narrowing a consuming component instead of the field it reads relocates this class of error rather than removing it. (`schema.ts`, `video/captionStyleDefaults.ts`)

- **Added: overlapping two items on the same track — clips or overlays — now crossfades between them, live in the editor's own preview.** `computeVisualCrossfade` derives complementary `opacity` keyframes for an overlapping overlay pair (`timeline-model.ts`), the same way `computeAutoCrossfade` already did for audio tracks, and lands through the same two commit paths: `commitTimelineEdit` folds it into the SAME undo step as the gesture that created the overlap (a drag or a trim), so dragging one overlay onto another never produces a bare move followed by a separate fade commit; a second, debounced pass in `Timeline.tsx` is the catch-all for an overlap that appears OUTSIDE a gesture — ripple-delete, gap-collapse — which reach `sync.mutate` directly and never pass through `commitTimelineEdit` at all. Both passes are idempotent, so an unaffected project, or one whose fades already converged, triggers no extra save.

  An overlay track's trim now lets an edge be dragged past a neighbour's NEAR boundary — a partial overlap is a transition, not a mistake — but not far enough to fully contain it, which the validator still rejects (`timeline/canvas/pointer-machine.ts`). `tracks[0]`'s own trim is unchanged; it never had a neighbour-overlap guard to begin with.

  The engine's own preview composites the same blend the render does: two decode sessions running side by side, painted together in one `Painter.paintBlend` call each frame. The commonest crossfade on a silence-trimmed timeline is between two CUTS OF THE SAME TAKE — trim a pause out of a clip and its neighbours are two segments of one source file — which a single `FrameServer` per source (refcounted by clip) can't serve two decode positions from at once. A clip that's the incoming side of such a pair can now ask for its own exclusive decoder for the length of the transition (`SourceRequest.exclusiveServer`), so both sides decode independently instead of one starving the other.

  The legacy `<video>`-element player has no compositing stage to blend two frames with — it plays one `<video>` per clip and hard-cuts between them, which it always did and still does for everything else. A project that falls back to it (background removal in v1, or simply an older host) now shows a persistent banner reading "Crossfades will not appear in this preview. They will render in the export." instead of silently disagreeing with what the export will produce; the banner tracks live, appearing and disappearing the instant an operator drags two clips into or out of overlap. (`video/timeline/timeline-model.ts`, `video/timeline/__tests__/timeline-model.test.ts`, `video/VideoEditor.tsx`, `video/__tests__/VideoEditor.test.tsx`, `video/timeline/Timeline.tsx`, `video/timeline/canvas/pointer-machine.ts`, `video/timeline/canvas/__tests__/pointer-machine.test.ts`, `engine/scheduler.ts`, `engine/index.ts`, `engine/__tests__/scheduler.test.ts`, `engine/__tests__/engine.test.ts`, `engine/__tests__/source-host.test.ts`, `engine/eligibility.ts`, `engine/__tests__/eligibility.test.ts`, `video/preview/PreviewPlayer.tsx`, `video/preview/__tests__/PreviewPlayer.engine.test.tsx`, `video/preview/OverlayItemsLayer.tsx`, `video/preview/__tests__/OverlayItemsLayer.keyframes.test.tsx`, `schema.ts`)

- **Filesystem-drop ghost lands on the video row the clip will.** A dropped desktop video's pre-ingest ghost band used to draw on whatever row the pointer released over — an overlay or image row included — even though the finished clip always resolves to a video row. It now resolves to that same video row, via a new shared `resolveDropTrackIndex` (exported beside `placeDroppedClip`), so the ghost and the placement can never disagree. (`video/timeline/placement.ts`, `index.ts`)

- **Caption Format tab: a slider on font size, bigger row labels, and the one-word preview is gone.** Font size now has the shared slider next to its typeable box (drag for a quick size, type for an exact one — both drive the same live value), the Format-tab row labels are a touch larger, and the small specimen box that showed a single word for a whole-sentence style has been removed (the Styles gallery is the size-faithful preview). (`CaptionListPanel.tsx`, `CaptionSpecimen` usage dropped)

- **Fixed `CaptionSpecimen`'s `textTransform` TypeScript type.** The `textTransform` prop was typed as `string` and assigned into a `style` object, where React's `CSSProperties` expects a specific `TextTransform` literal union. This caused `tsc --noEmit` to fail in any consumer typechecking against the package's TypeScript sources (since the package ships raw TS, `skipLibCheck` cannot mask it). It is now correctly typed as `CSSProperties['textTransform']`. (`CaptionSpecimen.tsx`)

- **Selecting a caption anywhere jumps the left panel to its Captions tab.** Clicking a caption on the timeline, in the preview, or in the list now switches the browser panel to Captions, so its controls are in front of you. It never fights a manual tab choice on mount, and re-selecting the same caption still snaps back. (`panels/LeftPanelTabs.tsx`, `VideoEditor.tsx`)

- **Transform tab: dropped the redundant "TRANSFORM" heading.** The CONTENT/TRANSFORM tab already names the pane, so the second heading is gone; the reset-all and keyframe-all controls stay, now under a compact "All" label. (`OverlayInspector.tsx`)

- **Accent text is legible in light mode.** The indigo accent used as ~10px text was marginally under the AA contrast floor on the light theme; a new `--editor-accent-text` token darkens accent *text* to indigo-600 in light mode only (fills, borders, rings and buttons keep the accent), applied at the ducking badge and the active left-panel tab. (`theme.ts`, `panels/ClipPropertiesPanel.tsx`, `panels/LeftPanelTabs.tsx`)

- **Caption style gallery reads consistently, and the pending screen's light-mode text is visible again.** With every caption template now anchored at the same height (see the app changelog), the gallery's seven cards frame their captions identically. Separately, the "project id" line and "Back to setup" link on the pending screen were near-invisible on a light background (a var-opacity class that silently no-ops) and now use a real tint. (`CaptionStyleGallery.tsx`, `VideoEditor.tsx`)

- **One number box and one slider everywhere.** Entering a number used to mean
  a different control depending on where you were: the clip Transform tab had a
  nice typeable box with up/down arrows, caption font size was a slider you
  could not type an exact value into, and the rest were plain boxes with no
  arrows. Every numeric field in the editor now uses the same control — type a
  value, nudge it with the arrows, and it previews live and commits when you
  click away. That covers caption font size (now a typeable box with arrows
  instead of a slider), letter spacing and line height, clip fades, ducking and
  trim points, overlay properties, the custom loudness target, the carousel
  slide properties, and the text toolbar's font size. Typing an exact font size
  also reaches sizes the old 28-120 slider could not. Every remaining slider —
  scale, volume, speed, and the version-compare scrubber — is now one shared
  control with a thin track and a round accent thumb, identical in light and
  dark. The Transform tab's number boxes are unchanged — they were the
  reference the rest moved to; its scale slider picked up the new thumb along
  with every other slider.
- **Dragging a clip to the edge of the timeline now scrolls faster the harder
  you push, and the clip stays under your cursor.** Edge auto-scroll used to
  jump to one flat speed the moment the pointer reached the edge, so there was
  no way to ask for "faster" — it now ramps with how far past the edge the
  cursor sits, from a gentle nudge up to a capped maximum, still stopping
  cleanly at the start and end of the timeline and still measured in real
  elapsed time so it feels identical at 60Hz and 120Hz. The dragged clip also
  used to stay put in time while the view scrolled out from under it, drifting
  away from the pointer; every horizontal gesture (move, trim, roll, slip,
  slide, audio, keyframes, captions) now measures its travel in timeline time
  instead of screen pixels, so what you drop is what you saw under the cursor.
- **Fixed: dragging a clip onto a different track ignored the clips already on
  it.** Moving a clip onto another track used to show no snap guide and refuse
  to click into place, even when it fit a gap on that track exactly. Snapping
  now follows whichever track the clip is actually hovering over, so it lines
  up flush with the clips beside it.
- **Fixed: turning on a social-media preview from "None" showed nothing until a
  page reload.** The safe-zone chrome overlay attached its size observer only
  once, on mount — and while "None" was selected the observed element wasn't in
  the DOM, so switching to TikTok/Instagram/YouTube mounted the chrome but never
  measured it, leaving it invisible until a reload happened to remount it with a
  platform already set. The observer now re-attaches whenever the platform
  changes, so the chrome appears the instant it is turned on.
- **The social-media preview chrome is closer to each app.** TikTok and YouTube
  Shorts now draw their bottom tab bars; YouTube adds a top-left back arrow and a
  solid-white Subscribe pill; Instagram adds the reshare action to its rail and
  the bottom add-comment bar. Still generic placeholder content and icon-only
  marks throughout — never real account data or platform wordmarks.
- **Fixed: Dolby Vision sources no longer fail the export.** A DV clip (e.g. an
  iPhone HDR recording) carries a Dolby Vision RPU that propagated untouched
  through the pipeline into libx265, which re-emitted it in-band; the MP4 muxer
  then died with "Error submitting a packet to the muxer: Not yet implemented in
  FFmpeg". Montaj outputs HDR10/HLG, never Dolby Vision, so the segment encoder
  now strips the DV RPU (HEVC NAL 62) on the HDR path, leaving plain HEVC with
  its HDR10 metadata intact. No effect on SDR or non-DV sources.
- **The render progress bar tracks total work, not just phase headings.** The
  two heavy phases — overlay assembly and composition — now advance the bar by
  their real per-segment counters, so it climbs steadily through the actual work
  instead of leaping to nearly full on a phase heading and freezing there.
- **UI polish.** The clip **Crop** tab is a centered icon + description + button
  rather than a bare line of text; the Export dialog's resolution tiles drop the
  overflowing "recommended" badge (the pre-selected tile already says it).
- **Fixed: dragging the selected keyframe diamond no longer drops its selection.**
  Retiming a selected diamond used to leave the selection pointing at the OLD
  time, which the drag had just vacated, so the diamond visually deselected the
  instant you dropped it. The selection now follows the diamond to its new time;
  Delete still removes the followed keyframe.

- **Video and image clips can be keyframed.** A clip's position, scale and
  rotation now animate over its own lifetime, using the same keyframe controls,
  curve maths and easings overlays already had — and, unlike before, the export
  reproduces the motion. The renderer compiles each curve into a time-varying
  ffmpeg filter expression rather than composing one static box per segment.
  Keyframing a clip previously did nothing at all: it animated neither in the
  editor nor in the export. Overlays are unchanged, and a project with no
  keyframed clips renders byte-identical ffmpeg arguments to before.

  **Opacity is the exception and cannot be animated on a clip.** ffmpeg applies
  alpha through a filter that accepts a fixed number and no expression, so a
  fade cannot be expressed on that path at any cost. The opacity keyframe
  control is therefore shown *disabled* on a video or image clip with a tooltip
  explaining why, rather than silently doing nothing, and double-clicking a clip
  to key every property skips opacity. Overlays still animate opacity normally.

- **BREAKING: the DOM timeline is removed — canvas is the only timeline.**
  The `VideoEditor` `timeline?: { canvas: boolean }` prop is gone from
  `VideoEditorProps`; a host that still passes it fails typecheck. The old
  DOM-rows implementation (one positioned `<div>` per visual clip / audio
  item) is deleted from the package outright, not kept behind a flag. A host
  that never passed the prop typechecks with no changes required, but its
  runtime behavior changes silently: it used to fall onto the DOM-rows path
  by default, and now gets the canvas timeline instead — which needs
  `EditorAdapter.getWaveformPeaks` and `getFilmstrip` implemented to draw
  per-clip/audio-lane waveforms and filmstrip thumbnails. Both stay optional
  and feature-detected, so a host missing either loses that imagery with no
  error, not a crash. A full migration runbook for consumer hosts — exact
  adapter method signatures, greppable call-site patterns, and a verification
  checklist — is maintained internally.
- **Ported the subcut-regenerate control to the canvas timeline.** It used to
  be a Scissors button on the old DOM clip rows, which would have made it
  unreachable — and effectively retired for good — once those rows came out;
  instead it moved across intact. It appears on a selected clip once the host
  enables regeneration, the clip still carries its generation provenance, and
  the clip is at least 3 seconds long, the same conditions the button always
  required. A "queued" badge shows on a clip the host reports as queued, but
  the button itself stays clickable while queued, so a queued clip can still
  be reopened and resubmitted rather than getting locked out. Clicking the
  button toggles the tool open and closed. It's rendered as a real HTML
  control positioned over the canvas surface rather than painted into it, so
  it keeps a genuine button's accessible name, title, and hover state, and it
  now has test coverage it never had before.
- **Reorganized the editor panels: left browses, right inspects.** The left
  sidebar is now a tabbed browser with an icon rail — **Media**, **Captions**
  (the default) and **Versions** — and the right panel holds only the
  properties of what is selected. Previously one sidebar stacked both jobs,
  which is why the version list felt cramped and the properties panel had
  nowhere to grow. The tab shell (`video/panels/LeftPanelTabs.tsx`) is generic:
  a new tab is one `{ id, icon, label, content }` entry, so Audio/Effects/Text
  drop in later without touching it. The active tab persists across reloads,
  and a tab keeps its state (scroll position, sub-tab, a half-finished edit)
  when you switch away and back. The right panel is always present, showing a
  short prompt when nothing is selected, so the preview and timeline never
  resize as selection changes. The preview and timeline themselves are
  unchanged. This applies to the three-column layout (the one a host opts into
  with `slots.mediaPanel`); the classic layout's arrangement is untouched.
- **The right properties panel has a real empty state, brandable by the host.**
  With nothing selected it now shows a vertically centered "Select an element"
  prompt in place of the old terse one-liner. A host can replace it via the new
  `slots.propertiesEmptyState` (Montaj renders its logo there); absent, the
  package's generic centered default shows. Classic layout unaffected.
- **Version history shows every version, by name and date.** The list no longer
  collapses to one row per backend "run", and the "Run N" prefix is gone: run
  is plumbing that was never meant to surface, and collapsing by it hid real
  saved versions. Each version is now its own row with **Compare** and
  **Restore**, newest first, with auto-generated labels humanized ("Draft",
  "Exported", "Auto-save before restore", "Untitled save") and operator-typed
  names shown verbatim. Compare and Restore behave exactly as before.
- **BREAKING: `renderClipInspector` is removed** from `VideoEditorProps`, and
  clip properties are now edited in the right panel instead of a modal.
  Selecting a video clip edits its volume, mute and speed there; selecting an
  audio track edits its label, volume, mute, fades, ducking, trim and position.
  A host no longer supplies any of that. Hosts with host-only per-clip UI use
  the new, narrower `renderGenerationPanel?: (ctx: { clipId: string }) =>
  ReactNode` seam, which the editor renders inside the properties panel beneath
  the clip properties when a video clip is selected. Deleting an audio track is
  deliberately not in the panel (destructive, and the panel is somewhere you
  land just by selecting) — the timeline's Delete/Backspace still does it.
- **Speed changes from the panel still ripple.** The retired modal closed the
  gap a speed-up leaves behind when the magnet is on; the editor's commit
  handler now owns that, folded into the same undo step as the speed change
  itself.
- **Redesigned the overlay properties panel as a Transform inspector.** The flat
  stack of five number fields is now a sectioned panel: a **Scale** slider with
  X/Y boxes and a uniform-scale lock, **Position** X/Y, a **Rotate** box with a
  circular dial (keyboard operable, Shift for coarse steps), **Opacity**, a
  six-button **Align** row that snaps to the frame edges using the same math as
  the preview's drag snapping, and a **Reset**. Every animatable row keeps its
  keyframe diamond, and the section header gains a keyframe unit covering all
  five properties at once plus arrows that jump the playhead between keyframes.
  When nothing is selected the panel shows a short prompt instead of vanishing.
  Keyframe persistence is unchanged: every control routes through the same
  auto-keyframe rule, so editing an already-animated property adds a keyframe
  at the playhead rather than overwriting the animation.
- **Keyframe diamonds are now on the canvas timeline itself, not just the
  panel.** A selected, keyframed overlay draws a diamond strip along the
  bottom of its clip, one per distinct keyframe time. Double-clicking the
  clip keys all five transform properties at the instant you clicked, each at
  the value it already holds there, so nothing moves; double-clicking a
  diamond selects it (its fill
  turns white); dragging a diamond retimes it with snapping to the item's
  other keyframe times, landing on one merges the two; right-click opens a
  menu for per-property easing and removal; and Delete/Backspace removes
  every property keyed at the selected instant. Keyframing stays
  overlay-only, a render constraint rather than a UI limitation.
- **Captions can now be generated by the host as a background job, instead of
  the editor's blocking modal.** `VideoEditorProps` gains two optional props:
  `onRegenerateCaptions` and `captionsGenerating`. When a host provides
  `onRegenerateCaptions`, the editor delegates the Captions panel's trigger to
  it and never mounts its own `CaptionRegenModal`, so the host can run
  generation in the background and report progress wherever it likes;
  `captionsGenerating` lets it disable the trigger while a job is in flight,
  and is OR'd with the editor's own modal state rather than replacing it. A
  host that passes neither prop is completely unaffected — the built-in modal
  remains the default and the only path, so embedding apps need no changes.
- **BREAKING: `OverlayPropsModal` is removed — overlay props move into the
  properties panel.** The floating "Edit overlay" modal is gone, along with
  the Pencil "Edit overlay" button that opened it. An overlay's props are now
  edited in the right properties panel under a new **Content** tab (the
  default), with the existing Transform inspector as the second tab; the
  active tab persists (`montaj.editor.overlayPanelTab`). Double-clicking an
  overlay in the preview now selects it — it no longer opens a modal. Edits
  preview live against the canvas and commit on blur as a single undo step;
  there is no Save button and no Cancel, undo is the revert path. A host that
  imported `OverlayPropsModal` directly will fail to resolve it; the file is
  deleted, not deprecated.
- **BREAKING: `PreviewPlayer` takes a `clock`, replacing `currentTime` /
  `onTimeUpdate`.** `PreviewPlayerProps` drops `currentTime: number` and
  `onTimeUpdate: (t: number) => void`, and gains a required
  `clock: PlaybackClock` — an external store for the playhead
  (`{ get, set, subscribe }`), written at playback rate so that only the
  components which actually render the time re-render. Unlike the rest of this
  release's breakage, this one fails **loudly**: the prop is required, so a
  host still passing the old pair gets a hard `TS2322` at the call site rather
  than quietly losing a feature. It affects hosts that mount `<PreviewPlayer>`
  directly only — a `<VideoEditor>`-only host is untouched, which is why it is
  easy to miss when auditing the surface. Migrate by replacing the
  `currentTime` state with a stable clock —
  `const clock = useMemo(() => createPlaybackClock(0), [])` — and passing
  `clock={clock}`; read the time, where you actually need to render it, with
  `usePlaybackTime(clock)`. Both helpers are exported from the package root.
  Two traps: the clock must have stable identity (a bare
  `createPlaybackClock(0)` in the render body mints a fresh one every render
  and breaks playback silently), and reintroducing a `useState` mirror of the
  time reinstates the per-frame re-render the external store exists to remove.
- **Overlay scale can now be non-uniform.** `VisualItem` gains optional
  `scaleX`/`scaleY`; when absent the item falls back to `scale` exactly as
  before, so every existing project renders byte-identical. The Transform
  panel's "Uniform scale" lock (previously inert) is now functional:
  unlocking it reveals independent width/height scaling, adjustable from the
  panel's X/Y boxes or by dragging the new edge handles on the preview
  selection box. Unlocking seeds both axes from the current uniform scale so
  nothing visibly jumps; re-locking keeps the X value and clears the per-axis
  fields. `KeyframeProp` widens to cover the two new props, so per-axis scale
  is keyframeable like every other transform property. Preview and render
  resolve scale through the same shared `@bycrux/timeline-core` geometry
  resolver, and the emitted CSS transform is now unconditionally the
  two-argument `scale(sx, sy)`, so the two surfaces can't drift apart.
- **Unified the overlay selection box with the clip selection box.** A
  selected overlay in the preview now gets the same crisp treatment a
  selected clip gets: a 2px `var(--editor-selection)` outline with eight
  12x12 white square handles — four corners (scale both axes) and four edge
  midpoints (scale one axis). The old faint amber ring with L-bracket corners
  is gone, and the drag snap guides are now token-driven instead of
  hardcoded amber.
- **The caption panel is now three sub-tabs, and the style picker is a live
  gallery.** The track-level caption controls used to sit behind one
  collapsible "Caption style" subsection above the transcript. They are now
  three sub-tabs: **Format** (the default), holding the fine controls — size,
  color, font, bold, case, alignment, letter spacing, line height — each now on
  its own labeled row in a single label/control column, with alignment promoted
  out of the case row onto its own;
  **Styles**, a card grid replacing the old text-chip row, with one card per
  style rendering the real `render/templates/captions/*.jsx` template — the
  same one the export uses — on a four-word sample, so hovering a card plays
  its actual animation and clicking applies it; and **Captions**, the
  transcript list, unchanged. The gallery needs two new optional props on
  `CaptionListPanelProps`, `compileOverlay` and `resolveCaptionTemplate`; a
  host that doesn't supply them (Hub, Los Parceros) falls back to a static
  styled specimen card per style, still clickable. The active sub-tab persists
  under `montaj.editor.captionPanelTab`.
- **Extracted a shared `TabNav` component for the editor's small tab
  strips.** The underline tab strip (uppercase labels, an accent underline
  under the active tab) is now one component (`video/panels/TabNav.tsx`),
  used by the caption panel's Format/Styles/Captions switch, the overlay
  panel's Content/Transform switch, and the new clip properties tabs below.
  Purely an internal de-duplication: no visual or behavioral change to any
  panel that already had tabs.
- **Video and image clips now get a tabbed properties pane, with a new
  Transform tab.** Selecting a clip used to show one flat pane with just
  Volume and, for video, Speed. It's now tabbed: **Transform, Speed,
  Volume, Crop, Generate**, opening on Transform, which is the same
  inspector overlays already use for scale, position, rotation, opacity and
  alignment. The tab set adapts to the selection: an image clip has no
  Speed or Crop tab, a clip that isn't a main-track video with a source has
  no Crop tab, and Generate only shows for a generated clip. The active tab
  is remembered per browser. Editing a transform property on a clip with no
  keyframes sets a static transform on the whole clip rather than creating
  one; once a property is keyframed, editing it at the playhead keys it
  there instead, the same auto-keyframe rule overlays already followed.
  (Opacity can be set statically but not keyframed on a clip, the same
  ffmpeg limitation noted above.) This is UI plumbing over transforms the
  render engine already supported, so an existing project with no clip
  transforms renders identically. Audio tracks keep their own untabbed
  panel, and captions are unaffected.
- **The Transform section's collapse chevron is gone.** Both the overlay
  Transform panel and the new clip Transform tab above now show the section
  permanently open, with no fold/unfold control. Now that Transform is
  reached by selecting its own tab rather than sharing a pane with other
  fields, there was nothing left to collapse it for.

### Both editors

- **Both editors now follow the app's light or dark mode.** They used to
  render dark-only, so switching Montaj into light mode left the editor
  looking broken — the surrounding chrome went light while the preview, the
  properties panel, and the timeline stayed dark. The editor now switches
  instantly the moment the app's theme toggle is used, with no reload. The
  video preview and the agent hand-off code box stay dark in both themes on
  purpose, the same way a real editor's preview always sits on black. Dark
  mode itself is unchanged — nothing looks different there.
- **Added: visible Undo (and Redo) toolbar buttons.** Undo/redo was previously
  keyboard-only (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`) and only advertised in the
  canvas hint line + ⓘ modal. The carousel editor now shows **Undo** and
  **Redo** buttons in the left toolbar group beside Refresh, wired to the
  project-state hook's `undo`/`redo` and disabled via `canUndo`/`canRedo`. The
  video editor gains an **Undo** button in the track-controls bar, wired to the
  existing `handleUndo`/`canUndo` (video has no redo stack, so no Redo button).
  Keyboard shortcuts are unchanged.
- **Fixed: ~260 more dead Tailwind `/NN` opacity modifiers on `--editor-*` CSS
  vars, package-wide — the same silent no-op `LeftPanelTabs.tsx` had (above),
  on toolbar icons, timeline controls, carousel panels, and shared `ui/`
  primitives across both editors. Tailwind cannot parse an opaque `var(...)`
  reference to inject an alpha channel, so it emits no rule at all and the
  element falls back to an inherited/default color — invisible against the
  editor's dark surface. Every instance, plain (`/60`) and bracketed
  (`/[0.06]`), is rewritten to the same
  `color-mix(in_srgb,var(--editor-X)_NN%,transparent)` form: 269 replacements
  across 38 files. `VideoEditor.tsx`'s two root containers also gain an
  explicit `text-[var(--editor-text)]`, so anything still uncolored inherits
  a readable color instead of whatever a host's chrome happens to set. A new
  source-level guard test greps the whole package for the dead pattern and
  fails the suite if it comes back. (`ui/*`, `text/*`, `crop/*`,
  `components/FilmstripScrubber.tsx`, `carousel/*`, `video/*` — 38 files in
  all — plus `__tests__/no-opacity-modifier-on-editor-vars.test.ts`,
  `__tests__/node-shims.d.ts`)

### Carousel editor

- **Fixed: `CarouselEditor`'s root did not set the editor text colour**, so chrome that inherits colour picked up the host page's instead of `--editor-text`. The root now carries `text-[var(--editor-text)]`, as `VideoEditor`'s already did. (`carousel/CarouselEditor.tsx`, `carousel/__tests__/CarouselEditor.test.tsx`)

## 0.8.10 — 2026-07-20

### Video editor

- **Added: caption color controls** in the caption panel, next to the style
  picker and font-size slider. A **Text** swatch sets the base caption color
  (`captions.color`, honored by every style), and a second **accent** swatch
  sets the highlighted/active color. The accent swatch is style-aware — it
  writes whichever field the active style's render template actually reads
  (`karaoke`→`highlightColor`, `pop`→`activeColor`, `highlight-box`/`outline`→
  `accentColor`, `subtitle`→`backgroundColor`) and relabels itself to match. It
  is hidden for `clean` and `word-by-word`, which have no accent. Colors preview
  live while picking and persist on the picker's close, mirroring the font-size
  slider. Both the browser preview and the render engine already read these
  fields, so preview and export stay in sync.
  - The native OS color picker is hex-only, so partial transparency (e.g.
    karaoke's translucent unsung words) can't be set from the UI.
- **Internal: extracted `SwatchInput`** into `src/ui/` as a shared primitive
  (gaining an `onCommit` blur hook + compact `size`/`showValue` options); the
  carousel slide panel now consumes it instead of its private copy.

## 0.8.9 — 2026-07-16

### Video editor

- **Fixed: arrow keys no longer scrub the video while editing caption text.**
  The timeline's global ←/→ frame-step handler only ignored `<input>`/
  `<textarea>` targets, so with the caret inside a caption segment (they're
  `contentEditable` spans) arrows moved the playhead as well as the text
  cursor. It now also bails when the target is contentEditable, and is
  disabled entirely while the transcript modal is open — arrows just move the
  text cursor there. Timeline scrubbing is unchanged everywhere else.

- **Added: caption style picker gains 3 styles** (`highlight-box`, `outline`,
  `clean`) alongside the existing `word-by-word`/`karaoke`/`pop`/`subtitle`.

- **Added: a font-size slider** in the caption panel — adjusts `fontsize` on
  the caption track live against the preview.

- **Added: a "Remove captions" button** with a two-step inline confirm, to
  clear the caption track from the project without hand-editing
  `project.json`.

- **`CaptionPreview` now passes theme props** (not just `segments`) through to
  the caption template factory, so style/color/size edits are reflected live
  in the preview.

## 0.8.8 — 2026-07-09

### Both editors

- **Added: an "ⓘ" controls & shortcuts reference.** A small info button in the
  video editor's toolbar and beside the carousel editor's hint line opens a
  themed modal (`ControlsInfoModal`) listing the real gestures and keyboard
  shortcuts for that editor — preview drag/scale/rotate, timeline trim, Split
  (`S`), undo/redo, `Delete`, etc. Content is sourced from the editors' actual
  handlers so it can't drift into fiction. Dismisses on backdrop-click or `Esc`.

## 0.8.7 — 2026-06-26

### Carousel editor

- **Fixed: the carousel render modal no longer hangs forever on "Starting render
  engine…".** The Hub render backend is async-only (`POST …/render` returns
  `{status:'running'}` and the render runs detached — it no longer streams SSE),
  but `CarouselRenderModal` still consumed the dead SSE `adapter.render()`
  stream, so it waited forever for a `done` event that never arrived while the
  render actually completed server-side. It now mirrors `video/RenderModal`:
  kick `renderAsync`, poll `getRenderStatus` until terminal (tolerating up to 12
  consecutive transient poll failures so a tunnel hiccup isn't mistaken for a
  failure), and build the done-state gallery from the promoted R2 `media`
  (filtered to `slide_NN.png` and sorted). The SSE `adapter.render()` path is
  preserved as a fallback for hosts without the poll API (montaj-native
  desktop). (`src/carousel/CarouselRenderModal.tsx`)

### Video editor

- **Render modal progress UI is now a host-chosen flag
  (`VideoEditorProps.renderProgressView?: 'phases' | 'logs'`, default
  `'phases'`).** montaj-native passes `'logs'` and gets the full scrolling
  render-log panel (colorized lines + Copy) back; Hub clients keep the compact
  Preparing → … → Saving stepper. The SSE render path accumulates log lines
  again for the panel. (`src/types.ts`, `src/video/RenderModal.tsx`,
  `src/video/VideoEditor.tsx`)

- **Fixed: lazy-normalize preview no longer freezes on clips with a
  `normalizedSrc` window cache.** The preview loads the per-window cache (which
  starts at 0 and is only `outPoint - inPoint` seconds long) but was still
  seeking to the original `inPoint` (e.g. 496s) — the browser clamped to EOF and
  the clip showed a frozen last frame with no playback. The preview now rebases
  the seek/window math to the cache timeline (effective inPoint 0, outPoint =
  `outPoint - inPoint`), mirroring render's `collectAllItems`. `nobg_preview_src`
  (full-source, takes precedence) is unaffected and keeps the original inPoint.
- **Fixed: preview now reflects `sourceCrop`.** Clips with a `sourceCrop`
  (clips-workflow vertical reframe) showed the full letterboxed source in
  preview while render applied the crop/zoom. The preview `<video>` now
  crop→contain-fits the sub-rect into the frame, matching render's ffmpeg
  `crop` + `scale(decrease)` + `pad` pipeline. Clips without `sourceCrop` keep
  the existing `object-contain` behavior.

- Layout brought in line with the carousel editor: the host-supplied assets
  panel (`slots.assetsPanel`) now renders as a **full-width region stacked below
  the editor** instead of crammed into the narrow right rail. The editor body
  (preview + timeline + captions) gets the full width; the right rail now carries
  only version history / run-history. Mirrors `CarouselEditor`'s stacked layout.
- Video editor chrome is now **theme-compliant**: `VersionPanel`, `VideoEditor`,
  `RenderModal`, and `CaptionRegenModal` consume the `--editor-*` theme tokens
  (via `applyTheme`) exactly like the carousel chrome, instead of hardcoding
  fixed grays + `dark:` variants. The video editor now re-skins per tenant and
  renders correctly in light-mode hubs. Brand accents (Render button, agent
  handoff, version Restore) follow `--editor-accent`; semantic colors
  (error/success/status, Ripple/Crop mode indicators) and the black video
  letterbox are unchanged. Version-history cards realigned for cleaner rows.

### Carousel editor

- Snap/alignment guides are more visible: thicker (2px), brighter, and glow so
  they're easy to see against any slide background.

## 0.5.3

### Video editor

- **Regenerate captions.** New `generateCaptions` adapter method
  (`AsyncIterable<CaptionEvent>`) + a "Regenerate captions" button in the
  caption panel. Streams multilingual transcription progress and replaces
  `project.captions` with project-time-aligned segments when done. Requires a
  host adapter that implements `generateCaptions` (mel-hub) and montaj ≥ 3.0.4
  on the sidecar.

## 0.5.2

### Video editor

- **Fix laggy playback / clips overrunning their cut.** Clip-boundary detection
  for video projects now runs on a `requestAnimationFrame` clock (~60Hz) instead
  of riding the `<video>` element's `timeupdate` event (~4Hz). Previously the
  active clip could play up to ~250ms past its `outPoint` before the swap fired
  — on a silence-trimmed single-source timeline that overshoot was trimmed-out
  footage playing past the cut ("the underlying video keeps playing"). The rAF
  clock tightens the boundary to ~1 frame (≤~16ms); measured overshoot dropped
  from ~250ms to ≤9ms. `handleTimeUpdate` is idempotent, so the coarse
  `timeupdate` event remains a harmless fallback.

## 0.4.6

### Carousel editor

- The editor controls (refresh / toolbar actions / render) now sit in a proper
  toolbar row at the top of the canvas column instead of floating over the slide.
- Add-element buttons (`+ AI Image` / `+ Upload Image` / `+ Text` / `+ Overlay`)
  render in a 2×2 grid with no mid-label wrapping.
- The three work-area columns (slides rail · canvas · controls) scroll
  independently — scrolling one no longer moves the others.

## 0.4.5

### Carousel editor

- Controls/inspector polish: the right-hand property panel restyled into a clean
  inspector — one consistent themed input style across all fields, a real color
  swatch + hex for Background color (was a blank box), a tidy X/Y/W/H transform
  grid, a segmented text-formatting toolbar, and consistent themed buttons.

## 0.4.4

### Carousel editor

- Layout: the slide editor (add-element toolbar + property panel) sits to the
  RIGHT of the canvas again (widened to 24rem) — stacking it below the canvas
  made it require too much scrolling. Project media (`assetsPanel`) stays as a
  full-width region at the bottom. Canvas height tuned down (~62vh).

## 0.4.3

### Carousel editor

- Canvas significantly larger via a tall vertically-scrolling layout.
- Left-rail slide thumbnails show the entire slide (no vertical trim) — fixed a
  flex-compression that clipped portrait thumbnails.
- Buttons stay legible on any host theme: non-primary buttons use a themed
  surface, full-strength text, and a visible border.
- (Superseded by Unreleased) below-canvas panels were stacked full-width.

## 0.4.2

### Carousel editor

- Layout: the property panel, add-element toolbar, and `assetsPanel` slot render
  in a region BELOW the canvas instead of a right sidebar. Editor controls
  (refresh / toolbar actions / render) stay on the canvas.
- Fix: overlays no longer render oversized/overlapping — overlay elements are
  authored in native slide pixels, so they're rendered at native size and
  CSS-scaled to the canvas scale (matching the renderer).
- Editor chrome honors the host `theme` via the `--editor-*` CSS variables
  (shell, panels, toolbars, buttons, selection). Added an `accentForeground`
  color token so accent-colored controls get a readable paired foreground.

## 0.4.1

### Carousel editor

- Fix: bound the `assetsPanel` slot width so a wide host panel couldn't blow out
  the right column and crush the canvas (superseded by the 0.4.2 below-canvas
  layout).

## 0.4.0

### Carousel editor

- New public `ReadOnlySlide` read-only renderer (with optional auto-fit): a thin
  wrapper over the non-interactive `SlideCanvas` exposing only read-only props,
  optionally measuring its sized parent to fit the slide.
- Crop display in non-interactive render: a committed `ImageElement.crop` now
  renders the cropped sub-rect via the oversized-cover technique (matching the
  renderer) instead of falling back to a plain `object-fit: cover`.
- Google Fonts loading for carousel overlays (`OverlayElement.googleFonts`): the
  carousel overlay render path now loads declared Google Fonts so previews use
  the same glyphs and metrics as the renderer.
