import { render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { App } from './App'

describe('application shell', () => {
  test('presents the local-first study workspace with accessible primary navigation', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Your Japanese study system' })).toBeVisible()
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(navigation).toBeVisible()
    expect(within(navigation).getByRole('link', { name: 'Decks0' })).toHaveAttribute('aria-current', 'page')
    expect(within(navigation).getByRole('link', { name: 'Study' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Ready for offline study')
    expect(screen.getByRole('button', { name: /new deck/i })).toBeDisabled()
  })
})
