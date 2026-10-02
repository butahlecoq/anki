import { afterEach, expect, test, vi } from 'vitest'
import * as templateRenderer from './template-renderer'
import { isRenderedCardEmpty, renderCard, renderNoteCard } from './card-rendering'

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

test('maps field IDs once and shares the same empty-card rule', () => {
  const type = { kind: 'standard' as const, fields: [{ id: 'expression', name: 'Expression' }, { id: 'meaning', name: 'Meaning' }] }
  const empty = renderNoteCard(type, { front: '{{Expression}}', back: '{{FrontSide}}<hr>{{Meaning}}', css: '' }, { expression: ' ', meaning: 'cat' })
  const filled = renderNoteCard(type, { front: '{{Expression}}', back: '{{FrontSide}}<hr>{{Meaning}}', css: '' }, { expression: '猫', meaning: 'cat' })

  expect(isRenderedCardEmpty(empty)).toBe(true)
  expect(isRenderedCardEmpty(filled)).toBe(false)
  expect(filled.front?.html).toBe('猫')
  expect(filled.back?.html).toBe('猫<hr>cat')
})

test('a rendering error has one shared non-empty fallback', () => {
  const card = renderCard({ front: '{{Missing', back: '', css: '' }, {})
  expect(card.error).toMatch(/unmatched template delimiter/i)
  expect(isRenderedCardEmpty(card)).toBe(false)
})

test('a back-side error does not change whether the front is empty', () => {
  const card = renderCard({ front: '{{Expression}}', back: '{{Missing', css: '' }, { Expression: ' ' })
  expect(card.error).toMatch(/unmatched template delimiter/i)
  expect(isRenderedCardEmpty(card)).toBe(true)
})
