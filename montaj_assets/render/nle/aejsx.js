// render/nle/aejsx.js
/**
 * The editor timeline as an After Effects script (`writeAeScript`): a `.jsx` that builds a composition and saves it
 * as an `.aep` beside itself. The same neutral timeline (`nle/timeline.js`) the FCP7 XML writer reads, so cuts,
 * speed, crossfades and placement agree with it.
 *
 * What lands in After Effects:
 *   - footage and image clips as layers, in z-order, each with its source window, speed (layer stretch), static
 *     position, scale and rotation (the same placement maths as the XML's Basic Motion, `motionOf`), opacity, a
 *     rectangular mask for a crop, and a marker naming what stays in Montaj;
 *   - a crossfade as opacity keyframes over the transition on both layers;
 *   - a video clip's sound on its own layer, at its volume, off when muted;
 *   - `audio.tracks` as audio layers with their volume and fades;
 *   - captions as EDITABLE TEXT layers (one per segment, an approximation of the style: the exact look is in
 *     `captions.mov`, added as a hidden layer to switch on);
 *   - overlays as transparent ProRes 4444 layers over their own window (the movies the graphics step rendered:
 *     their motion is in the pixels, as in the XML).
 *
 * Where it runs from does not matter: media paths and the `.aep` are written relative to the package folder, and the
 * package folder is the script's own folder when that holds the package marker (`.montaj-editor-export`: run from
 * the package by hand), else `DATA.dir`, the package's absolute path at export time, when THAT holds the marker (a
 * copy of the script run from elsewhere, as the app does), else nothing is built. Every segment goes through
 * `File.encode`, since `File()` and `Folder()` decode `%XX`. It ends with `app.project.save`; if After Effects
 * refuses (most likely "Allow Scripts to Write Files and Access Network" is off), it says so once and leaves the
 * composition open to save by hand.
 *
 * Safe to run twice: when the `.aep` is already beside the script it is opened, never built over. A cancelled
 * "save the open project?" prompt builds nothing. The build is one undo group; an error in it is one alert and
 * no save. A file that is missing or will not import is named once at the end, and the rest is built.
 *
 * The script is ExtendScript (ES3): `var`, no arrow functions, no template literals, no JSON object. The data is
 * one object literal on ONE line at the top (`DATA`); every other line is the fixed template (`AE_SCRIPT_TEMPLATE`),
 * which loads no code (no include, no eval). The whole script is ASCII: every character from U+007F up is a `\uXXXX`
 * escape in the data (ES3 reads U+2028 and U+2029 as line ends, and how ExtendScript guesses a file's encoding is not
 * something to depend on). The data line has no `#` and no `//` either (`#`, `\/`), so nothing in a caption or
 * a name can read as a preprocessor directive (`#include`, `//@include`, ...). The `.aep` is saved only directly in
 * the package folder, under the package's cleaned name; the script refuses any other target.
 */
import { relative, sep } from 'node:path'
import { motionOf, markerLabel } from './xmeml.js'
import { ExportError } from './export-error.js'
import { cleanFileName } from './file-name.js'

const FALLBACK_DURATION = 5

/** What `items.addComp` takes (After Effects Scripting Guide, ItemCollection.addComp). */
const AE_COMP = { minSize: 4, maxSize: 30000, maxDuration: 10800, minFps: 1, maxFps: 99 }

const rel = (pkgDir, p) => relative(pkgDir, p).split(sep).join('/')

/**
 * @param {import('./timeline.js').NleTimeline} timeline
 * @param {Object<string, object>} probes   probe results keyed by the timeline's source path (media size)
 * @param {{
 *   name?: string,
 *   pkgDir: string,                       the package folder the script sits in (final path), written as DATA.dir
 *   mediaPaths?: Object<string, string>,  original path to its copy in the package
 *   graphics?: Object<string, string>,    overlay clip id to its rendered movie
 *   captions?: string | null,             the rendered captions movie
 *   captionSegments?: Array<{ text: string, start: number, end: number }>,
 * }} options
 * @returns {{ jsx: string, aep: string, warnings: string[], leftOut: { clip: string, label: string }[] }}
 */
