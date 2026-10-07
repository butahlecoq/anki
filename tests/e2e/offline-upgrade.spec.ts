import { openCollectionTools } from './collection-tools'
import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openOfflineProfileDocument } from './offline-navigation'

const webURL = process.env.KIROKU_TEST_URL ?? `http://127.0.0.1:${process.env.KIROKU_WEB_PORT ?? '4173'}`

test('a populated prior-schema collection migrates before offline use and cold-opens in Chromium', async ({ browserName, browser }) => {
  const profile = await mkdtemp(join(tmpdir(), 'kiroku-upgrade-profile-'))
  let firstContext: import('@playwright/test').BrowserContext | undefined
  let reopenedContext: import('@playwright/test').BrowserContext | undefined

  try {
    firstContext = await browser.browserType().launchPersistentContext(profile)
    const first = firstContext.pages()[0] ?? await firstContext.newPage()
    await first.route(`${webURL}/`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }))
    await first.goto(`${webURL}/`)
    await first.evaluate(async () => {
      const imageBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg=='), (character) => character.charCodeAt(0))
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', imageBytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('kiroku-collection', 50)
        request.onupgradeneeded = () => {
          const database = request.result
          database.createObjectStore('decks', { keyPath: 'id' }).createIndex('name', 'name')
          database.createObjectStore('notes', { keyPath: 'id' }).createIndex('deckId', 'deckId')
          database.createObjectStore('cards', { keyPath: 'id' }).createIndex('deckId', 'deckId')
          database.createObjectStore('reviewEntries', { keyPath: 'id' }).createIndex('cardId', 'cardId')
          database.createObjectStore('outbox', { keyPath: 'opId' })
          database.createObjectStore('settings', { keyPath: 'key' })
          database.createObjectStore('receivedOperations', { keyPath: 'opId' })
          database.createObjectStore('deletedEntities', { keyPath: 'key' })
          database.createObjectStore('noteMedia', { keyPath: 'id' }).createIndex('noteId', 'noteId')
          database.createObjectStore('mediaBlobs', { keyPath: 'digest' })
        }
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(Array.from(database.objectStoreNames), 'readwrite')
          transaction.objectStore('decks').put({ id: 'legacy-deck', name: 'Upgraded offline', createdAt: '2026-10-01T00:00:00.000Z' })
          transaction.objectStore('notes').put({ id: 'legacy-note', deckId: 'legacy-deck', type: 'basic', fields: { front: '猫', back: 'cat' }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })
          transaction.objectStore('cards').put({ id: 'legacy-card', deckId: 'legacy-deck', noteId: 'legacy-note', due: '2026-10-02T00:00:00.000Z', stability: 4, difficulty: 5, elapsedDays: 1, scheduledDays: 2, learningSteps: 0, reps: 2, lapses: 0, state: 2, lastReview: '2026-10-01T00:00:00.000Z' })
          transaction.objectStore('reviewEntries').put({ id: 'legacy-review', cardId: 'legacy-card', deckId: 'legacy-deck', rating: 3, state: 2, due: '2026-10-02T00:00:00.000Z', stability: 4, difficulty: 5, elapsedDays: 1, lastElapsedDays: 1, scheduledDays: 2, learningSteps: 0, reviewedAt: '2026-10-01T00:00:00.000Z' })
          transaction.objectStore('outbox').put({ opId: 'legacy-offline-edit', entityType: 'note', entityId: 'legacy-note', action: 'update', occurredAt: '2026-10-01T00:00:00.000Z', payload: { id: 'legacy-note', fields: { front: '猫', back: 'cat' } } })
          transaction.objectStore('noteMedia').put({ id: 'legacy-media', noteId: 'legacy-note', digest, displayName: 'cat.png', side: 'front', kind: 'image', mimeType: 'image/png', byteLength: imageBytes.byteLength, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })
          transaction.objectStore('mediaBlobs').put({ digest, blob: new Blob([imageBytes], { type: 'image/png' }), byteLength: imageBytes.byteLength, mimeType: 'image/png', verifiedAt: '2026-10-01T00:00:00.000Z' })
          transaction.oncomplete = () => { database.close(); resolve() }
          transaction.onerror = () => reject(transaction.error ?? new Error('Could not seed the prior collection schema.'))
          transaction.onabort = () => reject(transaction.error ?? new Error('Seeding the prior collection schema was aborted.'))
        }
        request.onerror = () => reject(request.error ?? new Error('Could not create the prior collection database.'))
      })
    })
    await first.unroute(`${webURL}/`)
    await first.clock.setFixedTime(new Date('2026-10-03T12:00:00.000Z'))
    await first.reload()
    await first.evaluate(() => { window.location.hash = '#deck/legacy-deck' })

    await expect(first.getByRole('heading', { name: 'Upgraded offline' })).toBeVisible()
    await expect(first.getByText('REVIEWS 1')).toBeVisible()
    await openCollectionTools(first)
    await first.getByTestId('offline-storage-summary').click()
    await expect(first.getByText('1 changes waiting to sync.')).toBeVisible()
    await first.getByRole('button', { name: 'Study now' }).click()
    const firstImage = first.getByRole('img', { name: 'cat.png' })
    await expect(firstImage).toBeVisible()
    await expect.poll(() => firstImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 1)).toBe(true)

    if (browserName === 'webkit') {
      await firstContext.setOffline(true)
      await expect(first.getByText('Offline shell active')).toBeVisible()
      await first.getByRole('button', { name: 'Show answer' }).click()
      await first.getByRole('button', { name: /^Good · / }).click()
      await expect(first.getByRole('heading', { name: 'Session complete' })).toBeVisible()
      return
    }

    await first.evaluate(async () => { await navigator.serviceWorker.ready })

    await firstContext.close()
    firstContext = undefined
    reopenedContext = await browser.browserType().launchPersistentContext(profile)
    await reopenedContext.setOffline(true)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await reopened.clock.setFixedTime(new Date('2026-10-03T12:00:00.000Z'))
    await openOfflineProfileDocument(reopened, `${webURL}/#deck/legacy-deck`)

    await expect(reopened.getByRole('heading', { name: 'Upgraded offline' })).toBeVisible()
    await expect(reopened.getByText('REVIEWS 1')).toBeVisible()
    await openCollectionTools(reopened)
    await reopened.getByTestId('offline-storage-summary').click()
    await expect(reopened.getByText('1 changes waiting to sync.')).toBeVisible()
    await reopened.getByRole('button', { name: 'Study now' }).click()
    const offlineImage = reopened.getByRole('img', { name: 'cat.png' })
    await expect(offlineImage).toBeVisible()
    await expect.poll(() => offlineImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 1)).toBe(true)
  } finally {
    await firstContext?.close()
    await reopenedContext?.close()
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
})
