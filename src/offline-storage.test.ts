import { describe, expect, test, vi } from 'vitest'
import { formatStorageBytes, requestPersistentStorage, userFacingStorageError } from './offline-storage'

describe('offline storage protection', () => {
  test('reports an existing persistence grant without requesting it again', async () => {
    const persist = vi.fn()
    await expect(requestPersistentStorage({ persisted: async () => true, persist } as unknown as StorageManager)).resolves.toBe('granted')
    expect(persist).not.toHaveBeenCalled()
  })

  test('requests persistence and reports browser refusal', async () => {
    const storage = { persisted: async () => false, persist: vi.fn().mockResolvedValue(false) } as unknown as StorageManager
    await expect(requestPersistentStorage(storage)).resolves.toBe('denied')
    expect(storage.persist).toHaveBeenCalledOnce()
  })

  test('reports unsupported APIs and storage errors safely', async () => {
    await expect(requestPersistentStorage(undefined)).resolves.toBe('unsupported')
    await expect(requestPersistentStorage({ persisted: async () => { throw new Error('blocked') }, persist: async () => true } as unknown as StorageManager)).resolves.toBe('denied')
  })

  test('formats storage sizes for a compact status display', () => {
    expect(formatStorageBytes(0)).toBe('0 B')
    expect(formatStorageBytes(1536)).toBe('1.5 KiB')
    expect(formatStorageBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
  })

  test('turns quota failures, including wrapped IndexedDB failures, into recovery guidance', () => {
    const quotaError = { name: 'QuotaExceededError' }
    expect(userFacingStorageError(quotaError, 'save failed')).toMatch(/write was rolled back.*Free space.*export an Anki package/i)
    expect(userFacingStorageError({ inner: { cause: quotaError } }, 'save failed')).toMatch(/storage is full/i)
    expect(userFacingStorageError(new Error('invalid note'), 'save failed')).toBe('invalid note')
  })
})
