import type { StudyActivityPrompt } from './learning-activities'

export const MATCHING_MINIMUM_CARDS = 2

/** Matching needs renderable text on both sides and no media-only content. */
export function matchingUnsupportedReason(prompt: StudyActivityPrompt): string | undefined {
  if (prompt.noteType.kind === 'image-occlusion') return 'Image occlusion cards need a visual masking interaction.'
  if (prompt.attachments.length) return 'Cards with attached media are not supported by matching.'
  if (prompt.rendering.error) return 'The card prompt could not be rendered.'
  if (prompt.rendering.backError) return 'The card answer could not be rendered.'
  if (!prompt.rendering.front?.html.trim() || !prompt.rendering.back?.html.trim()) return 'Matching needs visible prompt and answer content.'
  return undefined
}
