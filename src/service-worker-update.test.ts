import { afterEach, describe, expect, test, vi } from 'vitest'
import { activateAvailableUpdate, setActivateWaitingWorker } from './service-worker-update'

afterEach(() => setActivateWaitingWorker(undefined))

describe('waiting service worker activation', () => {
  test('activates the waiting worker and lets the PWA client reload on control', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    setActivateWaitingWorker(activate)

    await expect(activateAvailableUpdate()).resolves.toBe(true)
    expect(activate).toHaveBeenCalledWith(true)
  })

  test('reports when there is no waiting update', async () => {
    await expect(activateAvailableUpdate()).resolves.toBe(false)
  })

  test('preserves activation failures for the UI to explain and retry', async () => {
    const failure = new Error('activation failed')
    setActivateWaitingWorker(vi.fn().mockRejectedValue(failure))

    await expect(activateAvailableUpdate()).rejects.toBe(failure)
  })
})
