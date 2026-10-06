import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ActivitySelection } from './ActivitySelection'
import { DEFAULT_LEARNING_ACTIVITY_ID, learningActivities } from './learning-activities'

afterEach(cleanup)

test('lists built-in activities and starts the selected activity', () => {
  const onSelect = vi.fn()
  const onBack = vi.fn()
  render(<ActivitySelection onSelect={onSelect} onBack={onBack} />)

  expect(screen.getByRole('heading', { name: 'Choose how to study' })).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Review cards' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Start Review cards' }))
  expect(onSelect).toHaveBeenCalledOnce()
  expect(onSelect).toHaveBeenCalledWith(DEFAULT_LEARNING_ACTIVITY_ID)

  fireEvent.click(screen.getByRole('button', { name: '← Back' }))
  expect(onBack).toHaveBeenCalledOnce()
  expect(new Set(learningActivities.map((activity) => activity.id)).size).toBe(learningActivities.length)
})
