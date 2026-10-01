import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Rating,
  BASIC_NOTE_TYPE_ID,
  IMAGE_OCCLUSION_NOTE_TYPE_ID,
  collection,
  tryRenderNoteTemplate,
  type Deck,
  type DeckCounts,
  type DeckSummary,
  type Grade,
  type Note,
  type NoteMediaReference,
} from './collection'
import { MediaRenderer } from './MediaRenderer'
import { ImageOcclusionEditor, ImageOcclusionReview } from './ImageOcclusion'
import { NoteTypeManager } from './NoteTypeManager'
import { TemplatePreview } from './TemplatePreview'
import { validateMedia } from './media'
import { pairCollection, syncCollection } from './sync-client'
import { clozeOrdinals } from './template-renderer'
import { compareTypedAnswer } from './typed-answer'

type Route =
  | { view: 'decks' }
  | { view: 'note-types' }
  | { view: 'deck'; deckId: string }
  | { view: 'review'; deckId: string }

function routeFromHash(): Route {
  if (window.location.hash === '#note-types') return { view: 'note-types' }
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
    const hash = next.view === 'decks' ? '#decks' : next.view === 'note-types' ? '#note-types' : `#${next.view}/${encodeURIComponent(next.deckId)}`
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

type PendingAttachment = { file: File; side: 'front' | 'back'; playback: 'automatic' | 'manual' }

function NoteDialog({ deckId, note, onClose }: { deckId: string; note?: Note; onClose: () => void }) {
  const noteTypes = useLiveQuery(() => collection.noteTypes.orderBy('name').toArray(), [], [])
  const [typeId, setTypeId] = useState(note?.typeId ?? BASIC_NOTE_TYPE_ID)
  const [imageEditor, setImageEditor] = useState(note?.typeId === IMAGE_OCCLUSION_NOTE_TYPE_ID)
  const noteType = noteTypes.find((type) => type.id === typeId)
  const [fields, setFields] = useState<Record<string, string>>(note?.fields ?? {})
  const [error, setError] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const textareas = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const existingMedia = useLiveQuery(() => note ? collection.mediaForNote(note.id) : [], [note?.id], [])
  const generation = noteType ? collection.tryCardGenerationStatus(noteType, fields) : undefined
  const clozeEditorField = noteType?.kind === 'cloze' ? noteType.templates[0]?.front.match(/{{\s*cloze:([^{}:]+?)\s*}}/)?.[1].trim() : undefined

  if (imageEditor) return <ImageOcclusionEditor deckId={deckId} note={note} onClose={onClose} />

  function makeCloze(fieldId: string) {
    const textarea = textareas.current[fieldId]
    if (!textarea) return
    const value = fields[fieldId] ?? ''
    const { selectionStart: start, selectionEnd: end } = textarea
    if (start === end) { setError('Select text to make a cloze deletion'); return }
    if (/{{|}}/.test(value.slice(start, end)) || [...value.matchAll(/{{c\d+::[\s\S]*?}}/g)].some((match) => start < match.index + match[0].length && end > match.index)) {
      setError('Select text outside existing deletions'); return
    }
    try {
      const ordinal = Math.max(0, ...clozeOrdinals(value)) + 1
      const replacement = `{{c${ordinal}::${value.slice(start, end)}}}`
      setFields((current) => ({ ...current, [fieldId]: value.slice(0, start) + replacement + value.slice(end) }))
      setError('')
      requestAnimationFrame(() => { textarea.focus(); textarea.setSelectionRange(start, start + replacement.length) })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to make cloze deletion')
    }
  }

  function selectMedia(files: FileList | null) {
    if (!files?.length) return
    try {
      const next = Array.from(files).map((file) => {
        const definition = validateMedia(file)
        return { file, side: 'front' as const, playback: definition.kind === 'audio' ? 'automatic' as const : 'manual' as const }
      })
      setAttachments((current) => [...current, ...next])
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to attach media')
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      if (note) {
        if (typeId === BASIC_NOTE_TYPE_ID) await collection.updateBasicNote(note.id, { front: fields.front ?? '', back: fields.back ?? '' })
        else await collection.updateNote(note.id, fields)
        await Promise.all(attachments.map(({ file, side, playback }) => collection.attachMedia(note.id, { file, side, playback })))
      } else if (typeId === BASIC_NOTE_TYPE_ID) await collection.createBasicNoteWithMedia(deckId, { front: fields.front ?? '', back: fields.back ?? '' }, attachments)
      else await collection.createNote(deckId, typeId, fields)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save note')
    }
  }

  return (
    <div className="dialog-backdrop">
      <section className="dialog note-dialog" role="dialog" aria-modal="true" aria-labelledby="note-dialog-title">
        <span className="section-code">{noteType?.name.toUpperCase() ?? 'NOTE'} // {note ? 'EDIT' : 'NEW'}</span>
        <h2 id="note-dialog-title">{note ? `Edit ${noteType?.name ?? ''} note` : `Add a ${noteType?.name ?? ''} note`}</h2>
        <form onSubmit={submit}>
          <label>Note type
            <select value={typeId} disabled={Boolean(note)} onChange={(event) => { if (event.target.value === IMAGE_OCCLUSION_NOTE_TYPE_ID) { setImageEditor(true); return } setTypeId(event.target.value); setFields({}); setAttachments([]) }}>
              {noteTypes.map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}
            </select>
          </label>
          {noteType?.fields.map((field, index) => <div key={field.id}>
            <label>{typeId === BASIC_NOTE_TYPE_ID ? field.name[0].toUpperCase() + field.name.slice(1) : field.name}
              <textarea ref={(element) => { textareas.current[field.id] = element }} autoFocus={index === 0} lang="ja" value={fields[field.id] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [field.id]: event.target.value }))} rows={index === 0 ? 3 : 4} />
            </label>
            {clozeEditorField === field.name && <button className="text-button" type="button" onClick={() => makeCloze(field.id)}>Make cloze</button>}
          </div>)}
          {noteType?.kind === 'cloze' && <small>Select text and choose Make cloze, or type {'{{c1::answer::optional hint}}'} directly. Each number creates one card.</small>}
          {typeId === BASIC_NOTE_TYPE_ID && <label>
            Images and audio
            <input type="file" multiple accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/ogg,audio/wav" onChange={(event) => selectMedia(event.target.files)} />
            <small>PNG, JPEG, WebP up to 10 MB; MP3, Ogg, WAV up to 20 MB.</small>
          </label>}
          {attachments.map((attachment, index) => (
            <div className="media-attachment" key={`${attachment.file.name}-${index}`}>
              <strong>{attachment.file.name}</strong>
              <label>Show on <select value={attachment.side} onChange={(event) => setAttachments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, side: event.target.value as PendingAttachment['side'] } : item))}><option value="front">front</option><option value="back">back</option></select></label>
              {attachment.file.type.startsWith('audio/') && <label>Play <select value={attachment.playback} onChange={(event) => setAttachments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, playback: event.target.value as PendingAttachment['playback'] } : item))}><option value="automatic">automatically</option><option value="manual">manually</option></select></label>}
              <button className="text-button" type="button" onClick={() => setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index))}>Remove</button>
            </div>
          ))}
          {existingMedia.map((media) => <ExistingMedia key={media.id} media={media} />)}
          {note?.retiredFields && Object.keys(note.retiredFields).length > 0 && <section className="retired-fields" aria-label="Retired fields">
            <h3>Retired fields</h3>
            <p>Saved values from fields that are no longer part of this note type.</p>
            <dl>{Object.entries(note.retiredFields).map(([fieldId, value]) => <div key={fieldId}><dt>Retired field · {fieldId}</dt><dd>{value || '(empty)'}</dd></div>)}</dl>
          </section>}
          {typeId !== BASIC_NOTE_TYPE_ID && generation?.ok && <p className="card-generation-status" aria-live="polite">{generation.value.eligible.length} {generation.value.eligible.length === 1 ? 'card' : 'cards'} will be created.</p>}
          {generation?.ok && generation.value.skipped.map(({ templateId, reason }) => <p className="form-warning" role="status" key={templateId}>{noteType?.templates.find((template) => template.id === templateId)?.name}: {reason}. No card will be created.</p>)}
          {generation && !generation.ok && <p className="form-error" role="alert">{generation.error}</p>}
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

