import { afterEach, expect, test, vi } from 'vitest'
import * as templateRenderer from './template-renderer'
import { isRenderedCardDisplayable, renderCard, renderNoteCard } from './card-rendering'

afterEach(() => vi.restoreAllMocks())

test('renders the front and back once each and returns the shared card result', () => {
  const render = vi.spyOn(templateRenderer, 'tryRenderTemplate')
  const card = renderCard(
    { front: '{{type:Expression}}', back: '{{FrontSide}}<hr>{{Meaning}}', css: '.card { color: red }' },
    { Expression: '猫', Meaning: 'cat' },
  )

  expect(render).toHaveBeenCalledTimes(2)
  expect(render.mock.calls.map(([, , , options]) => options?.side)).toEqual(['front', 'back'])
  expect(card).toMatchObject({
    front: { html: '', isEmpty: false, typedAnswer: '猫' },
    back: { html: '<hr>cat', isEmpty: false },
    typedAnswer: '猫',
    isEmpty: false,
    css: '.card { color: red }',
  })
})

test('maps field IDs once and shares the same displayable rule', () => {
  const type = { kind: 'standard' as const, fields: [{ id: 'expression', name: 'Expression' }, { id: 'meaning', name: 'Meaning' }] }
  const empty = renderNoteCard(type, { front: '{{Expression}}', back: '{{FrontSide}}<hr>{{Meaning}}', css: '' }, { expression: ' ', meaning: 'cat' })
  const filled = renderNoteCard(type, { front: '{{Expression}}', back: '{{FrontSide}}<hr>{{Meaning}}', css: '' }, { expression: '猫', meaning: 'cat' })

  expect(isRenderedCardDisplayable(empty, type.kind)).toBe(false)
  expect(isRenderedCardDisplayable(filled, type.kind)).toBe(true)
  expect(filled.front?.html).toBe('猫')
  expect(filled.back?.html).toBe('猫<hr>cat')
})

test('an image occlusion card is displayable with an empty front', () => {
  // An occlusion note has no front template; an empty front is expected rather
  // than a fault, and this exemption was previously restated by four callers.
  const type = { kind: 'image-occlusion' as const, fields: [{ id: 'occlusion', name: 'Occlusion' }] }
  const card = renderNoteCard(type, { front: '{{Occlusion}}', back: '{{FrontSide}}', css: '' }, { occlusion: ' ' })
  expect(card.isEmpty).toBe(true)
  expect(isRenderedCardDisplayable(card, type.kind)).toBe(true)
  expect(isRenderedCardDisplayable(card, 'standard')).toBe(false)
})

test('a front failure suppresses the card but a back failure does not', () => {
  const frontBroken = renderCard({ front: '{{Missing', back: '', css: '' }, {})
  expect(frontBroken.error).toMatch(/unmatched template delimiter/i)
  // Nothing can be shown, but the card must not become permanently unanswerable.
  expect(isRenderedCardDisplayable(frontBroken, 'standard')).toBe(true)

  const backBroken = renderCard({ front: '{{Expression}}', back: '{{Missing', css: '' }, { Expression: '猫' })
  expect(backBroken.error).toBeUndefined()
  expect(backBroken.backError).toMatch(/unmatched template delimiter/i)
  // The question still renders, so the card stays displayable.
  expect(backBroken.front?.html).toBe('猫')
  expect(isRenderedCardDisplayable(backBroken, 'standard')).toBe(true)
})

test('an empty front with an intact back is still not displayable', () => {
  const card = renderCard({ front: '{{Expression}}', back: '{{FrontSide}}', css: '' }, { Expression: ' ' })
  expect(card.isEmpty).toBe(true)
  expect(card.backError).toBeUndefined()
  expect(isRenderedCardDisplayable(card, 'standard')).toBe(false)
})

test('renders safe imported field HTML only when the note marks its field identity', () => {
  const type = { kind: 'standard' as const, fields: [{ id: 'expression', name: 'Expression' }] }
  const template = { front: '{{Expression}}', back: '{{FrontSide}}', css: '' }
  expect(renderNoteCard(type, template, { expression: '<b>猫</b>' }).front?.html).toBe('&lt;b&gt;猫&lt;/b&gt;')
  expect(renderNoteCard(type, template, { expression: '<b>猫</b>' }, undefined, undefined, [], ['expression']).front?.html).toBe('<b>猫</b>')
})