export function writeAeScript(timeline, probes, options) {
  const { name = 'Montaj', pkgDir, mediaPaths = {}, graphics = {}, captions = null, captionSegments = [] } = options
  const fps = timeline.fps
  const toS = (f) => f / fps
  const warnings = []
  const leftOut = []
  const noteLeft = (clip, key) => {
    const label = markerLabel(key)
    if (!leftOut.some((l) => l.clip === clip && l.label === label)) leftOut.push({ clip, label })
    return label
  }
  const linkOf = (src) => rel(pkgDir, mediaPaths[src] ?? src)

  const layers = []
  const transitions = []
  for (const track of timeline.videoTracks) {
    for (const clip of track.clips) {
      const marks = []
      for (const key of [...clip.unsupported]) {
        if (key.startsWith('keyframes:') || key === 'motionBlur') continue
        marks.push(noteLeft(clip.id, key))
      }
      const base = { id: clip.id, start: toS(clip.startFrame), end: toS(clip.endFrame), marks }
      if (clip.kind === 'graphic') {
        const movie = graphics[clip.id]
        if (!movie) { warnings.push(`overlay ${clip.id} has no rendered movie, so it is not in the composition`); continue }
        layers.push({ ...base, kind: 'graphic', path: rel(pkgDir, movie), name: `Overlay ${clip.id}` })
        continue
      }
      const p = probes[clip.src]
      const media = { width: p?.width ?? timeline.width, height: p?.height ?? timeline.height }
      const motion = motionOf(clip, media, { width: timeline.width, height: timeline.height })
      for (const m of motion.marks) marks.push(noteLeft(clip.id, m))
      const L = {
        ...base,
        kind: clip.kind === 'image' ? 'still' : 'footage',
        path: linkOf(clip.src),
        name: clip.id,
        sourceIn: clip.sourceIn ?? 0,
        speed: clip.speed ?? 1,
        opacity: clip.opacity ?? 1,
        // Position in pixels from the frame centre, y down, as Basic Motion's centre times the media size.
        scale: motion.scale,
        dx: motion.centerH * media.width,
        dy: motion.centerV * media.height,
        rotation: motion.rotation,
        mediaSize: [media.width, media.height],
      }
      if (clip.kind === 'video') {
        L.volume = clip.volume ?? 1
        L.muted = !!clip.muted || (p ? !p.hasAudio : false)
      }
      if (motion.crop) L.crop = motion.crop
      layers.push(L)
    }
    for (const t of track.transitions) transitions.push({ from: t.fromClipId, to: t.toClipId, start: toS(t.startFrame), end: toS(t.endFrame) })
  }

  const audio = []
  for (const track of timeline.audioTracks) {
    if (track.source !== 'audio.tracks') continue
    for (const c of track.clips) {
      if (c.muted) continue
      for (const key of c.unsupported ?? []) noteLeft(c.id, key)
      audio.push({
        id: c.id,
        path: linkOf(c.src),
        start: toS(c.startFrame),
        end: c.endFrame === null ? null : toS(c.endFrame),
        sourceIn: c.sourceIn ?? 0,
        speed: c.speed ?? 1,
        volume: c.volume ?? 1,
        fadeIn: toS(c.fadeInFrames ?? 0),
        fadeOut: toS(c.fadeOutFrames ?? 0),
      })
    }
  }

  const segs = (captionSegments ?? [])
    .filter((s) => typeof s?.text === 'string' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ text: s.text, start: s.start, end: s.end }))
  if (segs.length) warnings.push('captions are text layers in a plain style; captions.mov (hidden layer) holds the exact look')

  // A single file name, whatever the caller passed: the script saves it directly in the package folder.
  const aep = `${cleanFileName(name)}.aep`
  const data = {
    name,
    aep,
    dir: pkgDir,
    fps,
    width: timeline.width,
    height: timeline.height,
    duration: timeline.durationFrames > 0 ? toS(timeline.durationFrames) : FALLBACK_DURATION,
    layers,
    transitions,
    audio,
    captions: segs,
    captionsMovie: captions ? rel(pkgDir, captions) : null,
  }
  checkData(data)
  // One line, ASCII, and no `#` or `//`: all are JSON escapes, so the data is unchanged.
  const literal = JSON.stringify(data)
    .replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/#/g, '\\u0023')
    .replace(/\//g, '\\/')
  return { jsx: SCRIPT.replace('/*DATA*/', () => literal), aep: `${pkgDir}/${aep}`, warnings, leftOut }
}

