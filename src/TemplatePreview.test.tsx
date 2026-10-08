import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { TemplatePreview } from './TemplatePreview'
import { renderCard } from './card-rendering'
import { APPEARANCE_STORAGE_KEY, chooseAppearance } from './appearance'

function preview(front: string, back: string, fields: Record<string, string>, options: { kind?: 'standard' | 'cloze'; ordinal?: number; css?: string } = {}) {
  return renderCard({ front, back, css: options.css ?? '' }, fields, { kind: options.kind, ordinal: options.ordinal })
}

afterEach(cleanup)

test('uses the chosen cloze ordinal on the front and reveals it on the back', () => {
  const rendering = preview('{{cloze:Text}}', '{{FrontSide}}<hr>{{cloze:Text}}', { Text: '{{c1::東京}}と{{c2::大阪}}' }, { kind: 'cloze', ordinal: 2 })
  const { rerender } = render(<TemplatePreview rendering={rendering} side="front" />)
  expect(screen.getByTitle('Card preview')).toHaveAttribute('srcdoc', expect.stringContaining('東京と<span class="cloze">[…]</span>'))
  rerender(<TemplatePreview rendering={rendering} side="back" />)
  expect(screen.getByTitle('Card preview')).toHaveAttribute('srcdoc', expect.stringContaining('東京と<span class="cloze">大阪</span>'))
})

test('contains malformed synced templates as an actionable preview error', () => {
  const rendering = preview('{{cloze:Text', '{{cloze:Text}}', { Text: '{{c1::東京}}' }, { kind: 'cloze', ordinal: 1 })
  render(<TemplatePreview rendering={rendering} side="front" />)
  expect(screen.getByRole('alert')).toHaveTextContent(/unmatched template delimiter/i)
  expect(screen.queryByTitle('Card preview')).not.toBeInTheDocument()
})

test('applies Anki card and template-ordinal CSS classes', () => {
  const rendering = preview('{{Front}}', '{{FrontSide}}', { Front: 'question' }, { css: '.card2 { color: red }' })
  render(<TemplatePreview rendering={rendering} templateOrdinal={2} side="front" />)
  expect(screen.getByTitle('Card preview')).toHaveAttribute('srcdoc', expect.stringContaining('<body class="card card2">'))
})

test('a card with no background of its own follows the resolved theme', () => {
  const rendering = preview('{{Front}}', '{{FrontSide}}', { Front: 'question' })
  render(<TemplatePreview rendering={rendering} side="front" />)
  const srcDoc = screen.getByTitle('Card preview').getAttribute('srcdoc') ?? ''
  // The default is themed, not the fixed white it used to be, and the body
  // reaches its colour through the property so an import can still override it.
  expect(srcDoc).toContain('--kiroku-card-surface:#101317')
  expect(srcDoc).toContain('color:var(--kiroku-card-ink);background:var(--kiroku-card-surface)')
  expect(srcDoc).not.toMatch(/background:\s*#fff\b/)
})

test('an imported deck still overrides the themed card default', () => {
  const rendering = preview('{{Front}}', '{{FrontSide}}', { Front: 'question' }, { css: '.card{background:#123456;color:#fedcba}' })
  render(<TemplatePreview rendering={rendering} side="front" />)
  const srcDoc = screen.getByTitle('Card preview').getAttribute('srcdoc') ?? ''
  // The deck's CSS is still last in the one stylesheet, and it still targets a
  // more specific selector than the themed body, so the import owns its colours.
  expect(srcDoc).toContain('.card{background:#123456;color:#fedcba}')
  expect(srcDoc.lastIndexOf('.card{background:#123456')).toBeGreaterThan(srcDoc.lastIndexOf('--kiroku-card-surface:#101317'))
})

test('switching the theme repaints the card without rebuilding its document', () => {
  // The theme reaches the frame as an attribute on its documentElement, so the
  // srcDoc is identical in both themes. That is what keeps cached blob media
  // alive across a theme change: rebuilding srcDoc would reload the document.
  const rendering = preview('{{Front}}', '{{FrontSide}}', { Front: 'question' })
  const { rerender } = render(<TemplatePreview rendering={rendering} side="front" />)
  const frame = screen.getByTitle('Card preview')
  const before = frame.getAttribute('srcdoc')

  chooseAppearance('light')
  rerender(<TemplatePreview rendering={rendering} side="front" />)
  expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('light')
  expect(screen.getByTitle('Card preview').getAttribute('srcdoc')).toBe(before)
  expect(screen.getByTitle('Card preview')).toBe(frame)

  chooseAppearance('dark')
  rerender(<TemplatePreview rendering={rendering} side="front" />)
  expect(screen.getByTitle('Card preview').getAttribute('srcdoc')).toBe(before)
  expect(screen.getByTitle('Card preview')).toBe(frame)
})
