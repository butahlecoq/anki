import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CollectionStartup } from './CollectionStartup'

afterEach(cleanup)

describe('collection startup gate', () => {
  test('does not mount the workspace until the local database opens', async () => {
    let finishOpen!: () => void
    const openCollection = vi.fn(() => new Promise<void>((resolve) => { finishOpen = resolve }))
    render(<CollectionStartup openCollection={openCollection}><p>Study workspace</p></CollectionStartup>)

    expect(screen.getByRole('status')).toHaveTextContent('Opening your local collection')
    expect(screen.queryByText('Study workspace')).not.toBeInTheDocument()
    finishOpen()
    expect(await screen.findByText('Study workspace')).toBeVisible()
  })

  test('keeps a failed upgrade from looking like an empty collection and allows retry', async () => {
    const openCollection = vi.fn()
      .mockRejectedValueOnce(new DOMException('Storage is full', 'QuotaExceededError'))
      .mockResolvedValueOnce(undefined)
    render(<CollectionStartup openCollection={openCollection}><p>Study workspace</p></CollectionStartup>)

    expect(await screen.findByRole('alert')).toHaveTextContent('Your collection could not be opened')
    expect(screen.getByText(/Keep this browser profile and its site data intact/)).toBeVisible()
    expect(screen.queryByText('Study workspace')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try opening the collection again' }))
    expect(await screen.findByText('Study workspace')).toBeVisible()
    expect(openCollection).toHaveBeenCalledTimes(2)
  })
})
