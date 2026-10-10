/**
 * §190 T2: the preview mixer's `AudioWorkletProcessor`, as an inlined source
 * string.
 *
 * Loaded the way `audio-worklet-source.ts` is: a Blob URL handed to
 * `ctx.audioWorklet.addModule`, so it needs nothing from a host's bundler (the
 * app's Vite build, the OSS UI and Hub all take it as a plain string). Tested
 * the same way too: `__tests__/mix-processor-source.test.ts` executes this
 * string with `new Function` against fake ports and a fake `currentTime`.
 *
 * Unlike the per-clip ring it replaces, this processor is where the mixing
 * decisions live, because they must be made per frame on the audio thread:
 *
 *  1. **The one project clock.** `k` counts output frames the clock has
 *     advanced in the current transport generation, and
 *     `timelineTime = anchorTime + rate * k / sampleRate`. It is reported to
 *     main (`t: 'report'`) and to the Worker (`t: 'clock'`) at ~20 Hz and on
 *     every transport change. Starvation never stalls it.
 *  2. **Segments.** Each has a timeline span, placed in output frames for the
 *     current generation with `Math.round((tl - anchorTime) * sampleRate /
 *     rate)` (the Worker places blocks with the same expression), a base gain,
 *     fades shaped with ffmpeg afade's formulas (what the export applies, see
 *     `exportFadeGain` in mix-protocol.ts), and live overrides (mute, gain).
 *     Every gain change ramps linearly over `smoothingS` (10 ms).
 *  3. **Blocks.** Interleaved stereo float32 PCM per segment, from the Worker,
 *     each stamped with its generation, the segment's version and its first
 *     output frame. A segment active at a frame with no block covering it is
 *     STARVING: it contributes silence and is counted; the others play on.
 *     A starved segment that gets audio again ramps back in over the transport
 *     fade, so a late block never clicks.
 *  4. **Transport.** play (5 ms fade-in), pause (5 ms fade-out, the clock runs
 *     through the fade and then stops), seek and rate (fade out, switch to the
 *     new generation at k = 0, fade back in). A pause and a resume stay in one
 *     generation, so a resume keeps every queued block. While a switch's
 *     fade-out runs, blocks for the PENDING generation are already accepted, so
 *     the Worker can start filling the new position 5 ms early.
 *  5. **No allocation in `process()`** after warm-up: segment state, block
 *     queues and the report objects are built in `onmessage`, and the report
 *     and clock messages reuse one object each (the structured clone that
 *     `postMessage` makes is the only per-report cost, ~20 times a second).
 *  6. **Ducking** (§190 T3), as the export applies it: render/mix-audio.js:162-179
 *     runs a ducked lane through ffmpeg `sidechaincompress`, keyed by the mix
 *     built before it. Segments mix in `stage` order, so when a stage begins
 *     the output buffers hold exactly the lower stages' sum, before the bus
 *     gain: that is the key. A ducked segment's detector runs over it on every
 *     frame the clock renders, active or not (the export's runs through the
 *     whole stream, the lane's leading silence included), with
 *     af_sidechaincompress.c's detector and gain computer (RMS, channels
 *     averaged, knee 2.82843; `exportDuckGain` in mix-protocol.ts is the
 *     reference). The detector keeps its state across a seek: the export's
 *     state there depends on key audio the mixer has not fetched, so it
 *     settles within the attack and release time constants instead.
 *
 * Starvation is split in two for the HUD: `primingFrames` (a segment that was
 * already active when its generation began, or when it joined the plan,
 * waiting for its first block: the seek-to-sound wait) and `underrunFrames`
 * (every other starved frame, the number that must stay 0 in steady
 * playback). Both are segment-frames, summed over segments.
 */
import { MIX_PROCESSOR_NAME } from './mix-protocol'

export { MIX_PROCESSOR_NAME }

