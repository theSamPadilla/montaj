/**
 * §190 T2: the preview mixer's feeder Worker, as an inlined source string.
 *
 * Shipped like `decode-worker-source.ts`: a Blob URL and a classic
 * `new Worker(url)`, so it is plain JS with no imports and bundles unchanged in
 * the app's Vite build, the OSS UI and Hub. It is tested by executing this
 * string (`__tests__/mix-worker-source.test.ts`): `self`, `fetch` and
 * `performance` are shadowed by fakes, and a test hook (`self.__montajMixExpose`)
 * hands the DSP and cache internals to the tests. In a real Worker the hook is
 * absent and nothing is exposed.
 *
 * What it does, all off the main thread:
 *
 *  1. **The plan.** `{ t: 'plan', planGen, segments }` from main. Each segment
 *     gets a version that bumps whenever its audio mapping changes (url,
 *     format, rate, channels, data offset, timeline start, source in, speed);
 *     the mix parameters go on to the worklet (`t: 'segments'`) with it, and
 *     the worklet drops blocks of an older version.
 *  2. **The transport and clock**, from the worklet over the MessageChannel. A
 *     new transport generation (a seek or a rate change) drops every stream and
 *     refills from the new position; a clock report moves the fill horizon.
 *  3. **Feeding.** Every active or upcoming segment is kept `aheadS` (1.5 s)
 *     ahead of the clock, topped up once its lead falls `refillS` below that.
 *     Conformed PCM comes in by `fetch(url, { headers: { Range } })` in
 *     `blockS` (0.25 s) source blocks, through an LRU block cache capped at
 *     `cacheBytes` (64 MB). int16 becomes float32, mono becomes stereo.
 *  4. **Rate.** Per-clip speed times the transport rate is the source seconds
 *     per output second. When its magnitude is not 1 the audio is
 *     time-stretched with the WSOLA from `time-stretch.ts`, ported here line
 *     for line (the tests hold the two to identical output), inside the same
 *     streaming wrapper `audio-clock.ts` uses, plus a drift corrector so a long
 *     stretched segment never slides off the clock. A negative rate reads the
 *     source backwards.
 *  5. **Resampling** from the conformed rate (48 kHz) to the context's, with
 *     4-point, 3rd-order Lagrange interpolation (cubic), streamed with its
 *     phase and history carried across blocks.
 *  6. **Blocks** of interleaved stereo float32, at most `maxPostS` long, posted
 *     straight to the worklet's port with the buffer transferred, each stamped
 *     `{ gen, id, ver, k0 }`. `k0` is the output frame, placed with the
 *     worklet's own expression: `Math.round((tl - anchorTime) * outRate / rate)`.
 *
 *  7. **Scrub grains** (§190 T4). `{ t: 'scrub', time, dir, lenS }` from main:
 *     for every plan segment active at timeline `time`, one Hann-windowed grain
 *     of its source read from the same block cache (fetched by range when
 *     cold), cubic-resampled at the clip's speed, backwards when `dir` is -1,
 *     clipped to the segment's span so it never reads past a cut. Each goes to
 *     the worklet as `{ t: 'grain' }`, which applies the live gain and mute. A
 *     grain waiting on a cold block is retried as blocks land, and dropped
 *     once it is older than `GRAIN_EXPIRE_MS` or three newer ones are queued.
 *
 * Errors (a failed fetch) go to main as `{ t: 'error' }`; the block is retried
 * after 500 ms, doubling per failure up to 8 s, while the worklet counts the
 * segment as starving. Stats go to
 * main as `{ t: 'stats' }` about once a second and on request.
 */
