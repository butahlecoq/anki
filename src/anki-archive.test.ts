import { expect, test } from 'vitest'
import { zipSync } from 'fflate'
import { ANKI_ARCHIVE_LIMITS, validateAnkiArchive } from './anki-archive'

const small = { compressedBytes: 4096, expandedBytes: 512, entryBytes: 256, entries: 8 }
const encoded = (text: string) => new TextEncoder().encode(text)

function rawZstd(text: string) {
  const data = encoded(text)
  const header = (data.length << 3) | 1
  return Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, data.length, header & 255, (header >> 8) & 255, header >> 16, ...data])
}

function unknownSizeRleZstd(size: number, blocks = 1) {
  const bytes = [0x28, 0xb5, 0x2f, 0xfd, 0, 0]
  for (let index = 0; index < blocks; index += 1) {
    const block = (size << 3) | 2 | Number(index === blocks - 1)
    bytes.push(block & 255, (block >> 8) & 255, block >> 16, 65)
  }
  return Uint8Array.from(bytes)
}

function changeZipSize(bytes: Uint8Array, size: number) {
  const result = bytes.slice()
  const view = new DataView(result.buffer)
  view.setUint32(22, size, true)
  for (let offset = 0; offset <= result.length - 46; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, size, true)
  }
  return result
}

test('accepts bounded stored, deflated, and Zstandard entries with Japanese names', () => {
  const archive = zipSync({ '日本語.txt': encoded('猫'), media: encoded('{}'), 'collection.anki21b': rawZstd('Japanese') })
  expect(() => validateAnkiArchive(archive, small)).not.toThrow()
  expect(() => validateAnkiArchive(zipSync({ media: encoded('{}') }, { level: 0 }), small)).not.toThrow()
  const skip = [0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0, 123]
  const frames = Uint8Array.from([...rawZstd('first'), ...skip, ...rawZstd('second')])
  expect(() => validateAnkiArchive(zipSync({ 'collection.anki21b': frames }), small)).not.toThrow()
})

test.each(['../media', '/media', 'a/../media', 'C:/media', 'a\\media', 'a//media', 'a\0media'])('rejects unsafe ZIP name %j', (name) => {
  expect(() => validateAnkiArchive(zipSync({ [name]: encoded('x') }), small)).toThrow(/unsafe entry name/i)
})

test('rejects too many entries and advertised entry or aggregate expansion before extraction', () => {
  const entries = zipSync({ a: encoded('a'), b: encoded('b') })
  expect(() => validateAnkiArchive(entries, { ...small, entries: 1 })).toThrow(/more than 1 entries/i)
  expect(() => validateAnkiArchive(zipSync({ a: new Uint8Array(257) }), small)).toThrow(/entry limit/i)
  expect(() => validateAnkiArchive(zipSync({ a: new Uint8Array(200), b: new Uint8Array(200), c: new Uint8Array(200) }), small)).toThrow(/ZIP payload.*expanded limit/i)
})

test('rejects forged ZIP sizes even when their metadata claims to fit the budget', () => {
  const bomb = changeZipSize(zipSync({ a: new Uint8Array(2000) }), 10)
  expect(() => validateAnkiArchive(bomb, small)).toThrow(/expands beyond its declared size/i)
})

test('rejects damaged payloads, truncation, duplicate names, and disagreeing local headers', () => {
  const archive = zipSync({ a: encoded('hello') }, { level: 0 })
  const corrupt = archive.slice()
  corrupt[31] ^= 1
  expect(() => validateAnkiArchive(corrupt, small)).toThrow(/checksum mismatch/i)
  expect(() => validateAnkiArchive(archive.subarray(0, archive.length - 5), small)).toThrow()
  const badName = archive.slice()
  badName[30] = 98
  expect(() => validateAnkiArchive(badName, small)).toThrow(/names disagree/i)
  const duplicate = zipSync({ a: encoded('a'), b: encoded('b') }, { level: 0 })
  const view = new DataView(duplicate.buffer)
  for (let offset = 0; offset < duplicate.length - 46; offset += 1) {
    const magic = view.getUint32(offset, true)
    const nameAt = magic === 0x04034b50 ? offset + 30 : magic === 0x02014b50 ? offset + 46 : -1
    if (nameAt >= 0 && duplicate[nameAt] === 98) duplicate[nameAt] = 97
  }
  expect(() => validateAnkiArchive(duplicate, small)).toThrow(/duplicate entry/i)
})

