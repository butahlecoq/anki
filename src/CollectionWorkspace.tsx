import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Rating,
  collection,
  type BasicNoteFields,
  type Deck,
  type DeckCounts,
  type DeckSummary,
  type Grade,
  type Note,
} from './collection'
import { pairCollection, syncCollection } from './sync-client'

type Route =
  | { view: 'decks' }
  | { view: 'deck'; deckId: string }
  | { view: 'review'; deckId: string }

function routeFromHash(): Route {
  const match = window.location.hash.match(/^#(deck|review)\/([^/]+)$/)
  if (!match) return { view: 'decks' }
  return { view: match[1] as 'deck' | 'review', deckId: decodeURIComponent(match[2]) }
}

function useRoute() {
  const [route, setRoute] = useState<Route>(routeFromHash)

  useEffect(() => {
    const update = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  const navigate = (next: Route) => {
    const hash = next.view === 'decks' ? '#decks' : `#${next.view}/${encodeURIComponent(next.deckId)}`
    if (window.location.hash === hash) setRoute(next)
    else window.location.hash = hash
  }

  return [route, navigate] as const
}

function CountStrip({ counts, reviews }: { counts: DeckCounts; reviews: number }) {
  return (
    <div className="count-strip" aria-label="Deck counts">
      <span>NEW <strong>{counts.new}</strong></span>
      <span>LEARNING <strong>{counts.learning}</strong></span>
      <span>REVIEW <strong>{counts.review}</strong></span>
      <span>REVIEWS <strong>{reviews}</strong></span>
    </div>
  )
}

function DeckDialog({ deck, onClose }: { deck?: Deck; onClose: () => void }) {
  const [name, setName] = useState(deck?.name ?? '')
  const [error, setError] = useState('')
  const title = deck ? 'Rename deck' : 'Create a deck'

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      if (deck) await collection.renameDeck(deck.id, name)
      else await collection.createDeck(name)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save deck')
    }
  }

  return (
    <div className="dialog-backdrop">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="deck-dialog-title">
        <span className="section-code">DECK // {deck ? 'EDIT' : 'NEW'}</span>
        <h2 id="deck-dialog-title">{title}</h2>
        <form onSubmit={submit}>
          <label>
            Deck name
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="text-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-action" type="submit">{deck ? 'Save name' : 'Create deck'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function NoteDialog({ deckId, note, onClose }: { deckId: string; note?: Note; onClose: () => void }) {
  const [fields, setFields] = useState<BasicNoteFields>(note?.fields ?? { front: '', back: '' })
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      if (note) await collection.updateBasicNote(note.id, fields)
      else await collection.createBasicNote(deckId, fields)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save note')
    }
  }

  return (
    <div className="dialog-backdrop">
      <section className="dialog note-dialog" role="dialog" aria-modal="true" aria-labelledby="note-dialog-title">
        <span className="section-code">BASIC // {note ? 'EDIT' : 'NEW'}</span>
        <h2 id="note-dialog-title">{note ? 'Edit Basic note' : 'Add a Basic note'}</h2>
        <form onSubmit={submit}>
          <label>
            Front
            <textarea autoFocus lang="ja" value={fields.front} onChange={(event) => setFields({ ...fields, front: event.target.value })} rows={3} />
          </label>
          <label>
            Back
            <textarea lang="ja" value={fields.back} onChange={(event) => setFields({ ...fields, back: event.target.value })} rows={4} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="text-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-action" type="submit">{note ? 'Save changes' : 'Save note'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function SyncControls() {
  const settings = useLiveQuery(() => collection.syncSettings(), [], undefined)
  const [pairing, setPairing] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('This collection stays on this device until you connect a PC.')
  const [busy, setBusy] = useState(false)

  async function pair(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    const result = await pairCollection(collection, endpoint, code)
    setBusy(false)
    if (result.state === 'paired') {
      setPairing(false)
      setCode('')
      setMessage('PC connected. Your collections are ready to sync.')
    } else if (result.state === 'unreachable') setMessage('Your PC service could not be reached. Check its address and that it is running.')
    else setMessage('That pairing code was not accepted. Create a new code on your PC and try again.')
  }

  async function sync() {
    if (!settings) {
      setPairing(true)
      return
    }
    setBusy(true)
    setMessage('Syncing your collection…')
    const result = await syncCollection(collection)
    setBusy(false)
    if (result.state === 'complete') setMessage(`Sync complete. ${result.accepted} local change${result.accepted === 1 ? '' : 's'} sent.`)
    else if (result.state === 'authentication-required') setMessage('This device needs to be paired again before it can sync.')
    else setMessage('Your PC service could not be reached. Your changes remain on this device and will retry next time.')
  }

  return (
    <section className="sync-controls" aria-label="PC sync">
      <div><span className="section-code">SYNC // {settings ? 'PAIRED' : 'LOCAL ONLY'}</span><p aria-live="polite">{message}</p></div>
      <div className="sync-actions">
        {settings && <button className="text-button" type="button" disabled={busy} onClick={() => void sync()}>{busy ? 'Syncing…' : 'Sync now'}</button>}
        <button className="primary-action" type="button" disabled={busy} onClick={() => setPairing(true)}>{settings ? 'Pair another device' : 'Connect a PC'}</button>
      </div>
      {pairing && (
        <div className="dialog-backdrop">
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title">
            <span className="section-code">SYNC // PAIR DEVICE</span>
            <h2 id="sync-dialog-title">Connect to your PC</h2>
            <form onSubmit={pair}>
              <label>
                PC service address
                <input autoFocus inputMode="url" placeholder="http://192.168.1.20:4174" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required />
              </label>
              <label>
                One-time pairing code
                <input autoCapitalize="characters" value={code} onChange={(event) => setCode(event.target.value)} required />
              </label>
              <p className="sync-help">On the PC, run <code>npm run server:pair</code> to create a one-time code.</p>
              <div className="dialog-actions">
                <button className="text-button" type="button" disabled={busy} onClick={() => setPairing(false)}>Cancel</button>
                <button className="primary-action" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect device'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  )
}

function EmptyCollection({ onNewDeck }: { onNewDeck: () => void }) {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="section-code">01 // HOME</div>
          <h1>Your Japanese <br /><em>study system</em></h1>
          <p>A calm, local-first workspace for deliberate practice. Your collection lives on your device—not behind a subscription.</p>
        </div>
        <div className="kana-field" aria-hidden="true">
          <span>あ</span><span>記</span><span>学</span>
          <div className="orbit one" /><div className="orbit two" />
        </div>
      </section>
      <section className="workspace-grid single">
        <article className="empty-panel">
          <div className="panel-heading">
            <div><span className="section-code">DECKS // 00</span><h2>Start with one deck</h2></div>
            <span className="keycap">N</span>
          </div>
          <div className="empty-card">
            <span className="empty-glyph" lang="ja">一</span>
            <div><h3>Your collection is clear.</h3><p>Create a focused deck, add a Japanese card, and begin your first offline review.</p></div>
            <button className="primary-action" type="button" onClick={onNewDeck}>New deck</button>
            <small>Your decks and reviews stay in this browser.</small>
          </div>
        </article>
      </section>
    </>
  )
}

function DeckList({ decks, onNewDeck, onOpen }: { decks: DeckSummary[]; onNewDeck: () => void; onOpen: (id: string) => void }) {
  return (
    <>
      <section className="compact-hero">
        <div><span className="section-code">01 // COLLECTION</span><h1>Choose what to <em>remember</em></h1><p>Everything here is stored locally and ready whenever you are.</p></div>
        <button className="primary-action" type="button" onClick={onNewDeck}>New deck</button>
      </section>
      <section className="deck-grid" aria-label="Decks">
        {decks.map((deck) => (
          <article className="deck-tile" key={deck.id}>
            <span className="deck-index">DECK // {String(deck.noteCount).padStart(2, '0')} NOTES</span>
            <h2>{deck.name}</h2>
            <CountStrip counts={deck.counts} reviews={deck.reviewCount} />
            <button className="tile-action" type="button" aria-label={`Open ${deck.name}`} onClick={() => onOpen(deck.id)}>Open deck <span>→</span></button>
          </article>
        ))}
      </section>
    </>
  )
}

function DeckDetail({ deckId, onBack, onStudy }: { deckId: string; onBack: () => void; onStudy: () => void }) {
  const deck = useLiveQuery(() => collection.decks.get(deckId), [deckId])
  const notes = useLiveQuery(() => collection.notes.where('deckId').equals(deckId).sortBy('createdAt'), [deckId], [])
  const summary = useLiveQuery(async () => (await collection.summaries()).find((item) => item.id === deckId), [deckId])
  const [deckDialog, setDeckDialog] = useState(false)
  const [noteDialog, setNoteDialog] = useState<{ note?: Note } | null>(null)

  if (deck === undefined || summary === undefined) return <div className="loading-state" role="status">Loading local deck…</div>
  if (!deck || !summary) return <div className="loading-state"><h1>Deck not found</h1><button className="text-button" onClick={onBack}>Back to decks</button></div>

  const hasDueCards = summary.counts.new + summary.counts.review > 0

  async function removeDeck() {
    if (!window.confirm(`Delete “${deck?.name}” and its cards?`)) return
    await collection.deleteDeck(deckId)
    onBack()
  }

  return (
    <>
      <section className="deck-detail-header">
        <button className="text-button back-button" type="button" onClick={onBack}>← All decks</button>
        <span className="section-code">DECK // LOCAL</span>
        <h1>{deck.name}</h1>
        <CountStrip counts={summary.counts} reviews={summary.reviewCount} />
        <div className="deck-actions">
          <button className="primary-action" type="button" onClick={() => setNoteDialog({})}>Add note</button>
          <button className="primary-action study-action" type="button" disabled={!hasDueCards} onClick={onStudy}>Study now</button>
          <button className="text-button" type="button" onClick={() => setDeckDialog(true)}>Rename deck</button>
          <button className="text-button danger" type="button" onClick={removeDeck}>Delete deck</button>
        </div>
      </section>
      <section className="note-list" aria-label="Notes">
        <div className="panel-heading"><div><span className="section-code">NOTES // {String(notes.length).padStart(2, '0')}</span><h2>Basic notes</h2></div></div>
        {notes.length === 0 ? (
          <div className="note-empty"><span lang="ja">書</span><p>Add a front and back to generate your first card.</p></div>
        ) : notes.map((note) => (
          <article className="note-row" key={note.id}>
            <div><span>FRONT</span><strong lang="ja">{note.fields.front}</strong></div>
            <div><span>BACK</span><p lang="ja">{note.fields.back}</p></div>
            <button className="text-button" type="button" onClick={() => setNoteDialog({ note })}>Edit note</button>
          </article>
        ))}
      </section>
      {deckDialog && <DeckDialog deck={deck} onClose={() => setDeckDialog(false)} />}
      {noteDialog && <NoteDialog deckId={deckId} note={noteDialog.note} onClose={() => setNoteDialog(null)} />}
    </>
  )
}

function ReviewSession({ deckId, onBack }: { deckId: string; onBack: () => void }) {
  const [queue, setQueue] = useState<string[] | null>(null)
  const [showAnswer, setShowAnswer] = useState(false)
  const [reviewsRecorded, setReviewsRecorded] = useState(0)
  const [isAnswering, setIsAnswering] = useState(false)
  const cardId = queue?.[0]
  const card = useLiveQuery(() => cardId ? collection.cards.get(cardId) : undefined, [cardId])
  const note = useLiveQuery(() => card ? collection.notes.get(card.noteId) : undefined, [card?.noteId])
  const choices = useLiveQuery(() => cardId ? collection.reviewChoices(cardId, new Date()) : [], [cardId], [])

  useEffect(() => {
    collection.dueCards(deckId, new Date()).then((cards) => setQueue(cards.map((card) => card.id)))
  }, [deckId])

  async function answer(rating: Grade) {
    if (!cardId || isAnswering) return
    setIsAnswering(true)
    try {
      await collection.answer(cardId, rating, new Date())
      setReviewsRecorded((count) => count + 1)
      setShowAnswer(false)
      setQueue((current) => current?.slice(1) ?? [])
    } finally {
      setIsAnswering(false)
    }
  }

  if (queue === null || (cardId && (!card || !note))) return <div className="loading-state" role="status">Preparing review…</div>

  if (!cardId || !card || !note) {
    return (
      <section className="session-complete">
        <span className="completion-mark">✓</span>
        <span className="section-code">SESSION // COMPLETE</span>
        <h1>Session complete</h1>
        <p>{reviewsRecorded} {reviewsRecorded === 1 ? 'review' : 'reviews'} recorded</p>
        <button className="primary-action" type="button" onClick={onBack}>Back to deck</button>
      </section>
    )
  }

  return (
    <section className="review-session">
      <div className="review-progress"><span>REVIEW // {String(reviewsRecorded + 1).padStart(2, '0')}</span><button className="text-button" onClick={onBack}>End session</button></div>
      <article className="review-card">
        <span className="card-side">{showAnswer ? 'ANSWER' : 'QUESTION'}</span>
        <h1 lang="ja">{note.fields.front}</h1>
        {showAnswer && <div className="review-answer" lang="ja">{note.fields.back}</div>}
      </article>
      {!showAnswer ? (
        <button className="primary-action reveal-action" type="button" onClick={() => setShowAnswer(true)}>Show answer</button>
      ) : (
        <div className="rating-grid" aria-label="Rate answer">
          {choices.map((choice) => (
            <button aria-label={`${choice.label} · ${choice.interval}`} className={`rating rating-${Rating[choice.rating].toLowerCase()}`} type="button" disabled={isAnswering} key={choice.rating} onClick={() => void answer(choice.rating)}>
              <strong>{choice.label}</strong><span aria-hidden="true">·</span><small>{choice.interval}</small>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

export function CollectionWorkspace() {
  const [route, navigate] = useRoute()
  const decks = useLiveQuery(() => collection.summaries(), [], [])
  const [newDeck, setNewDeck] = useState(false)

  const content = useMemo(() => {
    if (route.view === 'review') return <ReviewSession deckId={route.deckId} onBack={() => navigate({ view: 'deck', deckId: route.deckId })} />
    if (route.view === 'deck') return <DeckDetail deckId={route.deckId} onBack={() => navigate({ view: 'decks' })} onStudy={() => navigate({ view: 'review', deckId: route.deckId })} />
    if (decks.length === 0) return <EmptyCollection onNewDeck={() => setNewDeck(true)} />
    return <DeckList decks={decks} onNewDeck={() => setNewDeck(true)} onOpen={(deckId) => navigate({ view: 'deck', deckId })} />
  }, [decks, navigate, route])

  return (
    <>
      <SyncControls />
      {content}
      {newDeck && <DeckDialog onClose={() => setNewDeck(false)} />}
    </>
  )
}
