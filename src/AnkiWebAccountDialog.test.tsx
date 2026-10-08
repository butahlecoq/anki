import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NativeAnkiClient, NativeSyncError } from './native-anki-sync'
import type { SqlJsStatic } from 'sql.js'
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

test('reports an interrupted collection download from an actual successful response with a failing body', async () => {
  const healthProbe = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null))
  vi.mocked(connectNativeAnkiAccount).mockImplementation(async () => {
    const client = await NativeAnkiClient.login(async (route) => {
      if (route === 'sync/hostKey') return Response.json({ key: 'private-host-key' })
      if (route === 'sync/meta') return Response.json({ mod: 1, scm: 1, usn: 0, ts: 1, cont: true, empty: false })
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new TypeError('private response body details')) },
      }), { status: 200 })
    }, 'private-user', 'private-password')
    await client.downloadCollection({} as SqlJsStatic)
    throw new Error('The failed download must not finish')
  })
  render(<AnkiWebAccountDialog settings={{ endpoint: 'http://127.0.0.1:8787', token: 'a'.repeat(64), cursor: 0 }} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('AnkiWeb username'), { target: { value: 'private-user' } })
  fireEvent.change(screen.getByLabelText('AnkiWeb password'), { target: { value: 'private-password' } })
  fireEvent.submit(screen.getByRole('button', { name: 'Connect account' }).closest('form')!)
  await screen.findByText(/collection download was interrupted/)
  expect(screen.getByRole('status')).toHaveTextContent('local work is preserved')
  expect(screen.getByRole('status')).toHaveTextContent('response-body')
  expect(screen.getByRole('status')).not.toHaveTextContent(/rejected this app origin|private-/)
  expect(screen.getByLabelText('AnkiWeb password')).toHaveValue('')
  expect(healthProbe).not.toHaveBeenCalled()
})

test.each([
  ['unreachable PC', () => { throw new TypeError('private socket details') }, /PC service could not be reached or the browser blocked the request/],
  ['confirmed origin', () => new Response(null, { status: 403, headers: { 'x-kiroku-response-source': 'relay', 'x-kiroku-relay-error': 'origin-rejected' } }), /rejected this app origin/],
  ['pairing credential', () => new Response(null, { status: 401, headers: { 'x-kiroku-relay-error': 'paired-authentication' } }), /no longer paired/],
  ['upstream credential', () => new Response(null, { status: 403, headers: { 'x-kiroku-response-source': 'upstream' } }), /AnkiWeb rejected the username or password/],
] as const)('shows distinct guidance for %s through the native transport', async (_name, response, message) => {
  const healthProbe = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null))
  vi.mocked(connectNativeAnkiAccount).mockImplementation(async () => {
    await NativeAnkiClient.login(async () => response(), 'private-user', 'private-password')
    throw new Error('The failed login must not finish')
  })
  render(<AnkiWebAccountDialog settings={{ endpoint: 'http://127.0.0.1:8787', token: 'a'.repeat(64), cursor: 0 }} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('AnkiWeb username'), { target: { value: 'private-user' } })
  fireEvent.change(screen.getByLabelText('AnkiWeb password'), { target: { value: 'private-password' } })
  fireEvent.submit(screen.getByRole('button', { name: 'Connect account' }).closest('form')!)
  await screen.findByText(message)
  expect(screen.getByRole('status')).not.toHaveTextContent(/private-user|private-password|private socket details/)
  if (_name === 'unreachable PC') {
    expect(screen.getByRole('status')).toHaveTextContent('cause could not be confirmed')
    expect(screen.getByRole('status')).toHaveTextContent('before-response')
    expect(screen.getByRole('status')).not.toHaveTextContent('rejected this app origin')
  }
  expect(healthProbe).not.toHaveBeenCalled()
})

test('does not relabel a local processing TypeError as a transport or origin failure', async () => {
  vi.mocked(connectNativeAnkiAccount).mockRejectedValue(new TypeError('private SQL details'))
  render(<AnkiWebAccountDialog settings={{ endpoint: 'http://127.0.0.1:8787', token: 'a'.repeat(64), cursor: 0 }} onClose={vi.fn()} />)
  fireEvent.submit(screen.getByRole('button', { name: 'Connect account' }).closest('form')!)
  await screen.findByText('The AnkiWeb connection could not be completed.')
})
