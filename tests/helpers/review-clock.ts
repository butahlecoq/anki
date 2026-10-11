import { cleanup } from '@testing-library/react'
import { vi } from 'vitest'

export async function atReviewNoon(body: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Immediate learning repeats are eligible well before the next 4 a.m. cutoff.
  vi.setSystemTime(new Date(2026, 9, 11, 12))
  try {
    await body()
  } finally {
    cleanup()
    vi.useRealTimers()
  }
}
