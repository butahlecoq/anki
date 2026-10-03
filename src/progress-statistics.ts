import { Rating, State, type CardRecord, type ReviewEntry } from './collection'
import { isSuspended } from './scheduler'

export type StatisticsPeriod = 'day' | 'week' | 'month' | 'all'

export function localDayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function periodWindow(period: StatisticsPeriod, anchor: Date) {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
  const end = new Date(start)
  if (period === 'week') {
    start.setDate(start.getDate() - (start.getDay() + 6) % 7)
    end.setTime(start.getTime()); end.setDate(end.getDate() + 7)
  } else if (period === 'month') {
    start.setDate(1); end.setTime(start.getTime()); end.setMonth(end.getMonth() + 1)
  } else end.setDate(end.getDate() + 1)
  return { start: period === 'all' ? -Infinity : start.getTime(), end: period === 'all' ? Infinity : end.getTime() }
}

export function reviewStatistics(entries: ReviewEntry[], period: StatisticsPeriod, anchor: Date) {
  const { start, end } = periodWindow(period, anchor)
  // Review IDs are the durable identity also used by IndexedDB and sync.
  const reviews = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
    .filter((entry) => { const time = Date.parse(entry.reviewedAt); return Number.isFinite(time) && time >= start && time < end })
    .sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt) || a.id.localeCompare(b.id))
  const timed = reviews.filter((entry) => Number.isFinite(entry.durationMs) && entry.durationMs! >= 0)
  const recall = reviews.filter((entry) => (entry.afterState ?? entry.state) === State.Review && entry.rescheduled !== false)
  return {
    reviews, count: reviews.length, cards: new Set(reviews.map((entry) => entry.cardId)).size,
    durationMs: timed.reduce((sum, entry) => sum + entry.durationMs!, 0), timedCount: timed.length,
    retention: recall.length ? recall.filter((entry) => entry.rating !== Rating.Again).length / recall.length : null,
    retentionCount: recall.length,
    ratings: [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].map((rating) => ({ rating, count: reviews.filter((entry) => entry.rating === rating).length })),
  }
}

export function reviewHeatmap(entries: ReviewEntry[], now: Date, days = 84) {
  const counts = new Map<string, number>()
  for (const entry of new Map(entries.map((item) => [item.id, item])).values()) {
    const date = new Date(entry.reviewedAt)
    if (!Number.isFinite(date.getTime())) continue
    const key = localDayKey(date)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + index + 1)
    const key = localDayKey(date)
    return { date, key, count: counts.get(key) ?? 0 }
  })
}

export function schedulingStatistics(cards: CardRecord[], now: Date) {
  const scheduled = cards.filter((card) => card.state !== State.New && !isSuspended(card))
  const forecast = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index)
    const end = new Date(date); end.setDate(end.getDate() + 1)
    return { key: localDayKey(date), count: scheduled.filter((card) => {
      const due = Math.max(Date.parse(card.due), card.buriedUntil ? Date.parse(card.buriedUntil) : -Infinity)
      return Number.isFinite(due) && due < end.getTime() && (index === 0 || due >= date.getTime())
    }).length }
  })
  const intervals = [
    { label: '< 1 day', count: scheduled.filter((card) => card.scheduledDays < 1).length },
    { label: '1–6 days', count: scheduled.filter((card) => card.scheduledDays >= 1 && card.scheduledDays < 7).length },
    { label: '7–29 days', count: scheduled.filter((card) => card.scheduledDays >= 7 && card.scheduledDays < 30).length },
    { label: '30+ days', count: scheduled.filter((card) => card.scheduledDays >= 30).length },
  ]
  const rated = scheduled.filter((card) => card.reps > 0 && Number.isFinite(card.difficulty) && card.difficulty >= 1 && card.difficulty <= 10)
  return { forecast, intervals, difficulty: rated.length ? rated.reduce((sum, card) => sum + card.difficulty, 0) / rated.length : null }
}
