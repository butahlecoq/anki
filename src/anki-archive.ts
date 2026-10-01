import { Inflate } from 'fflate'
import { Decompress } from 'fzstd'

const MiB = 1024 * 1024
export const ANKI_ARCHIVE_LIMITS = Object.freeze({ compressedBytes: 128 * MiB, expandedBytes: 256 * MiB, entryBytes: 64 * MiB, entries: 20_000 })
interface Limits { compressedBytes: number; expandedBytes: number; entryBytes: number; entries: number }
type Entry = { name: string; start: number; end: number; size: number; method: number; crc: number; local: number }
const names = new TextDecoder('utf-8', { fatal: true })

function invalid(detail: string): never { throw new Error(`Unsafe Anki archive: ${detail}`) }
function bounded(offset: number, length: number, end: number) {
  if (offset < 0 || length < 0 || offset + length > end) invalid('truncated or overlapping entry')
}
function safeName(name: string) {
  if (!name || /[\\:]/.test(name) || [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || name.startsWith('/') || name.split('/').some((part) => part === '.' || part === '..' || !part)) invalid(`unsafe entry name ${JSON.stringify(name)}`)
}

// ZIP central and local headers: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// Inspect all metadata before any inflater or collection parser is invoked.
function entries(bytes: Uint8Array, limits: Limits): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number) => { bounded(at, 2, bytes.length); return view.getUint16(at, true) }
  const u32 = (at: number) => { bounded(at, 4, bytes.length); return view.getUint32(at, true) }
  let eocd = bytes.length - 22
  while (eocd >= Math.max(0, bytes.length - 65_557) && (u32(eocd) !== 0x06054b50 || eocd + 22 + u16(eocd + 20) !== bytes.length)) eocd -= 1
  if (eocd < Math.max(0, bytes.length - 65_557)) invalid('missing ZIP directory')
  // The downstream reader chooses the last EOCD signature without checking
  // its comment length. Refuse competing signatures and ZIP64 locators so it
  // cannot select a different directory from the one validated here.
  for (let at = bytes.length - 22; at > eocd; at -= 1) if (u32(at) === 0x06054b50) invalid('ambiguous ZIP directory')
  if (eocd >= 20 && u32(eocd - 20) === 0x07064b50) invalid('ZIP64 archives are unsupported')
  if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== u16(eocd + 10)) invalid('split ZIP archives are unsupported')
  const count = u16(eocd + 10)
  const directorySize = u32(eocd + 12)
  const directory = u32(eocd + 16)
  if (count === 0xffff || directorySize === 0xffffffff || directory === 0xffffffff) invalid('ZIP64 archives are unsupported')
  if (count > limits.entries) invalid(`more than ${limits.entries} entries`)
  if (directory + directorySize !== eocd) invalid('invalid ZIP directory bounds')
  const result: Entry[] = []
  const seen = new Set<string>()
  let offset = directory
  let total = 0
  for (let index = 0; index < count; index += 1) {
    bounded(offset, 46, eocd)
    if (u32(offset) !== 0x02014b50) invalid('invalid ZIP directory entry')
    const flags = u16(offset + 8)
    const method = u16(offset + 10)
    const compressed = u32(offset + 20)
    const size = u32(offset + 24)
    const nameSize = u16(offset + 28)
    const extraSize = u16(offset + 30)
    const commentSize = u16(offset + 32)
    const local = u32(offset + 42)
    if (u16(offset + 34) || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) invalid('ZIP64 or split entries are unsupported')
    if (flags & 0x2041 || (method !== 0 && method !== 8)) invalid('encrypted or unsupported ZIP compression')
    bounded(offset + 46, nameSize + extraSize + commentSize, eocd)
    const name = names.decode(bytes.subarray(offset + 46, offset + 46 + nameSize))
    if (!(flags & 0x800) && bytes.subarray(offset + 46, offset + 46 + nameSize).some((byte) => byte >= 128)) invalid('non-UTF-8 ZIP names are unsupported')
    safeName(name)
    if (seen.has(name)) invalid(`duplicate entry ${JSON.stringify(name)}`)
    seen.add(name)
    if (size > limits.entryBytes) invalid(`${name} exceeds the ${limits.entryBytes / MiB} MiB entry limit`)
    total += size
    if (total > limits.expandedBytes) invalid(`ZIP payload exceeds the ${limits.expandedBytes / MiB} MiB expanded limit`)
    bounded(local, 30, directory)
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) invalid('local and directory headers disagree')
    const localNameSize = u16(local + 26)
    const localExtraSize = u16(local + 28)
    bounded(local + 30, localNameSize + localExtraSize, directory)
    if (names.decode(bytes.subarray(local + 30, local + 30 + localNameSize)) !== name) invalid('local and directory names disagree')
    if (!(flags & 8) && (u32(local + 18) !== compressed || u32(local + 22) !== size)) invalid('local and directory sizes disagree')
    const start = local + 30 + localNameSize + localExtraSize
    bounded(start, compressed, directory)
    if (method === 0 && compressed !== size) invalid('stored entry size mismatch')
    result.push({ name, local, start, end: start + compressed, size, method, crc: u32(offset + 16) })
    offset += 46 + nameSize + extraSize + commentSize
  }
  if (offset !== eocd) invalid('ZIP entry count does not match directory')
  const ranges = [...result].sort((left, right) => left.local - right.local)
  for (let index = 1; index < ranges.length; index += 1) if (ranges[index].local < ranges[index - 1].end) invalid('overlapping ZIP entries')
  return result
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function extract(bytes: Uint8Array, entry: Entry): Uint8Array {
  const output = new Uint8Array(entry.size)
  let written = 0
  let crc = 0xffffffff
  const accept = (chunk: Uint8Array) => {
    if (written + chunk.length > entry.size) invalid(`${entry.name} expands beyond its declared size`)
    output.set(chunk, written)
    written += chunk.length
    for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  }
  if (entry.method === 0) accept(bytes.subarray(entry.start, entry.end))
  else {
    const inflater = new Inflate(accept)
    // Small input chunks bound the inflater's transient output as well.
    for (let offset = entry.start; offset < entry.end; offset += 4096) inflater.push(bytes.subarray(offset, Math.min(offset + 4096, entry.end)), offset + 4096 >= entry.end)
    if (entry.start === entry.end) inflater.push(new Uint8Array(), true)
  }
  if (written !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) invalid(`${entry.name} has a size or checksum mismatch`)
  return output
}

