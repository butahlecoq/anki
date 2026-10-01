/**
 * Archive limits are intentionally below the browser's practical memory limit.
 * ZIP accounting happens before the package reader is loaded, while zstd frame
 * accounting happens before it can allocate a decoded collection or media blob.
 */
export const ANKI_ARCHIVE_LIMITS = {
  maxCompressedBytes: 512 * 1024 * 1024,
  maxEntries: 4_096,
  maxEntryBytes: 64 * 1024 * 1024,
  maxAggregateBytes: 256 * 1024 * 1024,
  maxZstdEntryBytes: 64 * 1024 * 1024,
  maxZstdAggregateBytes: 256 * 1024 * 1024,
} as const

interface ZipEntry {
  name: string
  flags: number
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  dataOffset: number
}

const zipLocalHeader = 0x04034b50
const zipCentralHeader = 0x02014b50
const zipEndOfCentralDirectory = 0x06054b50
const zstdMagic = 0xfd2fb528

function fail(message: string): never {
  throw new Error(`Unsafe Anki archive: ${message}`)
}

function requireRange(bytes: Uint8Array, offset: number, length: number, what: string) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) fail(`malformed ${what}`)
}

function u16(bytes: Uint8Array, offset: number, what: string) {
  requireRange(bytes, offset, 2, what)
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function u32(bytes: Uint8Array, offset: number, what: string) {
  requireRange(bytes, offset, 4, what)
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function readUnsigned(bytes: Uint8Array, offset: number, length: number, what: string) {
  requireRange(bytes, offset, length, what)
  let value = 0n
  for (let index = 0; index < length; index += 1) value |= BigInt(bytes[offset + index]) << BigInt(index * 8)
  return value
}

function archiveName(bytes: Uint8Array) {
  let name: string
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('entry name is not valid UTF-8')
  }
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) fail('entry has an unsafe path')
  const parts = name.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) fail('entry has an unsafe path')
  return name
}

function findEndOfCentralDirectory(bytes: Uint8Array) {
  const first = Math.max(0, bytes.length - 65_557)
  for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
    if (u32(bytes, offset, 'end of central directory') !== zipEndOfCentralDirectory) continue
    const commentLength = u16(bytes, offset + 20, 'end of central directory')
    if (offset + 22 + commentLength === bytes.length) return offset
  }
  fail('ZIP end-of-central-directory record is missing')
}