export const mixProcessorSource = `'use strict';

var CURVE_LINEAR = 0;
var CURVE_EXP = 1;
var CURVE_LOG = 2;

var S_PAUSED = 0;
var S_PLAYING = 1;
var S_STOPPING = 2;  // fading out to a pause; the clock still runs
var S_SWITCHING = 3; // fading out to a seek or rate change

// 5 * ln(0.1): ffmpeg afade's exp curve, -100 dB at the silent edge.
var EXP_K = -11.512925464970227;

function curveCode(name) {
  if (name === 'linear' || name === 'tri') return CURVE_LINEAR;
  if (name === 'log') return CURVE_LOG;
  return CURVE_EXP;
}

// ffmpeg afade fade_gain, x in [0, 1]: 0 at the silent edge, 1 at full level.
function shape(curve, x) {
  if (x >= 1) return 1;
  if (x < 0) x = 0;
  if (curve === CURVE_LINEAR) return x;
  if (curve === CURVE_LOG) {
    if (x <= 0) return 0;
    var g = 1 + 0.2 * Math.log10(x);
    return g < 0 ? 0 : g;
  }
  return Math.exp(EXP_K * (1 - x));
}

function fin(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// sidechaincompress's default knee; the export leaves it as it is.
var DUCK_KNEE = 2.82843;

// af_sidechaincompress.c output_gain (downward, RMS detection, knee > 1): the
// gain for detector level ls, a mean square above the knee's start. Inside the
// knee it is ffmpeg's hermite_interpolation(slope, kneeStart, kneeStop,
// kneeStart, compKneeStop, 1, 1 / ratio), written out.
function duckGain(d, ls) {
  var slope = 0.5 * Math.log(ls);
  var gain;
  if (slope < d.kneeStop) {
    var w = d.kneeStop - d.kneeStart;
    var t = (slope - d.kneeStart) / w;
    var p0 = d.kneeStart, p1 = d.compKneeStop, m0 = w, m1 = w / d.ratio;
    var t2 = t * t;
    gain = (2 * p0 + m0 - 2 * p1 + m1) * (t2 * t) + (-3 * p0 - 2 * m0 + 3 * p1 - m1) * t2 + m0 * t + p0;
  } else {
    gain = (slope - d.thres) / d.ratio + d.thres;
  }
  return Math.exp(gain - slope);
}

class MontajMixProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var o = (options && options.processorOptions) || {};
    this.sr = fin(o.sampleRate, 0) > 0 ? o.sampleRate : (typeof sampleRate === 'number' ? sampleRate : 48000);
    this.reportIntervalS = fin(o.reportIntervalS, 0) > 0 ? o.reportIntervalS : 0.05;
    this.smoothFrames = Math.max(1, Math.round((fin(o.smoothingS, 0) > 0 ? o.smoothingS : 0.01) * this.sr));
    this.fadeFrames = Math.max(1, Math.round((fin(o.transportFadeS, 0) > 0 ? o.transportFadeS : 0.005) * this.sr));

    // The clock: timelineTime = anchorTime + rate * k / sr.
    this.seq = 0;
    this.gen = 0;
    this.anchorTime = fin(o.startTime, 0);
    this.rate = 1;
    this.k = 0;
    this.state = S_PAUSED;
    this.pending = null;            // { gen, anchorTime, rate } waiting on the fade-out
    this.resumeAfterSwitch = false;

    // Bus envelope: the transport fade (tg) and the master gain (mg), each a linear ramp.
    this.tg = 0; this.tgTarget = 0; this.tgStep = 0; this.tgLeft = 0;
    this.mg = 1; this.mgTarget = 1; this.mgStep = 0; this.mgLeft = 0;

    this.renderedFrames = 0;
    this.underrunFrames = 0;
    this.primingFrames = 0;

    this.segs = [];
    this.segById = new Map();
    this.overrides = new Map();     // id -> { mute, gain }; survives plan changes

    this.gainBuf = new Float32Array(128);
    this.lastReportAt = -1e9;
    this.reportPending = false;
    this.wport = null;
    this.disposed = false;

    this.rep = {
      t: 'report', seq: 0, gen: 0, playing: false, rate: 1, k: 0, renderedFrames: 0,
      timelineTime: 0, contextTime: 0, underrunFrames: 0, primingFrames: 0, starving: [], queuedFrames: 0,
    };
    this.clk = { t: 'clock', gen: 0, k: 0, playing: false };

    var self = this;
    this.port.onmessage = function (ev) { self.onMain(ev.data); };
  }

  // ── messages ──────────────────────────────────────────────────────────────

  onMain(m) {
    if (!m || this.disposed) return;
    if (m.t === 'connect') {
      var self = this;
      this.wport = m.port;
      this.wport.onmessage = function (ev) { self.onWorker(ev.data); };
      this.sendTransport();
    } else if (m.t === 'play') {
      this.seq = m.seq;
      this.opPlay();
      this.report(0);
    } else if (m.t === 'pause') {
      this.seq = m.seq;
      this.opPause();
      this.report(0);
    } else if (m.t === 'seek') {
      this.seq = m.seq;
      this.opSwitch(m.gen, fin(m.time, 0), NaN);
      this.report(0);
    } else if (m.t === 'rate') {
      this.seq = m.seq;
      var r = fin(m.rate, 1);
      this.opSwitch(m.gen, NaN, r === 0 ? 1 : r);
      this.report(0);
    } else if (m.t === 'params') {
      this.applyParams(m);
    } else if (m.t === 'report') {
      this.report(0);
    } else if (m.t === 'dispose') {
      this.disposed = true;
      this.state = S_PAUSED;
      this.segs = [];
      this.segById = new Map();
      if (this.wport) {
        this.wport.onmessage = null;
        if (typeof this.wport.close === 'function') this.wport.close();
        this.wport = null;
      }
    }
  }

  onWorker(m) {
    if (!m || this.disposed) return;
    if (m.t === 'block') {
      var seg = this.segById.get(m.id);
      if (!seg || seg.ver !== m.ver) return;
      var blk = { k0: m.k0, end: m.k0 + m.frames, pcm: m.pcm };
      if (m.gen === this.gen) {
        if (seg.qh > 16) { seg.q.splice(0, seg.qh); seg.qh = 0; }
        seg.q.push(blk);
      } else if (this.pending !== null && m.gen === this.pending.gen) {
        seg.qp.push(blk);
      }
    } else if (m.t === 'segments') {
      this.applySegments(m.segs || []);
    }
  }

  // ── transport ─────────────────────────────────────────────────────────────

  rampTransport(target) {
    this.tgTarget = target;
    if (this.tg === target) { this.tgLeft = 0; this.tgStep = 0; return; }
    var frames = Math.max(1, Math.round(Math.abs(target - this.tg) * this.fadeFrames));
    this.tgStep = (target - this.tg) / frames;
    this.tgLeft = frames;
  }

  opPlay() {
    if (this.state === S_PAUSED) {
      this.state = S_PLAYING;
      this.rampTransport(1);
      this.sendTransport();
    } else if (this.state === S_STOPPING) {
      this.state = S_PLAYING;
      this.rampTransport(1);
    } else if (this.state === S_SWITCHING) {
      this.resumeAfterSwitch = true;
    }
  }

  opPause() {
    if (this.state === S_PLAYING) {
      this.state = S_STOPPING;
      this.rampTransport(0);
      if (this.tgLeft === 0) this.finishStop();
    } else if (this.state === S_SWITCHING) {
      this.resumeAfterSwitch = false;
    }
  }

  // A seek (time given) or a rate change (rate given; the anchor is wherever
  // the clock will be when the fade-out ends).
  opSwitch(gen, time, rate) {
    var base = this.pending;
    var newRate = rate === rate ? rate : (base !== null ? base.rate : this.rate);
    if (this.state === S_PAUSED) {
      this.applyGen(gen, time === time ? time : this.tlAt(this.k), newRate, false);
      this.sendTransport();
      return;
    }
    if (this.state === S_PLAYING) {
      this.resumeAfterSwitch = true;
      this.state = S_SWITCHING;
      this.rampTransport(0);
    } else if (this.state === S_STOPPING) {
      this.resumeAfterSwitch = false;
      this.state = S_SWITCHING;
    }
    var anchor = time === time ? time : (base !== null ? base.anchorTime : this.tlAt(this.k + this.tgLeft));
    this.pending = { gen: gen, anchorTime: anchor, rate: newRate };
    for (var i = 0; i < this.segs.length; i++) this.segs[i].qp = [];
    if (this.tgLeft === 0) { this.finishSwitch(); return; }
    // Let the Worker start on the new position while the old one fades out.
    if (this.wport) {
      this.wport.postMessage({
        t: 'transport', gen: gen, anchorTime: anchor, rate: newRate, k: 0, playing: this.resumeAfterSwitch,
      });
    }
  }

  finishStop() {
    this.state = S_PAUSED;
    this.tg = 0; this.tgLeft = 0;
    this.sendTransport();
    this.reportPending = true;
  }

  finishSwitch() {
    var p = this.pending;
    this.pending = null;
    this.applyGen(p.gen, p.anchorTime, p.rate, true);
    if (this.resumeAfterSwitch) {
      this.state = S_PLAYING;
      this.tg = 0;
      this.rampTransport(1);
    } else {
      this.state = S_PAUSED;
      this.tg = 0; this.tgLeft = 0;
    }
    this.sendTransport();
    this.reportPending = true;
  }

  applyGen(gen, anchorTime, rate, adoptPending) {
    this.gen = gen;
    this.anchorTime = anchorTime;
    this.rate = rate;
    this.k = 0;
    for (var i = 0; i < this.segs.length; i++) {
      var seg = this.segs[i];
      seg.q = adoptPending ? seg.qp : [];
      seg.qp = [];
      seg.qh = 0;
      seg.fed = false;
      seg.wasStarving = false;
      seg.egLeft = 0; seg.eg = 1;
      this.place(seg);
      seg.activeAtStart = seg.kStart <= 0 && seg.kEnd > 0;
    }
  }

  sendTransport() {
    if (!this.wport) return;
    this.wport.postMessage({
      t: 'transport', gen: this.gen, anchorTime: this.anchorTime, rate: this.rate, k: this.k,
      playing: this.state !== S_PAUSED,
    });
  }

  tlAt(k) {
    return this.anchorTime + this.rate * k / this.sr;
  }

  // The same expression the Worker places blocks with.
  place(seg) {
    var a = Math.round((seg.tlStart - this.anchorTime) * this.sr / this.rate);
    var b = seg.tlEnd === Infinity
      ? (this.rate > 0 ? Infinity : -Infinity)
      : Math.round((seg.tlEnd - this.anchorTime) * this.sr / this.rate);
    if (a <= b) { seg.kStart = a; seg.kEnd = b; } else { seg.kStart = b; seg.kEnd = a; }
  }

  // ── segments and gains ────────────────────────────────────────────────────

  newSeg(id) {
    return {
      id: id, ver: -1, tlStart: 0, tlEnd: Infinity, base: 1,
      fadeIn: 0, fadeOut: 0, curveIn: CURVE_EXP, curveOut: CURVE_EXP, hasFade: false,
      kStart: 0, kEnd: 0, q: [], qh: 0, qp: [],
      g: 0, gTarget: 0, gStep: 0, gLeft: 0, fresh: true,
      eg: 1, egStep: 0, egLeft: 0,
      fed: false, wasStarving: false, activeAtStart: false, starved: false, starvedFrames: 0,
      stage: 0, dk: null, db: null,
    };
  }

  // A ducked segment's compressor: sidechaincompress's derived constants
  // (af_sidechaincompress.c compressor_config_output) at this context's rate,
  // and the detector state, kept across plan changes. ffmpeg rejects an option
  // outside its range (and the export with it); the preview clamps to it.
  setDuck(seg, d) {
    if (!d || typeof d !== 'object') { seg.dk = null; return; }
    var thr = clamp(fin(d.threshold, 0.125), 0.000976563, 1);
    var ratio = clamp(fin(d.ratio, 2), 1, 20);
    var att = clamp(fin(d.attackMs, 20), 0.01, 2000);
    var rel = clamp(fin(d.releaseMs, 250), 0.01, 9000);
    var dk = seg.dk || { ls: 0 };
    var ks = thr / Math.sqrt(DUCK_KNEE);
    dk.thres = Math.log(thr);
    dk.ratio = ratio;
    dk.adjKneeStart = ks * ks;
    dk.kneeStart = Math.log(ks);
    dk.kneeStop = Math.log(thr * Math.sqrt(DUCK_KNEE));
    dk.compKneeStop = (dk.kneeStop - dk.thres) / ratio + dk.thres;
    dk.att = Math.min(1, 1 / (att * this.sr / 4000));
    dk.rel = Math.min(1, 1 / (rel * this.sr / 4000));
    seg.dk = dk;
    if (seg.db === null || seg.db.length < this.gainBuf.length) seg.db = new Float32Array(this.gainBuf.length);
  }

  applySegments(list) {
    var next = [];
    var byId = new Map();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var seg = this.segById.get(p.id);
      if (!seg) seg = this.newSeg(p.id);
      var joined = false;
      if (seg.ver !== p.ver) {
        // New, or its audio mapping changed: everything queued for it is wrong now.
        seg.ver = p.ver;
        seg.q = []; seg.qh = 0; seg.qp = [];
        seg.fed = false; seg.wasStarving = false;
        joined = true;
      }
      seg.tlStart = fin(p.tlStart, 0);
      seg.tlEnd = typeof p.tlEnd === 'number' && p.tlEnd === p.tlEnd ? p.tlEnd : Infinity;
      seg.base = fin(p.gain, 1);
      seg.fadeIn = Math.max(0, fin(p.fadeIn, 0));
      seg.fadeOut = Math.max(0, fin(p.fadeOut, 0));
      seg.curveIn = curveCode(p.curveIn);
      seg.curveOut = curveCode(p.curveOut);
      seg.hasFade = seg.fadeIn > 0 || (seg.fadeOut > 0 && seg.tlEnd !== Infinity);
      seg.stage = fin(p.stage, 0);
      this.setDuck(seg, p.duck);
      this.place(seg);
      // Already playing when it joined: its wait for a first block is priming.
      if (joined) seg.activeAtStart = seg.kStart <= this.k && this.k < seg.kEnd;
      this.retarget(seg);
      next.push(seg);
      byId.set(seg.id, seg);
    }
    // Mix order (stable, so equal stages keep the plan's order).
    next.sort(function (a, b) { return a.stage - b.stage; });
    this.segs = next;
    this.segById = byId;
  }

  retarget(seg) {
    var ov = this.overrides.get(seg.id);
    var target = seg.base * (ov ? (ov.mute ? 0 : ov.gain) : 1);
    if (seg.fresh) {
      seg.fresh = false;
      seg.g = target; seg.gTarget = target; seg.gLeft = 0; seg.gStep = 0;
      return;
    }
    if (target === seg.gTarget) return;
    seg.gTarget = target;
    seg.gStep = (target - seg.g) / this.smoothFrames;
    seg.gLeft = this.smoothFrames;
  }

  applyParams(m) {
    var segsIn = m.segments;
    if (segsIn) {
      for (var id in segsIn) {
        var p = segsIn[id] || {};
        var ov = this.overrides.get(id);
        if (!ov) { ov = { mute: false, gain: 1 }; this.overrides.set(id, ov); }
        if (typeof p.mute === 'boolean') ov.mute = p.mute;
        if (typeof p.gain === 'number' && p.gain === p.gain) ov.gain = p.gain;
        var seg = this.segById.get(id);
        if (seg) this.retarget(seg);
      }
    }
    if (typeof m.master === 'number' && m.master === m.master && m.master !== this.mgTarget) {
      this.mgTarget = m.master;
      this.mgStep = (m.master - this.mg) / this.smoothFrames;
      this.mgLeft = this.smoothFrames;
    }
  }

  advanceGain(seg, m) {
    if (seg.gLeft > 0) {
      if (m >= seg.gLeft) { seg.g = seg.gTarget; seg.gLeft = 0; }
      else { seg.g += seg.gStep * m; seg.gLeft -= m; }
    }
  }

  // Both fades multiply, as the export's two chained afade filters do.
  fadeEnv(seg, tl) {
    var g = 1;
    if (seg.fadeIn > 0) {
      var x = (tl - seg.tlStart) / seg.fadeIn;
      if (x < 1) g = shape(seg.curveIn, x);
    }
    if (seg.fadeOut > 0 && seg.tlEnd !== Infinity) {
      var y = (seg.tlEnd - tl) / seg.fadeOut;
      if (y < 1) g *= shape(seg.curveOut, y);
    }
    return g;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  process(_inputs, outputs) {
    var out = outputs[0];
    if (!out || out.length === 0 || !out[0]) return !this.disposed;
    var L = out[0];
    var R = out.length > 1 ? out[1] : null;
    var n = L.length;
    if (this.gainBuf.length < n) { // warm-up only
      this.gainBuf = new Float32Array(n);
      for (var d = 0; d < this.segs.length; d++) if (this.segs[d].db !== null) this.segs[d].db = new Float32Array(n);
    }

    var off = 0;
    while (off < n && this.state !== S_PAUSED) {
      var len = n - off;
      var ending = this.tgLeft > 0 && this.tgTarget === 0 && this.tgLeft <= len;
      if (ending) len = this.tgLeft;
      this.renderRun(L, R, off, len);
      off += len;
      if (ending) {
        if (this.state === S_SWITCHING) this.finishSwitch();
        else if (this.state === S_STOPPING) this.finishStop();
      }
    }

    if (this.reportPending || currentTime - this.lastReportAt >= this.reportIntervalS) {
      this.lastReportAt = currentTime;
      this.reportPending = false;
      this.report(n);
    }
    return !this.disposed;
  }

  renderRun(L, R, off, len) {
    var gb = this.gainBuf;
    var tg = this.tg, tgStep = this.tgStep, tgLeft = this.tgLeft, tgT = this.tgTarget;
    var mg = this.mg, mgStep = this.mgStep, mgLeft = this.mgLeft, mgT = this.mgTarget;
    for (var i = 0; i < len; i++) {
      if (tgLeft > 0) { tg += tgStep; if (--tgLeft === 0) tg = tgT; }
      if (mgLeft > 0) { mg += mgStep; if (--mgLeft === 0) mg = mgT; }
      gb[i] = tg * mg;
    }
    this.tg = tg; this.tgLeft = tgLeft;
    this.mg = mg; this.mgLeft = mgLeft;

    var kRun = this.k;
    var segs = this.segs;
    // Stage by stage (segs are sorted by stage). When a stage begins, L and R
    // hold the lower stages' sum: the key its ducked segments are compressed by.
    var s = 0;
    while (s < segs.length) {
      var e = s;
      var st = segs[s].stage;
      for (; e < segs.length && segs[e].stage === st; e++) {
        if (segs[e].dk !== null) this.duckRun(segs[e], L, R, off, len, kRun);
      }
      for (; s < e; s++) this.mixSeg(segs[s], L, R, off, len, kRun);
    }

    for (var j = 0; j < len; j++) {
      var g = gb[j];
      L[off + j] *= g;
      if (R !== null) R[off + j] *= g;
    }
    this.k = kRun + len;
    this.renderedFrames += len;
  }

  // sidechaincompress's detector over this run's key (L and R as they stand),
  // into seg.db: a one-pole follower of the squared channel average, rising
  // with the attack coefficient and falling with the release's. The gain is
  // computed only where the segment plays and the level is past the knee's start.
  duckRun(seg, L, R, off, len, kRun) {
    var d = seg.dk, db = seg.db;
    var ls = d.ls, att = d.att, rel = d.rel, adj = d.adjKneeStart;
    var a = seg.kStart - kRun, b = seg.kEnd - kRun;
    for (var j = 0; j < len; j++) {
      var x = L[off + j];
      if (x < 0) x = -x;
      if (R !== null) {
        var y = R[off + j];
        x = (x + (y < 0 ? -y : y)) * 0.5;
      }
      x *= x;
      ls += (x - ls) * (x > ls ? att : rel);
      db[j] = j >= a && j < b && ls > adj ? duckGain(d, ls) : 1;
    }
    d.ls = ls;
  }

  mixSeg(seg, L, R, off, len, kRun) {
    var a = seg.kStart - kRun;
    if (a < 0) a = 0;
    var b = seg.kEnd - kRun;
    if (b > len) b = len;
    if (a >= b) { this.advanceGain(seg, len); return; }
    if (a > 0) this.advanceGain(seg, a);

    var q = seg.q;
    var sr = this.sr, anchor = this.anchorTime, rate = this.rate;
    var i = a;
    while (i < b) {
      var kk = kRun + i;
      var h = seg.qh;
      while (h < q.length && q[h].end <= kk) { q[h] = null; h++; }
      seg.qh = h;
      var blk = h < q.length ? q[h] : null;

      if (blk === null || blk.k0 > kk) {
        // Starving: silence for this segment, counted; the others play on.
        var stop = blk === null ? b : blk.k0 - kRun;
        if (stop > b) stop = b;
        var m = stop - i;
        seg.starved = true;
        seg.wasStarving = true;
        seg.starvedFrames += m;
        if (!seg.fed && seg.activeAtStart) this.primingFrames += m;
        else this.underrunFrames += m;
        this.advanceGain(seg, m);
        i = stop;
        continue;
      }

      if (seg.wasStarving) {
        // Audio again after a gap: ramp in rather than start mid-waveform.
        seg.wasStarving = false;
        seg.eg = 0;
        seg.egStep = 1 / this.fadeFrames;
        seg.egLeft = this.fadeFrames;
      }
      seg.fed = true;

      var stop2 = blk.end - kRun;
      if (stop2 > b) stop2 = b;
      var pcm = blk.pcm;
      var p = (kk - blk.k0) * 2;
      var g = seg.g, gStep = seg.gStep, gLeft = seg.gLeft, gT = seg.gTarget;
      var eg = seg.eg, egStep = seg.egStep, egLeft = seg.egLeft;
      var fade = seg.hasFade;
      var db = seg.dk !== null ? seg.db : null;
      for (var j = i; j < stop2; j++, p += 2) {
        if (gLeft > 0) { g += gStep; if (--gLeft === 0) g = gT; }
        var e = g;
        if (egLeft > 0) { eg += egStep; if (--egLeft === 0) eg = 1; e *= eg; }
        if (fade) e *= this.fadeEnv(seg, anchor + rate * (kRun + j) / sr);
        if (db !== null) e *= db[j];
        var o = off + j;
        L[o] += pcm[p] * e;
        if (R !== null) R[o] += pcm[p + 1] * e;
      }
      seg.g = g; seg.gLeft = gLeft;
      seg.eg = eg; seg.egLeft = egLeft;
      i = stop2;
    }
    if (b < len) this.advanceGain(seg, len - b);
  }

  // ── reports ───────────────────────────────────────────────────────────────

  // endFrames: frames rendered in the current quantum (contextTime is its end).
  report(endFrames) {
    var r = this.rep;
    r.seq = this.seq;
    r.gen = this.gen;
    r.playing = this.state !== S_PAUSED;
    r.rate = this.rate;
    r.k = this.k;
    r.renderedFrames = this.renderedFrames;
    r.timelineTime = this.tlAt(this.k);
    r.contextTime = currentTime + endFrames / this.sr;
    r.underrunFrames = this.underrunFrames;
    r.primingFrames = this.primingFrames;
    var st = r.starving;
    st.length = 0;
    var minQ = -1;
    var k = this.k;
    for (var i = 0; i < this.segs.length; i++) {
      var seg = this.segs[i];
      if (seg.starved) { st.push(seg.id); seg.starved = false; }
      if (seg.kStart <= k && k < seg.kEnd) {
        var tail = seg.q.length > seg.qh ? seg.q[seg.q.length - 1].end : k;
        var ahead = tail > k ? tail - k : 0;
        if (minQ < 0 || ahead < minQ) minQ = ahead;
      }
    }
    r.queuedFrames = minQ < 0 ? 0 : minQ;
    this.port.postMessage(r);
    if (this.wport) {
      var c = this.clk;
      c.gen = this.gen;
      c.k = this.k;
      c.playing = r.playing;
      this.wport.postMessage(c);
    }
  }
}

// One AudioWorkletGlobalScope per context, and the context is the page's
// shared one: a second addModule (another clock, a dev hot reload) must not
// register the name twice, or addModule rejects.
if (!globalThis.__montajMixRegistered) {
  globalThis.__montajMixRegistered = true;
  registerProcessor('${MIX_PROCESSOR_NAME}', MontajMixProcessor);
}
`