function zstdMagic(value: number) { return value === 0xfd2fb528 || (value >= 0x184d2a50 && value <= 0x184d2a5f) }

// Validate every frame's allocation parameters before fzstd sees it, including
// concatenated/skippable frames. Format: https://www.rfc-editor.org/rfc/rfc8878.html
function validateZstdHeaders(bytes: Uint8Array, limit: number, windowBudget: number, frameBudget: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  let declared = 0n
  let allSizesKnown = true
  let windows = 0
  let frames = 0
  while (offset < bytes.length) {
    if (++frames > frameBudget) invalid('too many Zstandard frames')
    bounded(offset, 4, bytes.length)
    const magic = view.getUint32(offset, true)
    offset += 4
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      bounded(offset, 4, bytes.length)
      const length = view.getUint32(offset, true)
      offset += 4
      bounded(offset, length, bytes.length)
      offset += length
      continue
    }
    if (magic !== 0xfd2fb528) invalid('invalid Zstandard frame')
    bounded(offset, 1, bytes.length)
    const flags = bytes[offset++]
    if (flags & 8) invalid('reserved Zstandard header flag')
    const single = Boolean(flags & 32)
    let window = 0
    if (!single) {
      bounded(offset, 1, bytes.length)
      const descriptor = bytes[offset++]
      const base = 2 ** (10 + (descriptor >> 3))
      window = base + (base / 8) * (descriptor & 7)
    }
    const dictionaryBytes = [0, 1, 2, 4][flags & 3]
    const sizeFlag = flags >> 6
    const sizeBytes = sizeFlag ? 2 ** sizeFlag : single ? 1 : 0
    if (!sizeBytes) allSizesKnown = false
    bounded(offset, dictionaryBytes + sizeBytes, bytes.length)
    offset += dictionaryBytes
    let content = 0n
    for (let index = 0; index < sizeBytes; index += 1) content |= BigInt(bytes[offset++]) << BigInt(index * 8)
    if (sizeFlag === 1) content += 256n
    declared += content
    if (single) window = Number(content)
    if (window > limit || content > BigInt(limit) || declared > BigInt(limit)) invalid('Zstandard window or content exceeds the entry limit')
    windows += window
    if (windows > windowBudget) invalid('Zstandard decoder windows exceed the aggregate allocation limit')
    let last = false
    while (!last) {
      bounded(offset, 3, bytes.length)
      const header = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
      offset += 3
      last = Boolean(header & 1)
      const kind = (header >> 1) & 3
      const size = header >>> 3
      if (kind === 3 || size > Math.min(131_072, window)) invalid('invalid Zstandard block')
      const stored = kind === 1 ? 1 : size
      bounded(offset, stored, bytes.length)
      offset += stored
    }
    if (flags & 4) { bounded(offset, 4, bytes.length); offset += 4 }
  }
  return { expected: allSizesKnown ? Number(declared) : undefined, windows, frames }
}

/** Reject resource-hostile packages before the Anki reader parses any data. */
export function validateAnkiArchive(bytes: Uint8Array, limits: Limits = ANKI_ARCHIVE_LIMITS): void {
  if (bytes.length > limits.compressedBytes) invalid(`package exceeds the ${limits.compressedBytes / MiB} MiB compressed limit`)
  const directory = entries(bytes, limits)
  let expanded = 0
  let windows = 0
  let frames = 0
  for (const entry of directory) {
    const content = extract(bytes, entry)
    if (content.length >= 4 && zstdMagic(new DataView(content.buffer, content.byteOffset, content.byteLength).getUint32(0, true))) {
      const header = validateZstdHeaders(content, limits.entryBytes, limits.expandedBytes - windows, limits.entries - frames)
      windows += header.windows
      frames += header.frames
      let extracted = 0
      const decoder = new Decompress((chunk) => {
        extracted += chunk.length
        if (extracted > limits.entryBytes || expanded + extracted > limits.expandedBytes) invalid('Zstandard payload exceeds the expanded limit')
      })
      for (let offset = 0; offset < content.length; offset += 4096) decoder.push(content.subarray(offset, offset + 4096), offset + 4096 >= content.length)
      if (header.expected !== undefined && extracted !== header.expected) invalid('Zstandard content size mismatch')
      expanded += extracted
    } else expanded += content.length
    if (expanded > limits.expandedBytes) invalid('archive payload exceeds the expanded limit')
  }
}
