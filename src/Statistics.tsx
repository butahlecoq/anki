import { useEffect, useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { collection, Rating, State, type CardRecord } from './collection'
import { localDayKey, periodWindow, reviewHeatmap, reviewStatistics, schedulingStatistics, type StatisticsPeriod } from './progress-statistics'

function useStatisticsClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const update = () => setNow(new Date())
    const timer = window.setInterval(update, 30_000)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update) }
  }, [])
  return now
}

export function TodayWorkload({ deckId = '', showLink = true }: { deckId?: string; showLink?: boolean }) {
  const now = useStatisticsClock()
  const data = useLiveQuery(async () => {
    const decks = await collection.decks.toArray()
    const targets = deckId ? decks.filter((deck) => deck.id === deckId) : decks.filter((deck) => !deck.parentId)
    const cards = (await Promise.all(targets.map((deck) => collection.reviewQueue(deck.id, now)))).flat()
    const included = new Set(targets.map((deck) => deck.id))
    for (let changed = true; changed;) {
      changed = false
      for (const deck of decks) if (deck.parentId && included.has(deck.parentId) && !included.has(deck.id)) { included.add(deck.id); changed = true }
    }
    const today = reviewStatistics((await collection.reviewEntries.toArray()).filter((entry) => !deckId || included.has(entry.deckId)), 'day', now)
    return { cards, today }
  }, [now.getTime(), deckId])
  return <section className="today-workload" aria-label="Today's workload">
    <span className="section-code">TODAY // READY TO STUDY</span>
    <div className="count-strip"><span>NEW <strong>{data?.cards.filter((card) => card.state === State.New).length ?? '…'}</strong></span><span>LEARNING <strong>{data?.cards.filter((card) => card.state === State.Learning || card.state === State.Relearning).length ?? '…'}</strong></span><span>REVIEW <strong>{data?.cards.filter((card) => card.state === State.Review).length ?? '…'}</strong></span><span>STUDIED <strong>{data?.today.count ?? '…'}</strong></span></div>
    <small>Available now, after daily limits and burial. Studied counts answers, including repeated learning steps.</small>
    {showLink && <a className="text-button" href="#statistics">View progress →</a>}
  </section>
}

function Bars({ values }: { values: { label: string; count: number }[] }) {
  const max = Math.max(1, ...values.map((value) => value.count))
  return <ul className="stat-bars">{values.map((value) => <li key={value.label}><span>{value.label}</span><div><span style={{ width: `${value.count / max * 100}%` }} /></div><strong>{value.count}</strong></li>)}</ul>
}

export function CardHistory({ card }: { card: CardRecord }) {
  const [visible, setVisible] = useState(30)
  const entries = useLiveQuery(() => collection.reviewEntries.where('cardId').equals(card.id).toArray(), [card.id], [])
  const reviews = reviewStatistics(entries, 'all', new Date()).reviews
  return <section className="card-history" aria-label="Card review history">
    <dl className="review-card-info"><div><dt>State</dt><dd>{State[card.state]}</dd></div><div><dt>Interval</dt><dd>{card.scheduledDays} days</dd></div><div><dt>Difficulty</dt><dd>{card.reps ? card.difficulty.toFixed(2) : 'Not yet measured'}</dd></div><div><dt>Stability</dt><dd>{card.reps ? `${card.stability.toFixed(2)} days` : 'Not yet measured'}</dd></div></dl>
    <h3>Review history</h3>{reviews.length ? <><ol className="history-list">{reviews.slice(0, visible).map((entry) => <li key={entry.id}><time dateTime={entry.reviewedAt}>{new Date(entry.reviewedAt).toLocaleString()}</time><span>{entry.rescheduled === false ? 'Practice · ' : ''}{Rating[entry.rating]} · {State[entry.state]} · interval {entry.scheduledDays} days{entry.durationMs !== undefined ? ` · ${(entry.durationMs / 1000).toFixed(1)}s` : ''}</span></li>)}</ol>{reviews.length > visible && <button className="text-button" type="button" onClick={() => setVisible((count) => count + 30)}>Show more reviews</button>}</> : <p>No reviews yet. Your first answer will start this history.</p>}
  </section>
}

