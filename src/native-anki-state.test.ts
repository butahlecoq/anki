import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { NativeAnkiState } from './native-anki-state'
import { NativeAnkiClient, NativeSyncConflict, nativeSnapshotHash } from './native-anki-sync'
import type { NativeAnkiProjectionManifest } from './native-anki-projection'

let state: NativeAnkiState
let occupied = false
beforeEach(async () => {
  occupied = false
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown>) => {
    if (occupied) return callback(null)
    occupied = true
    try { return await callback({}) } finally { occupied = false }
  } } })
  state = new NativeAnkiState(`native-state-${crypto.randomUUID()}`)
  await state.replace(new Uint8Array([1, 2, 3]), null)
})
afterEach(async () => { await state.delete(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const client = () => NativeAnkiClient.login(async () => Response.json({ key: 'generated-in-memory-key' }), 'generated-user', 'generated-password')

it('persists a projection map only while its exact native checkpoint remains current', async () => {
  const snapshot = new Uint8Array([1, 2, 3])
  const manifest: NativeAnkiProjectionManifest = {
    version: 1,
    snapshotHash: await nativeSnapshotHash(snapshot),
    collectionId: 12,
    schema: 11,
    notes: [{ id: 34, guid: 'japanese-guid', notetypeId: 10 }],
    cards: [{ id: 56, noteId: 34, ordinal: 0, deckId: 78, originalDeckId: 0 }],
    reviews: [{ id: 90, cardId: 56 }],
    decks: [{ id: 78 }],
    notetypes: [{ id: 10, fieldOrdinals: [0, 1], templateOrdinals: [0] }],
  }
  await state.saveProjectionManifest(manifest, 1)
  const firstRead = await state.projectionManifest()
  expect(firstRead).toEqual(manifest)
  if (firstRead) firstRead.cards[0].deckId = 999
  expect(await state.projectionManifest()).toEqual(manifest)

  state.close()
  await state.open()
  expect(await state.projectionManifest()).toEqual(manifest)

  await state.replace(new Uint8Array([7, 8, 9]), 1)
  expect(await state.projectionManifest()).toBeUndefined()
  await expect(state.saveProjectionManifest(manifest, 1)).rejects.toThrow('another operation')
  state.close()
  await state.open()
  expect(await state.projectionManifest()).toBeUndefined()
})

it('keeps the durable checkpoint after a lost finish response and commits only the recovered result', async () => {
  const account = await client(), SQL = await initSqlJs()
  vi.spyOn(account, 'syncCollection').mockRejectedValueOnce(new Error('lost finish')).mockResolvedValueOnce({ outcome: 'synced', collection: new Uint8Array([4, 5, 6]) })
  await expect(state.synchronize(account, SQL)).rejects.toThrow('lost finish')
  state.close()
  await state.open()
  expect(Array.from((await state.checkpoint())!.collection)).toEqual([1, 2, 3])
  expect((await state.recovery())?.status).toBe('recovery-required')
  await expect(state.synchronize(account, SQL)).rejects.toThrow('needs recovery')
  await state.recover(account, SQL)
  expect((await state.checkpoint())?.revision).toBe(2)
  expect(Array.from((await state.checkpoint())!.collection)).toEqual([4, 5, 6])
  expect(await state.recovery()).toBeUndefined()
})

it('retains both concrete conflicting versions across reopen and blocks retries until resolution', async () => {
  const account = await client(), SQL = await initSqlJs()
  const local = [42, '猫 locally edited'], remote = [42, '猫 remotely edited']
  vi.spyOn(account, 'syncCollection').mockRejectedValue(new NativeSyncConflict('notes', 42, local, remote))
  await expect(state.synchronize(account, SQL)).rejects.toThrow('require resolution')
  state.close()
  await state.open()
  const conflict = (await state.conflicts.toArray())[0]
  expect(conflict).toMatchObject({ identity: 42, local, remote, baseRevision: 1 })
  await expect(state.recover(account, SQL)).rejects.toThrow('Resolve retained versions')
  const durable = JSON.stringify({ checkpoint: await state.checkpoint(), attempt: await state.recovery(), conflict })
  expect(durable).not.toContain('generated-in-memory-key')
  expect(durable).not.toContain('generated-password')
})

it('rejects another page sync and collection replacement while the native session is running', async () => {
  const account = await client(), SQL = await initSqlJs()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  let notifyEntered!: () => void
  const entered = new Promise<void>((resolve) => { notifyEntered = resolve })
  vi.spyOn(account, 'syncCollection').mockImplementation(async (_SQL, snapshot) => { notifyEntered(); await waiting; return { outcome: 'unchanged', collection: snapshot } })
  const running = state.synchronize(account, SQL)
  await entered
  await expect(state.synchronize(account, SQL)).rejects.toThrow('Another page')
  await expect(state.replace(new Uint8Array([9]), 1)).rejects.toThrow('another operation')
  release()
  await running
  expect((await state.checkpoint())?.revision).toBe(1)
})
