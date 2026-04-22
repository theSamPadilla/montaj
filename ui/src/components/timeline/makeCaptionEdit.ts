import type { Project } from '@/lib/types/schema'

export function makeCaptionEdit(
  globalIdx: number,
  project: Project,
  onProjectChange?: (p: Project) => void,
  onCaptionEdit?: (p: Project) => void,
) {
  return (text: string) => {
    if (!project.captions) return
    const updated = {
      ...project,
      captions: {
        ...project.captions,
        segments: project.captions.segments.map((s, j) => {
          if (j !== globalIdx) return s
          const newWords = text.split(/\s+/).filter(Boolean)
          const segDur = s.end - s.start
          const wordDur = segDur / (newWords.length || 1)
          const words = newWords.map((w, wi) => ({
            word: w,
            start: s.start + wi * wordDur,
            end: s.start + (wi + 1) * wordDur,
          }))
          return { ...s, text, words }
        }),
      },
    }
    onProjectChange?.(updated)
    onCaptionEdit?.(updated)
  }
}
