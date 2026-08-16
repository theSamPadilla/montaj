/**
 * SP4 T2 — demux's pure parts.
 *
 * Everything here runs on synthetic sample tables: vitest/jsdom has no
 * WebCodecs and no MP4 fixture, and the container-parsing half of `demux.ts`
 * is mp4box's job, not ours. What *is* ours — and what SP1 proved is where
 * the bugs live (`spikes/playback-engine/RESULTS.md` §7.1) — is the
 * decode-order/presentation-order bookkeeping laid over those samples. Every
 * table below therefore includes a B-frame pattern, because the all-intra
 * case (what SP3's proxies actually are) cannot distinguish a correct
 * implementation from the broken one: with cts order == dts order, sorting by
 * presentation time and not sorting are the same answer. That is exactly how
 * §7.1 survived to the measurement stage.
 */
import { describe, it, expect } from 'vitest'
import type { MP4BoxSampleEntry, DataStream } from 'mp4box'
import {
  buildPresIndex,
  firstPresentationTsUs,
  sampleAtOrBefore,
  keyframeAtOrBefore,
  audioSpecificConfigFor,
  descriptionForEntries,
  type SampleRef,
  type SampleTable,
} from '../demux'

/** One synthetic sample. Times in µs; 1000µs "frames" keep the tables readable. */
function s(cts: number, dts: number, isKey = false): SampleRef {
  return { tsUs: cts, dtsUs: dts, durUs: 1000, isKey, data: new Uint8Array(0) }
}

function table(samples: SampleRef[]): SampleTable {
  return { samples, presIndex: buildPresIndex(samples) }
}

/**
 * All-intra, the shape SP3's AV1 proxies actually have: every sample a
 * keyframe, cts == dts, no reordering.
 */
function allIntra(n = 8, originUs = 0): SampleRef[] {
  return Array.from({ length: n }, (_, i) => s(originUs + i * 1000, originUs + i * 1000, true))
}

/**
 * A classic reordered GOP: display order 0..7, decode order I0 P3 B1 B2 P6 B4
 * B5 I7. Two sync samples — decode index 0 and decode index 7 — and, in the
 * `closedGop` variant, a third at decode index 4 whose presentation time
 * (6000) is LATER than frames that precede it in presentation order. That
 * third keyframe is what separates a decode-order walk from a
 * presentation-order one.
 */
function bFrameGop({ closedGop = false } = {}): SampleRef[] {
  return [
    s(0, 0, true), //     0: I0
    s(3000, 1000), //     1: P3
    s(1000, 2000), //     2: B1
    s(2000, 3000), //     3: B2
    s(6000, 4000, closedGop), // 4: P6 (or I6)
    s(4000, 5000), //     5: B4
    s(5000, 6000), //     6: B5
    s(7000, 7000, true), // 7: I7
  ]
}

