import { expect, test } from 'vitest'
import { NativeSyncError } from './native-anki-sync'
import { nativeAnkiAccountErrorMessage } from './native-anki-account-message'

test('shows the supported AnkiWeb update state without exposing the protocol error', () => {
  const message = nativeAnkiAccountErrorMessage(new NativeSyncError('upgrade', 'private protocol boundary details'))
  expect(message).toContain('AnkiWeb needs an update')
  expect(message).toContain('your account data remains safe')
  expect(message).not.toContain('private protocol boundary details')
})

test('keeps actionable account authentication guidance', () => {
  expect(nativeAnkiAccountErrorMessage(new NativeSyncError('authentication', 'private auth response')))
    .toBe('AnkiWeb rejected the username or password. Check them and try again.')
})
