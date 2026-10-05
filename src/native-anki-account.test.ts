import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { nativeAnkiAccountStorageNames, openNativeAnkiAccountStores } from './native-anki-account'
import type { NativeAnkiMedia } from './native-anki-media'
import type { NativeAnkiState } from './native-anki-state'
import { ensureNativeAccountCheckpoint } from './native-anki-account-session'

let stores: Array<{ state: NativeAnkiState; media: NativeAnkiMedia }> = []
afterEach(async () => {
  for (const store of stores) {
    store.state.close()
    store.media.close()
    await store.state.delete()
    await store.media.delete()
  }
  stores = []
})

it('derives stable, private database names without exposing the account identity', async () => {
  const first = await nativeAnkiAccountStorageNames('  learner@example.invalid  ')
  const normalized = await nativeAnkiAccountStorageNames('learner@example.invalid')
  expect(first).toEqual(normalized)
  expect(first.state).not.toContain('learner')
  expect(first.state).not.toContain('@')
  expect(first.media).not.toContain('example.invalid')
  expect(first.state).not.toBe(first.media)
})

it('isolates durable collection checkpoints between AnkiWeb identities', async () => {
  const first = await openNativeAnkiAccountStores('first-user')
  const second = await openNativeAnkiAccountStores('second-user')
  stores.push(first, second)
  await first.state.checkpoints.put({ id: 'collection', revision: 3, collection: new Uint8Array([1, 2, 3]), updatedAt: 1 })
  await second.state.checkpoints.put({ id: 'collection', revision: 8, collection: new Uint8Array([8]), updatedAt: 2 })
  await first.media.setFile('unused-media.bin', null)
  expect(Array.from((await first.state.checkpoint())!.collection)).toEqual([1, 2, 3])
  expect(Array.from((await second.state.checkpoint())!.collection)).toEqual([8])
  expect(await first.media.files.get('unused-media.bin')).toMatchObject({ pending: true, bytes: null })
  expect(await second.media.files.get('unused-media.bin')).toBeUndefined()
  first.state.close()
  first.media.close()
  const reopened = await openNativeAnkiAccountStores('first-user')
  stores.push(reopened)
  expect(Array.from((await reopened.state.checkpoint())!.collection)).toEqual([1, 2, 3])
  expect(await reopened.media.files.get('unused-media.bin')).toMatchObject({ pending: true, bytes: null })
})

it('rejects empty or oversized identities before creating storage', async () => {
  await expect(nativeAnkiAccountStorageNames(' \t ')).rejects.toThrow('valid AnkiWeb username')
  await expect(nativeAnkiAccountStorageNames('x'.repeat(257))).rejects.toThrow('valid AnkiWeb username')
})

it('downloads an initial checkpoint once and preserves it on later account connections', async () => {
  const { state, media } = await openNativeAnkiAccountStores('checkpoint-reconnect')
  stores.push({ state, media })
  let downloads = 0
  const download = async () => { downloads++; return new Uint8Array([4, 5, 6]) }

  const initial = await ensureNativeAccountCheckpoint(state, download)
  expect(initial.downloaded).toBe(true)
  expect(initial.checkpoint.revision).toBe(1)
  await state.attempts.put({ id: 'active', baseRevision: 1, startedAt: 2, status: 'recovery-required' })

  const reconnect = await ensureNativeAccountCheckpoint(state, download)
  expect(reconnect.downloaded).toBe(false)
  expect(reconnect.checkpoint.revision).toBe(1)
  expect(Array.from(reconnect.checkpoint.collection)).toEqual([4, 5, 6])
  expect(downloads).toBe(1)
  expect(await state.recovery()).toMatchObject({ status: 'recovery-required', baseRevision: 1 })
})
