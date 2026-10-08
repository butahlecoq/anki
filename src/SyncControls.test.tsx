import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SyncControls } from './SyncControls'

const pairCollection = vi.hoisted(() => vi.fn())
vi.mock('./sync-client', () => ({
  pairCollection,
  listPcBackups: vi.fn().mockResolvedValue({ backups: [] }),
  createAndDownloadPcBackup: vi.fn(), previewPcBackupRestore: vi.fn(), restorePcBackup: vi.fn(), syncCollection: vi.fn(), rotateCredential: vi.fn(),
}))

describe('PC pairing dialog', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  test.each([
    ['paired', /PC connected/i, false],
    ['unreachable', /could not be reached/i, true],
    ['address-error', /PC service address is invalid or unsafe/i, true],
    ['pairing-error', /code was not accepted/i, true],
    ['collection-generation-required', /offline collection/i, true],
  ] as const)('shows %s and closes only on success', async (state, message, remainsOpen) => {
    pairCollection.mockResolvedValueOnce({ state })
    render(<SyncControls offlineSyncAvailable={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect a PC' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect a PC' }))
    fireEvent.change(screen.getByLabelText('PC service address'), { target: { value: 'https://pc.example.net' } })
    fireEvent.change(screen.getByLabelText('One-time pairing code'), { target: { value: 'ABC123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect device' }))
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(/Pairing failed\. network reset/i))
    expect(screen.getByRole('button', { name: 'Connect device' })).toBeEnabled()
  })
})
