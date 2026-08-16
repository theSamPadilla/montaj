/**
 * SP4 T4 — the master clock's `AudioWorkletProcessor`, as an inlined source
 * string.
 *
 * Loaded via `URL.createObjectURL(new Blob([audioWorkletSource], { type:
 * 'text/javascript' }))` and `ctx.audioWorklet.addModule(url)` — plan decision
 * 6, the same rule `decode-worker-source.ts` follows and for the same reason:
 * the Blob-URL form is the only one that needs nothing from a consumer's
 * bundler (`?raw` is Vite-only, and montaj's ui is not the only host).
 *
 * Because it is a string it cannot be type-checked, linted or unit-tested, so
 * — exactly like the decode worker — it is **thin by architecture**. Every
 * decision lives main-side in `audio-clock.ts` under test: what to decode,
 * how much to keep queued, the PCM volume scaling, the resample ratio, the
 * project↔media time mapping, the clock extrapolation. What is left here is
 * the irreducible audio-thread part:
 *
 *  1. a FIFO of interleaved Float32 PCM chunks, drained one render quantum at
 *     a time ("ring buffer" is the spike's name for it; the transport is
 *     postMessage chunks, NOT a `SharedArrayBuffer` — Hub cannot serve the
 *     COOP/COEP headers cross-origin isolation requires, plan decision 4);
 *  2. `samplesConsumed`: how many output frames have actually been rendered
 *     since the last reset. This — not decode progress, not wall time — is
 *     the master clock's ground truth, reported back at ~10Hz;
 *  3. **silence through underruns**: an empty queue renders silence and the
 *     frame counter still advances. A real audio device does not stall when
 *     it is starved, and neither may the clock: freezing it here would freeze
 *     the canvas painter that follows it (SP1 §6 measured playback against
 *     exactly this clock);
 *  4. a `playing` gate, so pause stops output *and* stops the clock without
 *     tearing down the node;
 *  5. an `epoch` echoed on every report, so main can discard readings that
 *     were in flight when it reset the ring (a seek). Same shape as the decode
 *     worker's `reqId` supersession — SP1 §7.3/§7.4 are what stale-request
 *     bookkeeping costs when it is missing.
 *
 * Constants are INJECTED via `processorOptions` rather than duplicated in the
 * string (the string cannot import), matching how `decode-worker-source.ts`
 * receives `preRollEpsilonUs` at `init`.
 *
 * `spikes/playback-engine/src/audio-worklet.js` is the precedent. The
 * deliberate additions over it are the `playing` gate, the `epoch`, and the
 * duplicate-registration guard — the spike had no transport (it played once,
 * from a context it owned and threw away), whereas this runs on the page's
 * ONE shared `window.__montajSharedCtx`, which outlives every clock built on
 * it and would otherwise throw `NotSupportedError` on the second
 * `registerProcessor` of the same name (dev HMR and every clip-boundary
 * clock swap both hit that path).
 */

/** Processor name registered by `audioWorkletSource`. Keep in sync with the string. */
export const RING_PROCESSOR_NAME = 'montaj-engine-pcm-ring'

export const audioWorkletSource = `'use strict';

class MontajRingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var opts = (options && options.processorOptions) || {};
    // ~10Hz. Injected, not hardcoded: audio-clock.ts owns the number because
    // its wall-clock extrapolation window is derived from the same constant.
    this.reportIntervalS = typeof opts.reportIntervalS === 'number' ? opts.reportIntervalS : 0.1;

    // FIFO of { pcm: Float32Array (interleaved), channels: number, offsetFrames: number }.
    this.queue = [];
    this.queuedFrames = 0;    // frames sitting in the FIFO, not yet rendered
    this.samplesConsumed = 0; // output frames rendered since the last reset — the clock's ground truth
    this.underrunFrames = 0;  // of those, how many were silence because the FIFO was empty
    this.epoch = 0;           // bumped by main on every reset; echoed on every report
    this.playing = false;     // pause gate: no output, no drain, no clock advance
    this.lastReportAt = 0;    // AudioWorkletGlobalScope currentTime (s) at the last report

    this.port.onmessage = (ev) => {
      var msg = ev.data;
      if (msg.t === 'chunk') {
        this.queue.push({ pcm: msg.pcm, channels: msg.channels, offsetFrames: 0 });
        this.queuedFrames += msg.frames;
      } else if (msg.t === 'play') {
        this.playing = true;
      } else if (msg.t === 'pause') {
        this.playing = false;
        // Report immediately: main freezes the playhead at pause and wants the
        // truest sample count it can get rather than waiting up to a full
        // report interval for one.
        this.report();
      } else if (msg.t === 'reset') {
        this.queue = [];
        this.queuedFrames = 0;
        this.samplesConsumed = 0;
        this.underrunFrames = 0;
        this.epoch = msg.epoch;
        this.lastReportAt = currentTime;
        this.report();
      }
    };
  }

  report() {
    this.port.postMessage({
      t: 'consumed',
      epoch: this.epoch,
      samplesConsumed: this.samplesConsumed,
      underrunFrames: this.underrunFrames,
      queuedFrames: this.queuedFrames,
    });
  }

  process(_inputs, outputs) {
    var output = outputs[0];
    if (!output || output.length === 0 || !output[0]) return true;
    var frameCount = output[0].length;
    var outChannels = output.length;

    // Paused: leave \`output\` untouched (it arrives zero-filled, i.e. silence)
    // and do NOT advance the clock or drain the FIFO. Resuming continues from
    // exactly where the audio stopped.
    if (this.playing) {
      for (var i = 0; i < frameCount; i++) {
        var entry = this.queue[0];
        if (!entry) {
          // Underrun: nothing queued. This frame is silence and the clock
          // still advances through it — see the module header, point 3.
          this.underrunFrames++;
          continue;
        }
        var frameBase = entry.offsetFrames * entry.channels;
        for (var ch = 0; ch < outChannels; ch++) {
          // Fewer source channels than outputs (mono source, stereo out):
          // duplicate the last source channel rather than emitting silence.
          var srcCh = ch < entry.channels ? ch : entry.channels - 1;
          output[ch][i] = entry.pcm[frameBase + srcCh];
        }
        entry.offsetFrames++;
        this.queuedFrames--;
        if (entry.offsetFrames * entry.channels >= entry.pcm.length) this.queue.shift();
      }
      this.samplesConsumed += frameCount;
    }

    if (currentTime - this.lastReportAt >= this.reportIntervalS) {
      this.lastReportAt = currentTime;
      this.report();
    }

    return true; // keep the processor alive for the life of the node
  }
}

// The AudioWorkletGlobalScope belongs to the CONTEXT, and the context here is
// the page-lifetime shared one — so this module can be added more than once
// (a second clock, a dev-server hot reload). A duplicate registerProcessor
// throws NotSupportedError and rejects the addModule promise, which would drop
// an otherwise-healthy engine onto the wall-clock fallback. The name stays
// registered from the first load either way.
if (!globalThis.__montajEngineRingRegistered) {
  globalThis.__montajEngineRingRegistered = true;
  registerProcessor('${RING_PROCESSOR_NAME}', MontajRingProcessor);
}
`
