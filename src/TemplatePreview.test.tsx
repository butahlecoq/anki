import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { TemplatePreview } from './TemplatePreview'

afterEach(cleanup)

test('uses the chosen cloze ordinal on the front and reveals it on the back', () => {
  const props = { front: '{{cloze:Text}}', back: '{{FrontSide}}<hr>{{cloze:Text}}', css: '', fields: { Text: '{{c1::東京}}と{{c2::大阪}}' }, kind: 'cloze' as const, ordinal: 2 }
  const { rerender } = render(<TemplatePreview {...props} side="front" />)
  expect(screen.getByTitle('Card preview')).toHaveAttribute('srcdoc', expect.stringContaining('東京と<span class="cloze">[…]</span>'))
  rerender(<TemplatePreview {...props} side="back" />)
  expect(screen.getByTitle('Card preview')).toHaveAttribute('srcdoc', expect.stringContaining('東京と<span class="cloze">大阪</span>'))
})

test('contains malformed synced templates as an actionable preview error', () => {
  render(<TemplatePreview front="{{cloze:Text" back="{{cloze:Text}}" css="" fields={{ Text: '{{c1::東京}}' }} kind="cloze" ordinal={1} side="front" />)
  expect(screen.getByRole('alert')).toHaveTextContent(/unmatched template delimiter/i)
  expect(screen.queryByTitle('Card preview')).not.toBeInTheDocument()
})

test('applies Anki card and template-ordinal CSS classes', () => {
  render(<TemplatePreview front="{{Front}}" back="{{FrontSide}}" css=".card2 { color: red }" fields={{ Front: 'question' }} templateOrdinal={2} side="front" />)
  expect(screen.getByTitle('Card preview')).toHaveAttribute('srcdoc', expect.stringContaining('<body class="card card2">'))
})
