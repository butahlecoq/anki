import { describe, expect, test } from 'vitest'
import { deflateSync } from 'fflate'
import { ANKI_ARCHIVE_LIMITS, preflightAnkiArchive } from './anki-archive'
import { prepareAnkiImport } from './anki-import'
import { createCollection } from './collection'

type ZipEntry = {
  name: string
  data?: Uint8Array
  method?: number
  flags?: number
  declaredCompressedSize?: number
  declaredUncompressedSize?: number
}

const encoder = new TextEncoder()

function u16(value: number) {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, true)
  return bytes
}

function u32(value: number) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function concat(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function zip(entries: ZipEntry[]) {
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = entry.data ?? new Uint8Array()
    const compressedSize = entry.declaredCompressedSize ?? data.length
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length
    const flags = entry.flags ?? 0
    const method = entry.method ?? 0
    const local = concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(0),
      u32(compressedSize), u32(uncompressedSize), u16(name.length), u16(0), name, data,
    ])
    locals.push(local)
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(0),
      u32(compressedSize), u32(uncompressedSize), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset), name,
    ]))
    localOffset += local.length
  }
  const centralBytes = concat(central)
  return concat([...locals, centralBytes, concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBytes.length), u32(localOffset), u16(0),
  ])])
}

function rawZstd(contentSize: number, withContentSize = true) {
  const header = withContentSize
    ? concat([Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x38), u32(contentSize)])
    : Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38)
  const block = Uint8Array.of(1, 0, 0)
  return concat([header, block])
}

describe('Anki archive preflight', () => {
  test('accepts a bounded stored archive', async () => {
    await expect(preflightAnkiArchive(zip([{ name: 'collection.anki2', data: Uint8Array.of(1, 2, 3) }]))).resolves.toBeUndefined()
  })

  test('does not treat legacy media-index entries as current-layout zstd frames', async () => {
    await expect(preflightAnkiArchive(zip([
      { name: 'collection.anki2', data: Uint8Array.of(1, 2, 3) },
      { name: 'media', data: encoder.encode('{"0":"cat.png"}') },
      { name: '0', data: Uint8Array.of(1, 2, 3) },
    ]))).resolves.toBeUndefined()
  })

  test('rejects path traversal and duplicate paths before extraction', async () => {
    await expect(preflightAnkiArchive(zip([{ name: '../collection.anki2' }]))).rejects.toThrow(/unsafe path/i)
    await expect(preflightAnkiArchive(zip([{ name: 'collection.anki2' }, { name: 'collection.anki2' }]))).rejects.toThrow(/duplicate/i)
  })

  test('rejects encrypted and unsupported compression entries before extraction', async () => {
    await expect(preflightAnkiArchive(zip([{ name: 'collection.anki2', flags: 1 }]))).rejects.toThrow(/encrypted/i)
    await expect(preflightAnkiArchive(zip([{ name: 'collection.anki2', method: 12 }]))).rejects.toThrow(/compression/i)
  })

  test('rejects individual and aggregate expanded archive size claims before extraction', async () => {
    await expect(preflightAnkiArchive(zip([{ name: 'collection.anki2', declaredUncompressedSize: ANKI_ARCHIVE_LIMITS.maxEntryBytes + 1 }]))).rejects.toThrow(/entry limit/i)
    await expect(preflightAnkiArchive(zip([
      { name: 'collection.anki2', declaredUncompressedSize: ANKI_ARCHIVE_LIMITS.maxEntryBytes },
      { name: 'first', declaredUncompressedSize: ANKI_ARCHIVE_LIMITS.maxEntryBytes },
      { name: 'second', declaredUncompressedSize: ANKI_ARCHIVE_LIMITS.maxEntryBytes },
      { name: 'third', declaredUncompressedSize: ANKI_ARCHIVE_LIMITS.maxEntryBytes },
      { name: 'media', declaredUncompressedSize: 1 },
    ]))).rejects.toThrow(/aggregate limit/i)
  })

  test('rejects a current-layout zstd frame without a declared content size', async () => {
    await expect(preflightAnkiArchive(zip([{ name: 'collection.anki21b', data: rawZstd(0, false) }]))).rejects.toThrow(/zstd.*content size/i)
  })

  test('rejects a current-layout zstd frame with compressed blocks that have no enforceable decoder cap', async () => {
    const frame = concat([Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x38), u32(0), Uint8Array.of(5, 0, 0)])
    await expect(preflightAnkiArchive(zip([{ name: 'collection.anki21b', data: frame }]))).rejects.toThrow(/compressed or run-length/i)
  })

  test('rejects a current-layout zstd frame above its decoded entry limit', async () => {
    await expect(preflightAnkiArchive(zip([{ name: 'collection.anki21b', data: rawZstd(ANKI_ARCHIVE_LIMITS.maxZstdEntryBytes + 1) }]))).rejects.toThrow(/zstd.*entry limit/i)
  })

  test('rejects a deflated entry that produces more bytes than its ZIP metadata declares', async () => {
    const zstd = rawZstd(0)
    await expect(preflightAnkiArchive(zip([{
      name: 'collection.anki21b',
      method: 8,
      data: deflateSync(zstd),
      declaredUncompressedSize: 1,
    }]))).rejects.toThrow(/deflated entry.*declared limit/i)
  })

  test('rejects an unsafe archive before package parsing or collection/outbox mutation', async () => {
    const collection = createCollection(`kiroku-archive-preflight-${crypto.randomUUID()}`)
    try {
      const file = new File([zip([{ name: '../collection.anki2' }])], 'unsafe.apkg', { type: 'application/octet-stream' })
      await expect(prepareAnkiImport(file, collection, { SQL: {} as never })).rejects.toThrow(/unsafe path/i)
      await expect(collection.decks.count()).resolves.toBe(0)
      await expect(collection.notes.count()).resolves.toBe(0)
      await expect(collection.cards.count()).resolves.toBe(0)
      await expect(collection.outbox.count()).resolves.toBe(0)
    } finally {
      await collection.delete()
    }
  })
})
