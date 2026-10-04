import { describe, expect, test } from 'vitest'
import { SYNC_LOCAL_ONLY, pairOutcomeMessage, pairingClosesOn, syncOutcomeMessage, type SyncOutcome } from './sync-messages'

/**
 * These are the sentences a learner reads when something has gone wrong with
 * their only copy of a collection. Each result state gets a case, because the
 * failure modes here are exactly what the browser suite cannot reach on this
 * host: the sync service does not start (issue #85).
 */

const complete = (overrides: Partial<Extract<SyncOutcome, { state: 'complete' }>['media']> = {}): Extract<SyncOutcome, { state: 'complete' }> => ({
  state: 'complete', accepted: 2, media: { uploaded: 3, downloaded: 4, pending: 0, ...overrides },
})

describe('a completed sync', () => {
  test('reports what moved, in both directions', () => {
    expect(syncOutcomeMessage(complete())).toBe('Sync complete. 2 local changes sent; 3 uploaded and 4 downloaded.')
  })

  test('a single change is not pluralised', () => {
    expect(syncOutcomeMessage({ state: 'complete', accepted: 1, media: { uploaded: 1, downloaded: 0, pending: 0 } })).toBe('Sync complete. 1 local change sent; 1 uploaded and 0 downloaded.')
  })

  test('a sync with no media at all still reads as complete', () => {
    expect(syncOutcomeMessage({ state: 'complete', accepted: 0 })).toBe('Sync complete. 0 local changes sent; 0 uploaded and 0 downloaded.')
  })

  test('a sync with conflicts tells the learner to review them', () => {
    expect(syncOutcomeMessage({ state: 'complete', accepted: 1, conflicts: 2 })).toBe('Sync complete. 1 local change sent; 0 uploaded and 0 downloaded. 2 conflicts need review.')
  })

  test('an incomplete sync explains saved progress and remaining work', () => {
    expect(syncOutcomeMessage({ state: 'incomplete', accepted: 100, pendingOperations: 25, remoteChangesPending: true }))
      .toBe('Sync saved progress after sending 100 local changes. 25 local changes remain; tap Sync now to continue. More changes are waiting from the PC.')
  })

  test('media awaiting pairing is distinguished from media that will retry', () => {
    const needsPairing = syncOutcomeMessage(complete({ pending: 2, uploadError: 'authentication-required' }))
    expect(needsPairing).toContain('still need pairing')
    const willRetry = syncOutcomeMessage(complete({ pending: 2, uploadError: 'unreachable' }))
    expect(willRetry).toContain('will retry when the PC is reachable')
    // The card data itself landed; only media is outstanding, and it must say so.
    expect(needsPairing).toMatch(/^Card sync complete\./)
    expect(willRetry).toMatch(/^Card sync complete\./)
    expect(needsPairing).not.toBe(willRetry)
  })

  test('one outstanding media file is not pluralised', () => {
    expect(syncOutcomeMessage(complete({ pending: 1, uploadError: 'authentication-required' }))).toContain('1 media file still need pairing')
  })

  test('a download failure is treated the same as an upload failure', () => {
    expect(syncOutcomeMessage(complete({ pending: 1, downloadError: 'unreachable' }))).toBe(syncOutcomeMessage(complete({ pending: 1, uploadError: 'unreachable' })))
  })

  test('media retry status does not hide unresolved conflicts', () => {
    expect(syncOutcomeMessage({ ...complete({ pending: 1, uploadError: 'unreachable' }), conflicts: 2 }))
      .toBe('Card sync complete. 1 media file will retry when the PC is reachable. 2 conflicts need review.')
  })
})

describe('a sync that did not complete', () => {
  test('an expired pairing says so without implying data loss', () => {
    expect(syncOutcomeMessage({ state: 'authentication-required' })).toMatch(/paired again/i)
  })

  test('a version mismatch names which side needs updating', () => {
    const device = syncOutcomeMessage({ state: 'upgrade-required', target: 'this-device' })
    const service = syncOutcomeMessage({ state: 'upgrade-required', target: 'pc-service' })
    expect(device).toMatch(/this device needs a kiroku update/i)
    expect(service).toMatch(/pc sync service needs an update/i)
    expect(device).not.toBe(service)
    // In both cases the learner's local changes are explicitly retained.
    expect(device).toMatch(/remain on this device/)
    expect(service).toMatch(/remain on this device/)
  })

  test('an unreachable service says the work is kept and will retry', () => {
    const message = syncOutcomeMessage({ state: 'unreachable' })
    expect(message).toMatch(/could not be reached/i)
    expect(message).toMatch(/remain on this device/)
    expect(message).toMatch(/retry/i)
  })

  test('a failed automatic backup displays the service explanation', () => {
    expect(syncOutcomeMessage({ state: 'backup-failed', message: 'Verified backup unavailable; no sync changes were accepted.' }))
      .toBe('Verified backup unavailable; no sync changes were accepted.')
  })

  test('an unrecognised outcome still produces something the learner can read', () => {
    expect(syncOutcomeMessage({ state: 'error' })).toMatch(/could not be reached/i)
  })
})

describe('pairing', () => {
  test('each outcome has its own message', () => {
    expect(pairOutcomeMessage('paired')).toMatch(/PC connected/i)
    expect(pairOutcomeMessage('unreachable')).toMatch(/could not be reached/i)
    expect(pairOutcomeMessage('pairing-error')).toMatch(/not accepted/i)
  })

  test('only a successful pairing closes the form', () => {
    // Closing on a rejection would discard the code the learner just typed.
    expect(pairingClosesOn('paired')).toBe(true)
    expect(pairingClosesOn('pairing-error')).toBe(false)
    expect(pairingClosesOn('unreachable')).toBe(false)
  })
})

describe('before any pairing', () => {
  test('the resting message states where the data lives', () => {
    expect(SYNC_LOCAL_ONLY).toMatch(/stays on this device/i)
    expect(SYNC_LOCAL_ONLY).toMatch(/until you connect a PC/i)
  })
})
