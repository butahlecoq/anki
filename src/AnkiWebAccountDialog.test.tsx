import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NativeSyncError } from './native-anki-sync'
import { AnkiWebAccountDialog } from './AnkiWebAccountDialog'
import { connectNativeAnkiAccount } from './native-anki-account-session'

vi.mock('./native-anki-account-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./native-anki-account-session.js')>()
  return { ...actual, connectNativeAnkiAccount: vi.fn() }
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('shows a clear AnkiWeb update status when the server returns an upgrade boundary', async () => {
  vi.mocked(connectNativeAnkiAccount).mockRejectedValue(new NativeSyncError('upgrade', 'private protocol boundary details'))
  render(<AnkiWebAccountDialog settings={{ endpoint: 'http://127.0.0.1:8787', token: 'a'.repeat(64), cursor: 0 }} onClose={vi.fn()} />)

  fireEvent.change(screen.getByLabelText('AnkiWeb username'), { target: { value: 'learner' } })
  fireEvent.change(screen.getByLabelText('AnkiWeb password'), { target: { value: 'private' } })
  fireEvent.submit(screen.getByRole('button', { name: 'Connect account' }).closest('form')!)

  await screen.findByText(/AnkiWeb needs an update/)
  const status = screen.getByRole('status')
  expect(status).toHaveTextContent('AnkiWeb needs an update')
  expect(status).toHaveTextContent('your account data remains safe')
  expect(status).not.toHaveTextContent('private protocol boundary details')
})
