import { expect, test } from 'vitest'
import fixture from '../tests/fixtures/image-occlusion-rectangles.json'
import { parseAnkiImageOcclusion, serializeAnkiImageOcclusion } from './image-occlusion-interchange'

test('parses the supported native Anki rectangular representation without renumbering gaps', () => {
  const parsed = parseAnkiImageOcclusion(fixture.fields)
  expect(parsed.imageName).toBe(fixture.expected.imageName)
  expect(parsed.header).toBe(fixture.expected.header)
  expect(parsed.backExtra).toBe(fixture.expected.backExtra)
  expect(parsed.masks.map(({ ordinal, x, y, width, height }) => ({ ordinal, x, y, width, height }))).toEqual(fixture.expected.masks)
})

test('serializes supported rectangles into native Anki fields for future package export', () => {
  const parsed = parseAnkiImageOcclusion(fixture.fields)
  const exported = serializeAnkiImageOcclusion(parsed)
  expect(exported).toEqual(fixture.fields)
})

test('reports unsupported Anki image occlusion shapes instead of silently dropping them', () => {
  expect(() => parseAnkiImageOcclusion({ ...fixture.fields, Occlusion: '{{c1::image-occlusion:ellipse:left=.1:top=.2:width=.2:height=.25}}' })).toThrow(/unsupported.*ellipse/i)
})

test('rejects malformed native rectangles missing a coordinate', () => {
  expect(() => parseAnkiImageOcclusion({ ...fixture.fields, Occlusion: '{{c1::image-occlusion:rect:left=:top=.2:width=.2:height=.25}}' })).toThrow(/left/i)
})
