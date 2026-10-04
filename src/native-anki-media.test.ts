import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { NativeAnkiMedia } from './native-anki-media'
import type { NativeAnkiClient } from './native-anki-sync'

const stores: NativeAnkiMedia[] = []
function store() {
  const media = new NativeAnkiMedia(`native-media-test-${crypto.randomUUID()}`)
  stores.push(media)
  return media
}

function sha1(bytes: Uint8Array) {
  return crypto.subtle.digest('SHA-1', bytes.slice().buffer).then((hash) =>
    [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  )
}

function fakeClient(changes: unknown, download: Uint8Array) {
  let reads = 0
  return {
    metadata: vi.fn(async () => undefined),
    mediaRequest: vi.fn(async (method: string) => {
      if (method === 'begin') return { usn: 1 }
      if (method === 'mediaChanges') return reads++ === 0 ? changes : []
      if (method === 'downloadFiles') return download
      if (method === 'mediaSanity') return 'OK'
      throw new Error(`Unexpected media request: ${method}`)
    }),
  } as unknown as NativeAnkiClient
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(stores.splice(0).map((media) => media.delete()))
})

function allowExclusiveStorage() {
  vi.stubGlobal('navigator', {
    locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}) },
  })
}

test('failed media download preserves the previous file and acknowledged cursor for recovery', async () => {
  allowExclusiveStorage()
  const media = store()
  const previous = new Uint8Array([1, 2, 3])
  const changed = new Uint8Array([4, 5, 6])
  await media.setFile('cat.png', previous)
  await media.meta.put({ id: 'media', usn: 1 })
  const client = fakeClient([['cat.png', 2, await sha1(changed)]], new Uint8Array([1, 2, 3]))

  await expect(media.synchronize(client)).rejects.toThrow(/archive|media response is invalid|damaged in transit/i)

  expect(await media.cursor()).toBe(1)
  const preserved = await media.files.get('cat.png')
  expect(Array.from(preserved!.bytes!)).toEqual(Array.from(previous))
  expect(preserved).toMatchObject({ pending: true })
  expect(await media.attempts.get('active')).toMatchObject({ status: 'recovery-required' })
})

test('download with a mismatched advertised hash preserves the previous file and cursor', async () => {
  allowExclusiveStorage()
  const media = store()
  const previous = new Uint8Array([1, 2, 3])
  const received = new Uint8Array([4, 5, 6])
  const wrongDigest = await sha1(new Uint8Array([7, 8, 9]))
  const archive = zipSync({ _meta: strToU8(JSON.stringify({ 0: 'cat.png' })), 0: received }, { level: 0 })
  await media.setFile('cat.png', previous)
  await media.meta.put({ id: 'media', usn: 1 })
  const client = fakeClient([['cat.png', 2, wrongDigest]], archive)

  await expect(media.synchronize(client)).rejects.toThrow(/changed or was damaged in transit/i)

  const preserved = await media.files.get('cat.png')
  expect(Array.from(preserved!.bytes!)).toEqual(Array.from(previous))
  expect(preserved).toMatchObject({ pending: true })
  expect(await media.cursor()).toBe(1)
})

test('verified media download stores the exact bytes and advances its cursor', async () => {
  allowExclusiveStorage()
  const media = store()
  const bytes = new Uint8Array([0, 1, 2, 255])
  const archive = zipSync({ _meta: strToU8(JSON.stringify({ 0: '猫.png' })), 0: bytes }, { level: 0 })
  const client = fakeClient([['猫.png', 1, await sha1(bytes)]], archive)

  await expect(media.synchronize(client)).resolves.toMatchObject({ outcome: 'synced', cursor: 1, files: 1 })

  const stored = await media.files.get('猫.png')
  expect(Array.from(stored!.bytes!)).toEqual(Array.from(bytes))
  expect(stored).toMatchObject({ pending: false, sha1: await sha1(bytes) })
  expect(await media.cursor()).toBe(1)
  expect(await media.attempts.get('active')).toBeUndefined()
})