/**
 * What the script hands After Effects has to be something it takes: every number finite (JSON would write a NaN as
 * null), and the composition inside `addComp`'s ranges. Throws `invalid_project` otherwise.
 */
function checkData(data) {
  const bad = (message) => { throw new ExportError('invalid_project', `After Effects: ${message}`) }
  const walk = (v, at) => {
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad(`${at} is not a number (${v})`) }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`)
  }
  walk(data, 'the edit')
  for (const k of ['width', 'height']) {
    const v = data[k]
    if (!Number.isInteger(v) || v < AE_COMP.minSize || v > AE_COMP.maxSize) {
      bad(`the ${k} must be a whole number of pixels from ${AE_COMP.minSize} to ${AE_COMP.maxSize} (this edit: ${v})`)
    }
  }
  if (!(data.duration > 0 && data.duration <= AE_COMP.maxDuration)) {
    bad(`a composition is at most ${AE_COMP.maxDuration} seconds long (this edit: ${data.duration})`)
  }
  if (!(data.fps >= AE_COMP.minFps && data.fps <= AE_COMP.maxFps)) {
    bad(`the frame rate must be from ${AE_COMP.minFps} to ${AE_COMP.maxFps} fps (this edit: ${data.fps})`)
  }
}

/** The script. `DATA` is the one object literal; the rest does not depend on the project. ExtendScript (ES3), ASCII. */
const SCRIPT = `// Montaj: build this edit in After Effects. Open it from After Effects (File > Scripts > Run Script File), or let Montaj run it.
// Media is found in the package folder (this file's own, or the one it was written to), so the package can be moved.
#target aftereffects
(function () {
var DATA = /*DATA*/;
var HERE = packageFolder();
// File() and Folder() decode %XX, so each segment goes in encoded: a file named "a%20b.mp4" stays itself.
function encoded(path) {
  var parts = path.split("/");
  for (var i = 0; i < parts.length; i++) parts[i] = File.encode(parts[i]);
  return parts.join("/");
}
function fileAt(rel) { return new File(HERE.absoluteURI + "/" + encoded(rel)); }
// The package: this script's own folder when it holds the package marker (run from the package), else the folder
// the export wrote it to (a copy run from elsewhere), when that holds it. Null when neither does.
function packageFolder() {
  var marker = File.encode(".montaj-editor-export");
  var holds = function (folder) {
    try { return !!folder && folder.exists && new File(folder.absoluteURI + "/" + marker).exists; } catch (e) { return false; }
  };
  var own = null;
  try { own = File($.fileName).parent; } catch (e) {}
  if (holds(own)) return own;
  // A Windows drive path in the form File and Folder take everywhere: C:\\a\\b is /c/a/b.
  var p = DATA.dir.replace(/\\\\/g, "/");
  var drive = /^([A-Za-z]):\\//.exec(p);
  if (drive) p = "/" + drive[1].toLowerCase() + p.slice(2);
  var made = new Folder(encoded(p));
  return holds(made) ? made : null;
}
function lin2db(v) { return v <= 0.00001 ? -96 : 20 * Math.log(v) / Math.LN10; }

if (parseFloat(app.version) < 14) { alert("This script needs After Effects 2017 or newer."); return; }
if (!HERE) { alert("Montaj: this script's package folder is missing; open it from the package folder."); return; }
// The project is saved only directly in the package folder, under one file name.
var target = fileAt(DATA.aep);
if (/[\\\\\\/]/.test(DATA.aep) || target.parent.fsName !== HERE.fsName) {
  alert("Montaj: this script would save its project outside its package folder, so nothing was built. Export again.");
  return;
}
// Built already: open it, never build over it.
if (target.exists) {
  if (!app.open(target)) alert("Montaj: " + DATA.aep + " is already beside this script; open it from File > Open.");
  return;
}
var proj = app.newProject();
if (!proj) { alert("Montaj: your open project was kept, so nothing was built. Run the script again to build it."); return; }

var comp = null;
var imported = {};
var missing = [];
var failed = [];
var placed = [];

// One import per file. A miss or a refused import is noted once, and every layer that wants it is skipped.
function importOnce(rel, straight) {
  var key = "@" + rel;
  if (key in imported) return imported[key];
  imported[key] = false;
  var f = fileAt(rel);
  if (!f.exists) { missing.push(rel); return false; }
  var item;
  try { item = proj.importFile(new ImportOptions(f)); } catch (e) { failed.push(rel + " (" + String(e) + ")"); return false; }
  // The overlay and caption movies carry straight (unmatted) alpha.
  if (straight) { try { item.mainSource.alphaMode = AlphaMode.STRAIGHT; } catch (e) {} }
  imported[key] = item;
  return item;
}
function mark(layer, time, text) {
  try { layer.property("Marker").setValueAtTime(time, new MarkerValue(text)); } catch (e) {}
}
function byId(id) { for (var i = 0; i < placed.length; i++) { if (placed[i].id === id) return placed[i]; } return null; }

function build() {
  comp = proj.items.addComp(DATA.name, DATA.width, DATA.height, 1, DATA.duration, DATA.fps);

  for (var i = 0; i < DATA.layers.length; i++) {
    var L = DATA.layers[i];
    var item = importOnce(L.path, L.kind === "graphic");
    if (!item) continue;
    var layer = comp.layers.add(item);
    layer.name = L.name;
    if (L.kind === "graphic") {
      layer.startTime = L.start;
      layer.inPoint = L.start;
      layer.outPoint = L.end;
    } else {
      var speed = L.speed || 1;
      if (L.kind === "footage") {
        layer.stretch = 100 / speed;
        layer.startTime = L.start - (L.sourceIn || 0) / speed;
      } else {
        layer.startTime = L.start;
      }
      layer.inPoint = L.start;
      layer.outPoint = L.end;
      var tr = layer.property("Transform");
      tr.property("Position").setValue([DATA.width / 2 + L.dx, DATA.height / 2 + L.dy]);
      tr.property("Scale").setValue([L.scale, L.scale]);
      if (L.rotation) tr.property("Rotation").setValue(L.rotation);
      tr.property("Opacity").setValue(100 * L.opacity);
      if (L.crop) {
        // A mask path is in the layer's own pixels, (0,0) at its top left.
        var w = L.mediaSize[0], h = L.mediaSize[1];
        var m = layer.property("Masks").addProperty("Mask");
        var s = new Shape();
        var x0 = L.crop.left / 100 * w, x1 = w - L.crop.right / 100 * w;
        var y0 = L.crop.top / 100 * h, y1 = h - L.crop.bottom / 100 * h;
        s.vertices = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        s.closed = true;
        m.property("Mask Path").setValue(s);
      }
      if (L.kind === "footage") {
        if (L.muted) { if (layer.hasAudio) layer.audioEnabled = false; }
        else if (L.volume !== 1 && layer.hasAudio) layer.property("Audio").property("Audio Levels").setValue([lin2db(L.volume), lin2db(L.volume)]);
      }
    }
    // One marker: marks at one time would replace each other.
    if (L.marks.length) mark(layer, L.start, L.marks.join("; "));
    placed.push({
      id: L.id, layer: layer, opacity: L.opacity === undefined ? 1 : L.opacity, start: L.start, end: L.end,
      sound: L.kind === "footage" && !L.muted, db: lin2db(L.volume === undefined ? 1 : L.volume)
    });
  }

  // A crossfade: both layers reach across the overlap; opacity keys blend them, and level keys cross their
  // sound the same way, so it does not double.
  for (var t = 0; t < DATA.transitions.length; t++) {
    var T = DATA.transitions[t];
    var from = byId(T.from), to = byId(T.to);
    if (!from || !to) continue;
    from.layer.outPoint = Math.max(from.layer.outPoint, T.end);
    to.layer.inPoint = Math.min(to.layer.inPoint, T.start);
    var fo = from.layer.property("Transform").property("Opacity");
    fo.setValueAtTime(T.start, 100 * from.opacity);
    fo.setValueAtTime(T.end, 0);
    var ti = to.layer.property("Transform").property("Opacity");
    ti.setValueAtTime(T.start, 0);
    ti.setValueAtTime(T.end, 100 * to.opacity);
    if (from.sound && from.layer.hasAudio) {
      var fl = from.layer.property("Audio").property("Audio Levels");
      fl.setValueAtTime(T.start, [from.db, from.db]);
      fl.setValueAtTime(T.end, [-96, -96]);
    }
    if (to.sound && to.layer.hasAudio) {
      var tl = to.layer.property("Audio").property("Audio Levels");
      tl.setValueAtTime(T.start, [-96, -96]);
      tl.setValueAtTime(T.end, [to.db, to.db]);
    }
  }

  for (var a = 0; a < DATA.audio.length; a++) {
    var A = DATA.audio[a];
    var ai = importOnce(A.path, false);
    if (!ai) continue;
    var al = comp.layers.add(ai);
    al.name = A.id;
    var sp = A.speed || 1;
    if (sp !== 1) al.stretch = 100 / sp;
    al.startTime = A.start - A.sourceIn / sp;
    al.inPoint = A.start;
    if (A.end !== null) al.outPoint = A.end;
    var lv = al.property("Audio").property("Audio Levels");
    var db = lin2db(A.volume);
    var end = al.outPoint;
    if (A.fadeIn > 0) { lv.setValueAtTime(A.start, [-96, -96]); lv.setValueAtTime(A.start + A.fadeIn, [db, db]); }
    else lv.setValue([db, db]);
    if (A.fadeOut > 0) { lv.setValueAtTime(end - A.fadeOut, [db, db]); lv.setValueAtTime(end, [-96, -96]); }
  }

  // Captions: editable text, one layer per segment.
  var size = Math.round(DATA.height * 0.045);
  for (var c = 0; c < DATA.captions.length; c++) {
    var C = DATA.captions[c];
    var cap = comp.layers.addText(C.text);
    cap.name = "Caption " + (c + 1);
    var doc = cap.property("Source Text").value;
    doc.fontSize = size;
    // Fill and stroke on first: their colours cannot be set while they are off.
    doc.applyFill = true;
    doc.applyStroke = true;
    doc.fillColor = [1, 1, 1];
    doc.strokeColor = [0, 0, 0];
    doc.strokeWidth = Math.max(1, size / 12);
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    cap.property("Source Text").setValue(doc);
    cap.property("Transform").property("Position").setValue([DATA.width / 2, DATA.height * 0.8]);
    cap.startTime = C.start;
    cap.inPoint = C.start;
    cap.outPoint = C.end;
  }
  // The exact caption look, as the render draws it: a hidden layer to switch on.
  if (DATA.captionsMovie) {
    var cm = importOnce(DATA.captionsMovie, true);
    if (cm) {
      var cl = comp.layers.add(cm);
      cl.name = "Captions (exact look, switched off)";
      cl.enabled = false;
    }
  }
}

var ok = false;
var err = null;
app.beginUndoGroup("Montaj: " + DATA.name);
app.beginSuppressDialogs();
try {
  build();
  ok = true;
} catch (e) {
  err = e;
} finally {
  app.endSuppressDialogs(false);
  app.endUndoGroup();
}
if (!ok) {
  alert("Montaj could not build the composition: " + String(err) + (err && err.line ? " (line " + err.line + ")" : "") + ". Nothing was saved.");
  return;
}
comp.openInViewer();

var note = "";
if (missing.length) note += "Not found beside this script: " + missing.join(", ") + ".\\n";
if (failed.length) note += "Could not import: " + failed.join(", ") + ".\\n";
try {
  proj.save(target);
} catch (e) {
  note += "The project is built but could not be saved (" + String(e) + "). Allow Scripts to Write Files and Access Network (Settings > Scripting & Expressions) may be off: turn it on and run the script again, or use File > Save.";
}
if (note) alert(note);
})();
`

/** The fixed lines of every script (all but the one `var DATA` line); for tests. */
export const AE_SCRIPT_TEMPLATE = SCRIPT
