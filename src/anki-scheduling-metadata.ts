import type { CardRecord, ReviewEntry } from './collection'
import type { CardRow } from 'ankipack'

export function nativeScheduleFingerprint(card: CardRow) {
  const { type, queue, due, ivl, factor, reps, lapses, left } = card
  return JSON.stringify({ type, queue, due, ivl, factor, reps, lapses, left })
}

export function readKirokuReview(data: string, id: number): Partial<ReviewEntry> {
  let parsed: { kirokuReviews?: Record<string, Record<string, unknown>> }
  try { parsed = JSON.parse(data || '{}') } catch { return {} }
  const value = parsed.kirokuReviews?.[id]
  if (!value) return {}
  const result: Partial<ReviewEntry> = {}
  for (const key of ['rating', 'state', 'stability', 'difficulty', 'elapsedDays', 'lastElapsedDays', 'scheduledDays', 'learningSteps', 'durationMs'] as const) {
    const field = value[key]
    if (key === 'durationMs' && field === undefined) continue
    if (typeof field !== 'number' || !Number.isFinite(field) || field < 0 || (key === 'rating' && (field < 1 || field > 4)) || (key === 'state' && field > 3)) throw new Error(`Invalid review ${key}`)
    Object.assign(result, { [key]: field })
  }
  for (const key of ['due', 'reviewedAt'] as const) {
    const field = value[key]
    if (typeof field !== 'string' || !Number.isFinite(Date.parse(field))) throw new Error(`Invalid review ${key}`)
    result[key] = new Date(field).toISOString()
  }
  return result
}

export function readKirokuSchedule(card: CardRow): Partial<CardRecord> {
  let parsed: unknown
  try { parsed = JSON.parse(card.data || '{}') } catch { return {} }
  if (!parsed || typeof parsed !== 'object' || !('kiroku' in parsed)) return {}
  const value = parsed.kiroku
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) throw new Error('Unsupported Kiroku scheduling metadata')
  // A later edit by native Anki takes precedence over stale supplementary data.
  if (!('native' in value) || value.native !== nativeScheduleFingerprint(card)) return {}
  const result: Partial<CardRecord> = {}
  for (const key of ['stability', 'difficulty', 'elapsedDays', 'scheduledDays', 'learningSteps', 'reps', 'lapses', 'state'] as const) {
    const field = (value as Record<string, unknown>)[key]
    if (typeof field !== 'number' || !Number.isFinite(field) || field < 0 || (key === 'state' && field > 3)) throw new Error(`Invalid scheduling ${key}`)
    result[key] = field
  }
  for (const key of ['due', 'lastReview', 'buriedUntil'] as const) {
    const field = (value as Record<string, unknown>)[key]
    if (field === undefined && key === 'buriedUntil') continue
    if (field === null && key !== 'due') result[key] = null
    else if (typeof field === 'string' && Number.isFinite(Date.parse(field))) result[key] = new Date(field).toISOString()
    else throw new Error(`Invalid scheduling ${key}`)
  }
  for (const key of ['manualSuspended', 'templateSuspended'] as const) {
    const field = (value as Record<string, unknown>)[key]
    if (field === undefined) continue
    if (typeof field !== 'boolean') throw new Error(`Invalid scheduling ${key}`)
    result[key] = field
  }
  return result
}
