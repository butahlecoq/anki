import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { collection, createCollection } from './collection'
import { SyncConflicts } from './SyncConflicts'

afterEach(async () => { cleanup(); await collection.delete() })

test('conflict choices label the record and fields, reject a changed version, and resume the latest context', async () => {
  const peer = createCollection(`conflict-peer-${crypto.randomUUID()}`)
  try {
    const now = new Date('2026-10-02T12:00:00Z')
    const deck = await collection.createDeck('Japanese conflict', now)
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' }, now)
    const seed = await collection.pendingOperations()
    await peer.applyRemoteChanges(structuredClone(seed), seed.length)
    await collection.acknowledgeOperations(seed.map((operation) => operation.opId))
    await collection.updateBasicNote(note.id, { front: 'ねこ', back: 'cat' }, now)
    await peer.updateBasicNote(note.id, { front: 'ネコ', back: 'cat' }, now)
    const first = await peer.pendingOperations()
    await collection.applyRemoteChanges(structuredClone(first), first.length)
    render(<SyncConflicts />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review note conflict' }))
    const dialog = screen.getByRole('dialog', { name: 'Choose the saved version' })
    await waitFor(() => expect(dialog).toHaveTextContent('Deck: Japanese conflict'))
    expect(dialog).toHaveTextContent('Basic')
    expect(dialog).toHaveTextContent('Conflicting properties: front')
    expect(dialog).toHaveTextContent('front: ねこ')
    expect(dialog).toHaveTextContent('back: cat')
    expect(dialog.querySelector('time')).toHaveAttribute('datetime', now.toISOString())
    const version = within(dialog).getAllByRole('group').find((group) => group.textContent?.includes('ネコ'))!
    fireEvent.click(within(version).getByRole('radio'))
    // A new genuine peer edit makes the open choice stale.
    await peer.updateBasicNote(note.id, { front: '猫ちゃん', back: 'cat' }, new Date('2026-10-02T12:01:00Z'))
    const latest = await peer.pendingOperations()
    await collection.applyRemoteChanges(structuredClone(latest), latest.length)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save choice' }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('This conflict changed'))
    expect(await collection.syncConflicts.count()).toBe(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decide later' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review note conflict' }))
    const resumed = screen.getByRole('dialog', { name: 'Choose the saved version' })
    expect(resumed).toHaveTextContent('猫ちゃん')
    expect(within(resumed).getByRole('button', { name: 'Save choice' })).toBeDisabled()
  } finally { peer.close(); await peer.delete() }
})