function ExistingMedia({ media }: { media: NoteMediaReference }) {
  const [error, setError] = useState('')
  return <div className="media-attachment"><strong>{media.displayName}</strong><span>{media.side} · {media.kind}</span><button className="text-button" type="button" onClick={() => void collection.removeMedia(media.id).catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to remove media'))}>Remove</button>{error && <p className="form-error" role="alert">{error}</p>}</div>
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
    if (result.state === 'complete') {
      const media = result.media
      const mediaError = media?.uploadError ?? media?.downloadError
      if (mediaError === 'authentication-required') setMessage(`Card sync complete. ${media?.pending ?? 0} media file${media?.pending === 1 ? '' : 's'} still need pairing.`)
      else if (mediaError) setMessage(`Card sync complete. ${media?.pending ?? 0} media file${media?.pending === 1 ? '' : 's'} will retry when the PC is reachable.`)
      else setMessage(`Sync complete. ${result.accepted} local change${result.accepted === 1 ? '' : 's'} sent; ${media?.uploaded ?? 0} uploaded and ${media?.downloaded ?? 0} downloaded.`)
    }
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
                <input autoFocus inputMode="url" placeholder="https://pc.example.net:4174" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required />
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
  const noteTypes = useLiveQuery(() => collection.noteTypes.toArray(), [], [])
  const summary = useLiveQuery(async () => (await collection.summaries()).find((item) => item.id === deckId), [deckId])
  const [deckDialog, setDeckDialog] = useState(false)
  const [noteDialog, setNoteDialog] = useState<{ note?: Note } | null>(null)

  if (deck === undefined || summary === undefined) return <div className="loading-state" role="status">Loading local deck…</div>
  if (!deck || !summary) return <div className="loading-state"><h1>Deck not found</h1><button className="text-button" onClick={onBack}>Back to decks</button></div>

  const hasDueCards = summary.counts.new + summary.counts.review > 0

  async function removeDeck() {
    if (!window.confirm(`Delete “${deck?.name}” and its cards?`)) return
    await collection.deleteDeck(deckId, { mode: 'delete-subtree' })
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
        <div className="panel-heading"><div><span className="section-code">NOTES // {String(notes.length).padStart(2, '0')}</span><h2>Notes</h2></div></div>
        {notes.length === 0 ? (
          <div className="note-empty"><span lang="ja">書</span><p>Add a front and back to generate your first card.</p></div>
        ) : notes.map((note) => {
          const type = noteTypes.find((candidate) => candidate.id === note.typeId)
          return <article className="note-row" key={note.id}>
            <div><span>{type?.fields[0]?.name.toUpperCase() ?? 'FIELD'}</span><strong lang="ja">{note.fields[type?.fields[0]?.id ?? 'front']}</strong></div>
            <div><span>{type?.fields[1]?.name.toUpperCase() ?? type?.name.toUpperCase() ?? 'NOTE'}</span><p lang="ja">{note.fields[type?.fields[1]?.id ?? 'back']}</p></div>
            <button className="text-button" type="button" onClick={() => setNoteDialog({ note })}>Edit note</button>
          </article>
        })}
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
  const [typedDraft, setTypedDraft] = useState<{ cardId?: string; value: string }>({ value: '' })
  const typedResultRef = useRef<HTMLDivElement>(null)
  const cardId = queue?.[0]
  const typedInput = typedDraft.cardId === cardId ? typedDraft.value : ''
  const card = useLiveQuery(async () => cardId ? await collection.cards.get(cardId) ?? null : undefined, [cardId])
  const note = useLiveQuery(async () => card ? await collection.notes.get(card.noteId) ?? null : undefined, [card?.noteId])
  const noteType = useLiveQuery(async () => note ? await collection.noteTypes.get(note.typeId) ?? null : undefined, [note?.typeId])
  const media = useLiveQuery(() => card ? collection.mediaForNote(card.noteId) : [], [card?.noteId], [])
  const choices = useLiveQuery(() => card ? collection.reviewChoices(card.id, new Date()) : [], [card?.id], [])
  const template = noteType?.templates.find((candidate) => candidate.id === card?.templateId)
  const frontResult = template && noteType && note && card
    ? tryRenderNoteTemplate(template.front, noteType, note.fields, undefined, card.clozeOrdinal, 'front') : undefined
  const backResult = frontResult?.ok && template && noteType && note && card
    ? tryRenderNoteTemplate(template.back, noteType, note.fields, frontResult.value.html, card.clozeOrdinal, 'back') : undefined
  const typedAnswer = frontResult?.ok ? frontResult.value.typedAnswer : undefined
  const renderError = frontResult && !frontResult.ok ? frontResult.error : backResult && !backResult.ok ? backResult.error : undefined
  const imageOcclusion = noteType?.kind === 'image-occlusion'
  const unavailable = card === null || note === null || noteType === null ||
    Boolean(card?.suspended) || (Boolean(noteType && card) && !template) ||
    Boolean(frontResult?.ok && frontResult.value.isEmpty && !imageOcclusion)

  useEffect(() => {
    collection.dueCards(deckId, new Date()).then((cards) => setQueue(cards.map((card) => card.id)))
  }, [deckId])

  useEffect(() => {
    if (showAnswer && typedAnswer !== undefined) typedResultRef.current?.focus()
  }, [cardId, showAnswer, typedAnswer])

  useEffect(() => {
    if (cardId && unavailable && (card === null || note === null || noteType === null ||
      (card !== undefined && note !== undefined && noteType !== undefined))) {
      void collection.dueCards(deckId, new Date()).then((cards) => {
        const dueIds = new Set(cards.map((dueCard) => dueCard.id))
        setShowAnswer(false)
        setQueue((current) => current?.filter((queuedId) => queuedId !== cardId && dueIds.has(queuedId)) ?? [])
      })
    }
  }, [deckId, cardId, card, note, noteType, unavailable])

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

  if (queue === null || (cardId && (card === undefined || note === undefined || noteType === undefined || unavailable))) return <div className="loading-state" role="status">Preparing review…</div>

  if (!cardId || !card || !note || !noteType || !template) {
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

  function skipCard() {
    setShowAnswer(false)
    setQueue((current) => current?.slice(1) ?? [])
  }

  if (renderError) return <section className="review-session">
    <div className="review-progress"><span>REVIEW // {String(reviewsRecorded + 1).padStart(2, '0')}</span><button className="text-button" onClick={onBack}>End session</button></div>
    <article className="review-card"><p className="form-error" role="alert">Unable to render card: {renderError}</p></article>
    <button className="primary-action" type="button" onClick={skipCard}>Skip card</button>
  </section>

  const fields = Object.fromEntries(noteType.fields.map((field) => [field.name, note.fields[field.id] ?? '']))
  const answerDiff = showAnswer && typedAnswer !== undefined ? compareTypedAnswer(typedAnswer, typedInput) : []

  return (
    <section className="review-session">
      <div className="review-progress"><span>REVIEW // {String(reviewsRecorded + 1).padStart(2, '0')}</span><button className="text-button" onClick={onBack}>End session</button></div>
      <article className="review-card">
        <span className="card-side">{showAnswer ? 'ANSWER' : 'QUESTION'}</span>
        {imageOcclusion
          ? <ImageOcclusionReview note={note} card={card} showAnswer={showAnswer} />
          : <TemplatePreview key={card.id} title="Review card" front={template.front} back={template.back} css={template.css} fields={fields} kind={noteType.kind} ordinal={card.clozeOrdinal} side={showAnswer ? 'back' : 'front'} />}
        {noteType.id === BASIC_NOTE_TYPE_ID && media.filter((reference) => reference.side === 'front').map((reference) => <MediaRenderer key={reference.id} reference={reference} automatic />)}
        {noteType.id === BASIC_NOTE_TYPE_ID && showAnswer && media.filter((reference) => reference.side === 'back').map((reference) => <MediaRenderer key={reference.id} reference={reference} automatic />)}
        {typedAnswer !== undefined && !showAnswer && <label className="typed-answer">Type your answer
          <input autoComplete="off" value={typedInput} onChange={(event) => setTypedDraft({ cardId, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setShowAnswer(true) } }} />
        </label>}
        {typedAnswer !== undefined && showAnswer && <div ref={typedResultRef} className="typed-answer-result" role="status" aria-live="polite" aria-label="Typed answer comparison" tabIndex={-1}>
          <span className="section-code">YOUR ANSWER</span>
          <div className="answer-diff">{answerDiff.map((part, index) => <span key={index} className={`answer-${part.kind}`} aria-label={`${part.kind === 'good' ? 'Correct' : part.kind === 'bad' ? 'Incorrect' : 'Missing'}: ${part.text}`}>{part.text}</span>)}</div>
          <p>Expected: <strong>{typedAnswer}</strong></p>
        </div>}
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
    if (route.view === 'note-types') return <NoteTypeManager onNewDeck={() => { navigate({ view: 'decks' }); setNewDeck(true) }} />
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
