import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { describeCardMedia } from './card-rendering'
import { MediaRenderer } from './MediaRenderer'
import type { NoteMediaReference } from './collection'

afterEach(cleanup)

const reference: NoteMediaReference = {
  id: 'media:cat-audio', noteId: 'note:cat', digest: 'a'.repeat(64), kind: 'audio', mimeType: 'audio/wav',
  displayName: 'cat.wav', side: 'front', playback: 'automatic', createdAt: '', updatedAt: '',
}

test('renders the exported media description with the prepared source and playback policy', () => {
  const description = describeCardMedia(reference, '/media/cat.wav')
  const { container } = render(<MediaRenderer description={description} />)
  const audio = container.querySelector('audio')

  expect(audio).toHaveAttribute('src', '/media/cat.wav')
  expect(audio).toHaveAttribute('autoplay')
  expect(screen.getByText('Audio: cat.wav')).toBeInTheDocument()
})

test('manual audio waits for the learner rather than playing on its own', () => {
  const { container } = render(<MediaRenderer description={describeCardMedia({ ...reference, playback: 'manual' }, '/media/cat.wav')} />)
  expect(container.querySelector('audio')).not.toHaveAttribute('autoplay')
})

test('reports a missing source from the exported media description', () => {
  render(<MediaRenderer description={describeCardMedia(reference)} />)
  expect(screen.getByRole('status')).toHaveTextContent(/cat\.wav will be available/i)
})
