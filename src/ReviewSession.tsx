import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Rating, BASIC_NOTE_TYPE_ID, IMAGE_OCCLUSION_NOTE_TYPE_ID, collection, type Grade, type Note, type NoteMediaReference } from './collection'
import { MediaRenderer } from './MediaRenderer'
import { replayAudioElements } from './audio-playback'
import { ImageOcclusionEditor, ImageOcclusionReview } from './ImageOcclusion'
import { useReviewMedia } from './use-review-media'
import { validateMedia } from './media'
import { clozeOrdinals } from './template-renderer'
import { compareTypedAnswer } from './typed-answer'
import { CardHistory } from './Statistics'
import { unavailableReason } from './scheduler'
import { describeCardMedia, isRenderedCardDisplayable, renderNoteCard } from './card-rendering'
import { undoAnnouncement, undoLabel } from './undo'
import { answerCustomStudy, customStudyQueue, practiceChoices, undoCustomStudy } from './custom-study'
import { customStudySessions } from './custom-study-state'
import { isShortcutBlocked } from './keyboard-shortcuts'
import { TemplatePreview } from './TemplatePreview'
import { useDialogKeyboard } from './use-dialog-keyboard'
import { useDialogSubmit } from './use-dialog-submit'
import { userFacingStorageError } from './offline-storage'
import { readCard, readCardReviewHistory, readDeckList, readNote, readNoteType, readNoteTypeList } from './collection-queries'
type PendingAttachment = { file: File; side: 'front' | 'back'; playback: 'automatic' | 'manual' }