export function Statistics() {
  const now = useStatisticsClock()
  const [period, setPeriod] = useState<StatisticsPeriod>('week')
  const [anchorKey, setAnchorKey] = useState('')
  const [deckId, setDeckId] = useState('')
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const anchor = anchorKey ? new Date(`${anchorKey}T12:00:00`) : now
  const data = useLiveQuery(async () => {
    return collection.transaction('r', collection.decks, collection.cards, collection.notes, collection.reviewEntries, async () => ({
      decks: await collection.decks.toArray(), cards: await collection.cards.toArray(), notes: await collection.notes.toArray(), reviews: await collection.reviewEntries.toArray(),
    }))
  }, [])
  if (!data) return <p role="status">Loading progress…</p>
  const deckIds = new Set([deckId])
  if (deckId) for (let changed = true; changed;) {
    changed = false
    for (const deck of data.decks) if (deck.parentId && deckIds.has(deck.parentId) && !deckIds.has(deck.id)) { deckIds.add(deck.id); changed = true }
  }
  const cards = data.cards.filter((card) => !deckId || deckIds.has(card.deckId))
  const entries = data.reviews.filter((entry) => !deckId || deckIds.has(entry.deckId))
  const stats = reviewStatistics(entries, period, anchor)
  const scheduling = schedulingStatistics(cards, now)
  const heatmap = reviewHeatmap(entries, now)
  const { start, end } = periodWindow(period, anchor)
  const card = data.cards.find((item) => item.id === selectedCard)
  const notes = new Map(data.notes.map((note) => [note.id, note]))
  const cardsById = new Map(data.cards.map((item) => [item.id, item]))
  const reviewedCards = [...new Set(stats.reviews.map((entry) => entry.cardId))]
  return <div className="statistics-workspace">
    <section className="compact-hero"><div><span className="section-code">04 // PROGRESS</span><h1>Every answer <em>adds up</em></h1><p>Your real study history, available offline.</p></div></section>
    <TodayWorkload deckId={deckId} showLink={false} />
    <div className="statistics-controls"><label>Statistics deck<select aria-label="Statistics deck" value={deckId} onChange={(event) => { setDeckId(event.target.value); setSelectedCard(null) }}><option value="">All decks</option>{data.decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name} (with children)</option>)}</select></label><label>Period<select aria-label="Period" value={period} onChange={(event) => setPeriod(event.target.value as StatisticsPeriod)}><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="all">All time</option></select></label><label>Date<input type="date" disabled={period === 'all'} value={localDayKey(anchor)} onChange={(event) => setAnchorKey(event.target.value)} /></label><button className="text-button" type="button" onClick={() => setAnchorKey('')}>Today</button></div>
    <p className="statistics-period">{period === 'all' ? 'All recorded history' : `${new Date(start).toLocaleDateString()} – ${new Date(end - 1).toLocaleDateString()}`} · Local midnight starts each study day. Weeks start Monday.</p>
    <section className="statistics-metrics" aria-label="Period totals">
      <article><span>ANSWERS</span><strong>{stats.count}</strong><small>{stats.cards} distinct cards</small></article>
      <article><span>REVIEW TIME</span><strong>{stats.timedCount ? `${(stats.durationMs / 60_000).toFixed(1)} min` : '—'}</strong><small>{stats.timedCount ? `Measured for ${stats.timedCount} of ${stats.count} answers` : 'No timed answers in this period'}</small></article>
      <article><span>RECALL</span><strong>{stats.retention === null ? '—' : `${Math.round(stats.retention * 100)}%`}</strong><small>{stats.retentionCount} review-state answers; Again counts as forgotten</small></article>
      <article><span>FSRS DIFFICULTY</span><strong>{scheduling.difficulty?.toFixed(2) ?? '—'}</strong><small>Current active scheduled cards · scale 1–10</small></article>
    </section>
    {!stats.count && <p className="statistics-empty">No answers in this period. Study a card or choose another date to see your progress.</p>}
    <section className="statistics-panel" aria-label="Study heatmap"><h2>84 days of practice</h2><p>Select a day to see its answers and cards.</p><div className="review-heatmap">{heatmap.map((day) => <button type="button" key={day.key} aria-label={`${day.key}: ${day.count} answers`} aria-pressed={period === 'day' && localDayKey(anchor) === day.key} title={`${day.key}: ${day.count} answers`} style={{ '--activity': day.count ? Math.min(1, .25 + day.count / 20) : 0 } as CSSProperties} onClick={() => { setPeriod('day'); setAnchorKey(day.key) }} />)}</div><small>Less <span className="heatmap-legend">░ ▒ ▓ █</span> More · last 84 local calendar days</small></section>
    <div className="statistics-grid"><section className="statistics-panel"><h2>Answer distribution</h2><Bars values={stats.ratings.map((item) => ({ label: Rating[item.rating], count: item.count }))} /></section><section className="statistics-panel"><h2>Current intervals</h2><Bars values={scheduling.intervals} /><p>Active scheduled cards; new and suspended cards are excluded.</p></section></div>
    <section className="statistics-panel"><h2>30-day forecast</h2><p>Current due dates, including overdue cards today. Daily limits, new introductions, and future answers can change the workload.</p><div className="forecast-scroll"><Bars values={scheduling.forecast.map((day) => ({ label: day.key, count: day.count }))} /></div></section>
    <section className="statistics-panel"><h2>Cards studied in this period</h2>{reviewedCards.length ? <ul className="studied-cards">{reviewedCards.map((id) => { const current = cardsById.get(id); const note = current && notes.get(current.noteId); return <li key={id}>{current ? <button className="text-button" type="button" onClick={() => setSelectedCard(id)}>{Object.values(note?.fields ?? {}).find(Boolean)?.replace(/<[^>]*>/g, '').slice(0, 100) || 'Card'} · {current.templateId}</button> : <span>Removed card</span>}</li> })}</ul> : <p>Your reviewed cards will appear here.</p>}</section>
    {card && <div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="statistics-card-title"><h2 id="statistics-card-title">Card progress</h2><p>Due {new Date(card.due).toLocaleString()} · {card.reps} answers · {card.lapses} lapses{card.manualSuspended || card.suspended || card.templateSuspended ? ' · Suspended' : ''}</p><CardHistory card={card} /><button className="primary-action" type="button" onClick={() => setSelectedCard(null)}>Close</button></section></div>}
  </div>
}