function parseZipArchive(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes)
  const disk = u16(bytes, eocd + 4, 'end of central directory')
  const centralDisk = u16(bytes, eocd + 6, 'end of central directory')
  const entriesOnDisk = u16(bytes, eocd + 8, 'end of central directory')
  const entryCount = u16(bytes, eocd + 10, 'end of central directory')
  const centralSize = u32(bytes, eocd + 12, 'end of central directory')
  const centralOffset = u32(bytes, eocd + 16, 'end of central directory')
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) fail('multi-disk ZIP archives are unsupported')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 archives are unsupported')
  if (entryCount > ANKI_ARCHIVE_LIMITS.maxEntries) fail(`archive exceeds the ${ANKI_ARCHIVE_LIMITS.maxEntries}-entry limit`)
  requireRange(bytes, centralOffset, centralSize, 'central directory')
  if (centralOffset + centralSize !== eocd) fail('central directory does not end at the ZIP footer')

  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let offset = centralOffset
  let expandedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (u32(bytes, offset, 'central directory entry') !== zipCentralHeader) fail('central directory entry is malformed')
    const flags = u16(bytes, offset + 8, 'central directory entry')
    const method = u16(bytes, offset + 10, 'central directory entry')
    const compressedSize = u32(bytes, offset + 20, 'central directory entry')
    const uncompressedSize = u32(bytes, offset + 24, 'central directory entry')
    const nameLength = u16(bytes, offset + 28, 'central directory entry')
    const extraLength = u16(bytes, offset + 30, 'central directory entry')
    const commentLength = u16(bytes, offset + 32, 'central directory entry')
    const localOffset = u32(bytes, offset + 42, 'central directory entry')
    const recordLength = 46 + nameLength + extraLength + commentLength
    requireRange(bytes, offset, recordLength, 'central directory entry')
    const name = archiveName(bytes.slice(offset + 46, offset + 46 + nameLength))
    if (names.has(name)) fail(`duplicate entry path ${JSON.stringify(name)}`)
    names.add(name)
    if (flags & 1) fail(`encrypted entry ${JSON.stringify(name)}`)
    if (flags & 8) fail(`streaming data-descriptor entry ${JSON.stringify(name)} is unsupported`)
    if (method !== 0 && method !== 8) fail(`unsupported ZIP compression method ${method} for ${JSON.stringify(name)}`)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail('ZIP64 archive values are unsupported')
    if (uncompressedSize > ANKI_ARCHIVE_LIMITS.maxEntryBytes) fail(`entry limit exceeded by ${JSON.stringify(name)}`)
    expandedBytes += uncompressedSize
    if (expandedBytes > ANKI_ARCHIVE_LIMITS.maxAggregateBytes) fail('aggregate limit exceeded by expanded ZIP entries')
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset, dataOffset: 0 })
    offset += recordLength
  }
  if (offset !== centralOffset + centralSize) fail('central directory entry count does not match its size')

  const ranges: Array<{ start: number; end: number }> = []
  for (const entry of entries) {
    if (entry.localOffset >= centralOffset || u32(bytes, entry.localOffset, 'local entry header') !== zipLocalHeader) fail(`local entry header is missing for ${JSON.stringify(entry.name)}`)
    const localFlags = u16(bytes, entry.localOffset + 6, 'local entry header')
    const localMethod = u16(bytes, entry.localOffset + 8, 'local entry header')
    const localCompressedSize = u32(bytes, entry.localOffset + 18, 'local entry header')
    const localUncompressedSize = u32(bytes, entry.localOffset + 22, 'local entry header')
    const nameLength = u16(bytes, entry.localOffset + 26, 'local entry header')
    const extraLength = u16(bytes, entry.localOffset + 28, 'local entry header')
    const headerSize = 30 + nameLength + extraLength
    requireRange(bytes, entry.localOffset, headerSize, 'local entry header')
    const localName = archiveName(bytes.slice(entry.localOffset + 30, entry.localOffset + 30 + nameLength))
    if (localName !== entry.name || localFlags !== entry.flags || localMethod !== entry.method || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize) fail(`local entry header does not match central directory for ${JSON.stringify(entry.name)}`)
    entry.dataOffset = entry.localOffset + headerSize
    const end = entry.dataOffset + entry.compressedSize
    if (end > centralOffset) fail(`compressed data is outside the local-file region for ${JSON.stringify(entry.name)}`)
    ranges.push({ start: entry.localOffset, end })
  }
  ranges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index += 1) if (ranges[index - 1].end > ranges[index].start) fail('local ZIP entries overlap')
  return entries
}

async function decodedZipEntry(bytes: Uint8Array, entry: ZipEntry) {
  const compressed = bytes.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  if (entry.method === 0) return compressed
  if (typeof DecompressionStream !== 'function' || typeof ReadableStream !== 'function') fail(`cannot safely inspect deflated entry ${JSON.stringify(entry.name)} in this browser`)
  let sourceOffset = 0
  const stream = new ReadableStream<BufferSource>({
    pull(controller) {
      if (sourceOffset >= compressed.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(sourceOffset + 64 * 1024, compressed.byteLength)
      controller.enqueue(compressed.subarray(sourceOffset, end))
      sourceOffset = end
    },
  })
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = stream.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  } catch {
    fail(`cannot safely inspect deflated entry ${JSON.stringify(entry.name)}`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > entry.uncompressedSize || size > ANKI_ARCHIVE_LIMITS.maxEntryBytes) {
        await reader.cancel()
        fail(`deflated entry ${JSON.stringify(entry.name)} expands beyond its declared limit`)
      }
      chunks.push(next.value)
    }
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith('Unsafe Anki archive:')) throw reason
    fail(`deflated entry ${JSON.stringify(entry.name)} cannot be decompressed safely`)
  } finally {
    reader.releaseLock()
  }
  if (size !== entry.uncompressedSize) fail(`deflated entry ${JSON.stringify(entry.name)} does not match its declared size`)
  const decoded = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    decoded.set(chunk, offset)
    offset += chunk.byteLength
  }
  return decoded
}