test('bounds Zstandard windows and declared content before decoder allocation', () => {
  const largeWindow = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x88, 1, 0, 0])
  expect(() => validateAnkiArchive(zipSync({ 'collection.anki21b': largeWindow }), small)).toThrow(/Zstandard window or content/i)
  const largeContent = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0xe0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0])
  expect(() => validateAnkiArchive(zipSync({ 'collection.anki21b': largeContent }), small)).toThrow(/Zstandard window or content/i)
})

test('refuses directories the downstream ZIP reader would interpret differently', () => {
  const archive = zipSync({ a: encoded('hello') })
  const comment = new Uint8Array(archive.length + 32)
  comment.set(archive)
  const view = new DataView(comment.buffer)
  view.setUint16(archive.length - 2, 32, true)
  view.setUint32(archive.length + 2, 0x06054b50, true)
  expect(() => validateAnkiArchive(comment, small)).toThrow(/ambiguous ZIP directory/i)
  const locator = archive.slice()
  new DataView(locator.buffer).setUint32(locator.length - 42, 0x07064b50, true)
  expect(() => validateAnkiArchive(locator, small)).toThrow(/ZIP64/i)
})

test('counts actual Zstandard output when headers omit the content size', () => {
  const bomb = zipSync({ 'collection.anki21b': unknownSizeRleZstd(1000, 2) })
  expect(() => validateAnkiArchive(bomb, { ...small, entryBytes: 2048, expandedBytes: 1500 })).toThrow(/Zstandard payload exceeds/i)
  const frames = Uint8Array.from([...unknownSizeRleZstd(1000), ...unknownSizeRleZstd(1000), ...unknownSizeRleZstd(1000)])
  expect(() => validateAnkiArchive(zipSync({ 'collection.anki21b': frames }), { ...small, entryBytes: 2048, expandedBytes: 8192 })).toThrow(/Zstandard payload exceeds/i)
})

test('bounds allocation churn from many tiny Zstandard frames', () => {
  const frame = unknownSizeRleZstd(1)
  const manyWindows = Uint8Array.from([...frame, ...frame, ...frame])
  expect(() => validateAnkiArchive(zipSync({ a: manyWindows }), { ...small, entryBytes: 2048, expandedBytes: 2500 })).toThrow(/aggregate allocation limit/i)
  const empty = rawZstd('')
  const manyEmpty = Uint8Array.from([...empty, ...empty, ...empty])
  expect(() => validateAnkiArchive(zipSync({ a: manyEmpty }), { ...small, entries: 2 })).toThrow(/too many Zstandard frames/i)
})

test('validates all concatenated frames and aggregate nested expansion', () => {
  const safe = rawZstd('safe')
  const unsafe = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x88, 1, 0, 0])
  expect(() => validateAnkiArchive(zipSync({ 'collection.anki21b': Uint8Array.from([...safe, ...unsafe]) }), small)).toThrow(/Zstandard window or content/i)
  const payload = rawZstd('x'.repeat(100))
  expect(() => validateAnkiArchive(zipSync({ a: payload, b: payload }), { ...small, expandedBytes: 150 })).toThrow(/expanded limit/i)
  const mismatched = rawZstd('safe')
  mismatched[5] = 10
  expect(() => validateAnkiArchive(zipSync({ a: mismatched }), small)).toThrow(/content size mismatch/i)
  expect(() => validateAnkiArchive(zipSync({ a: unknownSizeRleZstd(1000, 2), b: unknownSizeRleZstd(1000, 2) }), { ...small, entryBytes: 2048, expandedBytes: 2500 })).toThrow(/Zstandard payload exceeds/i)
})

test('rejects a package exceeding the documented compressed budget', () => {
  expect(ANKI_ARCHIVE_LIMITS.compressedBytes).toBe(128 * 1024 * 1024)
  expect(() => validateAnkiArchive(zipSync({ a: encoded('data') }), { ...small, compressedBytes: 1 })).toThrow(/compressed limit/i)
})
