import { expect, test } from 'vitest'
import { accountActionLabel } from './account-dialog-state'

test('only the account operation in progress gets its busy label', () => {
  expect(accountActionLabel('media', 'prepare', 'Download and verify account media', 'Synchronizing media…'))
    .toBe('Download and verify account media')
  expect(accountActionLabel('prepare', 'prepare', 'Preview account collection', 'Preparing…'))
    .toBe('Preparing…')
})