describe('buildPresIndex', () => {
  it('is the identity for an all-intra table (cts order == dts order)', () => {
    expect(buildPresIndex(allIntra(8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('reorders a B-frame table into presentation order without touching the samples', () => {
    const samples = bFrameGop()
    const presIndex = buildPresIndex(samples)
    // cts by decode index: [0, 3000, 1000, 2000, 6000, 4000, 5000, 7000]
    expect(presIndex).toEqual([0, 2, 3, 1, 5, 6, 4, 7])
    // The sample array itself must be untouched — decode order is the contract.
    expect(samples.map((x) => x.dtsUs)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000])
    // And walking presIndex yields strictly ascending presentation times.
    expect(presIndex.map((i) => samples[i].tsUs)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000])
  })

  it('is stable for duplicate presentation times (ties keep decode order)', () => {
    const samples = [s(0, 0, true), s(1000, 1000), s(1000, 2000), s(1000, 3000), s(2000, 4000)]
    expect(buildPresIndex(samples)).toEqual([0, 1, 2, 3, 4])
  })

  it('handles an empty table', () => {
    expect(buildPresIndex([])).toEqual([])
  })
})

describe('firstPresentationTsUs', () => {
  it('is samples[0] for an all-intra table starting at zero', () => {
    const samples = allIntra(4)
    expect(firstPresentationTsUs(samples, buildPresIndex(samples))).toBe(0)
  })

  it('tracks a non-zero media origin (timestamps need not start at 0)', () => {
    const samples = allIntra(4, 1_500_000)
    expect(firstPresentationTsUs(samples, buildPresIndex(samples))).toBe(1_500_000)
  })

  it('is NOT samples[0] when decode order leads with a later presentation time', () => {
    // Decode order starts on a frame whose cts is 2000; the true origin (0)
    // sits at decode index 1. Reading samples[0].tsUs would be off by 2ms and
    // every project↔media time conversion downstream would inherit it.
    const samples = [s(2000, 0, true), s(0, 1000), s(1000, 2000)]
    const presIndex = buildPresIndex(samples)
    expect(samples[0].tsUs).toBe(2000)
    expect(firstPresentationTsUs(samples, presIndex)).toBe(0)
  })

  it('is 0 for an empty table', () => {
    expect(firstPresentationTsUs([], [])).toBe(0)
  })
})

describe('sampleAtOrBefore', () => {
  it('finds exact and in-between presentation times in an all-intra table', () => {
    const t = table(allIntra(8))
    expect(sampleAtOrBefore(t, 0)).toBe(0)
    expect(sampleAtOrBefore(t, 3000)).toBe(3)
    expect(sampleAtOrBefore(t, 3999)).toBe(3)
    expect(sampleAtOrBefore(t, 7000)).toBe(7)
  })

  it('clamps below the first frame and above the last', () => {
    const t = table(allIntra(8, 1000))
    expect(sampleAtOrBefore(t, -5000)).toBe(0)
    expect(sampleAtOrBefore(t, 1e9)).toBe(7)
  })

  it('returns a DECODE index, not a presentation rank (B-frame table)', () => {
    const t = table(bFrameGop())
    // t=2500 → latest cts <= 2500 is 2000, which is decode index 3 while
    // being the 3rd frame in presentation order. Returning the rank (2) would
    // slice the decode range at the wrong sample.
    expect(sampleAtOrBefore(t, 2500)).toBe(3)
    expect(t.samples[sampleAtOrBefore(t, 2500)].tsUs).toBe(2000)
    // t=3000 lands on P3, which sits at decode index 1.
    expect(sampleAtOrBefore(t, 3000)).toBe(1)
    // t=6000 lands on P6 at decode index 4.
    expect(sampleAtOrBefore(t, 6000)).toBe(4)
  })

  it('returns 0 for an empty table', () => {
    expect(sampleAtOrBefore({ samples: [], presIndex: [] }, 1000)).toBe(0)
  })
})

describe('keyframeAtOrBefore', () => {
  it('is the sample itself for an all-intra table (every frame is a sync sample)', () => {
    const t = table(allIntra(8))
    for (let i = 0; i < 8; i++) {
      expect(keyframeAtOrBefore(t, i * 1000)).toBe(i)
      expect(keyframeAtOrBefore(t, i * 1000)).toBe(sampleAtOrBefore(t, i * 1000))
    }
  })

  it('walks back to the GOP head across a reordered run', () => {
    const t = table(bFrameGop())
    // Everything from decode index 1..6 belongs to the GOP opened at index 0.
    expect(keyframeAtOrBefore(t, 2500)).toBe(0)
    expect(keyframeAtOrBefore(t, 5000)).toBe(0)
    // The last sample is itself a sync sample.
    expect(keyframeAtOrBefore(t, 7000)).toBe(7)
  })

  it('walks DECODE order, not presentation order — the SP1 §7.1 distinction', () => {
    const t = table(bFrameGop({ closedGop: true }))
    // Target t=5000 → B5 at decode index 6. Walking back through DECODE
    // order hits the sync sample at decode index 4 first, so the decode run
    // is [4..6] — three frames.
    expect(sampleAtOrBefore(t, 5000)).toBe(6)
    expect(keyframeAtOrBefore(t, 5000)).toBe(4)
    // That keyframe's own presentation time (6000) is AFTER the target
    // (5000). A walk that skipped samples with tsUs > tUs — i.e. one done in
    // presentation order — would step straight over it and return 0,
    // decoding seven frames instead of three. That is the class of mistake
    // §7.1 documents, and it is undetectable on an all-intra source.
    expect(t.samples[4].tsUs).toBeGreaterThan(5000)
    expect(t.samples[4].isKey).toBe(true)
  })

  it('falls back to decode index 0 when no sync sample precedes the target', () => {
    // A table with no keyframe at all (a fragment starting mid-GOP).
    const t = table([s(0, 0), s(1000, 1000), s(2000, 2000)])
    expect(keyframeAtOrBefore(t, 2000)).toBe(0)
  })

  it('returns 0 for an empty table', () => {
    expect(keyframeAtOrBefore({ samples: [], presIndex: [] }, 1000)).toBe(0)
  })
})

describe('audioSpecificConfigFor (the esds walk)', () => {
  /** ES_Descriptor → DecoderConfigDescriptor (0x04) → DecoderSpecificInfo (0x05). */
  function esdsEntry(descs: unknown): MP4BoxSampleEntry {
    return { esds: { esd: descs } } as MP4BoxSampleEntry
  }

  it('extracts the AudioSpecificConfig bytes from a well-formed tree', () => {
    // 0x12 0x10 is the canonical AAC-LC 44.1kHz stereo AudioSpecificConfig.
    const entry = esdsEntry({
      tag: 0x03,
      descs: [
        { tag: 0x06, descs: [] },
        { tag: 0x04, descs: [{ tag: 0x05, data: [0x12, 0x10] }] },
      ],
    })
    const out = audioSpecificConfigFor(entry)
    expect(out).toBeInstanceOf(Uint8Array)
    expect(Array.from(out!)).toEqual([0x12, 0x10])
  })

  it('copies the bytes rather than aliasing mp4box’s array', () => {
    const data = [0x12, 0x10]
    const out = audioSpecificConfigFor(
      esdsEntry({ tag: 0x03, descs: [{ tag: 0x04, descs: [{ tag: 0x05, data }] }] }),
    )!
    data[0] = 0xff
    expect(out[0]).toBe(0x12)
  })

  it('returns undefined when the entry has no esds at all', () => {
    expect(audioSpecificConfigFor({})).toBeUndefined()
    expect(audioSpecificConfigFor({ esds: {} })).toBeUndefined()
  })

  it('returns undefined for a truncated tree (missing 0x04 or 0x05, or no data)', () => {
    // Missing DecoderConfigDescriptor.
    expect(audioSpecificConfigFor(esdsEntry({ tag: 0x03, descs: [{ tag: 0x06 }] }))).toBeUndefined()
    // Present 0x04 but no DecoderSpecificInfo beneath it.
    expect(
      audioSpecificConfigFor(esdsEntry({ tag: 0x03, descs: [{ tag: 0x04, descs: [] }] })),
    ).toBeUndefined()
    // Present 0x05 carrying no payload — the QuickTime-v1 AAC case that made
    // the 4K original's audio unconfigurable in SP1 (§6/§7.1).
    expect(
      audioSpecificConfigFor(
        esdsEntry({ tag: 0x03, descs: [{ tag: 0x04, descs: [{ tag: 0x05 }] }] }),
      ),
    ).toBeUndefined()
  })

  it('does not search below the first level of each descriptor list', () => {
    // 0x05 nested two levels down under an unrelated tag is not a
    // DecoderSpecificInfo of this DecoderConfigDescriptor.
    expect(
      audioSpecificConfigFor(
        esdsEntry({ tag: 0x03, descs: [{ tag: 0x0e, descs: [{ tag: 0x04, descs: [{ tag: 0x05, data: [1] }] }] }] }),
      ),
    ).toBeUndefined()
  })
})

describe('descriptionForEntries (the box dump)', () => {
  /**
   * A stand-in codec-config box that writes a real 8-byte ISOBMFF header
   * (4-byte size + 4-byte fourcc) followed by its payload, using mp4box's own
   * `DataStream` — so the header strip is asserted against the real writer.
   */
  function box(fourcc: string, payload: number[]) {
    const header = [
      0,
      0,
      0,
      8 + payload.length,
      ...Array.from(fourcc, (c) => c.charCodeAt(0)),
    ]
    return {
      write(stream: DataStream) {
        stream.writeUint8Array(new Uint8Array([...header, ...payload]))
      },
    }
  }

  it('strips the 8-byte box header from av1C', () => {
    const out = descriptionForEntries([{ av1C: box('av1C', [0x81, 0x05, 0x0c, 0x00]) }])
    expect(Array.from(out!)).toEqual([0x81, 0x05, 0x0c, 0x00])
  })

  it.each(['avcC', 'hvcC', 'vpcC', 'av1C'] as const)('accepts %s', (fourcc) => {
    const out = descriptionForEntries([{ [fourcc]: box(fourcc, [0xaa, 0xbb]) }])
    expect(Array.from(out!)).toEqual([0xaa, 0xbb])
  })

  it('falls through to the esds walk for an audio sample entry', () => {
    const out = descriptionForEntries([
      { esds: { esd: { tag: 0x03, descs: [{ tag: 0x04, descs: [{ tag: 0x05, data: [0x12, 0x10] }] }] } } },
    ])
    expect(Array.from(out!)).toEqual([0x12, 0x10])
  })

  it('skips entries carrying nothing usable and keeps looking', () => {
    const out = descriptionForEntries([{}, { esds: {} }, { hvcC: box('hvcC', [0x07]) }])
    expect(Array.from(out!)).toEqual([0x07])
  })

  it('returns undefined when no entry carries a description (a legitimate result)', () => {
    // Opus in MP4 configures without one — this is not an error path.
    expect(descriptionForEntries([])).toBeUndefined()
    expect(descriptionForEntries([{}])).toBeUndefined()
  })
})
