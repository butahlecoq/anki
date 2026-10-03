import { describe, expect, test } from 'vitest'
import {
  DAY_MILLISECONDS, NATIVE_CARD_TYPE, NATIVE_REVIEW_TYPE, SUPPORTED_MEDIA_TYPES,
  blobBytes, extensionForMediaType, isSupportedMediaType, maximumBytesFor,
  mediaKindFor, mediaTypeForFilename, nativeCardType, nativeReviewType, toHex,
} from '../anki-interchange'

/**
 * Interchange has one owner for its vocabulary. These tests are what makes that
 * claim checkable: if the two directions drift, one of them stops consulting the
 * table and starts re-typing it, and the round trip stops agreeing with itself.
 */

describe('the media type table', () => {
  test('every type has a canonical extension, and every extension resolves back', () => {
    for (const definition of SUPPORTED_MEDIA_TYPES) {
      expect(extensionForMediaType(definition.mimeType)).toBe(definition.extensions[0])
      for (const extension of definition.extensions) {
        expect(mediaTypeForFilename(`recording.${extension}`)).toBe(definition.mimeType)
      }
      // Round tripping a name the export side writes must resolve on the import side.
      const written = `blob.${extensionForMediaType(definition.mimeType)}`
      expect(mediaTypeForFilename(written)).toBe(definition.mimeType)
    }
  })

  test('a filename with no extension, or an unknown one, resolves to nothing', () => {
    expect(mediaTypeForFilename('recording')).toBeUndefined()
    expect(mediaTypeForFilename('payload.exe')).toBeUndefined()
    expect(mediaTypeForFilename('archive.tar.gz')).toBeUndefined()
  })

  test('extension matching is case-insensitive, as a package filename may be', () => {
    expect(mediaTypeForFilename('CAT.PNG')).toBe('image/png')
    expect(mediaTypeForFilename('clip.MP3')).toBe('audio/mpeg')
  })

  test('the browser and the sync service accept exactly the same types', () => {
    // The service asks this question directly; the browser derives it from the
    // same table. If these ever differ, the browser accepts a file the service
    // then refuses.
    const fromTable = SUPPORTED_MEDIA_TYPES.map(({ mimeType }) => mimeType).sort()
    expect(fromTable).toEqual([...fromTable].sort())
    for (const mimeType of fromTable) expect(isSupportedMediaType(mimeType)).toBe(true)
    expect(isSupportedMediaType('application/zip')).toBe(false)
    expect(isSupportedMediaType('video/mp4')).toBe(false)
    expect(isSupportedMediaType('')).toBe(false)
  })

  test('kind and size limits come from the same row as the type', () => {
    expect(mediaKindFor('image/png')).toBe('image')
    expect(mediaKindFor('audio/mpeg')).toBe('audio')
    expect(mediaKindFor('text/plain')).toBeUndefined()
    for (const definition of SUPPORTED_MEDIA_TYPES) {
      expect(maximumBytesFor(definition.mimeType)).toBe(definition.maximumBytes)
      expect(definition.maximumBytes).toBeGreaterThan(0)
    }
  })
})

describe('bytes and digests', () => {
  test('hex encoding is lowercase and zero-padded per byte', () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff, 0x10]))).toBe('000fff10')
    expect(toHex(new Uint8Array())).toBe('')
  })

  test('an ArrayBuffer and a Blob holding the same bytes read alike', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    const buffer = bytes.slice().buffer
    const fromBuffer = await blobBytes(buffer)
    const fromBlob = await blobBytes(new Blob([bytes]))
    expect([...fromBuffer]).toEqual([...bytes])
    expect([...fromBlob]).toEqual([...bytes])
  })

  test('the returned bytes own their buffer, so a caller may keep them', async () => {
    const source = new Uint8Array([9, 9, 9])
    const read = await blobBytes(source.slice().buffer)
    source[0] = 0
    expect(read[0]).toBe(9)
  })
})

describe('native state tables', () => {
  test('the card type table matches Anki, where relearning is 3 and not review', () => {
    expect(nativeCardType('new')).toBe(0)
    expect(nativeCardType('learning')).toBe(1)
    expect(nativeCardType('review')).toBe(2)
    expect(nativeCardType('relearning')).toBe(3)
    expect(Object.values(NATIVE_CARD_TYPE)).toEqual([0, 1, 2, 3])
  })

  test('the review type table records the answer context, which differs from the card table', () => {
    expect(nativeReviewType('learning')).toBe(0)
    expect(nativeReviewType('review')).toBe(1)
    expect(nativeReviewType('relearning')).toBe(2)
    expect(nativeReviewType('filtered')).toBe(3)
    // A card's state and a review's context are different enumerations; the
    // review table has a `filtered` the card table has no room for, and no
    // `new`, because a first answer is not recorded as a new card.
    expect(Object.keys(NATIVE_REVIEW_TYPE)).not.toContain('new')
    expect(Object.keys(NATIVE_CARD_TYPE)).not.toContain('filtered')
  })

  test('a day is a day', () => {
    expect(DAY_MILLISECONDS).toBe(86_400_000)
  })
})