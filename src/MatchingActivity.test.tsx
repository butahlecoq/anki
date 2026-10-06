import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MatchingActivity } from './MatchingActivity'
import type { StudyActivityCandidate, StudyActivityViewProps } from './learning-activities'

vi.mock('./TemplatePreview', () => ({ TemplatePreview: ({ title }: { title: string }) => <div>{title}</div> }))
afterEach(cleanup)

function candidate(id: string, unsupportedReason?: string): StudyActivityCandidate {
  return {
    prompt: {
      card: { id } as StudyActivityCandidate['prompt']['card'],
      note: { fields: { front: `Prompt ${id}` } } as unknown as StudyActivityCandidate['prompt']['note'],
      noteType: {} as StudyActivityCandidate['prompt']['noteType'],
      template: {} as StudyActivityCandidate['prompt']['template'],
      rendering: {} as StudyActivityCandidate['prompt']['rendering'],
      attachments: [],
      mediaBlocked: false,
    },
    ...(unsupportedReason ? { unsupportedReason } : {}),
  }
}

function props(candidates: StudyActivityCandidate[], grade = vi.fn(async () => true)): StudyActivityViewProps {
  return {
    session: {
      prompt: candidates[0].prompt,
      candidates,
      candidatesLoading: false,
      choicesLoading: false,
      minimumCandidateCount: 2,
      busy: false,
      choices: [],
      choicesFor: () => [
        { rating: 1, label: 'Again', interval: '1m' },
        { rating: 2, label: 'Hard', interval: '1d' },
        { rating: 3, label: 'Good', interval: '2d' },
        { rating: 4, label: 'Easy', interval: '4d' },
      ],
      grade,
      announceAnswer: vi.fn(),
      cardSurface: { current: null },
    },
  }
}

test('explains exclusions and minimum pairs before starting', () => {
  render(<MatchingActivity {...props([candidate('one'), candidate('three', 'Image occlusion is unsupported.')])} />)

  expect(screen.getByText('1 compatible pair · 1 excluded')).toBeVisible()
  expect(screen.getByText('1: Image occlusion is unsupported.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Start matching' })).toBeDisabled()
})

test('match feedback does not choose a grade and each matched card is graded separately', async () => {
  const grade = vi.fn(async () => true)
  render(<MatchingActivity {...props([candidate('one'), candidate('two')], grade)} />)

  fireEvent.click(screen.getByRole('button', { name: 'Start matching' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose prompt 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose answer 2' }))
  expect(screen.getByText('That answer does not match. Try another answer.')).toBeVisible()
  expect(grade).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Choose answer 1' }))
  expect(screen.getByText('Correct match for Prompt 1 · Prompt one. Choose a review grade.')).toBeVisible()
  expect(grade).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: /Good/ }))
  await waitFor(() => expect(grade).toHaveBeenCalledWith('one', 3))
  expect(screen.getByText('1 pairs remaining. Select a prompt, then its answer.')).toBeVisible()
})