export function NoteDialog({ deckId, note, onClose }: { deckId: string; note?: Note; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const noteTypes = useLiveQuery(() => readNoteTypeList(collection), [], [])
  const [typeId, setTypeId] = useState(note?.typeId ?? BASIC_NOTE_TYPE_ID)
  const [imageEditor, setImageEditor] = useState(note?.typeId === IMAGE_OCCLUSION_NOTE_TYPE_ID)
  const noteType = noteTypes.find((type) => type.id === typeId)
  const [fields, setFields] = useState<Record<string, string>>(note?.fields ?? {})
  const { error, setError, submitting, submit: submitAction } = useDialogSubmit()
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
      setError(userFacingStorageError(reason, 'Unable to make cloze deletion'))
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
      setError(userFacingStorageError(reason, 'Unable to attach media'))
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void submitAction(async () => {
      if (note) {
        if (typeId === BASIC_NOTE_TYPE_ID) await collection.updateBasicNote(note.id, { front: fields.front ?? '', back: fields.back ?? '' })
        else await collection.updateNote(note.id, fields)
        await Promise.all(attachments.map(({ file, side, playback }) => collection.attachMedia(note.id, { file, side, playback })))
      } else if (typeId === BASIC_NOTE_TYPE_ID) await collection.createBasicNoteWithMedia(deckId, { front: fields.front ?? '', back: fields.back ?? '' }, attachments)
      else await collection.createNote(deckId, typeId, fields)
    }, 'Unable to save note', onClose)
  }

  return (
    <div className="dialog-backdrop">
      <section {...dialogKeyboard} className="dialog note-dialog" role="dialog" aria-modal="true" aria-labelledby="note-dialog-title">
        <span className="section-code">{noteType?.name.toUpperCase() ?? 'NOTE'} // {note ? 'EDIT' : 'NEW'}</span>
        <h2 id="note-dialog-title">{note ? `Edit ${noteType?.name ?? ''} note` : `Add a ${noteType?.name ?? ''} note`}</h2>
        <form onSubmit={submit} aria-busy={submitting}>
          <label>Note type
            <select value={typeId} disabled={Boolean(note)} onChange={(event) => { if (event.target.value === IMAGE_OCCLUSION_NOTE_TYPE_ID) { setImageEditor(true); return } setTypeId(event.target.value); setFields({}); setAttachments([]) }}>
              {noteTypes.map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}
            </select>
          </label>
          {noteType?.fields.map((field, index) => <div key={field.id}>
            <label>{typeId === BASIC_NOTE_TYPE_ID ? field.name[0].toUpperCase() + field.name.slice(1) : field.name}
              <textarea ref={(element) => { textareas.current[field.id] = element }} lang="ja" value={fields[field.id] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [field.id]: event.target.value }))} rows={index === 0 ? 3 : 4} />
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
            <button className="text-button" type="button" disabled={submitting} onClick={onClose}>Cancel</button>
            <button className="primary-action" type="submit" disabled={submitting}>{note ? 'Save changes' : 'Save note'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function ExistingMedia({ media }: { media: NoteMediaReference }) {
  const [error, setError] = useState('')
  return <div className="media-attachment"><strong>{media.displayName}</strong><span>{media.side} · {media.kind}</span><button className="text-button" type="button" onClick={() => void collection.removeMedia(media.id).catch((reason) => setError(userFacingStorageError(reason, 'Unable to remove media')))}>Remove</button>{error && <p className="form-error" role="alert">{error}</p>}</div>
}

export function MoveNoteDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const decks = useLiveQuery(() => readDeckList(collection), [], [])
  const [destinationId, setDestinationId] = useState('')
  const { error, submitting, submit: submitAction } = useDialogSubmit()
  function submit(event: FormEvent) {
    event.preventDefault()
    void submitAction(async () => {
      await collection.moveNote(note.id, destinationId)
    }, 'Unable to move note', onClose)
  }
  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="move-note-title">
    <span className="section-code">NOTE // MOVE</span><h2 id="move-note-title">Move note</h2><form onSubmit={submit} aria-busy={submitting}>
      <label>Destination deck<select value={destinationId} onChange={(event) => setDestinationId(event.target.value)} required><option value="" disabled>Choose a destination</option>{decks.filter((deck) => deck.id !== note.deckId).map((deck) => <option value={deck.id} key={deck.id}>{deck.name}</option>)}</select></label>
      <p className="options-note">The note, generated cards, and review history keep their identities.</p>{error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">Move note</button></div>
    </form>
  </section></div>
}

export function NoteTagsDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const [tags, setTags] = useState((note.tags ?? []).join(', '))
  const { error, submitting, submit: submitAction } = useDialogSubmit()
  function submit(event: FormEvent) {
    event.preventDefault()
    void submitAction(async () => {
      await collection.updateNoteTags(note.id, tags.split(','))
    }, 'Unable to save tags', onClose)
  }
  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="note-tags-title">
    <span className="section-code">NOTE // TAGS</span><h2 id="note-tags-title">Edit tags</h2>
    <form onSubmit={submit} aria-busy={submitting}><label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
      <p className="options-note">Separate tags with commas. Tags apply to every card generated from this note.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">Save tags</button></div>
    </form>
  </section></div>
}

export function ReviewSession({ deckId = '', sessionId, onBack }: { deckId?: string; sessionId?: string; onBack: () => void }) {
  const [skippedCardIds, setSkippedCardIds] = useState<ReadonlySet<string>>(() => new Set())
  const [shownAnswerCardId, setShownAnswerCardId] = useState<string | null>(null)
  const [reviewsRecorded, setReviewsRecorded] = useState(0)
  const [isAnswering, setIsAnswering] = useState(false)
  const [actionError, setActionError] = useState('')
  /*
   * Rating a card moves it out of view without moving focus, so a learner
   * driving the reviewer from the keyboard or a screen reader gets no sign
   * that anything happened. Every outcome of a card action is announced here.
   */
  const [reviewAnnouncement, setReviewAnnouncement] = useState('')
  const [typedDraft, setTypedDraft] = useState<{ cardId?: string; value: string }>({ value: '' })
  const [editingNote, setEditingNote] = useState(false)
  const [movingNote, setMovingNote] = useState(false)
  const [editingTags, setEditingTags] = useState(false)
  const [deletingNote, setDeletingNote] = useState(false)
  const [showCardInfo, setShowCardInfo] = useState(false)
  const deleteDialogKeyboard = useDialogKeyboard(() => setDeletingNote(false), deletingNote)
  const cardInfoDialogKeyboard = useDialogKeyboard(() => setShowCardInfo(false), showCardInfo)
  const [audioMessage, setAudioMessage] = useState('')
  const typedResultRef = useRef<HTMLDivElement>(null)
  const reviewCardRef = useRef<HTMLElement>(null)
  const customSession = useLiveQuery(async () => sessionId ? (await customStudySessions(collection)).find((session) => session.id === sessionId) : undefined, [sessionId])
  const dueQueue = useLiveQuery(() => sessionId ? customStudyQueue(collection, sessionId, new Date()) : collection.reviewQueue(deckId, new Date()), [deckId, sessionId])
  const queue = dueQueue?.filter((candidate) => !skippedCardIds.has(candidate.id))
  const cardId = queue?.[0]?.id
  const showAnswer = shownAnswerCardId === cardId
  const typedInput = typedDraft.cardId === cardId ? typedDraft.value : ''
  const card = useLiveQuery(async () => cardId ? await readCard(collection, cardId) ?? null : undefined, [cardId])
  const note = useLiveQuery(async () => card ? await readNote(collection, card.noteId) ?? null : undefined, [card?.noteId])
  const noteType = useLiveQuery(async () => note ? await readNoteType(collection, note.typeId) ?? null : undefined, [note?.typeId])
  const mediaQuery = useLiveQuery(() => card ? collection.mediaForNote(card.noteId) : [], [card?.noteId])
  // A live query returns a new array identity on ordinary reviewer renders. Stable
  // identities keep the review timer effect and prepared media sources from restarting.
  const media = useMemo(() => mediaQuery ?? [], [mediaQuery])
  const reviewCount = useLiveQuery(async () => card ? (await readCardReviewHistory(collection, card.id)).length : 0, [card?.id], 0)
  // One subscription for one undo. A review belonging to another custom session
  // is not this session's to offer.
  const pendingUndo = useLiveQuery(async () => {
    const record = await collection.pendingUndo()
    return sessionId && record?.kind === 'review' && record.customSession?.after.id !== sessionId ? null : record
  }, [sessionId])
  const choices = useLiveQuery(() => card ? sessionId && customSession?.reschedule === false ? practiceChoices : collection.reviewChoices(card.id, new Date(), Boolean(sessionId)) : [], [card?.id, sessionId, customSession?.reschedule], [])
  const template = noteType?.templates.find((candidate) => candidate.id === card?.templateId)
  const imageOcclusion = noteType?.kind === 'image-occlusion'
  // Only prepare media once the live query has actually resolved for the active card,
  // so a pending read cannot be mistaken for a card that has no attachments. Prepared
  // sources are keyed by this list inside the hook, so no extra memoization is needed.
  const activeCard = card?.id === cardId ? card : undefined
  const activeMedia = activeCard
    ? media.filter((reference) => (!reference.templateId || reference.templateId === activeCard.templateId))
    : []
  const preparedMedia = useReviewMedia(activeMedia, cardId)
  const attachments = activeMedia.filter((reference) => !reference.inline).map((reference) => describeCardMedia(
    reference,
    preparedMedia.sources.byReference[reference.id]?.url,
  ))
  const renderedCard = template && noteType && note && card
    ? renderNoteCard(noteType, template, note.fields, card.clozeOrdinal, preparedMedia.sources.byName, attachments, note.renderedHtmlFields)
    : undefined
  const typedAnswer = renderedCard?.typedAnswer
  const renderError = renderedCard?.error
  // A media failure is reported but never blocks the card: a single corrupt or
  // unsupported attachment must not make the card permanently unanswerable.
  const mediaBlocked = !mediaQuery || preparedMedia.pending
  // Answering already refuses a suspended or buried card, so the reviewer asks the
  // scheduler for the same reason rather than restating a weaker suspension test.
  const unavailable = card === null || note === null || noteType === null ||
    Boolean(card && unavailableReason(card, new Date()) !== null) ||
    (Boolean(noteType && card) && !template) ||
    Boolean(renderedCard && !isRenderedCardDisplayable(renderedCard, noteType?.kind))

  useEffect(() => {
    if (showAnswer && typedAnswer !== undefined) typedResultRef.current?.focus()
  }, [cardId, showAnswer, typedAnswer])

  const activeTime = useRef<{ cardId?: string; elapsed: number; started: number | null }>({ elapsed: 0, started: null })
  useEffect(() => {
    if (activeTime.current.cardId !== cardId) activeTime.current = { cardId, elapsed: 0, started: null }
    const timer = activeTime.current
    const blocked = editingNote || movingNote || editingTags || deletingNote || showCardInfo || unavailable || !note || mediaBlocked
    const update = () => {
      if (timer.started !== null) timer.elapsed += performance.now() - timer.started
      timer.started = !blocked && document.visibilityState === 'visible' ? performance.now() : null
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      if (timer.started !== null) timer.elapsed += performance.now() - timer.started
      timer.started = null
    }
  }, [cardId, editingNote, movingNote, editingTags, deletingNote, showCardInfo, unavailable, note, mediaBlocked])

  const answer = useCallback(async (rating: Grade) => {
    if (!cardId || isAnswering || mediaBlocked) return
    setIsAnswering(true)
    setActionError('')
    try {
      const duration = activeTime.current.elapsed + (activeTime.current.started === null ? 0 : performance.now() - activeTime.current.started)
      if (sessionId) await answerCustomStudy(collection, sessionId, cardId, rating, new Date(), duration)
      else await collection.answer(cardId, rating, new Date(), duration)
      setReviewsRecorded((count) => count + 1)
      setReviewAnnouncement(`Recorded ${Rating[rating]}. ${reviewsRecorded + 1} rated this session.`)
      setShownAnswerCardId(null)
    } catch (reason) {
      setActionError(userFacingStorageError(reason, 'Unable to update card'))
    } finally {
      setIsAnswering(false)
    }
  }, [cardId, isAnswering, mediaBlocked, sessionId, reviewsRecorded])

  const updateCurrentCard = useCallback(async (action: (id: string) => Promise<void>, message: string) => {
    if (!cardId || isAnswering) return
    setIsAnswering(true)
    setActionError('')
    try {
      await action(cardId)
      setReviewAnnouncement(message)
      setShownAnswerCardId(null)
    } catch (reason) {
      setActionError(userFacingStorageError(reason, 'Unable to update card'))
    } finally {
      setIsAnswering(false)
    }
  }, [cardId, isAnswering])

  const replayAudio = useCallback(async () => {
    const surface = reviewCardRef.current
    if (!surface) return
    const audio = [
      ...surface.querySelectorAll('audio'),
      ...[...surface.querySelectorAll('iframe')].flatMap((frame) => [...(frame.contentDocument?.querySelectorAll('audio') ?? [])]),
    ]
    if (!audio.length) { setAudioMessage('Audio is still loading. Try again in a moment.'); return }
    setAudioMessage(await replayAudioElements(audio) ? 'Audio replayed.' : 'Audio could not play on this device.')
  }, [])

  const deleteCurrentNote = useCallback(async () => {
    if (!note || isAnswering) return
    setIsAnswering(true)
    setActionError('')
    try {
      await collection.deleteNote(note.id)
      setReviewAnnouncement('Note and its cards deleted.')
      setDeletingNote(false)
      setShownAnswerCardId(null)
    } catch (reason) {
      setActionError(userFacingStorageError(reason, 'Unable to delete note'))
    } finally {
      setIsAnswering(false)
    }
  }, [note, isAnswering])

  /** One affordance for the one undo record, whatever produced it. */
  const undoLastAction = useCallback(async () => {
    if (isAnswering) return
    setIsAnswering(true)
    setActionError('')
    try {
      if (pendingUndo?.kind === 'review' && sessionId) await undoCustomStudy(collection, sessionId)
      else await collection.undo()
      setReviewAnnouncement(undoAnnouncement(pendingUndo ?? null))
      setShownAnswerCardId(null)
      setReviewsRecorded((count) => (pendingUndo?.kind === 'review' ? Math.max(0, count - 1) : count))
    } catch (reason) {
      setActionError(userFacingStorageError(reason, 'Unable to undo'))
    } finally {
      setIsAnswering(false)
    }
  }, [isAnswering, pendingUndo, sessionId])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isAnswering || editingNote || movingNote || editingTags || deletingNote || showCardInfo) return
      if (isShortcutBlocked(event)) return
      const key = event.key.toLowerCase()
      const buttonFocused = event.target instanceof Element && Boolean(event.target.closest('button'))
      if ((key === 'u' || key === 'v' || key === 'x') && pendingUndo) { event.preventDefault(); void undoLastAction(); return }
      if (!cardId) return
      if ((key === ' ' || key === 'spacebar') && !showAnswer && !buttonFocused) {
        // Media that is still loading, or that failed to prepare, must not be
        // revealed early: the question would render without its own content.
        if (mediaBlocked) return
        event.preventDefault()
        setReviewAnnouncement('Answer shown. Rate the card with 1 to 4.')
        setShownAnswerCardId(cardId)
      } else if (showAnswer && /^[1-4]$/.test(key)) {
        const choice = choices[Number(key) - 1]
        if (choice) { event.preventDefault(); void answer(choice.rating) }
      } else if (key === 'e') { event.preventDefault(); setEditingNote(true) }
      else if (key === 'm') { event.preventDefault(); setMovingNote(true) }
      else if (key === 't') { event.preventDefault(); setEditingTags(true) }
      else if (key === 'k' && note) { event.preventDefault(); void updateCurrentCard(async () => collection.updateNoteTags(note.id, note.tags?.includes('marked') ? (note.tags ?? []).filter((tag) => tag !== 'marked') : [...(note.tags ?? []), 'marked']), note.tags?.includes('marked') ? 'Mark removed.' : 'Marked.') }
      else if (key === 'd') { event.preventDefault(); setDeletingNote(true) }
      else if (key === 'i') { event.preventDefault(); setShowCardInfo(true) }
      else if (key === 'r' && media.some((reference) => reference.kind === 'audio')) { event.preventDefault(); void replayAudio() }
      else if (key === 's') { event.preventDefault(); void updateCurrentCard((id) => collection.suspendCard(id), 'Card suspended.') }
      else if (key === 'b') { event.preventDefault(); void updateCurrentCard((id) => collection.buryCard(id), 'Card buried.') }
      else if (key === 'f') { event.preventDefault(); void updateCurrentCard(async (id) => { const current = await readCard(collection, id); await collection.setCardFlag(id, ((current?.flag ?? 0) + 1) % 8) }, 'Card flag advanced.') }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cardId, card?.flag, note, isAnswering, editingNote, movingNote, editingTags, deletingNote, showCardInfo, showAnswer, choices, media, answer, replayAudio, updateCurrentCard, pendingUndo, undoLastAction, mediaBlocked])

  /*
   * Card actions move the card out of view without moving focus, so a learner
   * driving the reviewer from the keyboard or a screen reader gets no sign
   * that anything happened. Declared once here because the reviewer returns
   * early for a completed session and for an unrenderable card, and the last
   * action is usually the one that emptied the queue.
   */
  const announcementRegion = <p className="visually-hidden" role="status">{reviewAnnouncement}</p>

  if (queue === undefined || (cardId && (card === undefined || note === undefined || noteType === undefined || unavailable))) return <div className="loading-state" role="status">Preparing review…</div>
  if (!cardId || !card || !note || !noteType || !template) {
    return (
      <section className="session-complete">
        <span className="completion-mark">✓</span>
        <span className="section-code">SESSION // COMPLETE</span>
        <h1>Session complete</h1>
        <p>{reviewsRecorded} {reviewsRecorded === 1 ? 'review' : 'reviews'} recorded</p>
        {pendingUndo && <button className="text-button" type="button" disabled={isAnswering} onClick={() => void undoLastAction()}>{undoLabel(pendingUndo)}</button>}
        {actionError && <p className="form-error" role="alert">{actionError}</p>}
        {/* The last action is usually the one that emptied the queue, so its
            announcement has to outlive the card it was about. */}
        {announcementRegion}
        <button className="primary-action" type="button" onClick={onBack}>{sessionId ? 'Back to custom study' : 'Back to deck'}</button>
      </section>
    )
  }

  function skipCard() {
    if (!cardId) return
    setShownAnswerCardId(null)
    setSkippedCardIds((current) => new Set(current).add(cardId))
    setReviewAnnouncement('Card skipped. It stays scheduled and comes back later.')
  }

  const reviewActions = <div className="review-session-actions">
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => setEditingNote(true)}>Edit note</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => setMovingNote(true)}>Move note</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => setEditingTags(true)}>Edit tags</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => void updateCurrentCard(async () => collection.updateNoteTags(note.id, note.tags?.includes('marked') ? (note.tags ?? []).filter((tag) => tag !== 'marked') : [...(note.tags ?? []), 'marked']), note.tags?.includes('marked') ? 'Mark removed.' : 'Marked.')}>{note.tags?.includes('marked') ? 'Unmark note' : 'Mark note'}</button>
    <button className="text-button" type="button" onClick={() => setShowCardInfo(true)}>Card info</button>
    {pendingUndo && <button className="text-button" type="button" disabled={isAnswering} onClick={() => void undoLastAction()}>{undoLabel(pendingUndo)}</button>}
    <label className="review-flag-control">Flag <select aria-label="Card flag" value={card.flag ?? 0} disabled={isAnswering} onChange={(event) => void updateCurrentCard((id) => collection.setCardFlag(id, Number(event.target.value)), `Flag set to ${event.target.value}.`)}>
      <option value={0}>None</option><option value={1}>Red</option><option value={2}>Orange</option><option value={3}>Green</option><option value={4}>Blue</option><option value={5}>Pink</option><option value={6}>Turquoise</option><option value={7}>Purple</option>
    </select></label>
    {media.some((reference) => reference.kind === 'audio') && <button className="text-button" type="button" onClick={() => void replayAudio()}>Replay audio</button>}
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => void updateCurrentCard((id) => collection.suspendCard(id), 'Card suspended.')}>Suspend card</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => void updateCurrentCard((id) => collection.buryCard(id), 'Card buried.')}>Bury card</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => setDeletingNote(true)}>Delete note</button>
    <button className="text-button" type="button" onClick={onBack}>End session</button>
  </div>
  const reviewerDialogs = <>
    {editingNote && <NoteDialog key={note.id} deckId={note.deckId} note={note} onClose={() => setEditingNote(false)} />}
    {movingNote && <MoveNoteDialog note={note} onClose={() => setMovingNote(false)} />}
    {editingTags && <NoteTagsDialog key={note.id} note={note} onClose={() => setEditingTags(false)} />}
    {deletingNote && <div className="dialog-backdrop"><section {...deleteDialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="review-delete-note-title">
      <span className="section-code">NOTE // DELETE</span><h2 id="review-delete-note-title">Delete note</h2>
      <p>This removes the note and all its cards, review history, and media references. You can undo it until the next sync attempt.</p>
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      <div className="dialog-actions"><button className="text-button" data-dialog-initial-focus type="button" onClick={() => setDeletingNote(false)}>Cancel</button><button className="primary-action" type="button" disabled={isAnswering} onClick={() => void deleteCurrentNote()}>Delete note and cards</button></div>
    </section></div>}
    {showCardInfo && <div className="dialog-backdrop"><section {...cardInfoDialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="review-card-info-title">
      <span className="section-code">CARD // DETAILS</span><h2 id="review-card-info-title">Card info</h2>
      <dl className="review-card-info"><div><dt>Note type</dt><dd>{noteType.name}</dd></div><div><dt>Card template</dt><dd>{template.name}</dd></div><div><dt>Due</dt><dd>{new Date(card.due).toLocaleString()}</dd></div><div><dt>Reviews</dt><dd>{reviewCount}</dd></div><div><dt>Lapses</dt><dd>{card.lapses}</dd></div><div><dt>Flag</dt><dd>{['None', 'Red', 'Orange', 'Green', 'Blue', 'Pink', 'Turquoise', 'Purple'][card.flag ?? 0]}</dd></div><div><dt>Tags</dt><dd>{note.tags?.join(', ') || 'None'}</dd></div></dl>
      <CardHistory key={card.id} card={card} />
      <div className="dialog-actions"><button className="primary-action" type="button" onClick={() => setShowCardInfo(false)}>Done</button></div>
    </section></div>}
  </>

  if (renderError) return <><section className="review-session">
    {sessionId && <p className="custom-review-mode">{customSession?.name ?? 'Custom session'} · {customSession?.reschedule ? 'Ratings reschedule the home card' : 'Practice: original schedule stays unchanged'}. Each rated card returns to its home deck.</p>}
    <div className="review-progress"><span>REVIEW // {String(reviewsRecorded + 1).padStart(2, '0')}</span>{reviewActions}</div>
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {announcementRegion}
    <article className="review-card"><p className="form-error" role="alert">Unable to render card: {renderError}</p></article>
    <button className="primary-action" type="button" onClick={skipCard}>Skip card</button>
  </section>{reviewerDialogs}</>

  const answerDiff = showAnswer && typedAnswer !== undefined ? compareTypedAnswer(typedAnswer, typedInput) : []

  return (
    <>
    <section className="review-session">
      {sessionId && <p className="custom-review-mode">{customSession?.name ?? 'Custom session'} · {customSession?.reschedule ? 'Ratings reschedule the home card' : 'Practice: original schedule stays unchanged'}. Each rated card returns to its home deck.</p>}
    <div className="review-progress"><span>REVIEW // {String(reviewsRecorded + 1).padStart(2, '0')}</span>{reviewActions}</div>
      <p className="review-shortcuts">Space reveal · 1–4 rate · E edit · M move · T tags · K mark · I info · F flag · R replay · S suspend · B bury · D delete · U undo review · V undo card action · X undo deletion. Undo is available until the next sync attempt or affected edit.</p>
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {announcementRegion}
      {audioMessage && <p className="review-feedback" role="status">{audioMessage}</p>}
      <article className="review-card" ref={reviewCardRef}>
        <span className="card-side">{showAnswer ? 'ANSWER' : 'QUESTION'}</span>
        {mediaBlocked ? <p role="status">Preparing card media…</p> : imageOcclusion
          ? <ImageOcclusionReview note={note} card={card} showAnswer={showAnswer} imageUrl={preparedMedia.sources.byReference[note.imageOcclusion?.sourceMediaId ?? '']?.url} />
          : <TemplatePreview title="Review card" key={card.id} rendering={renderedCard!} templateOrdinal={Math.max(1, noteType.templates.findIndex((candidate) => candidate.id === template.id) + 1)} side={showAnswer ? 'back' : 'front'} />}
        {preparedMedia.error && <p className="form-error" role="alert">Some attachments could not be shown: {preparedMedia.error}</p>}
        {!mediaBlocked && noteType.kind !== 'image-occlusion' && renderedCard?.media.filter((description) => description.side === 'front').map((description) => <MediaRenderer key={description.id} description={description} />)}
        {!mediaBlocked && noteType.kind !== 'image-occlusion' && showAnswer && renderedCard?.media.filter((description) => description.side === 'back').map((description) => <MediaRenderer key={description.id} description={description} />)}
        {typedAnswer !== undefined && !showAnswer && <label className="typed-answer">Type your answer
          <input autoComplete="off" value={typedInput} onChange={(event) => setTypedDraft({ cardId, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (!mediaBlocked) setShownAnswerCardId(cardId) } }} />
        </label>}
        {typedAnswer !== undefined && showAnswer && <div ref={typedResultRef} className="typed-answer-result" role="status" aria-live="polite" aria-label="Typed answer comparison" tabIndex={-1}>
          <span className="section-code">YOUR ANSWER</span>
          <div className="answer-diff">{answerDiff.map((part, index) => <span key={index} className={`answer-${part.kind}`} aria-label={`${part.kind === 'good' ? 'Correct' : part.kind === 'bad' ? 'Incorrect' : 'Missing'}: ${part.text}`}>{part.text}</span>)}</div>
          <p>Expected: <strong>{typedAnswer}</strong></p>
        </div>}
      </article>
      {!showAnswer ? (
        <button className="primary-action reveal-action" type="button" disabled={isAnswering || mediaBlocked} onClick={() => { setReviewAnnouncement('Answer shown. Rate the card with 1 to 4.'); setShownAnswerCardId(cardId) }}>Show answer</button>
      ) : (
        <div className="rating-grid" role="group" aria-label="Rate answer">
          {choices.map((choice) => (
            <button aria-label={`${choice.label} · ${choice.interval}`} className={`rating rating-${Rating[choice.rating].toLowerCase()}`} type="button" disabled={isAnswering || mediaBlocked} key={choice.rating} onClick={() => void answer(choice.rating)}>
              <strong>{choice.label}</strong><span aria-hidden="true">·</span><small>{choice.interval}</small>
            </button>
          ))}
        </div>
      )}
    </section>
    {reviewerDialogs}
    </>
  )
}
