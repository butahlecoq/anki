import { expect, test } from 'vitest'
import type { StudyActivityPrompt } from './learning-activities'
import { matchingUnsupportedReason } from './matching-requirements'

function prompt(overrides: Record<string, unknown> = {}) {
  return {
    noteType: { kind: 'standard' },
    attachments: [],
    rendering: { front: { html: '<p>prompt</p>' }, back: { html: '<p>answer</p>' } },
    ...overrides,
  } as unknown as StudyActivityPrompt
}

test('matching declares the card content it can present and explains exclusions', () => {
  expect(matchingUnsupportedReason(prompt())).toBeUndefined()
  expect(matchingUnsupportedReason(prompt({ noteType: { kind: 'image-occlusion' } }))).toMatch(/image occlusion/i)
  expect(matchingUnsupportedReason(prompt({ attachments: [{ id: 'media' }] }))).toMatch(/attached media/i)
  expect(matchingUnsupportedReason(prompt({ rendering: { front: { html: 'prompt' }, back: { html: '' } } }))).toMatch(/visible prompt and answer/i)
})
