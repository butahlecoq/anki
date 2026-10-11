import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { collection } from './collection'
import { readNote } from './collection-queries'
import { SyncControls } from './SyncControls'

const pairCollection = vi.hoisted(() => vi.fn())
const connectPrivatePc = vi.hoisted(() => vi.fn().mockResolvedValue({ state: 'manual' }))
vi.mock('./sync-client', () => ({
  pairCollection,
  connectPrivatePc,
  listPcBackups: vi.fn().mockResolvedValue({ backups: [] }),
  createAndDownloadPcBackup: vi.fn(), previewPcBackupRestore: vi.fn(), restorePcBackup: vi.fn(), syncCollection: vi.fn(), rotateCredential: vi.fn(),
}))

describe('PC pairing dialog', () => {
  beforeEach(async () => { await collection.openLocalCollection() })
  afterEach(async () => { cleanup(); vi.clearAllMocks(); await collection.removeLocalCollection() })

  test('connects the private PC automatically and keeps local notes without a code form', async () => {
    const deck = await collection.createDeck('Local work')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    connectPrivatePc.mockImplementationOnce(async () => {
      await collection.configureSync({ endpoint: 'https://owner.example.test', token: 'device-token', cursor: 0 })
      return { state: 'paired' }
    })
    render(<SyncControls offlineSyncAvailable />)
    await screen.findByText('Connected to your PC.')
    expect(pairCollection).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('One-time pairing code')).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced PC connection')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect AnkiWeb account' }))
    expect(screen.getByLabelText('AnkiWeb username')).toBeVisible()
    expect(screen.getByLabelText('AnkiWeb password')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect account' })).toBeEnabled())
    expect(await readNote(collection, note.id)).toMatchObject({ fields: { front: '猫', back: 'cat' } })
  })

  test('private connection failure retries without a code form or losing the account fields', async () => {
    connectPrivatePc.mockResolvedValueOnce({ state: 'unreachable' })
    connectPrivatePc.mockImplementationOnce(async () => {
      await collection.configureSync({ endpoint: 'https://owner.example.test', token: 'retry-token', cursor: 0 })
      return { state: 'paired' }
    })
    render(<SyncControls offlineSyncAvailable />)
    await screen.findByText(/Your PC is unavailable/)
    expect(screen.queryByText('Advanced PC connection')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect AnkiWeb account' }))
    fireEvent.change(screen.getByLabelText('AnkiWeb username'), { target: { value: 'synthetic-account' } })
    fireEvent.change(screen.getByLabelText('AnkiWeb password'), { target: { value: 'synthetic-password' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry PC connection' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect account' })).toBeEnabled())
    expect(screen.getByLabelText('AnkiWeb username')).toHaveValue('synthetic-account')
    expect(screen.getByLabelText('AnkiWeb password')).toHaveValue('synthetic-password')
    expect(screen.queryByLabelText('PC service address')).not.toBeInTheDocument()
    expect(pairCollection).not.toHaveBeenCalled()
  })

  test('offers AnkiWeb before pairing and clears the account intent on cancel', async () => {
    render(<SyncControls offlineSyncAvailable={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect AnkiWeb account' }))
    expect(screen.getByRole('dialog', { name: 'Connect AnkiWeb' })).toBeInTheDocument()
    expect(screen.getByLabelText('AnkiWeb username')).toBeVisible()
    expect(screen.getByLabelText('AnkiWeb password')).toBeVisible()
    expect(screen.queryByLabelText('PC service address')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Set up PC connection' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a PC' }))
    expect(screen.getByRole('dialog', { name: 'Connect to your PC' })).toBeInTheDocument()
  })

  test('PC setup cancellation returns to the same account login without submitting credentials', async () => {
    render(<SyncControls offlineSyncAvailable={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect AnkiWeb account' }))
    fireEvent.change(screen.getByLabelText('AnkiWeb username'), { target: { value: 'test-account' } })
    fireEvent.change(screen.getByLabelText('AnkiWeb password'), { target: { value: 'synthetic-password' } })
    expect(screen.getByRole('button', { name: 'Connect account' })).toBeDisabled()
    fireEvent.click(await screen.findByRole('button', { name: 'Set up PC connection' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Connect to your PC' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByLabelText('AnkiWeb username')).toHaveValue('test-account')
    expect(screen.getByLabelText('AnkiWeb password')).toHaveValue('synthetic-password')
    expect(pairCollection).not.toHaveBeenCalled()
  })

  test.each([
    ['paired', /PC connected/i, false],
    ['unreachable', /could not be reached/i, true],
    ['address-error', /PC service address is invalid or unsafe/i, true],
    ['pairing-error', /code was not accepted/i, true],
    ['collection-generation-required', /offline collection/i, true],
  ] as const)('shows %s and closes only on success', async (state, message, remainsOpen) => {
    pairCollection.mockResolvedValueOnce({ state })
    render(<SyncControls offlineSyncAvailable={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a PC' }))
    fireEvent.change(screen.getByLabelText('PC service address'), { target: { value: 'https://pc.example.net' } })
    fireEvent.change(screen.getByLabelText('One-time pairing code'), { target: { value: 'ABC123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect device' }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'PC sync' })).toHaveTextContent(message))
    if (remainsOpen) {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(message)
      expect(screen.getByLabelText('PC service address')).toHaveValue('https://pc.example.net')
      expect(screen.getByLabelText('One-time pairing code')).toHaveValue('ABC123')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      fireEvent.click(screen.getByRole('button', { name: 'Connect a PC' }))
      expect(within(screen.getByRole('dialog')).queryByRole('alert')).not.toBeInTheDocument()
    }
    else expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('shows unexpected rejection and lets the learner retry', async () => {
    pairCollection.mockRejectedValueOnce(new Error('network reset'))
    render(<SyncControls offlineSyncAvailable={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a PC' }))
    fireEvent.change(screen.getByLabelText('PC service address'), { target: { value: 'https://pc.example.net' } })
    fireEvent.change(screen.getByLabelText('One-time pairing code'), { target: { value: 'ABC123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect device' }))
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(/Pairing failed\. network reset/i))
    expect(screen.getByRole('button', { name: 'Connect device' })).toBeEnabled()
  })
  test('continues successful account pairing to login without deleting local cards', async () => {
    const deck = await collection.createDeck(`Account entry ${crypto.randomUUID()}`)
    const note = await collection.createBasicNote(deck.id, { front: 'local work', back: 'keep me' })
    pairCollection.mockImplementationOnce(async () => {
      await collection.configureSync({ endpoint: 'https://pc.example.net', token: 'test-device-token', cursor: 0 })
      return { state: 'paired' }
    })
    render(<SyncControls offlineSyncAvailable={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect AnkiWeb account' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Set up PC connection' }))
    fireEvent.change(screen.getByLabelText('PC service address'), { target: { value: 'https://pc.example.net' } })
    fireEvent.change(screen.getByLabelText('One-time pairing code'), { target: { value: 'ABC123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect device' }))
    expect(await screen.findByRole('dialog', { name: 'Connect AnkiWeb' })).toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByLabelText('AnkiWeb username')).toHaveValue('')
    expect(await readNote(collection, note.id)).toBeDefined()
  })

})
