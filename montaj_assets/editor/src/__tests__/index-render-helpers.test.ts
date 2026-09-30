// PL1: a host that owns its render window (VideoEditorProps.renderModal)
// must read the engine's log format and serve's name sanitizer through the
// same code as RenderModal, so the helpers are public.
import { describe, it, expect } from 'vitest'
import * as editor from '../index'
import * as modal from '../video/RenderModal'
import { TONE_EXAMPLES } from '../video/imageToneExamples'

describe('render helpers on the public index', () => {
  it('re-exports the exact functions RenderModal uses', () => {
    expect(editor.parseLogProgress).toBe(modal.parseLogProgress)
    expect(editor.stepperPhases).toBe(modal.stepperPhases)
    expect(editor.phaseLabel).toBe(modal.phaseLabel)
    expect(editor.phaseIndex).toBe(modal.phaseIndex)
    expect(editor.RENDER_PHASES).toBe(modal.RENDER_PHASES)
    expect(editor.pickSampleTime).toBe(modal.pickSampleTime)
    expect(editor.sanitizeOutputName).toBe(modal.sanitizeOutputName)
    expect(editor.resLabel).toBe(modal.resLabel)
  })

  it('re-exports the image tone example thumbnails', () => {
    expect(editor.TONE_EXAMPLES).toBe(TONE_EXAMPLES)
  })
})