export const mixWorkerSource = `'use strict';

// ── config (init) ──────────────────────────────────────────────────────────
var outRate = 48000;
var aheadS = 1.5;
var refillS = 0.25;
var blockS = 0.25;
var maxPostS = 0.25;
var cacheCap = 64 * 1024 * 1024;
var maxInflight = 6;
var SRC_CHUNK = 2048;      // source frames read per pipeline step (one WSOLA step)
var RETRY_MS = 500;        // first retry of a failed block; doubles per failure, up to RETRY_MAX_MS
var RETRY_MAX_MS = 8000;
var STATS_MS = 1000;

var port = null;
var disposed = false;

// ── transport (from the worklet) ───────────────────────────────────────────
var gen = -1;
var anchorTime = 0;
var rate = 1;
var clockK = 0;
var playing = false;

// ── plan ───────────────────────────────────────────────────────────────────
var planGen = 0;
var plan = [];
var planById = new Map();
var versions = new Map();  // id -> last version handed out, kept across removals
var streams = new Map();   // id -> stream, for the current generation

var stats = {
  t: 'stats', planGen: 0, gen: 0, cacheBytes: 0, cacheBlocks: 0, cacheEvictions: 0,
  fetches: 0, fetchBytes: 0, fetchErrors: 0, inflight: 0, blocksPosted: 0, framesPosted: 0, grains: 0,
  convertMs: 0, stretchMs: 0, resampleMs: 0, resampledFrames: 0, stretchedFrames: 0,
};
var lastStatsAt = -1e9;

var LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function now() { return performance.now(); }
function describe(err) { return err && err.message ? err.message : String(err); }
function fin(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d;
}
function postMain(msg) { self.postMessage(msg); }

// ── WSOLA: a line-for-line port of time-stretch.ts (keep the two identical) ──
var FRAME = 1024;
var SYNTH_HOP = FRAME / 2;
var OVERLAP = FRAME - SYNTH_HOP;
var SEARCH = 128;
var MAX_STRETCH = 32;
var WEIGHT_EPSILON = 1e-6;
var ENERGY_EPSILON = 1e-9;

function timeStretch(input, channels, factor) {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error('timeStretch: factor must be a finite positive number, got ' + factor);
  }
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error('timeStretch: channels must be a positive integer, got ' + channels);
  }
  if (input.length === 0) return new Float32Array(0);
  if (factor === 1) return input.slice();

  var f = Math.min(factor, MAX_STRETCH);
  var inFrames = Math.floor(input.length / channels);
  if (inFrames === 0) return new Float32Array(0);

  var analysisHop = Math.max(1, Math.round(SYNTH_HOP / f));
  var numFrames = Math.max(1, Math.round(inFrames / analysisHop));

  var mono = channels === 1 ? input : downmix(input, channels, inFrames);
  var win = hann(FRAME);

  var outFrames = Math.round(inFrames * f);
  var spanFrames = (numFrames - 1) * SYNTH_HOP + FRAME;
  var totalFrames = Math.max(spanFrames, outFrames);
  var out = new Float32Array(totalFrames * channels);
  var weight = new Float32Array(totalFrames);

  var target = new Float32Array(OVERLAP);
  var hasTarget = false;

  for (var m = 0; m < numFrames; m++) {
    var idealPos = m * analysisHop;
    var readPos = hasTarget ? idealPos + bestOffset(mono, inFrames, idealPos, target) : idealPos;
    var synthPos = m * SYNTH_HOP;

    for (var ch = 0; ch < channels; ch++) {
      for (var i = 0; i < FRAME; i++) {
        var src = readPos + i;
        if (src < 0 || src >= inFrames) continue;
        out[(synthPos + i) * channels + ch] += input[src * channels + ch] * win[i];
      }
    }
    for (var i2 = 0; i2 < FRAME; i2++) weight[synthPos + i2] += win[i2];

    for (var i3 = 0; i3 < OVERLAP; i3++) {
      var p = readPos + SYNTH_HOP + i3;
      target[i3] = p >= 0 && p < inFrames ? mono[p] : 0;
    }
    hasTarget = true;
  }

  for (var fr = 0; fr < totalFrames; fr++) {
    var w = weight[fr];
    for (var c2 = 0; c2 < channels; c2++) {
      out[fr * channels + c2] = w > WEIGHT_EPSILON ? out[fr * channels + c2] / w : 0;
    }
  }

  return out.length === outFrames * channels ? out : out.slice(0, outFrames * channels);
}

function hann(n) {
  var w = new Float32Array(n);
  for (var i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

function downmix(input, channels, inFrames) {
  var mono = new Float32Array(inFrames);
  for (var fr = 0; fr < inFrames; fr++) {
    var s = 0;
    for (var ch = 0; ch < channels; ch++) s += input[fr * channels + ch];
    mono[fr] = s / channels;
  }
  return mono;
}

function bestOffset(mono, inFrames, idealPos, target) {
  var bestOff = 0;
  var bestScore = correlate(mono, inFrames, idealPos, target);
  for (var off = -SEARCH; off <= SEARCH; off++) {
    if (off === 0) continue;
    var score = correlate(mono, inFrames, idealPos + off, target);
    if (score > bestScore) {
      bestScore = score;
      bestOff = off;
    }
  }
  return bestOff;
}

function correlate(mono, inFrames, pos, target) {
  var dot = 0;
  var energy = 0;
  for (var i = 0; i < OVERLAP; i++) {
    var p = pos + i;
    var c = p >= 0 && p < inFrames ? mono[p] : 0;
    dot += c * target[i];
    energy += c * c;
  }
  return energy <= ENERGY_EPSILON ? 0 : dot / Math.sqrt(energy);
}

// ── Streaming stretch: audio-clock.ts's createStreamStretch, plus drift ─────
var STRETCH_STEP_FRAMES = 2048;
var STRETCH_CONTEXT_FRAMES = 1024;

function concatPcm(a, b) {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  var out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function crossfadePcm(a, b, channels) {
  var frames = Math.floor(Math.min(a.length, b.length) / channels);
  var out = new Float32Array(frames * channels);
  for (var i = 0; i < frames; i++) {
    var t = frames > 1 ? i / (frames - 1) : 1;
    for (var ch = 0; ch < channels; ch++) {
      var idx = i * channels + ch;
      out[idx] = a[idx] * (1 - t) + b[idx] * t;
    }
  }
  return out;
}

// exact: hold the cumulative output to round((stepsIn * 2048 - 1024) * factor)
// frames by padding or trimming one frame at a block's end. Off, the output is
// identical to audio-clock.ts's createStreamStretch; on, a long stretched
// segment cannot drift from the clock (each block's integer rounding would
// otherwise accumulate, about 0.1 ms per second at speed 1.1).
function createStreamStretch(channels, factor, exact) {
  var step = STRETCH_STEP_FRAMES * channels;
  var context = STRETCH_CONTEXT_FRAMES * channels;
  var f = factor;
  var pending = new Float32Array(0);
  var tailIn = new Float32Array(0);
  var heldOut = null;
  var blocks = 0;   // blocks emitted since the last reset or factor change
  var emittedFrames = 0;

  function correct(emitted) {
    var ideal = Math.round((blocks * STRETCH_STEP_FRAMES - STRETCH_CONTEXT_FRAMES) * f);
    var have = emittedFrames + emitted.length / channels;
    var debt = ideal - have;
    if (debt === 0) return emitted;
    var frames = emitted.length / channels;
    var keep = Math.max(0, frames + debt);
    var out = new Float32Array(keep * channels);
    out.set(emitted.subarray(0, Math.min(keep, frames) * channels));
    for (var i = frames; i < keep; i++) {
      for (var ch = 0; ch < channels; ch++) out[i * channels + ch] = emitted[(frames - 1) * channels + ch];
    }
    return out;
  }

  function push(input) {
    if (f === 1) return input;
    if (input.length > 0) pending = concatPcm(pending, input);
    var hold = Math.round(STRETCH_CONTEXT_FRAMES * f) * channels;
    var emitted = new Float32Array(0);

    while (pending.length >= step) {
      var newInput = pending.subarray(0, step);
      var feed = concatPcm(tailIn, newInput);
      var out = timeStretch(feed, channels, f);
      var h = Math.min(hold, Math.floor(out.length / channels / 2) * channels);

      var blockOut;
      if (heldOut && h > 0) {
        var head = crossfadePcm(heldOut, out.subarray(0, h), channels);
        var mid = out.subarray(h, out.length - h);
        blockOut = concatPcm(head, mid);
      } else {
        blockOut = out.subarray(0, Math.max(0, out.length - h));
      }
      heldOut = h > 0 ? out.slice(out.length - h) : null;
      tailIn = newInput.slice(newInput.length - context);
      pending = pending.slice(step);
      emitted = concatPcm(emitted, blockOut);
      blocks++;
    }
    if (exact && blocks > 0 && emitted.length > 0) emitted = correct(emitted);
    emittedFrames += emitted.length / channels;
    return emitted;
  }

  return {
    push: push,
    setFactor: function (next) {
      if (next === f) return;
      f = next;
      tailIn = new Float32Array(0);
      heldOut = null;
      blocks = 0;
      emittedFrames = 0;
    },
    reset: function () {
      pending = new Float32Array(0);
      tailIn = new Float32Array(0);
      heldOut = null;
      blocks = 0;
      emittedFrames = 0;
    },
  };
}

// ── Resampler: 4-point, 3rd-order Lagrange, streaming, stereo ─────────────
// ratio = input frames per output frame (srcRate / outRate). Output frame j of
// the stream reads input position j * ratio, computed from j itself (never
// accumulated), so the output does not depend on how the input was chunked and
// cannot drift. The frame before the first input frame is the one prime()
// gives it; a stream that starts at file frame 0 has none and takes it to equal
// the first frame, which skews the second output sample slightly (under 2e-3 on
// a full-scale 1 kHz tone); the transport fade-in covers it.
function createResampler(ratio) {
  var buf = new Float32Array(16384 * 2);
  var n = 0;        // frames held; buf[0] is the frame before the first unread one
  var count = 0;    // output frames produced
  var dropped = 0;  // input frames compacted away
  var primed = false;

  function ensure(frames) {
    if (frames * 2 <= buf.length) return;
    var nb = new Float32Array(Math.max(frames * 2, buf.length * 2));
    nb.set(buf.subarray(0, n * 2));
    buf = nb;
  }

  return {
    // The real frame before the first pushed one (stereo, 2 floats).
    prime: function (c) {
      if (primed) return;
      ensure(1);
      buf[0] = c[0]; buf[1] = c[1];
      n = 1;
      primed = true;
    },
    push: function (c) {
      var f = c.length / 2;
      if (f === 0) return;
      if (!primed) {
        ensure(1 + f);
        buf[0] = c[0]; buf[1] = c[1];
        n = 1;
        primed = true;
      }
      ensure(n + f);
      buf.set(c, n * 2);
      n += f;
    },
    pull: function (out, off, max) {
      var got = 0;
      var pos = 1;
      while (got < max) {
        var x = count * ratio;   // input frame, from the stream start
        var xi = Math.floor(x);
        var i = xi + 1 - dropped; // in buf, whose frame 1 was input frame "dropped"
        if (i + 2 >= n) break;
        var t = x - xi;
        var tm1 = t - 1, tm2 = t - 2, tp1 = t + 1;
        var c0 = -t * tm1 * tm2 / 6;
        var c1 = tp1 * tm1 * tm2 / 2;
        var c2 = -tp1 * t * tm2 / 2;
        var c3 = tp1 * t * tm1 / 6;
        var b = (i - 1) * 2;
        var o = (off + got) * 2;
        out[o] = c0 * buf[b] + c1 * buf[b + 2] + c2 * buf[b + 4] + c3 * buf[b + 6];
        out[o + 1] = c0 * buf[b + 1] + c1 * buf[b + 3] + c2 * buf[b + 5] + c3 * buf[b + 7];
        got++;
        count++;
      }
      // Keep from the frame before the next read on.
      pos = Math.floor(count * ratio) + 1 - dropped;
      var drop = pos - 1;
      if (drop > 0) {
        if (drop > n) drop = n;
        buf.copyWithin(0, drop * 2, n * 2);
        n -= drop;
        dropped += drop;
      }
      return got;
    },
  };
}

// The same-rate path: a plain FIFO with the resampler's push/pull shape.
function createFifo() {
  var chunks = [];
  var head = 0;
  var at = 0; // frames consumed from chunks[head]
  return {
    push: function (c) { if (c.length > 0) chunks.push(c); },
    pull: function (out, off, max) {
      var got = 0;
      while (got < max && head < chunks.length) {
        var c = chunks[head];
        var avail = c.length / 2 - at;
        var n = Math.min(avail, max - got);
        out.set(c.subarray(at * 2, (at + n) * 2), (off + got) * 2);
        got += n;
        at += n;
        if (at * 2 >= c.length) { chunks[head] = null; head++; at = 0; }
      }
      if (head > 32) { chunks = chunks.slice(head); head = 0; }
      return got;
    },
  };
}

// ── PCM conversion: raw bytes -> interleaved stereo float32 ────────────────
function convertPcm(buf, format, channels) {
  var bps = format === 'pcm_f32le' ? 4 : 2;
  var ch = channels > 0 ? channels : 2;
  var frames = Math.floor(buf.byteLength / (bps * ch));
  var out = new Float32Array(frames * 2);
  var dv = LITTLE ? null : new DataView(buf);
  var src = null;
  if (LITTLE) src = bps === 2 ? new Int16Array(buf, 0, frames * ch) : new Float32Array(buf, 0, frames * ch);
  var scale = bps === 2 ? 1 / 32768 : 1;
  if (src !== null && ch === 2) {
    for (var i = 0; i < frames * 2; i++) out[i] = src[i] * scale;
    return out;
  }
  for (var f = 0; f < frames; f++) {
    var base = f * ch;
    var l, r;
    if (src !== null) {
      l = src[base] * scale;
      r = ch > 1 ? src[base + 1] * scale : l;
    } else if (bps === 2) {
      l = dv.getInt16(base * 2, true) * scale;
      r = ch > 1 ? dv.getInt16((base + 1) * 2, true) * scale : l;
    } else {
      l = dv.getFloat32(base * 4, true);
      r = ch > 1 ? dv.getFloat32((base + 1) * 4, true) : l;
    }
    out[f * 2] = l;
    out[f * 2 + 1] = r;
  }
  return out;
}

// ── LRU block cache ────────────────────────────────────────────────────────
function createLru(cap) {
  var map = new Map();
  var bytes = 0;
  var evictions = 0;
  return {
    get: function (key) {
      var v = map.get(key);
      if (v !== undefined) { map.delete(key); map.set(key, v); }
      return v;
    },
    peek: function (key) { return map.get(key); },
    has: function (key) { return map.has(key); },
    set: function (key, v) {
      var old = map.get(key);
      if (old !== undefined) { bytes -= old.bytes; map.delete(key); }
      map.set(key, v);
      bytes += v.bytes;
      // Never evict the entry just added: one block larger than the cap still serves.
      while (bytes > cap && map.size > 1) {
        var first = map.keys().next().value;
        bytes -= map.get(first).bytes;
        map.delete(first);
        evictions++;
      }
    },
    clear: function () { map.clear(); bytes = 0; },
    keys: function () { return Array.from(map.keys()); },
    size: function () { return map.size; },
    bytes: function () { return bytes; },
    evictions: function () { return evictions; },
  };
}

var cache = createLru(cacheCap);
var inflight = new Map();     // key -> true
var retryAt = new Map();      // key -> ms
var failures = new Map();     // key -> consecutive failures
var knownFrames = new Map();  // url -> frames, learned from a short or empty block

// ── the plan ───────────────────────────────────────────────────────────────
function curveName(c) { return c === 'linear' || c === 'log' || c === 'exp' ? c : null; }

function normSeg(s) {
  var curve = curveName(s.curve) || 'exp';
  var speed = fin(s.speed, 1);
  if (!(speed > 0)) speed = 1;
  if (speed < 1 / 16) speed = 1 / 16;
  if (speed > 16) speed = 16;
  var ch = Math.floor(fin(s.channels, 2));
  var sr = fin(s.sampleRate, 48000);
  return {
    id: String(s.id),
    url: String(s.url),
    format: s.format === 'pcm_f32le' ? 'pcm_f32le' : 'pcm_s16le',
    sampleRate: sr > 0 ? sr : 48000,
    channels: ch >= 1 ? ch : 2,
    dataOffset: Math.max(0, fin(s.dataOffset, 0)),
    frames: fin(s.frames, -1),
    tlStart: fin(s.tlStart, 0),
    tlEnd: typeof s.tlEnd === 'number' && s.tlEnd === s.tlEnd ? s.tlEnd : Infinity,
    srcIn: fin(s.srcIn, 0),
    speed: speed,
    gain: fin(s.gain, 1),
    fadeIn: Math.max(0, fin(s.fadeIn, 0)),
    fadeOut: Math.max(0, fin(s.fadeOut, 0)),
    curveIn: curveName(s.curveIn) || curve,
    curveOut: curveName(s.curveOut) || curve,
    // §190 T3: mix order and ducking, the worklet's alone (it sorts and clamps).
    stage: fin(s.stage, 0),
    duck: s.duck && typeof s.duck === 'object' ? s.duck : null,
    ver: 0,
    sig: '',
  };
}

// What decides the audio a segment's blocks hold. A change here is a new
// version. Gain, fades, stage and ducking are not in it: they are applied in the
// worklet, so changing one keeps the stream and every block already posted.
function sigOf(s) {
  return [s.url, s.format, s.sampleRate, s.channels, s.dataOffset, s.tlStart, s.srcIn, s.speed].join('|');
}

function setPlan(m) {
  planGen = m.planGen;
  var next = [];
  var byId = new Map();
  var list = m.segments || [];
  for (var i = 0; i < list.length; i++) {
    var n = normSeg(list[i]);
    n.sig = sigOf(n);
    var prev = planById.get(n.id);
    if (prev && prev.sig === n.sig) {
      n.ver = prev.ver;
    } else {
      var v = versions.has(n.id) ? versions.get(n.id) + 1 : 0;
      versions.set(n.id, v);
      n.ver = v;
      streams.delete(n.id);
    }
    next.push(n);
    byId.set(n.id, n);
  }
  streams.forEach(function (st, id) {
    var s = byId.get(id);
    if (!s) streams.delete(id);
    else st.seg = s;
  });
  plan = next;
  planById = byId;
  postSegments();
  schedulePump();
}

function postSegments() {
  if (!port) return;
  var segs = [];
  for (var i = 0; i < plan.length; i++) {
    var s = plan[i];
    segs.push({
      id: s.id, ver: s.ver, tlStart: s.tlStart, tlEnd: s.tlEnd, gain: s.gain,
      fadeIn: s.fadeIn, fadeOut: s.fadeOut, curveIn: s.curveIn, curveOut: s.curveOut,
      stage: s.stage, duck: s.duck,
    });
  }
  port.postMessage({ t: 'segments', planGen: planGen, segs: segs });
}

// ── transport ──────────────────────────────────────────────────────────────
function onPort(m) {
  if (!m || disposed) return;
  if (m.t === 'transport') {
    if (m.gen !== gen) {
      gen = m.gen;
      anchorTime = m.anchorTime;
      rate = m.rate;
      streams.clear();
    }
    clockK = m.k;
    playing = m.playing;
    schedulePump();
  } else if (m.t === 'clock') {
    if (m.gen !== gen) return;
    clockK = m.k;
    playing = m.playing;
    schedulePump();
    if (now() - lastStatsAt >= STATS_MS) postStats();
  }
}

// The worklet's own placement expression.
function placeK(tl) {
  return Math.round((tl - anchorTime) * outRate / rate);
}

function segSpan(s) {
  var a = placeK(s.tlStart);
  var b = s.tlEnd === Infinity ? (rate > 0 ? Infinity : -Infinity) : placeK(s.tlEnd);
  return a <= b ? [a, b] : [b, a];
}

// ── streams ────────────────────────────────────────────────────────────────
function blockFrames(s) { return Math.max(1, Math.round(blockS * s.sampleRate)); }
function bytesPerFrame(s) { return (s.format === 'pcm_f32le' ? 4 : 2) * s.channels; }
function blockKey(s, b) { return s.url + '#' + blockFrames(s) + '#' + b; }

function createStream(s, kFrom) {
  var span = segSpan(s);
  var k = Math.max(span[0], kFrom);
  var v = rate * s.speed;              // source seconds per output second
  var absV = Math.abs(v);
  var tl = anchorTime + rate * k / outRate;
  return {
    seg: s,
    ver: s.ver,
    nextK: k,
    kEnd: span[1],
    dir: v < 0 ? -1 : 1,
    absV: absV,
    srcNext: Math.round((s.srcIn + (tl - s.tlStart) * s.speed) * s.sampleRate),
    stretch: Math.abs(absV - 1) > 1e-9 ? createStreamStretch(2, 1 / absV, true) : null,
    waiting: false,
    resampling: s.sampleRate !== outRate,
    // A resampled stream that starts mid-file, unstretched and forwards, hands
    // its resampler the real frame before the start.
    needsPrior: s.sampleRate !== outRate && v > 0 && Math.abs(absV - 1) <= 1e-9
      && Math.round((s.srcIn + (tl - s.tlStart) * s.speed) * s.sampleRate) > 0,
    sink: s.sampleRate !== outRate ? createResampler(s.sampleRate / outRate) : createFifo(),
  };
}

function fileFrames(s) {
  if (s.frames >= 0) return s.frames;
  var k = knownFrames.get(s.url);
  return k === undefined ? Infinity : k;
}

// Copy source frames [start, start + count) into out (stereo). Frames outside
// the file are silence. Returns false, after requesting what is missing, when
// any block it needs is not cached yet.
function readSource(s, start, count, out) {
  var bf = blockFrames(s);
  var total = fileFrames(s);
  var lo = Math.max(start, 0);
  var hi = Math.min(start + count, total);
  var ok = true;
  if (hi > lo) {
    for (var b = Math.floor(lo / bf); b * bf < hi; b++) {
      if (!cache.has(blockKey(s, b))) { requestBlock(s, b); ok = false; }
    }
  }
  if (!ok) return false;
  var i = 0;
  while (i < count) {
    var f = start + i;
    if (f < 0) { i += Math.min(count - i, -f); continue; }
    if (f >= total) break;
    var b2 = Math.floor(f / bf);
    var e = cache.get(blockKey(s, b2));
    var off = f - b2 * bf;
    var n = Math.min(count - i, bf - off);
    var avail = Math.min(n, e.frames - off);
    if (avail > 0) out.set(e.data.subarray(off * 2, (off + avail) * 2), i * 2);
    i += n;
  }
  return true;
}

function reverseFrames(a, frames) {
  for (var i = 0, j = frames - 1; i < j; i++, j--) {
    var l = a[i * 2], r = a[i * 2 + 1];
    a[i * 2] = a[j * 2]; a[i * 2 + 1] = a[j * 2 + 1];
    a[j * 2] = l; a[j * 2 + 1] = r;
  }
}

function readChunk(st, count) {
  var start = st.dir > 0 ? st.srcNext : st.srcNext - count + 1;
  var out = new Float32Array(count * 2);
  if (!readSource(st.seg, start, count, out)) return null;
  if (st.dir < 0) reverseFrames(out, count);
  st.srcNext += st.dir * count;
  return out;
}

// Ask for every source block the stream will need to reach output frame targetK.
function prefetch(st, targetK) {
  var s = st.seg;
  var bf = blockFrames(s);
  var total = fileFrames(s);
  var need = Math.ceil((targetK - st.nextK) * st.absV * s.sampleRate / outRate)
    + SRC_CHUNK + (st.stretch ? STRETCH_STEP_FRAMES + STRETCH_CONTEXT_FRAMES : 0) + 4;
  var lo = st.dir > 0 ? st.srcNext : st.srcNext - need;
  var hi = st.dir > 0 ? st.srcNext + need : st.srcNext + 1;
  lo = Math.max(lo, 0);
  hi = Math.min(hi, total);
  if (hi <= lo) return;
  var b0 = Math.floor(lo / bf), b1 = Math.floor((hi - 1) / bf);
  // Never prefetch more than half the cache holds, or blocks evict each other
  // before they are read (a small cap would otherwise refetch forever).
  var fit = Math.max(1, Math.floor(cacheCap / ((bf * 8 + 64) * 2)));
  if (b1 - b0 + 1 > fit) {
    if (st.dir > 0) b1 = b0 + fit - 1; else b0 = b1 - fit + 1;
  }
  if (st.dir > 0) {
    for (var b = b0; b <= b1; b++) if (!cache.has(blockKey(s, b))) requestBlock(s, b);
  } else {
    for (var b2 = b1; b2 >= b0; b2--) if (!cache.has(blockKey(s, b2))) requestBlock(s, b2);
  }
}

function requestBlock(s, b) {
  var key = blockKey(s, b);
  if (inflight.has(key)) return;
  var ra = retryAt.get(key);
  if (ra !== undefined && now() < ra) return;
  if (inflight.size >= maxInflight) return;
  var bf = blockFrames(s);
  var bpf = bytesPerFrame(s);
  var from = s.dataOffset + b * bf * bpf;
  var to = from + bf * bpf - 1;
  var url = s.url, fmt = s.format, ch = s.channels;
  inflight.set(key, true);
  stats.fetches++;
  fetch(url, { headers: { Range: 'bytes=' + from + '-' + to } })
    .then(function (res) {
      if (res.status === 416) return null; // past the end of the file
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.arrayBuffer().then(function (buf) {
        // A server that ignored the Range sent the whole file.
        return res.status === 206 ? buf : buf.slice(from, to + 1);
      });
    })
    .then(function (buf) {
      if (disposed) return;
      var t0 = now();
      var data = buf ? convertPcm(buf, fmt, ch) : new Float32Array(0);
      stats.convertMs += now() - t0;
      stats.fetchBytes += buf ? buf.byteLength : 0;
      var frames = data.length / 2;
      cache.set(key, { data: data, frames: frames, bytes: data.byteLength + 64 });
      if (frames < bf) {
        var end = b * bf + frames;
        var prev = knownFrames.get(url);
        if (prev === undefined || end < prev) knownFrames.set(url, end);
      }
      retryAt.delete(key);
      failures.delete(key);
    })
    .catch(function (err) {
      if (disposed) return;
      stats.fetchErrors++;
      var n = (failures.get(key) || 0) + 1;
      failures.set(key, n);
      var delay = Math.min(RETRY_MAX_MS, RETRY_MS * Math.pow(2, n - 1));
      retryAt.set(key, now() + delay);
      postMain({ t: 'error', message: 'fetch ' + url + ' bytes ' + from + '-' + to + ': ' + describe(err), planGen: planGen });
      setTimeout(schedulePump, delay);
    })
    .then(function () {
      inflight.delete(key);
      schedulePump();
    });
}

// Produce up to want output frames for a stream. null when nothing could be
// produced yet (a block is on its way).
function fill(st, want) {
  var out = new Float32Array(want * 2);
  var got = 0;
  for (var guard = 0; got < want && guard < 100000; guard++) {
    var t0 = st.resampling ? now() : 0;
    var n = st.sink.pull(out, got, want - got);
    if (st.resampling) { stats.resampleMs += now() - t0; stats.resampledFrames += n; }
    got += n;
    if (got >= want) break;
    if (st.needsPrior) {
      var prior = new Float32Array(2);
      if (!readSource(st.seg, st.srcNext - 1, 1, prior)) break;
      st.sink.prime(prior);
      st.needsPrior = false;
    }
    var chunk = readChunk(st, SRC_CHUNK);
    if (chunk === null) break;
    if (st.stretch) {
      var t1 = now();
      chunk = st.stretch.push(chunk);
      stats.stretchMs += now() - t1;
      stats.stretchedFrames += chunk.length / 2;
    }
    if (chunk.length > 0) st.sink.push(chunk);
  }
  if (got === 0) return null;
  return got < want ? out.slice(0, got * 2) : out;
}

// ── scrub grains ───────────────────────────────────────────────────────────
var GRAIN_MAX_PENDING = 3;   // newer scrubs bump the oldest waiting one
var GRAIN_EXPIRE_MS = 300;   // a grain this late no longer belongs to where the pointer is
var GRAIN_MIN_FRAMES = 64;   // a sliver at a segment edge is not worth a message
var scrubs = [];

function onScrub(m) {
  var len = fin(m.lenS, 0);
  var time = fin(m.time, NaN);
  if (!(len > 0) || time !== time) return;
  scrubs.push({ time: time, dir: m.dir < 0 ? -1 : 1, lenS: len, at: now(), done: {} });
  while (scrubs.length > GRAIN_MAX_PENDING) scrubs.shift();
  schedulePump();
}

// One segment's grain, or null while a source block it needs is on its way.
// n output frames; the source is read at speed * srcRate / outRate source
// frames per output frame (the clip's speed, so the pitch follows it, as a
// tape scrub does), forwards or backwards from the position.
function renderGrain(s, sc) {
  var avail = sc.dir > 0 ? s.tlEnd - sc.time : sc.time - s.tlStart;
  var n = Math.floor(Math.min(sc.lenS, avail) * outRate);
  if (!(n >= GRAIN_MIN_FRAMES)) return { frames: 0 };
  var step = sc.dir * s.speed * s.sampleRate / outRate;
  var x0 = (s.srcIn + (sc.time - s.tlStart) * s.speed) * s.sampleRate;
  var xe = x0 + step * (n - 1);
  var lo = Math.floor(Math.min(x0, xe)) - 1;
  var hi = Math.floor(Math.max(x0, xe)) + 2;
  var src = new Float32Array((hi - lo + 1) * 2);
  if (!readSource(s, lo, hi - lo + 1, src)) return null;
  var out = new Float32Array(n * 2);
  var span = n > 1 ? n - 1 : 1;
  for (var j = 0; j < n; j++) {
    var x = x0 + step * j;
    var xi = Math.floor(x);
    var t = x - xi;
    var tm1 = t - 1, tm2 = t - 2, tp1 = t + 1;
    var c0 = -t * tm1 * tm2 / 6;
    var c1 = tp1 * tm1 * tm2 / 2;
    var c2 = -tp1 * t * tm2 / 2;
    var c3 = tp1 * t * tm1 / 6;
    var b = (xi - 1 - lo) * 2;
    var w = 0.5 * (1 - Math.cos(2 * Math.PI * j / span));
    out[j * 2] = w * (c0 * src[b] + c1 * src[b + 2] + c2 * src[b + 4] + c3 * src[b + 6]);
    out[j * 2 + 1] = w * (c0 * src[b + 1] + c1 * src[b + 3] + c2 * src[b + 5] + c3 * src[b + 7]);
  }
  return { frames: n, pcm: out };
}

function serveScrubs() {
  if (scrubs.length === 0) return;
  var t0 = now();
  var keep = [];
  for (var i = 0; i < scrubs.length; i++) {
    var sc = scrubs[i];
    if (t0 - sc.at > GRAIN_EXPIRE_MS) continue;
    var waiting = false;
    for (var j = 0; j < plan.length; j++) {
      var s = plan[j];
      if (sc.done[s.id] === s.ver) continue;
      if (!(sc.time >= s.tlStart && sc.time < s.tlEnd)) continue;
      var g = port ? renderGrain(s, sc) : null;
      if (g === null) { waiting = true; continue; }
      sc.done[s.id] = s.ver;
      if (g.frames > 0) {
        port.postMessage({ t: 'grain', id: s.id, ver: s.ver, time: sc.time, frames: g.frames, pcm: g.pcm }, [g.pcm.buffer]);
        stats.grains++;
      }
    }
    if (waiting) keep.push(sc);
  }
  scrubs = keep;
}

var pumpScheduled = false;
function schedulePump() {
  if (pumpScheduled || disposed) return;
  pumpScheduled = true;
  Promise.resolve().then(function () {
    pumpScheduled = false;
    serveScrubs();
    pump();
  });
}

function pump() {
  if (disposed || !port || gen < 0) return;
  var ahead = Math.round(aheadS * outRate);
  var refill = Math.round(refillS * outRate);
  var maxPost = Math.max(128, Math.round(maxPostS * outRate));
  var order = [];
  for (var i = 0; i < plan.length; i++) {
    var s = plan[i];
    var span = segSpan(s);
    if (span[1] <= clockK) { streams.delete(s.id); continue; }   // over
    if (span[0] > clockK + ahead) continue;                      // not within the horizon yet
    var st = streams.get(s.id);
    // A stream that fell behind the clock restarts at the clock: frames in the past are useless.
    if (!st || st.ver !== s.ver || st.nextK < clockK) {
      st = createStream(s, clockK);
      streams.set(s.id, st);
    }
    st.kEnd = span[1];
    order.push(st);
  }
  order.sort(function (a, b) { return a.nextK - b.nextK; });
  for (var j = 0; j < order.length; j++) {
    var st2 = order[j];
    var target = Math.min(st2.kEnd, clockK + ahead);
    if (st2.nextK >= target) continue;
    // Enough lead already: top up in bigger steps, not on every clock report.
    // Not after a fill a missing block cut short: that one finishes first.
    if (!st2.waiting && st2.nextK - clockK > ahead - refill && target < st2.kEnd) continue;
    prefetch(st2, target);
    st2.waiting = false;
    while (st2.nextK < target) {
      var want = Math.min(target - st2.nextK, maxPost);
      var pcm = fill(st2, want);
      if (pcm === null) { st2.waiting = true; break; }
      var got = pcm.length / 2;
      port.postMessage({
        t: 'block', gen: gen, id: st2.seg.id, ver: st2.ver, k0: st2.nextK, frames: got, pcm: pcm,
      }, [pcm.buffer]);
      st2.nextK += got;
      stats.blocksPosted++;
      stats.framesPosted += got;
      if (got < want) { st2.waiting = true; break; }
    }
  }
}

function postStats() {
  lastStatsAt = now();
  stats.planGen = planGen;
  stats.gen = gen;
  stats.cacheBytes = cache.bytes();
  stats.cacheBlocks = cache.size();
  stats.cacheEvictions = cache.evictions();
  stats.inflight = inflight.size;
  postMain(stats);
}

self.onmessage = function (ev) {
  var m = ev.data;
  if (!m || disposed) return;
  if (m.t === 'init') {
    outRate = fin(m.sampleRate, 48000);
    if (fin(m.aheadS, 0) > 0) aheadS = m.aheadS;
    if (fin(m.refillS, -1) >= 0) refillS = m.refillS;
    if (fin(m.blockS, 0) > 0) blockS = m.blockS;
    if (fin(m.maxPostS, 0) > 0) maxPostS = m.maxPostS;
    if (fin(m.cacheBytes, 0) > 0) { cacheCap = m.cacheBytes; cache = createLru(cacheCap); }
    if (fin(m.maxInflight, 0) >= 1) maxInflight = Math.floor(m.maxInflight);
    port = m.port;
    port.onmessage = function (e) { onPort(e.data); };
    if (plan.length > 0) postSegments();
    schedulePump();
  } else if (m.t === 'plan') {
    setPlan(m);
  } else if (m.t === 'scrub') {
    onScrub(m);
  } else if (m.t === 'stats') {
    postStats();
  } else if (m.t === 'dispose') {
    disposed = true;
    streams.clear();
    scrubs = [];
    cache.clear();
    if (port) {
      port.onmessage = null;
      if (typeof port.close === 'function') port.close();
      port = null;
    }
    if (typeof self.close === 'function') self.close();
  }
};

// Test hook: absent in a real Worker.
if (typeof self.__montajMixExpose === 'function') {
  self.__montajMixExpose({
    timeStretch: timeStretch,
    createStreamStretch: createStreamStretch,
    createResampler: createResampler,
    createFifo: createFifo,
    convertPcm: convertPcm,
    createLru: createLru,
    normSeg: normSeg,
    sigOf: sigOf,
    state: function () {
      return {
        gen: gen, anchorTime: anchorTime, rate: rate, clockK: clockK, playing: playing,
        planGen: planGen, plan: plan, streams: streams, cache: cache, inflight: inflight,
        knownFrames: knownFrames, stats: stats, outRate: outRate, aheadS: aheadS,
      };
    },
  });
}
`
