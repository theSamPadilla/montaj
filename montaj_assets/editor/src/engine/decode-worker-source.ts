/**
 * SP4 T3 — the decode worker, as an inlined source string.
 *
 * Loaded via `URL.createObjectURL(new Blob([decodeWorkerSource], { type:
 * 'text/javascript' }))` and `new Worker(url)` — a **classic** worker, so this
 * string must be plain JS with no imports (plan decision 6: the Blob-URL form
 * is the only one that needs nothing from a consumer's bundler; `?raw` is
 * Vite-only and `new Worker(new URL(...))` can only be verified against Hub's
 * webpack config, which does not live in this repo).
 *
 * Because it is a string, it cannot be type-checked, linted or unit-tested as
 * a module — so it is kept **thin by architecture**. Everything that decides
 * *what* to decode (batch boundaries, keyframe alignment, batch sizing, the
 * min-cts pre-roll target, the epsilon value itself) lives main-side in
 * `batch-planner.ts` under test. What is left here is the irreducible
 * off-main-thread part:
 *
 *  1. a serial queue over exactly one `VideoDecoder` (every request awaits the
 *     previous one's `flush()`, so the `output` callback always belongs to the
 *     request marked `current`);
 *  2. supersession by request id — **no `decoder.reset()` anywhere**. `reset()`
 *     drops the decoder to `unconfigured` and the next `decode()` throws
 *     `InvalidStateError`, so a superseded request is handled purely by never
 *     transferring its frames (they are closed here instead, immediately);
 *  3. the pre-roll drop, using the epsilon handed over at `init` (SP1 §7.2 —
 *     see `PRE_ROLL_EPSILON_US` in `batch-planner.ts` for why 1µs);
 *  4. the **total `done` contract**: every `decodeRange` posts exactly one
 *     `done`, whether it decoded, was skipped as stale before reaching the
 *     decoder, or threw. SP1 §7.4 is what happens without it — `frame-server`'s
 *     pending map orphans an entry and a seek promise never settles.
 *
 * Samples arrive by structured clone (never transfer): mp4box allocates a
 * dedicated `Uint8Array` per sample, so a clone copies exactly that sample's
 * bytes, whereas transferring would detach the buffer from the demuxed sample
 * table and corrupt every later request that overlaps the same GOP. See
 * `frame-server.ts`'s `postBatch`.
 *
 * `spikes/playback-engine/src/decode-worker.ts` is the precedent; the
 * deliberate simplification is that `done` is posted from ONE place after the
 * try/catch instead of once per exit path.
 */
export const decodeWorkerSource = `'use strict';

var decoder = null;
var queue = [];
var latestReqId = -1;
var processing = false;
var preRollEpsilonUs = 1;

// The request being fed to the decoder right now. At most one exists: drain()
// awaits each request's flush() before starting the next, so every output
// callback belongs to whichever request is current when it fires.
var current = null;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function describe(err) {
  return err && err.message ? err.message : String(err);
}

function onFrame(frame) {
  if (!current || current.reqId < latestReqId) {
    // Superseded while this request was still flushing. Close, never transfer.
    frame.close();
    if (current) current.dropped++;
    return;
  }
  if (frame.timestamp < current.targetTsUs - preRollEpsilonUs) {
    // Pre-roll: decoded only to prime prediction from the keyframe.
    frame.close();
    current.dropped++;
    return;
  }
  current.decoded++;
  post({ t: 'frame', frame: frame, reqId: current.reqId }, [frame]);
}

async function runRange(req) {
  current = { reqId: req.reqId, targetTsUs: req.targetTsUs, decoded: 0, dropped: 0 };
  try {
    if (!decoder) throw new Error('decodeRange before init');
    for (var i = 0; i < req.samples.length; i++) {
      var s = req.samples[i];
      decoder.decode(new EncodedVideoChunk({
        type: s.isKey ? 'key' : 'delta',
        timestamp: s.tsUs,
        duration: s.durUs,
        data: s.data,
      }));
    }
    await decoder.flush();
  } catch (err) {
    post({ t: 'error', message: 'decode: ' + describe(err), reqId: req.reqId });
  }
  // Unconditional: the total done contract has exactly one site.
  post({ t: 'done', reqId: req.reqId, decoded: current.decoded, dropped: current.dropped });
  current = null;
}

async function drain() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    var req = queue.shift();
    if (req.reqId < latestReqId) {
      // Stale before decoding a byte - still owes its done.
      post({ t: 'done', reqId: req.reqId, decoded: 0, dropped: 0 });
      continue;
    }
    await runRange(req);
  }
  processing = false;
}

self.onmessage = function (ev) {
  var cmd = ev.data;
  if (cmd.t === 'init') {
    if (typeof cmd.preRollEpsilonUs === 'number') preRollEpsilonUs = cmd.preRollEpsilonUs;
    try {
      decoder = new VideoDecoder({
        output: onFrame,
        error: function (e) { post({ t: 'error', message: 'decoder: ' + describe(e) }); },
      });
      decoder.configure({
        codec: cmd.codec,
        description: cmd.description,
        hardwareAcceleration: cmd.hardwareAcceleration,
      });
    } catch (err) {
      post({ t: 'error', message: 'init: ' + describe(err) });
    }
    return;
  }
  if (cmd.t === 'decodeRange') {
    if (cmd.reqId > latestReqId) latestReqId = cmd.reqId;
    queue.push(cmd);
    drain();
  }
};
`
