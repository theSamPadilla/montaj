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
 * Self-contained: media paths are written relative to the package folder and resolved from the script's own file
 * (`File($.fileName).parent`), so the package works from anywhere. It ends with `app.project.save`; if After Effects
 * refuses because "Allow Scripts to Write Files and Access Network" is off, it says so once and leaves the
 * composition open to save by hand.
 *
 * The script is ExtendScript (ES3): `var`, no arrow functions, no template literals, no JSON object. The data is
 * one object literal at the top (`DATA`); everything after is generic.
 */
import { relative, sep } from 'node:path'
import { motionOf, markerLabel } from './xmeml.js'

const FALLBACK_DURATION = 5

const rel = (pkgDir, p) => relative(pkgDir, p).split(sep).join('/')

/**
 * @param {import('./timeline.js').NleTimeline} timeline
 * @param {Object<string, object>} probes   probe results keyed by the timeline's source path (media size)
 * @param {{
 *   name?: string,
 *   pkgDir: string,                       the package folder the script sits in (final path)
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
        sourceIn: c.sourceIn,
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

  const aep = `${name}.aep`
  const data = {
    name,
    aep,
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
  return { jsx: SCRIPT.replace('/*DATA*/', () => JSON.stringify(data, null, 1)), aep: `${pkgDir}/${aep}`, warnings, leftOut }
}

/** The script. `DATA` is the one object literal; the rest does not depend on the project. ExtendScript (ES3). */
const SCRIPT = `// Montaj: build this edit in After Effects. Open it from After Effects (File > Scripts > Run Script File), or let Montaj run it.
// Media is found beside this file, so the folder can be moved.
#target aftereffects
(function () {
var DATA = /*DATA*/;
var HERE = File($.fileName).parent;
function fileAt(rel) { return new File(HERE.fsName + "/" + rel); }
function lin2db(v) { return v <= 0.00001 ? -96 : 20 * Math.log(v) / Math.LN10; }

if (parseFloat(app.version) < 14) { alert("This script needs After Effects 2017 or newer."); return; }
app.beginUndoGroup("Montaj: " + DATA.name);
var proj = app.newProject();
var comp = proj.items.addComp(DATA.name, DATA.width, DATA.height, 1, DATA.duration, DATA.fps);
var imported = {};
var missing = [];

function importOnce(rel) {
  if (imported[rel]) return imported[rel];
  var f = fileAt(rel);
  if (!f.exists) { missing.push(rel); return null; }
  var item = proj.importFile(new ImportOptions(f));
  imported[rel] = item;
  return item;
}
function mark(layer, time, text) {
  try { layer.property("Marker").setValueAtTime(time, new MarkerValue(text)); } catch (e) {}
}
function byId(id) { for (var i = 0; i < placed.length; i++) { if (placed[i].id === id) return placed[i]; } return null; }

var placed = [];
for (var i = 0; i < DATA.layers.length; i++) {
  var L = DATA.layers[i];
  var item = importOnce(L.path);
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
      var w = L.mediaSize[0], h = L.mediaSize[1];
      var m = layer.property("Masks").addProperty("Mask");
      var s = new Shape();
      var x0 = L.crop.left / 100 * w - w / 2, x1 = w / 2 - L.crop.right / 100 * w;
      var y0 = L.crop.top / 100 * h - h / 2, y1 = h / 2 - L.crop.bottom / 100 * h;
      s.vertices = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      s.closed = true;
      m.property("Mask Path").setValue(s);
    }
    if (L.kind === "footage") {
      if (L.muted) layer.audioEnabled = false;
      else if (L.volume !== 1 && layer.hasAudio) layer.property("Audio").property("Audio Levels").setValue([lin2db(L.volume), lin2db(L.volume)]);
    }
  }
  for (var k = 0; k < L.marks.length; k++) mark(layer, L.start, L.marks[k]);
  placed.push({ id: L.id, layer: layer, opacity: L.opacity === undefined ? 1 : L.opacity, start: L.start, end: L.end });
}

// A crossfade: both layers reach across the overlap; opacity keys blend them.
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
}

for (var a = 0; a < DATA.audio.length; a++) {
  var A = DATA.audio[a];
  var ai = importOnce(A.path);
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
  var tl = comp.layers.addText(C.text);
  tl.name = "Caption " + (c + 1);
  var doc = tl.property("Source Text").value;
  doc.fontSize = size;
  doc.fillColor = [1, 1, 1];
  doc.strokeColor = [0, 0, 0];
  doc.strokeWidth = Math.max(1, size / 12);
  doc.applyStroke = true;
  doc.applyFill = true;
  doc.justification = ParagraphJustification.CENTER_JUSTIFY;
  tl.property("Source Text").setValue(doc);
  tl.property("Transform").property("Position").setValue([DATA.width / 2, DATA.height * 0.8]);
  tl.startTime = C.start;
  tl.inPoint = C.start;
  tl.outPoint = C.end;
}
// The exact caption look, as the render draws it: a hidden layer to switch on.
if (DATA.captionsMovie) {
  var cm = importOnce(DATA.captionsMovie);
  if (cm) {
    var cl = comp.layers.add(cm);
    cl.name = "Captions (exact look, switched off)";
    cl.enabled = false;
  }
}

app.endUndoGroup();
comp.openInViewer();

var note = "";
if (missing.length) note += "Not found beside this script: " + missing.join(", ") + ".\\n";
try {
  proj.save(fileAt(DATA.aep));
} catch (e) {
  note += "The project is built but could not be saved. In After Effects, turn on Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network, then run the script again, or use File > Save.";
}
if (note) alert(note);
})();
`
