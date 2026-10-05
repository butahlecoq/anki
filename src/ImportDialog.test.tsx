import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ImportDialog } from './ImportDialog'

const prepareAnkiImport = vi.hoisted(() => vi.fn())
vi.mock('./anki-import', () => ({ prepareAnkiImport }))

function prepared(commit: () => Promise<void> = async () => {}) {
  const summary = { decks: 1, noteTypes: 1, notes: 2, cards: 2, reviews: 0, media: 0 }
  const duplicates = { create: 2, update: 0, keepLocal: 0, unchanged: 0 }
  return {
    filename: 'sample.apkg', summary, duplicates, issues: [],
    plan: { summary, duplicates, issues: [], blocksImport: false, decisions: [], writes: {} }, commit,
  }
}

describe('Anki import dialog', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })
  const chooseFile = (name: string) => fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], name)] } })
  test('previews and commits a package', async () => {
    const commit = vi.fn().mockResolvedValue(undefined)
    prepareAnkiImport.mockResolvedValueOnce(prepared(commit))
    const onClose = vi.fn()
    render(<ImportDialog onClose={onClose} />)
    chooseFile('sample.apkg')
    expect(await screen.findByText('sample.apkg')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Import package' }))
    await waitFor(() => expect(commit).toHaveBeenCalledOnce())
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('keeps the dialog open when preview fails', async () => {
    prepareAnkiImport.mockRejectedValueOnce(new Error('Package is corrupt'))
    render(<ImportDialog onClose={vi.fn()} />)
    chooseFile('bad.apkg')
    expect(await screen.findByRole('alert')).toHaveTextContent('Package is corrupt')
    expect(screen.getByRole('dialog', { name: 'Import Anki package' })).toBeInTheDocument()
  })

  test('keeps the dialog open when commit fails', async () => {
    prepareAnkiImport.mockResolvedValueOnce(prepared(() => Promise.reject(new Error('Write failed'))))
    render(<ImportDialog onClose={vi.fn()} />)
    chooseFile('sample.apkg')
    fireEvent.click(await screen.findByRole('button', { name: 'Import package' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Write failed')
    expect(screen.getByRole('dialog', { name: 'Import Anki package' })).toBeInTheDocument()
  })
})
