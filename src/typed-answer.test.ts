import { describe, expect, test } from 'vitest'
import { compareTypedAnswer } from './typed-answer'

describe('compareTypedAnswer', () => {
  test('shows matching, incorrect, and missing graphemes with readable text', () => {
    expect(compareTypedAnswer('ねこ', 'ねごん')).toEqual([
      { kind: 'good', text: 'ね' },
      { kind: 'bad', text: 'ごん' },
      { kind: 'missed', text: 'こ' },
    ])
  })

  test('compares a combined emoji as one grapheme and normalizes equivalent Unicode', () => {
    expect(compareTypedAnswer('が👨‍👩‍👧', 'が👨‍👩‍👧')).toEqual([{ kind: 'good', text: 'が👨‍👩‍👧' }])
  })
})