function zstdFrame(bytes: Uint8Array, offset: number, name: string) {
  if (u32(bytes, offset, `zstd frame in ${name}`) !== zstdMagic) fail(`zstd frame in ${JSON.stringify(name)} has an unsupported magic value`)
  requireRange(bytes, offset + 4, 1, `zstd frame in ${name}`)
  const descriptor = bytes[offset + 4]
  if (descriptor & 8) fail(`zstd frame in ${JSON.stringify(name)} has a reserved frame-header bit`)
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = Boolean(descriptor & 0x20)
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  let cursor = offset + 5
  if (!singleSegment) {
    requireRange(bytes, cursor, 1, `zstd frame in ${name}`)
    const windowDescriptor = bytes[cursor++]
    const windowLog = 10 + (windowDescriptor >>> 3)
    const windowBase = 2 ** windowLog
    const windowSize = windowBase + (windowBase / 8) * (windowDescriptor & 7)
    if (windowSize > ANKI_ARCHIVE_LIMITS.maxZstdEntryBytes) fail(`zstd window exceeds the entry limit for ${JSON.stringify(name)}`)
  }
  cursor += dictionaryBytes
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  if (!contentSizeBytes) fail(`zstd frame in ${JSON.stringify(name)} has no declared content size`)
  const contentSizeValue = readUnsigned(bytes, cursor, contentSizeBytes, `zstd frame in ${name}`) + (contentSizeFlag === 1 ? 256n : 0n)
  if (contentSizeValue > BigInt(ANKI_ARCHIVE_LIMITS.maxZstdEntryBytes)) fail(`zstd entry limit exceeded by ${JSON.stringify(name)}`)
  const contentSize = Number(contentSizeValue)
  cursor += contentSizeBytes
  let rawDecodedBytes = 0
  let onlyRawBlocks = true
  for (;;) {
    requireRange(bytes, cursor, 3, `zstd block in ${name}`)
    const header = bytes[cursor] | (bytes[cursor + 1] << 8) | (bytes[cursor + 2] << 16)
    cursor += 3
    const lastBlock = Boolean(header & 1)
    const type = (header >>> 1) & 3
    const blockSize = header >>> 3
    if (type === 0) {
      requireRange(bytes, cursor, blockSize, `zstd block in ${name}`)
      rawDecodedBytes += blockSize
      if (rawDecodedBytes > ANKI_ARCHIVE_LIMITS.maxZstdEntryBytes) fail(`zstd entry limit exceeded by ${JSON.stringify(name)}`)
      cursor += blockSize
    } else if (type === 1) {
      requireRange(bytes, cursor, 1, `zstd run-length block in ${name}`)
      onlyRawBlocks = false
      cursor += 1
    } else if (type === 2) {
      requireRange(bytes, cursor, blockSize, `zstd compressed block in ${name}`)
      onlyRawBlocks = false
      cursor += blockSize
    } else {
      fail(`zstd frame in ${JSON.stringify(name)} has a reserved block type`)
    }
    if (lastBlock) break
  }
  if (descriptor & 4) {
    requireRange(bytes, cursor, 4, `zstd checksum in ${name}`)
    cursor += 4
  }
  if (onlyRawBlocks && rawDecodedBytes !== contentSize) fail(`zstd frame in ${JSON.stringify(name)} does not match its declared content size`)
  return { next: cursor, declaredBytes: contentSize }
}

function validateZstdFrames(bytes: Uint8Array, name: string) {
  let offset = 0
  let declaredBytes = 0
  while (offset < bytes.length) {
    const frame = zstdFrame(bytes, offset, name)
    offset = frame.next
    declaredBytes += frame.declaredBytes
    if (declaredBytes > ANKI_ARCHIVE_LIMITS.maxZstdEntryBytes) fail(`zstd entry limit exceeded by ${JSON.stringify(name)}`)
  }
  return declaredBytes
}

function currentLayoutZstdEntry(name: string) {
  return name === 'collection.anki21b' || name === 'media' || /^\d+$/.test(name)
}

/**
 * Validates ZIP metadata before ankipack or SQL is loaded. Current Anki layout
 * zstd entries are inflated only to their already bounded ZIP size. Their frame
 * content size and window are checked before package parsing; raw blocks are
 * cross-checked against their declared output, while the package reader checks
 * compressed and run-length block validity.
 */
export async function preflightAnkiArchive(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > ANKI_ARCHIVE_LIMITS.maxCompressedBytes) fail(`archive exceeds the ${ANKI_ARCHIVE_LIMITS.maxCompressedBytes / 1024 / 1024} MB compressed limit`)
  const entries = parseZipArchive(bytes)
  const currentLayout = entries.some((entry) => entry.name === 'collection.anki21b')
  let zstdBytes = 0
  for (const entry of entries) {
    if (!currentLayout || !currentLayoutZstdEntry(entry.name)) continue
    const decoded = await decodedZipEntry(bytes, entry)
    zstdBytes += validateZstdFrames(decoded, entry.name)
    if (zstdBytes > ANKI_ARCHIVE_LIMITS.maxZstdAggregateBytes) fail('aggregate limit exceeded by decoded zstd entries')
  }
}
