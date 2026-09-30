import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { App } from './App'

const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')

afterEach(() => {
  cleanup()
  if (serviceWorkerDescriptor) Object.defineProperty(navigator, 'serviceWorker', serviceWorkerDescriptor)
  else Reflect.deleteProperty(navigator, 'serviceWorker')
})

describe('application shell', () => {
  test('presents the local-first study workspace with accessible primary navigation', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Your Japanese study system' })).toBeVisible()
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(navigation).toBeVisible()
    expect(within(navigation).getByRole('link', { name: 'Decks' })).toHaveAttribute('aria-current', 'page')
    expect(within(navigation).getByRole('link', { name: 'Study' })).toBeVisible()
    expect(within(navigation).getByRole('link', { name: 'Study' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Offline cache unavailable')
    expect(screen.getByRole('button', { name: /new deck/i })).toBeDisabled()
  })
})

test('waits for service-worker readiness before claiming the offline shell is ready', () => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: new Promise(() => undefined) },
  })

  render(<App />)

  expect(screen.getByRole('status')).toHaveTextContent('Preparing offline shell')
})
